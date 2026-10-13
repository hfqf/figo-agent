import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "../../src/llm/openai-compatible-provider.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMHttpCaptureStore } from "../../src/llm/llm-http-capture-store.js";
import { StorageManager } from "../../src/storage/storage-manager.js";

describe("OpenAICompatibleProvider", () => {
  it("sends native tools and reassembles streamed function call arguments", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAICompatibleProvider({
      config: { id: "relay", enabled: true, provider: "openai-compatible", apiKey: "test-key",
        baseUrl: "https://example.test/v1", model: "gpt-test", toolCallingMode: "native" },
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const wire = [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n'
        ].join("");
        return new Response(wire, { headers: { "content-type": "text/event-stream" } });
      }
    });
    const result = await provider.complete({ id: "req_1", sessionId: "ses", taskId: "task", turnId: "turn",
      model: "gpt-test", messages: [{ role: "user", content: "read" }],
      availableTools: [{ name: "read_file", description: "读取文件", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }]
    }, () => {});
    expect(bodies[0]).toMatchObject({ tool_choice: "auto", stream: true,
      tools: [{ type: "function", function: { name: "read_file", parameters: { required: ["path"] } } }] });
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "read_file", input: { path: "README.md" } }]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("sends assistant tool calls and matching tool results on the following request", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAICompatibleProvider({
      config: { id: "relay", enabled: true, provider: "openai-compatible", apiKey: "test-key",
        baseUrl: "https://example.test/v1", model: "gpt-test", toolCallingMode: "native" },
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "分析完成" }, finish_reason: "stop" }] }),
          { headers: { "content-type": "application/json" } });
      }
    });
    await provider.complete({ id: "req_2", sessionId: "ses", taskId: "task", turnId: "turn", model: "gpt-test",
      messages: [
        { role: "user", content: "分析" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", input: { path: "README.md" } }] },
        { role: "tool", toolCallId: "call_1", content: '{"status":"completed"}' }
      ], availableTools: [{ name: "read_file", description: "读取文件" }]
    });
    expect(body?.messages).toMatchObject([
      { role: "user", content: "分析" },
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: '{"status":"completed"}' }
    ]);
  });
  it("uses JSON runtime config and returns local placeholder when api key is absent", async () => {
    const provider = new OpenAICompatibleProvider({
      config: {
        id: "minimax",
        enabled: true,
        provider: "openai-compatible",
        apiKey: "",
        baseUrl: "https://json.example/v1",
        model: "MiniMax-M3"
      },
      fetchImpl: async () => {
        throw new Error("fetch must not be called without api key");
      }
    });

    expect(provider.config.baseUrl).toBe("https://json.example/v1");
    expect(provider.config.model).toBe("MiniMax-M3");

    const response = await provider.complete({
        id: "llm_req_1",
        sessionId: "ses_1",
        taskId: "task_1",
        turnId: "turn_1",
        contextPackId: "ctx_1",
        messages: [{ role: "user", content: "理解当前项目" }],
        model: provider.config.model,
        estimatedInputTokens: 100
      });
    expect(response).toMatchObject({
      requestId: "llm_req_1",
      model: "MiniMax-M3",
      finishReason: "stop"
    });
    expect(response.content).toContain("当前模型 minimax 未配置 apiKey");
  });

  it("calls OpenAI-compatible chat completions when api key is present", async () => {
    const provider = new OpenAICompatibleProvider({
      config: {
        id: "minimax",
        enabled: true,
        provider: "openai-compatible",
        apiKey: "test-key",
        baseUrl: "https://example.test/v1",
        model: "MiniMax-M3"
      },
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://example.test/v1/chat/completions");
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "完成" }, finish_reason: "stop" }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });

    const response = await provider.complete({
      id: "llm_req_2",
      sessionId: "ses_1",
      taskId: "task_1",
      turnId: "turn_1",
      contextPackId: "ctx_1",
      messages: [{ role: "user", content: "hi" }],
      model: provider.config.model
    });

    expect(response.content).toBe("完成");
    expect(response.outputLength).toBe(2);
  });

  it("records usage returned by the selected provider without estimating missing fields", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "figo-provider-"));
    try {
      const storage = await StorageManager.init(workspace);
      const provider = new OpenAICompatibleProvider({
        config: { id: "gpt-relay", enabled: true, provider: "openai-compatible", apiKey: "test-key", baseUrl: "https://example.test/v1", model: "gpt-test" },
        captureStore: new LLMHttpCaptureStore(storage),
        fetchImpl: async () => new Response(JSON.stringify({
          choices: [{ message: { content: "完成" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 }
        }), { status: 200 })
      });
      await provider.complete({ id: "req_usage", sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
      expect(storage.db.prepare("select prompt_tokens, completion_tokens, total_tokens, status from token_usage where request_id = ?").get("req_usage"))
        .toEqual({ prompt_tokens: 21, completion_tokens: 9, total_tokens: 30, status: "complete" });
      storage.db.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reassembles fragmented SSE text and records the full wire response", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "figo-provider-stream-"));
    try {
      const storage = await StorageManager.init(workspace);
      const parts = [
        'data: {"choices":[{"delta":{"content":"FINAL\\n你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
        'data: [DONE]\n\n'
      ];
      const wire = parts.join("");
      const bytes = new TextEncoder().encode(wire);
      const provider = new OpenAICompatibleProvider({
        config: { id: "test", enabled: true, provider: "openai-compatible", apiKey: "secret", baseUrl: "https://example.test/v1", model: "test" },
        captureStore: new LLMHttpCaptureStore(storage),
        fetchImpl: async (_url, init) => {
          expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true });
          let offset = 0;
          return new Response(new ReadableStream({
            pull(controller) {
              if (offset >= bytes.length) return controller.close();
              controller.enqueue(bytes.slice(offset, offset + 7));
              offset += 7;
            }
          }), { headers: { "content-type": "text/event-stream" } });
        }
      });
      const deltas: string[] = [];
      const response = await provider.complete({ id: "stream-1", sessionId: "ses", taskId: "task", turnId: "turn", model: "test", messages: [{ role: "user", content: "hi" }] }, (delta) => deltas.push(delta));
      expect(response.content).toBe("FINAL\n你好");
      expect(deltas).toEqual(["FINAL\n你", "好"]);
      const capture = storage.db.prepare("select response_body_json from llm_http_captures where request_id = ?").get("stream-1") as { response_body_json: string };
      expect(JSON.parse(capture.response_body_json).wire).toBe(wire);
      expect(storage.db.prepare("select total_tokens from token_usage where request_id = ?").get("stream-1")).toEqual({ total_tokens: 5 });
      storage.db.close();
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it("captures partial wire data when the stream ends without DONE", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "figo-provider-interrupted-"));
    try {
      const storage = await StorageManager.init(workspace);
      const wire = 'data: {"choices":[{"delta":{"content":"FINAL\\n部分"}}]}\n\n';
      const provider = new OpenAICompatibleProvider({
        config: { id: "test", enabled: true, provider: "openai-compatible", apiKey: "secret", baseUrl: "https://example.test/v1", model: "test" },
        captureStore: new LLMHttpCaptureStore(storage),
        fetchImpl: async () => new Response(wire, { headers: { "content-type": "text/event-stream" } })
      });
      const deltas: string[] = [];
      await expect(provider.complete({ id: "interrupted-1", sessionId: "ses", taskId: "task", turnId: "turn", model: "test", messages: [] }, (delta) => deltas.push(delta)))
        .rejects.toThrow("before [DONE]");
      expect(deltas.join("")).toBe("FINAL\n部分");
      const row = storage.db.prepare("select response_body_json from llm_http_captures where request_id = ?").get("interrupted-1") as { response_body_json: string };
      expect(JSON.parse(row.response_body_json)).toMatchObject({ wire, interrupted: true });
      storage.db.close();
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it("accepts a clean SSE end after a terminal finish reason even without DONE", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "figo-provider-finished-"));
    try {
      const storage = await StorageManager.init(workspace);
      const wire = [
        'data: {"choices":[{"delta":{"content":"FINAL\\n完成"},"finish_reason":""}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n'
      ].join("");
      const provider = new OpenAICompatibleProvider({
        config: { id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "secret", baseUrl: "https://example.test/v1", model: "MiniMax-M3" },
        captureStore: new LLMHttpCaptureStore(storage),
        fetchImpl: async () => new Response(wire, { headers: { "content-type": "text/event-stream" } })
      });
      const deltas: string[] = [];
      const result = await provider.complete({ id: "finished-1", sessionId: "ses", taskId: "task", turnId: "turn", model: "MiniMax-M3", messages: [] }, (delta) => deltas.push(delta));
      expect(result).toMatchObject({ content: "FINAL\n完成", finishReason: "stop" });
      expect(deltas).toEqual(["FINAL\n完成"]);
      expect(storage.db.prepare("select total_tokens from token_usage where request_id = ?").get("finished-1")).toEqual({ total_tokens: 5 });
      storage.db.close();
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
});
