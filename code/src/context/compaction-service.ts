import type { LLMProvider, LLMToolDefinition } from "../contracts/types.js";
import type { TraceRecorder } from "../trace/trace-recorder.js";
import { readPiCompactionSettings, resolvePiCompactionSettings, type PiCompactionSettings } from "../config/pi-compaction-settings.js";
import { evaluateCompactionPolicy } from "./compaction-policy.js";
import type { CompactionStore } from "./compaction-store.js";
import type { TaskHistoryReader } from "./task-history-reader.js";
import type { ConversationMessage } from "./conversation-message.js";
import { estimateConversation, prepareConversationCompaction } from "./compaction-preparation.js";
import { readConversationProjection } from "./conversation-projection.js";
import { generatePiSummary } from "./pi-summary.js";
import type { ContextMessageStore } from "./context-message-store.js";
import { createId } from "../utils/id.js";

export interface CompactInput {
  sessionId: string;
  taskId: string;
  turnId?: string;
  mode: "manual" | "auto" | "recovery";
  beforeSeq?: number;
  messages?: ConversationMessage[];
  system?: string;
  availableTools?: LLMToolDefinition[];
  usageScope?: string;
  previousSummary?: string;
  instructions?: string;
  signal?: AbortSignal;
  omittedSourceRefs?: string[];
  recoveryOfRequestId?: string;
  compactionAttemptId?: string;
}
export interface CompactionModel {
  llm: LLMProvider;
  model: string;
  providerId?: string;
  contextWindow?: number;
  maxTokens?: number;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
}
export interface CompactResult {
  status: "completed" | "skipped" | "failed";
  checkpointId?: string;
  coveredTurnIds: string[];
  reason: string;
  messages?: ConversationMessage[];
  summaryMarkdown?: string;
}

export class CompactionService {
  constructor(
    private readonly history: TaskHistoryReader,
    private readonly store: CompactionStore,
    private readonly llm: LLMProvider,
    private readonly trace: TraceRecorder,
    private readonly model: string,
    private readonly config: PiCompactionSettings = readPiCompactionSettings(undefined),
    private readonly messageStore?: ContextMessageStore
  ) {}

  loadConversation(taskId: string, beforeSeq?: number) {
    return readConversationProjection(this.history, this.store, taskId, beforeSeq);
  }
  toolSourceRef(turnId: string, intentIds: string[], round?: number): string {
    return this.history.toolSourceRef(turnId, intentIds, round);
  }

  async recordMessages(input: { sessionId: string; taskId: string; turnId: string }, messages: ConversationMessage[]): Promise<void> {
    this.messageStore?.append(input.taskId, messages);
    await this.trace.record({ ...input, type: "context.messages.appended", source: "ContextMessageStore", payload: { sourceRefs: messages.map((message) => message.sourceRef) } });
  }

  async compact(input: CompactInput, override?: CompactionModel): Promise<CompactResult> {
    input = { ...input, compactionAttemptId: createId("compact_attempt") };
    const requestIds: string[] = [];
    const model = override ?? { llm: this.llm, model: this.model };
    const settings = resolvePiCompactionSettings(this.config, model.providerId ?? "", model.model);
    let coveredTurnIds: string[] = [];
    try {
      input.signal?.throwIfAborted();
      if (input.omittedSourceRefs?.length) {
        this.messageStore?.omit(input.taskId, input.omittedSourceRefs);
        await this.trace.record({ sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId,
          type: "context.messages.omitted", source: "ContextMessageStore", payload: { sourceRefs: input.omittedSourceRefs,
            compactionAttemptId: input.compactionAttemptId, recoveryOfRequestId: input.recoveryOfRequestId } });
      }
      if (input.mode === "recovery" && !settings.enabled) {
        await this.record(input, "compaction.skipped", { mode: input.mode, reason: "disabled" });
        return { status: "skipped", coveredTurnIds, reason: "disabled" };
      }
      const loaded = input.messages ? undefined : this.loadConversation(input.taskId, input.beforeSeq);
      const base = this.store.latestEntry(input.taskId);
      const previousSummary = input.previousSummary ?? base?.summaryMarkdown ?? loaded?.previousSummary;
      const messages = input.messages ?? loaded!.messages;
      const usageScope = input.usageScope ?? "";
      const estimate = estimateConversation(messages, usageScope, input.system, previousSummary, input.availableTools);
      const decision = evaluateCompactionPolicy({ contextTokens: estimate.tokens, contextWindow: model.contextWindow }, settings);
      if (input.mode === "auto" && !decision.trigger) {
        await this.record(input, "compaction.skipped", { mode: input.mode, reason: decision.reason,
          contextWindow: model.contextWindow ?? null, reserveTokens: settings.reserveTokens, keepRecentTokens: settings.keepRecentTokens,
          providerId: model.providerId, model: model.model, ...estimate });
        return { status: "skipped", coveredTurnIds, reason: decision.reason };
      }
      await this.record(input, "compaction.requested", { mode: input.mode, contextTokens: estimate.tokens,
        contextWindow: model.contextWindow ?? null, reserveTokens: settings.reserveTokens, keepRecentTokens: settings.keepRecentTokens,
        providerId: model.providerId, model: model.model, estimateSource: estimate.source,
        omittedSourceRefs: input.omittedSourceRefs ?? [], policyReason: input.mode === "auto" ? decision.reason : input.mode });
      const omittedRefs = new Set(input.omittedSourceRefs ?? []);
      const omittedEntries = omittedRefs.size ? this.history.messages(input.taskId).filter((entry) => omittedRefs.has(entry.sourceRef)) : [];
      const preparation = prepareConversationCompaction(messages, settings.keepRecentTokens, usageScope, previousSummary, input.system, omittedEntries, input.availableTools);
      if (!preparation) {
        await this.record(input, "compaction.skipped", { mode: input.mode, reason: "no_summarizable_prefix", tokensBefore: estimate.tokens });
        return { status: "skipped", coveredTurnIds, reason: "没有可压缩的历史前缀" };
      }
      const covered = [...preparation.history, ...preparation.turnPrefix];
      coveredTurnIds = [...new Set(covered.map((entry) => entry.turnId))];
      await this.record(input, "compaction.started", { mode: input.mode, firstKeptSourceRef: preparation.firstKeptSourceRef,
        sourceRefs: covered.map((entry) => entry.sourceRef), tokensBefore: preparation.tokensBefore, isSplitTurn: preparation.isSplitTurn,
        historyMessages: preparation.history.length, turnPrefixMessages: preparation.turnPrefix.length, retainedMessages: preparation.retained.length });
      const summary = await generatePiSummary(model.llm, { history: preparation.history, turnPrefix: preparation.turnPrefix,
        previousSummary, previousReadFiles: base?.details.readFiles, previousModifiedFiles: base?.details.modifiedFiles,
        sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId ?? messages.at(-1)!.turnId,
        usageTurnId: input.mode === "manual" ? null : input.turnId ?? null, model: model.model,
        maxTokens: model.maxTokens, maxTokensField: model.maxTokensField, reserveTokens: settings.reserveTokens,
        summaryToolResultMaxChars: settings.summaryToolResultMaxChars, instructions: input.instructions, signal: input.signal,
        onRequest: (requestId) => requestIds.push(requestId) });
      input.signal?.throwIfAborted();
      const modifiedFiles = [...new Set([...(base?.details.modifiedFiles ?? []), ...summary.modifiedFiles])];
      const readFiles = [...new Set([...(base?.details.readFiles ?? []), ...summary.readFiles])].filter((file) => !modifiedFiles.includes(file));
      const checkpoint = this.store.appendEntry({ taskId: input.taskId, baseEntryId: base?.id,
        firstKeptSourceRef: preparation.firstKeptSourceRef, coveredSourceRefs: covered.map((entry) => entry.sourceRef),
        summaryMarkdown: summary.summaryMarkdown, details: { readFiles, modifiedFiles, requestIds: summary.requestIds,
          compactionAttemptId: input.compactionAttemptId, recoveryOfRequestId: input.recoveryOfRequestId,
          estimateSource: estimate.source, contextWindow: model.contextWindow ?? null,
          reserveTokens: settings.reserveTokens, keepRecentTokens: settings.keepRecentTokens,
          isSplitTurn: preparation.isSplitTurn, omittedSourceRefs: [...new Set([...(Array.isArray(base?.details.omittedSourceRefs) ? base!.details.omittedSourceRefs as string[] : []), ...(input.omittedSourceRefs ?? [])])],
          usage: summary.usage ?? null, providerId: model.providerId, model: model.model,
          boundaryRequestRefs: messages.filter((entry) => entry.message.role === "assistant").map((entry) => entry.sourceRef) },
        tokensBefore: preparation.tokensBefore, requestId: summary.requestId });
      const retained = preparation.retained.map((message) => ({ ...message, usage: undefined }));
      const tokensAfter = estimateConversation(retained, usageScope, input.system, summary.summaryMarkdown, input.availableTools).tokens;
      try {
        await this.record(input, "compaction.completed", { mode: input.mode, checkpointId: checkpoint.id,
          requestId: summary.requestId, requestIds: summary.requestIds, tokensBefore: preparation.tokensBefore, tokensAfter,
          tokensBeforeSource: estimate.source, tokensAfterSource: "estimate",
          firstKeptSourceRef: checkpoint.firstKeptSourceRef, summaryChars: summary.summaryMarkdown.length, retainedMessages: retained.length });
      } catch { /* 已提交的条目不能因通知失败改报未提交。 */ }
      return { status: "completed", checkpointId: checkpoint.id, coveredTurnIds, reason: "上下文压缩完成",
        messages: retained, summaryMarkdown: summary.summaryMarkdown };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.record(input, "compaction.failed", { mode: input.mode, reason, coveredTurnIds, requestIds });
      return { status: "failed", coveredTurnIds, reason };
    }
  }

  private async record(input: CompactInput, type: "compaction.requested" | "compaction.started" | "compaction.completed" | "compaction.skipped" | "compaction.failed", payload: Record<string, unknown>): Promise<void> {
    await this.trace.record({ sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId, type, source: "CompactionService",
      payload: { ...payload, compactionAttemptId: input.compactionAttemptId, recoveryOfRequestId: input.recoveryOfRequestId } });
  }
}
