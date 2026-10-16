import { isDeepStrictEqual } from "node:util";
import type { LLMMessage } from "../src/contracts/types.js";
import type { ConversationMessage } from "../src/context/conversation-message.js";
import type { StorageManager } from "../src/storage/storage-manager.js";

export interface PiCompactionBranchInput {
  storage: Pick<StorageManager, "db">;
  taskId: string;
  turnId: string;
  prefixRequestIds: string[];
  prefixMessages: Array<Pick<ConversationMessage, "sourceRef" | "message" | "omitted" | "stopReason">>;
}

export interface PiCompactionSummaryCheck {
  entryId: string;
  summaryRequestId: string;
  nextRequestId: string | null;
  summaryInNextRequest: boolean;
  firstKeptSourceRef: string;
  retainedPrefixMessages: number;
  retainedPrefixUnchanged: boolean;
}

export interface PiCompactionBranchMeasurements {
  requestCount: number;
  turnRequestCount: number;
  summaryRequestCount: number;
  knownPromptTokens: number;
  knownCompletionTokens: number;
  missingUsageRequestCount: number;
  httpDurationMs: number;
  failedRequestCount: number;
  completedToolCount: number;
  protocolRepairCount: number;
  firstTurnRequestChars: number | null;
  prefixRequestIdsMatch: boolean;
  summaryChecks: PiCompactionSummaryCheck[];
}

type CaptureRow = {
  capture_order: number;
  request_id: string;
  purpose: string;
  request_body_json: string;
  request_chars: number;
  response_status: number;
  duration_ms: number;
  usage_status: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
};

type EntryRow = { id: string; request_id: string; first_kept_source_ref: string; summary_markdown: string };

export function measurePiCompactionBranch(input: PiCompactionBranchInput): PiCompactionBranchMeasurements {
  const { db } = input.storage;
  const captures = db.prepare(`
    select c.rowid as capture_order, c.request_id, c.purpose, c.request_body_json,
           length(c.request_body_json) as request_chars, c.response_status, c.duration_ms,
           u.status as usage_status, u.prompt_tokens, u.completion_tokens
    from llm_http_captures c left join token_usage u on u.capture_id = c.id
    where c.task_id = ? order by c.rowid
  `).all(input.taskId) as CaptureRow[];
  const prefixIds = new Set(input.prefixRequestIds);
  const added = captures.filter((capture) => !prefixIds.has(capture.request_id));
  const turnRequests = added.filter((capture) => capture.purpose === "turn");
  const entries = db.prepare(`
    select id, request_id, first_kept_source_ref, summary_markdown
    from context_compactions where task_id = ? order by seq
  `).all(input.taskId) as EntryRow[];
  const summaryChecks = entries.filter((entry) => !prefixIds.has(entry.request_id)).map((entry): PiCompactionSummaryCheck => {
    const summary = added.find((capture) => capture.request_id === entry.request_id);
    const next = summary ? turnRequests.find((capture) => capture.capture_order > summary.capture_order) : undefined;
    const messages = requestMessages(next?.request_body_json);
    const firstKept = input.prefixMessages.findIndex((message) => message.sourceRef === entry.first_kept_source_ref);
    // 先定位原始边界，再排除不进入模型投影的消息，不能将边界迁移到其它引用。
    const retained = firstKept < 0 ? [] : input.prefixMessages.slice(firstKept).filter((message) =>
      message.omitted !== true && message.stopReason !== "error" && message.stopReason !== "aborted");
    return {
      entryId: entry.id,
      summaryRequestId: entry.request_id,
      nextRequestId: next?.request_id ?? null,
      summaryInNextRequest: entry.summary_markdown.length > 0 && messages.some((message) =>
        isRecord(message) && typeof message.content === "string" && message.content.includes(entry.summary_markdown)),
      firstKeptSourceRef: entry.first_kept_source_ref,
      retainedPrefixMessages: retained.length,
      // 空保留段没有比对证据，不能利用 every([]) 的真值报告通过。
      retainedPrefixUnchanged: retained.length > 0 && messages.some((_, index) =>
        retained.every((item, offset) => sameMessage(item.message, messages[index + offset])))
    };
  });
  const completedTools = db.prepare(`
    select count(*) as count from tool_calls c join turns t on t.id = c.turn_id
    where t.task_id = ? and c.turn_id = ? and c.status = 'completed'
  `).get(input.taskId, input.turnId) as { count: number };
  const repairs = db.prepare(`
    select count(*) as count from trace_events
    where task_id = ? and turn_id = ? and type = 'tool_call.repair.requested'
  `).get(input.taskId, input.turnId) as { count: number };
  return {
    requestCount: added.length,
    turnRequestCount: turnRequests.length,
    summaryRequestCount: added.filter((capture) => capture.purpose === "task_compaction" || capture.purpose === "round_compaction").length,
    knownPromptTokens: added.reduce((sum, capture) => sum + (tokenCount(capture.prompt_tokens) ? capture.prompt_tokens : 0), 0),
    knownCompletionTokens: added.reduce((sum, capture) => sum + (tokenCount(capture.completion_tokens) ? capture.completion_tokens : 0), 0),
    missingUsageRequestCount: added.filter((capture) => capture.usage_status !== "complete" ||
      !tokenCount(capture.prompt_tokens) || !tokenCount(capture.completion_tokens)).length,
    httpDurationMs: added.reduce((sum, capture) => sum + capture.duration_ms, 0),
    failedRequestCount: added.filter((capture) => capture.response_status < 200 || capture.response_status >= 300).length,
    completedToolCount: completedTools.count,
    protocolRepairCount: repairs.count,
    firstTurnRequestChars: turnRequests[0]?.request_chars ?? null,
    prefixRequestIdsMatch: input.prefixRequestIds.every((id, index) => captures[index]?.request_id === id),
    summaryChecks
  };
}

function requestMessages(body?: string): unknown[] {
  const parsed = parseJson(body);
  return isRecord(parsed) && Array.isArray(parsed.messages) ? parsed.messages : [];
}

function sameMessage(expected: LLMMessage, actual: unknown): boolean {
  if (!isRecord(actual) || actual.role !== expected.role) return false;
  const content = actual.role === "assistant" && actual.content === null ? "" : actual.content;
  if (content !== expected.content) return false;
  if (expected.role === "tool" && (actual.tool_call_id ?? actual.toolCallId) !== expected.toolCallId) return false;
  const wireCalls = actual.tool_calls ?? actual.toolCalls ?? [];
  if (!Array.isArray(wireCalls)) return false;
  const calls = wireCalls.map((call): unknown => {
    if (!isRecord(call)) return undefined;
    if (isRecord(call.function) && call.type === "function") return {
      id: call.id, name: call.function.name, input: typeof call.function.arguments === "string" ? parseJson(call.function.arguments) : call.function.arguments
    };
    return { id: call.id, name: call.name, input: call.input };
  });
  return isDeepStrictEqual(calls, expected.toolCalls ?? []);
}

function parseJson(value?: string): unknown {
  if (value === undefined) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
