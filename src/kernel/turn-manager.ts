import type { Turn } from "../contracts/types.js";
import type { StorageManager } from "../storage/storage-manager.js";
import { nowIso } from "../utils/clock.js";
import { createId } from "../utils/id.js";

export class TurnManager {
  constructor(private readonly storage: StorageManager) {}

  create(sessionId: string, taskId: string, input: string): Turn {
    const turn: Turn = {
      id: createId("turn"),
      sessionId,
      taskId,
      input,
      status: "received",
      createdAt: nowIso()
    };
    this.storage.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.storage.db.prepare(
        "select coalesce(max(task_seq), 0) + 1 as next_seq from turns where task_id = ?"
      ).get(taskId) as { next_seq: number };
      this.storage.db.prepare(
        "insert into turns (id, session_id, task_id, task_seq, input, status, created_at) values (?, ?, ?, ?, ?, ?, ?)"
      ).run(turn.id, turn.sessionId, turn.taskId, row.next_seq, turn.input, turn.status, turn.createdAt);
      this.storage.db.exec("COMMIT");
    } catch (error) {
      this.storage.db.exec("ROLLBACK");
      throw error;
    }
    return turn;
  }

  markProcessing(turnId: string): void {
    this.storage.db.prepare("update turns set status = ? where id = ?").run("processing", turnId);
  }

  complete(turnId: string): void {
    this.storage.db
      .prepare("update turns set status = ?, completed_at = ? where id = ?")
      .run("completed", nowIso(), turnId);
  }

  fail(turnId: string): void {
    this.storage.db
      .prepare("update turns set status = ?, completed_at = ? where id = ?")
      .run("failed", nowIso(), turnId);
  }
}
