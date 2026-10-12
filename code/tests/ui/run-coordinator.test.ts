import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentKernel } from "../../src/kernel/agent-kernel.js";
import { RunCoordinator } from "../../src/ui/run-coordinator.js";
import { WorkspaceFileService } from "../../src/ui/workspace-files.js";
import { TurnManager } from "../../src/kernel/turn-manager.js";
import { nowShanghaiTime } from "../../src/utils/clock.js";

let workspace = "";

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = "";
});

describe("RunCoordinator", () => {
  it("persists one accepted turn for an idempotency key and completes it asynchronously", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-run-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const coordinator = new RunCoordinator(kernel);
    const task = kernel.storage.db.prepare("select id from tasks where session_id = ?").get(kernel.session.id) as { id: string };

    const first = coordinator.submit({ taskId: task.id, input: "检查项目", clientRequestId: "request-1" });
    const duplicate = coordinator.submit({ taskId: task.id, input: "检查项目", clientRequestId: "request-1" });
    expect(duplicate).toEqual(first);
    expect(first.status).toBe("accepted");
    expect(kernel.storage.db.prepare("select count(*) as count from turns").get()).toEqual({ count: 1 });
    expect(coordinator.events.replay(0).map((event) => event.kind)).toEqual(["run.accepted"]);

    await coordinator.waitForIdle();
    expect(coordinator.getRun(first.runId).status).toBe("completed");
    expect(coordinator.events.replay(0).filter((event) => event.kind.startsWith("run.")).map((event) => event.kind)).toEqual([
      "run.accepted", "run.running", "run.completed"
    ]);
    const progress = coordinator.events.replay(0).filter((event) => event.kind === "trace.recorded");
    expect(progress.some((event) => event.payload.type === "llm.called")).toBe(true);
    expect(progress.some((event) => event.payload.type === "turn.completed")).toBe(true);
    expect(progress.every((event) => !JSON.stringify(event.payload).includes("检查项目"))).toBe(true);
    expect(kernel.storage.db.prepare("select status from turns where id = ?").get(first.turnId)).toEqual({ status: "completed" });
  });

  it("rejects another active run and does not create a second turn", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-run-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const coordinator = new RunCoordinator(kernel);
    const task = kernel.storage.db.prepare("select id from tasks where session_id = ?").get(kernel.session.id) as { id: string };
    coordinator.submit({ taskId: task.id, input: "第一轮", clientRequestId: "request-a" });
    expect(() => coordinator.submit({ taskId: task.id, input: "第二轮", clientRequestId: "request-b" })).toThrow("活动 Run");
    expect(kernel.storage.db.prepare("select count(*) as count from turns").get()).toEqual({ count: 1 });
    await coordinator.waitForIdle();
  });

  it("includes an explicitly validated file range in ContextPack and the actual request", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-run-"));
    await writeFile(join(workspace, "note.md"), "甲\n乙\n丙\n");
    const files = new WorkspaceFileService(workspace);
    const preview = await files.preview("note.md");
    const reference = await files.validateReference({
      path: "note.md", startLine: 2, endLine: 2, version: preview.version!
    });
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const coordinator = new RunCoordinator(kernel);
    const task = kernel.storage.db.prepare("select id from tasks where session_id = ?").get(kernel.session.id) as { id: string };
    const run = coordinator.submit({ taskId: task.id, input: "解释引用", clientRequestId: "reference-1", fileReferences: [reference] });
    await coordinator.waitForIdle();
    const item = kernel.storage.db.prepare("select source_type, source_ref, content from context_items where source_type = 'file_reference' and context_pack_id in (select id from context_packs where turn_id = ?)")
      .get(run.turnId) as { source_type: string; source_ref: string; content: string };
    expect(item).toMatchObject({ source_type: "file_reference", source_ref: "note.md#L2-L2", content: "乙" });
    const capture = kernel.storage.db.prepare("select request_body_json from llm_http_captures where turn_id = ?").get(run.turnId) as { request_body_json: string };
    expect(capture.request_body_json).toContain("note.md#L2-L2");
    expect(capture.request_body_json).toContain("乙");
  });

  it("rejects reuse of the same idempotency key with changed file references", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-run-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const coordinator = new RunCoordinator(kernel);
    const task = kernel.storage.db.prepare("select id from tasks where session_id = ?").get(kernel.session.id) as { id: string };
    coordinator.submit({ taskId: task.id, input: "读取", clientRequestId: "same-key", fileReferences: [
      { path: "a.md", startLine: 1, endLine: 1, version: "v1", content: "甲" }
    ] });
    expect(() => coordinator.submit({ taskId: task.id, input: "读取", clientRequestId: "same-key", fileReferences: [
      { path: "b.md", startLine: 1, endLine: 1, version: "v2", content: "乙" }
    ] })).toThrow("幂等键");
    await coordinator.waitForIdle();
  });

  it("marks a dead process run interrupted without replaying tools", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-run-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const task = kernel.storage.db.prepare("select id from tasks where session_id = ?").get(kernel.session.id) as { id: string };
    const turn = new TurnManager(kernel.storage).create(kernel.session.id, task.id, "不要重放");
    const now = nowShanghaiTime();
    kernel.storage.db.prepare("insert into ui_runs (run_id, turn_id, session_id, task_id, client_request_id, owner_pid, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("run_dead", turn.id, kernel.session.id, task.id, "dead-request", 99999999, "running", now, now);
    const coordinator = new RunCoordinator(kernel);
    expect(coordinator.getRun("run_dead").status).toBe("interrupted");
    expect(kernel.storage.db.prepare("select status from turns where id = ?").get(turn.id)).toEqual({ status: "failed" });
    expect(kernel.storage.db.prepare("select count(*) as count from llm_http_captures where turn_id = ?").get(turn.id)).toEqual({ count: 0 });
    expect(coordinator.events.replay(0).at(-1)?.kind).toBe("run.interrupted");
  });
});
