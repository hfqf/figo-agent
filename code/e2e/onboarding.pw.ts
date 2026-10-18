import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { startWorkbench } from "../src/ui/start-workbench.js";
import { OnboardingStore } from "../src/ui/onboarding-store.js";

const root = await mkdtemp(join(tmpdir(), "figo-onboarding-e2e-"));
const configRoot = join(root, "config");
const workspaceRoot = join(root, "project-a");
const otherWorkspace = join(root, "project-b");
for (const path of [configRoot, workspaceRoot, otherWorkspace]) await mkdir(path);
await writeFile(join(configRoot, "figo-agent.config.json"), JSON.stringify({ web: { onboarding: { enabled: true, revision: "1" } } }));
const executablePath = [process.env.CHROME_EXECUTABLE, chromium.executablePath(), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"]
  .find((path): path is string => Boolean(path && existsSync(path)));
assert.ok(executablePath, "需要可用 Chromium 浏览器");
const browser = await chromium.launch({ headless: true, executablePath });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const pageErrors: string[] = [];
const writes: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("request", (request) => {
  if (request.url().includes("/api/") && request.method() !== "GET") writes.push(new URL(request.url()).pathname);
});
const start = () => startWorkbench({ configRoot, workspaceRoot, staticRoot: resolve("web/dist"), port: 0, requireAccessCode: false });
let api = await start();
const firstOrigin = api.url;
const guide = (name: string) => page.getByRole("dialog", { name, exact: true });
const pictureLoaded = async (name: string) => {
  await guide(name).waitFor();
  assert.ok(await guide(name).locator("img").evaluate(async (image) => {
    const element = image as HTMLImageElement;
    await element.decode(); return element.naturalWidth > 1000;
  }));
};
const waitSaved = async (count: number) => {
  await page.waitForFunction(async (count) => {
    const boot = await (await fetch("/api/v1/bootstrap")).json(); return boot.onboarding.seen.length === count;
  }, count);
};
try {
  await page.goto(api.url);
  await pictureLoaded("工作台快速上手");
  await page.screenshot({ path: join(tmpdir(), "figo-onboarding-workbench-e2e.png") });
  await page.mouse.click(20, 20); await waitSaved(1);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.reload(); await page.getByRole("button", { name: "Trace Inspector", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: "Trace Inspector", exact: true }).click();
  await pictureLoaded("Trace Inspector 核心功能");
  await page.screenshot({ path: join(tmpdir(), "figo-onboarding-trace-inspector-e2e.png") });
  await page.keyboard.press("Escape"); await waitSaved(2);
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();

  for (const name of ["工作台快速上手", "Trace Inspector 核心功能"]) {
    await page.getByRole("button", { name: "设置", exact: true }).first().click();
    await page.getByRole("button", { name: "使用引导", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
    await pictureLoaded(name); await page.keyboard.press("Escape");
    if (name === "Trace Inspector 核心功能") await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  }

  await page.getByRole("button", { name: "打开文件夹或切换工作区", exact: true }).click();
  await page.getByLabel("文件夹路径", { exact: true }).fill(otherWorkspace);
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await page.getByRole("button", { name: "打开文件夹或切换工作区", exact: true }).filter({ hasText: "project-b" }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(api.kernel.storage.db.prepare("select count(*) n from turns").get()?.n, 0);

  await page.goto("about:blank"); await api.close(); api = await start();
  assert.notEqual(api.url, firstOrigin, "重启分配新端口验证非 localStorage 持久化");
  await page.goto(api.url); await page.getByRole("button", { name: "Trace Inspector", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: "Trace Inspector", exact: true }).click();
  await page.getByRole("button", { name: "返回工作台", exact: true }).waitFor();
  assert.equal(await guide("Trace Inspector 核心功能").count(), 0);
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();

  // 未配置模型时不覆盖配置入口，也不提前消费已看状态。
  await page.route("**/api/v1/bootstrap", async (route) => {
    const response = await route.fetch(); const boot = await response.json();
    await route.fulfill({ json: { ...boot, modelConfigured: false, onboarding: { enabled: true, revision: "new", seen: [] } } });
  });
  await page.reload(); await page.getByText("当前模型未配置 API Key。请在设置中填写并保存。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.deepEqual(pageErrors, []);
  assert.ok(writes.every((path) => path === "/api/v1/settings/onboarding" || path === "/api/v1/workspaces/open"), JSON.stringify(writes));
  const store = await OnboardingStore.open(configRoot);
  try { assert.deepEqual(store.seen("1"), ["trace-inspector", "workbench"]); }
  finally { store.close(); }
  console.log(JSON.stringify({ result: "passed", guides: 2, settingsReplay: true, workspaceSwitch: true,
    changedOrigin: true, modelSetupNotCovered: true, modelCalls: 0, pageErrors: 0,
    screenshots: [join(tmpdir(), "figo-onboarding-workbench-e2e.png"), join(tmpdir(), "figo-onboarding-trace-inspector-e2e.png")] }, null, 2));
} finally {
  await browser.close(); await api.close(); await rm(root, { recursive: true, force: true });
}
