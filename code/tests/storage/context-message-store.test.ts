import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ContextMessageStore } from "../../src/context/context-message-store.js";
import { StorageManager } from "../../src/storage/storage-manager.js";
let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it("消息快照原样追加，稳定引用幂等且拒绝改写，省略只改变投影标记", async () => {
  root = await mkdtemp(join(tmpdir(), "figo-context-message-"));
  const storage = await StorageManager.init(root);
  try {
    storage.db.prepare("insert into sessions (id,cwd,status,started_at) values ('s',?,'active','now')").run(root);
    storage.db.prepare("insert into turns (id,session_id,task_id,input,status,created_at) values ('t','s','task','input','processing','now')").run();
    const store = new ContextMessageStore(storage);
    const entry = { sourceRef: "request:r:response", turnId: "t", message: { role: "assistant" as const, content: "sk-example-secret-content" }, usageScope: "scope", stopReason: "stop" as const };
    store.append("task", [entry]);
    store.append("task", [entry]);
    expect(() => store.append("task", [{ ...entry, message: { ...entry.message, content: "rewritten" } }])).toThrow();
    expect(() => store.append("other-task", [entry])).toThrow();
    expect(() => store.append("other-task", [{ ...entry, sourceRef: "request:another:response" }])).toThrow();
    expect(storage.db.prepare("select count(*) as count from context_messages").get()).toMatchObject({ count: 1 });
    store.omit("task", [entry.sourceRef]);
    expect(storage.db.prepare("select message_json, omitted from context_messages").get()).toMatchObject({ message_json: JSON.stringify(entry.message), omitted: 1 });
  } finally { storage.db.close(); }
});
