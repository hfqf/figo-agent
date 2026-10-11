import type { Artifact, CommandResult, Session, Task, TurnResult } from "../contracts/types.js";
import { AgentLoop } from "../loop/agent-loop.js";
import type { LLMProvider } from "../contracts/types.js";
import { CompactionService } from "../context/compaction-service.js";
import { CompactionStore } from "../context/compaction-store.js";
import { TaskHistoryReader } from "../context/task-history-reader.js";
import { createBuiltinPluginHost } from "../plugin/builtin-plugins.js";
import type { MarkdownReporter } from "../reporter/markdown-reporter.js";
import { StorageManager } from "../storage/storage-manager.js";
import { TaskManager } from "../task/task-manager.js";
import { TraceRecorder } from "../trace/trace-recorder.js";
import { SessionManager } from "./session-manager.js";
import { TurnManager } from "./turn-manager.js";

export interface AgentKernelStartOptions {
  workspaceRoot: string;
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
    private readonly compaction: CompactionService
  ) {}

  static async start(options: AgentKernelStartOptions): Promise<AgentKernel> {
    const storage = await StorageManager.init(options.workspaceRoot);
    const runtimeConfig = await loadRuntimeConfig(options.workspaceRoot);
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
      pluginHost.requireCapability<LLMProvider>("llmProvider", "minimax"),
      trace, runtimeConfig.llm.model, runtimeConfig.context.compaction.summaryMaxChars
    );
    const loop = new AgentLoop(pluginHost, trace, {
      maxToolRounds: runtimeConfig.tools.maxToolRounds,
      model: runtimeConfig.llm.model,
      contextConfig: runtimeConfig.context,
      compaction
    });

    return new AgentKernel(storage, session, trace, sessionManager, taskManager, turnManager, reporter, loop, compaction);
  }

  async submitTurn(input: string): Promise<TurnResult> {
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
    await this.trace.record({
      sessionId: this.session.id,
      taskId: task.id,
      turnId: turn.id,
      type: "turn.received",
      source: "AgentKernel",
      payload: { input }
    });

    this.turnManager.markProcessing(turn.id);
    const result = await this.loop.runTurn({
      sessionId: this.session.id,
      taskId: task.id,
      turnId: turn.id,
      workspaceRoot: this.storage.paths.workspaceRoot,
      input
    });

    if (result.status === "completed") {
      this.turnManager.complete(turn.id);
    } else {
      this.turnManager.fail(turn.id);
    }
    return result;
  }

  async handleCommand(command: string): Promise<CommandResult> {
    const trimmed = command.trim();
    if (trimmed === "/compact") {
      const task = this.taskManager.getCurrent(this.session.id);
      const result = await this.compaction.compact({
        sessionId: this.session.id, taskId: task.id, mode: "manual", keepRawTurns: 1
      });
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
import { loadRuntimeConfig } from "../config/runtime-config.js";
