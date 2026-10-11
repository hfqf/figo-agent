import type { StorageManager } from "../storage/storage-manager.js";

export interface MemoryRecord {
  id: string;
  scope: string;
  key: string;
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

interface MemoryRow {
  id: string;
  scope: string;
  key: string;
  content: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export class SqliteMemoryStore {
  constructor(private readonly storage: StorageManager) {}

  async search(scopes: string[]): Promise<MemoryRecord[]> {
    if (scopes.length === 0) return [];
    const placeholders = scopes.map(() => "?").join(", ");
    const rows = this.storage.db
      .prepare(
        `select id, scope, key, content, source, created_at, updated_at
         from memory_records
         where scope in (${placeholders})
         order by updated_at desc`
      )
      .all(...scopes) as unknown as MemoryRow[];

    return rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      key: row.key,
      content: row.content,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }
}
