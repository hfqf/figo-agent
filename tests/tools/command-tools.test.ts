import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlledToolPolicy } from "../../src/policy/controlled-tool-policy.js";
import { createCommandTools } from "../../src/tools/command-tools.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("command tools", () => {
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
