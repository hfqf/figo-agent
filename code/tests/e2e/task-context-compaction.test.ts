import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentKernel } from "../../src/kernel/agent-kernel.js";

import { TestDatabases } from "../helpers/test-databases.js";

const databases = new TestDatabases();
let root = "";
afterEach(async () => {
  databases.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("Task context compaction e2e", () => {
  it("persists a Markdown entry with capture ownership and projects it only into its Task", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-compact-e2e-"));
    await writeFile(join(root, "figo-agent.config.json"), JSON.stringify({
      llm: { apiKey: "test-only-key", model: "MiniMax-M3" },
      context: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 } }
    }));
    const originalFetch = globalThis.fetch;
    let ordinaryCalls = 0;
    const summaryRequests: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      let content = "普通回答";
      if (body.messages[0].content.includes("上下文摘要助手")) {
        summaryRequests.push(body);
        content = "## Goal\n保留第一轮事实\n\n## Progress\n已读取本机环境信息。";
      } else {
        ordinaryCalls++;
        if (ordinaryCalls === 1) content = JSON.stringify({ type: "tool_calls", calls: [{ id: "call_1", name: "system_info", input: {} }] });
      }
      return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
    };
    try {
      const kernel = await AgentKernel.start({ workspaceRoot: root });
      databases.track(kernel.storage);
      const first = await kernel.submitTurn("第一轮事实：查询电脑配置");
      await kernel.submitTurn("第二轮追问");
      const before = kernel.storage.db.prepare("select * from turns order by task_seq").all();
      const compact = await kernel.handleCommand("/compact");
      expect(compact.status).toBe("completed");
      expect(kernel.storage.db.prepare("select * from turns order by task_seq").all()).toEqual(before);
      expect(summaryRequests.length).toBeGreaterThan(0);
      expect(summaryRequests.some((body) => JSON.stringify(body.messages).includes("system_info"))).toBe(true);
      for (const body of summaryRequests) {
        expect(body).not.toHaveProperty("tools");
        expect(body).not.toHaveProperty("stream");
        expect(body.max_tokens).toBeGreaterThan(0);
      }
      const checkpoint = kernel.storage.db.prepare("select id, task_id, seq, request_id, source_refs_json, summary_markdown from context_compactions").get() as {
        id: string; task_id: string; seq: number; request_id: string; source_refs_json: string; summary_markdown: string
      };
      expect(checkpoint).toMatchObject({ seq: 1, summary_markdown: expect.stringContaining("保留第一轮事实") });
      expect(JSON.parse(checkpoint.source_refs_json)).toContain(`turn:${first.turnId}:user`);
      expect((JSON.parse(checkpoint.source_refs_json) as string[]).some((ref) => ref.startsWith("tool:"))).toBe(true);
      expect(kernel.storage.db.prepare("select purpose, task_id from llm_http_captures where request_id = ?").get(checkpoint.request_id))
        .toMatchObject({ purpose: "task_compaction", task_id: checkpoint.task_id });
      const summaryCaptures = kernel.storage.db.prepare("select task_id from llm_http_captures where purpose = 'task_compaction'").all();
      expect(summaryCaptures).toHaveLength(summaryRequests.length);
      expect(summaryCaptures.every((capture) => capture.task_id === checkpoint.task_id)).toBe(true);
      const usage = kernel.storage.db.prepare("select task_id, usage_turn_id from token_usage where purpose = 'task_compaction'").all();
      expect(usage).toHaveLength(summaryRequests.length);
      expect(usage.every((row) => row.task_id === checkpoint.task_id && row.usage_turn_id === null)).toBe(true);
      expect(kernel.storage.db.prepare("select count(*) as count from trace_events where turn_id = ? and type = 'tool.completed'").get(first.turnId)).toMatchObject({ count: 1 });
      const originalTask = kernel.storage.db.prepare("select task_id from turns where id = ?").get(first.turnId) as { task_id: string };
      expect(checkpoint.task_id).toBe(originalTask.task_id);
      await kernel.handleCommand("/task new 另一个任务");
      const other = await kernel.submitTurn("新任务的独立事实");
      const otherPack = kernel.storage.db.prepare("select id from context_packs where turn_id = ?").get(other.turnId) as { id: string };
      expect(kernel.storage.db.prepare("select count(*) as count from context_items where context_pack_id = ? and source_type = 'task_compaction'").get(otherPack.id)).toMatchObject({ count: 0 });
      await kernel.handleCommand("/task pause");
      await kernel.handleCommand(`/task switch ${originalTask.task_id}`);
      const third = await kernel.submitTurn("第三轮继续");
      const pack = kernel.storage.db.prepare("select id from context_packs where turn_id = ?").get(third.turnId) as { id: string };
      const items = kernel.storage.db.prepare("select source_ref from context_items where context_pack_id = ?").all(pack.id) as Array<{ source_ref: string }>;
      expect(items.map((item) => item.source_ref)).toContain(`task.compaction:${checkpoint.id}`);
      expect(items.map((item) => item.source_ref)).not.toContain(`task.turn:${first.turnId}`);
      expect(items.map((item) => item.source_ref)).not.toContain(`task.turn:${other.turnId}`);
      expect(kernel.storage.db.prepare("select count(*) as count from trace_events where type = 'compaction.completed'").get()).toMatchObject({ count: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("checks the known window before appending the third user input and preserves raw history on empty summary", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-compact-e2e-"));
    await writeFile(join(root, "figo-agent.config.json"), JSON.stringify({
      llm: { apiKey: "test-only-key", model: "MiniMax-M3", contextWindow: 1000 },
      context: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 100 } }
    }));
    const originalFetch = globalThis.fetch;
    let ordinaryCalls = 0;
    const summaryPrompts: string[] = [];
    const ordinaryPrompts: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      if (body.messages[0].content.includes("上下文摘要助手")) {
        summaryPrompts.push(body.messages.map((message) => message.content).join("\n"));
        return Response.json({ choices: [{ message: { content: "" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 } });
      }
      ordinaryCalls++;
      ordinaryPrompts.push(body.messages.map((message) => message.content).join("\n"));
      const promptTokens = ordinaryCalls === 2 ? 950 : 10;
      return Response.json({ choices: [{ message: { content: "普通回答" }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 } });
    };
    try {
      const kernel = await AgentKernel.start({ workspaceRoot: root });
      databases.track(kernel.storage);
      const first = await kernel.submitTurn("第一条事实");
      const second = await kernel.submitTurn("第二条事实");
      expect(summaryPrompts).toHaveLength(0);
      const third = await kernel.submitTurn("继续分析");
      expect(third.status).toBe("completed");
      expect(summaryPrompts).toHaveLength(1);
      expect(summaryPrompts[0]).toContain("第一条事实");
      expect(summaryPrompts[0]).not.toContain("继续分析");
      expect(ordinaryPrompts.at(-1)).toContain("第一条事实");
      expect(ordinaryPrompts.at(-1)).toContain("第二条事实");
      expect(kernel.storage.db.prepare("select count(*) as count from trace_events where turn_id = ? and type = 'compaction.failed'").get(third.turnId))
        .toMatchObject({ count: 1 });
      expect(kernel.storage.db.prepare("select usage_turn_id from token_usage where purpose = 'task_compaction'").get())
        .toEqual({ usage_turn_id: third.turnId });
      expect(kernel.storage.db.prepare("select count(*) as count from context_compactions").get()).toMatchObject({ count: 0 });
      const pack = kernel.storage.db.prepare("select id from context_packs where turn_id = ?").get(third.turnId) as { id: string };
      const items = kernel.storage.db.prepare("select source_ref from context_items where context_pack_id = ? and source_type = 'task_turn'").all(pack.id) as Array<{ source_ref: string }>;
      expect(items.map((item) => item.source_ref)).toEqual([`task.turn:${first.turnId}`, `task.turn:${second.turnId}`]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
