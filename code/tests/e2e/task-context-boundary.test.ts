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

describe("Task context boundary e2e", () => {
  it("binds consecutive turns to the current task and writes task summary on finish", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "AGENTS.MD"), "中文文档原则", "utf8");
    await writeFile(join(workspace, "readme.md"), "# 项目\nTask 上下文边界", "utf8");

    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const current = await kernel.handleCommand("/task current");
    expect(current.message).toContain("default");

    const first = await kernel.submitTurn("第一轮：理解当前项目");
    const second = await kernel.submitTurn("第二轮：继续补充");
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");

    const rows = kernel.storage.db
      .prepare("select id, task_id from turns order by created_at")
      .all() as Array<{ id: string; task_id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].task_id).toBeTruthy();
    expect(rows[1].task_id).toBe(rows[0].task_id);

    const contextRows = kernel.storage.db
      .prepare("select task_id from context_packs order by created_at")
      .all() as Array<{ task_id: string }>;
    expect(contextRows.map((row) => row.task_id)).toEqual([rows[0].task_id, rows[0].task_id]);

    const contextItems = kernel.storage.db
      .prepare("select source_ref, content from context_items order by rowid")
      .all() as Array<{ source_ref: string; content: string }>;
    expect(contextItems.some((item) => item.source_ref === `task.turn:${rows[0].id}` && item.content.includes("第一轮"))).toBe(true);

    const finish = await kernel.handleCommand("/task finish");
    expect(finish.message).toContain("task-summary.md");
    expect(kernel.storage.db.prepare("select status from tasks where id = ?").get(rows[0].task_id)).toMatchObject({
      status: "completed"
    });

    const summary = await readFile(
      join(
        workspace,
        ".figo-agent/artifacts/sessions",
        kernel.session.id,
        "tasks",
        rows[0].task_id,
        "task-summary.md"
      ),
      "utf8"
    );
    expect(summary).toContain("第一轮：理解当前项目");
    expect(summary).toContain("第二轮：继续补充");

    const traceRows = kernel.storage.db
      .prepare("select task_id, type from trace_events where task_id = ? order by created_at")
      .all(rows[0].task_id) as Array<{ task_id: string; type: string }>;
    expect(traceRows.map((row) => row.type)).toEqual(
      expect.arrayContaining(["task.created", "turn.received", "task.summary.created", "task.completed"])
    );
  });
});
