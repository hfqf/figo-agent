import assert from "node:assert/strict";
import { resolve } from "node:path";
import { build } from "vite";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { TaskListItem } from "../src/contracts/task-list.js";
import type { Bootstrap, Task, Turn, UiRun } from "../web/src/api.js";

// 构建与接口数据均在内存中；不启动内核，不读取运行配置或业务数据库。
const webRoot = resolve(import.meta.dirname, "../web");
const built = await build({
  configFile: false, root: webRoot, base: "/", logLevel: "silent", esbuild: { jsx: "automatic" },
  build: { write: false, rollupOptions: { input: resolve(webRoot, "index.html") } }
});
assert.ok(!Array.isArray(built) && "output" in built);
const assets = new Map(built.output.map((asset) => ["/" + asset.fileName,
  asset.type === "chunk" ? asset.code : asset.source]));
const origin = "http://127.0.0.1:47123";
const workspace = "/task-sidebar-regression";
const preferenceKey = `figo.task-view.v1:${encodeURIComponent(workspace)}`;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(context: BrowserContext, paused = false) {
  const tasks: TaskListItem[] = Array.from({ length: 6 }, (_, index) => ({
    id: `task_current_${index}`, sessionId: "ses_current", title: `当前任务${index}`,
    displayTitle: `当前任务${index}`, sessionTitle: "当前会话", status: paused && index === 5 ? "paused" : "active",
    turnCount: 1, updatedAt: "2026-10-17 10:00:00.000"
  }));
  const history: TaskListItem = { ...tasks[0], id: "task_history", sessionId: "ses_history",
    title: "历史任务", displayTitle: "历史任务", sessionTitle: "历史会话" };
  const turns = new Map<string, Turn[]>([...tasks, history].map((task) => [task.id, [{
    id: `turn_${task.id}`, sessionId: task.sessionId, taskId: task.id, taskSeq: 1,
    input: task.displayTitle, output: "本地夹具回复", status: "completed", createdAt: task.updatedAt, completedAt: task.updatedAt
  }]]));
  const state = {
    currentTaskId: tasks[0].id, created: [] as Task[], actions: [] as Array<{ taskId: string; action: string }>,
    submitted: [] as Array<{ taskId: string; input: string }>, delayHistory: false,
    historyRelease: deferred(), unexpected: [] as string[], errors: [] as string[]
  };
  const runs = new Map<string, UiRun>();
  await context.addInitScript(() => { window.EventSource = class { close() {} } as unknown as typeof EventSource; });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const asset = url.origin === origin ? assets.get(path === "/" ? "/index.html" : path) : undefined;
    if (asset !== undefined) {
      const contentType = path === "/" || path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : path.endsWith(".png") ? "image/png" : "text/javascript";
      return route.fulfill({ contentType, body: typeof asset === "string" ? asset : Buffer.from(asset) });
    }
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.origin === origin) {
      if (path === "/api/v1/bootstrap") {
        const boot: Bootstrap = {
          workspace: "regression", workspacePath: workspace, branch: "main", sessionId: "ses_current",
          currentTaskId: state.currentTaskId, tasks, activeRun: null, eventCursor: 0, csrf: "fixture",
          model: "fixture", modelProviderId: "fixture", modelConfigured: true,
          taskList: { recentLimit: 8, pageSize: 30, maxPageSize: 100, searchMaxChars: 200, titleMaxChars: 120, searchDebounceMs: 200 },
          fileBrowser: { searchMinChars: 2, searchMaxChars: 200, maxDirectoryEntries: 100, maxPreviewBytes: 1000 },
          terminal: { maxCommandChars: 1000 }
        };
        return json(boot);
      }
      if (path === "/api/v1/tasks" && method === "GET") {
        // 历史入口在前；末尾当前任务可独立验证切换，避免菜单遮挡掩盖归属缺陷。
        return json({ tasks: [history, ...tasks], totalCount: tasks.length + 1, totalPages: 1, page: 1, pageSize: 8 });
      }
      if (path === "/api/v1/sessions/ses_history/tasks") {
        if (state.delayHistory) await state.historyRelease.promise;
        return json({ tasks: [history] });
      }
      if (path === "/api/v1/sessions/ses_current/tasks") return json({ tasks });
      if (path === "/api/v1/tasks" && method === "POST") {
        const { title } = route.request().postDataJSON();
        const task = { ...tasks[0], id: `task_created_${state.created.length}`, title, displayTitle: title, status: "active", turnCount: 0 };
        tasks.unshift(task); state.created.push(task); state.currentTaskId = task.id; turns.set(task.id, []);
        return json(task, 201);
      }
      const action = path.match(/^\/api\/v1\/tasks\/([^/]+)\/actions$/);
      if (action && method === "POST") {
        const task = tasks.find((task) => task.id === action[1]);
        assert.ok(task, "操作必须属于当前Session");
        const { action: name } = route.request().postDataJSON();
        state.actions.push({ taskId: task.id, action: name });
        if (name === "switch" || name === "resume") { state.currentTaskId = task.id; task.status = "active"; }
        else if (name === "pause") task.status = "paused";
        return json({ result: { status: "completed" }, tasks });
      }
      const turn = path.match(/^\/api\/v1\/tasks\/([^/]+)\/turns$/);
      if (turn && method === "POST") {
        const task = tasks.find((task) => task.id === turn[1]);
        assert.ok(task?.id === state.currentTaskId && task.status === "active", "发送只能写入当前Session的当前active任务");
        const { input } = route.request().postDataJSON();
        state.submitted.push({ taskId: task.id, input }); task.turnCount++;
        task.displayTitle = input;
        const created: Turn = { id: "turn_created", taskId: task.id, sessionId: task.sessionId, taskSeq: 1,
          input, output: "本地夹具回复", status: "completed", createdAt: task.updatedAt, completedAt: task.updatedAt };
        turns.set(task.id, [created]);
        const run: UiRun = { runId: "run_created", turnId: created.id, taskId: task.id, status: "completed" };
        runs.set(run.runId, run); return json(run, 202);
      }
      if (turn) return json({ turns: turns.get(turn[1]) ?? [] });
      if (path.startsWith("/api/v1/runs/")) return json(runs.get(path.split("/").at(-1)!));
      if (path === "/api/v1/models/available") return json({ providers: [] });
      if (path === "/api/v1/files") return json({ entries: [], truncated: false });
      if (path === "/api/v1/debug-events" || path.endsWith("/activity")) return json({ events: [] });
      if (path.endsWith("/tool-calls")) return json({ tools: [] });
      if (path.endsWith("/usage")) return json({ requestCount: 0, unavailableCount: 0, partialCount: 0, knownTotalTokens: 0, totalReportedCount: 0 });
    }
    state.unexpected.push(`${method} ${url.href}`);
    return json({ error: "夹具未声明此接口，禁止外部请求。" }, 500);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(2500);
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.goto(origin);
  await page.locator(".task-sidebar .task-row").last().waitFor();
  return { page, state };
}

const taskRow = (page: Page, title: string) => page.locator(".task-sidebar .task-row")
  .filter({ has: page.getByRole("button", { name: title, exact: true }) });

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function assertCurrent(page: Page, task: Task) {
  assert.equal(await page.locator(".task-panel-conversation .pane-title").innerText(), task.displayTitle ?? task.title);
  assert.equal(await page.locator(".history-readonly-badge").count(), 0, "当前任务不得保留历史只读标记");
  assert.equal(await page.locator(".composer textarea").isEnabled(), true);
  assert.deepEqual(await page.evaluate((key) => {
    const saved = JSON.parse(localStorage.getItem(key)!);
    return { sessionId: saved.sessionId, taskId: saved.taskId, view: saved.view };
  }, preferenceKey), { sessionId: "ses_current", taskId: task.id, view: "conversation" });
}

async function historyThenAction(page: Page, action: "switch" | "resume") {
  await taskRow(page, "历史任务").locator(".task-select").click();
  await page.locator(".history-readonly-badge").waitFor();
  assert.equal(await page.locator(".composer textarea").isDisabled(), true);
  await page.getByRole("button", { name: "返回任务列表", exact: true }).click();
  await taskRow(page, "当前任务5").locator(".task-more").click();
  await page.getByRole("menuitem", { name: action === "switch" ? "切换到此任务" : "恢复任务", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".app-shell")?.classList.contains("task-detail"));
  await settle(page);
}

async function releaseHistory(page: Page, state: Awaited<ReturnType<typeof fixture>>["state"]) {
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/sessions/ses_history/tasks");
  state.historyRelease.resolve();
  await (await response).finished();
  // 等待网络正文消费和React绘制后再断言，避免在迟到响应处理前误报通过。
  await settle(page);
}

const results: Array<{ name: string; passed: boolean; error?: string }> = [];
async function check(name: string, run: (test: Awaited<ReturnType<typeof fixture>>) => Promise<void>, paused = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let test: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    test = await fixture(context, paused);
    await run(test);
    assert.deepEqual(test.state.unexpected, []); assert.deepEqual(test.state.errors, []);
    results.push({ name, passed: true }); console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, error: message }); console.error(`FAIL ${name}\n${message}`);
  } finally {
    test?.state.historyRelease.resolve();
    await context.close();
  }
}

try {
  await check("F1 鼠标点击菜单暂停，不命中后续任务", async ({ page, state }) => {
    await taskRow(page, "当前任务0").locator(".task-more").click();
    await page.getByRole("menuitem", { name: "暂停任务", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".task-menu"));
    await settle(page);
    assert.deepEqual(state.actions, [{ taskId: "task_current_0", action: "pause" }]);
    assert.equal(await page.locator(".task-sidebar").isVisible(), true);
  });
  for (const action of ["switch", "resume"] as const) {
    await check(`F2 历史视图鼠标${action}恢复当前Session归属`, async ({ page, state }) => {
      await historyThenAction(page, action);
      assert.deepEqual(state.actions, [{ taskId: "task_current_5", action }]);
      await assertCurrent(page, { id: "task_current_5", sessionId: "ses_current", title: "当前任务5", status: "active", turnCount: 1, updatedAt: "" });
      assert.equal(await page.locator(".turn-prompt").innerText(), "当前任务5");
    }, action === "resume");
  }
  for (const mode of ["named", "send"] as const) {
    await check(`F3 延迟历史GET不覆盖${mode === "named" ? "命名新建" : "列表发送新建"}`, async ({ page, state }) => {
      state.delayHistory = true;
      const started = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/v1/sessions/ses_history/tasks");
      await taskRow(page, "历史任务").locator(".task-select").click(); await started;
      const title = mode === "named" ? "命名新建保留选择" : "列表发送保留新任务";
      if (mode === "named") {
        await page.getByRole("button", { name: "新建", exact: true }).click();
        await page.locator("#task-title").fill(title);
        await page.locator(".task-dialog button[type=submit]").click();
      } else {
        await page.locator(".composer textarea").fill(title);
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await page.locator(".turn-prompt", { hasText: title }).waitFor();
        await page.locator(".turn-answer").waitFor();
      }
      await page.locator(".task-panel-conversation .pane-title", { hasText: title }).waitFor();
      await assertCurrent(page, state.created[0]);
      await releaseHistory(page, state);
      await assertCurrent(page, state.created[0]);
      assert.equal(state.created.length, 1);
      assert.deepEqual(state.submitted, mode === "send" ? [{ taskId: state.created[0].id, input: title }] : []);
    });
  }
} finally { await browser.close(); }

console.log(JSON.stringify({ passed: results.every((result) => result.passed), checks: results.length,
  failed: results.filter((result) => !result.passed).map((result) => result.name) }));
if (results.some((result) => !result.passed)) process.exitCode = 1;
