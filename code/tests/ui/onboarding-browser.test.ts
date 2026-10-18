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
let saves: unknown[];
const executablePath = [process.env.CHROME_EXECUTABLE, chromium.executablePath(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"
].find((path): path is string => !!path && existsSync(path));

describe.skipIf(!executablePath)("双图片引导（真实浏览器）", () => {
  beforeAll(async () => {
    server = await createServer({ configFile: resolve("web/vite.config.ts"), server: { port: 0, host: "127.0.0.1", hmr: false }, plugins: [{
      name: "onboarding-fixture",
      resolveId(id) { if (id === "/__onboarding__.js") return id; },
      load(id) {
        if (id !== "/__onboarding__.js") return;
        return `import { createElement as h, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { Onboarding } from '/src/Onboarding.tsx';
          function Fixture() {
            const [view, setView] = useState('workbench');
            const [replay, setReplay] = useState(null);
            const [snapshot, setSnapshot] = useState(window.guideSnapshot || {enabled:true,revision:'1',seen:[]});
            const [error, setError] = useState('');
            return h('div', null,
              h('button', {id:'underlying',style:{position:'fixed',left:0,top:0,width:'100vw',height:'100vh'},onClick:()=>{window.underlyingClicks=(window.underlyingClicks||0)+1;}},'底层按钮'),
              h('div',{style:{position:'relative'}},
                h('button',{onClick:()=>setView('trace-inspector')},'进入 Trace Inspector'),
                h('button',{onClick:()=>setView('workbench')},'返回工作台'),
                h('button',{onClick:()=>setReplay({guide:'workbench',serial:Date.now()})},'重看工作台'),
                h('button',{onClick:()=>setReplay({guide:'trace-inspector',serial:Date.now()})},'重看 Trace'),
                h('button',{onClick:()=>setSnapshot({enabled:true,revision:'2',seen:[]})},'升级素材'),
                h('button',{onClick:()=>setSnapshot({enabled:true,revision:'1',seen:[]})},'刷新旧快照')),
              error && h('p',{role:'alert'},error),
              h(Onboarding,{snapshot,csrf:'fixture-csrf',view,replay,onError:setError}));
          }
          createRoot(document.getElementById('root')).render(h(Fixture));`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__onboarding__.html") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__onboarding__.js"></script></body></html>'));
        });
      }
    }] });
    await server.listen(); origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
    browser = await chromium.launch({ headless: true, executablePath });
  }, 30000);
  beforeEach(async () => {
    saves = []; page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route("**/api/v1/settings/onboarding", async (route) => {
      saves.push(route.request().postDataJSON());
      expect(route.request().headers()["x-figo-csrf"]).toBe("fixture-csrf");
      await route.fulfill({ json: { enabled: true, revision: "1", seen: [] } });
    });
  });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); await server?.close(); });
  const dialog = () => page.getByRole("dialog");
  const open = async () => { await page.goto(`${origin}/__onboarding__.html`); };
  const loaded = async () => { await dialog().waitFor({ timeout: 3000 }); await page.waitForFunction(() => { const image = document.querySelector('dialog img') as HTMLImageElement; return image?.complete && image.naturalWidth > 0; }); };

  it("两张图独立首次展示，关闭不穿透，旧快照不会使已关闭引导重现", async () => {
    await open(); await loaded();
    expect(await dialog().getAttribute("aria-label")).toBe("工作台快速上手");
    await page.mouse.click(2, 2);
    await page.waitForFunction(() => !document.querySelector('dialog'));
    expect(await page.evaluate(() => (window as Window & { underlyingClicks?: number }).underlyingClicks || 0)).toBe(0);
    await page.getByRole("button", { name: "刷新旧快照" }).click(); expect(await dialog().count()).toBe(0);
    await page.getByRole("button", { name: "进入 Trace Inspector" }).click(); await loaded();
    expect(await dialog().getAttribute("aria-label")).toBe("Trace Inspector 核心功能");
    await page.keyboard.press("Escape"); expect(await dialog().count()).toBe(0);
    await page.getByRole("button", { name: "返回工作台" }).click(); expect(await dialog().count()).toBe(0);
    expect(saves).toEqual([{ guide: "workbench", revision: "1" }, { guide: "trace-inspector", revision: "1" }]);
  });

  it("SQLite已看状态抑制自动展示，但可重看任一图片，素材升级重新引导", async () => {
    await page.addInitScript(() => { Object.assign(window, { guideSnapshot: { enabled: true, revision: "1", seen: ["workbench", "trace-inspector"] } }); });
    await open(); await page.getByRole("button", { name: "重看工作台" }).waitFor();
    expect(await dialog().count()).toBe(0);
    for (const name of ["重看工作台", "重看 Trace"]) {
      await page.getByRole("button", { name }).click(); await loaded();
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 180))).toBe(true);
      await page.keyboard.press("Enter"); expect(await dialog().count()).toBe(0);
    }
    await page.getByRole("button", { name: "升级素材" }).click(); await loaded();
    await page.keyboard.press("Space"); expect(await dialog().count()).toBe(0);
    await expect.poll(() => saves.at(-1)).toEqual({ guide: "workbench", revision: "2" });
  });

  it("自动引导关闭时不展示，但仍支持用户主动重看", async () => {
    await page.addInitScript(() => { Object.assign(window, { guideSnapshot: { enabled: false, revision: "1", seen: [] } }); });
    await open(); await page.getByRole("button", { name: "重看工作台" }).waitFor(); expect(await dialog().count()).toBe(0);
    await page.getByRole("button", { name: "重看 Trace" }).click(); await loaded();
    await page.keyboard.press("Escape"); expect(await dialog().count()).toBe(0);
  });

  it("图片加载失败可退出，未成功展示不写已看状态", async () => {
    await page.route("**/onboarding-desktop-v1.png*", (route) => route.request().resourceType() === "image" ? route.abort() : route.continue());
    await open(); await dialog().getByRole("alert").waitFor();
    await page.keyboard.press("Escape"); expect(await dialog().count()).toBe(0); expect(saves).toEqual([]);
  });

  it("保存失败仍立即关闭，并如实提示，不在当前页面反复弹出", async () => {
    await page.unroute("**/api/v1/settings/onboarding");
    await page.route("**/api/v1/settings/onboarding", (route) => route.fulfill({ status: 503, json: { error: "storage unavailable" } }));
    await open(); await loaded(); await page.keyboard.press("Escape");
    await page.getByRole("alert").waitFor(); expect(await dialog().count()).toBe(0);
    await page.getByRole("button", { name: "刷新旧快照" }).click(); expect(await dialog().count()).toBe(0);
  });

  it.each([1440, 390, 320])("%dpx完整等比展示两张图片，无裁切或页面横向溢出", async (width) => {
    await page.setViewportSize({ width, height: 900 }); await open(); await loaded();
    for (const guide of ["workbench", "trace-inspector"]) {
      if (guide === "trace-inspector") { await page.getByRole("button", { name: "进入 Trace Inspector" }).click(); await loaded(); }
      const box = await dialog().locator("img").boundingBox();
      expect(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 900, JSON.stringify(box)).toBe(true);
      expect(await dialog().locator("img").evaluate((node) => getComputedStyle(node).objectFit)).toBe("contain");
      await page.screenshot({ path: join(tmpdir(), `figo-onboarding-${guide}-${width}.png`) });
      await page.keyboard.press("Escape");
    }
  });
});
