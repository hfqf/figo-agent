import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { AgentKernel } from "../kernel/agent-kernel.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { startLocalApi, type LocalApiHandle } from "./local-api.js";
import { WorkspaceRegistry, resolveWorkspace } from "./workspace-registry.js";

export interface WorkbenchOptions {
  configRoot: string;
  workspaceRoot: string;
  staticRoot: string;
  port: number;
  requireAccessCode: boolean;
  requireModelKey?: boolean;
  pickWorkspace?: () => Promise<string | null>;
}

export interface WorkbenchHandle extends Omit<LocalApiHandle, "close"> {
  close(): Promise<void>;
}

function branchForWorkspace(path: string): string {
  try { return execFileSync("git", ["branch", "--show-current"], { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}

export async function startWorkbench(options: WorkbenchOptions): Promise<WorkbenchHandle> {
  const staticIndex = await stat(join(options.staticRoot, "index.html")).catch(() => undefined);
  if (!staticIndex?.isFile()) throw new Error("工作台静态资源不存在，请先构建 Web 前端。");
  const workspaceRoot = await resolveWorkspace(options.workspaceRoot);
  const config = await loadRuntimeConfig(options.configRoot);
  const registry = await WorkspaceRegistry.open(options.configRoot);
  let kernel: AgentKernel | undefined;
  try {
    kernel = await AgentKernel.start({ workspaceRoot, configRoot: options.configRoot });
    registry.record(workspaceRoot);
    const api = await startLocalApi({
      kernel, port: options.port, branch: branchForWorkspace(workspaceRoot),
      secrets: config.llm.map((entry) => entry.apiKey).filter(Boolean),
      requireAccessCode: options.requireAccessCode,
      modelConfigured: !options.requireModelKey || config.llm.some((entry) => entry.enabled && Boolean(entry.apiKey.trim())),
      fileBrowser: config.web.fileBrowser, terminal: config.web.terminal, inspectorSettings: config.web.traceInspector,
      taskList: config.web.taskList,
      onboarding: config.web.onboarding,
      staticRoot: options.staticRoot, registry, branchForWorkspace, configRoot: options.configRoot,
      createKernel: (path) => AgentKernel.start({ workspaceRoot: path, configRoot: options.configRoot }),
      pickWorkspace: options.pickWorkspace
    });
    let closing: Promise<void> | undefined;
    return {
      url: api.url, accessCode: api.accessCode,
      get coordinator() { return api.coordinator; },
      get kernel() { return api.kernel; },
      hasActiveWork: () => api.hasActiveWork(),
      close() {
        closing ??= (async () => {
          try { await api.close(); }
          finally {
            try { await api.kernel.shutdown(); }
            finally { api.kernel.storage.db.close(); registry.close(); }
          }
        })();
        return closing;
      }
    };
  } catch (error) {
    if (kernel) {
      try { await kernel.shutdown(); }
      finally { kernel.storage.db.close(); }
    }
    registry.close();
    throw error;
  }
}
