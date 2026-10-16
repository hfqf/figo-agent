import { mkdir, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { Artifact } from "../contracts/types.js";
import { defaultStorageConfig, type RuntimeStorageConfig } from "../config/runtime-behavior.js";
import { nowShanghaiTime } from "../utils/clock.js";
import { assertInsideWorkspace } from "../utils/path.js";
import { schemaSql } from "./schema.js";
import { migrateTimestamps } from "./timestamp-migration.js";
import { backfillTokenUsage } from "../token-usage/token-usage-store.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface StoragePaths {
  workspaceRoot: string;
  agentRoot: string;
  databasePath: string;
  artifactsRoot: string;
  memoryRoot: string;
}

export interface WriteArtifactInput {
  id: string;
  sessionId: string;
  taskId?: string;
  turnId?: string;
  type: Artifact["type"];
  path: string;
  content: string;
}

export class StorageManager {
  private constructor(
    public readonly paths: StoragePaths,
    public readonly db: DatabaseSyncType
  ) {}

  static async init(workspaceRoot: string, config: RuntimeStorageConfig = defaultStorageConfig): Promise<StorageManager> {
    const agentRoot = join(workspaceRoot, ".figo-agent");
    const artifactsRoot = join(agentRoot, "artifacts");
    const memoryRoot = join(agentRoot, "memory");

    await mkdir(join(artifactsRoot, "sessions"), { recursive: true });
    await mkdir(memoryRoot, { recursive: true });

    const databasePath = join(agentRoot, "figo-agent.db");
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`PRAGMA busy_timeout = ${config.sqliteBusyTimeoutMs}`);
      db.exec(schemaSql);
      migrateV11TaskColumns(db);
      ensureColumn(db, "turns", "output", "TEXT");
      ensureColumn(db, "sessions", "current_task_id", "TEXT");
      ensureColumn(db, "ui_runs", "owner_pid", "INTEGER");
      ensureColumn(db, "ui_runs", "request_hash", "TEXT");
      ensureColumn(db, "ui_runs", "model_provider_id", "TEXT");
      ensureColumn(db, "ui_runs", "model_id", "TEXT");
      ensureColumn(db, "tool_calls", "intent_id", "TEXT");
      ensureColumn(db, "tool_calls", "round", "INTEGER");
      createV11TaskIndexes(db);
      migrateTaskSequence(db);
      ensureColumn(db, "llm_http_captures", "purpose", "TEXT NOT NULL DEFAULT 'turn'");
      const addedUsageTurnId = ensureColumn(db, "token_usage", "usage_turn_id", "TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS idx_token_usage_turn_created ON token_usage(usage_turn_id, created_at)");
      if (addedUsageTurnId) {
        db.exec("update token_usage set usage_turn_id = turn_id where purpose != 'task_compaction'");
      }
      migrateTimestamps(db);
      backfillTokenUsage(db);

      return new StorageManager(
        { workspaceRoot, agentRoot, databasePath, artifactsRoot, memoryRoot },
        db
      );
    } catch (error) {
      db.close();
      throw error;
    }
  }

  getSessionDir(sessionId: string): string {
    return join(this.paths.workspaceRoot, ".figo-agent", "artifacts", "sessions", sessionId);
  }

  async writeArtifact(input: WriteArtifactInput): Promise<Artifact> {
    const relativePath = assertInsideWorkspace(this.paths.workspaceRoot, input.path);
    const absolutePath = join(this.paths.workspaceRoot, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });

    const tmpPath = `${absolutePath}.tmp`;
    await writeFile(tmpPath, input.content, "utf8");
    await rename(tmpPath, absolutePath);

    const bytes = Buffer.byteLength(input.content, "utf8");
    const createdAt = nowShanghaiTime();

    this.db
      .prepare(
        "insert into artifacts (id, session_id, task_id, turn_id, type, path, bytes, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.id,
        input.sessionId,
        input.taskId ?? null,
        input.turnId ?? null,
        input.type,
        relativePath,
        bytes,
        createdAt
      );

    return {
      id: input.id,
      sessionId: input.sessionId,
      taskId: input.taskId,
      turnId: input.turnId,
      type: input.type,
      path: relativePath,
      bytes,
      createdAt
    };
  }
}

function migrateV11TaskColumns(db: DatabaseSyncType): void {
  ensureColumn(db, "turns", "task_id", "TEXT");
  ensureColumn(db, "context_packs", "task_id", "TEXT");
  ensureColumn(db, "trace_events", "task_id", "TEXT");
  ensureColumn(db, "artifacts", "task_id", "TEXT");
  ensureColumn(db, "llm_http_captures", "task_id", "TEXT");
}

function migrateTaskSequence(db: DatabaseSyncType): void {
  ensureColumn(db, "turns", "task_seq", "INTEGER");
  const rows = db.prepare(
    "select id, task_id, task_seq from turns where task_id is not null order by task_id, created_at, rowid"
  ).all() as Array<{ id: string; task_id: string; task_seq: number | null }>;
  const nextByTask = new Map<string, number>();
  for (const row of rows) {
    if (row.task_seq !== null) {
      nextByTask.set(row.task_id, Math.max(nextByTask.get(row.task_id) ?? 0, row.task_seq));
    }
  }
  const update = db.prepare("update turns set task_seq = ? where id = ?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      if (row.task_seq !== null) continue;
      const next = (nextByTask.get(row.task_id) ?? 0) + 1;
      update.run(next, row.id);
      nextByTask.set(row.task_id, next);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_task_seq ON turns(task_id, task_seq)");
}

function createV11TaskIndexes(db: DatabaseSyncType): void {
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_turns_task_created ON turns(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trace_events_task_created ON trace_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_task_created ON artifacts(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_http_captures_task_created ON llm_http_captures(task_id, created_at);
`);
}

function ensureColumn(db: DatabaseSyncType, table: string, column: string, definition: string): boolean {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return false;
  db.exec(`alter table ${table} add column ${column} ${definition}`);
  return true;
}
