import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentKernel } from "../../src/kernel/agent-kernel.js";
import { TurnManager } from "../../src/kernel/turn-manager.js";
import { TaskHistoryReader } from "../../src/context/task-history-reader.js";

let root = "";
let kernel: AgentKernel;
afterEach(async () => { vi.restoreAllMocks(); if (kernel?.storage.db.isOpen) kernel.storage.db.close(); if (root) await rm(root, { recursive: true, force: true }); });
const reply = (message: unknown) => new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 } }), { status: 200 });
async function setup(window = 128000) {
  root = await mkdtemp(join(tmpdir(), "figo-pi-recovery-"));
  await writeFile(join(root, "figo-agent.config.json"), JSON.stringify({ activeModelId: "test", llm: [{ id: "test", enabled: true, provider: "openai-compatible", apiKey: "test-key", baseUrl: "https://test.example/v1", model: "model", toolCallingMode: "native", contextWindow: window, maxTokens: 4096 }], context: { includeMemory: false, compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } } }));
}

it("真实写文件工具在超限压缩重试中只执行一次，原始失败和成功消息都可追溯", async () => {
  await setup();
  let ordinary = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const body = JSON.parse(String(init?.body));
    if (!body.tools) return reply({ content: "## Goal\n写入一次 proof.txt 并确认结果。" });
    ordinary++;
    if (ordinary === 1) return reply({ content: null, tool_calls: [{ id: "write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "proof.txt", content: "once" }) } }] });
    if (ordinary === 2) return new Response(JSON.stringify({ error: { code: "context_length_exceeded" } }), { status: 400 });
    return reply({ content: "文件已写入一次。" });
  });
  kernel = await AgentKernel.start({ workspaceRoot: root });
  const result = await kernel.submitTurn("写入 proof.txt，不能重复写入。");
  expect(result.status, JSON.stringify(result)).toBe("completed");
  expect(await readFile(join(root, "proof.txt"), "utf8")).toBe("once");
  expect(kernel.storage.db.prepare("select count(*) as n from tool_calls where tool_name = 'write_file'").get()).toMatchObject({ n: 1 });
  expect(kernel.storage.db.prepare("select count(*) as n from llm_http_captures where response_status = 400").get()).toMatchObject({ n: 1 });
  expect(kernel.storage.db.prepare("select count(*) as n from context_messages where omitted = 1").get()).toMatchObject({ n: 1 });
  expect(kernel.storage.db.prepare("select count(*) as n from context_compactions").get()).toMatchObject({ n: 1 });
  expect(ordinary).toBe(3);
});

it("反馈边界在完成事件触发取消且没有下一抓包时仍可重建，并能继续新 Turn", async () => {
  await setup(101);
  let calls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const body = JSON.parse(String(init?.body));
    if (!body.tools) return reply({ content: "## Goal\n修复无效工具协议，继续核对项目。" });
    calls++;
    return calls === 1 ? reply({ content: '<tool_calls><invoke name="read_file" /></tool_calls>' }) : reply({ content: "继续完成。" });
  });
  kernel = await AgentKernel.start({ workspaceRoot: root });
  const task = kernel.storage.db.prepare("select id from tasks limit 1").get() as { id: string };
  const turn = new TurnManager(kernel.storage).create(kernel.session.id, task.id, "核对项目");
  const abort = new AbortController();
  const unsubscribe = kernel.onTraceEvent((event) => { if (event.type === "compaction.completed") abort.abort(); });
  const result = await kernel.runPreparedTurn(turn, undefined, undefined, abort.signal);
  new TurnManager(kernel.storage).fail(turn.id);
  unsubscribe();
  expect(result.status).toBe("failed");
  expect(calls, JSON.stringify(result)).toBe(1);
  const boundary = kernel.storage.db.prepare("select first_kept_source_ref from context_compactions").get() as { first_kept_source_ref: string };
  expect(boundary.first_kept_source_ref).toContain(":feedback:0");
  expect(new TaskHistoryReader(kernel.storage).messages(task.id).some((entry) => entry.sourceRef === boundary.first_kept_source_ref)).toBe(true);
  expect((await kernel.submitTurn("继续")).status).toBe("completed");
});
