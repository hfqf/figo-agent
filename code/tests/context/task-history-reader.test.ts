import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskHistoryReader } from "../../src/context/task-history-reader.js";
import { TurnManager } from "../../src/kernel/turn-manager.js";
import { LLMHttpCaptureStore } from "../../src/llm/llm-http-capture-store.js";
import { StorageManager } from "../../src/storage/storage-manager.js";
import type { LLMMessage } from "../../src/contracts/types.js";
import type { ConversationMessage } from "../../src/context/conversation-message.js";
import { wireUsageScope } from "../../src/context/conversation-message.js";
import { readConversationProjection } from "../../src/context/conversation-projection.js";
import { CompactionStore } from "../../src/context/compaction-store.js";
import { buildNativeToolResultMessages, buildToolResultMessage } from "../../src/loop/llm-message-builder.js";
import { zhCN } from "../../src/i18n/catalog.js";

let root = "";
const opened: StorageManager[] = [];
afterEach(async () => {
  for (const storage of opened.splice(0)) if (storage.db.isOpen) storage.db.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "figo-history-snapshot-"));
  const storage = await StorageManager.init(root);
  opened.push(storage);
  storage.db.exec(`CREATE TABLE IF NOT EXISTS context_messages (
    source_ref TEXT PRIMARY KEY, task_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    message_json TEXT NOT NULL, usage_json TEXT, usage_scope TEXT, stop_reason TEXT,
    omitted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  )`);
  storage.db.prepare("insert into sessions (id,cwd,status,started_at) values (?,?,?,?)").run("s", root, "active", "now");
  storage.db.prepare("insert into tasks (id,session_id,title,status,created_at,updated_at) values (?,?,?,?,?,?)")
    .run("task", "s", "review", "active", "now", "now");
  const turns = new TurnManager(storage);
  const turn = turns.create("s", "task", "inspect");
  const reader = new TaskHistoryReader(storage);
  const captures = new LLMHttpCaptureStore(storage);
  const initial = [{ role: "system", content: "system" }, { role: "user", content: "inspect" }];
  const entry = (sourceRef: string, message: LLMMessage, extra: Partial<ConversationMessage> = {}): ConversationMessage =>
    ({ sourceRef, turnId: turn.id, message, ...extra });
  const capture = (id: string, messages: unknown[], response: unknown, finish = "stop", usage?: unknown, turnId = turn.id) =>
    captures.record({ sessionId: "s", taskId: "task", turnId, provider: "p", model: "m", url: "local:test", method: "LOCAL",
      requestHeaders: {}, responseStatus: 200, responseStatusText: "OK", responseHeaders: {}, durationMs: 1,
      requestId: id, requestBody: { messages }, responseBody: { choices: [{ message: response, finish_reason: finish }], usage } });
  const snapshot = (entries: ConversationMessage[], taskId = "task") => {
    for (const [index, value] of entries.entries()) storage.db.prepare(
      "insert into context_messages (source_ref,task_id,turn_id,message_json,usage_json,usage_scope,stop_reason,omitted,created_at) values (?,?,?,?,?,?,?,?,?)"
    ).run(value.sourceRef, taskId, value.turnId, JSON.stringify(value.message), value.usage ? JSON.stringify(value.usage) : null,
      value.usageScope ?? null, value.stopReason ?? null, value.omitted ? 1 : 0, `2026-10-15 10:00:${String(59 - index).padStart(2, "0")}.000`);
  };
  const tool = (id: string, intentId: string, output: unknown, round = 0) => storage.db.prepare(
    "insert into tool_calls (id,session_id,turn_id,intent_id,round,tool_name,input_json,output_json,status,started_at) values (?,?,?,?,?,?,?,?,?,?)"
  ).run(id, "s", turn.id, intentId, round, "read_file", "{}", JSON.stringify(output), "completed", "now");
  return { storage, turns, turn, reader, initial, entry, capture, snapshot, tool };
}

const wireCall = (id: string) => ({ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `${id}.txt` }) } });
const nativeAssistant = (...ids: string[]) => ({ role: "assistant", content: null, tool_calls: ids.map(wireCall) });

describe("TaskHistoryReader 精确消息快照", () => {
  it("按 rowid 优先恢复源表原文，不读取 Trace 脱敏正文或抓包替换它", async () => {
    const f = await fixture();
    f.capture("wire", f.initial, { role: "assistant", content: "抓包中的不同内容" });
    const expected = [f.entry(`turn:${f.turn.id}:user`, { role: "user", content: "精确用户原文" }),
      f.entry("request:exact:response", { role: "assistant", content: "精确回答" }, {
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, usageScope: "scope", stopReason: "stop"
      })];
    f.snapshot(expected);
    f.storage.db.prepare("insert into trace_events (id,session_id,task_id,turn_id,type,source,payload_json,created_at) values (?,?,?,?,?,?,?,?)")
      .run("trace", "s", "task", f.turn.id, "context.messages.appended", "test", JSON.stringify({ messages: [{ ...expected[1], message: { role: "assistant", content: "[REDACTED]" } }] }), "now");
    expect(f.reader.messages("task")).toEqual(expected);
    expect(f.reader.captureMessages("task").some((item) => item.sourceRef === "request:wire:response")).toBe(true);
  });

  it("重复 toolCallId 与相同文本按独立 sourceRef 全部保留", async () => {
    const f = await fixture();
    const call = { id: "same", name: "read_file", input: { path: "a" } };
    const expected = [f.entry("request:a:response", { role: "assistant", content: "", toolCalls: [call] }),
      f.entry("tool:row-a:result", { role: "tool", toolCallId: "same", content: "identical" }),
      f.entry("request:b:response", { role: "assistant", content: "", toolCalls: [call] }),
      f.entry("tool:row-b:result", { role: "tool", toolCallId: "same", content: "identical" })];
    f.snapshot(expected);
    expect(f.reader.messages("task")).toEqual(expected);
  });

  it("原样恢复 omitted 原文，仅列值 1 映射 omitted:true", async () => {
    const f = await fixture();
    const expected = [f.entry("user", { role: "user", content: "inspect" }),
      f.entry("request:failed:response", { role: "assistant", content: "保留失败尝试原文" }, { stopReason: "length", omitted: true })];
    f.snapshot(expected);
    const restored = f.reader.messages("task");
    expect(restored).toEqual(expected);
    expect(restored[0]).not.toHaveProperty("omitted");
    expect(f.storage.db.prepare("select message_json from context_messages where source_ref = ?").get("request:failed:response"))
      .toEqual({ message_json: JSON.stringify(expected[1].message) });
  });

  it("每个 Turn 独立决定快照优先，无快照 Turn 沿抓包兼容并尊重 beforeSeq", async () => {
    const f = await fixture();
    const saved = f.entry("snapshot:first", { role: "user", content: "快照" });
    f.snapshot([saved]);
    const second = f.turns.create("s", "task", "second");
    f.capture("second", [{ role: "user", content: "second" }], { role: "assistant", content: "answer" }, "stop", undefined, second.id);
    expect(f.reader.messages("task").map((item) => item.sourceRef)).toEqual([
      "snapshot:first", `turn:${second.id}:user`, "request:second:response"
    ]);
    expect(f.reader.messages("task", 2)).toEqual([saved]);
    expect(f.reader.messages("other")).toEqual([]);
  });

  it("关闭重开后自定义预算的 native batch、feedback、usage 与 omitted 快照逐项相同", async () => {
    const f = await fixture();
    const batch = buildNativeToolResultMessages(["a", "b"].map((id) => ({ id, name: "read_file", status: "completed" as const,
      output: { content: id.repeat(10000) } })), 17, 300);
    const expected = [f.entry(`turn:${f.turn.id}:user`, { role: "user", content: "inspect" }),
      f.entry("request:a:response", { role: "assistant", content: "", toolCalls: ["a", "b"].map((id) => ({ id, name: "read_file", input: {} })) }),
      ...batch.map((message, index) => f.entry(`tool:row${index}:result`, message)),
      f.entry("request:a:feedback:0", { role: "user", content: "feedback" }),
      f.entry("request:failed:response", { role: "assistant", content: "partial" }, { omitted: true, stopReason: "length" }),
      f.entry("request:final:response", { role: "assistant", content: "final" }, { usageScope: "stable-scope", stopReason: "stop",
        usage: { input: 90, output: 10, cacheRead: 2, cacheWrite: 3, totalTokens: 105 } })];
    f.snapshot(expected);
    f.storage.db.close();
    const reopened = await StorageManager.init(root);
    opened.push(reopened);
    expect(new TaskHistoryReader(reopened).messages("task")).toEqual(expected);
  });

  it("快照中的 feedback 可以独立作为压缩边界，不要求下一抓包仍带前一 assistant", async () => {
    const f = await fixture();
    const entries = [f.entry("request:bad:response", { role: "assistant", content: "bad" }),
      f.entry("request:bad:feedback:0", { role: "user", content: "repair" }),
      f.entry("request:final:response", { role: "assistant", content: "done" })];
    f.snapshot(entries);
    const store = new CompactionStore(f.storage);
    store.appendEntry({ taskId: "task", firstKeptSourceRef: entries[1].sourceRef, coveredSourceRefs: [entries[0].sourceRef],
      summaryMarkdown: "summary", details: { readFiles: [], modifiedFiles: [] }, tokensBefore: 10, requestId: "summary" });
    expect(readConversationProjection(f.reader, store, "task").messages).toEqual(entries.slice(1));
  });

  it("未进入精确快照的失败抓包仍可通过独立 captureMessages 查找", async () => {
    const f = await fixture();
    f.snapshot([f.entry("user", { role: "user", content: "inspect" })]);
    f.capture("failed", f.initial, { role: "assistant", content: "partial" }, "length");
    expect(f.reader.messages("task").map((item) => item.sourceRef)).toEqual(["user"]);
    expect(f.reader.captureMessages("task").find((item) => item.sourceRef === "request:failed:response"))
      .toMatchObject({ message: { role: "assistant", content: "partial" }, stopReason: "length" });
  });

  it("list 展示完整 native 工具快照、同文不同来源、反馈及 omitted 事实", async () => {
    const f = await fixture();
    f.capture("legacy", f.initial, { role: "assistant", content: "旧抓包答案不应替换快照" });
    const expected = [f.entry("user", { role: "user", content: "inspect" }),
      f.entry("request:call:response", { role: "assistant", content: "", toolCalls: [
        { id: "a", name: "read_file", input: { path: "a.txt" } },
        { id: "b", name: "read_file", input: { path: "b.txt" } }
      ] }),
      f.entry("tool:a:result", { role: "tool", toolCallId: "a", content: "相同工具原文" }),
      f.entry("tool:b:result", { role: "tool", toolCallId: "b", content: "相同工具原文" }),
      f.entry("request:call:feedback:0", { role: "user", content: "继续检查" }),
      f.entry("request:failed:response", { role: "assistant", content: "失败尝试原文" }, { stopReason: "error", omitted: true }),
      f.entry("request:final:response", { role: "assistant", content: "最终回答" })];
    f.snapshot(expected);
    const content = f.reader.list("task")[0].content;
    for (const item of expected) {
      expect(content).toContain(item.sourceRef);
      if (item.message.content) expect(content).toContain(item.message.content);
    }
    expect(content).toContain('"role": "tool"');
    expect(content).toContain('"omitted": true');
    expect(content).toContain('"stopReason": "error"');
    expect(content.match(/相同工具原文/g)).toHaveLength(2);
    expect(content).not.toContain("旧抓包答案不应替换快照");
  });

  it("重启投影排除 omitted 尝试且仅清除压缩前 usage，Reader 保留原始事实", async () => {
    const f = await fixture();
    const usage = { input: 90, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 100 };
    const entries = [f.entry("user", { role: "user", content: "inspect" }),
      f.entry("request:before:response", { role: "assistant", content: "old" }, { usage, usageScope: "scope", stopReason: "stop" }),
      f.entry("request:failed:response", { role: "assistant", content: "partial" }, { omitted: true, stopReason: "length", usage, usageScope: "scope" }),
      f.entry("request:after:response", { role: "assistant", content: "new" }, { usage, usageScope: "scope", stopReason: "stop" })];
    f.snapshot(entries);
    new CompactionStore(f.storage).appendEntry({ taskId: "task", firstKeptSourceRef: entries[1].sourceRef,
      coveredSourceRefs: [entries[0].sourceRef], summaryMarkdown: "summary", tokensBefore: 100, requestId: "summary",
      details: { readFiles: [], modifiedFiles: [], boundaryRequestRefs: [entries[1].sourceRef] } });
    f.storage.db.close();
    const reopened = await StorageManager.init(root);
    opened.push(reopened);
    const reader = new TaskHistoryReader(reopened);
    expect(reader.messages("task")).toEqual(entries);
    const projected = readConversationProjection(reader, new CompactionStore(reopened), "task");
    expect(projected.messages).toEqual([{ ...entries[1], usage: undefined }, entries[3]]);
  });

  it("list 快照跨重启等价且只展示所选 Task", async () => {
    const f = await fixture();
    f.snapshot([f.entry("current", { role: "tool", toolCallId: "a", content: "当前任务工具原文" })]);
    f.storage.db.prepare("insert into tasks (id,session_id,title,status,created_at,updated_at) values (?,?,?,?,?,?)")
      .run("other", "s", "other", "active", "now", "now");
    const other = f.turns.create("s", "other", "other input");
    f.snapshot([{ sourceRef: "other-source", turnId: other.id, message: { role: "tool", toolCallId: "a", content: "其它任务工具原文" } }], "other");
    const before = f.reader.list("task");
    expect(before[0].content).toContain("当前任务工具原文");
    expect(before[0].content).not.toContain("其它任务工具原文");
    f.storage.db.close();
    const reopened = await StorageManager.init(root);
    opened.push(reopened);
    expect(new TaskHistoryReader(reopened).list("task")).toEqual(before);
  });
});

describe("TaskHistoryReader 旧抓包兼容", () => {
  it("按下一请求实际投影清除 mixed native 调用，并通过文本匹配恢复反馈", async () => {
    const f = await fixture();
    const mixed = { ...nativeAssistant("c"), content: "mixed" };
    f.capture("mixed", f.initial, mixed, "tool_calls");
    f.capture("repair", [...f.initial, { role: "assistant", content: "mixed" }, { role: "user", content: "repair feedback" }], { role: "assistant", content: "done" });
    const restored = f.reader.messages("task");
    expect(restored.find((item) => item.sourceRef === "request:mixed:response")?.message)
      .toEqual({ role: "assistant", content: "mixed" });
    expect(restored.find((item) => item.sourceRef === "request:mixed:feedback:0")?.message)
      .toEqual({ role: "user", content: "repair feedback" });
    expect(restored.filter((item) => item.message.role === "tool")).toEqual([]);
  });

  it("没有后续请求证据时不擅自移除 mixed native 调用", async () => {
    const f = await fixture();
    f.capture("mixed", f.initial, { ...nativeAssistant("c"), content: "mixed" }, "tool_calls");
    expect(f.reader.messages("task").at(-1)?.message.toolCalls?.[0].id).toBe("c");
  });

  it("length 原生调用无 DB 与下一抓包时也合成整批截断失败结果", async () => {
    const f = await fixture();
    f.capture("length", f.initial, nativeAssistant("a", "b"), "length");
    const expected = buildNativeToolResultMessages(["a", "b"].map((id) => ({ id, name: "read_file", status: "failed" as const,
      errorCode: "truncated_tool_call", errorMessage: zhCN.agent.truncatedToolCall })));
    const restored = f.reader.messages("task");
    expect(restored.filter((item) => item.message.role === "tool").map((item) => item.message)).toEqual(expected);
    expect(restored.slice(-2).map((item) => item.sourceRef)).toEqual(["request:length:truncated-tool:0", "request:length:truncated-tool:1"]);
  });

  it("length 文本工具调用同样合成单个 failed batch，不伪造执行记录", async () => {
    const f = await fixture();
    const calls = ["a", "b"].map((id) => ({ id, name: "read_file", input: {} }));
    f.capture("length-text", f.initial, { role: "assistant", content: JSON.stringify({ type: "tool_calls", calls }) }, "length");
    const expected = buildToolResultMessage(calls.map((call) => ({ id: call.id, name: call.name, status: "failed" as const,
      errorCode: "truncated_tool_call", errorMessage: zhCN.agent.truncatedToolCall })));
    expect(f.reader.messages("task").at(-1)).toMatchObject({ sourceRef: "request:length-text:truncated-tool:0", message: expected });
    expect(f.storage.db.prepare("select count(*) as count from tool_calls").get()).toEqual({ count: 0 });
  });

  it("原生多工具 fallback 使用默认整批预算，不逐条放大", async () => {
    const f = await fixture();
    f.capture("batch", f.initial, nativeAssistant("a", "b"), "tool_calls");
    const records = ["a", "b"].map((id) => ({ id, name: "read_file", status: "completed" as const,
      output: { path: `${id}.txt`, content: id.repeat(10000) } }));
    records.forEach((record, index) => f.tool(`row${index}`, record.id, record.output));
    const restored = f.reader.messages("task").filter((item) => item.message.role === "tool");
    expect(restored.map((item) => item.message)).toEqual(buildNativeToolResultMessages(records));
    expect(restored.reduce((sum, item) => sum + item.message.content.length, 0)).toBeLessThanOrEqual(12000);
    expect(restored.map((item) => item.sourceRef)).toEqual(["tool:row0:result", "tool:row1:result"]);
  });

  it("旧文本工具批次按默认预算重建，保留每个工具的来源身份", async () => {
    const f = await fixture();
    const records = ["a", "b"].map((id) => ({ id, name: "read_file", status: "completed" as const, output: { content: id.repeat(10000) } }));
    f.capture("text", f.initial, { role: "assistant", content: JSON.stringify({ type: "tool_calls",
      calls: records.map(({ id, name }) => ({ id, name, input: {} })) }) });
    records.forEach((record, index) => f.tool(`row${index}`, record.id, record.output));
    expect(f.reader.messages("task").at(-1)).toMatchObject({ sourceRef: "tool:row0,row1:result", message: buildToolResultMessage(records) });
  });

  it("抓包重建 usage 保留 Provider 原始用量并按 wire system/tools 生成作用域", async () => {
    const f = await fixture();
    f.capture("usage", f.initial, { role: "assistant", content: "done" }, "stop",
      { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 20 }, total_tokens: 105 });
    expect(f.reader.messages("task").at(-1)).toMatchObject({ usage: { input: 80, output: 5, cacheRead: 20, cacheWrite: 0, totalTokens: 105 },
      usageScope: wireUsageScope("p", "m", "system", undefined) });
  });
});

describe("TaskHistoryReader", () => {
  it("reconstructs native messages by request/tool identity without duplicating repeated capture context", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-history-"));
    const storage = await StorageManager.init(root);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("s", root, "active", "now");
    const manager = new TurnManager(storage);
    const turn = manager.create("s", "task", "inspect");
    const common = { sessionId: "s", taskId: "task", turnId: turn.id, provider: "p", model: "m", url: "local:test", method: "LOCAL", requestHeaders: {}, responseStatus: 200, responseStatusText: "OK", responseHeaders: {}, durationMs: 1 };
    const captures = new LLMHttpCaptureStore(storage);
    const assistant = { role: "assistant", content: null, tool_calls: [{ id: "call1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] };
    const result = { role: "tool", tool_call_id: "call1", content: "identical" };
    const initial = [{ role: "system", content: "system" }, { role: "user", content: "inspect" }];
    captures.record({ ...common, requestId: "q1", requestBody: { messages: initial }, responseBody: { choices: [{ message: assistant, finish_reason: "tool_calls" }], usage: { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 } } });
    storage.db.prepare("insert into tool_calls (id,session_id,turn_id,intent_id,round,tool_name,input_json,output_json,status,started_at) values (?,?,?,?,?,?,?,?,?,?)").run("toolrow1", "s", turn.id, "call1", 0, "read_file", "{}", '"identical"', "completed", "now");
    captures.record({ ...common, requestId: "q2", requestBody: { messages: [...initial, assistant, result] }, responseBody: { choices: [{ message: { ...assistant, tool_calls: [{ ...assistant.tool_calls[0], id: "call2" }] }, finish_reason: "tool_calls" }] } });
    storage.db.prepare("insert into tool_calls (id,session_id,turn_id,intent_id,round,tool_name,input_json,output_json,status,started_at) values (?,?,?,?,?,?,?,?,?,?)").run("toolrow2", "s", turn.id, "call2", 1, "read_file", "{}", '"identical"', "completed", "now");
    captures.record({ ...common, requestId: "q3", requestBody: { messages: [...initial, assistant, result, { ...assistant, tool_calls: [{ ...assistant.tool_calls[0], id: "call2" }] }, { ...result, tool_call_id: "call2" }] }, responseBody: { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] } });
    const messages = new TaskHistoryReader(storage).messages("task");
    expect(messages.map((x) => x.sourceRef)).toEqual([`turn:${turn.id}:user`, "request:q1:response", "tool:toolrow1:result", "request:q2:response", "tool:toolrow2:result", "request:q3:response"]);
    expect(messages.filter((x) => x.message.role === "tool").map((x) => x.message.content)).toEqual(["identical", "identical"]);
    expect(messages[1].usage?.totalTokens).toBe(100);
    expect(messages[1].message.toolCalls?.[0].input).toEqual({ path: "a" });
    storage.db.close();
  });

  it("keeps tool observations and final answer but excludes compaction captures", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-history-"));
    const storage = await StorageManager.init(root);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", root, "active", "2026-01-01T00:00:00.000Z");
    const turns = new TurnManager(storage);
    const turn = turns.create("ses", "task_a", "电脑配置");
    turns.complete(turn.id);
    const captures = new LLMHttpCaptureStore(storage);
    const common = { sessionId: "ses", taskId: "task_a", turnId: turn.id, provider: "minimax", model: "M3", url: "local:test", method: "LOCAL", requestHeaders: {}, responseStatus: 200, responseStatusText: "OK", responseHeaders: {}, durationMs: 1 };
    captures.record({ ...common, requestId: "req_1", requestBody: { messages: [{ role: "user", content: JSON.stringify({ type: "tool_results", results: [{ output: { arch: "arm64" } }] }) }] }, responseBody: { content: "32GB 内存" } });
    captures.record({ ...common, requestId: "req_1b", requestBody: { messages: [{ role: "user", content: JSON.stringify({ type: "tool_results", results: [{ output: { arch: "arm64" } }] }) }] }, responseBody: { content: "最终结论：32GB 内存" } });
    captures.record({ ...common, requestId: "req_2", purpose: "task_compaction", requestBody: { messages: [] }, responseBody: { content: "这是一段压缩摘要" } });
    const history = new TaskHistoryReader(storage).list("task_a");
    expect(history).toHaveLength(1);
    expect(history[0].content).toContain("arm64");
    expect(history[0].content).toContain("32GB 内存");
    expect(history[0].content.match(/arm64/g)).toHaveLength(1);
    expect(history[0].content).toContain("最终结论");
    expect(history[0].content).not.toContain("这是一段压缩摘要");
    expect(history[0].status).toBe("completed");
    expect(new TaskHistoryReader(storage).list("task_b")).toEqual([]);
    storage.db.close();
  });
});
