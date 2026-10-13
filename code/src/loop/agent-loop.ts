import type {
  Artifact,
  LLMProvider,
  SkillRunResult,
  TurnResult
} from "../contracts/types.js";
import type { ContextFileReference } from "../contracts/types.js";
import type { ModelSelection } from "../contracts/types.js";
import type { ContextBuilder } from "../context/context-builder.js";
import type { CompactionService } from "../context/compaction-service.js";
import type { RuntimeContextConfig } from "../config/runtime-config.js";
import type { RuntimeAgentBehavior } from "../config/runtime-behavior.js";
import { defaultAgentBehavior } from "../config/runtime-behavior.js";
import type { VersionedPrompts } from "../config/prompt-config.js";
import { createHash } from "node:crypto";
import { compactPriorRounds, splitPriorRounds } from "../context/round-compaction.js";
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
      loadPrompts?: () => Promise<VersionedPrompts>;
    } = {}
  ) {}

  async runTurn(input: RunTurnInput, onTextDelta?: (delta: string) => void): Promise<TurnResult> {
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

      if (this.options.compaction && this.options.contextConfig) {
        await this.options.compaction.compactIfNeeded({
          sessionId: input.sessionId,
          taskId: input.taskId,
          turnId: input.turnId,
          keepRawTurns: this.options.contextConfig.maxTaskHistoryTurns
        }, this.options.contextConfig.compaction, { llm, model: modelId });
      }

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
      const llmResponse = await this.runLlmToolLoop(input, llm, modelId, contextPack, onTextDelta, skillResult);
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
      const visibleError = error instanceof ProtocolResponseError || error instanceof NoProgressError;
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
    skillResult?: SkillRunResult
  ) {
    const parser = new ToolCallParser();
    const registry = this.pluginHost.requireCapability<ToolRegistry>("tool", "registry");
    const nativeTools = llm.toolCallingMode === "native";
    const promptConfig = await this.options.loadPrompts?.();
    const messages = buildInitialMessages(input.input, contextPack, {
      availableTools: registry.listTools(), workspaceRoot: input.workspaceRoot,
      toolCallingMode: nativeTools ? "native" : "text"
    }, promptConfig?.prompts);
    if (promptConfig) await this.trace.record({
      sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId,
      type: "prompt.config.applied", source: "AgentLoop", payload: { version: promptConfig.version }
    });
    if (skillResult && skillResult.status !== "skipped") {
      messages[1].content += `\n\n项目理解 Skill 的本地预检结果（不是最终回答）：\n${skillResult.message}`;
    }

    let protocolRepairAttempts = 0;
    const seenEvidence = new Set<string>();
    let noProgressRepeats = 0;

    for (let round = 0; ; round++) {
      input.signal?.throwIfAborted();
      const roundConfig = this.options.contextConfig?.compaction;
      if (roundConfig?.autoEnabled && messages.reduce((sum, message) => sum + message.content.length, 0) >= roundConfig.charThreshold) {
        if (messages.length >= 6) {
          const olderChars = splitPriorRounds(messages).older.reduce((sum, message) => sum + message.content.length, 0);
          if (olderChars <= roundConfig.summaryMaxChars + Math.floor(roundConfig.charThreshold / 4)) {
            await this.trace.record({ sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId,
              type: "compaction.skipped", source: "AgentLoop", payload: { mode: "round", round, reason: "insufficient_expected_savings", olderChars } });
          } else try {
            await this.trace.record({ sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId, type: "compaction.started", source: "AgentLoop", payload: { mode: "round", round } });
            const compacted = await compactPriorRounds(llm, {
              sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId,
              model: modelId, goal: input.input, messages,
              maxSummaryChars: roundConfig.summaryMaxChars,
              signal: input.signal
            });
            const beforeChars = messages.reduce((sum, message) => sum + message.content.length, 0);
            const afterChars = compacted.reduce((sum, message) => sum + message.content.length, 0);
            if (afterChars < beforeChars) {
              messages.splice(0, messages.length, ...compacted);
              await this.trace.record({ sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId,
                type: "compaction.completed", source: "AgentLoop", payload: { mode: "round", round, beforeChars, afterChars } });
            } else {
              await this.trace.record({ sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId,
                type: "compaction.skipped", source: "AgentLoop", payload: { mode: "round", round, reason: "no_reduction", beforeChars, afterChars } });
            }
          } catch (error) {
            if (input.signal?.aborted) throw error;
            await this.trace.record({ sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId, type: "compaction.failed", source: "AgentLoop", payload: { mode: "round", round, reason: error instanceof Error ? error.message : String(error) } });
          }
        } else {
          await this.trace.record({ sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId, type: "compaction.skipped", source: "AgentLoop", payload: { mode: "round", round, reason: "no older tool round" } });
        }
      }
      const availableTools = nativeTools ? registry.listTools() : undefined;
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
      const answerStream = new FinalAnswerStream(onTextDelta ?? (() => {}), nativeTools);
      const llmResponse = await llm.complete({
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
      const parsed = nativeTools
        ? llmResponse.toolCalls?.length
          ? llmResponse.content.trim() ? { kind: "invalid" as const, reason: "mixed_native_tool_response" }
            : { kind: "tool_calls" as const, calls: llmResponse.toolCalls }
          : llmResponse.finishReason === "tool_calls" ? { kind: "invalid" as const, reason: "missing_native_tool_calls" }
            : textAction.kind === "none" ? textAction
              : { kind: "invalid" as const, reason: textAction.kind === "invalid" ? textAction.reason : "text_tool_calls_in_native_mode" }
        : llmResponse.toolCalls?.length || llmResponse.finishReason === "tool_calls"
          ? { kind: "invalid" as const, reason: "unexpected_native_tool_calls" }
          : textAction;
      if (parsed.kind === "none") {
        await this.trace.record({
          sessionId: input.sessionId,
          taskId: input.taskId,
          turnId: input.turnId,
          type: "tool_call.parse.completed",
          source: "AgentLoop",
          payload: { round, callCount: 0 }
        });
        const content = answerStream.finish(llmResponse.content, true);
        return { ...llmResponse, content, outputLength: content.length };
      }
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
        messages.push({ role: "assistant", content: llmResponse.content });
        messages.push({ role: "user", content: nativeTools ? zhCN.agent.nativeProtocolRepair : zhCN.agent.protocolRepair });
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

      messages.push({ role: "assistant", content: llmResponse.content,
        ...(nativeTools ? { toolCalls: parsed.calls } : {}) });
      const configuredBatchChars = this.options.behavior?.toolResultBatchChars ?? defaultAgentBehavior.toolResultBatchChars;
      const remainingChars = this.options.contextConfig?.compaction.autoEnabled
        ? Math.max(1000, this.options.contextConfig.compaction.charThreshold - messages.reduce((sum, message) => sum + message.content.length, 0) - 256)
        : configuredBatchChars;
      const previewChars = this.options.behavior?.toolResultPreviewChars ?? defaultAgentBehavior.toolResultPreviewChars;
      const batchChars = Math.min(configuredBatchChars, remainingChars);
      if (nativeTools) messages.push(...buildNativeToolResultMessages(toolResults, previewChars, batchChars));
      else messages.push(buildToolResultMessage(toolResults, previewChars, batchChars));
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
        messages.push({ role: "user", content: zhCN.agent.noProgress });
      }
      await this.trace.record({
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        type: "tool_call.result.appended",
        source: "AgentLoop",
        payload: { round, resultCount: toolResults.length, newEvidenceCount, evidenceCount: evidence.length }
      });
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
