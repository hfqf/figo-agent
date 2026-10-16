import type { ConversationMessage } from "./conversation-message.js";
import { wireToolDefinitions } from "./conversation-message.js";
import type { LLMToolDefinition } from "../contracts/types.js";
import { estimateContextTokens, estimateTokens, findProjectedCutPoint, type PiMessage, type PiProjectedEntry } from "./pi-compaction.js";

export interface ConversationCompactionPreparation {
  firstKeptSourceRef: string;
  history: ConversationMessage[];
  turnPrefix: ConversationMessage[];
  retained: ConversationMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
}

export function toPiMessage(entry: ConversationMessage, usageScope?: string): PiMessage {
  const { message } = entry;
  if (message.role === "assistant") return {
    role: "assistant", content: [
      ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
      ...(message.toolCalls ?? []).map((call) => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: call.input }))
    ],
    ...(entry.usage && entry.usageScope === usageScope ? { usage: entry.usage } : {}),
    stopReason: entry.stopReason === "length" ? "length" : entry.stopReason === "error" || entry.stopReason === "aborted" ? entry.stopReason : "stop"
  };
  let isTextResult = false;
  if (message.role === "user") {
    try { isTextResult = JSON.parse(message.content)?.type === "tool_results"; } catch { /* 普通用户文本。 */ }
  }
  if (message.role === "tool" || isTextResult) return { role: "toolResult", content: [{ type: "text", text: message.content }] };
  if (message.role === "system") return { role: "system", content: message.content };
  return { role: "user", content: message.content };
}

export function estimateConversation(messages: ConversationMessage[], usageScope: string, system = "", previousSummary?: string, tools?: LLMToolDefinition[]) {
  const projected = messages.map((entry) => toPiMessage(entry, usageScope));
  const estimate = estimateContextTokens(projected);
  return { ...estimate, source: estimate.lastUsageIndex === null ? "estimate" as const : "usage" as const,
    tokens: estimate.tokens + (estimate.lastUsageIndex !== null ? 0 : estimateTokens({ role: "system", content: system, toolsAdded: wireToolDefinitions(tools) })
      + (previousSummary ? estimateTokens({ role: "compactionSummary", summary: previousSummary }) : 0)) };
}

export function prepareConversationCompaction(messages: ConversationMessage[], keepRecentTokens: number, usageScope: string, previousSummary?: string, system = "", omittedEntries: ConversationMessage[] = [], tools?: LLMToolDefinition[]): ConversationCompactionPreparation | undefined {
  const omittedRefs = new Set(omittedEntries.map((entry) => entry.sourceRef));
  const sourceEntries = [...messages, ...omittedEntries];
  const projected: PiProjectedEntry[] = sourceEntries.map((entry) => {
    const message = toPiMessage(entry, usageScope);
    return { sourceEntry: { type: "message", id: entry.sourceRef, message }, messages: omittedRefs.has(entry.sourceRef) ? [] : [message] };
  });
  if (projected.length === 0) return undefined;
  const cut = findProjectedCutPoint(projected, 0, projected.length, keepRecentTokens);
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const visible = (entries: ConversationMessage[]) => entries.filter((entry) => !omittedRefs.has(entry.sourceRef));
  const history = visible(sourceEntries.slice(0, historyEnd));
  const turnPrefix = cut.isSplitTurn ? visible(sourceEntries.slice(cut.turnStartIndex, cut.firstKeptEntryIndex)) : [];
  if (history.length === 0 && turnPrefix.length === 0) return undefined;
  return {
    firstKeptSourceRef: sourceEntries[cut.firstKeptEntryIndex].sourceRef,
    history, turnPrefix, retained: visible(sourceEntries.slice(cut.firstKeptEntryIndex)), isSplitTurn: cut.isSplitTurn,
    tokensBefore: estimateConversation(messages, usageScope, system, previousSummary, tools).tokens, previousSummary
  };
}
