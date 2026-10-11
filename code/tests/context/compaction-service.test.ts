import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMProvider, LLMRequest } from "../../src/contracts/types.js";
import { CompactionService } from "../../src/context/compaction-service.js";
import { CompactionStore } from "../../src/context/compaction-store.js";
import { TaskHistoryReader } from "../../src/context/task-history-reader.js";
import { TurnManager } from "../../src/kernel/turn-manager.js";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TraceRecorder } from "../../src/trace/trace-recorder.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

describe("CompactionService", () => {
  it("reports a committed checkpoint as completed when the completion trace fails", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-service-"));
    const storage = await StorageManager.init(root);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", root, "active", "2026-01-01T00:00:00.000Z");
    const turns = new TurnManager(storage);
    const first = turns.create("ses", "task", "first"); turns.complete(first.id);
    const second = turns.create("ses", "task", "second"); turns.complete(second.id);
    const llm: LLMProvider = { complete: async (request) => ({
      id: "res", requestId: request.id, model: request.model, finishReason: "stop", outputLength: 1, durationMs: 1,
      content: JSON.stringify({ goal: { text: "first", sourceTurnIds: [first.id] }, facts: [], decisions: [], completedWork: [], openIssues: [], constraints: [], sourceTurnIds: [first.id] })
    }) };
    const trace = new TraceRecorder(storage);
    const record = trace.record.bind(trace);
    vi.spyOn(trace, "record").mockImplementation(async (event) => {
      if (event.type === "compaction.completed") throw new Error("trace write failed");
      return record(event);
    });
    const store = new CompactionStore(storage);
    const service = new CompactionService(new TaskHistoryReader(storage), store, llm, trace, "M3", 12000);
    const result = await service.compact({ sessionId: "ses", taskId: "task", mode: "manual", keepRawTurns: 1 });
    expect(result.status).toBe("completed");
    expect(store.latest("task")?.id).toBe(result.checkpointId);
    expect(storage.db.prepare("select count(*) as count from trace_events where type = 'compaction.failed'").get()).toMatchObject({ count: 0 });
    storage.db.close();
  });

  it("retains the previous boundary when the LLM request fails", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-service-"));
    const storage = await StorageManager.init(root);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", root, "active", "2026-01-01T00:00:00.000Z");
    const turns = new TurnManager(storage);
    for (const input of ["first", "second"]) { const turn = turns.create("ses", "task", input); turns.complete(turn.id); }
    const llm: LLMProvider = { complete: async () => { throw new Error("llm request failed: 503"); } };
    const store = new CompactionStore(storage);
    const service = new CompactionService(new TaskHistoryReader(storage), store, llm, new TraceRecorder(storage), "M3", 12000);
    const result = await service.compact({ sessionId: "ses", taskId: "task", mode: "manual", keepRawTurns: 1 });
    expect(result).toMatchObject({ status: "failed", reason: "llm request failed: 503" });
    expect(store.latest("task")).toBeUndefined();
    storage.db.close();
  });

  it("rejects a generated summary when another checkpoint wins the same base", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-service-"));
    const storage = await StorageManager.init(root);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", root, "active", "2026-01-01T00:00:00.000Z");
    const turns = new TurnManager(storage);
    const ids: string[] = [];
    for (const input of ["first", "second", "third"]) { const turn = turns.create("ses", "task", input); turns.complete(turn.id); ids.push(turn.id); }
    const store = new CompactionStore(storage);
    const llm: LLMProvider = { complete: async (request) => {
      const summary = JSON.stringify({ goal: { text: "first", sourceTurnIds: [ids[0]] }, facts: [], decisions: [], completedWork: [], openIssues: [], constraints: [], sourceTurnIds: [ids[0]] });
      store.append({ taskId: "task", baseCheckpointId: undefined, fromSeq: 1, throughSeq: 1, sourceTurnIds: [ids[0]], summaryJson: summary, requestId: "other_request" });
      return { id: "res", requestId: request.id, model: request.model, finishReason: "stop", outputLength: summary.length, durationMs: 1, content: summary };
    } };
    const service = new CompactionService(new TaskHistoryReader(storage), store, llm, new TraceRecorder(storage), "M3", 12000);
    const result = await service.compact({ sessionId: "ses", taskId: "task", mode: "manual", keepRawTurns: 1 });
    expect(result.status).toBe("failed");
    expect(store.latest("task")?.throughSeq).toBe(1);
    storage.db.close();
  });
  it("rolls the previous checkpoint into a new append-only summary", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-service-"));
    const storage = await StorageManager.init(root);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", root, "active", "2026-01-01T00:00:00.000Z");
    const turns = new TurnManager(storage);
    const first = turns.create("ses", "task", "first"); turns.complete(first.id);
    const second = turns.create("ses", "task", "second"); turns.complete(second.id);
    const llm: LLMProvider = { complete: async (request) => {
      const input = JSON.parse(request.messages[1].content) as { previousSummary: { sourceTurnIds: string[] } | null; turns: Array<{ id: string }> };
      const ids = [...(input.previousSummary?.sourceTurnIds ?? []), ...input.turns.map((turn) => turn.id)];
      const content = JSON.stringify({ goal: { text: "rolling goal", sourceTurnIds: [ids[0]] }, facts: [], decisions: [], completedWork: [], openIssues: [], constraints: [], sourceTurnIds: ids });
      return { id: "res", requestId: request.id, model: request.model, finishReason: "stop", outputLength: content.length, durationMs: 1, content };
    } };
    const store = new CompactionStore(storage);
    const service = new CompactionService(new TaskHistoryReader(storage), store, llm, new TraceRecorder(storage), "M3", 12000);
    expect((await service.compact({ sessionId: "ses", taskId: "task", mode: "manual", keepRawTurns: 1 })).status).toBe("completed");
    const base = store.latest("task")!;
    for (const input of ["third", "fourth"]) { const turn = turns.create("ses", "task", input); turns.complete(turn.id); }
    expect((await service.compact({ sessionId: "ses", taskId: "task", mode: "manual", keepRawTurns: 1 })).status).toBe("completed");
    const latest = store.latest("task")!;
    expect(latest.baseCheckpointId).toBe(base.id);
    expect(latest.throughSeq).toBe(3);
    expect(JSON.parse(latest.summaryJson).sourceTurnIds).toHaveLength(3);
    expect(storage.db.prepare("select count(*) as count from task_compaction_checkpoints").get()).toMatchObject({ count: 2 });
    storage.db.close();
  });

  it("returns failure instead of throwing when the stored base summary is corrupted", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-service-"));
    const storage = await StorageManager.init(root);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", root, "active", "2026-01-01T00:00:00.000Z");
    const turns = new TurnManager(storage);
    for (const input of ["one", "two", "three"]) { const turn = turns.create("ses", "task", input); turns.complete(turn.id); }
    const ids = storage.db.prepare("select id from turns where task_id = ? order by task_seq").all("task") as Array<{ id: string }>;
    const store = new CompactionStore(storage);
    store.append({ taskId: "task", baseCheckpointId: undefined, fromSeq: 1, throughSeq: 1, sourceTurnIds: [ids[0].id], summaryJson: "broken", requestId: "req" });
    const llm: LLMProvider = { complete: async () => { throw new Error("should not call LLM"); } };
    const service = new CompactionService(new TaskHistoryReader(storage), store, llm, new TraceRecorder(storage), "M3", 12000);
    const result = await service.compact({ sessionId: "ses", taskId: "task", mode: "manual", keepRawTurns: 1 });
    expect(result.status).toBe("failed");
    expect(store.latest("task")?.throughSeq).toBe(1);
    storage.db.close();
  });
  it("automatically compacts only prior turns when its internal threshold is reached", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-service-"));
    const storage = await StorageManager.init(root);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", root, "active", "2026-01-01T00:00:00.000Z");
    const turns = new TurnManager(storage);
    const one = turns.create("ses", "task", "first"); turns.complete(one.id);
    const two = turns.create("ses", "task", "second"); turns.complete(two.id);
    const current = turns.create("ses", "task", "current");
    const llm: LLMProvider = { complete: async (request) => ({ id: "res", requestId: request.id, model: request.model, finishReason: "stop", outputLength: 1, durationMs: 1, content: JSON.stringify({ goal: { text: "first", sourceTurnIds: [one.id] }, facts: [], decisions: [], completedWork: [], openIssues: [], constraints: [], sourceTurnIds: [one.id] }) }) };
    const service = new CompactionService(new TaskHistoryReader(storage), new CompactionStore(storage), llm, new TraceRecorder(storage), "M3", 12000);
    const result = await service.compactIfNeeded({ sessionId: "ses", taskId: "task", turnId: current.id, keepRawTurns: 1 }, { autoEnabled: true, turnThreshold: 2, charThreshold: 24000, summaryMaxChars: 12000 });
    expect(result.status).toBe("completed");
    expect(new CompactionStore(storage).latest("task")?.sourceTurnIds).toEqual([one.id]);
    expect(storage.db.prepare("select status from turns where id = ?").get(current.id)).toMatchObject({ status: "received" });
    const requested = storage.db.prepare("select payload_json from trace_events where type = 'compaction.requested'").get() as { payload_json: string };
    expect(JSON.parse(requested.payload_json)).toMatchObject({ policyReason: "turn threshold reached" });
    storage.db.close();
  });
  it("writes a sourced checkpoint and leaves the newest turn raw", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-service-"));
    const storage = await StorageManager.init(root);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", root, "active", "2026-01-01T00:00:00.000Z");
    const turns = new TurnManager(storage);
    const one = turns.create("ses", "task", "first"); turns.complete(one.id);
    const two = turns.create("ses", "task", "second"); turns.complete(two.id);
    const requests: LLMRequest[] = [];
    const llm: LLMProvider = { complete: async (request) => {
      requests.push(request);
      return { id: "res", requestId: request.id, model: request.model, finishReason: "stop", outputLength: 10, durationMs: 1,
        content: JSON.stringify({ goal: { text: "first goal", sourceTurnIds: [one.id] }, facts: [], decisions: [], completedWork: [], openIssues: [], constraints: [], sourceTurnIds: [one.id] }) };
    } };
    const service = new CompactionService(new TaskHistoryReader(storage), new CompactionStore(storage), llm, new TraceRecorder(storage), "M3", 12000);
    const first = await service.compact({ sessionId: "ses", taskId: "task", mode: "manual", keepRawTurns: 1 });
    expect(first.status).toBe("completed");
    expect(new CompactionStore(storage).latest("task")?.sourceTurnIds).toEqual([one.id]);
    expect(requests).toHaveLength(1);
    expect(requests[0].purpose).toBe("task_compaction");
    expect(requests[0].turnId).toBe(two.id);
    const second = await service.compact({ sessionId: "ses", taskId: "task", mode: "manual", keepRawTurns: 1 });
    expect(second.status).toBe("skipped");
    expect(requests).toHaveLength(1);
    storage.db.close();
  });

  it("does not advance the checkpoint when the model response is invalid", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-service-"));
    const storage = await StorageManager.init(root);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", root, "active", "2026-01-01T00:00:00.000Z");
    const turns = new TurnManager(storage);
    for (const input of ["first", "second"]) { const turn = turns.create("ses", "task", input); turns.complete(turn.id); }
    const llm: LLMProvider = { complete: async (request) => ({ id: "res", requestId: request.id, model: request.model, finishReason: "stop", outputLength: 4, durationMs: 1, content: "oops" }) };
    const service = new CompactionService(new TaskHistoryReader(storage), new CompactionStore(storage), llm, new TraceRecorder(storage), "M3", 12000);
    const result = await service.compact({ sessionId: "ses", taskId: "task", mode: "manual", keepRawTurns: 1 });
    expect(result.status).toBe("failed");
    expect(new CompactionStore(storage).latest("task")).toBeUndefined();
    storage.db.close();
  });
});
