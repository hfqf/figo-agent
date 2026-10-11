import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TurnManager } from "../../src/kernel/turn-manager.js";
import { StorageManager } from "../../src/storage/storage-manager.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

describe("TurnManager task order", () => {
  it("allocates a monotonic sequence for each Task", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-turn-seq-"));
    const storage = await StorageManager.init(root);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses", root, "active", "2026-01-01T00:00:00.000Z");
    const manager = new TurnManager(storage);
    manager.create("ses", "task_a", "a1");
    manager.create("ses", "task_b", "b1");
    manager.create("ses", "task_a", "a2");
    expect(storage.db.prepare("select task_id, task_seq from turns order by rowid").all()).toEqual([
      { task_id: "task_a", task_seq: 1 },
      { task_id: "task_b", task_seq: 1 },
      { task_id: "task_a", task_seq: 2 }
    ]);
    storage.db.close();
  });
});
