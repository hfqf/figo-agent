import type { Policy, PolicyDecision, PolicyRequest } from "../contracts/types.js";
import { assertInsideWorkspace } from "../utils/path.js";

const allowedActions = new Set([
  "tool.list_files",
  "tool.read_file",
  "tool.search_text",
  "tool.system_info",
  "tool.path_stat",
  "tool.read_many_files",
  "tool.workspace_summary"
]);

export class ReadOnlyPolicy implements Policy {
  constructor(private readonly workspaceRoot: string) {}

  async evaluate(request: PolicyRequest): Promise<PolicyDecision> {
    if (!allowedActions.has(request.action)) {
      return {
        allowed: false,
        reason: "只读策略仅允许文件读取、文本搜索和安全观察类工具。",
        code: "tool_not_allowed"
      };
    }

    try {
      assertInsideWorkspace(this.workspaceRoot, request.resource || ".");
    } catch {
      return {
        allowed: false,
        reason: "路径越界，已拒绝访问工作区外资源。",
        code: "path_outside_workspace"
      };
    }

    return {
      allowed: true,
      reason: "只读操作位于工作区内，允许执行。",
      code: "allowed"
    };
  }
}
