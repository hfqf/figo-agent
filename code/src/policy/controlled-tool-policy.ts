import type { Policy, PolicyDecision, PolicyRequest } from "../contracts/types.js";
import { defaultAllowedTools } from "../config/runtime-config.js";
import { assertInsideWorkspace } from "../utils/path.js";

const actionByToolName = new Map([
  ["list_files", "tool.list_files"],
  ["read_file", "tool.read_file"],
  ["search_text", "tool.search_text"],
  ["system_info", "tool.system_info"],
  ["path_stat", "tool.path_stat"],
  ["read_many_files", "tool.read_many_files"],
  ["workspace_summary", "tool.workspace_summary"],
  ["write_file", "tool.write_file"],
  ["apply_patch", "tool.apply_patch"],
  ["run_command", "tool.run_command"],
  ["git_status", "tool.git_status"],
  ["git_diff", "tool.git_diff"],
  ["git_log", "tool.git_log"],
  ["git_add", "tool.git_add"],
  ["git_commit", "tool.git_commit"],
  ["network_fetch", "tool.network_fetch"],
  ["browser_open", "tool.browser_open"],
  ["browser_snapshot", "tool.browser_snapshot"]
]);

const workspaceBoundActions = new Set([
  "tool.list_files",
  "tool.read_file",
  "tool.search_text",
  "tool.path_stat",
  "tool.read_many_files",
  "tool.workspace_summary",
  "tool.write_file",
  "tool.apply_patch",
  "tool.git_status",
  "tool.git_diff",
  "tool.git_log",
  "tool.git_add",
  "tool.git_commit"
]);

const urlActions = new Set(["tool.network_fetch", "tool.browser_open", "tool.browser_snapshot"]);

const dangerousCommandPatterns = [
  /\brm\s+-rf\s+\/(?:\s|$)/,
  /\bsudo\b/,
  /\bmkfs(?:\.[a-z0-9]+)?\b/,
  /\bdd\s+.*\bof=\/dev\//,
  /:\(\)\s*\{\s*:\|:&\s*\};:/
];

export class ControlledToolPolicy implements Policy {
  private readonly allowedActions: Set<string>;

  constructor(
    private readonly workspaceRoot: string,
    allowedTools: string[] = defaultAllowedTools
  ) {
    this.allowedActions = new Set(
      allowedTools.map((toolName) => actionByToolName.get(toolName)).filter((action): action is string => Boolean(action))
    );
  }

  async evaluate(request: PolicyRequest): Promise<PolicyDecision> {
    if (!this.allowedActions.has(request.action)) {
      return deny("tool_not_allowed", `受控策略未开放动作：${request.action}`);
    }

    if (workspaceBoundActions.has(request.action)) {
      try {
        const resources = resourcesFromRequest(request);
        for (const resource of resources) assertInsideWorkspace(this.workspaceRoot, resource || ".");
      } catch {
        return deny("path_outside_workspace", "路径越界，已拒绝访问工作区外资源。");
      }
    }

    if (request.action === "tool.run_command" || request.action.startsWith("tool.git_")) {
      try {
        assertInsideWorkspace(this.workspaceRoot, String(request.metadata.cwd ?? "."));
      } catch {
        return deny("path_outside_workspace", "命令工作目录越界，已拒绝执行。");
      }
    }

    if (request.action === "tool.run_command") {
      const command = String(request.metadata.command ?? request.resource ?? "");
      if (isDangerousCommand(command)) {
        return deny("action_not_supported", "命令命中危险模式，已拒绝执行。");
      }
    }

    if (urlActions.has(request.action) && request.resource !== ".") {
      if (!isHttpUrl(request.resource)) {
        return deny("action_not_supported", "网络和浏览器工具仅允许 http/https URL。");
      }
    }

    return {
      allowed: true,
      reason: "动作已在 V1.2 受控工具策略中开放。",
      code: "allowed"
    };
  }
}

export function isDangerousCommand(command: string): boolean {
  return dangerousCommandPatterns.some((pattern) => pattern.test(command));
}

function resourcesFromRequest(request: PolicyRequest): string[] {
  const paths = request.metadata.paths;
  if (Array.isArray(paths) && paths.every((item) => typeof item === "string")) return paths.length > 0 ? paths : ["."];
  return [request.resource || "."];
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function deny(code: PolicyDecision["code"], reason: string): PolicyDecision {
  return { allowed: false, reason, code };
}
