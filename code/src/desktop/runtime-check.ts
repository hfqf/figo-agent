import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface SqliteRuntimeInfo {
  node: string;
  sqlite: string;
  electron?: string;
}

export async function verifySqliteRuntime(): Promise<SqliteRuntimeInfo> {
  const root = await mkdtemp(join(tmpdir(), "figo-sqlite-smoke-"));
  try {
    let sqlite = "";
    for (const path of [":memory:", join(root, "smoke.db")]) {
      const db = new DatabaseSync(path);
      try {
        db.exec("create table smoke (id integer primary key, value text not null)");
        db.prepare("insert into smoke (value) values (?)").run("ok");
        const row = db.prepare("select value from smoke").get() as { value: string };
        if (row.value !== "ok") throw new Error("SQLite 读写校验失败。");
        sqlite = (db.prepare("select sqlite_version() as version").get() as { version: string }).version;
      } finally { db.close(); }
    }
    return { node: process.version, sqlite, electron: process.versions.electron };
  } finally { await rm(root, { recursive: true, force: true }); }
}
