import type { DatabaseSync } from "node:sqlite";
import { formatShanghaiTime } from "../utils/clock.js";

const timestampVersion = 2;

export function migrateTimestamps(db: DatabaseSync): void {
  const { user_version: version } = db.prepare("pragma user_version").get() as { user_version: number };
  if (version >= timestampVersion) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    const tables = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
      .all() as Array<{ name: string }>;
    for (const { name: table } of tables) {
      const columns = db.prepare(`pragma table_info(${quoteIdentifier(table)})`)
        .all() as Array<{ name: string }>;
      for (const { name: column } of columns.filter((entry) => entry.name.endsWith("_at"))) {
        const rows = db.prepare(`select rowid as row_id, ${quoteIdentifier(column)} as value from ${quoteIdentifier(table)} where ${quoteIdentifier(column)} is not null`)
          .all() as Array<{ row_id: number; value: string }>;
        const update = db.prepare(`update ${quoteIdentifier(table)} set ${quoteIdentifier(column)} = ? where rowid = ?`);
        for (const row of rows) {
          if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(row.value)) continue;
          if (typeof row.value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.value)) {
            throw new Error(`无法迁移时间字段 ${table}.${column}，rowid=${row.row_id}`);
          }
          const date = new Date(row.value);
          if (!Number.isFinite(date.getTime())) {
            throw new Error(`无法迁移时间字段 ${table}.${column}，rowid=${row.row_id}`);
          }
          update.run(formatShanghaiTime(date), row.row_id);
        }
      }
    }
    db.exec(`pragma user_version = ${timestampVersion}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
