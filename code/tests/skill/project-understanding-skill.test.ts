import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReadOnlyPolicy } from "../../src/policy/read-only-policy.js";
import { ProjectUnderstandingSkill } from "../../src/skill/project-understanding-skill.js";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { createReadOnlyTools } from "../../src/tools/read-only-tools.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

import { TestDatabases } from "../helpers/test-databases.js";

const databases = new TestDatabases();
let workspace = "";

afterEach(async () => {
  databases.close();
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("ProjectUnderstandingSkill", () => {
  it("runs only when the user explicitly selects the skill", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "readme.md"), "# 项目\n", "utf8");
    const storage = databases.track(await StorageManager.init(workspace));
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace));
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const skill = new ProjectUnderstandingSkill(storage, registry);

    expect(skill.canHandle("理解当前项目")).toBe(false);
    expect(skill.canHandle("分析下当前项目")).toBe(false);
    expect(skill.canHandle("/skill project-understanding 分析当前项目")).toBe(true);
    const result = await skill.run({
      sessionId: "ses_1",
      turnId: "turn_1",
      workspaceRoot: workspace,
      input: "/skill project-understanding 分析当前项目"
    });

    expect(result.status).toBe("completed");
    expect(result.message).toContain("工作区预检发现");
    expect(storage.db.prepare("select status from skill_runs").get()).toMatchObject({
      status: "completed"
    });
  });

  it("does not claim success or read a nonexistent README in an empty workspace", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-empty-"));
    const storage = databases.track(await StorageManager.init(workspace));
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), undefined, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const skill = new ProjectUnderstandingSkill(storage, registry);

    const result = await skill.run({ sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "/skill project-understanding 分析当前项目" });

    expect(result.status).toBe("failed");
    expect(result.message).toContain("没有可分析的项目文件");
    expect(storage.db.prepare("select tool_name, status from tool_calls order by started_at").all()).toEqual([
      { tool_name: "list_files", status: "completed" }
    ]);
  });

  it("discovers an actual README name before reading it", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-readme-"));
    await writeFile(join(workspace, "README.md"), "# 真实项目\n", "utf8");
    const storage = databases.track(await StorageManager.init(workspace));
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), undefined, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const skill = new ProjectUnderstandingSkill(storage, registry);

    const result = await skill.run({ sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "/skill project-understanding 分析当前项目" });

    expect(result.status).toBe("completed");
    expect(result.message).toContain("真实项目");
    expect(storage.db.prepare("select input_json from tool_calls where tool_name = 'read_file'").get()).toMatchObject({ input_json: '{"path":"README.md"}' });
  });

  it("skips non project-understanding input", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = databases.track(await StorageManager.init(workspace));
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
