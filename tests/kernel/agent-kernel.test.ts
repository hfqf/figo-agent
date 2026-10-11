import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentKernel } from "../../src/kernel/agent-kernel.js";

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("AgentKernel", () => {
  it("runs /compact without creating a user turn and keeps history if the model cannot summarize", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    await kernel.submitTurn("第一轮");
    await kernel.submitTurn("第二轮");
    const before = kernel.storage.db.prepare("select count(*) as count from turns").get() as { count: number };
    const result = await kernel.handleCommand("/compact");
    expect(result.status).toBe("failed");
    expect(result.message).toContain("compaction summary is not JSON");
    expect(kernel.storage.db.prepare("select count(*) as count from turns").get()).toMatchObject(before);
    expect(kernel.storage.db.prepare("select count(*) as count from task_compaction_checkpoints").get()).toMatchObject({ count: 0 });
    expect(kernel.storage.db.prepare("select count(*) as count from trace_events where type = 'compaction.failed'").get()).toMatchObject({ count: 1 });
  });
  it("starts a session, submits a turn through AgentLoop, and shuts down", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "AGENTS.MD"), "中文文档原则", "utf8");
    await writeFile(join(workspace, "readme.md"), "# 项目\n项目理解", "utf8");

    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    expect(kernel.session.id).toMatch(/^ses_/);
    expect(
      kernel.storage.db.prepare("select id from sessions where id = ?").get(kernel.session.id)
    ).toBeTruthy();

    const result = await kernel.submitTurn("理解当前项目");
    expect(result.status).toBe("completed");
    expect(
      kernel.storage.db.prepare("select status from turns where id = ?").get(result.turnId)
    ).toMatchObject({ status: "completed" });

    await kernel.shutdown();
    expect(
      kernel.storage.db.prepare("select status from sessions where id = ?").get(kernel.session.id)
    ).toMatchObject({ status: "ended" });

    const jsonl = await readFile(
      join(workspace, ".figo-agent/artifacts/sessions", kernel.session.id, "trace.jsonl"),
      "utf8"
    );
    expect(jsonl).toContain("session.started");
    expect(jsonl).toContain("plugin.registered");
    expect(jsonl).toContain("plugin.ready");
    expect(jsonl).toContain("capability.registered");
    expect(jsonl).toContain("turn.received");
    expect(jsonl).toContain("turn.completed");
  });

  it("rejects ordinary input for a paused task and records task.command.rejected", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "AGENTS.MD"), "中文文档原则", "utf8");
    await writeFile(join(workspace, "readme.md"), "# 项目\n项目理解", "utf8");

    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    await kernel.handleCommand("/task pause");
    const task = kernel.storage.db.prepare("select id from tasks where status = ?").get("paused") as {
      id: string;
    };

    await expect(kernel.submitTurn("暂停后不应接收")).rejects.toThrow(
      "当前 Task 状态为 paused，不能接收普通输入。"
    );
    expect(kernel.storage.db.prepare("select count(*) as count from turns").get()).toMatchObject({
      count: 0
    });
    expect(
      kernel.storage.db
        .prepare("select type, task_id from trace_events where type = ?")
        .get("task.command.rejected")
    ).toMatchObject({ type: "task.command.rejected", task_id: task.id });
  });

  it("creates a new task for ordinary input after finishing the current task", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "AGENTS.MD"), "中文文档原则", "utf8");
    await writeFile(join(workspace, "readme.md"), "# 项目\n项目理解", "utf8");

    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const firstTask = kernel.storage.db.prepare("select id from tasks").get() as { id: string };
    await kernel.handleCommand("/task finish");

    const result = await kernel.submitTurn("理解当前项目");
    expect(result.status).toBe("completed");
    const turn = kernel.storage.db.prepare("select task_id from turns where id = ?").get(result.turnId) as {
      task_id: string;
    };
    expect(turn.task_id).not.toBe(firstTask.id);
    expect(kernel.storage.db.prepare("select status from tasks where id = ?").get(firstTask.id)).toMatchObject({
      status: "completed"
    });
  });
});
