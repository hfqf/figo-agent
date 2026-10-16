import type {
  Artifact,
  LLMProvider,
  LLMResponse,
  SkillRunResult,
  TurnResult
} from "../contracts/types.js";
import type { ContextFileReference } from "../contracts/types.js";
import type { ModelSelection } from "../contracts/types.js";
import type { ContextBuilder } from "../context/context-builder.js";
import type { CompactionService } from "../context/compaction-service.js";
import type { RuntimeLlmConfig } from "../config/runtime-config.js";
import type { ConversationMessage } from "../context/conversation-message.js";
import { conversationUsageScope } from "../context/conversation-message.js";
import { isContextOverflowError } from "../llm/llm-request-error.js";
import type { RuntimeContextConfig } from "../config/runtime-config.js";
import type { RuntimeAgentBehavior } from "../config/runtime-behavior.js";
import { defaultAgentBehavior } from "../config/runtime-behavior.js";
import type { VersionedPrompts } from "../config/prompt-config.js";
import { createHash } from "node:crypto";
import { buildInitialMessages, buildNativeToolResultMessages, buildToolResultMessage } from "./llm-message-builder.js";
import type { ToolExecutionRecord } from "./llm-message-builder.js";
import type { PluginHost } from "../plugin/plugin-host.js";
import type { MarkdownReporter } from "../reporter/markdown-reporter.js";
import type { ProjectUnderstandingSkill } from "../skill/project-understanding-skill.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { TraceRecorder } from "../trace/trace-recorder.js";
import { createId } from "../utils/id.js";
import { ToolCallParser } from "./tool-call-parser.js";
import { ToolCallingRuntime } from "./tool-calling-runtime.js";
import { estimateMessageTokens } from "../token-usage/estimate-message-tokens.js";
import { FinalAnswerStream } from "./final-answer-stream.js";
import { zhCN } from "../i18n/catalog.js";

class ProtocolResponseError extends Error {}
class NoProgressError extends Error {}
class RecoveryResponseError extends Error {}

export interface RunTurnInput {
  sessionId: string;
  taskId: string;
  turnId: string;
  workspaceRoot: string;
  input: string;
  fileReferences?: ContextFileReference[];
  modelSelection?: ModelSelection;
  signal?: AbortSignal;
}

export class AgentLoop {
  constructor(
    private readonly pluginHost: PluginHost,
    private readonly trace: TraceRecorder,
    private readonly options: {
      model?: string;
      llmId?: string;
      contextConfig?: RuntimeContextConfig;
      behavior?: RuntimeAgentBehavior;
      compaction?: CompactionService;
      resolveModelConfig?: (providerId: string, modelId: string) => RuntimeLlmConfig | undefined;
      loadPrompts?: () => Promise<VersionedPrompts>;
    } = {}
  ) {}

  async runTurn(input: RunTurnInput, onTextDelta?: (delta: string) => void, onTextReset?: () => void): Promise<TurnResult> {
    try {
      input.signal?.throwIfAborted();
      const providerId = input.modelSelection?.providerId ?? this.options.llmId ?? "minimax";
      const modelId = input.modelSelection?.modelId ?? this.options.model ?? "MiniMax-M3";
      const llm = this.pluginHost.requireCapability<LLMProvider>("llmProvider", providerId);
      await this.trace.record({
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        type: "turn.processing",
        source: "AgentLoop",
        payload: { providerId, modelId }
      });

      const contextBuilder = this.pluginHost.requireCapability<ContextBuilder>(
        "contextSource",
        "context-builder"
      );
      const contextPack = await contextBuilder.build(input);
      await this.trace.record({
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        type: "context.build.completed",
        source: "ContextBuilder",
        payload: { contextPackId: contextPack.id, estimatedTokens: contextPack.estimatedTokens }
      });

      const skill = this.pluginHost.requireCapability<ProjectUnderstandingSkill>(
        "skill",
        "project-understanding-skill"
      );
      const skillResult = await runSingleSkill(skill, input, this.trace);
      input.signal?.throwIfAborted();
      const llmResponse = await this.runLlmToolLoop(input, llm, modelId, contextPack, onTextDelta, skillResult, onTextReset);
      input.signal?.throwIfAborted();

      const reporter = this.pluginHost.requireCapability<MarkdownReporter>("reporter", "markdown");
      const artifacts = await reporter.writeTurnArtifacts({
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        input: input.input,
        contextPack,
        summary: llmResponse.content
      });
      await recordArtifacts(this.trace, input, artifacts);

      await this.trace.record({
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        type: "turn.completed",
        source: "AgentLoop",
        payload: {}
      });

      return {
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        status: "completed",
        message: llmResponse.content,
        artifacts
      };
    } catch (error) {
      const visibleError = error instanceof ProtocolResponseError || error instanceof NoProgressError || error instanceof RecoveryResponseError;
      await this.trace.record({
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        type: input.signal?.aborted ? "turn.interrupted" : "turn.failed",
        source: "AgentLoop",
        payload: { message: error instanceof Error ? error.message : String(error) }
      });
      return {
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        status: "failed",
        message: visibleError ? error.message : "Turn 执行失败。",
        artifacts: [],
        error: {
          code: error instanceof ProtocolResponseError ? "model_protocol_error" : error instanceof NoProgressError ? "no_progress" : "turn_failed",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private async runLlmToolLoop(
    input: RunTurnInput,
    llm: LLMProvider,
    modelId: string,
    contextPack: Awaited<ReturnType<ContextBuilder["build"]>>,
    onTextDelta?: (delta: string) => void,
    skillResult?: SkillRunResult,
    onTextReset?: () => void
  ) {
    const parser = new ToolCallParser();
    const registry = this.pluginHost.requireCapability<ToolRegistry>("tool", "registry");
    const nativeTools = llm.toolCallingMode === "native";
    const promptConfig = await this.options.loadPrompts?.();
    const initialMessages = buildInitialMessages(input.input, this.options.compaction ? {
      ...contextPack, items: contextPack.items.filter((item) => !["turn", "task_turn", "task_compaction"].includes(item.sourceType))
    } : contextPack, {
      availableTools: registry.listTools(), workspaceRoot: input.workspaceRoot,
      toolCallingMode: nativeTools ? "native" : "text"
    }, promptConfig?.prompts);
    if (promptConfig) await this.trace.record({
      sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId,
      type: "prompt.config.applied", source: "AgentLoop", payload: { version: promptConfig.version }
    });
    if (skillResult && skillResult.status !== "skipped") {
      initialMessages[1].content += `\n\n项目理解 Skill 的本地预检结果（不是最终回答）：\n${skillResult.message}`;
    }

    const providerId = input.modelSelection?.providerId ?? this.options.llmId ?? "minimax";
    const selectedConfig = this.options.resolveModelConfig?.(providerId, modelId);
    const modelConfig = selectedConfig ? { ...selectedConfig } : undefined;
    const availableTools = nativeTools ? registry.listTools() : undefined;
    const system = initialMessages[0].content;
    const usageScope = conversationUsageScope(providerId, modelId, system, availableTools);
    const loaded = this.options.compaction?.loadConversation(input.taskId);
    let conversation: ConversationMessage[] = loaded?.messages.filter((entry) => entry.turnId !== input.turnId) ?? [];
    let summaryMarkdown = loaded?.previousSummary;
    let messages = initialMessages;
    const rebuild = () => {
      messages = [initialMessages[0], ...(summaryMarkdown ? [{ role: "user" as const, content: summaryMarkdown }] : []),
        ...conversation.map((entry) => entry.message)];
    };
    const persist = async (entry: ConversationMessage) => {
      await this.options.compaction?.recordMessages?.(input, [entry]);
    };
    const append = async (entry: ConversationMessage) => {
      await persist(entry);
      conversation.push(entry);
      messages.push(entry.message);
    };
    const compact = async (mode: "auto" | "recovery", omittedSourceRefs?: string[]) => {
      if (!this.options.compaction) return false;
      const result = await this.options.compaction.compact({
        sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId, mode, messages: [...conversation],
        system, usageScope, availableTools, previousSummary: summaryMarkdown, signal: input.signal, omittedSourceRefs
      }, { llm, model: modelId, providerId, contextWindow: modelConfig?.contextWindow,
        maxTokens: modelConfig?.maxTokens, maxTokensField: modelConfig?.maxTokensField });
      input.signal?.throwIfAborted();
      if (result.status !== "completed") return false;
      conversation = result.messages!;
      summaryMarkdown = result.summaryMarkdown;
      rebuild();
      return true;
    };
    if (this.options.compaction) {
      // Pi 在追加新用户输入前检查历史，工具循环则在确需继续时检查。
      await compact("auto");
      await append({ sourceRef: `turn:${input.turnId}:user`, turnId: input.turnId, message: initialMessages[1] });
      rebuild();
    }
    let recoveryAttempted = false;

    let protocolRepairAttempts = 0;
    const seenEvidence = new Set<string>();
    let noProgressRepeats = 0;

    for (let round = 0; ; round++) {
      input.signal?.throwIfAborted();
      if (round > 0) await compact("auto");
      const estimatedInputTokens = estimateMessageTokens(messages, availableTools);
      const requestId = createId("llm_req");
      await this.trace.record({
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        type: "llm.called",
        source: "AgentLoop",
        payload: { requestId, contextPackId: contextPack.id, estimatedInputTokens, round, providerId: input.modelSelection?.providerId ?? this.options.llmId ?? "minimax", modelId }
      });
      let bufferedText = "";
      let emittedText = false;
      let acceptedText = false;
      const discardText = () => {
        bufferedText = "";
        if (emittedText) {
          emittedText = false;
          onTextReset?.();
        }
      };
      // 支持 reset 的消费者保留流式体验；旧回调只接收已确认的最终答案。
      const answerStream = new FinalAnswerStream((delta) => {
        if (!delta) return;
        if (onTextReset && onTextDelta) {
          emittedText = true;
          onTextDelta(delta);
        } else bufferedText += delta;
      }, nativeTools);
      try {
        let llmResponse: LLMResponse;
        try {
          llmResponse = await llm.complete({
            id: requestId,
            sessionId: input.sessionId,
            taskId: input.taskId,
            turnId: input.turnId,
            contextPackId: contextPack.id,
            messages,
            availableTools,
            model: modelId,
            estimatedInputTokens,
            signal: input.signal
          }, onTextDelta ? (delta) => answerStream.push(delta) : undefined);
        } catch (error) {
          discardText();
          await persist({ sourceRef: `request:${requestId}:response`, turnId: input.turnId, message: { role: "assistant", content: "" }, stopReason: "error" });
          await this.trace.record({ sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId,
            type: "llm.failed", source: "AgentLoop", payload: { requestId, round, contextOverflow: isContextOverflowError(error) } });
          if (input.signal?.aborted) throw error;
          if (!isContextOverflowError(error)) throw error;
          if (recoveryAttempted) throw new RecoveryResponseError(zhCN.agent.compactionRecoveryFailed);
          recoveryAttempted = true;
          if (await compact("recovery", [`request:${requestId}:response`])) continue;
          throw new RecoveryResponseError(zhCN.agent.compactionRecoveryFailed);
        }
        input.signal?.throwIfAborted();
        await this.trace.record({
          sessionId: input.sessionId,
          taskId: input.taskId,
          turnId: input.turnId,
          type: "llm.completed",
          source: "AgentLoop",
          payload: { requestId, outputLength: llmResponse.outputLength, round }
        });

        await this.trace.record({
          sessionId: input.sessionId,
          taskId: input.taskId,
          turnId: input.turnId,
          type: "tool_call.parse.started",
          source: "AgentLoop",
          payload: { round }
        });
        const textAction = parser.parse(llmResponse.content);
        const responseEntry: ConversationMessage = {
          sourceRef: `request:${requestId}:response`, turnId: input.turnId,
          message: { role: "assistant", content: llmResponse.content, ...(nativeTools && llmResponse.toolCalls?.length ? { toolCalls: llmResponse.toolCalls } : {}) },
          usage: llmResponse.usage, usageScope, stopReason: llmResponse.finishReason
        };
        const truncatedCalls = llmResponse.toolCalls?.length ? llmResponse.toolCalls : textAction.kind === "tool_calls" ? textAction.calls : [];
        if (llmResponse.finishReason === "length" && truncatedCalls.length) {
          discardText();
          if (protocolRepairAttempts >= (this.options.behavior?.protocolRepairAttempts ?? defaultAgentBehavior.protocolRepairAttempts)) throw new ProtocolResponseError(zhCN.agent.protocolFailed);
          protocolRepairAttempts++;
          await append(responseEntry);
          // 不执行截断响应中尚未确认完整的工具调用，补齐协议结果后继续正常调度。
          const failures = truncatedCalls.map((call) => ({
            id: call.id, name: call.name, status: "failed" as const, errorCode: "truncated_tool_call", errorMessage: zhCN.agent.truncatedToolCall
          }));
          const failed = nativeTools ? buildNativeToolResultMessages(failures) : [buildToolResultMessage(failures)];
          for (const [index, message] of failed.entries()) await append({ sourceRef: `request:${requestId}:truncated-tool:${index}`, turnId: input.turnId, message });
          recoveryAttempted = false;
          continue;
        }
        const usage = llmResponse.usage;
        const recoverableLength = llmResponse.finishReason === "length" && usage && (
          (modelConfig?.maxTokens !== undefined && usage.output < modelConfig.maxTokens) ||
          (modelConfig?.contextWindow !== undefined && usage.output === 0 && usage.input + usage.cacheRead >= modelConfig.contextWindow * 0.99));
        if (recoverableLength) {
          discardText();
          await persist(responseEntry);
          if (recoveryAttempted) throw new RecoveryResponseError(zhCN.agent.compactionRecoveryFailed);
          recoveryAttempted = true;
          if (await compact("recovery", [responseEntry.sourceRef])) continue;
          throw new RecoveryResponseError(zhCN.agent.compactionRecoveryFailed);
        }
        recoveryAttempted = false;
        if (llmResponse.finishReason === "error") throw new RecoveryResponseError(zhCN.agent.modelResponseFailed);
        const parsed = nativeTools
          ? llmResponse.toolCalls?.length
            ? { kind: "tool_calls" as const, calls: llmResponse.toolCalls }
            : llmResponse.finishReason === "tool_calls" ? { kind: "invalid" as const, reason: "missing_native_tool_calls" }
              : textAction.kind === "none" ? textAction
                : { kind: "invalid" as const, reason: textAction.kind === "invalid" ? textAction.reason : "text_tool_calls_in_native_mode" }
          : llmResponse.toolCalls?.length || llmResponse.finishReason === "tool_calls"
            ? { kind: "invalid" as const, reason: "unexpected_native_tool_calls" }
            : textAction;
        if (parsed.kind === "none") {
          await persist(responseEntry);
          await this.trace.record({
            sessionId: input.sessionId,
            taskId: input.taskId,
            turnId: input.turnId,
            type: "tool_call.parse.completed",
            source: "AgentLoop",
            payload: { round, callCount: 0 }
          });
          input.signal?.throwIfAborted();
          const content = answerStream.finish(llmResponse.content, true);
          if (!onTextReset && bufferedText) onTextDelta?.(bufferedText);
          acceptedText = true;
          return { ...llmResponse, content, outputLength: content.length };
        }
        discardText();
        if (parsed.kind === "invalid") {
          await this.trace.record({
            sessionId: input.sessionId,
            taskId: input.taskId,
            turnId: input.turnId,
            type: "tool_call.parse.failed",
            source: "AgentLoop",
            payload: { round, reason: parsed.reason }
          });
          if (protocolRepairAttempts >= (this.options.behavior?.protocolRepairAttempts ?? defaultAgentBehavior.protocolRepairAttempts)) {
            throw new ProtocolResponseError(zhCN.agent.protocolFailed);
          }
          protocolRepairAttempts++;
          await append({ ...responseEntry, message: { role: "assistant", content: llmResponse.content } });
          await append({ sourceRef: `request:${requestId}:feedback:0`, turnId: input.turnId,
            message: { role: "user", content: nativeTools ? zhCN.agent.nativeProtocolRepair : zhCN.agent.protocolRepair } });
          await this.trace.record({
            sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId,
            type: "tool_call.repair.requested", source: "AgentLoop", payload: { round, reason: parsed.reason }
          });
          continue;
        }

        protocolRepairAttempts = 0;

        await this.trace.record({
          sessionId: input.sessionId,
          taskId: input.taskId,
          turnId: input.turnId,
          type: "tool_call.parse.completed",
          source: "AgentLoop",
          payload: {
            round,
            callCount: parsed.calls.length,
            calls: parsed.calls.map((call) => ({ id: call.id, name: call.name }))
          }
        });

        await this.trace.record({
          sessionId: input.sessionId,
          taskId: input.taskId,
          turnId: input.turnId,
          type: "tool_call.round.started",
          source: "AgentLoop",
          payload: { round, callCount: parsed.calls.length }
        });
        const runtime = new ToolCallingRuntime(registry);
        const toolResults = await runtime.executeBatch(
          parsed.calls,
          {
            sessionId: input.sessionId,
            taskId: input.taskId,
            turnId: input.turnId,
            workspaceRoot: input.workspaceRoot,
            signal: input.signal
          },
          round
        );
        await this.trace.record({
          sessionId: input.sessionId,
          taskId: input.taskId,
          turnId: input.turnId,
          type: "tool_call.round.completed",
          source: "AgentLoop",
          payload: {
            round,
            results: toolResults.map((result) => ({
              id: result.id,
              name: result.name,
              status: result.status
            }))
          }
        });

        await append(responseEntry);
        const previewChars = this.options.behavior?.toolResultPreviewChars ?? defaultAgentBehavior.toolResultPreviewChars;
        const batchChars = this.options.behavior?.toolResultBatchChars ?? defaultAgentBehavior.toolResultBatchChars;
        if (nativeTools) {
          for (const [index, message] of buildNativeToolResultMessages(toolResults, previewChars, batchChars).entries()) await append({
            sourceRef: this.options.compaction?.toolSourceRef(input.turnId, [toolResults[index].id], round) ?? `tool:${toolResults[index].id}:result`,
            turnId: input.turnId, message
          });
        } else await append({
          sourceRef: this.options.compaction?.toolSourceRef(input.turnId, toolResults.map((result) => result.id), round) ?? `tool:${toolResults.map((result) => result.id).join(",")}:result`,
          turnId: input.turnId, message: buildToolResultMessage(toolResults, previewChars, batchChars)
        });
        const evidence = toolResults.flatMap(toolEvidenceFingerprints);
        const newEvidenceCount = new Set(evidence.filter((item) => !seenEvidence.has(item))).size;
        for (const item of evidence) seenEvidence.add(item);
        noProgressRepeats = newEvidenceCount === 0 ? noProgressRepeats + 1 : 0;
        if (noProgressRepeats > 0) {
          await this.trace.record({ sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId,
            type: "tool_call.no_progress", source: "AgentLoop", payload: { round, repeats: noProgressRepeats, evidenceCount: evidence.length } });
          if (noProgressRepeats >= (this.options.behavior?.noProgressRepeatLimit ?? defaultAgentBehavior.noProgressRepeatLimit)) {
            throw new NoProgressError(zhCN.agent.noProgressFailed);
          }
          await append({ sourceRef: `request:${requestId}:feedback:0`, turnId: input.turnId, message: { role: "user", content: zhCN.agent.noProgress } });
        }
        await this.trace.record({
          sessionId: input.sessionId,
          taskId: input.taskId,
          turnId: input.turnId,
          type: "tool_call.result.appended",
          source: "AgentLoop",
          payload: { round, resultCount: toolResults.length, newEvidenceCount, evidenceCount: evidence.length }
        });
      } finally {
        if (!acceptedText) discardText();
      }
    }

  }
}

function toolEvidenceFingerprints(result: ToolExecutionRecord): string[] {
  const output = result.output;
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  if (result.status === "completed" && output && typeof output === "object") {
    if (result.name === "read_file" && "path" in output && "content" in output) {
      return [hash({ type: "file", path: output.path, content: output.content })];
    }
    if (result.name === "read_many_files" && "files" in output && Array.isArray(output.files)) {
      const files = output.files.map((file: { path: string; content: string; truncated: boolean }) =>
        hash({ type: "file", path: file.path, content: file.content, ...(file.truncated ? { truncated: true } : {}) }));
      const errors = "errors" in output && Array.isArray(output.errors)
        ? output.errors.map((error: { path: string; code: string }) => hash({ type: "file_error", path: error.path, code: error.code }))
        : [];
      return files.length + errors.length > 0 ? [...files, ...errors] : [hash({ name: result.name, status: result.status, output })];
    }
  }
  return [hash({ name: result.name, status: result.status, output, errorCode: result.errorCode, errorMessage: result.errorMessage })];
}

async function runSingleSkill(
  skill: ProjectUnderstandingSkill,
  input: RunTurnInput,
  trace: TraceRecorder
): Promise<SkillRunResult> {
  if (!skill.canHandle(input.input)) {
    await trace.record({
      sessionId: input.sessionId,
      taskId: input.taskId,
      turnId: input.turnId,
      type: "skill.skipped",
      source: "AgentLoop",
      payload: { skill: skill.name }
    });
    return { status: "skipped", message: "未激活 Skill。", artifacts: [] };
  }

  await trace.record({
    sessionId: input.sessionId,
    taskId: input.taskId,
    turnId: input.turnId,
    type: "skill.activated",
    source: "AgentLoop",
    payload: { skill: skill.name }
  });
  const result = await skill.run(input);
  await trace.record({
    sessionId: input.sessionId,
    taskId: input.taskId,
    turnId: input.turnId,
    type: result.status === "completed" ? "skill.completed" : "skill.failed",
    source: "AgentLoop",
    payload: { skill: skill.name, status: result.status }
  });
  return result;
}

async function recordArtifacts(
  trace: TraceRecorder,
  input: RunTurnInput,
  artifacts: Artifact[]
): Promise<void> {
  for (const artifact of artifacts) {
    await trace.record({
      sessionId: input.sessionId,
      taskId: input.taskId,
      turnId: input.turnId,
      type: "artifact.created",
      source: "MarkdownReporter",
      payload: { artifactId: artifact.id, type: artifact.type, path: artifact.path }
    });
  }
}
