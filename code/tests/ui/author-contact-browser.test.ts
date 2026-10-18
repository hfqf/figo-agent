import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";

type ContactWindow = Window & {
  copied: string[];
  copyBehavior: "success" | "fail" | "defer";
  releaseCopy?: () => void;
};
let server: ViteDevServer;
let browser: Browser;
let page: Page;
let origin: string;
let apiCalls: string[];
const executablePath = [process.env.CHROME_EXECUTABLE, chromium.executablePath(),
  ...(process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : []),
  ...(process.platform === "linux" ? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"] : []),
  ...(process.platform === "win32" ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
    .filter(Boolean).map((root) => join(root!, "Google/Chrome/Application/chrome.exe")) : [])
].find((path): path is string => !!path && existsSync(path));

describe.skipIf(!executablePath)("联系作者（真实浏览器，不调用模型或数据库）", () => {
  beforeAll(async () => {
    server = await createServer({ configFile: resolve("web/vite.config.ts"),
      server: { port: 0, host: "127.0.0.1", hmr: false }, plugins: [{
        name: "author-contact-fixture",
        resolveId(id) { if (id === "/__author_contact__.js") return id; },
        load(id) {
          if (id !== "/__author_contact__.js") return;
          return `import { createElement as h } from 'react';
            import { createRoot } from 'react-dom/client';
            import { AuthorContact } from '/src/AuthorContact.tsx';
            import { BrandLogo } from '/src/BrandLogo.tsx';
            import '/src/styles.css';
            createRoot(document.getElementById('root')).render(h('div', {className:'app-shell'},
              h('header', {className:'topbar'}, h('div',{className:'brand-lockup'}, h(BrandLogo),
                h('span',{className:'brand-name'},h('strong',null,'Figo Agent'),
                  h('span',{className:'brand-version'},h(AuthorContact),h('small',{className:'app-version'},'v0.0.1-beta'))))),
              h('button',{id:'outside'},'任务正文')));`;
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (req.url !== "/__author_contact__.html") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__author_contact__.js"></script></body></html>'));
          });
        }
      }] });
    await server.listen(); origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
    browser = await chromium.launch({ headless: true, executablePath });
  }, 30000);
  beforeEach(async () => {
    apiCalls = [];
    page = await browser.newPage();
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) apiCalls.push(request.url()); });
    await page.addInitScript(() => {
      const state = window as ContactWindow;
      state.copied = []; state.copyBehavior = "success";
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => {
        if (state.copyBehavior === "fail") throw new DOMException("clipboard denied", "NotAllowedError");
        if (state.copyBehavior === "defer") await new Promise<void>((resolve) => { state.releaseCopy = resolve; });
        state.copied.push(text);
      } } });
    });
    await page.goto(`${origin}/__author_contact__.html`);
  });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); await server?.close(); });
  const trigger = () => page.getByRole("button", { name: "联系作者", exact: true });
  const dialog = () => page.getByRole("dialog", { name: "联系作者", exact: true });
  const copyButton = () => page.getByRole("button", { name: "复制微信号", exact: true });

  it("默认收起，点击显示正确微信号且不请求API或跳转", async () => {
    await trigger().waitFor({ timeout: 2000 });
    expect(await dialog().count()).toBe(0);
    const url = page.url();
    await trigger().click();
    await dialog().waitFor();
    expect(await dialog().getByLabel("微信", { exact: true }).inputValue()).toBe("hfqf123");
    expect(await copyButton().evaluate((node) => node === document.activeElement)).toBe(true);
    expect(page.url()).toBe(url);
    expect(apiCalls).toEqual([]);
    await trigger().click();
    expect(await dialog().count()).toBe(0);
  });

  it("复制确实完成后反馈成功，重新打开重置状态", async () => {
    await trigger().click(); await copyButton().click();
    await page.getByRole("status").filter({ hasText: "微信号已复制" }).waitFor();
    expect(await page.evaluate(() => (window as ContactWindow).copied)).toEqual(["hfqf123"]);
    await dialog().getByRole("button", { name: "关闭", exact: true }).click();
    await trigger().click();
    expect(await dialog().getByRole("status").count()).toBe(0);
    expect(apiCalls).toEqual([]);
  });

  it.each(["fail", "unavailable"])("剪贴板 %s 时保留可手动复制的微信号，不显示假成功", async (failure) => {
    await page.evaluate((failure) => {
      if (failure === "unavailable") Object.defineProperty(navigator, "clipboard", { value: undefined });
      else (window as ContactWindow).copyBehavior = "fail";
    }, failure);
    await trigger().click(); await copyButton().click();
    await dialog().getByRole("alert").waitFor();
    expect(await dialog().innerText()).toContain("手动复制");
    expect(await dialog().getByRole("status").count()).toBe(0);
    expect(await dialog().getByLabel("微信", { exact: true }).inputValue()).toBe("hfqf123");
  });

  it("Escape恢复焦点，关闭按钮和点击外部均收起浮层", async () => {
    await trigger().click(); await page.keyboard.press("Escape");
    expect(await dialog().count()).toBe(0);
    expect(await trigger().evaluate((node) => node === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    await dialog().getByRole("button", { name: "关闭", exact: true }).click();
    expect(await dialog().count()).toBe(0);
    await trigger().click(); await page.getByRole("button", { name: "任务正文" }).click();
    expect(await dialog().count()).toBe(0);
  });

  it("Tab离开非模态浮层后不遮挡正文", async () => {
    await trigger().click(); await page.keyboard.press("Tab");
    expect(await dialog().count()).toBe(0);
    expect(await page.getByRole("button", { name: "任务正文" }).evaluate((node) => node === document.activeElement)).toBe(true);
  });

  it("关闭并重开后丢弃迟到的复制反馈", async () => {
    await page.evaluate(() => { (window as ContactWindow).copyBehavior = "defer"; });
    await trigger().click(); await copyButton().click();
    expect(await copyButton().isDisabled()).toBe(true);
    await page.keyboard.press("Escape"); await trigger().click();
    await page.evaluate(async () => { (window as ContactWindow).releaseCopy!(); await new Promise(requestAnimationFrame); });
    expect(await dialog().getByRole("status").count()).toBe(0);
    expect(await copyButton().isEnabled()).toBe(true);
  });

  it.each([1440, 390, 320])("%dpx下浮层和文案不越界", async (width) => {
    await page.setViewportSize({ width, height: 844 });
    await trigger().click(); await dialog().waitFor();
    const box = await dialog().boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);
    expect(await dialog().evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: join(tmpdir(), `figo-author-contact-${width}.png`) });
  });
});
