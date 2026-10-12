import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextBuilder } from "../../src/context/context-builder.js";
import { LLMHttpCaptureStore } from "../../src/llm/llm-http-capture-store.js";
import { SqliteMemoryStore } from "../../src/memory/sqlite-memory-store.js";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TurnManager } from "../../src/kernel/turn-manager.js";
import { CompactionStore } from "../../src/context/compaction-store.js";

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("ContextBuilder", () => {
  it("builds a persisted ContextPack from turn input and memory without project docs by default", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "AGENTS.MD"), "项目原则", "utf8");
    await writeFile(join(workspace, "readme.md"), "项目说明", "utf8");
    const storage = await StorageManager.init(workspace);
    storage.db
      .prepare(
        "insert into memory_records (id, scope, key, content, source, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)"
      )
      .run("mem_1", "project", "architecture", "小内核", "test", "2026-10-10T00:00:00.000Z", "2026-10-10T00:00:00.000Z");

    const builder = new ContextBuilder(storage, new SqliteMemoryStore(storage));
    const pack = await builder.build({
      sessionId: "ses_1",
      taskId: "task_1",
      turnId: "turn_1",
      input: "理解当前项目"
    });

    expect(pack.items.map((item) => item.sourceRef)).toEqual(
      expect.arrayContaining(["turn.input", "memory:architecture"])
    );
    expect(pack.items.map((item) => item.sourceRef)).not.toContain("AGENTS.MD");
    expect(pack.items.map((item) => item.sourceRef)).not.toContain("readme.md");
    expect(pack.taskId).toBe("task_1");
    expect(pack.estimatedTokens).toBeGreaterThan(0);
    expect(pack.items.every((item) => item.estimatedTokens > 0 && item.reason)).toBe(true);
    expect(
      storage.db.prepare("select id from context_packs where id = ?").get(pack.id)
    ).toBeTruthy();
    expect(
      storage.db.prepare("select count(*) as count from context_items where context_pack_id = ?").get(pack.id)
    ).toMatchObject({ count: pack.items.length });
  });

  it("does not inject source repository docs into a user workspace", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "AGENTS.MD"), "项目原则", "utf8");
    await writeFile(join(workspace, "readme.md"), "项目说明", "utf8");
    const storage = await StorageManager.init(workspace);

    const builder = new ContextBuilder(storage, new SqliteMemoryStore(storage), undefined, {
      maxTaskHistoryTurns: 5,
      includeMemory: true,
      compaction: { autoEnabled: true, turnThreshold: 12, charThreshold: 24000, summaryMaxChars: 12000 }
    });
    const pack = await builder.build({
      sessionId: "ses_1",
      taskId: "task_1",
      turnId: "turn_1",
      input: "读取项目规则"
    });

    expect(pack.items.map((item) => item.sourceRef)).not.toContain("AGENTS.MD");
    expect(pack.items.map((item) => item.sourceRef)).not.toContain("readme.md");
  });

  it("includes previous turn tool results and final assistant answer in task history", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "AGENTS.MD"), "项目原则", "utf8");
    await writeFile(join(workspace, "readme.md"), "项目说明", "utf8");
    const storage = await StorageManager.init(workspace);
    storage.db
      .prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)")
      .run("ses_1", workspace, "active", "2026-10-11T00:00:00.000Z");
    storage.db
      .prepare("insert into tasks (id, session_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
      .run("task_1", "ses_1", "default", "active", "2026-10-11T00:00:00.000Z", "2026-10-11T00:00:00.000Z");
    storage.db
      .prepare("insert into turns (id, session_id, task_id, task_seq, input, status, created_at, completed_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "turn_1",
        "ses_1",
        "task_1",
        1,
        "当前电脑可以部署 Duix-Avatar 吗",
        "completed",
        "2026-10-11T00:00:01.000Z",
        "2026-10-11T00:00:02.000Z"
      );
    storage.db
      .prepare("insert into turns (id, session_id, task_id, task_seq, input, status, created_at) values (?, ?, ?, ?, ?, ?, ?)")
      .run(
        "turn_2",
        "ses_1",
        "task_1",
        2,
        "那你有什么好的实施方案推荐吗",
        "processing",
        "2026-10-11T00:00:03.000Z"
      );
    new LLMHttpCaptureStore(storage).record({
      sessionId: "ses_1",
      taskId: "task_1",
      turnId: "turn_1",
      requestId: "llm_req_1",
      provider: "minimax",
      model: "MiniMax-M3",
      url: "local:test",
      method: "LOCAL",
      requestHeaders: {},
      requestBody: {
        model: "MiniMax-M3",
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              type: "tool_results",
              results: [
                {
                  id: "call_1",
                  name: "system_info",
                  status: "completed",
                  output: { platform: "darwin", arch: "arm64", totalMemoryBytes: 34359738368 }
                }
              ]
            })
          }
        ]
      },
      responseStatus: 200,
      responseStatusText: "OK",
      responseHeaders: {},
      responseBody: {
        choices: [
          {
            message: {
              content: "当前电脑是 macOS arm64，32GB 内存；Duix-Avatar 不适合直接走 CUDA 本地部署。"
            },
            finish_reason: "stop"
          }
        ]
      },
      durationMs: 1
    });

    const builder = new ContextBuilder(storage, new SqliteMemoryStore(storage));
    const pack = await builder.build({
      sessionId: "ses_1",
      taskId: "task_1",
      turnId: "turn_2",
      input: "那你有什么好的实施方案推荐吗"
    });

    const history = pack.items.find((item) => item.sourceRef === "task.turn:turn_1");
    expect(history?.content).toContain("当前电脑可以部署 Duix-Avatar 吗");
    expect(history?.content).toContain("system_info");
    expect(history?.content).toContain("darwin");
    expect(history?.content).toContain("arm64");
    expect(history?.content).toContain("Duix-Avatar 不适合直接走 CUDA 本地部署");
  });

  it("keeps every uncompacted turn even beyond the legacy five-turn limit", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", workspace, "active", "2026-01-01T00:00:00.000Z");
    const turns = new TurnManager(storage);
    const older = Array.from({ length: 7 }, (_, index) => {
      const turn = turns.create("ses", "task", `历史 ${index + 1}`);
      turns.complete(turn.id);
      return turn;
    });
    const current = turns.create("ses", "task", "现在");
    const builder = new ContextBuilder(storage, new SqliteMemoryStore(storage));
    const pack = await builder.build({ sessionId: "ses", taskId: "task", turnId: current.id, input: "现在" });
    expect(pack.items.filter((item) => item.sourceType === "task_turn")).toHaveLength(7);
    expect(pack.items.map((item) => item.sourceRef)).toContain(`task.turn:${older[0].id}`);
    storage.db.close();
  });

  it("replaces covered history with a checkpoint while retaining the raw tail", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", workspace, "active", "2026-01-01T00:00:00.000Z");
    const turns = new TurnManager(storage);
    const first = turns.create("ses", "task", "压缩对象"); turns.complete(first.id);
    const second = turns.create("ses", "task", "保留原文"); turns.complete(second.id);
    const current = turns.create("ses", "task", "现在");
    new CompactionStore(storage).append({ taskId: "task", baseCheckpointId: undefined, fromSeq: 1, throughSeq: 1, sourceTurnIds: [first.id], summaryJson: JSON.stringify({ goal: { text: "压缩对象", sourceTurnIds: [first.id] }, facts: [], decisions: [], completedWork: [], openIssues: [], constraints: [], sourceTurnIds: [first.id] }), requestId: "req" });
    const pack = await new ContextBuilder(storage, new SqliteMemoryStore(storage)).build({ sessionId: "ses", taskId: "task", turnId: current.id, input: "现在" });
    expect(pack.items.map((item) => item.sourceType)).toContain("task_compaction");
    expect(pack.items.map((item) => item.sourceRef)).toContain(`task.turn:${second.id}`);
    expect(pack.items.map((item) => item.sourceRef)).not.toContain(`task.turn:${first.id}`);
    storage.db.close();
  });

  it("falls back to every original turn when the latest checkpoint is invalid", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", workspace, "active", "2026-01-01T00:00:00.000Z");
    const turns = new TurnManager(storage);
    const first = turns.create("ses", "task", "不能丢的旧事实"); turns.complete(first.id);
    const second = turns.create("ses", "task", "新事实"); turns.complete(second.id);
    const current = turns.create("ses", "task", "继续");
    new CompactionStore(storage).append({ taskId: "task", baseCheckpointId: undefined, fromSeq: 1, throughSeq: 1, sourceTurnIds: [first.id], summaryJson: "broken", requestId: "req" });
    const pack = await new ContextBuilder(storage, new SqliteMemoryStore(storage)).build({ sessionId: "ses", taskId: "task", turnId: current.id, input: "继续" });
    expect(pack.items.some((item) => item.sourceType === "task_compaction")).toBe(false);
    expect(pack.items.map((item) => item.sourceRef)).toContain(`task.turn:${first.id}`);
    expect(pack.items.map((item) => item.sourceRef)).toContain(`task.turn:${second.id}`);
    storage.db.close();
  });

  it("never reads another Task's checkpoint or raw turns", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", workspace, "active", "2026-01-01T00:00:00.000Z");
    const turns = new TurnManager(storage);
    const a = turns.create("ses", "task_a", "A 的私有信息"); turns.complete(a.id);
    new CompactionStore(storage).append({ taskId: "task_a", baseCheckpointId: undefined, fromSeq: 1, throughSeq: 1, sourceTurnIds: [a.id], summaryJson: JSON.stringify({ goal: { text: "A 的私有信息", sourceTurnIds: [a.id] }, facts: [], decisions: [], completedWork: [], openIssues: [], constraints: [], sourceTurnIds: [a.id] }), requestId: "req" });
    const b = turns.create("ses", "task_b", "B 的输入");
    const pack = await new ContextBuilder(storage, new SqliteMemoryStore(storage)).build({ sessionId: "ses", taskId: "task_b", turnId: b.id, input: "B 的输入" });
    expect(pack.items.map((item) => item.content).join("\n")).not.toContain("A 的私有信息");
    expect(pack.items.some((item) => item.sourceType === "task_compaction")).toBe(false);
    storage.db.close();
  });
});
