import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { AgentKernel } from "../src/kernel/agent-kernel.js";
import { startLocalApi } from "../src/ui/local-api.js";

// 仅使用临时配置与虚构密钥，禁止读取用户密钥或请求外部模型。
const root = await mkdtemp(join(tmpdir(), "figo-model-save-browser-"));
const configPath = join(root, "figo-agent.config.json");
await writeFile(configPath, JSON.stringify({ activeModelId: "gpt-relay", llm: [
  { id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "", baseUrl: "https://api.minimaxi.com/v1", model: "mini-test" },
  { id: "gpt-relay", enabled: true, provider: "openai-compatible", apiKey: "", baseUrl: "https://relay.example/v1", model: "gpt-test", toolCallingMode: "native" },
  { id: "deepseek", enabled: true, provider: "openai-compatible", apiKey: "", baseUrl: "https://api.deepseek.com", model: "deep-test" }
] }));
const kernel = await AgentKernel.start({ workspaceRoot: root, configRoot: root });
const api = await startLocalApi({ kernel, port: 0, requireAccessCode: false,
  configRoot: root, staticRoot: resolve("web/dist"), modelConfigured: false,
  modelFetch: (async () => new Response(JSON.stringify({ data: [{ id: "gpt-live" }] }),
    { headers: { "content-type": "application/json" } })) as typeof fetch });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let releaseStaleBootstrap = () => {};
try {
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_EXECUTABLE ?? (process.platform === "win32"
      ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    args: ["--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(api.url);
  const observer = await browser.newPage({ viewport: { width: 390, height: 844 } });
  observer.on("pageerror", (error) => errors.push(error.message));
  await observer.goto(api.url);
  await observer.locator(".connection-status.online").waitFor();
  assert.equal(await observer.locator(".composer textarea").isDisabled(), true);
  let captured!: () => void;
  let fulfilled!: () => void;
  let captureFirst = true;
  const staleCaptured = new Promise<void>((resolve) => { captured = resolve; });
  const staleFulfilled = new Promise<void>((resolve) => { fulfilled = resolve; });
  const staleGate = new Promise<void>((resolve) => { releaseStaleBootstrap = resolve; });
  await observer.route("**/api/v1/bootstrap", async (route) => {
    if (!captureFirst) return route.continue();
    captureFirst = false;
    const response = await route.fetch();
    captured();
    await staleGate;
    await route.fulfill({ response });
    fulfilled();
  });
  api.coordinator.events.append({ sessionId: kernel.session.id, kind: "task.updated", payload: {} });
  await staleCaptured;
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("API Key", { exact: true }).fill("fixture-relay-replacement");
  await page.getByRole("button", { name: "获取模型列表", exact: true }).click();
  await page.getByLabel("模型 ID", { exact: true }).selectOption("gpt-live");
  const firstResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/settings/models") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  assert.equal((await firstResponse).status(), 200);
  await page.getByRole("status").getByText("模型配置已保存并立即生效。", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "");
  await observer.waitForFunction(() => {
    const select = document.querySelector<HTMLSelectElement>(".composer-model-select");
    return select?.selectedOptions[0]?.textContent === "gpt-live" && !document.querySelector<HTMLTextAreaElement>(".composer textarea")?.disabled;
  });
  releaseStaleBootstrap();
  await staleFulfilled;
  await observer.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await observer.locator(".composer textarea").isDisabled(), false, "旧 bootstrap 响应不能覆盖新模型的已配置状态");
  await page.getByRole("button", { name: /MiniMax/ }).click();
  await page.getByLabel("API Key", { exact: true }).fill("fixture-mini-replacement");
  const secondResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/settings/models") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  assert.equal((await secondResponse).status(), 200);
  await page.getByRole("status").waitFor();
  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(persisted.activeModelId, "gpt-relay");
  assert.equal(persisted.llm[1].model, "gpt-live");
  assert.equal(kernel.defaultModelSelection().modelId, "gpt-live");
  assert.deepEqual(persisted.llm.map((entry: { apiKey: string }) => entry.apiKey), ["fixture-mini-replacement", "fixture-relay-replacement", ""]);
  const response = await page.request.get(`${api.url}/api/v1/settings/models`);
  const snapshot = await response.text();
  assert.ok(!snapshot.includes("fixture-mini-replacement") && !snapshot.includes("fixture-relay-replacement"));
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>(".composer-model-select")?.selectedOptions[0]?.textContent === "gpt-live");
  assert.equal(await page.locator(".composer-model-select optgroup").count(), 2);
  for (const current of [page, observer]) {
    assert.equal(await current.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const boot = await (await current.request.get(`${api.url}/api/v1/bootstrap`)).json();
    assert.equal(boot.sessionId, kernel.session.id);
    assert.equal(boot.modelConfigured, true);
  }
  assert.equal(kernel.storage.db.prepare("select count(*) n from turns").get()!.n, 0);
  assert.deepEqual(errors, []);
  console.log("通过：Chrome 连续保存密钥并即时更新默认模型、模型列表与跨页 SSE；移动端解除未配置状态；保留 Session；返回不含密钥，无页面异常或横向溢出。");
} finally {
  releaseStaleBootstrap();
  await browser?.close();
  await api.close();
  await kernel.shutdown();
  kernel.storage.db.close();
  await rm(root, { recursive: true, force: true });
}
