import type { Task, TaskStatus } from "../contracts/types.js";
import type { StorageManager } from "../storage/storage-manager.js";
import { nowShanghaiTime } from "../utils/clock.js";
import { createId } from "../utils/id.js";

type TaskRow = {
  id: string;
  session_id: string;
  title: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  paused_at: string | null;
  resumed_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  archived_at: string | null;
  close_reason: string | null;
};

export class TaskManager {
  constructor(private readonly storage: StorageManager) {}

  createDefault(sessionId: string): Task {
    const existing = this.storage.db
      .prepare("select * from tasks where session_id = ? and title = ? order by created_at limit 1")
      .get(sessionId, "default") as TaskRow | undefined;
    if (existing && ["active", "paused"].includes(existing.status)) {
      this.select(sessionId, existing.id);
      return rowToTask(existing);
    }
    return this.create(sessionId, "default");
  }

  create(sessionId: string, title: string): Task {
    const now = nowShanghaiTime();
    const task: Task = {
      id: createId("task"),
      sessionId,
      title,
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    this.storage.db
      .prepare(
        "insert into tasks (id, session_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)"
      )
      .run(task.id, task.sessionId, task.title, task.status, task.createdAt, task.updatedAt);
    this.select(sessionId, task.id);
    return task;
  }

  getOrCreateActive(sessionId: string): Task {
    const current = this.getCurrentOrUndefined(sessionId);
    if (!current) return this.createDefault(sessionId);
    if (current.status === "active") return current;
    return this.create(sessionId, "default");
  }

  getCurrent(sessionId: string): Task {
    const current = this.getCurrentOrUndefined(sessionId);
    if (!current) return this.createDefault(sessionId);
    return current;
  }

  listRunnable(sessionId: string): Task[] {
    return (
      this.storage.db
        .prepare(
          "select * from tasks where session_id = ? and status in ('active', 'paused') order by created_at"
        )
        .all(sessionId) as TaskRow[]
    ).map(rowToTask);
  }

  switch(taskId: string): Task {
    const task = this.getById(taskId);
    if (!["active", "paused"].includes(task.status)) {
      throw new Error("只能切换到 active 或 paused Task。");
    }
    this.touch(taskId);
    this.select(task.sessionId, taskId);
    return this.getById(taskId);
  }

  pause(taskId: string): Task {
    return this.transition(taskId, "paused", "paused_at");
  }

  resume(taskId: string): Task {
    const task = this.transition(taskId, "active", "resumed_at");
    this.select(task.sessionId, task.id);
    return task;
  }

  finish(taskId: string): Task {
    const task = this.transition(taskId, "completed", "completed_at");
    this.clearSelection(task.sessionId, task.id);
    return task;
  }

  cancel(taskId: string, reason: string): Task {
    const now = nowShanghaiTime();
    this.storage.db
      .prepare(
        "update tasks set status = ?, cancelled_at = ?, updated_at = ?, close_reason = ? where id = ?"
      )
      .run("cancelled", now, now, reason, taskId);
    const task = this.getById(taskId);
    this.clearSelection(task.sessionId, task.id);
    return task;
  }

  requireActiveCurrent(sessionId: string): Task {
    const task = this.getCurrent(sessionId);
    if (task.status !== "active") {
      throw new Error(`当前 Task 状态为 ${task.status}，不能接收普通输入。`);
    }
    return task;
  }

  getById(taskId: string): Task {
    const row = this.storage.db.prepare("select * from tasks where id = ?").get(taskId) as
      | TaskRow
      | undefined;
    if (!row) throw new Error(`Task 不存在：${taskId}`);
    return rowToTask(row);
  }

  private getCurrentOrUndefined(sessionId: string): Task | undefined {
    const selected = this.storage.db.prepare(
      "select t.* from sessions s join tasks t on t.id = s.current_task_id where s.id = ? and t.status in ('active', 'paused')"
    ).get(sessionId) as TaskRow | undefined;
    if (selected) return rowToTask(selected);
    const row = this.storage.db
      .prepare(
        "select * from tasks where session_id = ? and status in ('active', 'paused') order by updated_at desc, rowid desc limit 1"
      )
      .get(sessionId) as TaskRow | undefined;
    if (row) this.select(sessionId, row.id);
    return row ? rowToTask(row) : undefined;
  }

  private select(sessionId: string, taskId: string): void {
    this.storage.db.prepare("update sessions set current_task_id = ? where id = ?").run(taskId, sessionId);
  }

  private clearSelection(sessionId: string, taskId: string): void {
    this.storage.db.prepare("update sessions set current_task_id = null where id = ? and current_task_id = ?")
      .run(sessionId, taskId);
  }

  private touch(taskId: string): void {
    this.storage.db.prepare("update tasks set updated_at = ? where id = ?").run(nowShanghaiTime(), taskId);
  }

  private transition(taskId: string, status: TaskStatus, dateColumn: string): Task {
    const now = nowShanghaiTime();
    this.storage.db
      .prepare(`update tasks set status = ?, ${dateColumn} = ?, updated_at = ? where id = ?`)
      .run(status, now, now, taskId);
    return this.getById(taskId);
  }
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pausedAt: row.paused_at ?? undefined,
    resumedAt: row.resumed_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    closeReason: row.close_reason ?? undefined
  };
}
