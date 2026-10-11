import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextPack } from "../../src/contracts/types.js";
import { MarkdownReporter } from "../../src/reporter/markdown-reporter.js";
import { LLMHttpCaptureStore } from "../../src/llm/llm-http-capture-store.js";
import { StorageManager } from "../../src/storage/storage-manager.js";

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("MarkdownReporter", () => {
  it("writes Chinese context.md and report.md with artifact metadata", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);
    storage.db
      .prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)")
      .run("ses_1", workspace, "active", "2026-10-10T00:00:00.000Z");
    const pack: ContextPack = {
      id: "ctx_1",
      sessionId: "ses_1",
      taskId: "task_1",
      turnId: "turn_1",
      estimatedTokens: 10,
      createdAt: "2026-10-10T00:00:00.000Z",
      items: [
        {
          id: "ctx_item_1",
          sourceType: "file",
          sourceRef: "readme.md",
          summary: "项目说明",
          content: "内容",
          estimatedTokens: 2,
          included: true,
          reason: "测试夹具纳入"
        }
      ]
    };

    const reporter = new MarkdownReporter(storage);
    new LLMHttpCaptureStore(storage).record({
      sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", requestId: "req_1", purpose: "turn",
      provider: "gpt-relay", model: "gpt-test", url: "https://example.test", method: "POST",
      requestHeaders: {}, requestBody: {}, responseStatus: 200, responseStatusText: "OK",
      responseHeaders: {}, responseBody: { usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }, durationMs: 1
    });
    const artifacts = await reporter.writeTurnArtifacts({
      sessionId: "ses_1",
      taskId: "task_1",
      turnId: "turn_1",
      input: "理解当前项目",
      contextPack: pack,
      summary: "执行摘要"
    });

    expect(artifacts).toHaveLength(2);
    const contextMd = await readFile(
      join(workspace, ".figo-agent/artifacts/sessions/ses_1/tasks/task_1/turn_1/context.md"),
      "utf8"
    );
    const reportMd = await readFile(
      join(workspace, ".figo-agent/artifacts/sessions/ses_1/tasks/task_1/turn_1/report.md"),
      "utf8"
    );
    expect(contextMd).toContain("ContextPack：ctx_1");
    expect(contextMd).toContain("readme.md");
    expect(reportMd).toContain("用户输入：理解当前项目");
    expect(reportMd).toContain("执行摘要");
    expect(reportMd).toContain("实际输入 Token：12");
    expect(reportMd).toContain("实际输出 Token：4");
    expect(reportMd).toContain("ContextPack 估算 Token：10");
    expect(storage.db.prepare("select count(*) as count from artifacts").get()).toMatchObject({
      count: 2
    });
  });
});
