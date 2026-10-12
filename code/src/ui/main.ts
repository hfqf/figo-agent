import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { AgentKernel } from "../kernel/agent-kernel.js";
import { getActiveLlmConfig, loadRuntimeConfig } from "../config/runtime-config.js";
import { startLocalApi } from "./local-api.js";

const configRoot = process.cwd();
const workspaceRoot = resolve(configRoot, "..");
const config = await loadRuntimeConfig(configRoot);
const model = getActiveLlmConfig(config);
const kernel = await AgentKernel.start({ workspaceRoot, configRoot });
let branch = "";
try { branch = execFileSync("git", ["branch", "--show-current"], { cwd: workspaceRoot, encoding: "utf8" }).trim(); }
catch { /* Non-Git workspaces still run. */ }

const port = Number(process.env.FIGO_WEB_PORT ?? 4317);
const api = await startLocalApi({
  kernel, port, branch, model: model.model, secrets: config.llm.map((entry) => entry.apiKey).filter(Boolean),
  requireAccessCode: config.web.requireAccessCode,
  staticRoot: resolve(configRoot, "web/dist")
});
process.stdout.write(`工作台地址：${api.url}\n${config.web.requireAccessCode ? `本次启动访问码：${api.accessCode}\n` : "本机直达模式：无需访问码\n"}`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await api.close();
  await kernel.shutdown();
  process.exit(0);
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
