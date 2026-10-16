import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Page } from "playwright-core";
import { startWorkbench, type WorkbenchHandle } from "../src/ui/start-workbench.js";
import { nowShanghaiTime } from "../src/utils/clock.js";
import type { UiRun } from "../src/ui/run-coordinator.js";
import { assertPayableAmount } from "./workbench-flow-assertions.js";

const repo = resolve(import.meta.dirname, "../..");
const outputRoot = join(repo, ".figo-agent/acceptance", `workbench-flow-${Date.now()}`);
const workspace = join(outputRoot, "workspace");
const timeoutMs = 180_000;
const report: Record<string, unknown> = { startedAt: nowShanghaiTime(), status: "running", steps: [], outputRoot };
const steps = report.steps as Array<Record<string, unknown>>;
const secrets: string[] = [];
const pageErrors: string[] = [];
let configRoot: string | undefined;
let workbench: WorkbenchHandle | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
let slowPid: number | undefined;

function safeError(error: unknown): string {
  let value = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) value = value.replaceAll(secret, "[REDACTED]");
  return value;
}

async function waitUntil(check: () => boolean | Promise<boolean>, label: string, limit = timeoutMs): Promise<void> {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`等待超时：${label}`);
}

function db() { assert.ok(workbench); return workbench.kernel.storage.db; }

function snapshot() {
  return {
    turns: db().prepare("select id, task_id, status, output from turns order by created_at, rowid").all(),
    runs: db().prepare("select run_id, turn_id, status from ui_runs order by created_at, rowid").all(),
    tools: db().prepare("select id, turn_id, tool_name, status, input_json, output_json from tool_calls order by started_at, rowid").all(),
    captures: db().prepare("select request_id, turn_id, response_status, duration_ms from llm_http_captures order by created_at, rowid").all(),
    usage: db().prepare("select request_id, purpose, status, prompt_tokens, completion_tokens, total_tokens from token_usage order by created_at, rowid").all()
  };
}

async function record(name: string, data: Record<string, unknown>): Promise<void> {
  const step = { name, at: nowShanghaiTime(), ...data };
  steps.push(step);
  if (workbench) db().prepare("insert into trace_events (id, session_id, type, source, payload_json, created_at) values (?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), workbench.kernel.session.id, "acceptance.step", "WorkbenchFlowAcceptance", JSON.stringify(step), nowShanghaiTime());
  await writeFile(join(outputRoot, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${name}：${data.status ?? "passed"}\n`);
}

async function send(input: string): Promise<UiRun> {
  assert.ok(page);
  await page.locator(".composer textarea").fill(input);
  const response = page.waitForResponse((item) => /\/api\/v1\/tasks\/[^/]+\/turns$/.test(item.url()) && item.request().method() === "POST");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const accepted = await response;
  assert.equal(accepted.status(), 202);
  return await accepted.json() as UiRun;
}

async function completed(run: UiRun): Promise<string> {
  await waitUntil(() => !["accepted", "running"].includes(workbench!.coordinator.getRun(run.runId).status), "Run 完成");
  assert.equal(workbench!.coordinator.getRun(run.runId).status, "completed");
  const turn = db().prepare("select status, output from turns where id = ?").get(run.turnId) as { status: string; output: string };
  assert.equal(turn.status, "completed");
  assert.ok(turn.output && !turn.output.includes("本地占位响应"));
  await page!.locator(".turn-group").last().locator(".turn-status.completed").waitFor();
  return turn.output;
}

async function openTask(title: string): Promise<void> {
  await page!.locator(".task-panel-list .task-select", { hasText: title }).click();
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function scanSecrets(root: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) count += await scanSecrets(path);
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      assert.ok(secrets.every((secret) => !bytes.includes(Buffer.from(secret))), `验收产物发现凭据：${path}`);
      count++;
    }
  }
  return count;
}

await mkdir(workspace, { recursive: true });
try {
  const source = JSON.parse(await readFile(join(repo, "code/figo-agent.config.json"), "utf8"));
  const active = source.llm.find((entry: { id: string }) => entry.id === source.activeModelId);
  assert.ok(active?.enabled, "当前默认模型未启用");
  if (!active.apiKey?.trim() && process.env.FIGO_ACCEPTANCE_KEY_COMMIT) {
    const history = JSON.parse(execFileSync("git", ["show", `${process.env.FIGO_ACCEPTANCE_KEY_COMMIT}:code/figo-agent.config.json`],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const previous = history.llm.find((entry: { id: string; model: string; baseUrl: string }) =>
      entry.id === active.id && entry.model === active.model && entry.baseUrl === active.baseUrl);
    assert.ok(previous?.apiKey?.trim(), "授权历史中没有与当前模型和端点一致的凭据");
    active.apiKey = previous.apiKey;
  }
  assert.ok(active.apiKey?.trim(), "必须配置真实模型密钥；占位响应不计验收");
  for (const entry of source.llm) {
    if (entry.apiKey?.trim()) secrets.push(entry.apiKey);
    if (entry.id !== active.id) { entry.apiKey = ""; entry.enabled = false; }
  }
  configRoot = await mkdtemp(join(tmpdir(), "figo-workbench-config-"));
  await writeFile(join(configRoot, "figo-agent.config.json"), JSON.stringify(source), { mode: 0o600 });
  const code = `FGO-WB-${randomUUID()}`;
  await writeFile(join(workspace, "order.json"), JSON.stringify({ projectCode: code, unitPrice: 73, quantity: 6, discount: 18 }, null, 2));
  await writeFile(join(workspace, "slow-task.cjs"), [
    "const fs = require('node:fs');",
    "const started = JSON.stringify({ pid: process.pid, startedAt: Date.now() });",
    "fs.appendFileSync('command-starts.jsonl', started + '\\n');",
    "fs.writeFileSync('started.json', started);",
    "setTimeout(() => { fs.writeFileSync('late.marker', 'finished'); console.log('slow task finished'); }, 30000);"
  ].join("\n"));
  report.model = { providerId: active.id, modelId: active.model, baseUrl: active.baseUrl };
  workbench = await startWorkbench({ configRoot, workspaceRoot: workspace, staticRoot: join(repo, "code/web/dist"), port: 0, requireAccessCode: false });
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  page.on("pageerror", (error) => pageErrors.push(safeError(error)));
  const title = "工作台真实使用链路验收";
  await page.goto(workbench.url);
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByLabel("任务名称").fill(title);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const originalSessionId = workbench.kernel.session.id;
  const amountFormat = "最后单独一行写实付金额的纯数字，可以带“实付金额：”字段名，这一行不写公式、单位或 Markdown 装饰。";

  let started = Date.now();
  const first = await send(`请调用 read_file 读取 order.json，然后明确告诉我 projectCode，以及 unitPrice × quantity − discount 的实付金额。不要修改文件，不要只说正在处理。${amountFormat}`);
  const firstAnswer = await completed(first);
  assert.ok(firstAnswer.includes(code));
  assertPayableAmount(firstAnswer, 420);
  assert.ok(db().prepare("select id from tool_calls where turn_id = ? and tool_name = 'read_file' and status = 'completed'").get(first.turnId));
  await page.locator(".turn-answer").filter({ hasText: code }).waitFor();
  await page.screenshot({ path: join(outputRoot, "01-read-and-answer.png"), fullPage: true });
  await record("读取文件并明确答复", { status: "passed", runId: first.runId, turnId: first.turnId, taskId: first.taskId, wallMs: Date.now() - started, answer: firstAnswer });

  started = Date.now();
  const followup = await send(`根据刚才已读到的数据，数量增加到 7，单价和优惠不变，实付是多少？同时原样给出 projectCode。直接使用已有证据，不再调用工具。${amountFormat}`);
  const followupAnswer = await completed(followup);
  assert.equal(followup.taskId, first.taskId);
  assert.ok(followupAnswer.includes(code));
  assertPayableAmount(followupAnswer, 493);
  assert.equal(Number((db().prepare("select count(*) as n from tool_calls where turn_id = ?").get(followup.turnId) as { n: number }).n), 0);
  const followupCapture = db().prepare("select request_id, request_body_json from llm_http_captures where turn_id = ? order by created_at, rowid limit 1").get(followup.turnId) as { request_id: string; request_body_json: string };
  assert.ok(followupCapture.request_body_json.includes(code), "追问实际请求必须携带文件证据");
  await page.screenshot({ path: join(outputRoot, "02-followup.png"), fullPage: true });
  await record("同一任务连续追问", { status: "passed", runId: followup.runId, turnId: followup.turnId, requestId: followupCapture.request_id, wallMs: Date.now() - started, answer: followupAnswer, tools: 0, priorEvidenceInRequest: true });

  const slow = await send("请用 run_command 执行 node slow-task.cjs，timeoutMs 设置为 60000。这是一个 30 秒测试命令，不修改脚本，不使用其他工具替代，执行结束再给出结果。");
  await waitUntil(async () => { try { await readFile(join(workspace, "started.json")); return true; } catch { return false; } }, "实际命令启动");
  slowPid = JSON.parse(await readFile(join(workspace, "started.json"), "utf8")).pid;
  assert.ok(slowPid && processAlive(slowPid));
  const beforeRefresh = snapshot();
  const commandStarts = await readFile(join(workspace, "command-starts.jsonl"), "utf8");
  assert.equal(commandStarts.trim().split("\n").length, 1);
  await page.reload();
  await openTask(title);
  await page.getByRole("button", { name: "停止运行", exact: true }).waitFor();
  const afterRefresh = snapshot();
  assert.deepEqual(afterRefresh.runs, beforeRefresh.runs);
  assert.deepEqual(afterRefresh.tools.map((tool) => tool.id), beforeRefresh.tools.map((tool) => tool.id));
  assert.deepEqual(afterRefresh.captures, beforeRefresh.captures);
  assert.equal(await readFile(join(workspace, "command-starts.jsonl"), "utf8"), commandStarts);
  await page.screenshot({ path: join(outputRoot, "03-running-after-refresh.png"), fullPage: true });
  await record("长命令启动且刷新不重放", { status: "passed", runId: slow.runId, turnId: slow.turnId, childPid: slowPid,
    runsBefore: beforeRefresh.runs.length, runsAfter: afterRefresh.runs.length,
    toolIdsBefore: beforeRefresh.tools.map((tool) => tool.id), toolIdsAfter: afterRefresh.tools.map((tool) => tool.id), commandStartCount: 1 });

  started = Date.now();
  const stopResponse = page.waitForResponse((item) => item.url().endsWith(`/runs/${slow.runId}/stop`));
  await page.getByRole("button", { name: "停止运行", exact: true }).click();
  assert.equal((await stopResponse).status(), 202);
  await waitUntil(() => workbench!.coordinator.getRun(slow.runId).status === "interrupted", "停止入库", 10_000);
  await waitUntil(() => !processAlive(slowPid!), "命令子进程退出", 10_000);
  await workbench.coordinator.waitForIdle();
  assert.equal((db().prepare("select status from turns where id = ?").get(slow.turnId) as { status: string }).status, "interrupted");
  assert.equal((db().prepare("select status from tool_calls where turn_id = ? and tool_name = 'run_command'").get(slow.turnId) as { status: string }).status, "failed");
  assert.equal((db().prepare("select count(*) n from tool_calls where turn_id = ?").get(slow.turnId) as { n: number }).n, 1);
  assert.equal((db().prepare("select count(*) as n from trace_events where turn_id = ? and type = 'tool.completed'").get(slow.turnId) as { n: number }).n, 0);
  await page.getByText("运行已由用户停止。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "发送", exact: true }).waitFor();
  await page.screenshot({ path: join(outputRoot, "04-stopped.png"), fullPage: true });
  await record("用户停止并结束子进程", { status: "passed", runId: slow.runId, turnId: slow.turnId, stopMs: Date.now() - started, childExited: true, cancelledToolReportedCompleted: false });

  started = Date.now();
  const resumed = await send(`上一轮已经由我停止，不要重新执行命令或调用工具。请使用之前订单文件的数据，给出 projectCode 和原来数量 6 的实付金额，并说明现在可以继续对话。${amountFormat}`);
  const resumedAnswer = await completed(resumed);
  assert.ok(resumedAnswer.includes(code));
  assertPayableAmount(resumedAnswer, 420);
  assert.equal(resumed.taskId, first.taskId);
  assert.equal((db().prepare("select count(*) as n from tool_calls where turn_id = ?").get(resumed.turnId) as { n: number }).n, 0);
  assert.equal(await readFile(join(workspace, "late.marker")).then(() => true, () => false), false);
  assert.equal(await readFile(join(workspace, "command-starts.jsonl"), "utf8"), commandStarts);
  await page.screenshot({ path: join(outputRoot, "05-continue-after-stop.png"), fullPage: true });
  await record("停止后继续对话", { status: "passed", runId: resumed.runId, turnId: resumed.turnId, wallMs: Date.now() - started, answer: resumedAnswer, stoppedCommandReplayed: false });

  const beforeHistory = snapshot();
  await page.reload();
  await openTask(title);
  await page.locator(".turn-group").nth(3).waitFor();
  assert.equal(await page.locator(".turn-group").count(), 4);
  await page.locator(".turn-answer").filter({ hasText: code }).last().waitFor();
  started = Date.now();
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([workbench.close(), new Promise<never>((_resolve, reject) => {
      closeTimer = setTimeout(() => reject(new Error("浏览器保持连接时，工作台服务关闭超过 10 秒")), 10_000);
    })]);
  } finally { clearTimeout(closeTimer); }
  const serviceCloseMs = Date.now() - started;
  workbench = undefined;
  workbench = await startWorkbench({ configRoot, workspaceRoot: workspace, staticRoot: join(repo, "code/web/dist"), port: 0, requireAccessCode: false });
  await page.goto(workbench.url);
  await page.getByRole("button", { name: "历史 Session", exact: true }).click();
  await page.locator(".session-list button", { hasText: originalSessionId.slice(0, 12) }).click();
  await page.locator(".turn-group").nth(3).waitFor();
  assert.equal(await page.locator(".turn-group").count(), 4);
  await page.locator(".turn-answer").filter({ hasText: code }).last().waitFor();
  assert.equal(await page.locator(".composer textarea").isDisabled(), true);
  assert.deepEqual(snapshot(), beforeHistory, "历史回放不得增加或改写 Turn/Run/Tool/Capture/Usage");
  await page.screenshot({ path: join(outputRoot, "06-history-after-restart.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.locator(".turn-group").nth(3).waitFor();
  await page.screenshot({ path: join(outputRoot, "07-history-mobile.png"), fullPage: true });
  await record("刷新及服务重启后回放历史", { status: "passed", oldSessionId: originalSessionId, newSessionId: workbench.kernel.session.id,
    historicalTurns: 4, readOnly: true, duplicateExecutions: 0, mobileOverflow: false, serviceCloseMs });
  assert.deepEqual(pageErrors, []);
  report.evidence = snapshot();
  report.pageErrors = pageErrors;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = safeError(error);
  if (workbench) report.evidence = snapshot();
  if (page) await page.screenshot({ path: join(outputRoot, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (workbench) {
    const running = db().prepare("select run_id from ui_runs where status in ('accepted', 'running')").all() as Array<{ run_id: string }>;
    for (const row of running) workbench.coordinator.stop(row.run_id);
    await workbench.close();
    workbench = undefined;
  }
  if (configRoot) await rm(configRoot, { recursive: true, force: true });
  report.finishedAt = nowShanghaiTime();
  report.temporaryConfigRemoved = true;
  await writeFile(join(outputRoot, "report.json"), JSON.stringify(report, null, 2));
  try { report.scannedFiles = await scanSecrets(outputRoot); report.secretScan = "passed"; }
  catch (error) { report.status = "failed"; report.secretScan = safeError(error); process.exitCode = 1; }
  await writeFile(join(outputRoot, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`真实工作台验收：${report.status}；报告：${join(outputRoot, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
