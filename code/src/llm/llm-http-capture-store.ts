import type { StorageManager } from "../storage/storage-manager.js";
import { nowShanghaiTime } from "../utils/clock.js";
import { createId } from "../utils/id.js";
import { TokenUsageStore } from "../token-usage/token-usage-store.js";

export interface LLMHttpCaptureInput {
  purpose?: "turn" | "task_compaction" | "round_compaction";
  sessionId: string;
  taskId: string;
  turnId: string;
  usageTurnId?: string | null;
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
    const captureId = createId("llm_cap");
    const createdAt = nowShanghaiTime();
    this.storage.db.exec("BEGIN IMMEDIATE");
    try {
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
          captureId,
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
          createdAt,
          input.purpose ?? "turn"
        );
      new TokenUsageStore(this.storage).recordCapture({ captureId, createdAt, capture: input });
      this.storage.db.exec("COMMIT");
    } catch (error) {
      this.storage.db.exec("ROLLBACK");
      throw error;
    }
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
