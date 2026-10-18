import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "playwright-core";

const require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), "figo-desktop-first-run-"));
const configRoot = join(root, "config");
const workspace = join(root, "project");
await mkdir(configRoot); await mkdir(workspace);
const catalog = createServer((request, response) => {
  if (request.url !== "/v1/models" || request.headers.authorization !== "Bearer first-run-test-key") {
    response.writeHead(401); response.end(); return;
  }
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
});
await new Promise(resolve => catalog.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${catalog.address().port}/v1`;
const env = { ...process.env, FIGO_DESKTOP_SMOKE_CONFIG_ROOT: configRoot };
delete env.FIGO_DESKTOP_SMOKE_WORKSPACE;
delete env.ELECTRON_RUN_AS_NODE;
const packagedBinary = process.env.FIGO_DESKTOP_BINARY;
let app;
try {
  app = await _electron.launch({ executablePath: packagedBinary || require("electron"),
    args: packagedBinary ? ["--desktop-e2e"] : [".", "--desktop-e2e"], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.on("console", (message) => process.stderr.write(`setup console ${message.type()}: ${message.text()}\n`));
  page.on("pageerror", (error) => process.stderr.write(`setup pageerror: ${error.message}\n`));
  try { await page.getByRole("heading", { name: "模型设置" }).waitFor({ timeout: 8000 }); }
  catch (error) {
    process.stderr.write(`首次启动页面：${page.url()} ${await page.content()}\n`);
    throw error;
  }
  assert.equal(await page.getByRole("button", { name: "浏览文件夹" }).isDisabled(), true);
  await page.waitForFunction(() => {
    const image = document.querySelector(".setup-header img.brand-logo");
    return image?.complete && image.naturalWidth === 512;
  });
  await page.screenshot({ path: "/tmp/figo-desktop-first-run.png", fullPage: true });
  assert.deepEqual(await readdir(workspace), [], "setup must not create a workspace Session");
  assert.deepEqual(await page.evaluate(() => Object.keys(window.figoSetup).sort()),
    ["discoverModels", "openWorkspace", "pickWorkspace", "read", "saveModel"]);
  for (const name of ["MiniMax", "DeepSeek", "GPT 官方", "GPT 中转"]) {
    assert.equal(await page.getByRole("button", { name, exact: true }).count(), 1);
  }
  await page.getByRole("button", { name: "GPT 中转", exact: true }).click();
  await page.getByLabel("API 地址").fill(baseUrl);
  await page.getByLabel("API Key").fill("first-run-test-key");
  await page.getByRole("button", { name: "获取模型列表", exact: true }).click();
  await page.getByRole("combobox", { name: "模型 ID" }).selectOption("test-model");
  await page.getByRole("button", { name: "保存模型" }).click();
  await page.getByText("模型配置已保存").waitFor();
  assert.equal(await page.evaluate(async () => JSON.stringify(await window.figoSetup.read()).includes("first-run-test-key")), false);
  const savedConfig = JSON.parse(await readFile(join(configRoot, "figo-agent.config.json"), "utf8"));
  assert.equal(savedConfig.activeModelId, "gpt-relay");
  assert.equal(savedConfig.llm.find(model => model.id === "gpt-relay").baseUrl, baseUrl);
  assert.equal(savedConfig.llm.find(model => model.id === "minimax").apiKey, "");
  assert.deepEqual(await readdir(workspace), [], "saving the model must not create a workspace Session");
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole("button", { name: "浏览文件夹" }).click();
  assert.equal(await page.getByLabel("文件夹路径").inputValue(), "", "cancel keeps the setup page empty");
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.getByRole("button", { name: "浏览文件夹" }).click();
  const canonicalWorkspace = await realpath(workspace);
  await page.waitForFunction((path) => document.querySelector("#setup-workspace-path")?.value === path, canonicalWorkspace);
  assert.equal(await page.getByLabel("文件夹路径").inputValue(), canonicalWorkspace);
  const nextWindow = app.waitForEvent("window");
  await page.getByRole("button", { name: "打开工作区", exact: true }).click();
  const workbench = await nextWindow;
  const onboarding = workbench.getByRole("dialog", { name: "工作台快速上手", exact: true });
  await onboarding.waitFor();
  await onboarding.locator("img").evaluate((image) => image.decode());
  await workbench.keyboard.press("Escape");
  await workbench.getByRole("button", { name: "新建", exact: true }).waitFor();
  await workbench.waitForFunction(() => {
    const image = document.querySelector(".topbar img.brand-logo");
    return image?.complete && image.naturalWidth === 512;
  });
  const bootstrap = await workbench.evaluate(async () => (await (await fetch("/api/v1/bootstrap")).json()));
  assert.equal(bootstrap.workspacePath, canonicalWorkspace);
  assert.equal(bootstrap.modelConfigured, true);
  process.stdout.write(`Electron ${packagedBinary ? "安装包" : "开发态"}首次启动通过：四服务入口、真实 IPC 拉取本地目录并保存中转、凭据不回显，主动打开工作区后才创建 Session。\n`);
} finally {
  await app?.close();
  await new Promise(resolve => catalog.close(resolve));
  await rm(root, { recursive: true, force: true });
}
