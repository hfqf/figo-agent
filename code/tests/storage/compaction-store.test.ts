import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TurnManager } from "../../src/kernel/turn-manager.js";
import { CompactionStore, type AppendContextCompactionEntryInput } from "../../src/context/compaction-store.js";
import { StorageManager } from "../../src/storage/storage-manager.js";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

async function entryStorage() {
  root = await mkdtemp(join(tmpdir(), "figo-compaction-entry-"));
  const storage = await StorageManager.init(root);
  storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)")
    .run("ses", root, "active", "2026-10-15 12:00:00.000");
  const insertTask = storage.db.prepare("insert into tasks (id, session_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)");
  for (const id of ["task_a", "task_b"]) insertTask.run(id, "ses", id, "active", "2026-10-15 12:00:00.000", "2026-10-15 12:00:00.000");
  return storage;
}

function entryInput(overrides: Partial<AppendContextCompactionEntryInput> = {}): AppendContextCompactionEntryInput {
  return {
    taskId: "task_a", firstKeptSourceRef: "turn:kept", coveredSourceRefs: ["turn:first", "tool:call_1"],
    summaryMarkdown: "## Goal\n继续实现压缩", details: { readFiles: ["readme.md"], modifiedFiles: ["src/index.ts"], custom: { strategy: "pi" } },
    tokensBefore: 1234, requestId: "req_entry", ...overrides
  };
}

describe("CompactionStore entries", () => {
  it("persists Markdown entries and metadata with independent per-task sequence numbers", async () => {
    const storage = await entryStorage();
    try {
      const store = new CompactionStore(storage);
      expect(store.latestEntry("task_a")).toBeUndefined();
      const first = store.appendEntry(entryInput());
      expect(first).toMatchObject({ ...entryInput(), seq: 1 });
      expect(first.id).toEqual(expect.any(String));
      expect(first.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
      expect(store.latestEntry("task_a")).toEqual(first);
      const second = store.appendEntry(entryInput({ baseEntryId: first.id, requestId: "req_next", tokensBefore: 0 }));
      const other = store.appendEntry(entryInput({ taskId: "task_b" }));
      expect(second.seq).toBe(2);
      expect(other.seq).toBe(1);
      expect(store.latestEntry("task_b")).toEqual(other);
      const row = storage.db.prepare("select * from context_compactions where id = ?").get(second.id);
      expect(row).toMatchObject({ task_id: "task_a", seq: 2, base_entry_id: first.id,
        first_kept_source_ref: "turn:kept", source_refs_json: JSON.stringify(second.coveredSourceRefs),
        summary_markdown: second.summaryMarkdown, details_json: JSON.stringify(second.details),
        tokens_before: 0, request_id: "req_next", created_at: second.createdAt });
      expect(store.latest("task_a")).toBeUndefined();
      storage.db.close();
      const reopened = await StorageManager.init(root);
      try {
        expect(new CompactionStore(reopened).latestEntry("task_a")).toEqual(second);
        expect(reopened.db.prepare("select count(*) as count from context_compactions").get()).toMatchObject({ count: 3 });
      } finally { reopened.db.close(); }
    } finally { if (storage.db.isOpen) storage.db.close(); }
  });

  it("checks the latest base across two connections and rolls back stale appends", async () => {
    const storage = await entryStorage();
    const competing = await StorageManager.init(root);
    try {
      const store = new CompactionStore(storage);
      const other = new CompactionStore(competing);
      const first = store.appendEntry(entryInput());
      const second = other.appendEntry(entryInput({ baseEntryId: first.id, requestId: "req_second" }));
      expect(() => store.appendEntry(entryInput({ baseEntryId: first.id }))).toThrow(/base changed/);
      expect(() => store.appendEntry(entryInput())).toThrow(/base changed/);
      expect(store.latestEntry("task_a")).toEqual(second);
      expect(store.appendEntry(entryInput({ baseEntryId: second.id })).seq).toBe(3);
      expect(storage.db.prepare("select count(*) as count from context_compactions").get()).toMatchObject({ count: 3 });
    } finally { competing.db.close(); storage.db.close(); }
  });

  it("supports an explicit ID as the retained-none source reference and rolls back duplicate IDs", async () => {
    const storage = await entryStorage();
    try {
      const store = new CompactionStore(storage);
      const first = store.appendEntry(entryInput({ id: "compact_self", firstKeptSourceRef: "compact_self" }));
      expect(first.id).toBe("compact_self");
      expect(store.latestEntry("task_a")?.firstKeptSourceRef).toBe(first.id);
      expect(() => store.appendEntry(entryInput({ id: first.id, baseEntryId: first.id }))).toThrow();
      expect(store.appendEntry(entryInput({ baseEntryId: first.id })).seq).toBe(2);
    } finally { storage.db.close(); }
  });

  it.each([
    { taskId: "" }, { id: " " }, { firstKeptSourceRef: "" }, { firstKeptSourceRef: " " },
    { coveredSourceRefs: [] }, { coveredSourceRefs: [""] }, { coveredSourceRefs: ["valid", " "] },
    { coveredSourceRefs: null }, { coveredSourceRefs: [1] },
    { summaryMarkdown: "" }, { summaryMarkdown: "\n " }, { requestId: "" }, { requestId: " " },
    { tokensBefore: -1 }, { tokensBefore: Number.NaN }, { tokensBefore: Number.POSITIVE_INFINITY },
    { tokensBefore: Number.NEGATIVE_INFINITY }, { tokensBefore: "123" },
    { details: null }, { details: { readFiles: [], modifiedFiles: "file" } },
    { details: { readFiles: [1], modifiedFiles: [] } }
  ])("rejects invalid entry input without inserting or consuming a sequence: %j", async (invalid) => {
    const storage = await entryStorage();
    try {
      const store = new CompactionStore(storage);
      expect(() => store.appendEntry(entryInput(invalid as Partial<AppendContextCompactionEntryInput>))).toThrow();
      expect(store.latestEntry("task_a")).toBeUndefined();
      expect(store.appendEntry(entryInput()).seq).toBe(1);
    } finally { storage.db.close(); }
  });

  it("enforces Task ownership through a foreign key and rejects another task's base", async () => {
    const storage = await entryStorage();
    try {
      const store = new CompactionStore(storage);
      expect(() => store.appendEntry(entryInput({ taskId: "missing" }))).toThrow(/FOREIGN KEY/);
      const first = store.appendEntry(entryInput());
      expect(() => store.appendEntry(entryInput({ taskId: "task_b", baseEntryId: first.id }))).toThrow(/base changed/);
      expect(() => storage.db.prepare("update context_compactions set task_id = ? where id = ?").run("missing", first.id)).toThrow(/FOREIGN KEY/);
      expect(store.appendEntry(entryInput({ taskId: "task_b" })).seq).toBe(1);
    } finally { storage.db.close(); }
  });

  it("preserves original turns and legacy checkpoints while appending new entries", async () => {
    const storage = await entryStorage();
    try {
      const turns = new TurnManager(storage);
      const turn = turns.create("ses", "task_a", "原始用户输入");
      turns.complete(turn.id);
      const store = new CompactionStore(storage);
      const legacy = store.append({ taskId: "task_a", fromSeq: 1, throughSeq: 1, sourceTurnIds: [turn.id], summaryJson: "{}", requestId: "legacy" });
      const original = storage.db.prepare("select * from turns where id = ?").get(turn.id);
      const first = store.appendEntry(entryInput({ coveredSourceRefs: [turn.id] }));
      store.appendEntry(entryInput({ baseEntryId: first.id }));
      expect(storage.db.prepare("select * from turns where id = ?").get(turn.id)).toEqual(original);
      expect(store.latest("task_a")).toEqual(legacy);
      expect(storage.db.prepare("select summary_markdown from context_compactions where id = ?").get(first.id))
        .toMatchObject({ summary_markdown: first.summaryMarkdown });
    } finally { storage.db.close(); }
  });
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
