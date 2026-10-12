import type { Turn } from "../contracts/types.js";
import type { StorageManager } from "../storage/storage-manager.js";
import { nowShanghaiTime } from "../utils/clock.js";
import { createId } from "../utils/id.js";

export class TurnManager {
  constructor(private readonly storage: StorageManager) {}

  create(sessionId: string, taskId: string, input: string): Turn {
    this.storage.db.exec("BEGIN IMMEDIATE");
    try {
      const turn = this.createWithinTransaction(sessionId, taskId, input);
      this.storage.db.exec("COMMIT");
      return turn;
    } catch (error) {
      this.storage.db.exec("ROLLBACK");
      throw error;
    }
  }

  createWithinTransaction(sessionId: string, taskId: string, input: string): Turn {
    const turn: Turn = {
      id: createId("turn"),
      sessionId,
      taskId,
      input,
      status: "received",
      createdAt: nowShanghaiTime()
    };
    const row = this.storage.db.prepare(
      "select coalesce(max(task_seq), 0) + 1 as next_seq from turns where task_id = ?"
    ).get(taskId) as { next_seq: number };
    this.storage.db.prepare(
      "insert into turns (id, session_id, task_id, task_seq, input, status, created_at) values (?, ?, ?, ?, ?, ?, ?)"
    ).run(turn.id, turn.sessionId, turn.taskId, row.next_seq, turn.input, turn.status, turn.createdAt);
    return turn;
  }

  markProcessing(turnId: string): void {
    this.storage.db.prepare("update turns set status = ? where id = ?").run("processing", turnId);
  }

  complete(turnId: string): void {
    this.storage.db
      .prepare("update turns set status = ?, completed_at = ? where id = ?")
      .run("completed", nowShanghaiTime(), turnId);
  }

  fail(turnId: string): void {
    this.storage.db
      .prepare("update turns set status = ?, completed_at = ? where id = ?")
      .run("failed", nowShanghaiTime(), turnId);
  }
}
