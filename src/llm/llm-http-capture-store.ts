import type { StorageManager } from "../storage/storage-manager.js";
import { nowIso } from "../utils/clock.js";
import { createId } from "../utils/id.js";

export interface LLMHttpCaptureInput {
  purpose?: "turn" | "task_compaction" | "round_compaction";
  sessionId: string;
  taskId: string;
  turnId: string;
  requestId: string;
  provider: string;
  model: string;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  responseStatus: number;
  responseStatusText: string;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  durationMs: number;
}

export class LLMHttpCaptureStore {
  constructor(private readonly storage: StorageManager) {}

  record(input: LLMHttpCaptureInput): void {
    this.storage.db
      .prepare(
        `insert into llm_http_captures (
          id,
          session_id,
          task_id,
          turn_id,
          request_id,
          provider,
          model,
          url,
          method,
          request_headers_json,
          request_body_json,
          response_status,
          response_status_text,
          response_headers_json,
          response_body_json,
          duration_ms,
          created_at,
          purpose
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        createId("llm_cap"),
        input.sessionId,
        input.taskId,
        input.turnId,
        input.requestId,
        input.provider,
        input.model,
        input.url,
        input.method,
        JSON.stringify(redactHeaders(input.requestHeaders)),
        JSON.stringify(input.requestBody),
        input.responseStatus,
        input.responseStatusText,
        JSON.stringify(redactHeaders(input.responseHeaders)),
        JSON.stringify(input.responseBody),
        input.durationMs,
        nowIso(),
        input.purpose ?? "turn"
      );
  }
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = /authorization|api[-_]?key|token|secret|password/i.test(key)
      ? "[REDACTED]"
      : value;
  }
  return redacted;
}
