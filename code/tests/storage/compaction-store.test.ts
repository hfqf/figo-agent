import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TurnManager } from "../../src/kernel/turn-manager.js";
import { CompactionStore } from "../../src/context/compaction-store.js";
import { StorageManager } from "../../src/storage/storage-manager.js";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("CompactionStore", () => {
  it("assigns stable per-task sequence numbers and persists checkpoints across reopen", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-compaction-"));
    const storage = await StorageManager.init(root);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses_1", root, "active", "2026-01-01T00:00:00.000Z");
    const turns = new TurnManager(storage);
    const a = turns.create("ses_1", "task_a", "first");
    const b = turns.create("ses_1", "task_a", "second");
    const c = turns.create("ses_1", "task_b", "other");
    turns.complete(a.id);
    turns.complete(b.id);
    turns.complete(c.id);
    expect(storage.db.prepare("select task_seq from turns where id = ?").get(a.id)).toMatchObject({ task_seq: 1 });
    expect(storage.db.prepare("select task_seq from turns where id = ?").get(b.id)).toMatchObject({ task_seq: 2 });
    expect(storage.db.prepare("select task_seq from turns where id = ?").get(c.id)).toMatchObject({ task_seq: 1 });

    const store = new CompactionStore(storage);
    const first = store.append({ taskId: "task_a", baseCheckpointId: undefined, fromSeq: 1, throughSeq: 1, sourceTurnIds: [a.id], summaryJson: "{}", requestId: "req_1" });
    expect(store.latest("task_a")?.id).toBe(first.id);
    expect(() => store.append({ taskId: "task_a", baseCheckpointId: undefined, fromSeq: 1, throughSeq: 1, sourceTurnIds: [a.id], summaryJson: "{}", requestId: "req_2" })).toThrow();
    const second = store.append({ taskId: "task_a", baseCheckpointId: first.id, fromSeq: 2, throughSeq: 2, sourceTurnIds: [b.id], summaryJson: "{}", requestId: "req_3" });
    expect(second.throughSeq).toBe(2);
    expect(store.latest("task_b")).toBeUndefined();
    storage.db.close();

    const reopened = await StorageManager.init(root);
    expect(new CompactionStore(reopened).latest("task_a")?.id).toBe(second.id);
    expect(reopened.db.prepare("select task_seq from turns where id = ?").get(a.id)).toMatchObject({ task_seq: 1 });
    reopened.db.close();
  });

  it("backfills legacy turns without sequence numbers", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-compaction-"));
    const storage = await StorageManager.init(root);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", root, "active", "2026-01-01T00:00:00.000Z");
    storage.db.prepare("insert into turns (id, session_id, task_id, input, status, created_at) values (?, ?, ?, ?, ?, ?)").run("old_1", "ses", "task", "one", "completed", "2026-01-01T00:00:00.000Z");
    storage.db.prepare("insert into turns (id, session_id, task_id, input, status, created_at) values (?, ?, ?, ?, ?, ?)").run("old_2", "ses", "task", "two", "completed", "2026-01-01T00:00:00.000Z");
    storage.db.close();
    const reopened = await StorageManager.init(root);
    expect(reopened.db.prepare("select id, task_seq from turns where task_id = ? order by task_seq").all("task")).toEqual([
      { id: "old_1", task_seq: 1 },
      { id: "old_2", task_seq: 2 }
    ]);
    reopened.db.close();
  });

  it("backfills a mixed old/new task without colliding with existing sequence numbers", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-compaction-"));
    const storage = await StorageManager.init(root);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", root, "active", "2026-01-01T00:00:00.000Z");
    storage.db.prepare("insert into turns (id, session_id, task_id, task_seq, input, status, created_at) values (?, ?, ?, ?, ?, ?, ?)").run("new", "ses", "task", 1, "new", "completed", "2026-01-02T00:00:00.000Z");
    storage.db.prepare("insert into turns (id, session_id, task_id, input, status, created_at) values (?, ?, ?, ?, ?, ?)").run("old", "ses", "task", "old", "completed", "2026-01-01T00:00:00.000Z");
    storage.db.close();
    const reopened = await StorageManager.init(root);
    expect(reopened.db.prepare("select task_seq from turns where id = 'old'").get()).toMatchObject({ task_seq: 2 });
    reopened.db.close();
  });
});
