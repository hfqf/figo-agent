import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReadOnlyPolicy } from "../../src/policy/read-only-policy.js";

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("ReadOnlyPolicy", () => {
  it("allows V1 read-only actions inside workspace", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const policy = new ReadOnlyPolicy(workspace);

    await expect(
      policy.evaluate({
        sessionId: "ses_1",
        turnId: "turn_1",
        action: "tool.list_files",
        resource: ".",
        metadata: {}
      })
    ).resolves.toMatchObject({ allowed: true, code: "allowed" });
    await expect(
      policy.evaluate({
        sessionId: "ses_1",
        turnId: "turn_1",
        action: "tool.read_file",
        resource: "readme.md",
        metadata: {}
      })
    ).resolves.toMatchObject({ allowed: true, code: "allowed" });
    await expect(
      policy.evaluate({
        sessionId: "ses_1",
        turnId: "turn_1",
        action: "tool.search_text",
        resource: ".",
        metadata: {}
      })
    ).resolves.toMatchObject({ allowed: true, code: "allowed" });
  });

  it("denies write, command, and outside-workspace requests", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const policy = new ReadOnlyPolicy(workspace);

    await expect(
      policy.evaluate({
        sessionId: "ses_1",
        turnId: "turn_1",
        action: "tool.write_file",
        resource: "readme.md",
        metadata: {}
      })
    ).resolves.toMatchObject({ allowed: false, code: "tool_not_allowed" });
    await expect(
      policy.evaluate({
        sessionId: "ses_1",
        turnId: "turn_1",
        action: "tool.run_command",
        resource: ".",
        metadata: {}
      })
    ).resolves.toMatchObject({ allowed: false, code: "tool_not_allowed" });
    await expect(
      policy.evaluate({
        sessionId: "ses_1",
        turnId: "turn_1",
        action: "tool.read_file",
        resource: "../secret.txt",
        metadata: {}
      })
    ).resolves.toMatchObject({ allowed: false, code: "path_outside_workspace" });
  });
});
