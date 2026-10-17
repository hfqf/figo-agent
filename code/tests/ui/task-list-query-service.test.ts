import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { defaultTaskListSettings } from "../../src/config/task-list-settings.js";
import { zhCN } from "../../src/i18n/catalog.js";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TaskListQueryService } from "../../src/ui/task-list-query-service.js";
import { WorkspaceQueryService } from "../../src/ui/workspace-query-service.js";

const time = "2026-10-17 10:00:00.000";
let root: string;
let storage: StorageManager;

function session(id: string) {
  storage.db.prepare("insert into sessions(id,cwd,status,started_at) values(?,?,?,?)").run(id, root, "active", time);
}
function task(id: string, sessionId = "ses_a", title = id, updatedAt = time) {
  storage.db.prepare("insert into tasks(id,session_id,title,status,created_at,updated_at) values(?,?,?,?,?,?)")
    .run(id, sessionId, title, "active", time, updatedAt);
}
function turn(id: string, taskId: string | null, input: string, sessionId = "ses_a", createdAt = time, completedAt: string | null = null) {
  storage.db.prepare("insert into turns(id,session_id,task_id,input,status,created_at,completed_at) values(?,?,?,?,?,?,?)")
    .run(id, sessionId, taskId, input, "completed", createdAt, completedAt);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "figo-task-list-"));
  storage = await StorageManager.init(root);
  session("ses_a");
});
afterEach(async () => {
  storage?.db.close();
  if (root) await rm(root, { recursive: true, force: true });
});

it("跨Session汇总Task，保留持久标题，以各自首条消息派生展示名", () => {
  session("ses_b");
  task("a", "ses_a", "原有标题"); task("b", "ses_b"); task("a2");
  turn("last", "a", "末条不能命名", "ses_a", "2026-10-17 11:00:00.000");
  turn("first", "a", "  首条\n 用户\t消息  ");
  turn("other", "a2", "另一个任务", "ses_a", "2026-10-17 12:00:00.000");
  turn("b1", "b", "B的首条", "ses_b");
  const result = new TaskListQueryService(storage).list();
  expect(result).toMatchObject({ totalCount: 3, page: 1, totalPages: 1, pageSize: 30 });
  expect(result.tasks.find(item => item.id === "a")).toEqual({ id: "a", sessionId: "ses_a", title: "原有标题", displayTitle: "首条 用户 消息", sessionTitle: "首条 用户 消息", status: "active", turnCount: 2, updatedAt: "2026-10-17 11:00:00.000" });
  expect(result.tasks.find(item => item.id === "a2")?.sessionTitle).toBe("首条 用户 消息");
  expect(result.tasks.find(item => item.id === "b")?.sessionTitle).toBe("B的首条");
  expect(JSON.stringify(result)).not.toContain("firstInput");
});

it("同时间首条消息按rowid稳定选择，不按ID或task_seq选取", () => {
  task("a");
  turn("z-first", "a", "先插入"); turn("a-second", "a", "后插入");
  storage.db.prepare("update turns set task_seq = ? where id = ?").run(99, "z-first");
  storage.db.prepare("update turns set task_seq = ? where id = ?").run(1, "a-second");
  expect(new TaskListQueryService(storage).list().tasks[0]).toMatchObject({ displayTitle: "先插入", sessionTitle: "先插入" });
});

it("保留命名空Task，隐藏default空Task，有消息的default仍显示", () => {
  task("empty", "ses_a", "自定义空任务"); task("automatic", "ses_a", "default");
  task("used", "ses_a", "default"); turn("used1", "used", "已使用");
  session("ses_empty"); task("named", "ses_empty", "空任务");
  const page = new TaskListQueryService(storage).list();
  expect(page.totalCount).toBe(3);
  expect(page.tasks.find(item => item.id === "empty")).toMatchObject({ title: "自定义空任务", displayTitle: "自定义空任务", turnCount: 0 });
  expect(page.tasks.find(item => item.id === "named")).toMatchObject({ displayTitle: "空任务", sessionTitle: "未命名会话" });
  expect(page.tasks.find(item => item.id === "used")?.displayTitle).toBe("已使用");
});

it("旧task_id为空的Turn按Session合成独立legacy任务", () => {
  session("ses_b");
  turn("a-old-1", null, "  旧\n消息  ");
  turn("a-old-2", null, "旧消息2", "ses_a", "2026-10-17 11:00:00.000", "2026-10-17 12:00:00.000");
  turn("b-old-1", null, "B旧消息", "ses_b");
  const page = new TaskListQueryService(storage).list();
  expect(page.tasks).toMatchObject([
    { id: "legacy_ses_a", sessionId: "ses_a", title: "历史对话（未归属 Task）", displayTitle: "旧 消息", sessionTitle: "旧 消息", status: "archived", turnCount: 2, updatedAt: "2026-10-17 12:00:00.000" },
    { id: "legacy_ses_b", sessionId: "ses_b", displayTitle: "B旧消息", turnCount: 1 }
  ]);
});

it("新旧legacy查询使用locale标题，不在查询中硬编码中文", () => {
  turn("legacy", null, "历史首条");
  const original = zhCN.workbench.legacyTaskTitle;
  zhCN.workbench.legacyTaskTitle = "测试用历史任务名";
  try {
    expect(new TaskListQueryService(storage).list({ q: "测试用历史" }).tasks[0]).toMatchObject({
      id: "legacy_ses_a", title: "测试用历史任务名", displayTitle: "历史首条"
    });
    expect(new WorkspaceQueryService(storage).tasks("ses_a")[0]).toMatchObject({
      id: "legacy_ses_a", title: "测试用历史任务名", displayTitle: "历史首条"
    });
  } finally { zhCN.workbench.legacyTaskTitle = original; }
});

it("最近活动取Task更新、Turn创建和完成的最大值，同时间排序稳定", () => {
  task("c"); task("b"); task("a");
  task("task-new", "ses_a", "命名更新", "2026-10-17 13:00:00.000");
  task("turn-new"); turn("new", "turn-new", "运行中", "ses_a", "2026-10-17 12:00:00.000");
  task("finished"); turn("finished1", "finished", "结束", "ses_a", time, "2026-10-17 14:00:00.000");
  task("clock"); turn("clock1", "clock", "完成时间早于创建", "ses_a", "2026-10-17 11:00:00.000", time);
  const query = new TaskListQueryService(storage);
  const ids = ["finished", "task-new", "turn-new", "clock", "a", "b", "c"];
  expect(query.list().tasks.map(item => item.id)).toEqual(ids);
  expect(query.list().tasks.map(item => item.id)).toEqual(ids);
});

it("先过滤再计数分页，夹回越界页且支持安全整数最大页码", () => {
  for (let index = 0; index < 5; index++) task(`task-${index}`);
  const query = new TaskListQueryService(storage);
  expect(query.list({ limit: 2 })).toMatchObject({ totalCount: 5, page: 1, totalPages: 3, pageSize: 2 });
  expect(query.list({ page: 2, limit: 2 }).tasks.map(item => item.id)).toEqual(["task-2", "task-3"]);
  expect(query.list({ page: Number.MAX_SAFE_INTEGER, limit: 2 })).toMatchObject({ tasks: [{ id: "task-4" }], totalCount: 5, page: 3, totalPages: 3 });
  expect(query.list({ page: 2, limit: 2, q: "task-3" })).toMatchObject({ tasks: [{ id: "task-3" }], totalCount: 1, page: 1, totalPages: 1 });
});

it("搜索命名、Task首条输入和Session首条输入，%/_为字面字符，SQL片段不执行", () => {
  task("percent", "ses_a", "构建100%"); task("underscore", "ses_a", "A_B"); task("plain", "ses_a", "AxxB");
  session("ses_input"); task("input", "ses_input"); turn("first", "input", "  Alpha\n标题  ", "ses_input");
  session("ses_b"); task("session-first", "ses_b"); turn("s-first", "session-first", "会话搜索", "ses_b"); task("session-child", "ses_b");
  const query = new TaskListQueryService(storage);
  expect(query.list({ q: "%" }).tasks.map(item => item.id)).toEqual(["percent"]);
  expect(query.list({ q: "_" }).tasks.map(item => item.id)).toEqual(["underscore"]);
  expect(query.list({ q: "构建" }).totalCount).toBe(1);
  expect(query.list({ q: " alpha " }).tasks.map(item => item.id)).toEqual(["input"]);
  expect(query.list({ q: "会话搜索", limit: 1 })).toMatchObject({ totalCount: 2, totalPages: 2 });
  expect(query.list({ q: "' OR 1=1 --" }).totalCount).toBe(0);
  expect(query.list({ q: "   " }).totalCount).toBe(6);
});

it("空数据库及空搜索结果返回page=0，不返回原始首条消息", () => {
  const query = new TaskListQueryService(storage);
  expect(query.list()).toEqual({ tasks: [], totalCount: 0, page: 0, totalPages: 0, pageSize: 30 });
  task("a");
  expect(query.list({ page: 99, limit: 2, q: "不存在" })).toEqual({ tasks: [], totalCount: 0, page: 0, totalPages: 0, pageSize: 2 });
});

it("标题先完整脱敏再折叠空白与截断，保留原始任务名但不泄漏凭据", () => {
  const secret = "fixture-private-long-value";
  task("a", "ses_a", `原始 ${secret}`);
  turn("first", "a", `${secret}  首条\n消息`);
  const query = new TaskListQueryService(storage, [secret], { ...defaultTaskListSettings, titleMaxChars: 12 });
  const result = query.list();
  expect(result.tasks[0]).toMatchObject({ title: "原始 [REDACTED]", displayTitle: "[REDACTED] 首", sessionTitle: "[REDACTED] 首" });
  expect(JSON.stringify(result)).not.toContain(secret.slice(0, 10));
  expect(Object.keys(result.tasks[0]).sort()).toEqual(["id", "sessionId", "title", "displayTitle", "sessionTitle", "status", "turnCount", "updatedAt"].sort());
});

it("通用凭据模式同样在截断之前脱敏，空白首条回退任务名", () => {
  task("a"); turn("a1", "a", "sk-fixture1234567890abcdef 后文");
  task("b", "ses_a", "命名"); turn("b1", "b", "  \n\t");
  const query = new TaskListQueryService(storage, [], { ...defaultTaskListSettings, titleMaxChars: 10 });
  expect(query.list().tasks.find(item => item.id === "a")?.displayTitle).toBe("[REDACTED]");
  expect(query.list().tasks.find(item => item.id === "b")?.displayTitle).toBe("命名");
});

it.each([
  { page: 0 }, { page: -1 }, { page: 1.2 }, { page: "1" }, { page: null }, { page: NaN }, { page: Infinity },
  { page: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: -1 }, { limit: 101 }, { limit: 1.2 },
  { limit: "2" }, { limit: null }, { limit: NaN }, { q: 1 }, { q: null }, { q: "x".repeat(201) }
])("拒绝无效查询参数 %j", options => {
  expect(() => new TaskListQueryService(storage).list(options as never)).toThrow(/无效/);
});

it("读取自定义分页与搜索上限", () => {
  for (let index = 0; index < 4; index++) task(`task-${index}`);
  const query = new TaskListQueryService(storage, [], { ...defaultTaskListSettings, recentLimit: 2, pageSize: 2, maxPageSize: 3, searchMaxChars: 4 });
  expect(query.list()).toMatchObject({ pageSize: 2, totalPages: 2 });
  expect(query.list({ limit: 3 }).tasks).toHaveLength(3);
  expect(() => query.list({ limit: 4 })).toThrow(/无效/);
  expect(() => query.list({ q: "12345" })).toThrow(/无效/);
});

it("在SQLite query_only下完成列表和原查询，历史标题及total_changes不变", () => {
  task("a", "ses_a", "存储标题"); turn("a1", "a", "  展示\n标题  ");
  turn("old", null, "旧首条", "ses_a", "2026-10-17 09:00:00.000");
  const before = storage.db.prepare("select total_changes() as n").get();
  const taskBefore = storage.db.prepare("select * from tasks").all();
  storage.db.exec("PRAGMA query_only = ON");
  expect(new TaskListQueryService(storage).list({ q: "标题", limit: 1 }).totalCount).toBe(1);
  const workspace = new WorkspaceQueryService(storage);
  expect(workspace.sessions()[0]).toMatchObject({ id: "ses_a", cwd: root, title: "旧首条", turnCount: 2 });
  expect(workspace.tasks("ses_a")).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "a", title: "存储标题", displayTitle: "展示 标题", createdAt: time }),
    expect.objectContaining({ id: "legacy_ses_a", displayTitle: "旧首条" })
  ]));
  expect(storage.db.prepare("select total_changes() as n").get()).toEqual(before);
  expect(storage.db.prepare("select * from tasks").all()).toEqual(taskBefore);
});

it("原Session和Task接口共用先脱敏再归一化的命名规则及空Session回退", () => {
  const secret = "fixture-session-private-value";
  task("a"); turn("a1", "a", ` ${secret}\n 标题 ${"长".repeat(150)}`);
  session("ses_empty");
  const workspace = new WorkspaceQueryService(storage, [secret]);
  const title = `[REDACTED] 标题 ${"长".repeat(150)}`.slice(0, 120);
  expect(workspace.sessions().find(row => row.id === "ses_a")?.title).toBe(title);
  expect(workspace.sessions().find(row => row.id === "ses_empty")?.title).toBe("未命名会话");
  expect(workspace.tasks("ses_a")[0]).toMatchObject({ title: "a", displayTitle: title });
});

it("原Workspace查询通过第三参复用目录的自定义展示标题长度", () => {
  const secret = "fixture-shared-private-value";
  task("a"); turn("a1", "a", `${secret} 首条很长标题`);
  turn("old", null, "旧首条很长标题".repeat(10), "ses_a", "2026-10-17 11:00:00.000");
  const settings = { ...defaultTaskListSettings, titleMaxChars: 12 };
  const workspace = new WorkspaceQueryService(storage, [secret], settings);
  const directory = new TaskListQueryService(storage, [secret], settings).list();
  expect(workspace.sessions()[0].title).toBe("[REDACTED] 首");
  for (const row of workspace.tasks("ses_a")) {
    const item = directory.tasks.find(item => item.id === row.id)!;
    expect(row.displayTitle).toBe(item.displayTitle);
    expect(item.sessionTitle).toBe(workspace.sessions()[0].title);
  }
  expect(workspace.tasks("ses_a").find(row => row.id === "a")?.displayTitle).toBe("[REDACTED] 首");
});
