import type { StorageManager } from "../storage/storage-manager.js";
import { nowShanghaiTime } from "../utils/clock.js";
import { createId } from "../utils/id.js";

export interface CompactionCheckpoint {
  id: string;
  taskId: string;
  baseCheckpointId?: string;
  fromSeq: number;
  throughSeq: number;
  sourceTurnIds: string[];
  summaryJson: string;
  requestId: string;
  createdAt: string;
}

export type AppendCheckpointInput = Omit<CompactionCheckpoint, "id" | "createdAt">;

export interface ContextCompactionEntry {
  id: string;
  taskId: string;
  seq: number;
  baseEntryId?: string;
  firstKeptSourceRef: string;
  coveredSourceRefs: string[];
  summaryMarkdown: string;
  details: { readFiles: string[]; modifiedFiles: string[]; [key: string]: unknown };
  tokensBefore: number;
  requestId: string;
  createdAt: string;
}

export type AppendContextCompactionEntryInput = Omit<ContextCompactionEntry, "id" | "seq" | "createdAt"> & { id?: string };

type EntryRow = {
  id: string;
  task_id: string;
  seq: number;
  base_entry_id: string | null;
  first_kept_source_ref: string;
  source_refs_json: string;
  summary_markdown: string;
  details_json: string;
  tokens_before: number;
  request_id: string;
  created_at: string;
};

type CheckpointRow = {
  id: string;
  task_id: string;
  base_checkpoint_id: string | null;
  from_seq: number;
  through_seq: number;
  source_turn_ids_json: string;
  summary_json: string;
  request_id: string;
  created_at: string;
};

export class CompactionStore {
  constructor(private readonly storage: StorageManager) {}

  latestEntry(taskId: string): ContextCompactionEntry | undefined {
    const row = this.storage.db.prepare(
      "select * from context_compactions where task_id = ? order by seq desc limit 1"
    ).get(taskId) as EntryRow | undefined;
    return row ? toEntry(row) : undefined;
  }

  appendEntry(input: AppendContextCompactionEntryInput): ContextCompactionEntry {
    validateEntryInput(input);
    const db = this.storage.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const base = this.latestEntry(input.taskId);
      if (base?.id !== input.baseEntryId) throw new Error("compaction entry base changed");
      const entry: ContextCompactionEntry = {
        ...input,
        id: input.id ?? createId("compact"),
        seq: (base?.seq ?? 0) + 1,
        createdAt: nowShanghaiTime()
      };
      db.prepare(
        `insert into context_compactions (
          id, task_id, seq, base_entry_id, first_kept_source_ref, source_refs_json,
          summary_markdown, details_json, tokens_before, request_id, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(entry.id, entry.taskId, entry.seq, entry.baseEntryId ?? null, entry.firstKeptSourceRef,
        JSON.stringify(entry.coveredSourceRefs), entry.summaryMarkdown, JSON.stringify(entry.details),
        entry.tokensBefore, entry.requestId, entry.createdAt);
      db.exec("COMMIT");
      return entry;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  latest(taskId: string): CompactionCheckpoint | undefined {
    const row = this.storage.db.prepare(
      "select * from task_compaction_checkpoints where task_id = ? order by through_seq desc limit 1"
    ).get(taskId) as CheckpointRow | undefined;
    return row ? toCheckpoint(row) : undefined;
  }

  append(input: AppendCheckpointInput): CompactionCheckpoint {
    const db = this.storage.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const base = this.latest(input.taskId);
      if (base?.id !== input.baseCheckpointId || input.fromSeq !== (base?.throughSeq ?? 0) + 1) {
        throw new Error("compaction checkpoint base changed");
      }
      if (input.throughSeq < input.fromSeq || input.sourceTurnIds.length !== input.throughSeq - input.fromSeq + 1) {
        throw new Error("invalid compaction checkpoint range");
      }
      const sourceRows = db.prepare(
        "select id, task_seq, status from turns where task_id = ? and task_seq between ? and ? order by task_seq"
      ).all(input.taskId, input.fromSeq, input.throughSeq) as Array<{ id: string; task_seq: number; status: string }>;
      if (sourceRows.length !== input.sourceTurnIds.length || sourceRows.some((row, index) =>
        row.id !== input.sourceTurnIds[index] || !["completed", "failed"].includes(row.status)
      )) {
        throw new Error("compaction source turns changed or are not terminal");
      }
      const checkpoint: CompactionCheckpoint = {
        ...input,
        id: createId("compact"),
        createdAt: nowShanghaiTime()
      };
      db.prepare(
        "insert into task_compaction_checkpoints (id, task_id, base_checkpoint_id, from_seq, through_seq, source_turn_ids_json, summary_json, request_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(checkpoint.id, checkpoint.taskId, checkpoint.baseCheckpointId ?? null, checkpoint.fromSeq,
        checkpoint.throughSeq, JSON.stringify(checkpoint.sourceTurnIds), checkpoint.summaryJson,
        checkpoint.requestId, checkpoint.createdAt);
      db.exec("COMMIT");
      return checkpoint;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function validateEntryInput(input: AppendContextCompactionEntryInput): void {
  if (!nonemptyString(input.taskId) || (input.id !== undefined && !nonemptyString(input.id)) ||
    !nonemptyString(input.firstKeptSourceRef) || !nonemptyString(input.summaryMarkdown) || !nonemptyString(input.requestId) ||
    !stringArray(input.coveredSourceRefs) || input.coveredSourceRefs.length === 0 ||
    !Number.isFinite(input.tokensBefore) || input.tokensBefore < 0 ||
    typeof input.details !== "object" || input.details === null || Array.isArray(input.details) ||
    !stringArray(input.details.readFiles) || !stringArray(input.details.modifiedFiles)) {
    throw new Error("invalid context compaction entry");
  }
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && [...value].every(nonemptyString);
}

function toEntry(row: EntryRow): ContextCompactionEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    seq: row.seq,
    baseEntryId: row.base_entry_id ?? undefined,
    firstKeptSourceRef: row.first_kept_source_ref,
    coveredSourceRefs: JSON.parse(row.source_refs_json) as string[],
    summaryMarkdown: row.summary_markdown,
    details: JSON.parse(row.details_json) as ContextCompactionEntry["details"],
    tokensBefore: row.tokens_before,
    requestId: row.request_id,
    createdAt: row.created_at
  };
}

function toCheckpoint(row: CheckpointRow): CompactionCheckpoint {
  return {
    id: row.id,
    taskId: row.task_id,
    baseCheckpointId: row.base_checkpoint_id ?? undefined,
    fromSeq: row.from_seq,
    throughSeq: row.through_seq,
    sourceTurnIds: JSON.parse(row.source_turn_ids_json) as string[],
    summaryJson: row.summary_json,
    requestId: row.request_id,
    createdAt: row.created_at
  };
}
