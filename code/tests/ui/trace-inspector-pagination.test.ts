import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, it } from "vitest";
import { schemaSql } from "../../src/storage/schema.js";
import type { StorageManager } from "../../src/storage/storage-manager.js";
import { TraceInspectorQueryService } from "../../src/ui/trace-inspector-query-service.js";
import { routeTraceInspectorRequest } from "../../src/ui/trace-inspector-api.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
let db: InstanceType<typeof DatabaseSync>;
let service: TraceInspectorQueryService;
const time = "2026-10-17 12:00:00.000";
function insert(table: string, row: Record<string, string | number | null>) {
  db.prepare(`insert into ${table} (${Object.keys(row).join(",")}) values (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
}
function trace(id: string, type = "turn.completed", taskId: string | null = "task", sessionId = "session", turnId = "turn") {
  insert("trace_events", { id, type, session_id: sessionId, task_id: taskId, turn_id: turnId, source: "Fixture", payload_json: "{}", created_at: time });
}
function route(query: string) {
  return routeTraceInspectorRequest("GET", new URL(`http://localhost/api/v1/tasks/task/trace-inspector/events?${query}`), service)!;
}
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(schemaSql);
  db.exec("alter table turns add column task_seq integer; alter table llm_http_captures add column purpose TEXT NOT NULL DEFAULT 'turn'");
  insert("sessions", { id: "session", cwd: "/fixture", status: "active", started_at: time });
  for (const id of ["task", "other-task"]) {
    insert("tasks", { id, session_id: "session", title: id, status: "active", created_at: time, updated_at: time });
    insert("turns", { id: id === "task" ? "turn" : "other-turn", session_id: "session", task_id: id, input: "fixture", status: "completed", created_at: time });
  }
  service = new TraceInspectorQueryService({ db } as StorageManager);
});
afterEach(() => db.close());

it("page 返回整页和同筛选总量，同毫秒稳定且越界夹紧到末页", () => {
  for (let i = 0; i < 5; i++) trace(`event-${i}`);
  const first = service.listEvents("task", { page: 1, limit: 2 });
  expect(first.events.map(event => event.key)).toEqual(["trace:event-0", "trace:event-1"]);
  expect(first.pagination).toEqual({ totalCount: 5, page: 1, totalPages: 3, pageSize: 2, from: 1, to: 2 });
  const second = service.listEvents("task", { page: 2, limit: 2 });
  expect(second.events.map(event => event.key)).toEqual(["trace:event-2", "trace:event-3"]);
  expect(second.hasMore).toBe(true);
  const last = service.listEvents("task", { page: 999, limit: 2 });
  expect(last.events.map(event => event.key)).toEqual(["trace:event-4"]);
  expect(last.pagination).toEqual({ totalCount: 5, page: 3, totalPages: 3, pageSize: 2, from: 5, to: 5 });
  expect(last.hasMore).toBe(false);
});

it("空page与Live使用明确的零范围", () => {
  expect(service.listEvents("task", { page: 1 }).pagination).toEqual({ totalCount: 0, page: 0, totalPages: 0, pageSize: 200, from: 0, to: 0 });
  expect(service.listEvents("task", { latest: true }).pagination).toEqual({ totalCount: 0, page: null, totalPages: null, pageSize: 200, from: 0, to: 0 });
});

it("page/group通过路由传入SQL，group先过滤再计数", () => {
  trace("tool", "tool.completed"); trace("llm", "llm.completed"); trace("protocol", "protocol.repair");
  const result = route("page=1&limit=1&category=capture,trace&group=llm");
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ events: [{ key: "trace:llm" }], pagination: { totalCount: 2, page: 1, totalPages: 2 } });
});

it.each([
  ["llm", ["llm.completed", "protocol.repair"], ["LLM.completed", "tool.completed", "llm", "my.llm.completed"]],
  ["tool", ["tool.completed", "policy.denied"], ["tool_call.parse.started", "Tool.completed", "my.tool.completed"]],
  ["context", ["context.build.completed", "memory.hit", "file.read", "task.history.loaded"], ["contextual.completed", "Task.history.loaded", "my.context.build"]],
  ["compaction", ["compaction.completed", "task.compaction.skipped", "not_compaction", "legacy-compaction"], ["Compaction.completed", "turn.completed"]]
] as const)("group %s 与前端原前缀规则完全一致且区分大小写", (group, included, excluded) => {
  for (const kind of [...included, ...excluded]) trace(kind, kind);
  const page = service.listEvents("task", { category: ["trace"], group, page: 1, limit: 2 });
  expect(page.pagination?.totalCount).toBe(included.length);
  expect(page.events.map(row => row.kind)).toEqual(included.slice(0, 2));
});

it("group保留非trace事实类别，并与category、failed、q同时作用于计数和行", () => {
  trace("own-failed", "llm.failed"); trace("other-failed", "llm.failed"); trace("own-good", "llm.completed");
  trace("own-tool", "tool.failed"); trace("foreign", "llm.failed", "other-task", "session", "other-turn");
  insert("llm_http_captures", { id: "own-cap", session_id: "session", task_id: "task", turn_id: "turn", request_id: "own-request", purpose: "turn",
    provider: "fixture", model: "fixture", url: "https://example.test", method: "POST", request_headers_json: "{}", request_body_json: "{}",
    response_status: 500, response_status_text: "ERROR", response_headers_json: "{}", response_body_json: "{}", duration_ms: 1, created_at: time });
  const page = service.listEvents("task", { category: ["trace", "capture", "tool"], group: "llm", failed: true, q: "own", page: 1 });
  expect(page.events.map(row => row.key)).toEqual(["trace:own-failed", "capture:own-cap"]);
  expect(page.pagination).toMatchObject({ totalCount: 2, from: 1, to: 2 });
  expect(service.listEvents("task", { category: "tool", group: "llm", page: 1 }).pagination?.totalCount).toBe(0);
});

it("Live最多500并按返回的最近窗口给出总量和范围，不冒充页码", () => {
  db.exec("begin");
  for (let i = 0; i < 505; i++) trace(`event-${i}`);
  db.exec("commit; PRAGMA query_only=ON");
  const page = service.listEvents("task", { latest: true, limit: 999 });
  expect(page.events).toHaveLength(500);
  expect(page.events[0].key).toBe("trace:event-5");
  expect(page.events.at(-1)?.key).toBe("trace:event-504");
  expect(page.pagination).toEqual({ totalCount: 505, page: null, totalPages: null, pageSize: 500, from: 6, to: 505 });
  expect(page.nextCursor).toBeNull();
});

it("无page仍走旧keyset，totalCount不被cursor缩小，group绑定游标", () => {
  for (let i = 0; i < 5; i++) trace(`event-${i}`, "llm.completed");
  const first = service.listEvents("task", { group: "llm", limit: 2 });
  const second = service.listEvents("task", { group: "llm", limit: 2, cursor: first.nextCursor! });
  expect(second.events.map(row => row.key)).toEqual(["trace:event-2", "trace:event-3"]);
  expect(second.pagination).toEqual({ totalCount: 5, page: null, totalPages: null, pageSize: 2, from: null, to: null });
  expect(() => service.listEvents("task", { group: "tool", cursor: first.nextCursor! })).toThrow(/游标/);
});

it("默认页长200，page不改变类别默认值，空筛选页无后续", () => {
  for (let i = 0; i < 201; i++) trace(`event-${i}`);
  insert("ui_events", { event_id: "ui", session_id: "session", task_id: "task", turn_id: "turn", kind: "run.updated", payload_json: "{}", created_at: time });
  const first = service.listEvents("task", { page: 1 });
  expect(first.events).toHaveLength(200);
  expect(first.pagination).toMatchObject({ totalCount: 202, pageSize: 200, totalPages: 2 });
  expect(service.listEvents("task", { page: 2 }).events.map(row => row.key)).toEqual(["trace:event-200", "ui:ui"]);
  const empty = service.listEvents("task", { page: 99, q: "no-match" });
  expect(empty.events).toEqual([]);
  expect(empty.pagination).toMatchObject({ totalCount: 0, page: 0, totalPages: 0, from: 0, to: 0 });
  expect(empty.hasMore).toBe(false);
});

it("无Task历史按Session隔离计数与翻页且只读", () => {
  for (const sessionId of ["ses_a", "ses_b"]) {
    insert("sessions", { id: sessionId, cwd: "/fixture", status: "completed", started_at: time });
    insert("turns", { id: sessionId, session_id: sessionId, task_id: null, input: "legacy", status: "completed", created_at: time });
    for (let i = 0; i < 3; i++) trace(`${sessionId}-${i}`, "llm.completed", null, sessionId, sessionId);
  }
  const before = db.prepare("select total_changes() n").get();
  db.exec("PRAGMA query_only=ON");
  const page = service.listEvents("legacy_ses_a", { page: 2, limit: 2, group: "llm" });
  expect(page.events.map(row => row.key)).toEqual(["trace:ses_a-2"]);
  expect(page.pagination).toEqual({ totalCount: 3, page: 2, totalPages: 2, pageSize: 2, from: 3, to: 3 });
  expect(db.prepare("select total_changes() n").get()).toEqual(before);
});

it("整页装不下明确400并提示缩小筛选，旧keyset和Live仍可预算部分返回", () => {
  for (let i = 0; i < 12; i++) insert("context_messages", { source_ref: `request:${i}:${"x".repeat(60000)}:response`, task_id: "task", turn_id: "turn", message_json: "{}", omitted: 0, created_at: time });
  const result = route("page=1&limit=12&category=message");
  expect(result.status).toBe(400);
  expect(result.body).toMatchObject({ error: expect.stringMatching(/缩小.*搜索.*类别/) });
  const old = service.listEvents("task", { category: "message", limit: 12 });
  expect(old.events.length).toBeGreaterThan(0);
  expect(old.events.length).toBeLessThan(12);
  expect(old.hasMore).toBe(true);
  expect(old.nextCursor).toBeTruthy();
  const live = service.listEvents("task", { category: "message", latest: true, limit: 12 });
  expect(live.pagination).toMatchObject({ totalCount: 12, from: 12 - live.events.length + 1, to: 12 });
});

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null])("服务拒绝非法page %s", (page) => {
  expect(() => service.listEvents("task", { page } as any)).toThrow(/无效|分页/);
});

it.each([
  "page=0", "page=-1", "page=1.5", "page=1e2", "page=", "page=9007199254740992", "page=1&page=2",
  "group=unknown", "group=", "group=llm&group=tool", "page=1&latest=true", "page=1&cursor=anything", "page=1&latest=1"
])("路由严格拒绝非法或冲突参数 %s", (query) => { expect(route(query).status).toBe(400); });

it("latest=false允许page，但service也检查冲突和无效group", () => {
  trace("one");
  expect(route("page=1&latest=false").status).toBe(200);
  for (const options of [{ page: 1, latest: true }, { page: 1, cursor: "" }, { group: "unknown" }, { group: null }]) {
    expect(() => service.listEvents("task", options as any)).toThrow(/无效|混用|分页/);
  }
});
