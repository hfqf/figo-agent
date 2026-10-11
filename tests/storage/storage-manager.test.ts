import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StorageManager } from "../../src/storage/storage-manager.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("StorageManager", () => {
  it("initializes database, artifact directories, tables, and indexes", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);

    expect(storage.paths.agentRoot).toContain(".figo-agent");
    expect(
      storage.db
        .prepare("select name from sqlite_master where type='table' and name='sessions'")
        .get()
    ).toBeTruthy();
    expect(
      storage.db
        .prepare("select name from sqlite_master where type='index' and name='idx_trace_events_session_created'")
        .get()
    ).toBeTruthy();
  });

  it("writes artifact files and metadata without storing markdown body in sqlite", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);
    storage.db
      .prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)")
      .run("ses_1", workspace, "active", "2026-10-10T00:00:00.000Z");

    const artifact = await storage.writeArtifact({
      id: "art_1",
      sessionId: "ses_1",
      type: "report",
      path: ".figo-agent/artifacts/sessions/ses_1/report.md",
      content: "# 报告"
    });

    expect(artifact.bytes).toBeGreaterThan(0);
    await expect(readFile(join(workspace, artifact.path), "utf8")).resolves.toContain("# 报告");

    const row = storage.db
      .prepare("select path, bytes from artifacts where id = ?")
      .get("art_1") as { path: string; bytes: number };
    expect(row.path).toBe(".figo-agent/artifacts/sessions/ses_1/report.md");
    expect(row.bytes).toBe(8);
  });

  it("rejects artifact paths outside workspace", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);

    await expect(
      storage.writeArtifact({
        id: "art_2",
        sessionId: "ses_1",
        type: "report",
        path: "../report.md",
        content: "# 越界"
      })
    ).rejects.toThrow("path outside workspace");
  });

  it("migrates an existing V1 database before creating task_id indexes", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await mkdir(join(workspace, ".figo-agent"), { recursive: true });
    const db = new DatabaseSync(join(workspace, ".figo-agent", "figo-agent.db"));
    db.exec(`
CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT);
CREATE TABLE context_packs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, estimated_tokens INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE trace_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, type TEXT NOT NULL, source TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, type TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE llm_http_captures (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  request_body_json TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_status_text TEXT NOT NULL,
  response_headers_json TEXT NOT NULL,
  response_body_json TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`);
    db.close();

    const storage = await StorageManager.init(workspace);

    expect(
      storage.db.prepare("select name from pragma_table_info('turns') where name = ?").get("task_id")
    ).toBeTruthy();
    expect(
      storage.db
        .prepare("select name from sqlite_master where type='index' and name='idx_turns_task_created'")
        .get()
    ).toBeTruthy();
  });
});
