import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { startLocalApi } from "../src/ui/local-api.js";
import { AgentKernel } from "../src/kernel/agent-kernel.js";
import { WorkspaceRegistry } from "../src/ui/workspace-registry.js";
import { TraceRecorder } from "../src/trace/trace-recorder.js";
import { createTraceInspectorFixture } from "./trace-inspector-fixture.js";

const root = await mkdtemp(join(tmpdir(), "figo-trace-browser-"));
const nextRoot = await mkdtemp(join(tmpdir(), "figo-trace-browser-next-"));
const shots = resolve(process.env.FIGO_TRACE_SHOTS ?? "../docs/agent/modules/ui/trace-inspector/assets/acceptance-2026-10-16");
await mkdir(shots, { recursive: true });
const fixture = await createTraceInspectorFixture(root);
const { kernel, taskId, compactionEntryId } = fixture;
kernel.storage.db.prepare("insert into tasks (id,session_id,title,status,created_at,updated_at) values (?,?,?,?,?,?)")
  .run("fixture_empty_task", kernel.session.id, "已归档空任务", "archived", "2026-01-01 00:00:00.000", "2026-01-01 00:00:00.000");
process.stdout.write("夹具已就绪\n");
const registry = await WorkspaceRegistry.open(root);
const api = await startLocalApi({ kernel, port: 0, modelConfigured: true, requireAccessCode: false, staticRoot: resolve("web/dist"), branch: "inspector-e2e",
  registry, createKernel: path => AgentKernel.start({ workspaceRoot: path, configRoot: root }) });
process.stdout.write(`本地服务已就绪 ${api.url}\n`);
const candidates = [process.env.CHROME_EXECUTABLE, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter((path): path is string => Boolean(path));
let executablePath: string | undefined;
for (const path of candidates) { try { await access(path); executablePath = path; break; } catch { /* 按平台继续探测。 */ } }
assert.ok(executablePath, "需要本地 Chrome，或设置 CHROME_EXECUTABLE");
assert.equal((await fetch(api.url)).status, 200, "静态页面必须由本地服务提供");
const browser = await chromium.launch({ headless: true, executablePath, args: ["--no-proxy-server"] });
process.stdout.write("浏览器已启动\n");
const errors: string[] = [];
const checks: string[] = [];
const before = kernel.storage.db.prepare("select (select count(*) from turns) as turns, (select count(*) from llm_http_captures) as captures, (select count(*) from tool_calls) as tools").get();
const captureKey = (request: string) => {
  const row = kernel.storage.db.prepare("select id from llm_http_captures where request_id = ?").get(request) as { id: string };
  return `capture:${row.id}`;
};
const tabs = [["overview", "总览"], ["context-flow", "上下文流"], ["llm-request", "模型请求"], ["llm-response", "模型响应"], ["tool-calls", "工具调用"], ["compaction", "压缩"], ["raw", "原始 JSON"]] as const;
async function ready(page: Page) {
  await page.locator('.ti-detail-scroll[aria-busy="false"] .ti-detail-content').waitFor();
}
async function select(page: Page, key: string) {
  await page.locator(`[data-event-key=${JSON.stringify(key)}]`).click();
  await ready(page);
}
async function screenshot(page: Page, name: string) {
  process.stdout.write(`截图 ${name}\n`);
  await page.getByTestId("trace-inspector").screenshot({ path: join(shots, `${name}.png`) });
  assert.ok(await page.getByTestId("trace-inspector").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), `${name} 页面不能横向溢出`);
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("requestfailed", request => process.stderr.write(`请求失败 ${request.url()} ${request.failure()?.errorText}\n`));
  await page.goto(api.url, { waitUntil: "domcontentloaded", timeout: 15000 });
  process.stdout.write("工作台已加载\n");
  await page.locator(".composer textarea").fill("检查器返回后必须保留的草稿");
  await page.getByRole("button", { name: "Trace Inspector", exact: true }).click();
  await page.locator("[data-event-key]").first().waitFor();
  await select(page, captureKey("fixture_after_compaction"));
  for (const [name, label] of tabs) {
    await page.locator(".ti-tabs:not(.ti-subtabs)").getByRole("tab", { name: label, exact: true }).click();
    await ready(page);
    await screenshot(page, `1440-${name}`);
  }
  checks.push("1440x900 七个一级标签真实后端截图");
  await page.locator(".ti-tabs:not(.ti-subtabs)").getByRole("tab", { name: "压缩", exact: true }).click();
  await ready(page);
  await page.getByLabel("摘要选择", { exact: true }).selectOption(compactionEntryId);
  await ready(page);
  for (const [name, label] of [["process", "过程"], ["summary", "摘要"], ["messages", "来源消息"], ["comparison", "前后对比"], ["metadata", "元数据"]]) {
    await page.locator(".ti-subtabs").getByRole("tab", { name: label, exact: true }).click();
    await screenshot(page, `1440-compaction-${name}`);
  }
  assert.ok((await page.locator(".ti-detail-content").innerText()).includes("fixture_summary_history"));
  checks.push("压缩五个二级标签、两个摘要请求引用");

  await select(page, captureKey("fixture_request_one"));
  await page.getByRole("tab", { name: "模型响应", exact: true }).click();
  await ready(page);
  assert.ok((await page.locator(".ti-detail-content").innerText()).includes("先读取文件核对内容"));
  assert.ok((await page.locator(".ti-detail-content").innerText()).includes("tool_calls"));
  await screenshot(page, "1440-native-response");
  await page.getByRole("tab", { name: "模型请求", exact: true }).click();
  await ready(page);
  await page.getByLabel("请求选择", { exact: true }).selectOption("fixture_request_two");
  await ready(page);
  assert.ok((await page.locator(".ti-detail-content").innerText()).includes("tool_call_id"));
  assert.ok(!(await page.locator(".ti-detail-content").innerText()).includes("fixture-only-secret"));
  checks.push("请求选择共享、原生过程正文和工具往返、脱敏");

  await select(page, captureKey("fixture_after_compaction"));
  await page.getByRole("tab", { name: "上下文流", exact: true }).click();
  await ready(page);
  await page.locator(".ti-source-refs button").first().click();
  const source = page.getByRole("dialog", { name: "执行时快照", exact: true });
  await source.waitFor();
  assert.ok((await source.innerText()).includes("已核对项目结构"));
  await screenshot(page, "1440-source-snapshot");
  await source.getByRole("button", { name: "关闭", exact: true }).click();
  checks.push("消息引用打开执行时快照");
  await page.locator(".ti-table-scroll tr").filter({ hasText: "file_reference" }).getByRole("button").first().click();
  await source.waitFor();
  assert.ok((await source.innerText()).includes("文件历史内容"));
  await source.getByRole("button", { name: "查看文件当前版本", exact: true }).click();
  await source.locator(".ti-file-current").waitFor();
  assert.ok((await source.innerText()).includes("文件当前版本"));
  assert.ok(!(await source.locator(".ti-file-current").innerText()).includes("文件历史内容"));
  await screenshot(page, "1440-file-current");
  await source.getByRole("button", { name: "关闭", exact: true }).click();
  checks.push("本地文件历史快照和当前版本分开读取");

  const handle = page.getByRole("separator", { name: "事件表宽度", exact: true });
  const oldWidth = (await page.locator(".ti-list").boundingBox())!.width;
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + 80); await page.mouse.down();
  await page.mouse.move(box.x - 80, box.y + 80, { steps: 6 }); await page.mouse.up();
  assert.ok((await page.locator(".ti-list").boundingBox())!.width < oldWidth - 40);
  await handle.dblclick();
  assert.ok(Math.abs((await page.locator(".ti-list").boundingBox())!.width - oldWidth) < 8);
  await page.locator("[data-selected=true]").focus();
  const previousKey = await page.locator("[data-selected=true]").getAttribute("data-event-key");
  await page.keyboard.press("ArrowDown");
  assert.notEqual(await page.locator("[data-selected=true]").getAttribute("data-event-key"), previousKey);
  await page.keyboard.press("Control+k");
  assert.equal(await page.getByLabel("搜索事件、模型、工具或引用").evaluate(node => node === document.activeElement), true);
  checks.push("分栏拖动和双击复位、键盘选行和搜索");

  const inspector = page.getByTestId("trace-inspector");
  await inspector.locator(".ti-toolbar").getByRole("button", { name: "导出脱敏 JSON", exact: true }).click({ trial: true });
  const downloadPromise = page.waitForEvent("download");
  await inspector.locator(".ti-toolbar").getByRole("button", { name: "导出脱敏 JSON", exact: true }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  const exported = JSON.parse(await readFile(downloadPath!, "utf8"));
  assert.equal(exported.redacted, true);
  assert.ok(exported.loadedRows > 0);
  checks.push("真实下载的脱敏JSON与加载范围");
  await select(page, captureKey("fixture_after_compaction"));
  await page.locator("[data-selected=true]").click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制行摘要", exact: true }).click();
  await page.locator(".ti-footer [role=status]").filter({ hasText: "已复制" }).waitFor();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  assert.equal(copied.refs.requestId, "fixture_after_compaction");
  checks.push("右键菜单复制真实剪贴板的脱敏行摘要");

  await select(page, captureKey("fixture_after_compaction"));
  await page.getByLabel("实时跟随", { exact: true }).check();
  const selectedKey = await page.locator("[data-selected=true]").getAttribute("data-event-key");
  const trace = new TraceRecorder(kernel.storage);
  const liveEvent = await trace.record({ sessionId: kernel.session.id, taskId, turnId: fixture.secondTurnId, type: "tool.completed", source: "浏览器验收", payload: { name: "live-late-fact" } });
  api.coordinator.events.append({ sessionId: kernel.session.id, taskId, kind: "trace.recorded", payload: { type: liveEvent.type } });
  await page.locator(`[data-event-key="trace:${liveEvent.id}"]`).waitFor();
  assert.equal(await page.locator("[data-selected=true]").getAttribute("data-event-key"), selectedKey);
  assert.equal(await page.getByLabel("请求选择", { exact: true }).inputValue(), "fixture_after_compaction");
  await page.getByLabel("仅失败", { exact: true }).check();
  await page.waitForFunction(() => { const rows = [...document.querySelectorAll(".ti-event-table tbody tr")]; return rows.length > 0 && rows.every(row => row.querySelector(".ti-error,.ti-denied,.ti-interrupted")); });
  await screenshot(page, "1440-failure-filter");
  checks.push("SSE后只读更新保留选中请求、筛选不混旧行");
  await page.getByLabel("仅失败", { exact: true }).uncheck();
  await page.locator(`[data-event-key=${JSON.stringify(captureKey("fixture_after_compaction"))}]`).waitFor();

  const search = page.getByLabel("搜索事件、模型、工具或引用");
  await search.fill("not-existing-inspector-event");
  await page.getByText("暂无符合条件的事件", { exact: true }).waitFor();
  await screenshot(page, "1440-empty-filter");
  await search.fill("");
  await page.locator("[data-event-key]").first().waitFor();
  await page.route("**/trace-inspector/events?*", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"隔离验收：查询暂不可用"}' }), { times: 1 });
  await inspector.locator(".ti-toolbar").getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("alert").getByText("隔离验收：查询暂不可用", { exact: true }).waitFor();
  await screenshot(page, "1440-query-error");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.getByRole("alert").waitFor({ state: "hidden" });
  checks.push("空筛选、查询错误及重试保留已有记录");

  await select(page, captureKey("fixture_after_compaction"));
  let signalSlow!: () => void;
  const slowStarted = new Promise<void>(resolve => { signalSlow = resolve; });
  let finishSlow!: () => void;
  const slowFinished = new Promise<void>(resolve => { finishSlow = resolve; });
  await page.route("**/trace-inspector/events/*/llm-response?*", async route => {
    const response = await route.fetch();
    signalSlow();
    await new Promise(resolve => setTimeout(resolve, 650));
    await route.fulfill({ response }).catch(() => {});
    finishSlow();
  }, { times: 1 });
  await page.getByRole("tab", { name: "模型响应", exact: true }).click();
  await slowStarted;
  await inspector.getByLabel("任务", { exact: true }).selectOption("fixture_empty_task");
  await page.getByText("暂无符合条件的事件", { exact: true }).waitFor();
  await slowFinished;
  assert.equal(await page.locator(".ti-detail-content").count(), 0, "迟到详情不能进入另一Task");
  await screenshot(page, "1440-archived-empty-task");
  await inspector.getByLabel("任务", { exact: true }).selectOption(taskId);
  await page.locator("[data-event-key]").first().waitFor();
  checks.push("历史任务切换与迟到详情隔离");

  await page.setViewportSize({ width: 1920, height: 1080 });
  await select(page, captureKey("fixture_after_compaction"));
  await screenshot(page, "1920-overview");
  const listBox = (await page.locator(".ti-list").boundingBox())!;
  const detailBox = (await page.locator(".ti-detail").boundingBox())!;
  assert.ok(listBox.x + listBox.width <= detailBox.x, "左右区域不重叠");
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  assert.equal(await page.locator(".composer textarea").inputValue(), "检查器返回后必须保留的草稿");
  checks.push("1920x1080 布局和返回草稿保持");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Trace Inspector", exact: true }).click();
  await page.locator("[data-event-key]").first().waitFor();
  await screenshot(page, "390-list");
  await select(page, captureKey("fixture_after_compaction"));
  for (const [name, label] of tabs) {
    await page.locator(".ti-tabs:not(.ti-subtabs)").getByRole("tab", { name: label, exact: true }).click();
    await ready(page);
    await screenshot(page, `390-${name}`);
  }
  await page.getByRole("button", { name: "返回事件列表", exact: true }).click();
  assert.equal(await page.locator(".ti-list").isVisible(), true);
  checks.push("390x844 列表/详情切换、七个标签不溢出");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel("实时跟随", { exact: true }).uncheck();
  // 同毫秒批量记录在事务中造数，分页和 Live 都必须从真实 API 读取。
  const insert = kernel.storage.db.prepare("insert into trace_events (id,session_id,task_id,turn_id,type,source,payload_json,created_at) values (?,?,?,?,?,?,?,?)");
  kernel.storage.db.exec("begin");
  for (let i = 0; i < 525; i++) insert.run(`fixture_bulk_${i}`, kernel.session.id, taskId, fixture.secondTurnId, "tool.completed", "分页验收", "{}", "2026-10-16 23:00:00.000");
  kernel.storage.db.exec("commit");
  await inspector.locator(".ti-toolbar").getByRole("button", { name: "刷新", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".ti-event-table tbody tr").length === 200);
  const firstPageKeys = await page.locator("[data-event-key]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-event-key")));
  await page.getByRole("button", { name: "加载下一页", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".ti-event-table tbody tr").length === 400);
  const pagedKeys = await page.locator("[data-event-key]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-event-key")));
  assert.equal(new Set(pagedKeys).size, pagedKeys.length);
  assert.deepEqual(pagedKeys.slice(0, 200), firstPageKeys);
  await screenshot(page, "1440-pagination");
  await page.getByLabel("实时跟随", { exact: true }).check();
  api.coordinator.events.append({ sessionId: kernel.session.id, taskId, kind: "trace.recorded", payload: {} });
  await page.locator('[data-event-key="trace:fixture_bulk_524"]').waitFor();
  assert.ok(await page.locator("[data-event-key]").count() <= 500);
  assert.ok((await page.locator(".ti-footer").innerText()).includes("未查完"));
  assert.equal(await page.getByRole("button", { name: "下一页", exact: true }).count(), 0, "Live尾窗口不能显示无游标的死按钮");
  checks.push("超过500行分页无重复、Live最近窗口可见新事实且明确范围");
  assert.deepEqual(errors, []);
  assert.deepEqual(kernel.storage.db.prepare("select (select count(*) from turns) as turns, (select count(*) from llm_http_captures) as captures, (select count(*) from tool_calls) as tools").get(), before);
  checks.push("无浏览器运行错误、无新增Turn/模型调用/工具重放");
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  await page.locator(".workspace-switcher").click();
  await page.locator("#workspace-path").fill(nextRoot);
  await page.locator(".workspace-dialog .dialog-actions button[type=submit]").click();
  await page.waitForFunction(path => document.querySelector(".workspace-switcher")?.getAttribute("title") === path, nextRoot);
  await page.getByRole("button", { name: "Trace Inspector", exact: true }).click();
  await page.locator("[data-event-key]").first().waitFor();
  assert.notEqual(await inspector.getByLabel("任务", { exact: true }).inputValue(), taskId);
  assert.equal(await page.locator(".ti-detail-content").count(), 0);
  assert.ok(!(await inspector.innerText()).includes("fixture_after_compaction"));
  await screenshot(page, "1440-new-workspace");
  checks.push("切换真实临时工作区后检查器不残留旧事件或请求");
  await writeFile(join(shots, "result.json"), JSON.stringify({ passed: true, date: "2026-10-16", data: "isolated-sqlite-fixture", checks, errors }, null, 2));
  process.stdout.write(JSON.stringify({ passed: true, checks: checks.length, screenshots: shots }, null, 2) + "\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  await writeFile(join(shots, "result.json"), JSON.stringify({ passed: false, date: "2026-10-16", checks,
    errors: [...errors, error instanceof Error ? error.message : String(error)] }, null, 2));
  for (const page of browser.contexts().flatMap(context => context.pages())) await page.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await api.close();
  if (api.kernel.storage.db.isOpen) api.kernel.storage.db.close();
  if (kernel.storage.db.isOpen) kernel.storage.db.close();
  registry.close();
  await rm(root, { recursive: true, force: true });
  await rm(nextRoot, { recursive: true, force: true });
}
