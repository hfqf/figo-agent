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
