import { createRequire } from "node:module";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { nowShanghaiTime } from "../utils/clock.js";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export async function resolveWorkspace(input: string): Promise<string> {
  if (!input.trim() || !isAbsolute(input) || input.includes("\0")) throw new Error("工作区路径必须是绝对目录。");
  let path: string;
  try {
    path = await realpath(input);
    if (!(await stat(path)).isDirectory()) throw new Error("工作区路径不是目录。");
  } catch (error) {
    if (error instanceof Error && error.message === "工作区路径不是目录。") throw error;
    throw new Error("工作区目录不存在或无法访问。");
  }
  return path;
}

export class WorkspaceRegistry {
  private constructor(private readonly db: DatabaseSyncType) {}

  static async open(configRoot: string): Promise<WorkspaceRegistry> {
    const root = join(configRoot, ".figo-agent");
    await mkdir(root, { recursive: true });
    const db = new DatabaseSync(join(root, "workspaces.db"));
    db.exec("create table if not exists workspaces (path text primary key, opened_at text not null, visit_order integer not null)");
    return new WorkspaceRegistry(db);
  }

  recent(): string[] {
    return (this.db.prepare("select path from workspaces order by visit_order desc limit 10").all() as Array<{ path: string }>).map((row) => row.path);
  }

  record(path: string): void {
    this.db.prepare("insert into workspaces (path, opened_at, visit_order) values (?, ?, (select coalesce(max(visit_order), 0) + 1 from workspaces)) on conflict(path) do update set opened_at = excluded.opened_at, visit_order = excluded.visit_order")
      .run(path, nowShanghaiTime());
  }

  close(): void { this.db.close(); }
}
