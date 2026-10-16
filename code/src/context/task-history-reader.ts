import type { StorageManager } from "../storage/storage-manager.js";
import type { LLMMessage, LLMToolCall } from "../contracts/types.js";
import type { ConversationMessage } from "./conversation-message.js";
import { wireUsageScope } from "./conversation-message.js";
import { parseUsage } from "../llm/openai-compatible-provider.js";
import { buildToolResultMessage, buildNativeToolResultMessages } from "../loop/llm-message-builder.js";
import { ToolCallParser } from "../loop/tool-call-parser.js";
import { zhCN } from "../i18n/catalog.js";

export interface TaskHistoryTurn {
  id: string;
  seq: number;
  status: string;
  content: string;
}

type TurnRow = { id: string; task_seq: number; status: string; input: string };
type CaptureRow = { request_body_json: string; response_body_json: string };
type MessageCaptureRow = CaptureRow & { request_id: string; provider: string; model: string; response_status: number };
type ToolRow = { id: string; intent_id: string | null; round: number | null; tool_name: string; status: string; output_json: string | null; error_message: string | null };
type SnapshotRow = { source_ref: string; turn_id: string; message_json: string; usage_json: string | null;
  usage_scope: string | null; stop_reason: ConversationMessage["stopReason"] | null; omitted: number };

export class TaskHistoryReader {
  constructor(private readonly storage: StorageManager) {}

  sequenceOf(turnId: string): number | undefined {
    const row = this.storage.db.prepare("select task_seq from turns where id = ?").get(turnId) as { task_seq: number | null } | undefined;
    return row?.task_seq ?? undefined;
  }

  toolSourceRef(turnId: string, intentIds: string[], round?: number): string {
    const rows = this.storage.db.prepare("select id, intent_id, round from tool_calls where turn_id = ? order by started_at, rowid").all(turnId) as Array<{ id: string; intent_id: string | null; round: number | null }>;
    return `tool:${intentIds.map((id) => [...rows].reverse().find((row) => row.intent_id === id && (round === undefined || row.round === round))?.id ?? id).join(",")}:result`;
  }

  list(taskId: string, beforeSeq?: number): TaskHistoryTurn[] {
    const turns = this.storage.db.prepare(
      "select id, task_seq, status, input from turns where task_id = ? and task_seq is not null and (? is null or task_seq < ?) order by task_seq"
    ).all(taskId, beforeSeq ?? null, beforeSeq ?? null) as TurnRow[];
    return turns.map((turn) => ({ id: turn.id, seq: turn.task_seq, status: turn.status, content: this.content(turn) }));
  }

  messages(taskId: string, beforeSeq?: number): ConversationMessage[] {
    const turns = this.storage.db.prepare("select id, task_seq, status, input from turns where task_id = ? and task_seq is not null and (? is null or task_seq < ?) order by task_seq")
      .all(taskId, beforeSeq ?? null, beforeSeq ?? null) as TurnRow[];
    return turns.flatMap((turn) => this.turnMessages(turn));
  }

  captureMessages(taskId: string, beforeSeq?: number): ConversationMessage[] {
    const turns = this.storage.db.prepare("select id, task_seq, status, input from turns where task_id = ? and task_seq is not null and (? is null or task_seq < ?) order by task_seq")
      .all(taskId, beforeSeq ?? null, beforeSeq ?? null) as TurnRow[];
    return turns.flatMap((turn) => this.captureTurnMessages(turn));
  }

  private turnMessages(turn: TurnRow): ConversationMessage[] {
    return this.snapshotMessages(turn.id) ?? this.captureTurnMessages(turn);
  }

  private snapshotMessages(turnId: string): ConversationMessage[] | undefined {
    const hasSnapshots = this.storage.db.prepare("select 1 from sqlite_master where type = 'table' and name = 'context_messages'").get();
    if (hasSnapshots) {
      const rows = this.storage.db.prepare(
        "select source_ref, turn_id, message_json, usage_json, usage_scope, stop_reason, omitted from context_messages where turn_id = ? order by rowid"
      ).all(turnId) as SnapshotRow[];
      if (rows.length) return rows.map((row) => ({
        sourceRef: row.source_ref, turnId: row.turn_id, message: JSON.parse(row.message_json) as LLMMessage,
        ...(row.usage_json !== null ? { usage: JSON.parse(row.usage_json) as ConversationMessage["usage"] } : {}),
        ...(row.usage_scope !== null ? { usageScope: row.usage_scope } : {}),
        ...(row.stop_reason !== null ? { stopReason: row.stop_reason } : {}),
        ...(row.omitted === 1 ? { omitted: true } : {})
      }));
    }
    return undefined;
  }

  // 存量兼容：预览预算缺失时用默认值；已从后续请求移除的反馈没有精确来源，不伪造恢复。
  private captureTurnMessages(turn: TurnRow): ConversationMessage[] {
    const captures = this.storage.db.prepare("select request_id, provider, model, response_status, request_body_json, response_body_json from llm_http_captures where turn_id = ? and purpose = 'turn' order by created_at, rowid")
      .all(turn.id) as MessageCaptureRow[];
    const tools = this.storage.db.prepare("select id, intent_id, round, tool_name, status, output_json, error_message from tool_calls where turn_id = ? and intent_id is not null order by started_at, rowid")
      .all(turn.id) as ToolRow[];
    const firstRequest = parseJson(captures[0]?.request_body_json ?? "");
    const firstMessages = isRecord(firstRequest) && Array.isArray(firstRequest.messages) ? firstRequest.messages.filter(isRecord) : [];
    const initial = [...firstMessages].reverse().find((message) => message.role === "user" && typeof message.content === "string" && message.content.includes(turn.input));
    const result: ConversationMessage[] = [{ sourceRef: `turn:${turn.id}:user`, turnId: turn.id, message: { role: "user", content: typeof initial?.content === "string" ? initial.content : turn.input } }];
    const seen = new Set<string>();
    captures.forEach((capture, round) => {
      if (seen.has(capture.request_id)) return;
      seen.add(capture.request_id);
      const body = parseJson(capture.response_body_json);
      if (!isRecord(body) || capture.response_status < 200 || capture.response_status >= 300) {
        result.push({ sourceRef: `request:${capture.request_id}:response`, turnId: turn.id, message: { role: "assistant", content: "" }, stopReason: "error" });
        return;
      }
      const choice = Array.isArray(body.choices) && isRecord(body.choices[0]) ? body.choices[0] : undefined;
      const response = choice && isRecord(choice.message) ? choice.message : body;
      if (typeof response.content !== "string" && !Array.isArray(response.tool_calls)) return;
      const rawCalls = readWireCalls(response.tool_calls);
      const content = typeof response.content === "string" ? response.content : "";
      const next = parseJson(captures[round + 1]?.request_body_json ?? "");
      const nextMessages = isRecord(next) && Array.isArray(next.messages) ? next.messages.filter(isRecord) : [];
      const reversed = [...nextMessages].reverse();
      let reverseIndex = -1;
      if (rawCalls.length) reverseIndex = reversed.findIndex((item) => item.role === "assistant" &&
        readWireCalls(item.tool_calls).map((call) => call.id).join(",") === rawCalls.map((call) => call.id).join(","));
      if (reverseIndex < 0 && (!rawCalls.length || content)) {
        reverseIndex = reversed.findIndex((item) => item.role === "assistant" && item.content === content);
      }
      const assistantIndex = reverseIndex < 0 ? -1 : nextMessages.length - reverseIndex - 1;
      const projectedAssistant = assistantIndex >= 0 ? nextMessages[assistantIndex] : undefined;
      const clearedCalls = rawCalls.length > 0 && projectedAssistant &&
        (projectedAssistant.tool_calls === undefined || Array.isArray(projectedAssistant.tool_calls) && projectedAssistant.tool_calls.length === 0);
      const calls = clearedCalls ? [] : rawCalls;
      const message: LLMMessage = { role: "assistant", content, ...(calls.length ? { toolCalls: calls } : {}) };
      const request = parseJson(capture.request_body_json);
      const wireMessages = isRecord(request) && Array.isArray(request.messages) ? request.messages.filter(isRecord) : [];
      const system = wireMessages.filter((entry) => entry.role === "system").map((entry) => entry.content).join("\n");
      const finish = choice?.finish_reason ?? body.finishReason;
      result.push({ sourceRef: `request:${capture.request_id}:response`, turnId: turn.id, message,
        usage: parseUsage(body.usage), usageScope: wireUsageScope(capture.provider, capture.model, system, isRecord(request) ? request.tools : undefined),
        stopReason: finish === "length" ? "length" : finish === "tool_calls" ? "tool_calls" : "stop" });
      const roundTools = tools.filter((tool) => tool.round === round || tool.round === null && calls.some((call) => call.id === tool.intent_id));
      if (calls.length) {
        const observations = calls.map((call, index) => {
          const tool = roundTools.find((item) => item.intent_id === call.id);
          const wireResult = [...nextMessages].reverse().find((item) => item.role === "tool" && item.tool_call_id === call.id);
          return { call, index, tool, wireResult };
        }).filter(({ tool, wireResult }) => tool || wireResult || finish === "length");
        const fallback = buildNativeToolResultMessages(observations.map(({ call, tool }) => ({
          id: call.id, name: call.name, status: tool?.status === "completed" ? "completed" : "failed",
          output: parseJson(tool?.output_json ?? ""),
          ...(!tool && finish === "length" ? { errorCode: "truncated_tool_call", errorMessage: zhCN.agent.truncatedToolCall }
            : { errorMessage: tool?.error_message ?? undefined })
        })));
        for (const [fallbackIndex, { call, index, tool, wireResult }] of observations.entries()) {
          result.push({ sourceRef: finish === "length" && !tool ? `request:${capture.request_id}:truncated-tool:${index}` : `tool:${tool?.id ?? call.id}:result`, turnId: turn.id,
            message: typeof wireResult?.content === "string" ? { role: "tool", toolCallId: call.id, content: wireResult.content } : fallback[fallbackIndex] });
        }
      } else if (finish === "length" && roundTools.length === 0) {
        const action = new ToolCallParser().parse(content);
        if (action.kind === "tool_calls") result.push({ sourceRef: `request:${capture.request_id}:truncated-tool:0`, turnId: turn.id,
          message: buildToolResultMessage(action.calls.map((call) => ({ id: call.id, name: call.name,
            status: "failed", errorCode: "truncated_tool_call", errorMessage: zhCN.agent.truncatedToolCall }))) });
      }
      if (!calls.length && roundTools.length) {
        const ids = new Set(roundTools.map((tool) => tool.intent_id));
        const wireResult = [...nextMessages].reverse().find((entry) => {
          if (entry.role !== "user" || typeof entry.content !== "string") return false;
          const parsed = parseJson(entry.content);
          return isRecord(parsed) && parsed.type === "tool_results" && Array.isArray(parsed.results)
            && parsed.results.some((tool) => isRecord(tool) && ids.has(String(tool.id)));
        });
        result.push({ sourceRef: `tool:${roundTools.map((tool) => tool.id).join(",")}:result`, turnId: turn.id,
          message: { role: "user", content: typeof wireResult?.content === "string" ? wireResult.content : buildToolResultMessage(roundTools.map((tool) => ({ id: tool.intent_id!, name: tool.tool_name, status: tool.status === "completed" ? "completed" : "failed", output: parseJson(tool.output_json ?? ""), errorMessage: tool.error_message ?? undefined }))).content } });
      }
      if (assistantIndex >= 0) {
        nextMessages.slice(assistantIndex + 1).filter((item) => item.role === "user" && typeof item.content === "string" &&
          !(isRecord(parseJson(item.content)) && (parseJson(item.content) as Record<string, unknown>).type === "tool_results"))
          .forEach((item, index) => result.push({ sourceRef: `request:${capture.request_id}:feedback:${index}`, turnId: turn.id,
            message: { role: "user", content: item.content as string } }));
      }
    });
    return result;
  }

  private content(turn: TurnRow): string {
    const snapshots = this.snapshotMessages(turn.id);
    if (snapshots) return [`状态：${turn.status}`, `用户输入：\n${turn.input}`,
      ...snapshots.map((entry) => JSON.stringify(entry, null, 2))].join("\n\n");
    const captures = this.storage.db.prepare(
      "select request_body_json, response_body_json from llm_http_captures where turn_id = ? and purpose = 'turn' order by created_at, rowid"
    ).all(turn.id) as CaptureRow[];
    const results: unknown[] = [];
    const resultKeys = new Set<string>();
    let answer = "";
    for (const capture of captures) {
      const request = parseJson(capture.request_body_json);
      if (isRecord(request) && Array.isArray(request.messages)) {
        for (const message of request.messages) {
          if (!isRecord(message) || typeof message.content !== "string") continue;
          const content = parseJson(message.content);
          if (isRecord(content) && content.type === "tool_results" && Array.isArray(content.results)) {
            for (const result of content.results) {
              const key = JSON.stringify(result);
              if (resultKeys.has(key)) continue;
              resultKeys.add(key);
              results.push(result);
            }
          }
        }
      }
      const response = parseJson(capture.response_body_json);
      if (isRecord(response)) {
        if (typeof response.content === "string") answer = response.content;
        else if (Array.isArray(response.choices)) {
          const choice = response.choices[0];
          if (isRecord(choice) && isRecord(choice.message) && typeof choice.message.content === "string") {
            answer = choice.message.content;
          }
        }
      }
    }
    const parts = [`状态：${turn.status}`, `用户输入：\n${turn.input}`];
    if (results.length) parts.push(`工具结果：\n${JSON.stringify({ type: "tool_results", results }, null, 2)}`);
    if (answer) parts.push(`助手回答：\n${answer}`);
    return parts.join("\n\n");
  }
}

function readWireCalls(value: unknown): LLMToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || !isRecord(item.function) || typeof item.function.name !== "string") return [];
    const input = typeof item.function.arguments === "string" ? parseJson(item.function.arguments) : item.function.arguments;
    if (!isRecord(input)) return [];
    return [{ id: item.id, name: item.function.name, input }];
  });
}

function parseJson(content: string): unknown {
  try { return JSON.parse(content); } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
