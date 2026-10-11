import type { LLMMessage, LLMProvider } from "../contracts/types.js";
import { createId } from "../utils/id.js";
import { parseModelJson } from "./model-json.js";

export interface RoundCompactionInput {
  sessionId: string;
  taskId: string;
  turnId: string;
  model: string;
  messages: LLMMessage[];
  maxSummaryChars: number;
}

export async function compactPriorRounds(llm: LLMProvider, input: RoundCompactionInput): Promise<LLMMessage[]> {
  if (input.messages.length < 6) return input.messages;
  const older = input.messages.slice(2, -2);
  const latest = input.messages.slice(-2);
  const response = await llm.complete({
    id: createId("llm_req"),
    sessionId: input.sessionId,
    taskId: input.taskId,
    turnId: input.turnId,
    model: input.model,
    purpose: "round_compaction",
    messages: [
      { role: "system", content: `将较早的工具往返压成严格 JSON：{"summary":"..."}。保留已观察到的事实与未决事项，不编造。summary 不超过 ${input.maxSummaryChars} 字符。` },
      { role: "user", content: JSON.stringify(older) }
    ]
  });
  let parsed: unknown;
  try { parsed = parseModelJson(response.content); }
  catch { throw new Error("round compaction summary is not JSON"); }
  if (!isRecord(parsed) || typeof parsed.summary !== "string" || !parsed.summary.trim() || parsed.summary.length > input.maxSummaryChars) {
    throw new Error("round compaction summary is invalid");
  }
  return [
    ...input.messages.slice(0, 2),
    { role: "user", content: JSON.stringify({ type: "round_summary", summary: parsed.summary }) },
    ...latest
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
