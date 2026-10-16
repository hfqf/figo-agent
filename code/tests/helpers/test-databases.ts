import type { DatabaseSync } from "node:sqlite";

/** 测试显式登记自己持有的连接；清理时先关库，再删除临时目录。 */
export class TestDatabases {
  private readonly databases = new Set<DatabaseSync>();

  track<T extends { db: DatabaseSync }>(owner: T): T {
    this.databases.add(owner.db);
    return owner;
  }

  close(): void {
    for (const db of this.databases) {
      if (db.isOpen) db.close();
    }
    this.databases.clear();
  }
}
