import { createRequire } from "node:module";
import { expect, it } from "vitest";
import type { StorageManager } from "../../src/storage/storage-manager.js";
import { TraceInspectorReader } from "../../src/ui/trace-inspector-reader.js";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

it("超长正文先脱敏再截断，不能泄露跨输出边界的已配置密钥前缀", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("create table context_items (id text, content text)");
    const secret = "private-credential-for-boundary-test";
    const insert = db.prepare("insert into context_items values (?, ?)");
    const guard = 128;
    for (const edge of [16384 - guard, 16384, 16384 + guard]) {
      insert.run(String(edge), "x".repeat(edge - 6) + secret + "z".repeat(20000));
    }
    insert.run("many-secrets", secret.repeat(50) + "x".repeat(16384 - secret.length * 50 + guard - 6) + secret + "z".repeat(20000));
    const reader = new TraceInspectorReader({ db } as StorageManager, [secret]);
    const rows = reader.rows("context_items", "1=1", []);
    expect(reader.truncated).toBe(false);
    for (const row of rows) {
      expect(JSON.stringify(row.content).includes(secret.slice(0, 6))).toBe(false);
      expect(row.content).toMatchObject({ __inspectorField: true, loadable: true });
      expect((row.content as { preview: string }).preview.length).toBeLessThanOrEqual(16384);
    }
  } finally { db.close(); }
});
