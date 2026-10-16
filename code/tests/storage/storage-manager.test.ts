import { mkdtemp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TestDatabases } from "../helpers/test-databases.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const databases = new TestDatabases();
let workspace = "";

afterEach(async () => {
  databases.close();
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("StorageManager", () => {
  it("initializes database, artifact directories, tables, and indexes", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = databases.track(await StorageManager.init(workspace));

    expect(storage.paths.agentRoot).toContain(".figo-agent");
    expect(storage.db.prepare("pragma busy_timeout").get()).toEqual({ timeout: 5000 });
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

  it("applies the configured SQLite lock wait to its connection", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-storage-timeout-"));
    const storage = databases.track(await StorageManager.init(workspace, { sqliteBusyTimeoutMs: 2500 }));
    expect(storage.db.prepare("pragma busy_timeout").get()).toEqual({ timeout: 2500 });
    storage.db.close();
  });

  it("writes artifact files and metadata without storing markdown body in sqlite", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = databases.track(await StorageManager.init(workspace));
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
    expect(row.path).toBe(join(".figo-agent", "artifacts", "sessions", "ses_1", "report.md"));
    expect(row.bytes).toBe(8);
  });

  it("rejects artifact paths outside workspace", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = databases.track(await StorageManager.init(workspace));

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
    databases.track({ db });
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
    db.prepare(`insert into llm_http_captures (
      id, session_id, turn_id, request_id, provider, model, url, method,
      request_headers_json, request_body_json, response_status, response_status_text,
      response_headers_json, response_body_json, duration_ms, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("cap_old", "ses_old", "turn_old", "req_old", "minimax", "MiniMax-M3", "https://example.test", "POST",
        "{}", "{}", 200, "OK", "{}", '{"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}', 10,
        "2026-10-10T00:00:00.000Z");
    db.close();

    const storage = databases.track(await StorageManager.init(workspace));

    expect(
      storage.db.prepare("select name from pragma_table_info('turns') where name = ?").get("task_id")
    ).toBeTruthy();
    expect(
      storage.db
        .prepare("select name from sqlite_master where type='index' and name='idx_turns_task_created'")
        .get()
    ).toBeTruthy();
    expect(storage.db.prepare("select purpose, prompt_tokens, completion_tokens, total_tokens, created_at from token_usage where request_id = ?").get("req_old"))
      .toEqual({ purpose: "turn", prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, created_at: "2026-10-10 08:00:00.000" });
  });

  it("converts existing UTC timestamp columns to Shanghai time once", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const first = databases.track(await StorageManager.init(workspace));
    first.db.prepare("insert into sessions (id, cwd, status, started_at, ended_at) values (?, ?, ?, ?, ?)")
      .run("ses_1", workspace, "ended", "2026-10-11T11:26:44.601Z", "2026-10-11T11:27:00.000Z");
    first.db.prepare("insert into trace_events (id, session_id, type, source, payload_json, created_at) values (?, ?, ?, ?, ?, ?)")
      .run("trace_1", "ses_1", "test", "test", "{}", "2026-10-11T11:26:44.602Z");
    first.db.exec("pragma user_version = 0");
    first.db.close();

    const second = databases.track(await StorageManager.init(workspace));
    expect(second.db.prepare("select started_at, ended_at from sessions where id = ?").get("ses_1"))
      .toEqual({ started_at: "2026-10-11 19:26:44.601", ended_at: "2026-10-11 19:27:00.000" });
    expect(second.db.prepare("select created_at from trace_events where id = ?").get("trace_1"))
      .toEqual({ created_at: "2026-10-11 19:26:44.602" });
    second.db.close();

    const third = databases.track(await StorageManager.init(workspace));
    expect(third.db.prepare("select started_at from sessions where id = ?").get("ses_1"))
      .toEqual({ started_at: "2026-10-11 19:26:44.601" });
    third.db.close();
  });

  it("rolls back timestamp migration when an old value has no timezone", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const first = databases.track(await StorageManager.init(workspace));
    first.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)")
      .run("ses_1", workspace, "active", "2026-10-11T11:26:44.601Z");
    first.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)")
      .run("ses_2", workspace, "active", "2026-10-11 11:26:44");
    first.db.exec("pragma user_version = 0");
    first.db.close();

    await expect(StorageManager.init(workspace)).rejects.toThrow("无法迁移时间字段 sessions.started_at");
    const db = new DatabaseSync(join(workspace, ".figo-agent", "figo-agent.db"));
    databases.track({ db });
    expect(db.prepare("select started_at from sessions where id = ?").get("ses_1"))
      .toEqual({ started_at: "2026-10-11T11:26:44.601Z" });
    expect(db.prepare("pragma user_version").get()).toEqual({ user_version: 0 });
    db.close();
    // Windows 仍有任何连接持有文件时，重命名会失败。
    const databasePath = join(workspace, ".figo-agent", "figo-agent.db");
    await expect(rename(databasePath, `${databasePath}.released`)).resolves.toBeUndefined();
  });

  it("migrates version 1 Shanghai ISO timestamps without changing the instant", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const first = databases.track(await StorageManager.init(workspace));
    first.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)")
      .run("ses_1", workspace, "active", "2026-10-11T00:31:23.348+08:00");
    first.db.exec("pragma user_version = 1");
    first.db.close();

    const second = databases.track(await StorageManager.init(workspace));
    expect(second.db.prepare("select started_at from sessions where id = ?").get("ses_1"))
      .toEqual({ started_at: "2026-10-11 00:31:23.348" });
    expect(second.db.prepare("pragma user_version").get()).toEqual({ user_version: 2 });
    second.db.close();
  });
});
