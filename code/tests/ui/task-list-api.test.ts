import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AgentKernel } from "../../src/kernel/agent-kernel.js";
import { startLocalApi } from "../../src/ui/local-api.js";

it("工作台任务目录跨Session分页，保留首条消息标题、权限和数据原文", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "figo-task-list-api-"));
  const kernel = await AgentKernel.start({ workspaceRoot: workspace });
  const db = kernel.storage.db;
  db.prepare("insert into sessions(id,cwd,status,started_at) values(?,?,?,?)").run("ses_history", workspace, "completed", "2026-10-01 10:00:00.000");
  db.prepare("insert into tasks(id,session_id,title,status,created_at,updated_at) values(?,?,?,?,?,?)")
    .run("task_history", "ses_history", "旧的人工标题", "active", "2026-10-01 10:00:00.000", "2026-10-01 10:00:00.000");
  db.prepare("insert into turns(id,session_id,task_id,input,output,status,created_at,task_seq) values(?,?,?,?,?,?,?,?)")
    .run("turn_history", "ses_history", "task_history", "读取当前项目", "历史答复", "completed", "2026-10-01 10:01:00.000", 1);
  const api = await startLocalApi({ kernel, port: 0, requireAccessCode: false });
  try {
    const response = await fetch(`${api.url}/api/v1/tasks?page=1&limit=2`);
    expect(response.status).toBe(200);
    const list = await response.json();
    expect(list).toMatchObject({ totalCount: 1, page: 1, totalPages: 1, pageSize: 2,
      tasks: [{ id: "task_history", sessionId: "ses_history", displayTitle: "读取当前项目", sessionTitle: "读取当前项目" }] });
    const sessions = await (await fetch(`${api.url}/api/v1/sessions`)).json();
    expect(sessions.sessions.find((session: { id: string }) => session.id === "ses_history")).toMatchObject({ title: "读取当前项目" });
    const boot = await (await fetch(`${api.url}/api/v1/bootstrap`)).json();
    expect(boot.taskList).toMatchObject({ recentLimit: 8, pageSize: 30 });
    const sent = await fetch(`${api.url}/api/v1/tasks/task_history/turns`, { method: "POST", headers: {
      origin: api.url, "x-figo-csrf": boot.csrf, "content-type": "application/json"
    }, body: JSON.stringify({ input: "不能写入历史", clientRequestId: "history-write" }) });
    expect(sent.status).toBe(400);
    expect(await sent.json()).toEqual({ error: "Task 不属于当前 Session 或状态不是 active。" });
    for (const query of ["page=-1", "limit=0", "page=1.5", "q=" + "x".repeat(201)]) {
      expect((await fetch(`${api.url}/api/v1/tasks?${query}`)).status).toBe(400);
    }
    expect(db.prepare("select title,session_id from tasks where id='task_history'").get()).toMatchObject({ title: "旧的人工标题", session_id: "ses_history" });
    expect(db.prepare("select count(*) as n from turns where task_id='task_history'").get()).toMatchObject({ n: 1 });
  } finally {
    await api.close(); await kernel.shutdown(); db.close(); await rm(workspace, { recursive: true, force: true });
  }
});
