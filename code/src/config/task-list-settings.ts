export interface TaskListSettings {
  recentLimit: number;
  pageSize: number;
  maxPageSize: number;
  searchMaxChars: number;
  titleMaxChars: number;
  searchDebounceMs: number;
}

export const defaultTaskListSettings: TaskListSettings = {
  recentLimit: 8,
  pageSize: 30,
  maxPageSize: 100,
  searchMaxChars: 200,
  titleMaxChars: 120,
  searchDebounceMs: 200
};

export function readTaskListSettings(value: unknown): TaskListSettings {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("web.taskList 配置无效，必须是对象。");
  }
  const input = (value ?? {}) as Record<string, unknown>;
  const settings = { ...defaultTaskListSettings };
  const bounds: Record<keyof TaskListSettings, [number, number]> = {
    recentLimit: [1, 100], pageSize: [1, 100], maxPageSize: [1, 100],
    searchMaxChars: [1, 10000], titleMaxChars: [1, 1000], searchDebounceMs: [0, 5000]
  };
  for (const key of Object.keys(settings) as Array<keyof TaskListSettings>) {
    const n = input[key];
    if (n === undefined) continue;
    const [min, max] = bounds[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max) {
      throw new Error(`web.taskList.${key} 无效，必须是 ${min} 至 ${max} 的安全整数。`);
    }
    settings[key] = n;
  }
  if (settings.recentLimit > settings.maxPageSize || settings.pageSize > settings.maxPageSize) {
    throw new Error("web.taskList 配置范围无效，recentLimit 和 pageSize 不能超过 maxPageSize。");
  }
  return settings;
}
