import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Tool } from "../contracts/types.js";
import { isDangerousCommand } from "../policy/controlled-tool-policy.js";
import { assertInsideWorkspace } from "../utils/path.js";
import { defaultToolDefaults, type RuntimeToolDefaults } from "../config/runtime-behavior.js";

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

export function createCommandTools(defaults: RuntimeToolDefaults = defaultToolDefaults): Array<Tool<Record<string, unknown>, unknown>> {
  return [{ ...runCommandTool, execute: (input, context) => runCommandTool.execute({
    timeoutMs: defaults.commandTimeoutMs, maxOutputBytes: defaults.commandMaxOutputBytes, ...input
  }, context) }];
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
    const output = await runShellCommand(command, cwd, timeoutMs, maxOutputBytes, context.signal);
    context.signal?.throwIfAborted();
    return { status: "completed", output };
  }
};

export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal
): Promise<CommandToolOutput> {
  signal?.throwIfAborted();
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, detached: process.platform !== "win32" });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;

    const stopChild = () => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGTERM"); return; }
        catch { /* The child already exited. */ }
      }
      child.kill("SIGTERM");
    };
    const onAbort = () => stopChild();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) stopChild();

    const timer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => pushBounded(stdout, chunk, maxOutputBytes));
    child.stderr.on("data", (chunk: Buffer) => pushBounded(stderr, chunk, maxOutputBytes));
    child.on("error", () => {});
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
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
