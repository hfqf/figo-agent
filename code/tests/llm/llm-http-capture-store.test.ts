import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LLMHttpCaptureStore } from "../../src/llm/llm-http-capture-store.js";
import { OpenAICompatibleProvider } from "../../src/llm/openai-compatible-provider.js";
import { StorageManager } from "../../src/storage/storage-manager.js";

import { TestDatabases } from "../helpers/test-databases.js";

const databases = new TestDatabases();
let workspace = "";

afterEach(async () => {
  databases.close();
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("LLM HTTP capture", () => {
  it("stores full request and response details in sqlite with redacted authorization", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = databases.track(await StorageManager.init(workspace));
    const captureStore = new LLMHttpCaptureStore(storage);
    const provider = new OpenAICompatibleProvider({
      config: {
        id: "minimax",
        enabled: true,
        provider: "openai-compatible",
        apiKey: "test-key",
        baseUrl: "https://example.test/v1",
        model: "MiniMax-M3"
      },
      captureStore,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl_1",
            choices: [{ message: { content: "完成" }, finish_reason: "stop" }]
          }),
          {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json", "x-request-id": "req_1" }
          }
        )
    });

    await provider.complete({
      id: "llm_req_1",
      sessionId: "ses_1",
      taskId: "task_1",
      turnId: "turn_1",
      contextPackId: "ctx_1",
      messages: [
        { role: "system", content: "你是 Figo Agent V1。" },
        { role: "user", content: "理解当前项目" }
      ],
      model: "MiniMax-M3",
      estimatedInputTokens: 42
    });

    const row = storage.db.prepare("select * from llm_http_captures").get() as {
      request_id: string;
      task_id: string;
      provider: string;
      model: string;
      url: string;
      method: string;
      request_headers_json: string;
      request_body_json: string;
      response_status: number;
      response_headers_json: string;
      response_body_json: string;
    };

    expect(row.request_id).toBe("llm_req_1");
    expect(row.task_id).toBe("task_1");
    expect(row.provider).toBe("minimax");
    expect(row.model).toBe("MiniMax-M3");
    expect(row.url).toBe("https://example.test/v1/chat/completions");
    expect(row.method).toBe("POST");
    expect(JSON.parse(row.request_headers_json)).toMatchObject({
      Authorization: "[REDACTED]",
      "Content-Type": "application/json"
    });
    expect(JSON.parse(row.request_body_json)).toMatchObject({
      model: "MiniMax-M3",
      messages: [
        { role: "system", content: "你是 Figo Agent V1。" },
        { role: "user", content: "理解当前项目" }
      ]
    });
    expect(row.response_status).toBe(200);
    expect(JSON.parse(row.response_headers_json)).toMatchObject({
      "content-type": "application/json",
      "x-request-id": "req_1"
    });
    expect(JSON.parse(row.response_body_json)).toMatchObject({
      id: "chatcmpl_1",
      choices: [{ message: { content: "完成" }, finish_reason: "stop" }]
    });
    await provider.complete({
      id: "llm_req_2", sessionId: "ses_1", taskId: "task_1", turnId: "turn_1",
      messages: [{ role: "user", content: "压缩摘要" }], model: "MiniMax-M3", purpose: "task_compaction"
    });
    expect(storage.db.prepare("select purpose from llm_http_captures where request_id = ?").get("llm_req_2")).toMatchObject({ purpose: "task_compaction" });
  });
});
