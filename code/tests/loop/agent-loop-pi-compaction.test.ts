import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../src/contracts/types.js";
import type { CompactionService, CompactInput } from "../../src/context/compaction-service.js";
import { ContextBuilder } from "../../src/context/context-builder.js";
import { AgentLoop } from "../../src/loop/agent-loop.js";
import { SqliteMemoryStore } from "../../src/memory/sqlite-memory-store.js";
import { PluginHost } from "../../src/plugin/plugin-host.js";
import { MarkdownReporter } from "../../src/reporter/markdown-reporter.js";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TraceRecorder } from "../../src/trace/trace-recorder.js";
import { LLMRequestError } from "../../src/llm/llm-request-error.js";

let root = "";
let storage: StorageManager;
afterEach(async () => { if (storage?.db.isOpen) storage.db.close(); if (root) await rm(root, { recursive: true, force: true }); });

async function fixture(outputs: Array<Partial<LLMResponse> | Error>, mode: "native" | "text" = "native") {
  root = await mkdtemp(join(tmpdir(), "figo-pi-loop-"));
  storage = await StorageManager.init(root);
  const trace = new TraceRecorder(storage);
  const requests: LLMRequest[] = [];
  let executed = 0;
  const provider: LLMProvider = { toolCallingMode: mode, complete: async (request) => {
    requests.push(structuredClone({ ...request, signal: undefined }));
    const output = outputs.shift();
    if (!output) throw new Error("unexpected model call");
    if (output instanceof Error) throw output;
    return { id: "res", requestId: request.id, model: request.model, content: "done", finishReason: "stop", outputLength: 4, durationMs: 1, ...output };
  } };
  const host = new PluginHost();
  host.register({ manifest: { id: "builtin", name: "builtin", version: "1", description: "", capabilities: [] }, setup: async () => ({ capabilities: [
    { type: "llmProvider", name: "test", value: provider },
    { type: "contextSource", name: "context-builder", value: new ContextBuilder(storage, new SqliteMemoryStore(storage)) },
    { type: "skill", name: "project-understanding-skill", value: { canHandle: () => false } },
    { type: "reporter", name: "markdown", value: new MarkdownReporter(storage) },
    { type: "tool", name: "registry", value: { listTools: () => [{ name: "read_file", description: "read" }],
      execute: async () => { executed++; return { status: "completed", output: { path: "x", content: "ok" } }; } } }
  ] }) });
  await host.setupAll({});
  const compact = vi.fn(async (input: CompactInput) => input.mode === "recovery"
    ? { status: "completed", coveredTurnIds: [], reason: "ok", messages: input.messages, summaryMarkdown: "checkpoint" }
    : { status: "skipped", coveredTurnIds: [], reason: "below_threshold" });
  const service = { compact, loadConversation: () => ({ messages: [] }), toolSourceRef: (_: string, ids: string[]) => `tool:${ids.join(",")}:result` } as unknown as CompactionService;
  const loop = new AgentLoop(host, trace, { llmId: "test", model: "model", compaction: service,
    resolveModelConfig: () => ({ id: "test", enabled: true, provider: "openai-compatible", apiKey: "", baseUrl: "", model: "model", contextWindow: 128000, maxTokens: 4096 }) });
  return { requests, compact, service, executed: () => executed, run: () => loop.runTurn({ sessionId: "s", taskId: "task", turnId: "turn", input: "inspect", workspaceRoot: root }) };
}

const call = { id: "c", name: "read_file", input: { path: "x" } };
const usage = (output: number) => ({ input: 100, output, cacheRead: 0, cacheWrite: 0, totalTokens: 100 + output });

describe("AgentLoop Pi 安全调度", () => {
  it("仅旧JSON摘要且自动压缩跳过时保留实际使用的旧检查点引用", async () => {
    const f = await fixture([{ content: "done" }]);
    f.service.loadConversation = () => ({ messages: [], previousSummary: "旧JSON摘要", legacyCheckpointId: "legacy-checkpoint" });
    expect((await f.run()).status).toBe("completed");
    const row = storage.db.prepare("select payload_json from trace_events where type = 'llm.called'").get() as { payload_json: string };
    expect(JSON.parse(row.payload_json).projection).toMatchObject({ compactionEntryId: null, legacyCheckpointId: "legacy-checkpoint" });
    expect(f.requests[0].messages).toContainEqual({ role: "user", content: "旧JSON摘要" });
    expect(f.requests).toHaveLength(1);
  });
  it("按每次请求保存有序消息来源，工具往返不改变先前投影", async () => {
    const f = await fixture([{ content: "过程说明", finishReason: "tool_calls", toolCalls: [call] }, { content: "done" }]);
    expect((await f.run()).status).toBe("completed");
    const events = storage.db.prepare("select payload_json from trace_events where type = 'llm.called' order by rowid").all() as Array<{ payload_json: string }>;
    const projections = events.map((event) => JSON.parse(event.payload_json));
    expect(projections[0]).toMatchObject({ requestId: f.requests[0].id, projection: {
      compactionEntryId: null, sourceRefs: ["turn:turn:user"], usageScope: expect.any(String)
    } });
    expect(projections[1].projection.sourceRefs).toEqual([
      "turn:turn:user", `request:${f.requests[0].id}:response`, expect.stringMatching(/^tool:/)
    ]);
    expect(JSON.stringify(projections)).not.toContain("过程说明");
  });
  it("同Turn滚动摘要后请求保留当时条目引用和实际摘要正文", async () => {
    const f = await fixture([{ content: "过程说明", finishReason: "tool_calls", toolCalls: [call] }, { content: "done" }]);
    let seq = 0;
    f.compact.mockImplementation(async input => ({ status: "completed", coveredTurnIds: [], reason: "ok",
      checkpointId: `entry-${++seq}`, messages: input.messages, summaryMarkdown: `摘要版本${seq}` }));
    expect((await f.run()).status).toBe("completed");
    const rows = storage.db.prepare("select payload_json from trace_events where type = 'llm.called' order by rowid").all() as Array<{ payload_json: string }>;
    expect(rows.map(row => JSON.parse(row.payload_json).projection.compactionEntryId)).toEqual(["entry-1", "entry-2"]);
    expect(f.requests[0].messages).toContainEqual({ role: "user", content: "摘要版本1" });
    expect(f.requests[1].messages).toContainEqual({ role: "user", content: "摘要版本2" });
    expect(f.executed()).toBe(1);
  });
  it("恢复后的请求关联失败请求和成功摘要条目，保留原始失败事件", async () => {
    const f = await fixture([new LLMRequestError(400, { code: "context_length_exceeded" }), { content: "recovered" }]);
    f.compact.mockImplementation(async (input: CompactInput) => input.mode === "recovery"
      ? { status: "completed", checkpointId: "compact_recovery", coveredTurnIds: [], reason: "ok", messages: input.messages, summaryMarkdown: "checkpoint" }
      : { status: "skipped", coveredTurnIds: [], reason: "below_threshold" });
    expect((await f.run()).status).toBe("completed");
    const rows = storage.db.prepare("select type, payload_json from trace_events where type in ('llm.called', 'llm.failed') order by rowid").all() as Array<{ type: string; payload_json: string }>;
    const called = rows.filter((row) => row.type === "llm.called").map((row) => JSON.parse(row.payload_json));
    expect(called[1]).toMatchObject({ recoveryOfRequestId: f.requests[0].id, projection: { compactionEntryId: "compact_recovery" } });
    expect(rows.some((row) => row.type === "llm.failed" && JSON.parse(row.payload_json).requestId === f.requests[0].id)).toBe(true);
    expect(f.requests).toHaveLength(2);
  });
  it("先检查历史，工具结果后检查，最终回答后不再压缩", async () => {
    const f = await fixture([{ content: "", finishReason: "tool_calls", toolCalls: [call] }, { content: "done" }]);
    expect((await f.run()).status).toBe("completed");
    expect(f.compact).toHaveBeenCalledTimes(2);
    expect(f.compact.mock.calls[0][0].messages).toEqual([]);
    expect(f.compact.mock.calls[1][0].messages?.at(-1)?.message).toMatchObject({ role: "tool", toolCallId: "c" });
    expect(f.executed()).toBe(1);
  });
  it("明确超限压缩后重试，不重放已成功的工具", async () => {
    const f = await fixture([{ content: "", finishReason: "tool_calls", toolCalls: [call] }, new LLMRequestError(400, { error: { code: "context_length_exceeded" } }), { content: "recovered" }]);
    expect((await f.run()).message).toBe("recovered");
    expect(f.executed()).toBe(1);
    expect(f.requests).toHaveLength(3);
    expect(f.compact.mock.calls.filter(([input]) => input.mode === "recovery")).toHaveLength(1);
    expect(f.requests[2].messages.some((message) => message.toolCallId === "c")).toBe(true);
  });
  it("连续第二次超限可见失败，不无限重试", async () => {
    const overflow = new LLMRequestError(400, { code: "context_length_exceeded" });
    const f = await fixture([overflow, overflow]);
    const result = await f.run();
    expect(result.status).toBe("failed");
    expect(result.message).toContain("一次压缩恢复");
    expect(f.requests).toHaveLength(2);
  });
  it.each([401, 429, 500])("普通 %i 错误不执行压缩恢复", async (status) => {
    const f = await fixture([new LLMRequestError(status, { error: { message: "generic failure" } })]);
    expect((await f.run()).status).toBe("failed");
    expect(f.compact.mock.calls.some(([input]) => input.mode === "recovery")).toBe(false);
    expect(f.requests).toHaveLength(1);
  });
  it("低于预期输出上限的最终 length 响应仅恢复一次，失败尝试不进入投影", async () => {
    const f = await fixture([{ content: "partial", finishReason: "length", usage: usage(10) }, { content: "complete" }]);
    expect((await f.run()).message).toBe("complete");
    expect(f.requests[1].messages.some((message) => message.content === "partial")).toBe(false);
    expect(f.compact.mock.calls.find(([input]) => input.mode === "recovery")?.[0].omittedSourceRefs).toEqual([`request:${f.requests[0].id}:response`]);
  });
  it.each([4096, undefined])("正常输出上限或未知 usage (%s) 不作为上下文失败", async (output) => {
    const f = await fixture([{ content: "partial", finishReason: "length", usage: output === undefined ? undefined : usage(output) }]);
    expect((await f.run()).message).toBe("partial");
    expect(f.requests).toHaveLength(1);
    expect(f.compact.mock.calls.some(([input]) => input.mode === "recovery")).toBe(false);
  });
  it("length 携带工具调用时补失败结果，不执行截断工具", async () => {
    const f = await fixture([{ content: "", finishReason: "length", toolCalls: [call], usage: usage(5) }, { content: "complete" }]);
    expect((await f.run()).message).toBe("complete");
    expect(f.executed()).toBe(0);
    expect(f.requests[1].messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "c" });
    expect(f.requests[1].messages.at(-1)?.content).toContain("truncated_tool_call");
  });
  it("文本协议 length 同样不执行 write_file，只补失败结果后继续", async () => {
    const f = await fixture([{ content: JSON.stringify({ type: "tool_calls", calls: [{ id: "w", name: "write_file", input: { path: "x", content: "unsafe" } }] }), finishReason: "length" }, { content: "complete" }], "text");
    expect((await f.run()).message).toBe("complete");
    expect(f.executed()).toBe(0);
    expect(f.requests[1].messages.at(-1)?.content).toContain("truncated_tool_call");
  });
});
