import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { AgentKernel } from "../src/kernel/agent-kernel.js";
import { startLocalApi } from "../src/ui/local-api.js";

const workspace = await mkdtemp(join(tmpdir(), "figo-ui-e2e-"));
await writeFile(join(workspace, "note.md"), "第一行\n需要引用的第二行\n第三行\n");
const kernel = await AgentKernel.start({ workspaceRoot: workspace });
const api = await startLocalApi({ kernel, port: 0, model: "MiniMax-M3", branch: "test", requireAccessCode: false, staticRoot: resolve("web/dist") });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
});

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const pageErrors: string[] = [];
  desktop.on("pageerror", (error) => pageErrors.push(error.message));
  await desktop.goto(api.url);
  await desktop.getByRole("button", { name: "新建任务" }).waitFor();
  assert.equal(await desktop.getByLabel("访问码").count(), 0);
  await desktop.getByRole("button", { name: "新建任务" }).click();
  await desktop.getByLabel("任务名称").fill("工作台回归任务");
  await desktop.getByRole("button", { name: "创建", exact: true }).click();
  await desktop.getByText("工作台回归任务").first().waitFor();
  const composer = desktop.locator(".composer textarea");
  await composer.fill("你好，验证工作台对话");
  await desktop.getByRole("button", { name: "发送" }).click();
  await desktop.getByText("本地占位响应", { exact: false }).waitFor();

  await desktop.locator(".tree-row", { hasText: "note.md" }).click();
  await desktop.getByTitle("预览 Markdown").click();
  await desktop.getByText("需要引用的第二行").waitFor();
  await desktop.getByTitle("查看源码").click();
  await desktop.locator(".code-line").nth(1).click();
  await desktop.getByRole("button", { name: "引用选中行" }).click();
  await composer.fill("请解释引用行");
  await desktop.getByRole("button", { name: "发送" }).click();
  await desktop.locator(".chat-scroll").getByText("请解释引用行").waitFor();
  await desktop.getByText("本地占位响应", { exact: false }).nth(1).waitFor();
  await desktop.getByRole("tab", { name: "上下文" }).click();
  await desktop.getByText("note.md#L2-L2").first().waitFor();
  await desktop.getByText("历史第 1 轮").first().waitFor();
  await desktop.getByText("你好，验证工作台对话").last().waitFor();
  await desktop.getByRole("button", { name: "定位到第 1 轮对话" }).click();
  await desktop.locator(".turn-group.focused").getByText("第 1 轮").waitFor();
  await desktop.getByRole("button", { name: "上下文" }).last().click();
  await desktop.screenshot({ path: "/tmp/figo-workbench-desktop.png", fullPage: true });
  await desktop.getByRole("tab", { name: "抓包" }).click();
  await desktop.getByText("模型交互抓包").waitFor();
  await desktop.getByRole("tab", { name: "Trace" }).click();
  await desktop.getByText("当前 Turn · Trace").waitFor();
  await desktop.reload();
  await desktop.locator(".chat-scroll").getByText("请解释引用行").waitFor();
  await desktop.getByRole("button", { name: "新建任务" }).waitFor();

  const narrow = await browser.newPage({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 });
  narrow.on("pageerror", (error) => pageErrors.push(error.message));
  await narrow.goto(api.url);
  await narrow.getByRole("button", { name: "新建任务" }).waitFor();
  assert.equal(await narrow.locator(".sidebar-pane").isVisible(), true);
  await narrow.getByRole("button", { name: "打开检查器" }).click();
  await narrow.getByRole("tab", { name: "上下文" }).waitFor();
  await narrow.screenshot({ path: "/tmp/figo-workbench-narrow.png", fullPage: true });
  assert.equal(await narrow.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "narrow desktop has horizontal overflow");

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  mobile.on("pageerror", (error) => pageErrors.push(error.message));
  await mobile.goto(api.url);
  await mobile.getByRole("button", { name: "打开导航" }).waitFor();
  await mobile.screenshot({ path: "/tmp/figo-workbench-mobile.png", fullPage: true });
  await mobile.getByRole("button", { name: "打开导航" }).click();
  await mobile.locator(".tree-row", { hasText: "note.md" }).click();
  await mobile.locator(".preview-code").waitFor();
  await mobile.getByRole("button", { name: "打开检查器" }).click();
  await mobile.getByRole("tab", { name: "Trace" }).click();
  await mobile.getByText("当前 Turn · Trace").waitFor();
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, "mobile document has horizontal overflow");

  const historyKernel = await AgentKernel.start({ workspaceRoot: workspace });
  const historyApi = await startLocalApi({ kernel: historyKernel, port: 0, staticRoot: resolve("web/dist") });
  try {
    const historyPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    historyPage.on("pageerror", (error) => pageErrors.push(error.message));
    await historyPage.goto(historyApi.url);
    await historyPage.getByLabel("访问码").fill(historyApi.accessCode);
    await historyPage.getByRole("button", { name: "验证并进入" }).click();
    await historyPage.getByRole("button", { name: "历史 Session" }).click();
    await historyPage.locator(".session-list button", { hasText: kernel.session.id.slice(0, 12) }).click();
    await historyPage.getByText("工作台回归任务").first().waitFor();
    assert.equal(await historyPage.locator(".composer textarea").isDisabled(), true);
  } finally {
    await historyApi.close();
    await historyKernel.shutdown();
  }

  const toolWorkspace = await mkdtemp(join(tmpdir(), "figo-ui-tools-"));
  await writeFile(join(toolWorkspace, "figo-agent.config.json"), JSON.stringify({
    activeModelId: "test-model",
    llm: [{ id: "test-model", enabled: true, provider: "openai-compatible", apiKey: "test-only-key", baseUrl: "https://example.invalid/v1", model: "test-model" }]
  }));
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /example\.invalid/);
    modelCalls++;
    const content = modelCalls === 1 ? '```json\n{"type":"tool_calls","calls":[{"id":"call_1","name":"system_info","input":{}}]}\n```' : "工具完成";
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }), { status: 200 });
  };
  let toolKernel: AgentKernel | undefined;
  let toolApi: Awaited<ReturnType<typeof startLocalApi>> | undefined;
  try {
    toolKernel = await AgentKernel.start({ workspaceRoot: toolWorkspace });
    globalThis.fetch = originalFetch;
    toolApi = await startLocalApi({ kernel: toolKernel, port: 0, model: "test-model", staticRoot: resolve("web/dist") });
    const toolPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    toolPage.on("pageerror", (error) => pageErrors.push(error.message));
    await toolPage.goto(toolApi.url);
    await toolPage.getByLabel("访问码").fill(toolApi.accessCode);
    await toolPage.getByRole("button", { name: "验证并进入" }).click();
    await toolPage.locator(".composer textarea").fill("请读取本机系统信息");
    await toolPage.getByRole("button", { name: "发送" }).click();
    await toolPage.getByText("工具完成").waitFor();
    await toolPage.locator(".tool-event", { hasText: "system_info" }).click();
    await toolPage.getByText("关联工具 · system_info").waitFor();
    await toolPage.screenshot({ path: "/tmp/figo-workbench-tools.png", fullPage: true });
    assert.equal(modelCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (toolApi) await toolApi.close();
    if (toolKernel) await toolKernel.shutdown();
    await rm(toolWorkspace, { recursive: true, force: true });
  }
  assert.deepEqual(pageErrors, []);
  console.log("工作台端到端自测通过；截图：/tmp/figo-workbench-desktop.png、/tmp/figo-workbench-narrow.png、/tmp/figo-workbench-mobile.png、/tmp/figo-workbench-tools.png");
} finally {
  await browser.close();
  await api.close();
  await kernel.shutdown();
  await rm(workspace, { recursive: true, force: true });
}
