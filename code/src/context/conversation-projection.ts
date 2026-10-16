import type { CompactionStore } from "./compaction-store.js";
import type { TaskHistoryReader } from "./task-history-reader.js";
import type { ConversationMessage } from "./conversation-message.js";
import { parseCompactionSummary } from "./compaction-summary.js";

export interface ConversationProjection {
  messages: ConversationMessage[];
  previousSummary?: string;
  baseEntryId?: string;
  legacyCheckpointId?: string;
}

export function readConversationProjection(history: TaskHistoryReader, store: CompactionStore, taskId: string, beforeSeq?: number): ConversationProjection {
  const raw = history.messages(taskId, beforeSeq);
  const entry = store.latestEntry(taskId);
  if (entry) {
    const omitted = new Set(Array.isArray(entry.details.omittedSourceRefs) ? entry.details.omittedSourceRefs as string[] : []);
    const index = raw.findIndex((message) => message.sourceRef === entry.firstKeptSourceRef);
    if (index === -1 && entry.firstKeptSourceRef !== entry.id) throw new Error(`压缩保留边界不存在：${entry.firstKeptSourceRef}`);
    const tail = index === -1 ? [] : raw.slice(index);
    const invalidUsage = new Set(Array.isArray(entry.details.boundaryRequestRefs) ? entry.details.boundaryRequestRefs as string[] : []);
    return { messages: tail.filter((message) => !message.omitted && !omitted.has(message.sourceRef) && message.stopReason !== "error" && message.stopReason !== "aborted").map((message) => invalidUsage.has(message.sourceRef) ? { ...message, usage: undefined } : message),
      previousSummary: entry.summaryMarkdown, baseEntryId: entry.id };
  }
  const legacy = store.latest(taskId);
  if (!legacy) return { messages: raw.filter((message) => !message.omitted && message.stopReason !== "error" && message.stopReason !== "aborted") };
  const turns = history.list(taskId, beforeSeq);
  const summary = parseCompactionSummary(legacy.summaryJson, turns.filter((turn) => turn.seq <= legacy.throughSeq).map((turn) => turn.id), Number.MAX_SAFE_INTEGER);
  const keptIds = new Set(turns.filter((turn) => turn.seq > legacy.throughSeq).map((turn) => turn.id));
  return { messages: raw.filter((message) => keptIds.has(message.turnId) && !message.omitted && message.stopReason !== "error" && message.stopReason !== "aborted").map((message) => ({ ...message, usage: undefined })),
    previousSummary: JSON.stringify(summary, null, 2), legacyCheckpointId: legacy.id };
}
