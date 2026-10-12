import type {
  Artifact,
  LLMProvider,
  SkillRunResult,
  TurnResult
} from "../contracts/types.js";
import type { ContextFileReference } from "../contracts/types.js";
import type { ContextBuilder } from "../context/context-builder.js";
import type { CompactionService } from "../context/compaction-service.js";
import type { RuntimeContextConfig } from "../config/runtime-config.js";
import type { RuntimeAgentBehavior } from "../config/runtime-behavior.js";
import { defaultAgentBehavior } from "../config/runtime-behavior.js";
import type { VersionedPrompts } from "../config/prompt-config.js";
import { compactPriorRounds } from "../context/round-compaction.js";
import { buildInitialMessages, buildToolResultMessage } from "./llm-message-builder.js";
import type { PluginHost } from "../plugin/plugin-host.js";
import type { MarkdownReporter } from "../reporter/markdown-reporter.js";
import type { ProjectUnderstandingSkill } from "../skill/project-understanding-skill.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { TraceRecorder } from "../trace/trace-recorder.js";
import { createId } from "../utils/id.js";
import { ToolCallParser } from "./tool-call-parser.js";
import { ToolCallingRuntime } from "./tool-calling-runtime.js";
import { estimateMessageTokens } from "../token-usage/estimate-message-tokens.js";
import { FinalAnswerStream, hasFinalMarker } from "./final-answer-stream.js";

export interface RunTurnInput {
  sessionId: string;
  taskId: string;
  turnId: string;
  workspaceRoot: string;
  input: string;
  fileReferences?: ContextFileReference[];
}

export class AgentLoop {
  constructor(
    private readonly pluginHost: PluginHost,
    private readonly trace: TraceRecorder,
    private readonly options: {
      maxToolRounds: number;
      model?: string;
      llmId?: string;
      contextConfig?: RuntimeContextConfig;
      behavior?: RuntimeAgentBehavior;
      compaction?: CompactionService;
      loadPrompts?: () => Promise<VersionedPrompts>;
    } = { maxToolRounds: 3 }
  ) {}

  async runTurn(input: RunTurnInput, onTextDelta?: (delta: string) => void): Promise<TurnResult> {
    try {
      await this.trace.record({
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        type: "turn.processing",
        source: "AgentLoop",
        payload: {}
      });

      if (this.options.compaction && this.options.contextConfig) {
        await this.options.compaction.compactIfNeeded({
          sessionId: input.sessionId,
          taskId: input.taskId,
          turnId: input.turnId,
          keepRawTurns: this.options.contextConfig.maxTaskHistoryTurns
        }, this.options.contextConfig.compaction);
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

      const llm = this.pluginHost.requireCapability<LLMProvider>("llmProvider", this.options.llmId ?? "minimax");
      const skill = this.pluginHost.requireCapability<ProjectUnderstandingSkill>(
        "skill",
        "project-understanding-skill"
      );
      const skillResult = await runSingleSkill(skill, input, this.trace);
      const llmResponse = await this.runLlmToolLoop(input, llm, contextPack, onTextDelta, skillResult);

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
      await this.trace.record({
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        type: "turn.failed",
        source: "AgentLoop",
        payload: { message: error instanceof Error ? error.message : String(error) }
      });
      return {
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        status: "failed",
        message: "Turn 执行失败。",
        artifacts: [],
        error: {
          code: "turn_failed",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private async runLlmToolLoop(
    input: RunTurnInput,
    llm: LLMProvider,
    contextPack: Awaited<ReturnType<ContextBuilder["build"]>>,
    onTextDelta?: (delta: string) => void,
    skillResult?: SkillRunResult
  ) {
    const parser = new ToolCallParser();
    const registry = this.pluginHost.requireCapability<ToolRegistry>("tool", "registry");
    const promptConfig = await this.options.loadPrompts?.();
    const messages = buildInitialMessages(input.input, contextPack, {
      availableTools: registry.listTools(),
      maxToolRounds: this.options.maxToolRounds
    }, promptConfig?.prompts);
    if (promptConfig) await this.trace.record({
      sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId,
      type: "prompt.config.applied", source: "AgentLoop", payload: { version: promptConfig.version }
    });
    if (skillResult && skillResult.status !== "skipped") {
      messages[1].content += `\n\n项目理解 Skill 的本地预检结果（不是最终回答）：\n${skillResult.message}`;
    }

    for (let round = 0; round <= this.options.maxToolRounds; round++) {
      const roundConfig = this.options.contextConfig?.compaction;
      if (roundConfig?.autoEnabled && messages.reduce((sum, message) => sum + message.content.length, 0) >= roundConfig.charThreshold) {
        if (messages.length >= 6) {
          try {
            await this.trace.record({ sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId, type: "compaction.started", source: "AgentLoop", payload: { mode: "round", round } });
            const compacted = await compactPriorRounds(llm, {
              sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId,
              model: this.options.model ?? "MiniMax-M3", messages,
              maxSummaryChars: roundConfig.summaryMaxChars
            });
            messages.splice(0, messages.length, ...compacted);
            await this.trace.record({ sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId, type: "compaction.completed", source: "AgentLoop", payload: { mode: "round", round } });
          } catch (error) {
            await this.trace.record({ sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId, type: "compaction.failed", source: "AgentLoop", payload: { mode: "round", round, reason: error instanceof Error ? error.message : String(error) } });
          }
        } else {
          await this.trace.record({ sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId, type: "compaction.skipped", source: "AgentLoop", payload: { mode: "round", round, reason: "no older tool round" } });
        }
      }
      const estimatedInputTokens = estimateMessageTokens(messages);
      const requestId = createId("llm_req");
      await this.trace.record({
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        type: "llm.called",
        source: "AgentLoop",
        payload: { requestId, contextPackId: contextPack.id, estimatedInputTokens, round }
      });
      const answerStream = new FinalAnswerStream(onTextDelta ?? (() => {}));
      const llmResponse = await llm.complete({
        id: requestId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        contextPackId: contextPack.id,
        messages,
        model: this.options.model ?? "MiniMax-M3",
        estimatedInputTokens
      }, onTextDelta ? (delta) => answerStream.push(delta) : undefined);
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
      const parsed = hasFinalMarker(llmResponse.content) ? { kind: "none" as const } : parser.parse(llmResponse.content);
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
        return {
          ...llmResponse,
          content: `模型返回了不支持的工具调用格式，已拒绝执行工具。原因：${parsed.reason}`,
          outputLength: parsed.reason.length
        };
      }

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

      if (round === this.options.maxToolRounds) {
        await this.trace.record({
          sessionId: input.sessionId,
          taskId: input.taskId,
          turnId: input.turnId,
          type: "tool_call.round.limited",
          source: "AgentLoop",
          payload: { round, callCount: parsed.calls.length }
        });
        return {
          ...llmResponse,
          content: "工具调用轮次达到上限，已停止继续执行。",
          outputLength: 20
        };
      }

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
          workspaceRoot: input.workspaceRoot
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

      messages.push({ role: "assistant", content: llmResponse.content });
      messages.push(buildToolResultMessage(toolResults, this.options.behavior?.toolResultPreviewChars ?? defaultAgentBehavior.toolResultPreviewChars));
      await this.trace.record({
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        type: "tool_call.result.appended",
        source: "AgentLoop",
        payload: { round, resultCount: toolResults.length }
      });
    }

    throw new Error("unreachable tool calling loop state");
  }
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
