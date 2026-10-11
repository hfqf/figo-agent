import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PolicyAction } from "../../src/contracts/types.js";
import { ControlledToolPolicy } from "../../src/policy/controlled-tool-policy.js";

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("ControlledToolPolicy", () => {
  it("allows V1.2 controlled tool actions", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const policy = new ControlledToolPolicy(workspace);
    const actions: PolicyAction[] = [
      "tool.list_files",
      "tool.read_file",
      "tool.search_text",
      "tool.system_info",
      "tool.path_stat",
      "tool.read_many_files",
      "tool.workspace_summary",
      "tool.write_file",
      "tool.apply_patch",
      "tool.run_command",
      "tool.git_status",
      "tool.git_diff",
      "tool.git_log",
      "tool.git_add",
      "tool.git_commit",
      "tool.network_fetch",
      "tool.browser_open",
      "tool.browser_snapshot"
    ];

    for (const action of actions) {
      await expect(
        policy.evaluate({
          sessionId: "ses_1",
          taskId: "task_1",
          turnId: "turn_1",
          action,
          resource: action === "tool.network_fetch" ? "https://example.com" : ".",
          metadata: {}
        })
      ).resolves.toMatchObject({ allowed: true, code: "allowed" });
    }
  });

  it("denies outside-workspace file operations and dangerous commands", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const policy = new ControlledToolPolicy(workspace);

    await expect(
      policy.evaluate({
        sessionId: "ses_1",
        taskId: "task_1",
        turnId: "turn_1",
        action: "tool.write_file",
        resource: "../secret.txt",
        metadata: {}
      })
    ).resolves.toMatchObject({ allowed: false, code: "path_outside_workspace" });

    await expect(
      policy.evaluate({
        sessionId: "ses_1",
        taskId: "task_1",
        turnId: "turn_1",
        action: "tool.run_command",
        resource: "rm -rf /",
        metadata: { command: "rm -rf /" }
      })
    ).resolves.toMatchObject({ allowed: false, code: "action_not_supported" });

    await expect(
      policy.evaluate({
        sessionId: "ses_1",
        taskId: "task_1",
        turnId: "turn_1",
        action: "tool.run_command",
        resource: "pwd",
        metadata: { command: "pwd", cwd: "../outside" }
      })
    ).resolves.toMatchObject({ allowed: false, code: "path_outside_workspace" });
  });

  it("allows only http and https URLs for network and browser actions", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const policy = new ControlledToolPolicy(workspace);

    await expect(
      policy.evaluate({
        sessionId: "ses_1",
        taskId: "task_1",
        turnId: "turn_1",
        action: "tool.network_fetch",
        resource: "file:///etc/passwd",
        metadata: {}
      })
    ).resolves.toMatchObject({ allowed: false, code: "action_not_supported" });

    await expect(
      policy.evaluate({
        sessionId: "ses_1",
        taskId: "task_1",
        turnId: "turn_1",
        action: "tool.browser_open",
        resource: "https://example.com",
        metadata: {}
      })
    ).resolves.toMatchObject({ allowed: true, code: "allowed" });
  });
});
