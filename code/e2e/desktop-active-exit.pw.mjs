import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "playwright-core";
import { defaultRuntimeConfig } from "../dist/config/runtime-config.js";

const require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), "figo-desktop-active-exit-"));
const configRoot = join(root, "config");
const workspace = join(root, "workspace");
await mkdir(configRoot); await mkdir(workspace);
let modelRequests = 0;
let requestStarted;
const firstRequest = new Promise((resolve) => { requestStarted = resolve; });
const modelServer = createServer(async (request, response) => {
  for await (const _chunk of request) { /* Consume the request before holding the response. */ }
  modelRequests++;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.flushHeaders();
  requestStarted();
});
await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
const address = modelServer.address();
if (!address || typeof address === "string") throw new Error("模型测试服务未启动。");
const config = { ...defaultRuntimeConfig, activeModelId: "desktop-hold",
  llm: [{ id: "desktop-hold", enabled: true, provider: "openai-compatible", apiKey: "test-only-key",
    baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "desktop-hold" }] };
await writeFile(join(configRoot, "figo-agent.config.json"), JSON.stringify(config), { mode: 0o600 });
const env = { ...process.env, FIGO_DESKTOP_SMOKE_CONFIG_ROOT: configRoot, FIGO_DESKTOP_SMOKE_WORKSPACE: workspace };
delete env.ELECTRON_RUN_AS_NODE;
const packagedBinary = process.env.FIGO_DESKTOP_BINARY;
const launchApp = () => _electron.launch({ executablePath: packagedBinary || require("electron"),
  args: packagedBinary ? ["--desktop-e2e"] : [".", "--desktop-e2e"], env, timeout: 30000 });
let electronApp;

try {
  electronApp = await launchApp();
  const page = await electronApp.firstWindow();
  await page.getByRole("button", { name: "新建", exact: true }).waitFor();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByLabel("任务名称").fill("活动任务退出验收");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.locator(".composer textarea").fill("等待远程模型");
  await page.getByRole("button", { name: "发送" }).click();
  let requestTimeout;
  try {
    await Promise.race([firstRequest, new Promise((_, reject) => {
      requestTimeout = setTimeout(() => reject(new Error("模型请求未到达。")), 15000);
    })]);
  } finally { clearTimeout(requestTimeout); }
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(join(workspace, ".figo-agent", "figo-agent.db"));
  const run = db.prepare("select run_id, turn_id, status from ui_runs order by created_at desc limit 1").get();
  assert.equal(run?.status, "running");
  db.close();

  await electronApp.evaluate(({ dialog }) => {
    globalThis.__figoExitChoice = 0;
    globalThis.__figoExitPrompts = 0;
    dialog.showMessageBoxSync = () => {
      globalThis.__figoExitPrompts++;
      return globalThis.__figoExitChoice;
    };
  });
  await electronApp.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  const deadline = Date.now() + 10000;
  while (await electronApp.evaluate(() => globalThis.__figoExitPrompts) < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await electronApp.evaluate(() => globalThis.__figoExitPrompts), 1, "active work prompts before exit");
  await page.locator(".connection-status.online").waitFor();
  assert.equal(modelRequests, 1);
  const stillRunning = new DatabaseSync(join(workspace, ".figo-agent", "figo-agent.db"));
  try { assert.equal(stillRunning.prepare("select status from ui_runs where run_id = ?").get(run.run_id)?.status, "running"); }
  finally { stillRunning.close(); }

  await electronApp.evaluate(() => { globalThis.__figoExitChoice = 1; });
  const closed = electronApp.waitForEvent("close", { timeout: 15000 });
  await electronApp.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  await closed;
  electronApp = undefined;

  electronApp = await launchApp();
  const reopenedPage = await electronApp.firstWindow();
  await reopenedPage.getByRole("button", { name: "新建", exact: true }).waitFor();
  const recovered = new DatabaseSync(join(workspace, ".figo-agent", "figo-agent.db"));
  try {
    const after = recovered.prepare("select status from ui_runs where run_id = ?").get(run.run_id);
    const turn = recovered.prepare("select status from turns where id = ?").get(run.turn_id);
    assert.equal(after?.status, "interrupted");
    assert.equal(turn?.status, "failed");
    assert.equal(modelRequests, 1, "restart must not replay the model request");
    process.stdout.write(`活动 Run 退出验收通过：${packagedBinary ? "安装包" : "开发态"}，Run ${run.run_id} 已标记 interrupted，模型请求未重放。\n`);
  } finally { recovered.close(); }
} finally {
  await electronApp?.close();
  modelServer.closeAllConnections();
  await new Promise((resolve) => modelServer.close(resolve));
  await rm(root, { recursive: true, force: true });
}
