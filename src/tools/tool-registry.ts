import type {
  Policy,
  PolicyAction,
  PolicyDecision,
  Tool,
  ToolExecutionContext,
  ToolResult
} from "../contracts/types.js";
import type { TraceRecorder } from "../trace/trace-recorder.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<Record<string, unknown>, unknown>>();

  constructor(
    private readonly policy: Policy,
    private readonly trace?: TraceRecorder
  ) {}

  register(tool: Tool<Record<string, unknown>, unknown>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  listTools(): Array<{ name: string; description: string }> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description
    }));
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { status: "failed", errorMessage: `工具不存在：${name}`, errorCode: "tool_not_found" };
    }

    const action = toolAction(name);
    const resource = toolResource(name, input);
    const decision = await this.policy.evaluate({
      sessionId: context.sessionId,
      taskId: context.taskId,
      turnId: context.turnId,
      action,
      resource,
      metadata: { tool: name, ...toolMetadata(name, input) }
    });
    const policySource = this.policy.constructor.name || "Policy";
    await this.record(context, "policy.evaluated", policySource, {
      action,
      resource,
      allowed: decision.allowed,
      code: decision.code
    });

    if (!decision.allowed) {
      await this.record(context, "policy.denied", policySource, {
        action,
        resource,
        code: decision.code
      });
      await this.record(context, "tool.denied", "ToolRegistry", {
        tool: name,
        code: decision.code
      });
      return {
        status: "failed",
        errorMessage: decision.reason,
        errorCode: decision.code
      };
    }

    try {
      await this.record(context, "tool.called", "ToolRegistry", { tool: name, input });
      const result = await tool.execute(input, context);
      await this.record(context, result.status === "completed" ? "tool.completed" : "tool.failed", "ToolRegistry", {
        tool: name,
        status: result.status
      });
      return result;
    } catch (error) {
      await this.record(context, "tool.failed", "ToolRegistry", {
        tool: name,
        message: error instanceof Error ? error.message : String(error)
      });
      return {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        errorCode: "tool_failed"
      };
    }
  }

  private async record(
    context: ToolExecutionContext,
    type: "policy.evaluated" | "policy.denied" | "tool.called" | "tool.completed" | "tool.failed" | "tool.denied",
    source: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.trace) return;
    await this.trace.record({
      sessionId: context.sessionId,
      taskId: context.taskId,
      turnId: context.turnId,
      type,
      source,
      payload
    });
  }
}

function toolAction(name: string): PolicyAction {
  if (name === "list_files") return "tool.list_files";
  if (name === "read_file") return "tool.read_file";
  if (name === "search_text") return "tool.search_text";
  if (name === "system_info") return "tool.system_info";
  if (name === "path_stat") return "tool.path_stat";
  if (name === "read_many_files") return "tool.read_many_files";
  if (name === "workspace_summary") return "tool.workspace_summary";
  if (name === "write_file") return "tool.write_file";
  if (name === "apply_patch") return "tool.apply_patch";
  if (name === "git_status") return "tool.git_status";
  if (name === "git_diff") return "tool.git_diff";
  if (name === "git_log") return "tool.git_log";
  if (name === "git_add") return "tool.git_add";
  if (name === "git_commit") return "tool.git_commit";
  if (name === "network_fetch") return "tool.network_fetch";
  if (name === "browser_open") return "tool.browser_open";
  if (name === "browser_snapshot") return "tool.browser_snapshot";
  return "tool.run_command";
}

function toolResource(name: string, input: Record<string, unknown>): string {
  if (name === "run_command") return String(input.command ?? ".");
  if (name === "network_fetch" || name === "browser_open" || name === "browser_snapshot") {
    return String(input.url ?? ".");
  }
  if (name === "read_many_files") {
    const paths = Array.isArray(input.paths) ? input.paths.map(String) : ["."];
    return paths[0] ?? ".";
  }
  if (name === "apply_patch") {
    const paths = patchPaths(input.patches);
    return paths[0] ?? ".";
  }
  return String(input.path ?? ".");
}

function toolMetadata(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (name === "run_command") return { command: String(input.command ?? ""), cwd: String(input.cwd ?? ".") };
  if (name === "read_many_files") {
    return { paths: Array.isArray(input.paths) ? input.paths.map(String) : [] };
  }
  if (name === "apply_patch") return { paths: patchPaths(input.patches) };
  if (name === "git_add") {
    return { paths: Array.isArray(input.paths) ? input.paths.map(String) : ["."], cwd: String(input.cwd ?? ".") };
  }
  if (name.startsWith("git_")) return { cwd: String(input.cwd ?? ".") };
  return {};
}

function patchPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String((item as Record<string, unknown>).path ?? "")).filter(Boolean);
}

export function policyDecisionToToolResult(decision: PolicyDecision): ToolResult {
  return {
    status: "failed",
    errorMessage: decision.reason,
    errorCode: decision.code
  };
}
