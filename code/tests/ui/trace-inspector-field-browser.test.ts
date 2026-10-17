import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import type { InspectorField } from "../../web/src/trace-inspector-state.js";

const marker = (eventKey = "capture:request/a?#"): InspectorField => ({
  __inspectorField: true, eventKey, field: "request_body_json", path: ["messages", 3, "content"],
  originalChars: 50000, preview: "脱敏预览，不是完整正文", loadable: true,
});
type FixtureWindow = Window & { mount(kind: string, value: unknown): void; accepted: string[]; copied: string[] };
let server: ViteDevServer;
let browser: Browser;
let page: Page;
let origin: string;
const executablePath = [
  process.env.CHROME_EXECUTABLE, chromium.executablePath(),
  ...(process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : []),
  ...(process.platform === "linux" ? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"] : []),
  ...(process.platform === "win32" ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
    .filter((root): root is string => !!root).map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe")) : []),
].find((path): path is string => !!path && existsSync(path));

describe.skipIf(!executablePath)(`Trace Inspector 字段按需读取（真实浏览器，无模型、无SQLite${executablePath ? "" : "；无可用Chrome，跳过"}）`, () => {
beforeAll(async () => {
  server = await createServer({
    configFile: resolve("web/vite.config.ts"),
    server: { port: 0, host: "127.0.0.1", hmr: false },
    plugins: [{
      name: "trace-inspector-test-fixture",
      resolveId(id) { if (id === "/__trace_fixture__.js") return id; },
      load(id) {
        if (id !== "/__trace_fixture__.js") return;
        return `import { createElement } from 'react';
          import { createRoot } from 'react-dom/client';
          import { FieldPreview } from '/src/TraceInspectorField.tsx';
          import { JsonView } from '/src/TraceInspectorPrimitives.tsx';
          import { TraceInspector } from '/src/TraceInspector.tsx';
          import { TraceInspectorSource } from '/src/TraceInspectorSource.tsx';
          import { TraceInspectorDetails } from '/src/TraceInspectorDetails.tsx';
          import { inspectorCopy } from '/src/i18n.ts';
          import '/src/trace-inspector.css';
          const root = createRoot(document.getElementById('root'));
          window.accepted = []; window.copied = [];
          Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => window.copied.push(text) } });
          window.mount = (kind, value) => root.render(kind === 'details'
            ? createElement(TraceInspectorDetails, { ...value, onRequest() {}, onCompaction() {}, onSource() {}, onTool() {}, onOpenFile() {}, onOpenTurn() {} }) : kind === 'source'
            ? createElement(TraceInspectorSource, { ...value, onClose() {} }) : kind === 'inspector'
            ? createElement(TraceInspector, { ...value, onClose() {}, onOpenTurn() {}, onOpenFile() {} }) : kind === 'json' || kind === 'scoped-json'
            ? createElement(JsonView, { value, label: '测试JSON', exportScope: kind === 'scoped-json' ? inspectorCopy.detailExportScope : undefined })
            : createElement(FieldPreview, { value, onContent: (content) => window.accepted.push(content) }));`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__trace_fixture__.html") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div class="trace-inspector"><main class="ti-detail-scroll" id="root"></main></div><script type="module" src="/__trace_fixture__.js"></script></body></html>'));
        });
      },
    }],
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
  browser = await chromium.launch({ headless: true, executablePath });
}, 30000);
beforeEach(async () => {
  page = await browser.newPage();
  await page.goto(`${origin}/__trace_fixture__.html`);
  await page.waitForFunction(() => typeof (window as FixtureWindow).mount === "function");
});
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); await server?.close(); });
async function mount(value: unknown, kind = "field") {
  await page.evaluate(({ value, kind }) => (window as FixtureWindow).mount(kind, value), { value, kind });
}
function fieldPage(value: InspectorField, content: string, offset = 0, nextOffset: number | null = null, totalChars = offset + content.length) {
  return { eventKey: value.eventKey, field: value.field, path: value.path, format: "text", content, offset, nextOffset, totalChars, complete: nextOffset === null };
}

  it("仅点击后GET读取脱敏分页，offset按响应推进且复制不把预览冒充全文", async () => {
    const value = marker();
    const calls: URL[] = [];
    await page.route("**/api/v1/trace-inspector/events/**/field?**", async (route) => {
      expect(route.request().method()).toBe("GET");
      const url = new URL(route.request().url()); calls.push(url);
      const offset = Number(url.searchParams.get("offset"));
      await route.fulfill({ json: offset === 0 ? fieldPage(value, "完整正文首段", 0, 6, 12) : fieldPage(value, "完整正文末段", 6, null, 12) });
    });
    await mount({ messages: [{ role: "user", content: value }], choices: [{ finish_reason: "stop" }] }, "json");
    await page.getByRole("button", { name: "加载完整", exact: true }).waitFor();
    expect(calls).toHaveLength(0);
    await page.getByRole("button", { name: "加载完整", exact: true }).click();
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
    await page.getByText("字段已完整加载", { exact: true }).waitFor();
    expect(calls.map((url) => url.searchParams.get("offset"))).toEqual(["0", "6"]);
    expect(calls[0].pathname).toContain(encodeURIComponent(value.eventKey));
    expect(JSON.parse(calls[0].searchParams.get("path")!)).toEqual(value.path);
    await page.getByRole("button", { name: "复制脱敏 JSON", exact: true }).click();
    await page.waitForFunction(() => (window as FixtureWindow).copied.length === 1);
    const copied = await page.evaluate(() => (window as FixtureWindow).copied[0]);
    expect(copied).toContain("完整正文首段完整正文末段");
    expect(copied).not.toContain("__inspectorField");
    expect(copied).toContain("finish_reason");
  });
  it("整页复制及下载共享显式scope，不声称包含其他标签按需加载的正文", async () => {
    await mount({ row: { key: "capture:one" } }, "scoped-json");
    await page.getByRole("button", { name: "复制脱敏 JSON", exact: true }).click();
    await page.waitForFunction(() => (window as FixtureWindow).copied.length === 1);
    const data = JSON.parse(await page.evaluate(() => (window as FixtureWindow).copied[0]));
    expect(data.scope).toContain("不包含其他标签或视图按需加载的内容");
    expect(data.data.row.key).toBe("capture:one");
  });
  it("切换scope或字段后丢弃迟到响应，不向旧消费者回传正文", async () => {
    const old = marker("capture:old");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    await page.route("**/api/v1/trace-inspector/events/**/field?**", async (route) => {
      started(); await pending;
      await route.fulfill({ json: fieldPage(old, "旧scope的迟到正文") });
    });
    await mount(old);
    await page.getByRole("button", { name: "加载完整", exact: true }).click();
    await entered;
    await mount({ ...marker("capture:new"), preview: "新scope预览" });
    await page.getByText("新scope预览", { exact: true }).waitFor();
    const response = page.waitForResponse((item) => item.url().includes("/field?"));
    release(); await response;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => (window as FixtureWindow).accepted)).toEqual([]);
    expect(await page.locator("body").innerText()).not.toContain("旧scope的迟到正文");
  });
  it("网络失败可重试，错误字段响应不拼接也不推进offset", async () => {
    const value = marker(); let count = 0;
    await page.route("**/api/v1/trace-inspector/events/**/field?**", async (route) => {
      count++;
      if (count === 1) return route.fulfill({ status: 503, json: { error: "读取暂不可用" } });
      if (count === 2) return route.fulfill({ json: fieldPage(marker("capture:wrong"), "错误请求正文") });
      expect(new URL(route.request().url()).searchParams.get("offset")).toBe("0");
      await route.fulfill({ json: fieldPage(value, "当前字段正文") });
    });
    await mount(value);
    await page.getByRole("button", { name: "加载完整", exact: true }).click();
    await page.getByRole("alert").getByText("读取暂不可用").waitFor();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.getByText("字段分页响应不匹配，请重试", { exact: true }).waitFor();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.getByText("字段已完整加载", { exact: true }).waitFor();
    expect(await page.evaluate(() => (window as FixtureWindow).accepted)).toEqual(["当前字段正文"]);
  });
  it("工具失败长错误在表格和Facts中均不崩溃，支持只读分页加载", async () => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    const value = { ...marker("tool:failed-tool"), field: "error_message", path: [], preview: "工具失败的脱敏预览" };
    const content = "完整工具错误".repeat(5000);
    const calls: number[] = [];
    await page.route("**/api/v1/trace-inspector/events/**/field?**", async (route) => {
      const url = new URL(route.request().url()); const offset = Number(url.searchParams.get("offset"));
      expect(route.request().method()).toBe("GET"); expect(url.searchParams.get("field")).toBe("error_message");
      expect(JSON.parse(url.searchParams.get("path")!)).toEqual([]); calls.push(offset);
      const next = Math.min(offset + 24000, content.length);
      await route.fulfill({ json: fieldPage(value, content.slice(offset, next), offset, next < content.length ? next : null, content.length) });
    });
    const time = "2026-10-17 12:00:00.000";
    const row = { key: value.eventKey, category: "tool", time, kind: "tool.failed", status: "error", sessionId: "s", taskId: "t", turnId: "turn", turnSeq: 1,
      source: "Tool", name: "read_file", durationMs: 1, tokens: null, refs: { toolCallId: "failed-tool" } };
    await mount({ tab: "tool-calls", requestId: null, compactionEntryId: null, detail: {
      row, record: {}, events: [], context: { pack: null, items: [], checkpoint: null }, captures: [], messages: [], compactions: [], legacyCheckpoints: [], artifacts: [], limitations: [], truncated: false,
      selection: { taskId: "t", turnId: "turn", requestId: null, requestAssociation: "unknown", compactionEntryId: null, compactionAttemptId: null, recoveryOfRequestId: null, contextPackId: null,
        projection: { status: "unknown", compactionEntryId: null, sourceRefs: [], usageScope: null } },
      tools: [{ id: "failed-tool", intentId: "call", turnId: "turn", name: "read_file", round: 1, status: "failed", input: { path: "x" }, output: null,
        errorMessage: value, startedAt: time, completedAt: time, relation: "direct" }],
    } }, "details");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(errors).toEqual([]);
    const table = page.locator("tbody td").nth(4);
    const facts = page.locator(".ti-facts");
    for (const view of [table, facts]) {
      await view.getByRole("button", { name: "加载完整", exact: true }).click();
      await view.getByRole("button", { name: "加载更多", exact: true }).click();
      await view.getByText("字段已完整加载", { exact: true }).waitFor();
      expect(await view.locator(".ti-field pre").innerText()).toBe(content);
    }
    expect(calls).toEqual([0, 24000, 0, 24000]); expect(errors).toEqual([]);
  });
  it("真实列表请求默认排除UI，LLM/工具过滤保留关联Trace，高级入口恢复传输与全部类别", async () => {
    const categories: string[] = [];
    await page.route("**/api/v1/tasks/*/trace-inspector/events?**", async (route) => {
      const category = new URL(route.request().url()).searchParams.get("category") ?? "";
      categories.push(category);
      const row = { key: "capture:one", category: "capture", time: "2026-10-17 12:00:00.000", kind: "llm.completed", status: "ok",
        sessionId: "s", taskId: "t", turnId: "turn", turnSeq: 1, source: "LLM", name: "业务模型请求", durationMs: 0, durationState: "recorded", tokens: null, tokenState: "provider_unavailable", refs: {} };
      const transport = { ...row, key: "ui:one", category: "ui", kind: "assistant.text.delta", name: "传输增量", durationMs: null, durationState: "not_applicable", tokenState: "not_applicable" };
      await route.fulfill({ json: { events: [row, transport].filter((item) => category.split(",").includes(item.category)), nextCursor: null, hasMore: false, truncated: false } });
    });
    await mount({ workspace: "fixture", taskId: "t", tasks: [{ id: "t", title: "模拟任务" }], revision: 0 }, "inspector");
    await page.getByText("业务模型请求", { exact: true }).waitFor();
    expect(categories[0].split(",")).not.toContain("ui");
    expect(await page.getByText("传输增量", { exact: true }).count()).toBe(0);
    await page.getByRole("combobox", { name: "事件类型", exact: true }).selectOption("ui");
    await page.getByText("传输增量", { exact: true }).waitFor();
    expect(categories.at(-1)).toBe("ui");
    await page.getByRole("combobox", { name: "事件类型", exact: true }).selectOption("all");
    await page.getByText("业务模型请求", { exact: true }).waitFor();
    expect(categories.at(-1)?.split(",")).toContain("ui");
    const llm = page.waitForRequest((item) => new URL(item.url()).searchParams.get("category") === "capture,trace");
    await page.getByRole("combobox", { name: "事件类型", exact: true }).selectOption("llm"); await llm;
    const tool = page.waitForRequest((item) => new URL(item.url()).searchParams.get("category") === "tool,trace");
    await page.getByRole("combobox", { name: "事件类型", exact: true }).selectOption("tool"); await tool;
  });
  it.each(["模型请求", "模型响应"])("普通事件进入%s自动选请求，手选与跨事件/任务作用域正确保留", async (tab) => {
    const calls: string[] = [];
    const time = "2026-10-17 12:00:00.000";
    const row = (task: string, suffix: string) => ({ key: `trace:${task}-${suffix}`, category: "trace", time, kind: "turn.completed", status: "ok",
      sessionId: "s", taskId: task, turnId: `${task}-${suffix}`, turnSeq: 1, source: "Loop", name: suffix, durationMs: null, tokens: null, refs: {} });
    await page.route("**/api/v1/tasks/*/trace-inspector/events?**", async (route) => {
      const task = new URL(route.request().url()).pathname.split("/")[4];
      await route.fulfill({ json: { events: [row(task, "one"), row(task, "two")], nextCursor: null, hasMore: false, truncated: false } });
    });
    await page.route("**/api/v1/trace-inspector/events/**", async (route) => {
      expect(route.request().method()).toBe("GET");
      const url = new URL(route.request().url()); calls.push(url.pathname + url.search);
      const key = decodeURIComponent(url.pathname.split("/")[5]);
      const task = key.includes("taskB") ? "taskB" : "taskA";
      const suffix = key.endsWith("two") ? "two" : "one";
      const selected = url.searchParams.get("requestId");
      const ids = [`${task}-${suffix}-first`, `${task}-${suffix}-second`];
      if (selected && !ids.includes(selected)) return route.fulfill({ status: 400, json: { error: "请求归属不匹配" } });
      await route.fulfill({ json: {
        row: row(task, suffix), record: {}, events: [], context: { pack: null, items: [], checkpoint: null }, tools: [], messages: [], compactions: [], legacyCheckpoints: [], artifacts: [], limitations: [], truncated: false,
        selection: { taskId: task, turnId: `${task}-${suffix}`, requestId: selected, requestAssociation: selected ? "selected" : "unknown", compactionEntryId: null,
          compactionAttemptId: null, recoveryOfRequestId: null, contextPackId: null, projection: { status: "unknown", compactionEntryId: null, sourceRefs: [], usageScope: null } },
        captures: ids.map(id => ({ id, requestId: id, taskId: task, turnId: `${task}-${suffix}`, purpose: "turn", provider: "fixture", model: "fixture", url: "https://fixture.invalid", method: "POST",
          requestHeaders: {}, requestBody: { messages: [{ role: "user", content: `请求正文-${id}` }] }, responseStatus: 200, responseStatusText: "OK", responseHeaders: {},
          responseBody: { choices: [{ message: { content: `响应正文-${id}` }, finish_reason: "stop" }] }, durationMs: 1, createdAt: time,
          usage: { status: "unavailable", promptTokens: null, completionTokens: null, totalTokens: null, usageTurnId: null }, relation: "scope_only" }))
      } });
    });
    await mount({ workspace: "fixture", taskId: "taskA", tasks: [{ id: "taskA", title: "任务A" }, { id: "taskB", title: "任务B" }], revision: 0 }, "inspector");
    await page.locator('[data-event-key="trace:taskA-one"]').click();
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('select[aria-label="请求选择"]') as HTMLSelectElement)?.value === "taskA-one-first");
    const content = tab === "模型请求" ? "请求正文" : "响应正文";
    await page.locator(".ti-detail-content").filter({ hasText: `${content}-taskA-one-first` }).waitFor();
    expect(calls.some(call => call.includes("requestId=taskA-one-first"))).toBe(true);
    await page.getByLabel("请求选择", { exact: true }).selectOption("taskA-one-second");
    await page.locator(".ti-detail-content").filter({ hasText: `${content}-taskA-one-second` }).waitFor();
    const other = tab === "模型请求" ? "模型响应" : "模型请求";
    await page.getByRole("tab", { name: other, exact: true }).click();
    await page.locator(".ti-detail-content").filter({ hasText: `正文-taskA-one-second` }).waitFor();
    expect(await page.getByLabel("请求选择", { exact: true }).inputValue()).toBe("taskA-one-second");
    await page.locator('[data-event-key="trace:taskA-two"]').click();
    await page.locator(".ti-detail-content").filter({ hasText: `正文-taskA-two-first` }).waitFor();
    expect(await page.getByLabel("请求选择", { exact: true }).inputValue()).toBe("taskA-two-first");
    await page.getByLabel("任务", { exact: true }).selectOption("taskB");
    await page.locator('[data-event-key="trace:taskB-one"]').click();
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await page.locator(".ti-detail-content").filter({ hasText: `${content}-taskB-one-first` }).waitFor();
    expect(await page.getByLabel("请求选择", { exact: true }).inputValue()).toBe("taskB-one-first");
    expect(await page.getByRole("alert").count()).toBe(0);
  });
  it("长字段在桌面与移动视口可见且不撑破页面，不可加载字段不发请求", async () => {
    const requests: string[] = [];
    await page.route("**/api/**", (route) => { requests.push(route.request().url()); return route.abort(); });
    await mount({ content: { ...marker(), preview: "长行正文".repeat(500), loadable: false }, metadata: { finish_reason: "tool_calls" } }, "json");
    await page.getByText("此字段仅保留预览，无法加载完整内容", { exact: true }).waitFor();
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const rect = await page.locator(".ti-field").boundingBox();
      expect(rect!.width).toBeGreaterThan(100);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      if (process.env.FIGO_TRACE_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.FIGO_TRACE_SCREENSHOT_DIR, `trace-field-${viewport.width}.png`) });
    }
    expect(requests).toEqual([]);
  });
  it("真实页码替换当前页，前后翻页、筛选清零及实时窗口统计一致", async () => {
    let datasetSize = 525;
    await page.route("**/api/v1/tasks/*/trace-inspector/events?**", async route => {
      const query = new URL(route.request().url()).searchParams;
      const total = query.get("q") === "none" ? 0 : query.get("group") === "llm" ? 3 : datasetSize;
      const size = Number(query.get("limit") ?? 200);
      const latest = query.get("latest") === "true";
      const pages = Math.ceil(total / size);
      const current = total ? Math.min(Number(query.get("page") ?? 1), pages) : 0;
      const offset = latest ? Math.max(0, total-size) : Math.max(0, (current-1)*size);
      const events = Array.from({ length: Math.min(size, total-offset) }, (_, index) => ({ key: `trace:page-${offset+index+1}`, category: "trace", time: "2026-10-17 12:00:00.000",
        kind: query.get("group") === "llm" ? "llm.completed" : "turn.completed", status: "ok", sessionId: "s", taskId: "t", turnId: "turn", turnSeq: 1,
        source: "Fixture", name: `事件${offset+index+1}`, durationMs: null, tokens: null, refs: {} }));
      await route.fulfill({ json: { events, nextCursor: null, hasMore: latest ? total > events.length : current < pages, truncated: latest ? total > events.length : current < pages,
        pagination: { totalCount: total, page: latest ? null : current, totalPages: latest ? null : pages, pageSize: size, from: total ? offset+1 : 0, to: offset+events.length } } });
    });
    await mount({ workspace: "fixture", taskId: "t", tasks: [{ id: "t", title: "分页任务" }], revision: 0 }, "inspector");
    await page.getByText("共 525 条", { exact: true }).waitFor({ timeout: 2000 });
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.getByText("第 2 / 3 页", { exact: true }).waitFor();
    expect(await page.locator("[data-event-key]").count()).toBe(200);
    expect(await page.locator('[data-event-key="trace:page-1"]').count()).toBe(0);
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await page.getByText("第 1 / 3 页", { exact: true }).waitFor();
    await page.getByRole("button", { name: "末页", exact: true }).click();
    await page.getByText("第 3 / 3 页", { exact: true }).waitFor();
    expect(await page.locator("[data-event-key]").count()).toBe(125);
    expect(await page.getByRole("button", { name: "下一页", exact: true }).isDisabled()).toBe(true);
    datasetSize = 325;
    await page.locator(".ti-toolbar").getByRole("button", { name: "刷新", exact: true }).click();
    await page.getByText("第 2 / 2 页", { exact: true }).waitFor();
    datasetSize = 525;
    await page.locator(".ti-toolbar").getByRole("button", { name: "刷新", exact: true }).click();
    await page.getByText("第 2 / 3 页", { exact: true }).waitFor({ timeout: 2000 });
    await page.getByLabel("事件类型", { exact: true }).selectOption("llm");
    await page.getByText("共 3 条", { exact: true }).waitFor();
    await page.getByText("第 1 / 1 页", { exact: true }).waitFor();
    await page.getByLabel("搜索事件、模型、工具或引用", { exact: true }).fill("none");
    await page.getByText("共 0 条", { exact: true }).waitFor();
    await page.getByText("第 0 / 0 页", { exact: true }).waitFor();
    await page.getByLabel("搜索事件、模型、工具或引用", { exact: true }).fill("");
    await page.getByLabel("事件类型", { exact: true }).selectOption("");
    await page.getByText("共 525 条", { exact: true }).waitFor();
    await page.getByLabel("实时跟随", { exact: true }).check();
    await page.getByText("最新 500 条", { exact: true }).waitFor();
    expect(await page.getByText("共 525 条", { exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "下一页", exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "从最早事件分页", exact: true }).click();
    await page.getByText("第 1 / 3 页", { exact: true }).waitFor();
    await mount({ workspace: "initial-live", taskId: "t", currentTaskId: "t", tasks: [{ id: "t", title: "活动任务", status: "active" }], revision: 0 }, "inspector");
    await page.getByText("最新 500 条", { exact: true }).waitFor({ timeout: 2000 });
    expect(await page.getByLabel("实时跟随", { exact: true }).isChecked()).toBe(true);
  });
  it.each(["preview", "tooLarge", "same", "different"] as const)("来源长正文比较状态 %s：预览不冒充完整原文", async (mode) => {
    const original = "长正文".repeat(10000);
    const content = mode === "different" ? "修改后的正文" : original;
    await page.route("**/api/v1/trace-inspector/file?**", async (route) => {
      expect(route.request().method()).toBe("GET");
      expect(new URL(route.request().url()).searchParams.get("path")).toBe("sample.md");
      await route.fulfill({ json: { path: "sample.md", content, size: content.length, lineCount: 1, version: "fixture-version", tooLarge: mode === "tooLarge" } });
    });
    await mount({ source: "sample.md#L1-L1", snapshot: { content: mode === "preview" ? { ...marker("context:item"), preview: original.slice(0, 9) } : original }, file: true, truncated: false }, "source");
    await page.getByRole("button", { name: "查看文件当前版本", exact: true }).click();
    const expected = mode === "preview" || mode === "tooLarge" ? "版本关系未确认；当前文件不替代历史快照"
      : mode === "same" ? "当前文件所选行与执行时快照一致（不代表完整版本一致）" : "当前文件所选行与执行时快照不同";
    await page.getByText(expected, { exact: true }).waitFor();
    if (mode === "tooLarge") await page.getByText("当前文件超过预览字节限制", { exact: true }).waitFor();
  });
});
