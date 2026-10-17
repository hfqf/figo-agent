import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { AgentKernel } from "../src/kernel/agent-kernel.js";
import { startLocalApi } from "../src/ui/local-api.js";
import { defaultTaskListSettings } from "../src/config/task-list-settings.js";

const workspace = await mkdtemp(join(tmpdir(), "figo-task-sidebar-e2e-"));
const output = resolve("../.figo-agent/task-sidebar-2026-10-17");
await mkdir(output, { recursive: true });
const kernel = await AgentKernel.start({ workspaceRoot: workspace });
const db = kernel.storage.db;
const titles = ["读取当前项目", "了解当前项目结构", "读取下 docs/1006/OKYOO修改意见.docx",
  ...Array.from({ length: 15 }, (_, index) => `历史对话 ${index + 4}：${"中文长标题用于验证布局".repeat(6)}`)];
const sessionIds = ["ses_first", "ses_second", "ses_legacy", "ses_bulk"];
for (const id of sessionIds) db.prepare("insert into sessions(id,cwd,status,started_at) values(?,?,?,?)")
  .run(id, workspace, "completed", "2026-10-01 10:00:00.000");
for (const [index, title] of titles.entries()) {
  const sessionId = sessionIds[Math.min(index, 3)];
  const taskId = index === 2 ? null : `task_fixture_${index}`;
  const time = index < 3 ? `2026-10-17 20:${30 - index}:00.000` : `2026-10-10 10:${String(index).padStart(2, "0")}:00.000`;
  if (taskId) db.prepare("insert into tasks(id,session_id,title,status,created_at,updated_at) values(?,?,?,?,?,?)")
    .run(taskId, sessionId, `手工占位标题${index}`, "active", time, time);
  db.prepare("insert into turns(id,session_id,task_id,input,output,status,created_at,completed_at,task_seq) values(?,?,?,?,?,?,?,?,?)")
    .run(`turn_fixture_${index}`, sessionId, taskId, title, `答复：${title}`, "completed", time, time, taskId ? 1 : null);
}
db.prepare("insert into turns(id,session_id,task_id,input,output,status,created_at,completed_at,task_seq) values(?,?,?,?,?,?,?,?,?)")
  .run("turn_followup", "ses_first", "task_fixture_0", "这是第二轮，不应覆盖标题", "继续回答", "completed", "2026-10-17 20:31:00.000", "2026-10-17 20:31:00.000", 2);
const counts = () => ["sessions", "tasks", "turns", "ui_runs", "llm_http_captures"].map((table) => ({ table,
  count: (db.prepare(`select count(*) n from ${table}`).get() as { n: number }).n }));
const before = counts();
const api = await startLocalApi({ kernel, port: 0, requireAccessCode: false, staticRoot: resolve("web/dist"),
  taskList: { ...defaultTaskListSettings, recentLimit: 3, pageSize: 5 } });
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const checks: string[] = [];
const errors: string[] = [];
const screenshots: string[] = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(7000);
page.on("pageerror", (error) => errors.push(error.message));
const rows = () => page.locator(".task-sidebar .task-row");
const composer = () => page.locator(".task-pane .composer textarea");
const waitRows = async (count: number) => page.waitForFunction((n) => document.querySelectorAll(".task-sidebar .task-row").length === n
  && document.querySelector(".task-sidebar .task-list")?.getAttribute("aria-busy") === "false", count);
async function shot(name: string) { const path = join(output, name); await page.screenshot({ path, fullPage: true }); screenshots.push(path); }

try {
  await page.goto(api.url);
  await page.getByRole("button", { name: "查看全部（18）", exact: true }).waitFor();
  assert.equal(await rows().count(), 3);
  assert.deepEqual(await page.locator(".task-sidebar .task-title").allTextContents(), titles.slice(0, 3));
  assert.equal(await page.getByRole("button", { name: "任务面板设置", exact: true }).count(), 1);
  assert.equal(await composer().isVisible(), true);
  await shot("1440-recent.png"); checks.push("默认近期列表跨Session，首轮标题、真实总数、图标与固定输入框");

  await page.getByRole("button", { name: "历史 Session", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.locator(".task-session-list button", { hasText: titles[0] }).waitFor();
  assert.equal(await page.locator(".task-session-list").innerText().then(text => text.includes("这是第二轮")), false);
  await shot("1440-sessions.png");
  await page.reload();
  await page.locator(".task-session-list button", { hasText: titles[0] }).waitFor();
  checks.push("Session标题取第一条消息，历史图标可键盘操作且展开状态刷新可恢复");
  await page.getByRole("button", { name: "历史 Session", exact: true }).click();

  await page.getByRole("button", { name: "查看全部（18）", exact: true }).click();
  await waitRows(5);
  await page.getByText("第 1 / 4 页", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下一页对话", exact: true }).click();
  await page.getByText("第 2 / 4 页", { exact: true }).waitFor();
  await page.getByLabel("搜索对话", { exact: true }).fill("OKYOO");
  await waitRows(1);
  assert.equal(await page.locator(".task-sidebar .task-title").innerText(), titles[2]);
  await page.getByText("第 1 / 1 页", { exact: true }).waitFor();
  await page.getByLabel("搜索对话", { exact: true }).fill("没有这种对话");
  await page.getByText("没有匹配的对话", { exact: true }).waitFor();
  await page.getByText("第 0 / 0 页", { exact: true }).waitFor();
  await page.getByLabel("搜索对话", { exact: true }).fill("");
  await waitRows(5); await shot("1440-all.png");
  checks.push("查看全部、分页总数、翻页、搜索重置页码与空结果");

  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  await page.route("**/api/v1/tasks?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") !== "慢查询") return route.continue();
    const response = await route.fetch(); entered(); await hold; await route.fulfill({ response });
  });
  await page.getByLabel("搜索对话", { exact: true }).fill("慢查询");
  await started;
  await page.getByLabel("搜索对话", { exact: true }).fill("OKYOO");
  await waitRows(1); release();
  await page.waitForResponse((response) => new URL(response.url()).searchParams.get("q") === "慢查询");
  assert.equal(await page.locator(".task-sidebar .task-title").innerText(), titles[2]);
  await page.unroute("**/api/v1/tasks?**");
  checks.push("搜索迟到响应不覆盖当前结果");

  await page.getByRole("button", { name: titles[2], exact: true }).click();
  await page.locator(".turn-prompt", { hasText: titles[2] }).waitFor();
  assert.equal(await composer().isDisabled(), true);
  await page.getByText("历史 Session（只读）", { exact: true }).waitFor();
  await page.reload();
  await page.locator(".turn-prompt", { hasText: titles[2] }).waitFor();
  assert.equal(await composer().isDisabled(), true);
  checks.push("legacy对话按真实Session打开，刷新恢复且保持只读");

  await page.getByRole("button", { name: "返回任务列表", exact: true }).click();
  await page.getByText("第 1 / 4 页", { exact: true }).waitFor();
  await page.getByRole("button", { name: "最近对话", exact: true }).click();
  await waitRows(3);
  await page.getByRole("button", { name: titles[0], exact: true }).click();
  await page.locator(".turn-prompt", { hasText: "这是第二轮，不应覆盖标题" }).waitFor();
  assert.equal(await page.locator(".task-panel-conversation .pane-title").innerText(), titles[0]);
  await page.reload();
  await page.locator(".turn-prompt", { hasText: "这是第二轮，不应覆盖标题" }).waitFor();
  assert.equal(await composer().isDisabled(), true);
  await shot("1440-history-restored.png");
  checks.push("跨Session任务正确恢复完整Turn与首轮标题，无权限漂移");

  const afterReadOnly = counts();
  assert.deepEqual(afterReadOnly, before, "只读浏览不创建或搬迁Session、Task、Turn、Run和模型请求");
  checks.push("查询、搜索、翻页、刷新均无Agent副作用");
  await page.getByRole("button", { name: "返回任务列表", exact: true }).click(); await waitRows(3);
  await page.reload(); await waitRows(3);
  assert.equal(await page.locator(".task-sidebar").isVisible(), true);
  checks.push("列表视图刷新后保留列表，不跳回对话");

  await page.setViewportSize({ width: 390, height: 844 });
  await shot("390-recent.png");
  assert.equal(await composer().isVisible(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole("button", { name: "查看全部（18）", exact: true }).click(); await waitRows(5);
  await page.getByRole("button", { name: "下一页对话", exact: true }).click();
  await page.getByText("第 2 / 4 页", { exact: true }).waitFor();
  await shot("390-long-titles.png");
  assert.equal(await page.getByText("第 2 / 4 页", { exact: true }).count(), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.ok(await page.locator(".task-sidebar .task-title").first().evaluate((node) => node.scrollWidth > node.clientWidth));
  checks.push("390移动端长标题省略、分页与固定输入框无整体溢出");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "最近对话", exact: true }).click(); await waitRows(3);
  await composer().fill("新任务的第一条消息作为标题");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator(".turn-group", { hasText: "新任务的第一条消息作为标题" }).locator(".turn-answer").waitFor();
  await page.getByRole("button", { name: "返回任务列表", exact: true }).click(); await waitRows(3);
  await page.getByRole("button", { name: "新任务的第一条消息作为标题", exact: true }).waitFor();
  assert.equal((db.prepare("select count(*) n from llm_http_captures where method != 'LOCAL'").get() as { n: number }).n, 0);
  checks.push("列表发送创建当前Session任务并展示首条标题，全程没有真实模型调用");

  const savedKey = await page.evaluate(() => Object.keys(localStorage).find(key => key.startsWith("figo.task-view.v1:"))!);
  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ version: 1, sessionId: "ses_deleted", taskId: "task_missing", view: "conversation", historyOpen: true, listMode: "all" })), savedKey);
  await page.reload();
  await page.getByRole("button", { name: "查看全部（19）", exact: true }).waitFor();
  assert.equal(await page.locator(".task-sidebar").isVisible(), true);
  assert.equal(await composer().isEnabled(), true);
  checks.push("已删除或归属无效的视图偏好安全回退，不进入鉴权错误页");

  assert.deepEqual(errors, []);
  await writeFile(join(output, "browser-result.json"), JSON.stringify({ passed: true, checks, screenshots, before, afterReadOnly, after: counts(), pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, screenshots: screenshots.length, result: join(output, "browser-result.json") }));
} finally {
  await browser.close(); await api.close(); await kernel.shutdown(); db.close();
  await rm(workspace, { recursive: true, force: true });
}
