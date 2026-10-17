import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { defaultRuntimeConfig, loadRuntimeConfig } from "../../src/config/runtime-config.js";
import { defaultTaskListSettings, readTaskListSettings } from "../../src/config/task-list-settings.js";

const defaults = { recentLimit: 8, pageSize: 30, maxPageSize: 100, searchMaxChars: 200, titleMaxChars: 120, searchDebounceMs: 200 };

it("任务列表提供独立的完整默认配置", () => {
  expect(defaultTaskListSettings).toEqual(defaults);
  expect(readTaskListSettings(undefined)).toEqual(defaults);
  const settings = readTaskListSettings({ pageSize: 10, searchDebounceMs: 0 });
  expect(settings).toEqual({ ...defaults, pageSize: 10, searchDebounceMs: 0 });
  settings.titleMaxChars = 1;
  expect(defaultTaskListSettings.titleMaxChars).toBe(120);
});

it.each([
  null, [], "bad", { recentLimit: 0 }, { pageSize: -1 }, { maxPageSize: 101 },
  { pageSize: 101 }, { maxPageSize: 20 }, { recentLimit: 101 },
  { searchMaxChars: 0 }, { searchMaxChars: 10001 }, { titleMaxChars: 0 },
  { titleMaxChars: 1001 }, { searchDebounceMs: -1 }, { searchDebounceMs: 5001 },
  { pageSize: 1.5 }, { pageSize: "8" }, { titleMaxChars: NaN }, { pageSize: Infinity }
])("任务列表拒绝无效配置 %j", (value) => {
  expect(() => readTaskListSettings(value)).toThrow(/无效/);
});

it("统一运行配置加载、兼容旧配置并独立克隆任务列表参数", async () => {
  const root = await mkdtemp(join(tmpdir(), "figo-task-settings-"));
  try {
    expect(defaultRuntimeConfig.web.taskList).toEqual(defaults);
    const first = await loadRuntimeConfig(root);
    first.web.taskList.pageSize = 1;
    expect((await loadRuntimeConfig(root)).web.taskList).toEqual(defaults);
    expect(defaultRuntimeConfig.web.taskList).toEqual(defaults);
    await writeFile(join(root, "figo-agent.config.json"), JSON.stringify({ web: {} }));
    expect((await loadRuntimeConfig(root)).web.taskList).toEqual(defaults);
    await writeFile(join(root, "figo-agent.config.json"), JSON.stringify({ web: { taskList: { pageSize: 12, recentLimit: 4 } } }));
    expect((await loadRuntimeConfig(root)).web.taskList).toEqual({ ...defaults, pageSize: 12, recentLimit: 4 });
    await writeFile(join(root, "figo-agent.config.json"), JSON.stringify({ web: { taskList: { maxPageSize: 101 } } }));
    await expect(loadRuntimeConfig(root)).rejects.toThrow(/无效/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
