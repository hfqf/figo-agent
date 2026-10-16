import type { Artifact, CommandResult, ModelSelection, Session, Task, TraceEvent, Turn, TurnResult } from "../contracts/types.js";
import { getActiveLlmConfig, loadRuntimeConfig, type RuntimeLlmConfig } from "../config/runtime-config.js";
import { readPromptConfig } from "../config/prompt-config.js";
import { AgentLoop } from "../loop/agent-loop.js";
import type { LLMProvider } from "../contracts/types.js";
import { CompactionService } from "../context/compaction-service.js";
import { CompactionStore } from "../context/compaction-store.js";
import { TaskHistoryReader } from "../context/task-history-reader.js";
import { ContextMessageStore } from "../context/context-message-store.js";
import { createBuiltinPluginHost } from "../plugin/builtin-plugins.js";
import type { PluginHost } from "../plugin/plugin-host.js";
import type { MarkdownReporter } from "../reporter/markdown-reporter.js";
import { StorageManager } from "../storage/storage-manager.js";
import { TaskManager } from "../task/task-manager.js";
import { TraceRecorder } from "../trace/trace-recorder.js";
import { SessionManager } from "./session-manager.js";
import { TurnManager } from "./turn-manager.js";
import { TokenUsageStore } from "../token-usage/token-usage-store.js";
import { formatTokenUsageSummary } from "../token-usage/format-token-usage.js";
import { WorkspaceRunLease } from "../ui/workspace-run-lease.js";
import { createId } from "../utils/id.js";

export interface AgentKernelStartOptions {
  workspaceRoot: string;
  configRoot?: string;
}

export class AgentKernel {
  private constructor(
    public readonly storage: StorageManager,
    public readonly session: Session,
    private readonly trace: TraceRecorder,
    private readonly sessionManager: SessionManager,
    private readonly taskManager: TaskManager,
    private readonly turnManager: TurnManager,
    private readonly reporter: MarkdownReporter,
    private readonly loop: AgentLoop,
    private readonly compaction: CompactionService,
    private readonly pluginHost: PluginHost,
    private readonly runtimeModels: RuntimeLlmConfig[],
    private runtimeActiveModelId: string
  ) {}

  static async start(options: AgentKernelStartOptions): Promise<AgentKernel> {
    const runtimeConfig = await loadRuntimeConfig(options.configRoot ?? options.workspaceRoot);
    const activeLlm = getActiveLlmConfig(runtimeConfig);
    const storage = await StorageManager.init(options.workspaceRoot, runtimeConfig.storage);
    const trace = new TraceRecorder(storage);
    const sessionManager = new SessionManager(storage);
    const taskManager = new TaskManager(storage);
    const turnManager = new TurnManager(storage);
    const session = sessionManager.create(options.workspaceRoot);
    const defaultTask = taskManager.createDefault(session.id);

    await trace.record({
      sessionId: session.id,
      type: "session.started",
      source: "AgentKernel",
      payload: { cwd: options.workspaceRoot }
    });
    await trace.record({
      sessionId: session.id,
      taskId: defaultTask.id,
      type: "task.created",
      source: "AgentKernel",
      payload: { title: defaultTask.title, status: defaultTask.status }
    });

    const pluginHost = createBuiltinPluginHost(storage, trace, session.id, runtimeConfig);
    await pluginHost.setupAll({ sessionId: session.id });
    const reporter = pluginHost.requireCapability<MarkdownReporter>("reporter", "markdown");
    const compaction = new CompactionService(
      new TaskHistoryReader(storage), new CompactionStore(storage),
      pluginHost.requireCapability<LLMProvider>("llmProvider", activeLlm.id),
      trace, activeLlm.model, runtimeConfig.context.compaction, new ContextMessageStore(storage)
    );
    const loop = new AgentLoop(pluginHost, trace, {
      model: activeLlm.model,
      llmId: activeLlm.id,
      contextConfig: runtimeConfig.context,
      behavior: runtimeConfig.agent,
      compaction,
      resolveModelConfig: (providerId, modelId) => runtimeConfig.llm.find((entry) => entry.id === providerId && entry.model === modelId),
      loadPrompts: () => readPromptConfig(options.configRoot ?? options.workspaceRoot)
    });

    return new AgentKernel(storage, session, trace, sessionManager, taskManager, turnManager, reporter, loop, compaction, pluginHost, runtimeConfig.llm, runtimeConfig.activeModelId);
  }

  modelConfigs(): RuntimeLlmConfig[] { return this.runtimeModels.map((entry) => ({ ...entry })); }

  defaultModelSelection(): ModelSelection {
    const provider = this.runtimeModels.find((entry) => entry.id === this.runtimeActiveModelId)!;
    return { providerId: provider.id, modelId: provider.model };
  }

  validateModelSelection(selection?: ModelSelection): ModelSelection {
    const providerId = selection?.providerId ?? this.runtimeActiveModelId;
    const provider = this.runtimeModels.find((entry) => entry.id === providerId && entry.enabled);
    const modelId = selection?.modelId ?? provider?.model;
    if (!provider || !provider.apiKey.trim() || !modelId || modelId.length > 200 || /[\u0000-\u001f]/.test(modelId)) {
      throw new Error("所选模型配置无效或尚未在当前进程启用。");
    }
    return { providerId, modelId };
  }

  setDefaultModelSelection(selection: ModelSelection): void {
    const validated = this.validateModelSelection(selection);
    const provider = this.runtimeModels.find((entry) => entry.id === validated.providerId)!;
    if (provider.model !== validated.modelId) {
      delete provider.contextWindow;
      delete provider.maxTokens;
      delete provider.maxTokensField;
      delete provider.metadataSource;
    }
    provider.model = validated.modelId;
    this.runtimeActiveModelId = validated.providerId;
  }

  async submitTurn(input: string): Promise<TurnResult> {
    const release = new WorkspaceRunLease(this.storage).acquire(createId("cli_run"));
    try {
      return await this.submitTurnWithLease(input);
    } finally {
      release();
    }
  }

  private async submitTurnWithLease(input: string): Promise<TurnResult> {
    const task = this.taskManager.getCurrent(this.session.id);
    if (task.status !== "active") {
      await this.trace.record({
        sessionId: this.session.id,
        taskId: task.id,
        type: "task.command.rejected",
        source: "AgentKernel",
        payload: { status: task.status, input }
      });
      throw new Error(`当前 Task 状态为 ${task.status}，不能接收普通输入。`);
    }
    const turn = this.turnManager.create(this.session.id, task.id, input);
    return this.executeTurn(turn);
  }

  createTurnWithinTransaction(taskId: string, input: string): Turn {
    const task = this.taskManager.getById(taskId);
    if (task.sessionId !== this.session.id || task.status !== "active") {
      throw new Error("Task 不属于当前 Session 或状态不是 active。");
    }
    const current = this.taskManager.getCurrent(this.session.id);
    if (current.id !== taskId) throw new Error("请先切换到所选 Task。");
    return this.turnManager.createWithinTransaction(this.session.id, taskId, input);
  }

  onTraceEvent(subscriber: (event: TraceEvent) => void): () => void {
    return this.trace.subscribe(subscriber);
  }

  async executeTurn(turn: Turn): Promise<TurnResult> {
    this.turnManager.markProcessing(turn.id);
    const result = await this.runPreparedTurn(turn);
    if (result.status === "completed") this.turnManager.complete(turn.id);
    else this.turnManager.fail(turn.id);
    this.storage.db.prepare("update turns set output = ? where id = ?").run(result.message, turn.id);
    return result;
  }

  async runPreparedTurn(turn: Turn, onTextDelta?: (delta: string) => void, modelSelection?: ModelSelection, signal?: AbortSignal, onTextReset?: () => void): Promise<TurnResult> {
    const selected = modelSelection ? this.validateModelSelection(modelSelection) : this.defaultModelSelection();
    await this.trace.record({
      sessionId: this.session.id,
      taskId: turn.taskId,
      turnId: turn.id,
      type: "turn.received",
      source: "AgentKernel",
      payload: { input: turn.input }
    });

    return this.loop.runTurn({
      sessionId: this.session.id,
      taskId: turn.taskId,
      turnId: turn.id,
      workspaceRoot: this.storage.paths.workspaceRoot,
      input: turn.input,
      fileReferences: turn.fileReferences,
      modelSelection: selected,
      signal
    }, onTextDelta, onTextReset);

  }

  async handleCommand(command: string): Promise<CommandResult> {
    const trimmed = command.trim();
    if (trimmed === "/usage") {
      const task = this.taskManager.getCurrent(this.session.id);
      const usage = new TokenUsageStore(this.storage);
      return {
        status: "completed",
        message: [
          `当前 Task：${task.id}`,
          ...formatTokenUsageSummary(usage.summarizeTask(task.id)),
          "",
          `当前 Session：${this.session.id}`,
          ...formatTokenUsageSummary(usage.summarizeSession(this.session.id))
        ].join("\n"),
        artifacts: []
      };
    }
    if (/^\/compact(?:\s|$)/.test(trimmed)) {
      const task = this.taskManager.getCurrent(this.session.id);
      const selected = this.defaultModelSelection();
      const metadata = this.runtimeModels.find((entry) => entry.id === selected.providerId && entry.model === selected.modelId);
      const result = await this.compaction.compact({
        sessionId: this.session.id, taskId: task.id, mode: "manual", instructions: trimmed.slice("/compact".length).trim()
      }, { llm: this.pluginHost.requireCapability<LLMProvider>("llmProvider", selected.providerId), model: selected.modelId,
        providerId: selected.providerId, contextWindow: metadata?.contextWindow, maxTokens: metadata?.maxTokens, maxTokensField: metadata?.maxTokensField });
      return { status: result.status === "failed" ? "failed" : "completed", message: result.reason, artifacts: [] };
    }
    if (!trimmed.startsWith("/task")) {
      return { status: "failed", message: `未知命令：${command}`, artifacts: [] };
    }

    const [verb = "current", ...rest] = trimmed.replace(/^\/task\s*/, "").split(/\s+/).filter(Boolean);
    if (verb === "new") {
      const title = rest.join(" ") || "default";
      const task = this.taskManager.create(this.session.id, title);
      await this.recordTaskEvent(task, "task.created");
      return { status: "completed", message: formatTask(task), artifacts: [] };
    }

    if (verb === "current") {
      return { status: "completed", message: formatTask(this.taskManager.getCurrent(this.session.id)), artifacts: [] };
    }

    if (verb === "list") {
      const tasks = this.taskManager.listRunnable(this.session.id);
      return {
        status: "completed",
        message: tasks.length ? tasks.map(formatTask).join("\n") : "没有 active / paused Task。",
        artifacts: []
      };
    }

    if (verb === "switch") {
      const task = this.taskManager.switch(requiredId(rest[0]));
      await this.recordTaskEvent(task, "task.switched");
      return { status: "completed", message: formatTask(task), artifacts: [] };
    }

    if (verb === "pause") {
      const current = this.taskManager.getCurrent(this.session.id);
      const task = this.taskManager.pause(current.id);
      await this.recordTaskEvent(task, "task.paused");
      return { status: "completed", message: formatTask(task), artifacts: [] };
    }

    if (verb === "resume") {
      const task = this.taskManager.resume(requiredId(rest[0]));
      await this.recordTaskEvent(task, "task.resumed");
      return { status: "completed", message: formatTask(task), artifacts: [] };
    }

    if (verb === "finish") {
      const current = this.taskManager.getCurrent(this.session.id);
      await this.recordTaskEvent(current, "task.finish.requested");
      const task = this.taskManager.finish(current.id);
      const artifact = await this.reporter.writeTaskSummary(this.session.id, task.id);
      await this.recordTaskEvent(task, "task.summary.created", { artifactId: artifact.id, path: artifact.path });
      await this.recordTaskEvent(task, "task.completed");
      return {
        status: "completed",
        message: `Task 已完成：${task.title}\n${artifact.path}`,
        artifacts: [artifact]
      };
    }

    if (verb === "cancel") {
      const current = this.taskManager.getCurrent(this.session.id);
      await this.recordTaskEvent(current, "task.cancel.requested");
      const task = this.taskManager.cancel(current.id, rest.join(" ") || "cancelled by user");
      await this.recordTaskEvent(task, "task.cancelled");
      return { status: "completed", message: formatTask(task), artifacts: [] };
    }

    return { status: "failed", message: `未知 Task 命令：${trimmed}`, artifacts: [] };
  }

  async shutdown(): Promise<void> {
    this.sessionManager.end(this.session.id);
    await this.trace.record({
      sessionId: this.session.id,
      type: "session.ended",
      source: "AgentKernel",
      payload: {}
    });
  }

  private async recordTaskEvent(
    task: Task,
    type:
      | "task.created"
      | "task.switched"
      | "task.paused"
      | "task.resumed"
      | "task.finish.requested"
      | "task.completed"
      | "task.cancel.requested"
      | "task.cancelled"
      | "task.summary.created",
    payload: Record<string, unknown> = {}
  ): Promise<void> {
    await this.trace.record({
      sessionId: task.sessionId,
      taskId: task.id,
      type,
      source: "AgentKernel",
      payload: { title: task.title, status: task.status, ...payload }
    });
  }
}

function formatTask(task: Task): string {
  return `Task ${task.id}：${task.title}（${task.status}）`;
}

function requiredId(value: string | undefined): string {
  if (!value) throw new Error("缺少 Task id。");
  return value;
}
