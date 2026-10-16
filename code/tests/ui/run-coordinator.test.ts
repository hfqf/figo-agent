import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKernel } from "../../src/kernel/agent-kernel.js";
import { RunCoordinator } from "../../src/ui/run-coordinator.js";
import { WorkspaceFileService } from "../../src/ui/workspace-files.js";
import { TurnManager } from "../../src/kernel/turn-manager.js";
import { nowShanghaiTime } from "../../src/utils/clock.js";
import { activityForTurn } from "../../web/src/activity-feed.js";

import { TestDatabases } from "../helpers/test-databases.js";

const databases = new TestDatabases();
let workspace = "";

afterEach(async () => {
  databases.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = "";
});

describe("RunCoordinator", () => {
  it("clears pending text and its timer, resets offsets and replays only the replacement answer", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-stream-reset-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    databases.track(kernel.storage);
    const coordinator = new RunCoordinator(kernel);
    const task = kernel.storage.db.prepare("select id from tasks limit 1").get() as { id: string };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const runTurn = vi.spyOn(kernel, "runPreparedTurn").mockImplementation(async (turn, delta, _model, _signal, reset) => {
      delta?.("旧".repeat(512));
      delta?.("废弃的 pending");
      expect(vi.getTimerCount()).toBe(1);
      expect(reset).toBeTypeOf("function");
      reset?.();
      expect(vi.getTimerCount()).toBe(0);
      delta?.("新答案");
      await vi.advanceTimersByTimeAsync(100);
      return { sessionId: kernel.session.id, taskId: task.id, turnId: turn.id, status: "completed", message: "新答案", artifacts: [] };
    });
    try {
      const run = coordinator.submit({ taskId: task.id, input: "检查", clientRequestId: "reset-offset" });
      await coordinator.waitForIdle();
      expect(coordinator.getRun(run.runId).status).toBe("completed");
      const history = coordinator.events.taskHistory(task.id);
      const textEvents = history.filter((event) => event.kind.startsWith("assistant.text."));
      expect(textEvents.map((event) => event.kind)).toEqual(["assistant.text.delta", "assistant.text.reset", "assistant.text.delta"]);
      expect(textEvents[2].payload).toMatchObject({ text: "新答案", offset: 0, sourceLength: 3 });
      expect(activityForTurn(history, run.turnId).text).toBe("新答案");
      expect(coordinator.events.replay(textEvents[0].seq).some((event) => event.kind === "assistant.text.reset")).toBe(true);
    } finally {
      runTurn.mockRestore(); vi.useRealTimers(); coordinator.close(); kernel.storage.db.close();
    }
  });

  it("propagates a real streamed recovery reset through Kernel and the persisted event history", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-recovery-reset-"));
    await writeFile(join(workspace, "figo-agent.config.json"), JSON.stringify({
      llm: { apiKey: "test-key", model: "review", contextWindow: 1000000, maxTokens: 1000 },
      context: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } }
    }));
    const originalFetch = globalThis.fetch;
    let ordinaryCalls = 0;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      if (body.messages[0].content.includes("上下文摘要助手")) return Response.json({ choices: [{ message: { content: "## Goal\n完成当前请求" }, finish_reason: "stop" }] });
      ordinaryCalls++;
      const content = ordinaryCalls === 1 ? "FINAL\n" + "旧".repeat(512) + "pending" : "FINAL\n新答案";
      const wire = [
        { choices: [{ delta: { content }, finish_reason: ordinaryCalls === 1 ? "length" : "stop" }] },
        { choices: [], usage: { prompt_tokens: 500, completion_tokens: 5, total_tokens: 505 } }
      ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(wire, { headers: { "content-type": "text/event-stream" } });
    };
    let kernel: AgentKernel | undefined;
    let coordinator: RunCoordinator | undefined;
    try {
      kernel = await AgentKernel.start({ workspaceRoot: workspace });
      databases.track(kernel.storage);
      coordinator = new RunCoordinator(kernel);
      const task = kernel.storage.db.prepare("select id from tasks limit 1").get() as { id: string };
      const run = coordinator.submit({ taskId: task.id, input: "检查", clientRequestId: "real-reset" });
      await coordinator.waitForIdle();
      expect(coordinator.getRun(run.runId).status).toBe("completed");
      expect(ordinaryCalls).toBe(2);
      const history = coordinator.events.taskHistory(task.id);
      expect(history.filter((event) => event.kind === "assistant.text.reset")).toHaveLength(1);
      expect(activityForTurn(history, run.turnId).text).toBe("新答案");
      const deltas = history.filter((event) => event.kind === "assistant.text.delta");
      expect(deltas.at(-1)?.payload).toMatchObject({ offset: 0, text: "新答案" });
    } finally {
      globalThis.fetch = originalFetch; coordinator?.close(); kernel?.storage.db.close();
    }
  });

  it("stops an in-flight model request without completing the turn", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-stop-run-"));
    await writeFile(join(workspace, "figo-agent.config.json"), JSON.stringify({ activeModelId: "minimax", llm: [{
      id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "test-key",
      baseUrl: "https://model.example/v1", model: "test-model"
    }] }));
    const originalFetch = globalThis.fetch;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    let aborted = false;
    globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      requestStarted();
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      }, { once: true });
    });
    try {
      const kernel = await AgentKernel.start({ workspaceRoot: workspace });
      databases.track(kernel.storage);
      const coordinator = new RunCoordinator(kernel);
      const task = kernel.storage.db.prepare("select id from tasks where session_id = ?").get(kernel.session.id) as { id: string };
      const run = coordinator.submit({ taskId: task.id, input: "分析项目", clientRequestId: "stop-request" });
      await started;
      coordinator.stop(run.runId);
      await coordinator.waitForIdle();
      expect(aborted).toBe(true);
      expect(coordinator.getRun(run.runId).status).toBe("interrupted");
      expect(kernel.storage.db.prepare("select status from turns where id = ?").get(run.turnId)).toEqual({ status: "interrupted" });
      expect(kernel.storage.db.prepare("select response_status_text from llm_http_captures where turn_id = ?").get(run.turnId)).toEqual({ response_status_text: "ABORTED" });
      expect(coordinator.events.replay(0).map((event) => event.kind)).toContain("run.interrupted");
      await kernel.shutdown(); kernel.storage.db.close();
    } finally { globalThis.fetch = originalFetch; }
  });
  it("persists a per-message model choice and calls the selected provider and model", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-model-run-"));
    await writeFile(join(workspace, "figo-agent.config.json"), JSON.stringify({ activeModelId: "minimax", llm: [
      { id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "mini-key", baseUrl: "https://mini.example/v1", model: "MiniMax-M3" },
      { id: "gpt-relay", enabled: true, provider: "openai-compatible", apiKey: "relay-key", baseUrl: "https://relay.example/v1", model: "gpt-default" }
    ] }));
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; model: string }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), model: (JSON.parse(String(init?.body)) as { model: string }).model });
      return new Response(JSON.stringify({ choices: [{ message: { content: "FINAL\n已完成" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const kernel = await AgentKernel.start({ workspaceRoot: workspace });
      databases.track(kernel.storage);
      const coordinator = new RunCoordinator(kernel);
      const task = kernel.storage.db.prepare("select id from tasks where session_id = ?").get(kernel.session.id) as { id: string };
      const choice = { providerId: "gpt-relay", modelId: "gpt-selected" };
      const run = coordinator.submit({ taskId: task.id, input: "检查", clientRequestId: "model-request", modelSelection: choice });
      await coordinator.waitForIdle();
      expect(calls[0]).toEqual({ url: "https://relay.example/v1/chat/completions", model: "gpt-selected" });
      expect(coordinator.getRun(run.runId)).toMatchObject(choice);
      expect(kernel.storage.db.prepare("select provider, model from llm_http_captures where turn_id = ?").get(run.turnId)).toEqual({ provider: "gpt-relay", model: "gpt-selected" });
      expect(() => coordinator.submit({ taskId: task.id, input: "检查", clientRequestId: "model-request", modelSelection: { providerId: "minimax", modelId: "MiniMax-M3" } })).toThrow("幂等键");
      const oldDefaultRun = coordinator.submit({ taskId: task.id, input: "旧默认", clientRequestId: "old-default" });
      kernel.setDefaultModelSelection(choice);
      await coordinator.waitForIdle();
      expect(calls[1]).toEqual({ url: "https://mini.example/v1/chat/completions", model: "MiniMax-M3" });
      expect(coordinator.getRun(oldDefaultRun.runId)).toMatchObject({ providerId: "minimax", modelId: "MiniMax-M3" });
      const newDefaultRun = coordinator.submit({ taskId: task.id, input: "新默认", clientRequestId: "new-default" });
      await coordinator.waitForIdle();
      expect(calls[2]).toEqual({ url: "https://relay.example/v1/chat/completions", model: "gpt-selected" });
      expect(coordinator.getRun(newDefaultRun.runId)).toMatchObject(choice);
      await kernel.shutdown(); kernel.storage.db.close();
    } finally { globalThis.fetch = originalFetch; }
  });
  it("persists one accepted turn for an idempotency key and completes it asynchronously", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-run-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    databases.track(kernel.storage);
    const coordinator = new RunCoordinator(kernel);
    const task = kernel.storage.db.prepare("select id from tasks where session_id = ?").get(kernel.session.id) as { id: string };

    const first = coordinator.submit({ taskId: task.id, input: "检查项目", clientRequestId: "request-1" });
    const duplicate = coordinator.submit({ taskId: task.id, input: "检查项目", clientRequestId: "request-1" });
    expect(duplicate).toEqual(first);
    expect(first.status).toBe("accepted");
    expect(kernel.storage.db.prepare("select count(*) as count from turns").get()).toEqual({ count: 1 });
    expect(coordinator.events.replay(0).map((event) => event.kind)).toEqual(["run.accepted"]);

    await coordinator.waitForIdle();
    expect(coordinator.getRun(first.runId).status).toBe("completed");
    expect(coordinator.events.replay(0).filter((event) => event.kind.startsWith("run.")).map((event) => event.kind)).toEqual([
      "run.accepted", "run.running", "run.completed"
    ]);
    const progress = coordinator.events.replay(0).filter((event) => event.kind === "trace.recorded");
    expect(progress.some((event) => event.payload.type === "llm.called")).toBe(true);
    expect(progress.some((event) => event.payload.type === "turn.completed")).toBe(true);
    expect(progress.every((event) => !JSON.stringify(event.payload).includes("检查项目"))).toBe(true);
    expect(coordinator.events.taskHistory(task.id).some((event) => event.kind === "assistant.text.delta")).toBe(true);
    expect(kernel.storage.db.prepare("select status from turns where id = ?").get(first.turnId)).toEqual({ status: "completed" });
  });

  it("rejects another active run and does not create a second turn", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-run-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    databases.track(kernel.storage);
    const coordinator = new RunCoordinator(kernel);
    const task = kernel.storage.db.prepare("select id from tasks where session_id = ?").get(kernel.session.id) as { id: string };
    coordinator.submit({ taskId: task.id, input: "第一轮", clientRequestId: "request-a" });
    expect(() => coordinator.submit({ taskId: task.id, input: "第二轮", clientRequestId: "request-b" })).toThrow("活动 Run");
    expect(kernel.storage.db.prepare("select count(*) as count from turns").get()).toEqual({ count: 1 });
    await coordinator.waitForIdle();
  });

  it("includes an explicitly validated file range in ContextPack and the actual request", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-run-"));
    await writeFile(join(workspace, "note.md"), "甲\n乙\n丙\n");
    const files = new WorkspaceFileService(workspace);
    const preview = await files.preview("note.md");
    const reference = await files.validateReference({
      path: "note.md", startLine: 2, endLine: 2, version: preview.version!
    });
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    databases.track(kernel.storage);
    const coordinator = new RunCoordinator(kernel);
    const task = kernel.storage.db.prepare("select id from tasks where session_id = ?").get(kernel.session.id) as { id: string };
    const run = coordinator.submit({ taskId: task.id, input: "解释引用", clientRequestId: "reference-1", fileReferences: [reference] });
    await coordinator.waitForIdle();
    const item = kernel.storage.db.prepare("select source_type, source_ref, content from context_items where source_type = 'file_reference' and context_pack_id in (select id from context_packs where turn_id = ?)")
      .get(run.turnId) as { source_type: string; source_ref: string; content: string };
    expect(item).toMatchObject({ source_type: "file_reference", source_ref: "note.md#L2-L2", content: "乙" });
    const capture = kernel.storage.db.prepare("select request_body_json from llm_http_captures where turn_id = ?").get(run.turnId) as { request_body_json: string };
    expect(capture.request_body_json).toContain("note.md#L2-L2");
    expect(capture.request_body_json).toContain("乙");
  });

  it("rejects reuse of the same idempotency key with changed file references", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-run-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    databases.track(kernel.storage);
    const coordinator = new RunCoordinator(kernel);
    const task = kernel.storage.db.prepare("select id from tasks where session_id = ?").get(kernel.session.id) as { id: string };
    coordinator.submit({ taskId: task.id, input: "读取", clientRequestId: "same-key", fileReferences: [
      { path: "a.md", startLine: 1, endLine: 1, version: "v1", content: "甲" }
    ] });
    expect(() => coordinator.submit({ taskId: task.id, input: "读取", clientRequestId: "same-key", fileReferences: [
      { path: "b.md", startLine: 1, endLine: 1, version: "v2", content: "乙" }
    ] })).toThrow("幂等键");
    await coordinator.waitForIdle();
  });

  it("marks a dead process run interrupted without replaying tools", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-run-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    databases.track(kernel.storage);
    const task = kernel.storage.db.prepare("select id from tasks where session_id = ?").get(kernel.session.id) as { id: string };
    const turn = new TurnManager(kernel.storage).create(kernel.session.id, task.id, "不要重放");
    const now = nowShanghaiTime();
    kernel.storage.db.prepare("insert into ui_runs (run_id, turn_id, session_id, task_id, client_request_id, owner_pid, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("run_dead", turn.id, kernel.session.id, task.id, "dead-request", 99999999, "running", now, now);
    const coordinator = new RunCoordinator(kernel);
    expect(coordinator.getRun("run_dead").status).toBe("interrupted");
    expect(kernel.storage.db.prepare("select status from turns where id = ?").get(turn.id)).toEqual({ status: "interrupted" });
    expect(kernel.storage.db.prepare("select count(*) as count from llm_http_captures where turn_id = ?").get(turn.id)).toEqual({ count: 0 });
    expect(coordinator.events.replay(0).at(-1)?.kind).toBe("run.interrupted");
  });
});
