import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../src/contracts/types.js";
import type { RuntimeLlmConfig } from "../../src/config/runtime-config.js";
import type { CompactInput, CompactionModel, CompactionService } from "../../src/context/compaction-service.js";
import { ContextBuilder } from "../../src/context/context-builder.js";
import { AgentLoop } from "../../src/loop/agent-loop.js";
import { LLMRequestError } from "../../src/llm/llm-request-error.js";
import { SqliteMemoryStore } from "../../src/memory/sqlite-memory-store.js";
import { PluginHost } from "../../src/plugin/plugin-host.js";
import { MarkdownReporter } from "../../src/reporter/markdown-reporter.js";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TraceRecorder } from "../../src/trace/trace-recorder.js";

let root = "";
let storage: StorageManager;
afterEach(async () => { if (storage?.db.isOpen) storage.db.close(); if (root) await rm(root, { recursive: true, force: true }); });

async function fixture(complete: LLMProvider["complete"]) {
  root = await mkdtemp(join(tmpdir(), "figo-stream-reset-"));
  storage = await StorageManager.init(root);
  const host = new PluginHost();
  const execute = vi.fn(async () => ({ status: "completed" as const, output: { path: "x", content: "ok" } }));
  host.register({ manifest: { id: "builtin", name: "builtin", version: "1", description: "", capabilities: [] },
    setup: async () => ({ capabilities: [
      { type: "llmProvider", name: "test", value: { toolCallingMode: "native", complete } },
      { type: "contextSource", name: "context-builder", value: new ContextBuilder(storage, new SqliteMemoryStore(storage)) },
      { type: "skill", name: "project-understanding-skill", value: { canHandle: () => false } },
      { type: "reporter", name: "markdown", value: new MarkdownReporter(storage) },
      { type: "tool", name: "registry", value: { listTools: () => [{ name: "read_file", description: "read" }], execute } }
    ] }) });
  await host.setupAll({});
  const compact = vi.fn(async (input: CompactInput, _model?: CompactionModel) => input.mode === "recovery"
    ? { status: "completed", coveredTurnIds: [], reason: "ok", messages: input.messages, summaryMarkdown: "checkpoint" }
    : { status: "skipped", coveredTurnIds: [], reason: "below_threshold" });
  const service = { compact, loadConversation: () => ({ messages: [] }), toolSourceRef: () => "tool:c:result" } as unknown as CompactionService;
  const config: RuntimeLlmConfig = { id: "test", enabled: true, provider: "openai-compatible", apiKey: "", baseUrl: "", model: "model",
    contextWindow: 128000, maxTokens: 4096, maxTokensField: "max_completion_tokens" };
  const loop = new AgentLoop(host, new TraceRecorder(storage), { llmId: "test", model: "model", compaction: service,
    resolveModelConfig: () => config });
  return { execute, compact, config, run: (delta?: (text: string) => void, reset?: () => void, signal?: AbortSignal) =>
    loop.runTurn({ sessionId: "s", taskId: "t", turnId: "turn", input: "inspect", workspaceRoot: root, signal }, delta, reset) };
}

function response(request: LLMRequest, content = "新答案", extra: Partial<LLMResponse> = {}): LLMResponse {
  return { id: "res", requestId: request.id, model: request.model, content, finishReason: "stop", outputLength: content.length, durationMs: 1, ...extra };
}

const call = { id: "c", name: "read_file", input: { path: "x" } };

describe("AgentLoop attempt stream", () => {
  it("passes native tool definitions into the compaction estimate", async () => {
    const f = await fixture(async (request) => response(request));
    expect((await f.run()).status).toBe("completed");
    expect(f.compact.mock.calls[0][0].availableTools).toEqual([{ name: "read_file", description: "read" }]);
  });

  it.each(["length", "overflow"])("replaces discarded %s text while preserving live streaming", async (failure) => {
    let visible = "";
    let calls = 0;
    const reset = vi.fn(() => { visible = ""; });
    const f = await fixture(async (request, emit) => {
      calls++;
      if (calls === 1) {
        emit?.("旧答案");
        expect(visible).toBe("旧答案");
        if (failure === "overflow") throw new LLMRequestError(400, { code: "context_length_exceeded" });
        return response(request, "旧答案", { finishReason: "length", usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 105 } });
      }
      expect(visible).toBe("");
      emit?.("新"); emit?.("答案");
      expect(visible).toBe("新答案");
      return response(request);
    });
    expect((await f.run((text) => { visible += text; }, reset)).message).toBe("新答案");
    expect(visible).toBe("新答案");
    expect(reset).toHaveBeenCalledOnce();
    expect(calls).toBe(2);
  });

  it("buffers attempts for legacy consumers and emits the final answer only once", async () => {
    const chunks: string[] = [];
    let calls = 0;
    const f = await fixture(async (request, emit) => {
      calls++;
      emit?.(calls === 1 ? "旧答案" : "新答案");
      expect(chunks).toEqual([]);
      return response(request, calls === 1 ? "旧答案" : "新答案", calls === 1
        ? { finishReason: "length", usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 105 } } : {});
    });
    expect((await f.run((text) => chunks.push(text))).message).toBe("新答案");
    expect(chunks).toEqual(["新答案"]);
  });

  it.each(["repair", "tool", "truncated tool"])("clears non-final %s text before retrying or executing tools", async (kind) => {
    let visible = "";
    let calls = 0;
    const reset = vi.fn(() => { visible = ""; });
    const f = await fixture(async (request, emit) => {
      calls++;
      if (calls === 1) {
        emit?.("废弃文本");
        return kind === "repair"
          ? response(request, '<tool_calls><invoke name="read_file"></invoke></tool_calls>')
          : response(request, kind === "truncated tool" ? "尚未完成的过程说明" : "",
            { toolCalls: [call], finishReason: kind === "truncated tool" ? "length" : "tool_calls" });
      }
      expect(visible).toBe("");
      emit?.("新答案");
      return response(request);
    });
    f.execute.mockImplementation(async () => {
      expect(visible).toBe("");
      return { status: "completed", output: { path: "x", content: "ok" } };
    });
    expect((await f.run((text) => { visible += text; }, reset)).status).toBe("completed");
    expect(visible).toBe("新答案");
    expect(reset).toHaveBeenCalledOnce();
    expect(f.execute).toHaveBeenCalledTimes(kind === "tool" ? 1 : 0);
  });

  it.each([false, true])("keeps native explanatory text non-final with reset=%s and executes once", async (withReset) => {
    const requests: LLMRequest[] = [];
    const chunks: string[] = [];
    let visible = "";
    const reset = vi.fn(() => { visible = ""; });
    const explanation = "我先读取目标文件，再根据真实结果回答。";
    const f = await fixture(async (request, emit) => {
      requests.push(structuredClone({ ...request, signal: undefined }));
      if (requests.length === 1) {
        emit?.(explanation.slice(0, 6));
        emit?.(explanation.slice(6));
        if (!withReset) expect(chunks).toEqual([]);
        return response(request, explanation, { finishReason: "tool_calls", toolCalls: [call] });
      }
      expect(visible).toBe("");
      emit?.("最终");
      emit?.("答案");
      return response(request, "最终答案");
    });
    f.execute.mockImplementation(async () => {
      expect(visible).toBe("");
      return { status: "completed", output: { path: "x", content: "ok" } };
    });
    const result = await f.run((text) => { chunks.push(text); visible += text; }, withReset ? reset : undefined);
    expect(result.status).toBe("completed");
    expect(result.message).toBe("最终答案");
    expect(visible).toBe("最终答案");
    expect(f.execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.slice(-2)).toMatchObject([
      { role: "assistant", content: explanation, toolCalls: [call] }, { role: "tool", toolCallId: call.id }
    ]);
    expect(reset).toHaveBeenCalledTimes(withReset ? 1 : 0);
    expect(chunks.join("")).toBe(withReset ? explanation + "最终答案" : "最终答案");
    expect(storage.db.prepare("select count(*) count from trace_events where type = 'tool_call.repair.requested'").get())
      .toEqual({ count: 0 });
  });

  it("does not emit buffered text after cancellation", async () => {
    const controller = new AbortController();
    const chunks: string[] = [];
    const f = await fixture(async (request, emit) => {
      emit?.("取消前的内容");
      controller.abort();
      return response(request, "取消前的内容");
    });
    expect((await f.run((text) => chunks.push(text), undefined, controller.signal)).status).toBe("failed");
    expect(chunks).toEqual([]);
  });

  it("clears visible text on nonrecoverable errors", async () => {
    let visible = "";
    const reset = vi.fn(() => { visible = ""; });
    const f = await fixture(async (_request, emit) => { emit?.("失败前的内容"); throw new Error("network failed"); });
    expect((await f.run((text) => { visible += text; }, reset)).status).toBe("failed");
    expect(visible).toBe("");
    expect(reset).toHaveBeenCalledOnce();
  });

  it("resets a live consumer when the attempt is cancelled after streaming", async () => {
    const controller = new AbortController();
    let visible = "";
    const reset = vi.fn(() => { visible = ""; });
    const f = await fixture(async (request, emit) => {
      emit?.("取消前的内容");
      expect(visible).toBe("取消前的内容");
      controller.abort();
      return response(request, "取消前的内容");
    });
    expect((await f.run((text) => { visible += text; }, reset, controller.signal)).status).toBe("failed");
    expect(visible).toBe("");
    expect(reset).toHaveBeenCalledOnce();
  });

  it("does not emit buffered text when a legacy attempt fails", async () => {
    const chunks: string[] = [];
    const f = await fixture(async (_request, emit) => { emit?.("失败前的内容"); throw new Error("network failed"); });
    expect((await f.run((text) => chunks.push(text))).status).toBe("failed");
    expect(chunks).toEqual([]);
  });

  it("snapshots selected capacity metadata before the runtime config is changed", async () => {
    let calls = 0;
    const f = await fixture(async (request) => {
      if (++calls === 1) {
        delete f.config.contextWindow;
        delete f.config.maxTokens;
        delete f.config.maxTokensField;
        return response(request, "", { finishReason: "tool_calls", toolCalls: [call] });
      }
      return response(request);
    });
    expect((await f.run()).status).toBe("completed");
    expect(f.compact.mock.calls).toHaveLength(2);
    expect(f.compact.mock.calls[1][1]).toMatchObject({ contextWindow: 128000, maxTokens: 4096, maxTokensField: "max_completion_tokens" });
  });
});
