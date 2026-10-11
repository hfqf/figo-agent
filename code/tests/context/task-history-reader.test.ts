import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskHistoryReader } from "../../src/context/task-history-reader.js";
import { TurnManager } from "../../src/kernel/turn-manager.js";
import { LLMHttpCaptureStore } from "../../src/llm/llm-http-capture-store.js";
import { StorageManager } from "../../src/storage/storage-manager.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

describe("TaskHistoryReader", () => {
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
