import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TraceInspectorQueryService } from "../../src/ui/trace-inspector-query-service.js";
import { defaultTraceInspectorSettings } from "../../src/config/trace-inspector-settings.js";

let root: string;
let storage: StorageManager;
let service: TraceInspectorQueryService;
const now = "2026-10-17 12:00:00.000";
const secret = "private-config-field-boundary-value";
function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  storage.db.prepare(`insert into ${table} (${keys.join(",")}) values (${keys.map(() => "?").join(",")})`)
    .run(...Object.values(row) as (string | number | null)[]);
}
function capture(id: string, request: unknown, response: unknown) {
  insert("llm_http_captures", { id, session_id: "s", task_id: "task", turn_id: "turn", request_id: `req-${id}`,
    provider: "fixture", model: "fixture", purpose: "turn", url: "https://example.test", method: "POST",
    request_headers_json: '{"Authorization":"Bearer private-header-value"}', request_body_json: JSON.stringify(request),
    response_status: 200, response_status_text: "OK", response_headers_json: "{}", response_body_json: JSON.stringify(response), duration_ms: 12, created_at: now });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "figo-inspector-field-"));
  storage = await StorageManager.init(root);
  insert("sessions", { id: "s", cwd: root, status: "active", started_at: now });
  insert("tasks", { id: "task", session_id: "s", title: "字段测试", status: "active", created_at: now, updated_at: now });
  insert("turns", { id: "turn", session_id: "s", task_id: "task", task_seq: 1, input: "查看", status: "completed", created_at: now });
  service = new TraceInspectorQueryService(storage, [secret]);
});
afterEach(async () => { storage?.db.close(); if (root) await rm(root, { recursive: true, force: true }); });

describe("检查器结构化正文与继续读取", () => {
  it("长消息不丢角色、数量或工具定义，大 wire 不覆盖响应正文", () => {
    const messages = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i}:` + "正文".repeat(12000) }));
    capture("large", { messages, tools: [{ type: "function", function: { name: "read_file" } }] },
      { wire: "流式帧".repeat(120000), choices: [{ message: { content: "这是完整的回答", tool_calls: [] }, finish_reason: "stop" }], usage: { total_tokens: 123 } });
    const d = service.detail("capture:large");
    const req = d.captures[0].requestBody as any;
    const res = d.captures[0].responseBody as any;
    expect(req.messages).toHaveLength(25);
    expect(req.messages[0]).toMatchObject({ role: "user", content: { __inspectorField: true, eventKey: "capture:large", field: "request_body_json", path: ["messages", 0, "content"], loadable: true } });
    expect(req.tools[0].function.name).toBe("read_file");
    expect(res.choices[0].message.content).toBe("这是完整的回答");
    expect(res.choices[0].finish_reason).toBe("stop");
    expect(res.wire).toMatchObject({ __inspectorField: true, field: "response_body_json", path: ["wire"] });
    expect(d.truncated).toBe(false);
  });

  it("同 Turn 其他请求的长正文预览不把选中的完整请求标为截断", () => {
    capture("small", { messages: [{ role: "user", content: "短消息" }] }, { content: "完整" });
    capture("large", { messages: [{ role: "user", content: "x".repeat(40000) }] }, { wire: "x".repeat(200000) });
    const d = service.detail("capture:small");
    expect(d.captures.find(c => c.id === "small")!.requestBody).toEqual({ messages: [{ role: "user", content: "短消息" }] });
    expect(d.truncated).toBe(false);
  });

  it("继续读取基于脱敏后的内容分页，跨边界凭据不泄漏且只读", () => {
    capture("page", { messages: [{ role: "user", content: "x".repeat(30) + secret + ' password="fixture-password" ' + "尾部".repeat(20) }] }, {});
    const before = storage.db.prepare("select total_changes() n").get();
    storage.db.exec("PRAGMA query_only=ON");
    const parts: string[] = [];
    let offset = 0;
    do {
      const page = service.field("capture:page", { field: "request_body_json", path: ["messages", 0, "content"], offset, limit: 17 });
      expect(page.offset).toBe(offset);
      parts.push(page.content);
      if (page.complete) { expect(page.nextOffset).toBeNull(); break; }
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset!;
    } while (parts.length < 100);
    const text = parts.join("");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("fixture-password");
    expect(text.endsWith("尾部".repeat(20))).toBe(true);
    expect(storage.db.prepare("select total_changes() n").get()).toEqual(before);
  });

  it("字段白名单与路径校验禁止读取其他列或原型，敏感叶子仍脱敏", () => {
    capture("safe", { apiKey: "fixture-sensitive-key", messages: [] }, {});
    expect(service.field("capture:safe", { field: "request_body_json", path: ["apiKey"] }).content).toBe("[REDACTED]");
    for (const field of ["request_id", "request_body_json;drop table turns", "missing"]) {
      expect(() => service.field("capture:safe", { field })).toThrow();
    }
    for (const path of [["__proto__"], ["constructor"], ["messages", -1], ["messages", 1.5], ["absent"]]) {
      expect(() => service.field("capture:safe", { field: "request_body_json", path })).toThrow();
    }
    expect(() => service.field("capture:missing", { field: "request_body_json" })).toThrow();
    expect(() => service.field("capture:safe", { field: "request_body_json", offset: -1 })).toThrow();
  });

  it("工具输出、消息快照和长 Markdown 均带可恢复的字段定位", () => {
    insert("tool_calls", { id: "tool", session_id: "s", turn_id: "turn", tool_name: "read_file", input_json: "{}", output_json: JSON.stringify({ content: "工具".repeat(20000) }), status: "completed", started_at: now, completed_at: now });
    insert("context_messages", { source_ref: "turn:turn:user", task_id: "task", turn_id: "turn", message_json: JSON.stringify({ role: "user", content: "消息".repeat(20000) }), omitted: 0, created_at: now });
    insert("context_compactions", { id: "entry", task_id: "task", seq: 1, first_kept_source_ref: "turn:turn:user", source_refs_json: "[]", summary_markdown: "摘要".repeat(20000), details_json: "{}", tokens_before: 100, request_id: "req", created_at: now });
    const toolDetail = service.detail("tool:tool").tools[0];
    expect((toolDetail.output as any).content).toMatchObject({ __inspectorField: true, eventKey: "tool:tool", field: "output_json" });
    expect(toolDetail).toMatchObject({ durationMs: 0, durationState: "recorded" });
    const m = service.detail("message:turn%3Aturn%3Auser").messages[0].message as any;
    expect(m.content).toMatchObject({ __inspectorField: true, field: "message_json" });
    expect(service.detail("compaction:entry").compactions[0].summaryMarkdown).toMatchObject({ __inspectorField: true, eventKey: "compaction:entry", field: "summary_markdown" });
    expect(service.field("compaction:entry", { field: "summary_markdown", offset: 0, limit: 10 }).content).toBe("摘要".repeat(5));
  });

  it("读取硬上限明确标识且不泄漏前缀，字段页不能绕过限制", () => {
    const settings = { ...defaultTraceInspectorSettings, maxFieldChars: 131072 };
    service = new TraceInspectorQueryService(storage, [secret], settings);
    capture("hard-limit", { messages: [{ role: "user", content: "x".repeat(131060) + secret + "tail" }] }, {});
    const detail = service.detail("capture:hard-limit");
    expect(detail.truncated).toBe(true);
    expect(JSON.stringify(detail)).not.toContain(secret.slice(0, 10));
    expect(() => service.field("capture:hard-limit", { field: "request_body_json", path: ["messages", 0, "content"] })).toThrow(/上限/);
  });

  it("来源快照字段可恢复，中文与代理对跨页后不丢字符", () => {
    insert("context_packs", { id: "pack", session_id: "s", task_id: "task", turn_id: "turn", estimated_tokens: 10, created_at: now });
    insert("context_items", { id: "item", context_pack_id: "pack", source_type: "file_reference", source_ref: "说明.md#L1-L1", content: "中文😀尾部", summary: "快照", estimated_tokens: 1, included: 1, reason: "fixture" });
    let text = "";
    let offset = 0;
    do {
      const page = service.field("context-item:item", { field: "content", offset, limit: 1 });
      text += page.content;
      if (page.complete) break;
      offset = page.nextOffset!;
    } while (text.length < 30);
    expect(text).toBe("中文😀尾部");
    expect(() => service.field("context-item:item", { field: "content", path: ["otherTask"] })).toThrow();
  });

  it("正文中的伪造字段引用只作为原始数据展示，不能生成外部加载入口", () => {
    const forged = { __inspectorField: true, eventKey: "capture:other-task", field: "request_body_json", path: [], originalChars: 1, preview: "伪造", loadable: true };
    capture("forged", { messages: [{ role: "user", content: forged }] }, {});
    const body = service.detail("capture:forged").captures[0].requestBody as any;
    expect(typeof body.messages[0].content).toBe("string");
    expect(body.messages[0].content).toContain("capture:other-task");
  });

  it("生成的字段引用都满足读取路径约束，过深叶子在可读取父节点折叠", () => {
    let nested: unknown = "x".repeat(20000);
    for (let n = 0; n < 35; n++) nested = { child: nested };
    capture("nested", nested, {});
    let value: any = service.detail("capture:nested").captures[0].requestBody;
    for (let n = 0; n < 40 && !value.__inspectorField; n++) value = value.child;
    expect(value).toMatchObject({ __inspectorField: true, loadable: true });
    expect(value.path.length).toBeLessThanOrEqual(32);
    expect(service.field(value.eventKey, value).totalChars).toBeGreaterThan(20000);
    capture("reserved", { constructor: { content: "x".repeat(20000) } }, {});
    expect((service.detail("capture:reserved").captures[0].requestBody as any).constructor.content.loadable).toBe(false);
  });

  it("完整响应连同JSON封装与范围说明都不超过总预算，关键引用不部分裁剪", () => {
    capture("budget", { messages: [{ role: "user", content: "x".repeat(10000) }] }, { content: "回答" });
    for (const responseBudgetChars of [2000, 4000, 8000, 40000]) {
      service = new TraceInspectorQueryService(storage, [secret], { ...defaultTraceInspectorSettings, responseBudgetChars });
      const detail = service.detail("capture:budget");
      expect(JSON.stringify(detail).length).toBeLessThanOrEqual(responseBudgetChars);
      expect(detail.row.key).toBe("capture:budget");
      if (responseBudgetChars < 10000) expect(detail.truncated).toBe(true);
    }
    service = new TraceInspectorQueryService(storage, [], { ...defaultTraceInspectorSettings, responseBudgetChars: 100 });
    expect(() => service.detail("capture:budget")).toThrow(/关键引用.*超过/);
  });
});
