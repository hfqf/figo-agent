import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TraceInspectorQueryService } from "../../src/ui/trace-inspector-query-service.js";

const time = "2026-10-17 12:00:00.123";
let root: string;
let storage: StorageManager;
let service: TraceInspectorQueryService;
function insert(table: string, row: Record<string, string | number | null>) {
  const keys = Object.keys(row);
  storage.db.prepare(`insert into ${table} (${keys.join(",")}) values (${keys.map(() => "?").join(",")})`).run(...Object.values(row));
}
function trace(id: string, type: string, payload: object = {}, overrides: Record<string, string | null> = {}) {
  insert("trace_events", { id, session_id: "session", task_id: "task", turn_id: "turn", type, source: "AgentLoop",
    payload_json: JSON.stringify(payload), created_at: time, ...overrides });
}
function capture(id = "request", overrides: Record<string, string | number | null> = {}) {
  insert("llm_http_captures", { id: `cap-${id}`, request_id: id, session_id: "session", task_id: "task", turn_id: "turn",
    purpose: "turn", provider: "test", model: "test", url: "https://example.test", method: "POST", request_headers_json: "{}",
    request_body_json: "{}", response_status: 200, response_status_text: "OK", response_headers_json: "{}", response_body_json: "{}",
    duration_ms: 42, created_at: time, ...overrides });
}
function usage(id = "request", overrides: Record<string, string | number | null> = {}) {
  insert("token_usage", { capture_id: `cap-${id}`, request_id: id, session_id: "session", task_id: "task", turn_id: "turn",
    usage_turn_id: "turn", purpose: "turn", provider: "test", model: "test", prompt_tokens: 10, completion_tokens: 3,
    total_tokens: 13, status: "complete", created_at: time, ...overrides });
}
function tool(id = "tool", overrides: Record<string, string | number | null> = {}) {
  insert("tool_calls", { id, session_id: "session", turn_id: "turn", tool_name: "read_file", input_json: "{}", status: "completed",
    started_at: "2026-10-16 23:59:59.900", completed_at: "2026-10-17 00:00:01.025", ...overrides });
}
function event(key: string) { return service.listEvents("task", { limit: 500 }).events.find((row) => row.key === key)!; }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "figo-trace-metrics-"));
  storage = await StorageManager.init(root);
  for (const id of ["session", "other-session"]) insert("sessions", { id, cwd: root, status: "active", started_at: time });
  for (const [id, sessionId] of [["task", "session"], ["other-task", "session"], ["foreign-task", "other-session"]]) {
    insert("tasks", { id, session_id: sessionId, title: id, status: "active", created_at: time, updated_at: time });
    insert("turns", { id: id === "task" ? "turn" : `${id}-turn`, session_id: sessionId, task_id: id, input: "测试", status: "completed", created_at: time });
  }
  insert("turns", { id: "another-turn", session_id: "session", task_id: "task", input: "同Task另一轮", status: "completed", created_at: time });
  service = new TraceInspectorQueryService(storage);
});
afterEach(async () => { if (storage?.db.isOpen) storage.db.close(); if (root) await rm(root, { recursive: true, force: true }); });

it("完成工具及精确工具事件按上海毫秒文本计算跨日耗时，payload.tool 作为名称", () => {
  tool();
  trace("done", "tool.completed", { toolCallId: "tool", tool: "read_file" });
  for (const key of ["tool:tool", "trace:done"]) expect(event(key)).toMatchObject({ name: "read_file", durationMs: 1125,
    durationState: "recorded", tokens: null, tokenState: "not_applicable" });
});

it("LLM完成事件仅按精确request关联capture和单次实测usage", () => {
  capture(); usage();
  capture("unrelated", { duration_ms: 9000 }); usage("unrelated", { total_tokens: 99999 });
  trace("done", "llm.completed", { requestId: "request" });
  expect(event("trace:done")).toMatchObject({ durationMs: 42, durationState: "recorded", tokenState: "recorded",
    tokens: { value: 13, kind: "provider_actual", availability: "recorded" } });
});

it.each([
  { task_id: "other-task", turn_id: "other-task-turn" },
  { session_id: "other-session" },
  { turn_id: "another-turn" },
  { turn_id: "foreign-task-turn" }
])("异常capture引用不跨Task/Session/Turn关联 %#", (overrides) => {
  capture("request", overrides); usage("request", overrides);
  trace("done", "llm.completed", { requestId: "request" });
  expect(event("trace:done")).toMatchObject({ durationMs: null, durationState: "not_recorded", tokenState: "not_recorded" });
  expect(event("trace:done").tokens?.value ?? null).toBeNull();
});

it.each([
  { task_id: "other-task" }, { session_id: "other-session" }, { turn_id: "another-turn" }, { request_id: "wrong-request" }
])("usage即使capture_id相同仍校验完整归属 %#", (overrides) => {
  capture(); usage("request", overrides);
  trace("done", "llm.completed", { requestId: "request" });
  for (const key of ["trace:done", "capture:cap-request"]) {
    expect(event(key)).toMatchObject({ durationMs: 42, durationState: "recorded", tokenState: "not_recorded" });
    expect(event(key).tokens?.value ?? null).toBeNull();
  }
});

it("Turn本身归属异常时不得用相同错误字段串联LLM或工具指标", () => {
  storage.db.prepare("update turns set session_id = 'other-session' where id = 'turn'").run();
  capture(); usage(); tool();
  trace("llm", "llm.completed", { requestId: "request" });
  trace("tool", "tool.completed", { toolCallId: "tool" });
  expect(event("trace:llm")).toMatchObject({ durationMs: null, tokenState: "not_recorded" });
  expect(event("trace:tool")).toMatchObject({ durationMs: null, durationState: "not_recorded" });
});

it.each([{ turn_id: "other-task-turn" }, { session_id: "other-session" }, { turn_id: "another-turn" }])("异常工具引用不串耗时 %#", (overrides) => {
  tool("tool", overrides);
  trace("done", "tool.completed", { toolCallId: "tool", tool: "read_file" });
  expect(event("trace:done")).toMatchObject({ durationMs: null, durationState: "not_recorded", tokenState: "not_applicable" });
});

it("请求ID重复且同归属时不猜测也不重复事实行", () => {
  capture(); capture("duplicate", { request_id: "request" }); usage();
  trace("done", "llm.completed", { requestId: "request" });
  const rows = service.listEvents("task", { category: "trace" }).events;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ durationMs: null, durationState: "not_recorded", tokenState: "not_recorded" });
});

it("真实零耗时和零Token保持recorded而非缺失", () => {
  capture("request", { duration_ms: 0 }); usage("request", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  tool("zero", { started_at: time, completed_at: time });
  trace("done", "llm.completed", { requestId: "request" });
  expect(event("trace:done")).toMatchObject({ durationMs: 0, durationState: "recorded", tokenState: "recorded", tokens: { value: 0 } });
  expect(event("tool:zero")).toMatchObject({ durationMs: 0, durationState: "recorded", tokens: null });
});

it("LOCAL占位无usage不伪造模型Token，远程未记录与模型未提供分开", () => {
  capture("local", { method: "LOCAL", response_status_text: "LOCAL_FALLBACK" });
  capture("missing");
  capture("unavailable"); usage("unavailable", { prompt_tokens: null, completion_tokens: null, total_tokens: null, status: "unavailable" });
  for (const requestId of ["local", "missing", "unavailable"]) trace(requestId, "llm.completed", { requestId });
  expect(event("trace:local")).toMatchObject({ tokenState: "not_applicable", tokens: null });
  expect(event("capture:cap-local")).toMatchObject({ tokenState: "not_applicable", tokens: null });
  expect(event("trace:missing").tokenState).toBe("not_recorded");
  expect(event("trace:unavailable")).toMatchObject({ tokenState: "provider_unavailable", tokens: { value: null, availability: "unavailable" } });
});

it("进行中、失败未记录和已记录失败耗时分别展示", () => {
  trace("pending", "llm.called", { requestId: "pending" });
  trace("failed", "llm.failed", { requestId: "failed" });
  capture("http-error", { response_status: 0, duration_ms: 99 });
  usage("http-error", { total_tokens: null, prompt_tokens: null, completion_tokens: null, status: "unavailable" });
  trace("http-error", "llm.failed", { requestId: "http-error" });
  tool("running", { status: "received", completed_at: null });
  tool("failed", { status: "failed", completed_at: null });
  tool("error-timed", { status: "failed" });
  expect(event("trace:pending")).toMatchObject({ durationMs: null, durationState: "pending", tokenState: "pending" });
  expect(event("trace:failed")).toMatchObject({ durationMs: null, durationState: "not_recorded", tokenState: "not_recorded" });
  expect(event("trace:http-error")).toMatchObject({ durationMs: 99, durationState: "recorded", tokenState: "provider_unavailable" });
  expect(event("tool:running")).toMatchObject({ durationMs: null, durationState: "pending", tokenState: "not_applicable" });
  expect(event("tool:failed")).toMatchObject({ durationMs: null, durationState: "not_recorded" });
  expect(event("tool:error-timed")).toMatchObject({ durationMs: 1125, durationState: "recorded" });
});

it("瞬时事件不适用耗时或Token，context估算与compaction source显式保留", () => {
  trace("instant", "turn.completed");
  trace("context", "context.build.completed", { estimatedTokens: 0 });
  trace("estimate", "compaction.skipped", { tokens: 100, source: "estimate" });
  trace("usage", "compaction.skipped", { tokens: 150, source: "usage" });
  trace("unknown", "compaction.skipped", { tokensBefore: 20 });
  expect(event("trace:instant")).toMatchObject({ durationMs: null, durationState: "not_applicable", tokens: null, tokenState: "not_applicable" });
  expect(event("trace:context")).toMatchObject({ tokenState: "recorded", tokens: { value: 0, kind: "estimate" } });
  expect(event("trace:estimate").tokens).toMatchObject({ value: 100, kind: "estimate" });
  expect(event("trace:usage").tokens).toMatchObject({ value: 150, kind: "usage_plus_estimate" });
  expect(event("trace:unknown").tokens).toMatchObject({ value: 20, kind: "unknown" });
});

it.each(["bad-time", "2026-10-16 23:59:58.900", "2026-13-17 00:00:01.025"])("非法或逆序时间不伪造耗时：%s", (completed_at) => {
  tool("bad-time", { completed_at });
  expect(event("tool:bad-time")).toMatchObject({ durationMs: null, durationState: "not_recorded" });
});

it("指标富化只读，不改变八类默认集合、稳定排序或分页游标", () => {
  capture(); usage(); tool(); trace("a", "llm.completed", { requestId: "request" }); trace("b", "turn.completed");
  const before = storage.db.prepare("select total_changes() as n").get();
  storage.db.exec("PRAGMA query_only = ON");
  const all = service.listEvents("task").events;
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = service.listEvents("task", { limit: 2, cursor });
    keys.push(...page.events.map((row) => row.key));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(keys).toEqual(all.map((row) => row.key));
  expect(storage.db.prepare("select total_changes() as n").get()).toEqual(before);
  expect(service.detail("trace:a").row.durationMs).toBe(42);
});
