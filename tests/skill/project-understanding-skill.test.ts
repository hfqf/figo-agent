import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReadOnlyPolicy } from "../../src/policy/read-only-policy.js";
import { ProjectUnderstandingSkill } from "../../src/skill/project-understanding-skill.js";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { createReadOnlyTools } from "../../src/tools/read-only-tools.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("ProjectUnderstandingSkill", () => {
  it("matches project-understanding input and runs through ToolRegistry", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "readme.md"), "# 项目\n", "utf8");
    const storage = await StorageManager.init(workspace);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace));
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const skill = new ProjectUnderstandingSkill(storage, registry);

    expect(skill.canHandle("理解当前项目")).toBe(true);
    const result = await skill.run({
      sessionId: "ses_1",
      turnId: "turn_1",
      workspaceRoot: workspace,
      input: "理解当前项目"
    });

    expect(result.status).toBe("completed");
    expect(result.message).toContain("项目理解完成");
    expect(storage.db.prepare("select status from skill_runs").get()).toMatchObject({
      status: "completed"
    });
  });

  it("skips non project-understanding input", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace));
    const skill = new ProjectUnderstandingSkill(storage, registry);

    expect(skill.canHandle("随便聊聊")).toBe(false);
    await expect(
      skill.run({
        sessionId: "ses_1",
        turnId: "turn_1",
        workspaceRoot: workspace,
        input: "随便聊聊"
      })
    ).resolves.toMatchObject({ status: "skipped" });
  });
});
