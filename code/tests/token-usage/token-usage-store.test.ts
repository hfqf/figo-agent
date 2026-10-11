import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LLMHttpCaptureStore } from "../../src/llm/llm-http-capture-store.js";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TokenUsageStore } from "../../src/token-usage/token-usage-store.js";

let workspace = "";

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = "";
});

function capture(store: LLMHttpCaptureStore, requestId: string, responseBody: unknown, purpose: "turn" | "task_compaction" = "turn"): void {
  store.record({
    sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", requestId,
    purpose, provider: "gpt-relay", model: "gpt-test", url: "https://example.test/v1/chat/completions",
    method: "POST", requestHeaders: { Authorization: "Bearer test-secret" }, requestBody: { messages: [] },
    responseStatus: 200, responseStatusText: "OK", responseHeaders: {}, responseBody, durationMs: 10
  });
}

describe("TokenUsageStore", () => {
  it("persists provider usage per request and reports unknown calls separately", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-token-"));
    const storage = await StorageManager.init(workspace);
    const captures = new LLMHttpCaptureStore(storage);
    capture(captures, "req_1", { usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } });
    capture(captures, "req_2", { choices: [] }, "task_compaction");
    capture(captures, "req_3", { usage: { prompt_tokens: 5 } });

    const rows = storage.db.prepare("select request_id, prompt_tokens, completion_tokens, total_tokens, status, purpose from token_usage order by request_id").all();
    expect(rows).toEqual([
      { request_id: "req_1", prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, status: "complete", purpose: "turn" },
      { request_id: "req_2", prompt_tokens: null, completion_tokens: null, total_tokens: null, status: "unavailable", purpose: "task_compaction" },
      { request_id: "req_3", prompt_tokens: 5, completion_tokens: null, total_tokens: null, status: "partial", purpose: "turn" }
    ]);
    expect(new TokenUsageStore(storage).summarizeTask("task_1")).toMatchObject({
      requestCount: 3, completeCount: 1, partialCount: 1, unavailableCount: 1,
      knownPromptTokens: 17, knownCompletionTokens: 7, knownTotalTokens: 19
    });
    storage.db.close();
  });

  it("backfills old captures once on restart without changing the raw response", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-token-"));
    const storage = await StorageManager.init(workspace);
    const captures = new LLMHttpCaptureStore(storage);
    capture(captures, "req_old", { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } });
    storage.db.exec("delete from token_usage");
    storage.db.close();

    const reopened = await StorageManager.init(workspace);
    expect(reopened.db.prepare("select prompt_tokens, completion_tokens, total_tokens from token_usage where request_id = ?").get("req_old"))
      .toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
    expect(reopened.db.prepare("select response_body_json from llm_http_captures where request_id = ?").get("req_old"))
      .toMatchObject({ response_body_json: '{"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}' });
    reopened.db.close();

    const again = await StorageManager.init(workspace);
    expect(again.db.prepare("select count(*) as count from token_usage where request_id = ?").get("req_old"))
      .toEqual({ count: 1 });
    again.db.close();
  });

  it("keeps zero as an actual value, rejects malformed counts, and isolates task and session totals", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-token-"));
    const storage = await StorageManager.init(workspace);
    const captures = new LLMHttpCaptureStore(storage);
    capture(captures, "req_zero", { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    capture(captures, "req_bad", { usage: { prompt_tokens: -1, completion_tokens: 1.5, total_tokens: "9" } });
    captures.record({
      sessionId: "ses_2", taskId: "task_2", turnId: "turn_2", requestId: "req_other", purpose: "round_compaction",
      provider: "minimax", model: "MiniMax-M3", url: "https://example.test", method: "POST",
      requestHeaders: {}, requestBody: {}, responseStatus: 200, responseStatusText: "OK",
      responseHeaders: {}, responseBody: { usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } }, durationMs: 1
    });
    const usage = new TokenUsageStore(storage);
    expect(usage.summarizeTask("task_1")).toMatchObject({ requestCount: 2, completeCount: 1, unavailableCount: 1, knownTotalTokens: 0, totalReportedCount: 1 });
    expect(usage.summarizeSession("ses_1")).toMatchObject({ requestCount: 2, knownTotalTokens: 0 });
    expect(usage.summarizeTask("task_2")).toMatchObject({ requestCount: 1, knownPromptTokens: 8, knownCompletionTokens: 3, knownTotalTokens: 11 });
    expect(usage.summarizeTurn("turn_2")).toMatchObject({ requestCount: 1 });
    storage.db.close();
  });

  it("rolls back a duplicate new request instead of leaving an unmatched capture", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-token-"));
    const storage = await StorageManager.init(workspace);
    const captures = new LLMHttpCaptureStore(storage);
    capture(captures, "req_duplicate", { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    expect(() => capture(captures, "req_duplicate", { usage: { prompt_tokens: 8, completion_tokens: 9, total_tokens: 17 } }))
      .toThrow();
    expect(storage.db.prepare("select count(*) as count from llm_http_captures where request_id = ?").get("req_duplicate"))
      .toEqual({ count: 1 });
    expect(storage.db.prepare("select prompt_tokens from token_usage where request_id = ?").get("req_duplicate"))
      .toEqual({ prompt_tokens: 1 });
    storage.db.close();
  });

  it("adds usage turn attribution to an older token_usage table without guessing task compaction", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-token-"));
    const storage = await StorageManager.init(workspace);
    const captures = new LLMHttpCaptureStore(storage);
    capture(captures, "req_turn", { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    capture(captures, "req_compact", { usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }, "task_compaction");
    storage.db.exec("drop index idx_token_usage_turn_created");
    storage.db.exec("alter table token_usage drop column usage_turn_id");
    storage.db.close();

    const reopened = await StorageManager.init(workspace);
    expect(reopened.db.prepare("select usage_turn_id from token_usage where request_id = ?").get("req_turn"))
      .toEqual({ usage_turn_id: "turn_1" });
    expect(reopened.db.prepare("select usage_turn_id from token_usage where request_id = ?").get("req_compact"))
      .toEqual({ usage_turn_id: null });
    reopened.db.close();
  });

  it("backfills more than one batch of legacy captures", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-token-"));
    const storage = await StorageManager.init(workspace);
    const captures = new LLMHttpCaptureStore(storage);
    for (let index = 0; index < 205; index++) {
      capture(captures, `req_batch_${index}`, { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    storage.db.exec("delete from token_usage");
    storage.db.close();

    const reopened = await StorageManager.init(workspace);
    expect(reopened.db.prepare("select count(*) as count, sum(total_tokens) as total from token_usage").get())
      .toEqual({ count: 205, total: 410 });
    reopened.db.close();
  });
});
