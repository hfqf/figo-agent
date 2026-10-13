import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "playwright-core";
import { defaultRuntimeConfig } from "../dist/config/runtime-config.js";

const require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), "figo-desktop-window-"));
const configRoot = join(root, "config");
const workspace = join(root, "workspace");
const secondWorkspace = join(root, "second-workspace");
await mkdir(configRoot); await mkdir(workspace); await mkdir(secondWorkspace);
execFileSync("git", ["init", "-q", "-b", "desktop-e2e", workspace]);
await writeFile(join(workspace, "note.md"), "桌面初始内容\n");
await writeFile(join(secondWorkspace, "second.md"), "第二个工作区\n");
let modelCalls = 0;
const modelServer = createServer(async (request, response) => {
  if (request.url !== "/v1/chat/completions") { response.writeHead(404); response.end(); return; }
  for await (const _chunk of request) { /* Consume the complete request. */ }
  modelCalls++;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end('data: {"choices":[{"delta":{"content":"FINAL\\n桌面验证完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});
await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
const address = modelServer.address();
if (!address || typeof address === "string") throw new Error("模型测试服务未启动");
const config = { ...defaultRuntimeConfig, activeModelId: "desktop-test",
  web: { ...defaultRuntimeConfig.web, requireAccessCode: false },
  llm: [{ id: "desktop-test", enabled: true, provider: "openai-compatible", apiKey: "test-only-key",
    baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "desktop-test" }] };
await writeFile(join(configRoot, "figo-agent.config.json"), JSON.stringify(config), { mode: 0o600 });
const env = { ...process.env, FIGO_DESKTOP_SMOKE_CONFIG_ROOT: configRoot, FIGO_DESKTOP_SMOKE_WORKSPACE: workspace };
delete env.ELECTRON_RUN_AS_NODE;
const packagedBinary = process.env.FIGO_DESKTOP_BINARY;
const launchApp = () => _electron.launch({ executablePath: packagedBinary || require("electron"),
  args: packagedBinary ? ["--desktop-e2e"] : [".", "--desktop-e2e"], env, timeout: 30000 });
let electronApp;
const desktopCookie = (target, url) => target.evaluate(async ({ session }, targetUrl) => {
  const cookies = await session.fromPartition("persist:figo-workbench").cookies.get({ url: targetUrl });
  const cookie = cookies.find((item) => item.name === "figo_sid");
  return cookie ? { name: cookie.name, value: cookie.value } : null;
}, url);

try {
  electronApp = await launchApp();
  const page = await electronApp.firstWindow();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.getByRole("button", { name: "新建", exact: true }).waitFor();
  assert.equal(await page.getByLabel("访问码").count(), 0);
  assert.equal((await fetch(new URL("/api/v1/bootstrap", page.url()))).status, 401, "desktop requires a session even when Web login is disabled");
  await page.locator(".branch-meta b", { hasText: "desktop-e2e" }).waitFor();
  const firstSession = await page.evaluate(async () => (await (await fetch("/api/v1/bootstrap")).json()).sessionId);
  const secondExit = await new Promise((resolve, reject) => {
    const child = spawn(packagedBinary || require("electron"), packagedBinary ? ["--desktop-e2e"] : [".", "--desktop-e2e"], {
      cwd: process.cwd(), env, stdio: "ignore"
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("第二实例未及时退出。")); }, 10000);
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("exit", (code) => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(secondExit, 0, "second instance exits without opening a new workbench");
  await page.locator(".connection-status.online").waitFor();
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/v1/bootstrap")).json()).sessionId), firstSession);

  await page.locator(".tree-row", { hasText: "note.md" }).click();
  await page.locator(".cm-content").fill("桌面编辑已保存\n");
  await page.getByTitle("保存文件").click();
  await page.locator(".dirty-dot").waitFor({ state: "hidden" });
  assert.equal(await readFile(join(workspace, "note.md"), "utf8"), "桌面编辑已保存\n");

  await page.getByRole("tab", { name: "Terminal" }).click();
  await page.getByRole("textbox", { name: "终端命令" }).fill("pwd");
  await page.getByRole("button", { name: "执行命令" }).click();
  await page.locator(".terminal-output", { hasText: workspace }).waitFor();
  await page.getByText("退出码 0").waitFor();
  await page.getByRole("textbox", { name: "终端命令" }).fill("git status --short");
  await page.getByRole("button", { name: "执行命令" }).click();
  await page.locator(".terminal-output", { hasText: "note.md" }).waitFor();

  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByLabel("任务名称").fill("桌面端验收");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.locator(".composer textarea").fill("请回复桌面验证完成");
  await page.getByRole("button", { name: "发送" }).click();
  await page.locator(".turn-answer", { hasText: "桌面验证完成" }).waitFor({ timeout: 15000 });
  await page.locator(".turn-status.completed").last().waitFor();
  assert.equal(modelCalls, 1);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(join(workspace, ".figo-agent", "figo-agent.db"));
  const turn = db.prepare("select id from turns where input = ? order by created_at desc limit 1")
    .get("请回复桌面验证完成");
  const capture = db.prepare("select id from llm_http_captures where turn_id = ? limit 1").get(turn.id);
  assert.ok(capture?.id, "the model request is preserved in SQLite");
  db.close();
  await page.getByRole("button", { name: "打开分析侧栏" }).click();
  await page.getByRole("tab", { name: "抓包" }).click();
  await page.locator(".inspector-pane").getByText("desktop-test").first().waitFor();
  await page.screenshot({ path: "/tmp/figo-desktop-electron.png", fullPage: true });
  assert.deepEqual(pageErrors, []);
  const oldCookie = await desktopCookie(electronApp, page.url());
  assert.ok(oldCookie?.value, "the desktop window has a session cookie");
  await electronApp.close();
  electronApp = undefined;
  const reopened = await launchApp();
  electronApp = reopened;
  const historyPage = await reopened.firstWindow();
  await historyPage.getByRole("button", { name: "新建", exact: true }).waitFor();
  const newCookie = await desktopCookie(reopened, historyPage.url());
  assert.ok(newCookie?.value && newCookie.value !== oldCookie.value, "restart replaces the session cookie");
  const stale = await fetch(new URL("/api/v1/bootstrap", historyPage.url()), { headers: { cookie: `${oldCookie.name}=${oldCookie.value}` } });
  assert.equal(stale.status, 401, "the previous process cookie cannot access the restarted service");
  await historyPage.getByRole("button", { name: "历史 Session" }).click();
  await historyPage.locator(".session-list button").nth(1).click();
  await historyPage.locator(".turn-answer", { hasText: "桌面验证完成" }).waitFor();
  await reopened.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
  }, secondWorkspace);
  await historyPage.getByRole("button", { name: "打开文件夹或切换工作区" }).click();
  await historyPage.getByRole("button", { name: "浏览" }).click();
  const canonicalSecondWorkspace = await realpath(secondWorkspace);
  await historyPage.waitForFunction((target) => document.querySelector("#workspace-path")?.value === target, canonicalSecondWorkspace);
  assert.equal(await historyPage.getByLabel("文件夹路径").inputValue(), canonicalSecondWorkspace);
  await historyPage.getByRole("button", { name: "打开", exact: true }).click();
  await historyPage.locator(".tree-row", { hasText: "second.md" }).waitFor();
  assert.equal(await historyPage.getByRole("button", { name: "打开文件夹或切换工作区" }).getAttribute("title"), canonicalSecondWorkspace);
  const mainPid = reopened.process().pid;
  const children = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .filter((match) => Number(match[2]) === mainPid)
    .map((match) => ({ pid: Number(match[1]), type: /--type=([^\s]+)/.exec(match[3])?.[1],
      utility: /--utility-sub-type=([^\s]+)/.exec(match[3])?.[1] }));
  const serviceChildren = children.filter((child) => child.type === "utility" && child.utility === "node.mojom.NodeService");
  assert.equal(serviceChildren.length, 1, "only the Node service utility process is selected for the crash test");
  await historyPage.locator(".connection-status.online").waitFor();
  await reopened.evaluate(({ dialog }) => {
    globalThis.__figoCrashNotices = 0;
    dialog.showMessageBox = async (options) => {
      if (options.message === "本地服务已退出。请重启应用。") globalThis.__figoCrashNotices++;
      return { response: 0, checkboxChecked: false };
    };
  });
  process.kill(serviceChildren[0].pid, "SIGKILL");
  await historyPage.locator(".connection-status.offline").waitFor({ timeout: 10000 });
  const deadline = Date.now() + 10000;
  while (await reopened.evaluate(() => globalThis.__figoCrashNotices) !== 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await reopened.evaluate(() => globalThis.__figoCrashNotices), 1, "service crash is reported exactly once");
  process.stdout.write(`Electron ${packagedBinary ? "安装包" : "开发态"}窗口 E2E 通过：单实例、文件、终端、Git、模型对话、抓包、重启鉴权、目录切换与服务崩溃；Turn ${turn.id}，抓包 ${capture.id}。\n`);
} finally {
  await electronApp?.close();
  await new Promise((resolve) => modelServer.close(resolve));
  await rm(root, { recursive: true, force: true });
}
