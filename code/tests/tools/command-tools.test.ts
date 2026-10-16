import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlledToolPolicy } from "../../src/policy/controlled-tool-policy.js";
import { createCommandTools, runShellCommand } from "../../src/tools/command-tools.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("command tools", () => {
  it("does not report a cancelled command as a completed tool", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-cancel-command-"));
    const controller = new AbortController();
    const tool = createCommandTools()[0];
    const pending = tool.execute({ command: "node -e \"setTimeout(() => {}, 5000)\"" }, {
      ...toolContext(), signal: controller.signal
    });
    const timer = setTimeout(() => controller.abort(new Error("测试主动停止")), 50);
    try { await expect(pending).rejects.toThrow("测试主动停止"); }
    finally { clearTimeout(timer); }
  });
  it.each([1, 2, 3])("terminates a started shell descendant when stopped (attempt %s)", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-stop-command-"));
    const controller = new AbortController();
    const pending = runShellCommand('node -e "require(\'fs\').writeFileSync(\'started\', String(process.pid)); setTimeout(() => console.log(\'late\'), 5000)"', workspace, 10_000, 1024, controller.signal);
    try {
      let childPid = 0;
      await vi.waitFor(async () => {
        const pid = await readFile(join(workspace, "started"), "utf8");
        expect(pid).toMatch(/^\d+$/);
        childPid = Number(pid);
      }, { timeout: 2000 });
      const stoppedAt = Date.now();
      controller.abort();
      const result = await pending;
      expect(Date.now() - stoppedAt).toBeLessThan(2000);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("late");
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      controller.abort();
      await pending;
    }
  });

  it("terminates an active shell command when the run is stopped", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-stop-command-"));
    const controller = new AbortController();
    const pending = runShellCommand("node -e \"setTimeout(() => console.log('late'), 5000)\"", workspace, 10_000, 1024, controller.signal);
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      const result = await pending;
      expect(result.exitCode).not.toBe(0);
      expect(result.durationMs).toBeLessThan(2000);
    } finally { clearTimeout(timer); }
  });

  it("terminates shell descendants when the command times out", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-command-timeout-"));
    const result = await runShellCommand('node -e "console.log(\'started\'); setTimeout(() => console.log(\'late\'), 5000)"', workspace, 1000, 1024);
    expect(result).toMatchObject({ timedOut: true, stdout: "started\n" });
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeLessThan(3000);
  });
  it("runs shell commands with bounded output", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const registry = new ToolRegistry(new ControlledToolPolicy(workspace));
    for (const tool of createCommandTools()) registry.register(tool);

    const result = await registry.execute(
      "run_command",
      { command: "node -e \"console.log('ok')\"", maxOutputBytes: 1000 },
      toolContext()
    );

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toMatchObject({ exitCode: 0, timedOut: false });
      expect(result.output.stdout).toContain("ok");
    }
  });

  it("blocks dangerous shell commands", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const registry = new ToolRegistry(new ControlledToolPolicy(workspace));
    for (const tool of createCommandTools()) registry.register(tool);

    await expect(
      registry.execute("run_command", { command: "sudo rm -rf /" }, toolContext())
    ).resolves.toMatchObject({ status: "failed", errorCode: "action_not_supported" });
  });
});

function toolContext() {
  return {
    sessionId: "ses_1",
    taskId: "task_1",
    turnId: "turn_1",
    workspaceRoot: workspace
  };
}
