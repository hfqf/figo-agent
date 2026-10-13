import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "playwright-core";

const require = createRequire(import.meta.url);
const source = JSON.parse(await readFile(join(process.cwd(), "figo-agent.config.json"), "utf8"));
const active = source.llm.find((entry) => entry.id === source.activeModelId);
assert.ok(active?.enabled && active.apiKey, "当前启用模型必须有 API Key");

const root = await mkdtemp(join(tmpdir(), "figo-desktop-real-"));
const configRoot = join(root, "config");
const workspace = join(root, "workspace");
let electronApp;
try {
  await mkdir(configRoot); await mkdir(workspace);
  await writeFile(join(configRoot, "figo-agent.config.json"), JSON.stringify(source), { mode: 0o600 });
  const env = { ...process.env, FIGO_DESKTOP_SMOKE_CONFIG_ROOT: configRoot, FIGO_DESKTOP_SMOKE_WORKSPACE: workspace };
  delete env.ELECTRON_RUN_AS_NODE;
  const packagedBinary = process.env.FIGO_DESKTOP_BINARY;
  electronApp = await _electron.launch({ executablePath: packagedBinary || require("electron"),
    args: packagedBinary ? ["--desktop-e2e"] : [".", "--desktop-e2e"], env, timeout: 30000 });
  const page = await electronApp.firstWindow();
  await page.getByRole("button", { name: "新建", exact: true }).waitFor();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByLabel("任务名称").fill("桌面远程模型验收");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.locator(".composer textarea").fill("请只回复：桌面远程模型验收通过");
  await page.getByRole("button", { name: "发送" }).click();
  await page.locator(".turn-status.completed, .turn-status.failed").last().waitFor({ timeout: 120000 });

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(join(workspace, ".figo-agent", "figo-agent.db"));
  try {
    const turn = db.prepare("select id, status, output from turns where input = ? order by created_at desc limit 1")
      .get("请只回复：桌面远程模型验收通过");
    assert.equal(turn?.status, "completed");
    assert.ok(turn.output?.trim() && !turn.output.includes("本地占位响应"), "模型必须返回真实非占位内容");
    const captures = db.prepare("select id, response_status, request_headers_json, request_body_json, response_headers_json, response_body_json from llm_http_captures where turn_id = ? order by created_at")
      .all(turn.id);
    assert.ok(captures.length > 0, "远程请求必须留下抓包记录");
    assert.ok(captures.some((capture) => capture.response_status === 200), "至少一次远程请求成功");
    assert.ok(captures.every((capture) => Object.values(capture).every((value) => !String(value).includes(active.apiKey))), "抓包不能包含 API Key");
    process.stdout.write(`桌面真实模型验收通过：${packagedBinary ? "安装包" : "开发态"}，模型 ${active.id}，Turn ${turn.id}，抓包 ${captures.length} 条，响应 ${turn.output.length} 字。\n`);
  } finally { db.close(); }
} finally {
  await electronApp?.close();
  await rm(root, { recursive: true, force: true });
}
