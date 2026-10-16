import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "../../src/memory/sqlite-memory-store.js";
import { StorageManager } from "../../src/storage/storage-manager.js";

import { TestDatabases } from "../helpers/test-databases.js";

const databases = new TestDatabases();
let workspace = "";

afterEach(async () => {
  databases.close();
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("SqliteMemoryStore", () => {
  it("reads project and user memory ordered by updatedAt without creating records", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = databases.track(await StorageManager.init(workspace));
    storage.db
      .prepare(
        "insert into memory_records (id, scope, key, content, source, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)"
      )
      .run("mem_1", "project", "a", "旧记录", "test", "2026-10-10T00:00:00.000Z", "2026-10-10T00:00:00.000Z");
    storage.db
      .prepare(
        "insert into memory_records (id, scope, key, content, source, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)"
      )
      .run("mem_2", "user", "b", "新记录", "test", "2026-10-10T00:00:00.000Z", "2026-10-11T00:00:00.000Z");

    const store = new SqliteMemoryStore(storage);
    await expect(store.search(["project", "user"])).resolves.toMatchObject([
      { id: "mem_2", scope: "user", content: "新记录" },
      { id: "mem_1", scope: "project", content: "旧记录" }
    ]);
    await expect(store.search(["session"])).resolves.toEqual([]);

    const count = storage.db.prepare("select count(*) as count from memory_records").get() as {
      count: number;
    };
    expect(count.count).toBe(2);
  });
});
