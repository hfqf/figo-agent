import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "../../src/llm/openai-compatible-provider.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMHttpCaptureStore } from "../../src/llm/llm-http-capture-store.js";
import { StorageManager } from "../../src/storage/storage-manager.js";

describe("OpenAICompatibleProvider", () => {
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
});
