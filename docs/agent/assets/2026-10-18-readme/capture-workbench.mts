import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createTraceInspectorFixture } from '../../../../code/e2e/trace-inspector-fixture.js';
import { startLocalApi } from '../../../../code/src/ui/local-api.js';
import { nowShanghaiTime } from '../../../../code/src/utils/clock.js';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../../..');
const { chromium } = createRequire(join(root, 'code/package.json'))('playwright-core');
const output = join(directory, 'screenshots');
const temporaryRoot = await realpath(tmpdir());
const workspace = await mkdtemp(join(temporaryRoot, 'figo-readme-'));
const originalFetch = globalThis.fetch;
let remoteRequests = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    remoteRequests++;
    throw new Error('截图期间禁止外部模型或网络请求');
  }
  return originalFetch(input, init);
};
await mkdir(output, { recursive: true });
const fixture = await createTraceInspectorFixture(workspace);
const { kernel, taskId } = fixture;
const db = kernel.storage.db;
await writeFile(join(workspace, 'context-pipeline.ts'), [
  '// 离线演示文件：观察准备信息与实际模型请求的区别。',
  'interface MessageSnapshot {',
  '  sourceRef: string;',
  '  turnId: string;',
  '  role: "user" | "assistant" | "tool";',
  '  content: string;',
  '}',
  '',
  'interface CompactionEntry {',
  '  summaryMarkdown: string;',
  '  firstKeptSourceRef: string;',
  '  coveredSourceRefs: string[];',
  '}',
  '',
  '// 原文保留，检查点只改变下次请求的历史投影。',
  'function projectHistory(',
  '  original: MessageSnapshot[],',
  '  checkpoint: CompactionEntry',
  ') {',
  '  const boundary = original.findIndex(',
  '    item => item.sourceRef === checkpoint.firstKeptSourceRef',
  '  );',
  '  return {',
  '    summary: checkpoint.summaryMarkdown,',
  '    recent: original.slice(boundary)',
  '  };',
  '}',
  ''
].join('\n'));
db.prepare('update turns set output = ? where id = ?').run(
  '### 上下文来源核对（离线演示）\n\n- 文件引用进入 ContextPack，保留来源与行号。\n- 消息原文持久化到 SQLite，压缩不删除原文。\n- 摘要与近期消息共同组成历史投影。\n\n可以在 Trace Inspector 对照实际请求、工具结果和摘要边界。', fixture.firstTurnId);
db.prepare('update turns set output = ? where id = ?').run(
  '### 边界检查（离线演示）\n\n检查器中已准备模型请求、文件读取、工具拒绝和压缩示例。页面中的用量与耗时来自合成夹具，不是实际模型测试结果。', fixture.secondTurnId);
const time = nowShanghaiTime();
for (const [index, title] of ['梳理项目目录与执行入口', '检查模型请求和工具反馈', '查看长对话的摘要边界'].entries()) {
  const id = `readme_task_${index}`;
  db.prepare('insert into tasks(id,session_id,title,status,created_at,updated_at) values(?,?,?,?,?,?)')
    .run(id, kernel.session.id, title, 'completed', time, time);
  db.prepare('insert into turns(id,session_id,task_id,input,output,status,created_at,completed_at,task_seq) values(?,?,?,?,?,?,?,?,?)')
    .run(`readme_turn_${index}`, kernel.session.id, id, title, 'README 离线演示条目。', 'completed', time, time, 1);
}
const counts = () => db.prepare('select (select count(*) from turns) turns, (select count(*) from llm_http_captures) captures, (select count(*) from tool_calls) tools, (select count(*) from ui_runs) runs').get();
const before = counts();
const api = await startLocalApi({ kernel, configRoot: workspace, port: 0, modelConfigured: true,
  requireAccessCode: false, staticRoot: join(root, 'code/web/dist'), branch: 'README-离线演示',
  modelFetch: (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch });
assert.equal((await fetch(api.url)).status, 200, '隔离静态服务必须可访问');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--no-proxy-server'] });
const errors: string[] = [];
const screenshots: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(api.url).origin) return route.continue();
    remoteRequests++;
    return route.abort();
  });
  const shot = async (name: string) => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
    screenshots.push(`${name}.png`);
    console.log(`截图：${name}`);
  };
  await page.goto(api.url, { waitUntil: 'domcontentloaded' });
  await page.locator('.task-sidebar .task-select').first().waitFor();
  await page.locator('.tree-row', { hasText: 'context-pipeline.ts' }).click();
  await page.locator('.cm-line').first().waitFor();
  await shot('tasks');
  await page.locator('.task-sidebar .task-select', { hasText: '分析项目中的上下文来源和压缩过程' }).click();
  await page.locator('.turn-prompt', { hasText: '继续核对实际请求与摘要边界' }).waitFor();
  await shot('workbench');
  await page.getByRole('button', { name: 'Trace Inspector', exact: true }).click();
  await page.locator('[data-event-key]').first().waitFor();
  const capture = db.prepare('select id from llm_http_captures where request_id = ?').get('fixture_after_compaction') as { id: string };
  await page.locator(`[data-event-key="capture:${capture.id}"]`).click();
  const ready = () => page.locator('.ti-detail-scroll[aria-busy="false"] .ti-detail-content').waitFor();
  await ready();
  for (const [name, label] of [['trace-request', '模型请求'], ['context-flow', '上下文流'], ['compaction', '压缩']]) {
    await page.locator('.ti-tabs:not(.ti-subtabs)').getByRole('tab', { name: label, exact: true }).click();
    await ready();
    if (name === 'compaction') await page.locator('.ti-subtabs').getByRole('tab', { name: '前后对比', exact: true }).click();
    await shot(name);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(counts(), before, '只读拍摄不得创建 Run、请求或工具调用');
  assert.equal(Number((counts() as { runs: number }).runs), 0);
  assert.equal(remoteRequests, 0);
  await writeFile(join(output, 'capture.json'), JSON.stringify({ date: '2026-10-18', status: 'pass',
    viewport: { width: 1600, height: 1000 }, screenshots, errors,
    dataSource: '当前源码 + 临时 SQLite 隔离夹具；所有对话、耗时、用量和压缩数值为演示数据，无实际模型调用。',
    before, after: counts(), remoteRequests, taskId
  }, null, 2) + '\n');
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  await api.close();
  if (db.isOpen) db.close();
  const target = await realpath(workspace);
  const within = relative(temporaryRoot, target);
  assert.ok(within.startsWith('figo-readme-') && !within.includes('..') && dirname(target) === temporaryRoot);
  await rm(target, { recursive: true, force: true });
}
