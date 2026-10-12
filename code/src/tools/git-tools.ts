import { join } from "node:path";
import type { Tool } from "../contracts/types.js";
import { assertInsideWorkspace } from "../utils/path.js";
import { runShellCommand, type CommandToolOutput } from "./command-tools.js";
import { defaultToolDefaults, type RuntimeToolDefaults } from "../config/runtime-behavior.js";

export function createGitTools(defaults: RuntimeToolDefaults = defaultToolDefaults): Array<Tool<Record<string, unknown>, unknown>> {
  return [gitStatusTool, gitDiffTool, gitLogTool, gitAddTool, gitCommitTool].map((tool) => ({
    ...tool,
    execute: (input, context) => tool.execute({
      timeoutMs: defaults.gitTimeoutMs, maxOutputBytes: defaults.gitMaxOutputBytes,
      ...(tool.name === "git_log" ? { maxCount: defaults.gitLogCount } : {}), ...input
    }, context)
  }));
}

const gitStatusTool: Tool<Record<string, unknown>, CommandToolOutput> = {
  name: "git_status",
  description: "查看 git 状态",
  execute: async (input, context) => runGitTool(context.workspaceRoot, input, "git status --short")
};

const gitDiffTool: Tool<Record<string, unknown>, CommandToolOutput> = {
  name: "git_diff",
  description: "查看 git diff",
  execute: async (input, context) => runGitTool(context.workspaceRoot, input, "git diff --")
};

const gitLogTool: Tool<Record<string, unknown>, CommandToolOutput> = {
  name: "git_log",
  description: "查看 git 日志",
  execute: async (input, context) => {
    const maxCount = boundedInteger(input.maxCount, 5, 1, 100);
    return runGitTool(context.workspaceRoot, input, `git log --oneline -n ${maxCount}`);
  }
};

const gitAddTool: Tool<Record<string, unknown>, CommandToolOutput> = {
  name: "git_add",
  description: "添加文件到 git 暂存区",
  execute: async (input, context) => {
    const paths = parsePaths(input.paths);
    for (const path of paths) assertInsideWorkspace(context.workspaceRoot, path);
    return runGitTool(context.workspaceRoot, input, `git add -- ${paths.map(shellQuote).join(" ")}`);
  }
};

const gitCommitTool: Tool<Record<string, unknown>, CommandToolOutput> = {
  name: "git_commit",
  description: "创建 git commit",
  execute: async (input, context) => {
    const message = String(input.message ?? "").trim();
    if (!message) {
      return { status: "failed", errorCode: "invalid_commit_message", errorMessage: "提交信息不能为空。" };
    }
    return runGitTool(context.workspaceRoot, input, `git commit -m ${shellQuote(message)}`);
  }
};

async function runGitTool(workspaceRoot: string, input: Record<string, unknown>, command: string) {
  const cwdPath = assertInsideWorkspace(workspaceRoot, String(input.cwd ?? "."));
  const cwd = join(workspaceRoot, cwdPath);
  const timeoutMs = boundedInteger(input.timeoutMs, 30_000, 1_000, 120_000);
  const maxOutputBytes = boundedInteger(input.maxOutputBytes, 128 * 1024, 1024, 1024 * 1024);
  const output = await runShellCommand(command, cwd, timeoutMs, maxOutputBytes);
  return { status: "completed" as const, output };
}

function parsePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return ["."];
  const paths = value.map(String).filter(Boolean);
  return paths.length > 0 ? paths : ["."];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numericValue)));
}
