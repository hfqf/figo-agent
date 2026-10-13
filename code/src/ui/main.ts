import { resolve } from "node:path";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { startWorkbench } from "./start-workbench.js";
import { WorkspaceRegistry, resolveWorkspace } from "./workspace-registry.js";

const configRoot = process.cwd();
const registry = await WorkspaceRegistry.open(configRoot);
let workspaceRoot = await resolveWorkspace(resolve(configRoot, ".."));
for (const path of registry.recent()) {
  try { workspaceRoot = await resolveWorkspace(path); break; }
  catch { /* Removed workspaces do not block startup. */ }
}
registry.close();
const config = await loadRuntimeConfig(configRoot);
const workbench = await startWorkbench({
  configRoot, workspaceRoot, staticRoot: resolve(configRoot, "web/dist"),
  port: Number(process.env.FIGO_WEB_PORT ?? 4317), requireAccessCode: config.web.requireAccessCode
});
process.stdout.write(`工作台地址：${workbench.url}\n${config.web.requireAccessCode ? `本次启动访问码：${workbench.accessCode}\n` : "本机直达模式：无需访问码\n"}`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await workbench.close();
  process.exit(0);
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
