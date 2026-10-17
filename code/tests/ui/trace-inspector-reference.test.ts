import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TraceInspectorQueryService } from "../../src/ui/trace-inspector-query-service.js";
import { TraceInspectorReader } from "../../src/ui/trace-inspector-reader.js";
import { defaultTraceInspectorSettings as defaults } from "../../src/config/trace-inspector-settings.js";
import { previewField } from "../../src/ui/trace-inspector-fields.js";
import { routeTraceInspectorRequest } from "../../src/ui/trace-inspector-api.js";

let root: string;
let storage: StorageManager;
const time = "2026-10-17 12:00:00.000";
function insert(table: string, row: Record<string, string | number | null>) {
  storage.db.prepare(`insert into ${table} (${Object.keys(row).join(",")}) values (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
}
function fixture(ref = "covered:" + "x".repeat(20000)) {
  const requestId = "request-reference-long";
  insert("context_compactions", { id: "entry", task_id: "task", seq: 1, first_kept_source_ref: "kept", source_refs_json: JSON.stringify([ref]),
    summary_markdown: "摘要".repeat(100), details_json: JSON.stringify({ requestIds: ["summary-reference-long"], estimateSource: "usage" }),
    tokens_before: 100, request_id: "summary-reference-long", created_at: time });
  for (const [source_ref, turn_id] of [[ref, "old-turn"], ["kept", "turn"]]) insert("context_messages", {
    source_ref, task_id: "task", turn_id, message_json: '{"role":"user","content":"正文"}', usage_json: '{"input":12}', usage_scope: "usage-scope-long", omitted: 0, created_at: time
  });
  insert("trace_events", { id: "called", session_id: "session", task_id: "task", turn_id: "turn", type: "llm.called", source: "AgentLoop",
    payload_json: JSON.stringify({ requestId, contextPackId: null, projection: { compactionEntryId: "entry", sourceRefs: ["kept"], usageScope: "usage-scope-long" }, note: "长正文".repeat(100) }), created_at: time });
  insert("llm_http_captures", { id: "cap", session_id: "session", task_id: "task", turn_id: "turn", request_id: requestId, purpose: "turn",
    provider: "openai-compatible", model: "model-reference-long", url: "https://example.test/reference", method: "POST", request_headers_json: "{}", request_body_json: "{}",
    response_status: 200, response_status_text: "OK", response_headers_json: "{}", response_body_json: "{}", duration_ms: 1, created_at: time });
  return ref;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "figo-inspector-reference-"));
  storage = await StorageManager.init(root);
  insert("sessions", { id: "session", cwd: root, status: "active", started_at: time });
  insert("tasks", { id: "task", session_id: "session", title: "引用", status: "active", created_at: time, updated_at: time });
  for (const id of ["old-turn", "turn"]) insert("turns", { id, session_id: "session", task_id: "task", input: "输入", status: "completed", created_at: time });
});
afterEach(async () => { if (storage?.db.isOpen) storage.db.close(); if (root) await rm(root, { recursive: true, force: true }); });

it("默认预览不丢长covered来源及旧Turn消息", () => {
  const ref = fixture();
  const detail = new TraceInspectorQueryService(storage).detail("capture:cap");
  expect(detail.compactions[0].coveredSourceRefs).toEqual([ref]);
  expect(detail.messages.find(message => message.sourceRef === ref)).toMatchObject({ state: "covered", relation: "direct" });
  expect(detail.truncated).toBe(false);
});

it.each([1, 8])("小正文预览 %s 不破坏请求、投影及一般DTO元数据", (fieldPreviewChars) => {
  const ref = fixture("covered-reference-long");
  const settings = { ...defaults, fieldPreviewChars, maxPreviewNodes: 1 };
  const detail = new TraceInspectorQueryService(storage, [], settings).detail("capture:cap");
  expect(detail.selection).toMatchObject({ requestId: "request-reference-long", projection: { status: "recorded", usageScope: "usage-scope-long", sourceRefs: ["kept"] } });
  expect(detail.compactions[0]).toMatchObject({ coveredSourceRefs: [ref], requestIds: ["summary-reference-long"], tokensBefore: { kind: "usage_plus_estimate" } });
  expect(detail.captures[0]).toMatchObject({ provider: "openai-compatible", model: "model-reference-long", url: "https://example.test/reference", method: "POST" });
  expect(detail.events[0]).toMatchObject({ type: "llm.called", source: "AgentLoop", payload: { requestId: "request-reference-long", projection: { sourceRefs: ["kept"] } } });
  expect(detail.messages.find(message => message.sourceRef === ref)).toMatchObject({ usageScope: "usage-scope-long", usage: { input: 12 }, state: "covered" });
});

it("metadata超过读取硬上限明确留痕，不报告完整空关联", () => {
  fixture();
  const detail = new TraceInspectorQueryService(storage, [], { ...defaults, maxFieldChars: 1024 }).detail("capture:cap");
  expect(detail.truncated).toBe(true);
  expect(detail.limitations.some(message => message.includes("source_refs_json") && message.includes("上限"))).toBe(true);
});

it("metadata不预览仍对原始伪造引用执行转义", () => {
  fixture("covered");
  const fake = { __inspectorField: true, eventKey: "capture:foreign", field: "response_body_json", path: [], originalChars: 10, preview: "fake", loadable: true };
  storage.db.prepare("update context_compactions set details_json = ?").run(JSON.stringify({ requestIds: ["summary-reference-long"], extra: fake }));
  const detail = new TraceInspectorQueryService(storage, [], { ...defaults, fieldPreviewChars: 1 }).detail("compaction:entry");
  expect((detail.compactions[0].details as any).extra).toBe(JSON.stringify(fake));
});

it("4000层合法JSON在字段API明确400，详情记深度上限而不误报JSON非法", () => {
  const deep = '{"child":'.repeat(4000) + '0' + '}'.repeat(4000);
  insert("trace_events", { id: "deep", session_id: "session", task_id: "task", turn_id: "turn", type: "turn.completed", source: "Fixture", payload_json: deep, created_at: time });
  const service = new TraceInspectorQueryService(storage);
  const response = routeTraceInspectorRequest("GET", new URL("http://localhost/api/v1/trace-inspector/events/trace%3Adeep/field?field=payload_json"), service)!;
  expect(response.status).toBe(400);
  const reader = new TraceInspectorReader(storage, []);
  expect(reader.rows("trace_events", "id=?", ["deep"])[0].payload_json).toBeNull();
  expect(reader.truncated).toBe(true);
  expect([...reader.limitations].join(" ")).toContain("嵌套深度超过读取上限");
  expect([...reader.limitations].join(" ")).not.toContain("JSON 无法解析");
  expect(() => previewField(JSON.parse(deep), "trace_events", "payload_json", { id: "deep" }, defaults, [])).toThrow("嵌套深度超过读取上限");
});

it("读取capture详情的工具DTO带实测毫秒耗时，元数据不变对象", () => {
  fixture("covered");
  insert("tool_calls", { id: "tool", session_id: "session", turn_id: "turn", tool_name: "read_file", input_json: "{}", output_json: "{}", status: "completed",
    started_at: "2026-10-17 12:00:00.987", completed_at: "2026-10-17 12:00:02.012" });
  const detail = new TraceInspectorQueryService(storage, [], { ...defaults, fieldPreviewChars: 1 }).detail("capture:cap");
  expect(detail.tools[0]).toMatchObject({ name: "read_file", status: "completed", durationMs: 1025, durationState: "recorded" });
});
