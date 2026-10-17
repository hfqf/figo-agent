import { describe, expect, it } from "vitest";
import { defaultTaskListSettings } from "../../src/config/task-list-settings.js";
import { decodeTaskView, relativeTaskTime, taskListPath, taskViewKey } from "../../web/src/task-sidebar-state.js";

describe("任务窗口视图状态", () => {
  it("工作区使用独立的偏好键", () => {
    expect(taskViewKey("/work/one")).not.toBe(taskViewKey("/work/two"));
  });
  it("只接受有归属、版本及合法视图的偏好，不将列表偏好当权限", () => {
    const value = { version: 1, sessionId: "ses_old", taskId: "task_old", view: "conversation", historyOpen: true, listMode: "all" };
    expect(decodeTaskView(JSON.stringify(value))).toEqual(value);
    for (const raw of [null, "{", "null", "[]", JSON.stringify({ ...value, version: 2 }), JSON.stringify({ ...value, view: "other" }), JSON.stringify({ ...value, taskId: "" })]) {
      expect(decodeTaskView(raw)).toBeNull();
    }
  });
  it("列表按配置生成查询，搜索使用URL编码而不是拼接", () => {
    const url = new URL(taskListPath({ mode: "recent", page: 1, q: "" }, defaultTaskListSettings), "http://localhost");
    expect(url.pathname).toBe("/api/v1/tasks");
    expect(url.searchParams.get("limit")).toBe(String(defaultTaskListSettings.recentLimit));
    const all = new URL(taskListPath({ mode: "all", page: 2, q: "a&b/中文" }, { ...defaultTaskListSettings, pageSize: 17 }), "http://localhost");
    expect(all.searchParams.get("page")).toBe("2");
    expect(all.searchParams.get("limit")).toBe("17");
    expect(all.searchParams.get("q")).toBe("a&b/中文");
  });
});

describe("任务相对时间", () => {
  const now = Date.parse("2026-10-17T12:00:00+08:00");
  it.each([
    ["2026-10-17 11:59:59.000", "刚刚"],
    ["2026-10-17 11:57:00.000", "3分"],
    ["2026-10-17 10:00:00.000", "2时"],
    ["2026-10-15 12:00:00.000", "2天"],
    ["2026-10-03 12:00:00.000", "2周"],
    ["2026-09-17 12:00:00.000", "1月"],
    ["2025-10-17 12:00:00.000", "1年"],
    ["2026-10-18 12:00:00.000", "刚刚"],
    ["unknown", "未知"],
  ])("按上海时间解释 %s", (value, expected) => {
    expect(relativeTaskTime(value, now)).toBe(expected);
  });
  it("带时区的旧格式与上海本地文本得到同一结果", () => {
    expect(relativeTaskTime("2026-10-17T02:00:00.000Z", now)).toBe("2时");
    expect(relativeTaskTime("2026-10-17T10:00:00.000+08:00", now)).toBe("2时");
  });
});
