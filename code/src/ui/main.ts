import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { AgentKernel } from "../kernel/agent-kernel.js";
import { getActiveLlmConfig, loadRuntimeConfig } from "../config/runtime-config.js";
import { startLocalApi } from "./local-api.js";
import { WorkspaceRegistry, resolveWorkspace } from "./workspace-registry.js";

const configRoot = process.cwd();
const registry = await WorkspaceRegistry.open(configRoot);
let workspaceRoot = await resolveWorkspace(resolve(configRoot, ".."));
for (const path of registry.recent()) {
  try { workspaceRoot = await resolveWorkspace(path); break; }
  catch { /* Removed workspaces do not block startup. */ }
}
const config = await loadRuntimeConfig(configRoot);
const model = getActiveLlmConfig(config);
const kernel = await AgentKernel.start({ workspaceRoot, configRoot });
registry.record(workspaceRoot);
function branchForWorkspace(path: string): string {
  try { return execFileSync("git", ["branch", "--show-current"], { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}

const port = Number(process.env.FIGO_WEB_PORT ?? 4317);
const api = await startLocalApi({
  kernel, port, branch: branchForWorkspace(workspaceRoot), model: model.model, secrets: config.llm.map((entry) => entry.apiKey).filter(Boolean),
  requireAccessCode: config.web.requireAccessCode,
  fileBrowser: config.web.fileBrowser, terminal: config.web.terminal,
  staticRoot: resolve(configRoot, "web/dist"), registry, branchForWorkspace, configRoot,
  createKernel: (path) => AgentKernel.start({ workspaceRoot: path, configRoot })
});
process.stdout.write(`工作台地址：${api.url}\n${config.web.requireAccessCode ? `本次启动访问码：${api.accessCode}\n` : "本机直达模式：无需访问码\n"}`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await api.close();
  await api.kernel.shutdown();
  api.kernel.storage.db.close();
  registry.close();
  process.exit(0);
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
