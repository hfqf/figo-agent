import type { TaskListSettings } from "../../src/config/task-list-settings.js";
import { copy, formatCopy } from "./i18n";

export interface TaskViewPreference {
  version: 1;
  sessionId: string;
  taskId: string;
  view: "list" | "conversation";
  historyOpen: boolean;
  listMode: "recent" | "all";
}

export function taskViewKey(workspace: string): string {
  return `figo.task-view.v1:${encodeURIComponent(workspace)}`;
}

export function decodeTaskView(raw: string | null): TaskViewPreference | null {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || value.version !== 1 || typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.length > 256
      || typeof value.taskId !== "string" || !value.taskId || value.taskId.length > 256
      || !["list", "conversation"].includes(value.view) || typeof value.historyOpen !== "boolean"
      || !["recent", "all"].includes(value.listMode)) return null;
    return { version: 1, sessionId: value.sessionId, taskId: value.taskId, view: value.view,
      historyOpen: value.historyOpen, listMode: value.listMode };
  } catch { return null; }
}

export function taskListPath(selection: { mode: "recent" | "all"; page: number; q: string }, settings: TaskListSettings): string {
  const search = new URLSearchParams({ page: String(selection.page), limit: String(selection.mode === "recent" ? settings.recentLimit : settings.pageSize) });
  if (selection.q.trim()) search.set("q", selection.q.trim());
  return `/api/v1/tasks?${search}`;
}

export function relativeTaskTime(value: string, now = Date.now()): string {
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? value.replace(" ", "T") + "+08:00" : value;
  const time = Date.parse(normalized);
  if (!Number.isFinite(time)) return copy.taskAgeUnknown;
  const seconds = Math.max(0, (now - time) / 1000);
  if (seconds < 60) return copy.taskAgeNow;
  for (const [size, template] of [
    [31536000, copy.taskAgeYear], [2592000, copy.taskAgeMonth], [604800, copy.taskAgeWeek],
    [86400, copy.taskAgeDay], [3600, copy.taskAgeHour], [60, copy.taskAgeMinute]
  ] as const) {
    if (seconds >= size) return formatCopy(template, { count: Math.floor(seconds / size) });
  }
  return copy.taskAgeNow;
}
