import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Tool } from "../contracts/types.js";
import { isDangerousCommand } from "../policy/controlled-tool-policy.js";
import { assertInsideWorkspace } from "../utils/path.js";

export interface CommandToolOutput {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
}

export function createCommandTools(): Array<Tool<Record<string, unknown>, unknown>> {
  return [runCommandTool];
}

const runCommandTool: Tool<Record<string, unknown>, CommandToolOutput> = {
  name: "run_command",
  description: "在工作区内执行受控 shell 命令",
  execute: async (input, context) => {
    const command = String(input.command ?? "");
    if (!command.trim()) {
      return { status: "failed", errorCode: "invalid_command", errorMessage: "命令不能为空。" };
    }
    if (isDangerousCommand(command)) {
      return { status: "failed", errorCode: "action_not_supported", errorMessage: "命令命中危险模式。" };
    }
    const cwdPath = assertInsideWorkspace(context.workspaceRoot, String(input.cwd ?? "."));
    const cwd = join(context.workspaceRoot, cwdPath);
    const timeoutMs = boundedInteger(input.timeoutMs, 30_000, 1_000, 120_000);
    const maxOutputBytes = boundedInteger(input.maxOutputBytes, 64 * 1024, 1024, 1024 * 1024);
    return { status: "completed", output: await runShellCommand(command, cwd, timeoutMs, maxOutputBytes) };
  }
};

export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number
): Promise<CommandToolOutput> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => pushBounded(stdout, chunk, maxOutputBytes));
    child.stderr.on("data", (chunk: Buffer) => pushBounded(stderr, chunk, maxOutputBytes));
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      resolve({
        command,
        cwd,
        exitCode,
        stdout: stdoutText,
        stderr: stderrText,
        timedOut,
        durationMs: Date.now() - startedAt,
        truncated:
          Buffer.byteLength(stdoutText, "utf8") >= maxOutputBytes ||
          Buffer.byteLength(stderrText, "utf8") >= maxOutputBytes
      });
    });
  });
}

function pushBounded(chunks: Buffer[], chunk: Buffer, maxBytes: number): void {
  const currentBytes = chunks.reduce((sum, item) => sum + item.length, 0);
  if (currentBytes >= maxBytes) return;
  chunks.push(chunk.subarray(0, maxBytes - currentBytes));
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numericValue)));
}
