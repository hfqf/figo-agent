import type { LLMMessage, LLMProvider } from "../contracts/types.js";
import { createId } from "../utils/id.js";
import { parseModelJson } from "./model-json.js";
import { zhCN, formatLocaleTemplate } from "../i18n/catalog.js";

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
      { role: "system", content: formatLocaleTemplate(zhCN.agent.roundCompactionTemplate, { maxSummaryChars: input.maxSummaryChars }) },
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
