import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentKernel } from "../../src/kernel/agent-kernel.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

describe("Task context compaction e2e", () => {
  it("persists a manual checkpoint and exposes its HTTP capture in the next ContextPack", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-compact-e2e-"));
    await writeFile(join(root, "figo-agent.config.json"), JSON.stringify({ llm: { apiKey: "test-only-key", model: "MiniMax-M3" } }));
    const originalFetch = globalThis.fetch;
    let ordinaryCalls = 0;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      let content = "普通回答";
      if (body.messages[0].content.includes("将 Task 历史压缩")) {
        const payload = JSON.parse(body.messages[1].content) as { turns: Array<{ id: string }> };
        expect(payload.turns[0].content).toContain("system_info");
        const ids = payload.turns.map((turn) => turn.id);
        content = JSON.stringify({ goal: { text: "保留第一轮事实", sourceTurnIds: [ids[0]] }, facts: [], decisions: [], completedWork: [], openIssues: [], constraints: [], sourceTurnIds: ids });
      } else {
        ordinaryCalls++;
        if (ordinaryCalls === 1) content = JSON.stringify({ type: "tool_calls", calls: [{ id: "call_1", name: "system_info", input: {} }] });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 });
    };
    try {
      const kernel = await AgentKernel.start({ workspaceRoot: root });
      const first = await kernel.submitTurn("第一轮事实：查询电脑配置");
      await kernel.submitTurn("第二轮追问");
      const before = kernel.storage.db.prepare("select count(*) as count from turns").get();
      const compact = await kernel.handleCommand("/compact");
      expect(compact.status).toBe("completed");
      expect(kernel.storage.db.prepare("select count(*) as count from turns").get()).toEqual(before);
      const checkpoint = kernel.storage.db.prepare("select id, request_id, through_seq from task_compaction_checkpoints").get() as { id: string; request_id: string; through_seq: number };
      expect(checkpoint.through_seq).toBe(1);
      expect(kernel.storage.db.prepare("select purpose from llm_http_captures where request_id = ?").get(checkpoint.request_id)).toMatchObject({ purpose: "task_compaction" });
      expect(kernel.storage.db.prepare("select usage_turn_id from token_usage where request_id = ?").get(checkpoint.request_id)).toEqual({ usage_turn_id: null });
      expect(kernel.storage.db.prepare("select count(*) as count from trace_events where turn_id = ? and type = 'tool.completed'").get(first.turnId)).toMatchObject({ count: 1 });
      const originalTask = kernel.storage.db.prepare("select task_id from turns where id = ?").get(first.turnId) as { task_id: string };
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
  it("runs automatic policy before the third turn and falls back to full raw history on summary failure", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-compact-e2e-"));
    await writeFile(join(root, "figo-agent.config.json"), JSON.stringify({
      context: { maxTaskHistoryTurns: 1, compaction: { autoEnabled: true, turnThreshold: 2, charThreshold: 24000, summaryMaxChars: 12000 } }
    }));
    const kernel = await AgentKernel.start({ workspaceRoot: root });
    await kernel.submitTurn("第一条事实");
    await kernel.submitTurn("第二条事实");
    const third = await kernel.submitTurn("继续分析");
    expect(third.status).toBe("completed");
    expect(kernel.storage.db.prepare("select count(*) as count from trace_events where type = 'compaction.failed'").get()).toMatchObject({ count: 1 });
    expect(kernel.storage.db.prepare("select usage_turn_id from token_usage where purpose = 'task_compaction'").get())
      .toEqual({ usage_turn_id: third.turnId });
    expect(kernel.storage.db.prepare("select count(*) as count from task_compaction_checkpoints").get()).toMatchObject({ count: 0 });
    const pack = kernel.storage.db.prepare("select id from context_packs where turn_id = ?").get(third.turnId) as { id: string };
    expect(kernel.storage.db.prepare("select count(*) as count from context_items where context_pack_id = ? and source_type = 'task_turn'").get(pack.id)).toMatchObject({ count: 2 });
  });
});
