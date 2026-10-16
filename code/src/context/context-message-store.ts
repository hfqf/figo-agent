import type { StorageManager } from "../storage/storage-manager.js";
import type { ConversationMessage } from "./conversation-message.js";
import { nowShanghaiTime } from "../utils/clock.js";

export class ContextMessageStore {
  constructor(private readonly storage: StorageManager) {}

  append(taskId: string, entries: ConversationMessage[]): void {
    const db = this.storage.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        const owner = db.prepare("select task_id from turns where id = ?").get(entry.turnId) as { task_id: string } | undefined;
        if (!owner || owner.task_id !== taskId) throw new Error("上下文消息不属于当前 Task");
        const message = JSON.stringify(entry.message);
        const usage = entry.usage ? JSON.stringify(entry.usage) : null;
        const existing = db.prepare("select task_id,turn_id,message_json,usage_json,usage_scope,stop_reason from context_messages where source_ref = ?").get(entry.sourceRef) as Record<string, unknown> | undefined;
        if (existing) {
          if (existing.task_id !== taskId || existing.turn_id !== entry.turnId || existing.message_json !== message ||
              existing.usage_json !== usage || existing.usage_scope !== (entry.usageScope ?? null) || existing.stop_reason !== (entry.stopReason ?? null)) throw new Error("上下文消息引用已存在且内容不一致");
          continue;
        }
        db.prepare("insert into context_messages (source_ref,task_id,turn_id,message_json,usage_json,usage_scope,stop_reason,omitted,created_at) values (?,?,?,?,?,?,?,?,?)")
          .run(entry.sourceRef, taskId, entry.turnId, message, usage, entry.usageScope ?? null, entry.stopReason ?? null, entry.omitted ? 1 : 0, nowShanghaiTime());
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  omit(taskId: string, sourceRefs: string[]): void {
    const update = this.storage.db.prepare("update context_messages set omitted = 1 where task_id = ? and source_ref = ?");
    for (const sourceRef of sourceRefs) update.run(taskId, sourceRef);
  }
}
