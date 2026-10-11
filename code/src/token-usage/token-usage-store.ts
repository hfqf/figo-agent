import type { DatabaseSync } from "node:sqlite";
import type { LLMHttpCaptureInput } from "../llm/llm-http-capture-store.js";
import type { StorageManager } from "../storage/storage-manager.js";

type UsageCapture = Pick<LLMHttpCaptureInput,
  "sessionId" | "taskId" | "turnId" | "usageTurnId" | "requestId" | "purpose" | "provider" | "model" | "responseBody">;

interface CaptureUsageInput {
  captureId: string;
  createdAt: string;
  capture: UsageCapture;
}

export interface TokenUsageSummary {
  requestCount: number;
  completeCount: number;
  partialCount: number;
  unavailableCount: number;
  knownPromptTokens: number;
  knownCompletionTokens: number;
  knownTotalTokens: number;
  promptReportedCount: number;
  completionReportedCount: number;
  totalReportedCount: number;
}

export class TokenUsageStore {
  constructor(private readonly storage: StorageManager) {}

  recordCapture(input: CaptureUsageInput): void {
    insertCaptureUsage(this.storage.db, input);
  }

  summarizeTask(taskId: string): TokenUsageSummary {
    return summarize(this.storage.db, "task_id", taskId);
  }

  summarizeTurn(turnId: string): TokenUsageSummary {
    return summarize(this.storage.db, "usage_turn_id", turnId);
  }

  summarizeSession(sessionId: string): TokenUsageSummary {
    return summarize(this.storage.db, "session_id", sessionId);
  }
}

export function backfillTokenUsage(db: DatabaseSync): void {
  const selectMissing = db.prepare(`
    select c.id, c.session_id, c.task_id, c.turn_id, c.request_id, c.purpose,
           c.provider, c.model, c.response_body_json, c.created_at
    from llm_http_captures c
    left join token_usage u on u.request_id = c.request_id
    where u.request_id is null
    order by c.created_at, c.rowid
    limit 200
  `);
  type MissingCapture = {
    id: string; session_id: string; task_id: string | null; turn_id: string;
    request_id: string; purpose: LLMHttpCaptureInput["purpose"];
    provider: string; model: string; response_body_json: string; created_at: string;
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    while (true) {
      const rows = selectMissing.all() as MissingCapture[];
      if (rows.length === 0) break;
      for (const row of rows) {
        let responseBody: unknown;
        try { responseBody = JSON.parse(row.response_body_json); }
        catch { responseBody = row.response_body_json; }
        insertCaptureUsage(db, {
          captureId: row.id,
          createdAt: row.created_at,
          capture: {
            sessionId: row.session_id, taskId: row.task_id ?? "", turnId: row.turn_id,
            usageTurnId: row.purpose === "task_compaction" ? null : row.turn_id,
            requestId: row.request_id, purpose: row.purpose, provider: row.provider, model: row.model,
            responseBody
          }
        }, true);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function insertCaptureUsage(db: DatabaseSync, input: CaptureUsageInput, ignoreExisting = false): void {
  const usage = readUsage(input.capture.responseBody);
  const status = usage.promptTokens !== null && usage.completionTokens !== null && usage.totalTokens !== null
    ? "complete" : usage.promptTokens !== null || usage.completionTokens !== null || usage.totalTokens !== null
      ? "partial" : "unavailable";
  db.prepare(`
    insert into token_usage (
      capture_id, request_id, session_id, task_id, turn_id, usage_turn_id, purpose, provider, model,
      prompt_tokens, completion_tokens, total_tokens, status, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ${ignoreExisting ? "on conflict(request_id) do nothing" : ""}
  `).run(
    input.captureId, input.capture.requestId, input.capture.sessionId, input.capture.taskId || null,
    input.capture.turnId,
    input.capture.usageTurnId === undefined
      ? input.capture.purpose === "task_compaction" ? null : input.capture.turnId
      : input.capture.usageTurnId,
    input.capture.purpose ?? "turn", input.capture.provider, input.capture.model,
    usage.promptTokens, usage.completionTokens, usage.totalTokens, status, input.createdAt
  );
}

function readUsage(body: unknown): { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } {
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
  return {
    promptTokens: tokenCount(usage.prompt_tokens ?? usage.input_tokens),
    completionTokens: tokenCount(usage.completion_tokens ?? usage.output_tokens),
    totalTokens: tokenCount(usage.total_tokens)
  };
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarize(db: DatabaseSync, column: "task_id" | "usage_turn_id" | "session_id", id: string): TokenUsageSummary {
  const row = db.prepare(`
    select count(*) as requestCount,
           sum(case when status = 'complete' then 1 else 0 end) as completeCount,
           sum(case when status = 'partial' then 1 else 0 end) as partialCount,
           sum(case when status = 'unavailable' then 1 else 0 end) as unavailableCount,
           sum(prompt_tokens) as knownPromptTokens,
           sum(completion_tokens) as knownCompletionTokens,
           sum(total_tokens) as knownTotalTokens,
           count(prompt_tokens) as promptReportedCount,
           count(completion_tokens) as completionReportedCount,
           count(total_tokens) as totalReportedCount
    from token_usage where ${column} = ?
  `).get(id) as Record<keyof TokenUsageSummary, number | null>;
  return {
    requestCount: row.requestCount ?? 0,
    completeCount: row.completeCount ?? 0,
    partialCount: row.partialCount ?? 0,
    unavailableCount: row.unavailableCount ?? 0,
    knownPromptTokens: row.knownPromptTokens ?? 0,
    knownCompletionTokens: row.knownCompletionTokens ?? 0,
    knownTotalTokens: row.knownTotalTokens ?? 0,
    promptReportedCount: row.promptReportedCount ?? 0,
    completionReportedCount: row.completionReportedCount ?? 0,
    totalReportedCount: row.totalReportedCount ?? 0
  };
}
