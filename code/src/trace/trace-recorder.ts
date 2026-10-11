import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TraceEvent, TraceEventType } from "../contracts/types.js";
import type { StorageManager } from "../storage/storage-manager.js";
import { nowShanghaiTime } from "../utils/clock.js";
import { createId } from "../utils/id.js";

export interface TraceEventInput {
  sessionId: string;
  taskId?: string;
  turnId?: string;
  type: TraceEventType;
  source: string;
  payload?: Record<string, unknown>;
}

export class TraceRecorder {
  constructor(private readonly storage: StorageManager) {}

  async record(input: TraceEventInput): Promise<TraceEvent> {
    if (!input.sessionId) throw new Error("sessionId is required");
    if (!input.type) throw new Error("type is required");
    if (!input.source) throw new Error("source is required");

    const event: TraceEvent = {
      id: createId("trc"),
      sessionId: input.sessionId,
      taskId: input.taskId,
      turnId: input.turnId,
      type: input.type,
      source: input.source,
      payload: sanitizePayload(input.payload ?? {}),
      createdAt: nowShanghaiTime()
    };

    this.storage.db
      .prepare(
        "insert into trace_events (id, session_id, task_id, turn_id, type, source, payload_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        event.id,
        event.sessionId,
        event.taskId ?? null,
        event.turnId ?? null,
        event.type,
        event.source,
        JSON.stringify(event.payload),
        event.createdAt
      );

    const jsonlPath = join(
      this.storage.paths.workspaceRoot,
      ".figo-agent",
      "artifacts",
      "sessions",
      event.sessionId,
      "trace.jsonl"
    );
    await mkdir(dirname(jsonlPath), { recursive: true });
    await appendFile(jsonlPath, `${JSON.stringify(event)}\n`, "utf8");

    return event;
  }
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    redacted[key] = isSensitiveKey(key) ? "[REDACTED]" : value;
  }
  return redacted;
}

function isSensitiveKey(key: string): boolean {
  return /^(apiKey|api_key|authorization|password|secret|token|accessToken|refreshToken)$/i.test(key);
}
