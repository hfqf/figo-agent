import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let origin: string;
const executablePath = [process.env.CHROME_EXECUTABLE, chromium.executablePath(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome",
  ...(process.env.PROGRAMFILES ? [join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe")] : [])
].find((file): file is string => Boolean(file && existsSync(file)));

describe.skipIf(!executablePath)("首次配置页真实浏览器（隔离 IPC，不调用真实模型）", () => {
  beforeAll(async () => {
    server = await createServer({ configFile: resolve("web/vite.config.ts"), server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [{ name: "desktop-setup-fixture", configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__desktop_setup__.html") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/setup-main.tsx"></script></body></html>'));
        });
      } }] });
    await server.listen(); origin = server.resolvedUrls!.local[0];
    browser = await chromium.launch({ executablePath, headless: true });
  }, 30000);
  beforeEach(async () => {
    page = await browser.newPage();
    await page.addInitScript(() => {
      const state = window as unknown as Record<string, any>;
      state.calls = []; state.discoveryError = false; state.saveError = false;
      let model = { id: "minimax", family: "minimax", baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3", configured: false,
        settings: { activeModelId: "minimax", version: "fixture-version", models: [
          { id: "minimax", family: "minimax", enabled: true, baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3", hasApiKey: false }
        ] } };
      state.figoSetup = {
        read: async () => ({ model, recent: [] }),
        discoverModels: async (input: Record<string, string>) => {
          state.calls.push({ type: "discover", ...input });
          if (state.discoveryError) throw new Error("模型列表请求失败：401。");
          return ["fixture-a", "fixture-b"];
        },
        saveModel: async (input: Record<string, string>) => {
          state.calls.push({ type: "save", ...input });
          if (state.saveError) throw new Error("模型配置已变化，请刷新后重试。");
          const item = { id: input.family, family: input.family, enabled: true, baseUrl: input.baseUrl, model: input.model, hasApiKey: true };
          model = { ...item, configured: true, settings: { activeModelId: item.id, version: "saved-version", models: [item] } };
          return model;
        },
        pickWorkspace: async () => "/fixture/project", openWorkspace: async (path: string) => { state.calls.push({ type: "open", path }); }
      };
    });
    await page.goto(`${origin}__desktop_setup__.html`);
    await page.getByLabel("API Key", { exact: true }).waitFor();
  });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); await server?.close(); });

  it.each(["MiniMax", "DeepSeek", "GPT 官方", "GPT 中转"])("首次可直接选择 %s，拉取模型并保存后打开项目", async (label) => {
    for (const name of ["MiniMax", "DeepSeek", "GPT 官方", "GPT 中转"]) expect(await page.getByRole("button", { name, exact: true }).count()).toBe(1);
    await page.getByRole("button", { name: label, exact: true }).click();
    expect(await page.getByRole("button", { name: "浏览文件夹" }).isDisabled()).toBe(true);
    if (label === "GPT 中转") await page.getByLabel("API 地址", { exact: true }).fill("https://fixture.example/v1");
    else expect(await page.getByLabel("API 地址", { exact: true }).isDisabled()).toBe(true);
    await page.getByLabel("API Key", { exact: true }).fill("fixture-secret");
    await page.getByRole("button", { name: "获取模型列表" }).click();
    await page.getByRole("combobox", { name: "模型 ID" }).selectOption("fixture-b");
    await page.getByRole("button", { name: "保存模型", exact: true }).click();
    await page.getByText("模型配置已保存", { exact: true }).waitFor();
    expect(await page.getByLabel("API Key", { exact: true }).inputValue()).toBe("");
    await page.getByRole("button", { name: "浏览文件夹" }).click();
    await page.getByRole("button", { name: "打开工作区", exact: true }).click();
    const calls = await page.evaluate(() => (window as unknown as { calls: Record<string, string>[] }).calls);
    const family = { MiniMax: "minimax", DeepSeek: "deepseek", "GPT 官方": "gpt-official", "GPT 中转": "gpt-relay" }[label];
    expect(calls.find(call => call.type === "save")).toMatchObject({ family, model: "fixture-b", version: "fixture-version" });
    expect(calls.at(-1)).toEqual({ type: "open", path: "/fixture/project" });
  });

  it("切换服务丢弃未保存密钥，中转地址变化清除旧模型列表", async () => {
    await page.getByLabel("API Key", { exact: true }).fill("fixture-minimax");
    await page.getByRole("button", { name: "GPT 中转", exact: true }).click();
    expect(await page.getByLabel("API Key", { exact: true }).inputValue()).toBe("");
    await page.getByLabel("API 地址", { exact: true }).fill("https://first.example/v1");
    await page.getByLabel("API Key", { exact: true }).fill("fixture-relay");
    await page.getByRole("button", { name: "获取模型列表" }).click();
    await page.getByRole("combobox", { name: "模型 ID" }).selectOption("fixture-a");
    await page.getByLabel("API 地址", { exact: true }).fill("https://second.example/v1");
    expect(await page.getByRole("combobox", { name: "模型 ID" }).inputValue()).toBe("");
    expect(await page.getByRole("button", { name: "保存模型", exact: true }).isDisabled()).toBe(true);
    expect(await page.getByLabel("API Key", { exact: true }).inputValue()).toBe("");
  });

  it("目录查询失败显示错误，不伪造模型选项或允许打开工作区", async () => {
    await page.evaluate(() => { (window as unknown as { discoveryError: boolean }).discoveryError = true; });
    await page.getByRole("button", { name: "DeepSeek", exact: true }).click();
    await page.getByLabel("API Key", { exact: true }).fill("fixture-secret");
    await page.getByRole("button", { name: "获取模型列表" }).click();
    await page.getByRole("alert").filter({ hasText: "401" }).waitFor();
    expect(await page.getByRole("combobox", { name: "模型 ID" }).locator("option").count()).toBe(1);
    expect(await page.getByRole("button", { name: "浏览文件夹" }).isDisabled()).toBe(true);
  });

  it("配置冲突显示错误，不能显示保存成功或打开工作区", async () => {
    await page.evaluate(() => { (window as unknown as { saveError: boolean }).saveError = true; });
    await page.getByRole("button", { name: "DeepSeek", exact: true }).click();
    await page.getByLabel("API Key", { exact: true }).fill("fixture-secret");
    await page.getByRole("button", { name: "获取模型列表" }).click();
    await page.getByRole("combobox", { name: "模型 ID" }).selectOption("fixture-a");
    await page.getByRole("button", { name: "保存模型", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "配置已变化" }).waitFor();
    expect(await page.getByText("模型配置已保存", { exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "浏览文件夹" }).isDisabled()).toBe(true);
  });

  it.each([390, 900])("%dpx 下服务入口与表单不越界", async (width) => {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "GPT 中转", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const buttons = page.getByRole("group", { name: "模型服务" }).getByRole("button");
    expect(await buttons.count()).toBe(4);
    for (const button of await buttons.all()) {
      const box = await button.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);
    }
    await page.screenshot({ path: join(tmpdir(), `figo-setup-services-${width}.png`), fullPage: true });
  });
});
