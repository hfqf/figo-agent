import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TaskManager } from "../../src/task/task-manager.js";

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("TaskManager", () => {
  it("keeps an explicit current task when updates share the same millisecond", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)")
      .run("ses_1", workspace, "active", "2026-10-12 08:00:00.000");
    const manager = new TaskManager(storage);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T00:00:00.000Z"));
    try {
      const first = manager.create("ses_1", "第一项");
      manager.create("ses_1", "第二项");
      manager.switch(first.id);
      expect(manager.getCurrent("ses_1").id).toBe(first.id);
    } finally { vi.useRealTimers(); }
  });
  it("creates a default active task and returns it as current task", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);
    storage.db
      .prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)")
      .run("ses_1", workspace, "active", "2026-10-11T00:00:00.000Z");
    const manager = new TaskManager(storage);

    const task = manager.createDefault("ses_1");
    const current = manager.getCurrent("ses_1");

    expect(task.title).toBe("default");
    expect(task.status).toBe("active");
    expect(current.id).toBe(task.id);
    expect(storage.db.prepare("select session_id, status, title from tasks where id = ?").get(task.id)).toMatchObject({
      session_id: "ses_1",
      status: "active",
      title: "default"
    });
  });

  it("supports new, switch, pause, resume, finish, and cancel lifecycle commands", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);
    storage.db
      .prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)")
      .run("ses_1", workspace, "active", "2026-10-11T00:00:00.000Z");
    const manager = new TaskManager(storage);

    const first = manager.createDefault("ses_1");
    const second = manager.create("ses_1", "梳理 Task 设计");
    expect(manager.getCurrent("ses_1").id).toBe(second.id);
    expect(manager.listRunnable("ses_1").map((task) => task.id)).toEqual([first.id, second.id]);

    manager.switch(second.id);
    manager.pause(second.id);
    expect(manager.getCurrent("ses_1").status).toBe("paused");
    expect(() => manager.requireActiveCurrent("ses_1")).toThrow("当前 Task 状态为 paused，不能接收普通输入。");

    manager.resume(second.id);
    expect(manager.requireActiveCurrent("ses_1").status).toBe("active");

    manager.finish(second.id);
    expect(storage.db.prepare("select status from tasks where id = ?").get(second.id)).toMatchObject({
      status: "completed"
    });
    expect(() => manager.switch(second.id)).toThrow("只能切换到 active 或 paused Task。");

    manager.switch(first.id);
    manager.cancel(first.id, "用户取消");
    expect(storage.db.prepare("select status, close_reason from tasks where id = ?").get(first.id)).toMatchObject({
      status: "cancelled",
      close_reason: "用户取消"
    });
  });
});
