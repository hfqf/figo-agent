import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { _electron } from "playwright-core";
import { defaultRuntimeConfig } from "../dist/config/runtime-config.js";

const require = createRequire(import.meta.url);
const liveConfig = process.env.FIGO_DSML_REAL_CONFIG;
const source = liveConfig ? JSON.parse(await readFile(liveConfig, "utf8")) : undefined;
const model = source?.llm.find((entry) => entry.id === source.activeModelId);
if (liveConfig) assert.ok(model?.enabled && model.apiKey && model.toolCallingMode === "text", "实测需要已配置的文本协议模型");
const root = await mkdtemp(join(tmpdir(), "figo-desktop-dsml-"));
const configRoot = join(root, "config");
const workspace = join(root, "workspace");
const marker = `DSML-VERIFIED-${crypto.randomUUID()}`;
const dsml = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_file"><｜｜DSML｜｜ parameter name="input" string="false">{"path":"README.md"}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
let requests = 0;
let remoteRequests = 0;
let electronApp;
let db;
const modelServer = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests++;
    if (requests > 9) throw new Error("验收请求数超过上限");
    if (requests === 1 || !liveConfig) {
      const content = requests === 1 ? dsml : requests === 2
        ? JSON.stringify({ type: "tool_calls", calls: [{ id: "verified_read", name: "read_file", input: { path: "README.md" } }] })
        : `FINAL\n${marker}`;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
      return;
    }
    remoteRequests++;
    const upstream = await fetch(`${model.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${model.apiKey}` },
      body: JSON.stringify({ ...body, model: model.model }), signal: AbortSignal.timeout(60000)
    });
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    if (upstream.body) Readable.fromWeb(upstream.body).on("error", () => response.destroy()).pipe(response);
    else response.end();
  } catch {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "DSML 验收代理请求失败" } }));
  }
});

try {
  await mkdir(configRoot); await mkdir(workspace);
  await writeFile(join(workspace, "README.md"), marker);
  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const config = { ...defaultRuntimeConfig, activeModelId: "dsml-test", llm: [{
    id: "dsml-test", enabled: true, provider: "openai-compatible", model: model?.model ?? "dsml-test",
    baseUrl: `http://127.0.0.1:${modelServer.address().port}`, apiKey: "test-only-key", toolCallingMode: "text"
  }] };
  await writeFile(join(configRoot, "figo-agent.config.json"), JSON.stringify(config), { mode: 0o600 });
  const env = { ...process.env, FIGO_DESKTOP_SMOKE_CONFIG_ROOT: configRoot, FIGO_DESKTOP_SMOKE_WORKSPACE: workspace };
  delete env.ELECTRON_RUN_AS_NODE;
  const binary = process.env.FIGO_DESKTOP_BINARY;
  electronApp = await _electron.launch({ executablePath: binary || require("electron"),
    args: binary ? ["--desktop-e2e"] : [".", "--desktop-e2e"], env, timeout: 30000 });
  const page = await electronApp.firstWindow();
  const { DatabaseSync } = require("node:sqlite");
  const results = [];
  for (const scenario of liveConfig ? ["injected-repair", "live-task"] : ["injected-repair"]) {
    if (scenario === "live-task") await page.locator(".task-back").click();
    await page.getByRole("button", { name: "新建", exact: true }).click();
    await page.getByLabel("任务名称").fill(`DSML ${scenario}`);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.locator(".composer textarea").fill("请用 read_file 读取 README.md，最终回答给出文件中的完整标记，不要猜测。");
    await page.getByRole("button", { name: "发送" }).click();
    await page.locator(".turn-status.completed, .turn-status.failed").last().waitFor({ timeout: 180000 });
    db = new DatabaseSync(join(workspace, ".figo-agent/figo-agent.db"), { readOnly: true });
    db.exec("PRAGMA busy_timeout = 3000");
    const turn = db.prepare("select id, status, output from turns order by rowid desc limit 1").get();
    const captures = db.prepare("select response_status, duration_ms, request_body_json, response_body_json from llm_http_captures where turn_id=? order by rowid").all(turn.id);
    const repairs = db.prepare("select payload_json from trace_events where turn_id=? and type='tool_call.repair.requested'").all(turn.id);
    const tools = db.prepare("select tool_name, status from tool_calls where turn_id=? order by rowid").all(turn.id);
    assert.equal(turn.status, "completed");
    assert.ok(turn.output.includes(marker) && !turn.output.includes("DSML｜"));
    assert.ok(tools.some((tool) => tool.tool_name === "read_file" && tool.status === "completed"));
    assert.ok(captures.every((capture) => capture.response_status === 200));
    if (scenario === "injected-repair") {
      assert.equal(repairs.length, 1);
      assert.equal(JSON.parse(repairs[0].payload_json).reason, "unsupported_dsml_tool_calls");
    }
    if (model?.apiKey) assert.ok(!JSON.stringify(captures).includes(model.apiKey));
    results.push({ scenario, turnId: turn.id, model: model?.model ?? "stub", status: turn.status,
      requests: captures.length, repairs: repairs.length, tools, durationsMs: captures.map((capture) => capture.duration_ms),
      output: turn.output });
    db.close(); db = undefined;
  }
  await page.screenshot({ path: join(tmpdir(), "figo-desktop-dsml.png") });
  const report = { mode: liveConfig ? "injected-first-response-then-real-model" : "stub", remoteRequests, results };
  await writeFile(join(tmpdir(), "figo-desktop-dsml-result.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const page = electronApp?.windows()[0];
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(tmpdir(), "figo-desktop-dsml-failed.png") }).catch(() => {});
    process.stderr.write(`DSML 验收页面：${JSON.stringify({ url: page.url(), text: (await page.locator("body").innerText()).slice(0, 1200) })}\n`);
  }
  throw error;
} finally {
  db?.close();
  if (electronApp) {
    await electronApp.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
    await electronApp.close();
  }
  modelServer.closeAllConnections();
  await new Promise((resolve) => modelServer.close(resolve));
  await rm(root, { recursive: true, force: true });
}
