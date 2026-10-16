import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../src/contracts/types.js";
import { readPiCompactionSettings, type PiCompactionSettings } from "../../src/config/pi-compaction-settings.js";
import { CompactionService } from "../../src/context/compaction-service.js";
import { CompactionStore } from "../../src/context/compaction-store.js";
import { ContextMessageStore } from "../../src/context/context-message-store.js";
import type { ConversationMessage } from "../../src/context/conversation-message.js";
import { TaskHistoryReader } from "../../src/context/task-history-reader.js";
import { TurnManager } from "../../src/kernel/turn-manager.js";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TraceRecorder } from "../../src/trace/trace-recorder.js";

let root = "";
const opened: StorageManager[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const storage of opened.splice(0)) if (storage.db.isOpen) storage.db.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

const summaryMarkdown = "## Goal\n保留已完成的工作。\n\n## Progress\n### Done\n- 已检查项目。\n\n## Next Steps\n继续后续任务。";
const compactSettings = readPiCompactionSettings({ keepRecentTokens: 1, reserveTokens: 100 });
const manual = { sessionId: "ses", taskId: "task", mode: "manual" as const };

function response(request: LLMRequest, content = summaryMarkdown, finishReason: LLMResponse["finishReason"] = "stop"): LLMResponse {
  return { id: "res", requestId: request.id, model: request.model, finishReason,
    outputLength: content.length, durationMs: 1, content };
}

async function fixture(inputs = ["FIRST-RAW-INPUT", "SECOND-RAW-INPUT"]) {
  root = await mkdtemp(join(tmpdir(), "figo-pi-service-"));
  const storage = await StorageManager.init(root);
  opened.push(storage);
  storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)")
    .run("ses", root, "active", "2026-10-15 12:00:00.000");
  storage.db.prepare("insert into tasks (id, session_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
    .run("task", "ses", "压缩测试", "active", "2026-10-15 12:00:00.000", "2026-10-15 12:00:00.000");
  const turns = new TurnManager(storage);
  const ids = inputs.map((input) => { const turn = turns.create("ses", "task", input); turns.complete(turn.id); return turn.id; });
  const store = new CompactionStore(storage);
  const history = new TaskHistoryReader(storage);
  const trace = new TraceRecorder(storage);
  const requests: LLMRequest[] = [];
  const llm: LLMProvider = { complete: async (request) => { requests.push(request); return response(request); } };
  const service = (provider = llm, config: PiCompactionSettings = compactSettings) =>
    new CompactionService(history, store, provider, trace, "M3", config);
  const originals = () => storage.db.prepare("select * from turns order by task_seq").all();
  return { storage, turns, ids, store, history, trace, requests, llm, service, originals };
}

function legacySummary(turnId: string) {
  return JSON.stringify({ goal: { text: "旧版目标", sourceTurnIds: [turnId] }, facts: [], decisions: [],
    completedWork: [], openIssues: [], constraints: [], sourceTurnIds: [turnId] });
}

describe("CompactionService Pi", () => {
  it("禁用恢复也持久化失败尝试的省略标记，不在下一轮回灌", async () => {
    const f = await fixture();
    const messageStore = new ContextMessageStore(f.storage);
    const failed: ConversationMessage = { sourceRef: "request:failed:response", turnId: f.ids[0], message: { role: "assistant", content: "废弃的部分答案" }, stopReason: "length" };
    messageStore.append("task", [{ sourceRef: `turn:${f.ids[0]}:user`, turnId: f.ids[0], message: { role: "user", content: "原始目标" } }, failed]);
    const service = new CompactionService(f.history, f.store, f.llm, f.trace, "M3", { ...compactSettings, enabled: false }, messageStore);
    const result = await service.compact({ ...manual, mode: "recovery", omittedSourceRefs: [failed.sourceRef] });
    expect(result.status).toBe("skipped");
    expect(f.requests).toHaveLength(0);
    expect(service.loadConversation("task").messages.some((entry) => entry.sourceRef === failed.sourceRef)).toBe(false);
    expect(f.storage.db.prepare("select omitted from context_messages where source_ref = ?").get(failed.sourceRef)).toMatchObject({ omitted: 1 });
  });
  it("stores message source references separately from the Markdown summary", async () => {
    const f = await fixture();
    const messages: ConversationMessage[] = [
      { sourceRef: `turn:${f.ids[0]}:user`, turnId: f.ids[0], message: { role: "user", content: "读取项目说明" } },
      { sourceRef: "request:read:response", turnId: f.ids[0], message: { role: "assistant", content: "",
        toolCalls: [{ id: "read", name: "read_file", input: { path: "readme.md" } }] } },
      { sourceRef: "tool:read:result", turnId: f.ids[0], message: { role: "tool", toolCallId: "read", content: "项目说明原文" } },
      { sourceRef: `turn:${f.ids[1]}:user`, turnId: f.ids[1], message: { role: "user", content: "后续任务" } }
    ];
    const originals = f.originals();
    const result = await f.service().compact({ ...manual, messages });
    expect(result).toMatchObject({ status: "completed", coveredTurnIds: [f.ids[0]] });
    expect(result.summaryMarkdown).toContain(summaryMarkdown);
    expect(result.messages?.map((entry) => entry.sourceRef)).toEqual([messages[3].sourceRef]);
    const entry = f.store.latestEntry("task")!;
    expect(entry).toMatchObject({ id: result.checkpointId, seq: 1, summaryMarkdown: result.summaryMarkdown,
      firstKeptSourceRef: messages[3].sourceRef, coveredSourceRefs: messages.slice(0, 3).map((entry) => entry.sourceRef) });
    expect(entry.details.readFiles).toContain("readme.md");
    expect(entry.details.modifiedFiles).toEqual([]);
    expect(result.summaryMarkdown).toContain("<read-files>\nreadme.md\n</read-files>");
    expect(entry.summaryMarkdown).not.toContain("sourceTurnIds");
    expect(entry.requestId).toBe(f.requests[0].id);
    expect(f.requests[0]).toMatchObject({ purpose: "task_compaction", turnId: f.ids[1], usageTurnId: null });
    expect(f.requests[0].availableTools).toBeUndefined();
    expect(f.requests[0].messages.map((message) => message.content).join("\n")).toContain("项目说明原文");
    expect(f.store.latest("task")).toBeUndefined();
    expect(f.originals()).toEqual(originals);
    const started = f.storage.db.prepare("select payload_json from trace_events where type = 'compaction.started'").get() as { payload_json: string };
    expect(JSON.parse(started.payload_json)).toMatchObject({ firstKeptSourceRef: messages[3].sourceRef,
      sourceRefs: messages.slice(0, 3).map((entry) => entry.sourceRef) });
  });

  it("skips short histories with default recent-token settings", async () => {
    const f = await fixture();
    const service = new CompactionService(f.history, f.store, f.llm, f.trace, "M3");
    expect((await service.compact(manual)).status).toBe("skipped");
    expect(f.requests).toHaveLength(0);
    expect(f.store.latestEntry("task")).toBeUndefined();
  });

  it("reports a committed entry as completed when the completion trace fails", async () => {
    const f = await fixture();
    const record = f.trace.record.bind(f.trace);
    vi.spyOn(f.trace, "record").mockImplementation(async (event) => {
      if (event.type === "compaction.completed") throw new Error("trace write failed");
      return record(event);
    });
    const result = await f.service().compact(manual);
    expect(result.status).toBe("completed");
    expect(f.store.latestEntry("task")?.id).toBe(result.checkpointId);
    expect(f.storage.db.prepare("select count(*) as count from trace_events where type = 'compaction.failed'").get()).toMatchObject({ count: 0 });
  });

  it("retains the previous entry and raw history when the LLM request fails", async () => {
    const f = await fixture();
    const first = await f.service().compact(manual);
    for (const input of ["third", "fourth"]) { const turn = f.turns.create("ses", "task", input); f.turns.complete(turn.id); }
    const originals = f.originals();
    const llm: LLMProvider = { complete: async () => { throw new Error("llm request failed: 503"); } };
    expect(await f.service(llm).compact(manual)).toMatchObject({ status: "failed", reason: "llm request failed: 503" });
    expect(f.store.latestEntry("task")?.id).toBe(first.checkpointId);
    expect(f.storage.db.prepare("select count(*) as count from context_compactions").get()).toMatchObject({ count: 1 });
    expect(f.originals()).toEqual(originals);
  });

  it.each([
    { name: "empty", content: "", finishReason: "stop" as const },
    { name: "whitespace", content: " \n ", finishReason: "stop" as const },
    { name: "length", content: summaryMarkdown, finishReason: "length" as const },
    { name: "tool calls", content: summaryMarkdown, finishReason: "tool_calls" as const },
    { name: "error", content: summaryMarkdown, finishReason: "error" as const }
  ])("does not append a checkpoint for a $name summary response", async ({ content, finishReason }) => {
    const f = await fixture();
    const originals = f.originals();
    const complete = vi.fn(async (request: LLMRequest) => ({ ...response(request, content, finishReason),
      ...(finishReason === "tool_calls" ? { toolCalls: [{ id: "unexpected", name: "read_file", input: {} }] } : {}) }));
    const llm: LLMProvider = { complete };
    expect((await f.service(llm).compact(manual)).status).toBe("failed");
    expect(complete).toHaveBeenCalledOnce();
    expect(f.store.latestEntry("task")).toBeUndefined();
    expect(f.originals()).toEqual(originals);
  });

  it("accepts nonempty plain text without requiring old JSON provenance", async () => {
    const f = await fixture();
    const llm: LLMProvider = { complete: async (request) => response(request, "已完成目录检查，继续实现。") };
    expect((await f.service(llm).compact(manual)).status).toBe("completed");
    expect(f.store.latestEntry("task")?.summaryMarkdown).toContain("已完成目录检查");
  });

  it("does not call the LLM or append an entry for a pre-aborted request", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    const originals = f.originals();
    expect((await f.service().compact({ ...manual, signal: controller.signal })).status).not.toBe("completed");
    expect(f.requests).toHaveLength(0);
    expect(f.store.latestEntry("task")).toBeUndefined();
    expect(f.originals()).toEqual(originals);
  });

  it("does not commit a summary when cancellation arrives during generation", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const originals = f.originals();
    const complete = vi.fn(async (request: LLMRequest) => {
      expect(request.signal).toBe(controller.signal);
      controller.abort();
      return response(request);
    });
    const llm: LLMProvider = { complete };
    expect((await f.service(llm).compact({ ...manual, signal: controller.signal })).status).not.toBe("completed");
    expect(complete).toHaveBeenCalledOnce();
    expect(f.store.latestEntry("task")).toBeUndefined();
    expect(f.originals()).toEqual(originals);
  });

  it("rejects a stale generated summary when another writer commits the same base", async () => {
    const f = await fixture();
    const llm: LLMProvider = { complete: async (request) => {
      f.store.appendEntry({ id: "winner", taskId: "task", firstKeptSourceRef: `turn:${f.ids[1]}:user`,
        coveredSourceRefs: [`turn:${f.ids[0]}:user`], summaryMarkdown: "并发写入的摘要", details: { readFiles: [], modifiedFiles: [] },
        tokensBefore: 20, requestId: "other_request" });
      return response(request);
    } };
    expect(await f.service(llm).compact(manual)).toMatchObject({ status: "failed", reason: "compaction entry base changed" });
    expect(f.store.latestEntry("task")?.id).toBe("winner");
    expect(f.storage.db.prepare("select count(*) as count from context_compactions").get()).toMatchObject({ count: 1 });
  });

  it("rolls the previous Markdown summary forward after reopening without changing old entries", async () => {
    const f = await fixture();
    const first = await f.service().compact(manual);
    expect(first.status).toBe("completed");
    const base = f.store.latestEntry("task")!;
    const newer = ["THIRD-RAW-INPUT", "FOURTH-RAW-INPUT"].map((input) => {
      const turn = f.turns.create("ses", "task", input); f.turns.complete(turn.id); return turn.id;
    });
    const originals = f.originals();
    f.storage.db.close();
    const reopened = await StorageManager.init(root);
    opened.push(reopened);
    const store = new CompactionStore(reopened);
    const requests: LLMRequest[] = [];
    const llm: LLMProvider = { complete: async (request) => { requests.push(request); return response(request, "## Goal\n滚动更新后的目标"); } };
    const service = new CompactionService(new TaskHistoryReader(reopened), store, llm, new TraceRecorder(reopened), "M3", compactSettings);
    const loaded = await service.loadConversation("task");
    expect(loaded).toMatchObject({ baseEntryId: base.id, previousSummary: base.summaryMarkdown });
    expect(loaded.messages.map((entry) => entry.sourceRef)).toEqual([f.ids[1], ...newer].map((id) => `turn:${id}:user`));
    const result = await service.compact(manual);
    expect(result.status).toBe("completed");
    const prompt = requests.map((request) => request.messages.map((message) => message.content).join("\n")).join("\n");
    expect(prompt).toContain(base.summaryMarkdown);
    expect(prompt).not.toContain("FIRST-RAW-INPUT");
    const latest = store.latestEntry("task")!;
    expect(latest).toMatchObject({ seq: 2, baseEntryId: base.id, firstKeptSourceRef: `turn:${newer[1]}:user` });
    expect(latest.coveredSourceRefs).toEqual([`turn:${f.ids[1]}:user`, `turn:${newer[0]}:user`]);
    expect(reopened.db.prepare("select summary_markdown from context_compactions where id = ?").get(base.id)).toMatchObject({ summary_markdown: base.summaryMarkdown });
    expect(reopened.db.prepare("select * from turns order by task_seq").all()).toEqual(originals);
    expect((await service.loadConversation("task")).messages.map((entry) => entry.sourceRef)).toEqual([`turn:${newer[1]}:user`]);
    expect((await service.compact(manual)).status).toBe("skipped");
    expect(requests).toHaveLength(1);
  });

  it("loads an old JSON checkpoint as previous summary and appends only to the new table", async () => {
    const f = await fixture(["old raw", "new prefix", "retained"]);
    const legacy = f.store.append({ taskId: "task", fromSeq: 1, throughSeq: 1, sourceTurnIds: [f.ids[0]],
      summaryJson: legacySummary(f.ids[0]), requestId: "legacy_request" });
    const loaded = await f.service().loadConversation("task");
    expect(loaded.previousSummary).toContain("旧版目标");
    expect(loaded.messages.map((entry) => entry.sourceRef)).toEqual(f.ids.slice(1).map((id) => `turn:${id}:user`));
    expect((await f.service().compact(manual)).status).toBe("completed");
    expect(f.store.latestEntry("task")).toMatchObject({ seq: 1, coveredSourceRefs: [`turn:${f.ids[1]}:user`] });
    expect(f.store.latest("task")).toEqual(legacy);
  });

  it("returns failure without appending when a legacy JSON checkpoint is corrupt", async () => {
    const f = await fixture(["old raw", "new prefix", "retained"]);
    const legacy = f.store.append({ taskId: "task", fromSeq: 1, throughSeq: 1, sourceTurnIds: [f.ids[0]], summaryJson: "broken", requestId: "legacy_request" });
    expect((await f.service().compact(manual)).status).toBe("failed");
    expect(f.requests).toHaveLength(0);
    expect(f.store.latestEntry("task")).toBeUndefined();
    expect(f.store.latest("task")).toEqual(legacy);
  });

  it("allows manual compaction when automatic compaction is disabled", async () => {
    const f = await fixture();
    expect((await f.service(f.llm, { ...compactSettings, enabled: false }).compact(manual)).status).toBe("completed");
  });

  it.each(["auto", "recovery"] as const)("skips %s while disabled even when the known window is exceeded", async (mode) => {
    const f = await fixture(["x".repeat(1000), "tail"]);
    expect((await f.service(f.llm, { ...compactSettings, enabled: false }).compact({ ...manual, mode, messages: f.history.messages("task") },
      { llm: f.llm, model: "M3", contextWindow: 120 })).status).toBe("skipped");
    expect(f.requests).toHaveLength(0);
  });

  it("skips automatic compaction when the effective model window is unknown", async () => {
    const f = await fixture(["x".repeat(1000), "tail"]);
    expect((await f.service().compact({ ...manual, mode: "auto", messages: f.history.messages("task") })).status).toBe("skipped");
    expect(f.requests).toHaveLength(0);
    expect(f.store.latestEntry("task")).toBeUndefined();
  });

  it("skips automatic compaction below window minus reserve", async () => {
    const f = await fixture();
    expect((await f.service().compact({ ...manual, mode: "auto", messages: f.history.messages("task") }, { llm: f.llm, model: "M3", contextWindow: 10000 })).status).toBe("skipped");
    expect(f.requests).toHaveLength(0);
  });

  it("automatically compacts only prior messages using a known model window", async () => {
    const f = await fixture(["x".repeat(1000), "prior retained message"]);
    const current = f.turns.create("ses", "task", "current input");
    const result = await f.service().compact({ ...manual, mode: "auto", turnId: current.id, beforeSeq: 3, messages: f.history.messages("task", 3) },
      { llm: f.llm, model: "M3", contextWindow: 120 });
    expect(result.status).toBe("completed");
    expect(f.store.latestEntry("task")?.coveredSourceRefs).toEqual([`turn:${f.ids[0]}:user`]);
    expect(f.requests[0]).toMatchObject({ turnId: current.id, usageTurnId: current.id });
    expect(f.requests[0].messages.map((message) => message.content).join("\n")).not.toContain("current input");
    expect(f.storage.db.prepare("select status from turns where id = ?").get(current.id)).toMatchObject({ status: "received" });
  });

  it("passes the model override, output limit, instructions and omitted-source metadata", async () => {
    const f = await fixture();
    const requests: LLMRequest[] = [];
    const llm: LLMProvider = { complete: async (request) => { requests.push(request); return response(request); } };
    const result = await f.service().compact({ ...manual, instructions: "保留验证命令", omittedSourceRefs: ["tool:omitted:result"] },
      { llm, model: "override-model", providerId: "relay", contextWindow: 10000, maxTokens: 64, maxTokensField: "max_completion_tokens" });
    expect(result.status).toBe("completed");
    expect(f.requests).toHaveLength(0);
    expect(requests[0]).toMatchObject({ model: "override-model", maxOutputTokens: 64, maxTokensField: "max_completion_tokens" });
    expect(requests[0].messages.map((message) => message.content).join("\n")).toContain("保留验证命令");
    expect(f.store.latestEntry("task")?.details).toMatchObject({ omittedSourceRefs: ["tool:omitted:result"], providerId: "relay", model: "override-model" });
  });

  it("passes an explicit live previous summary into rolling summary generation", async () => {
    const f = await fixture();
    const result = await f.service().compact({ ...manual, messages: f.history.messages("task"), previousSummary: "LIVE-PREVIOUS-SUMMARY" });
    expect(result.status).toBe("completed");
    expect(f.requests.map((request) => request.messages.map((message) => message.content).join("\n")).join("\n")).toContain("LIVE-PREVIOUS-SUMMARY");
  });
});
