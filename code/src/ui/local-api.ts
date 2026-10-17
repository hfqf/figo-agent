import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { AgentKernel } from "../kernel/agent-kernel.js";
import { RunCoordinator } from "./run-coordinator.js";
import type { UiEvent } from "./ui-event-store.js";
import { WorkspaceFileService, type FileReference } from "./workspace-files.js";
import { WorkspaceRunLease } from "./workspace-run-lease.js";
import { WorkspaceQueryService } from "./workspace-query-service.js";
import { TraceInspectorQueryService } from "./trace-inspector-query-service.js";
import type { TraceInspectorSettings } from "../config/trace-inspector-settings.js";
import { routeTraceInspectorRequest } from "./trace-inspector-api.js";
import { TokenUsageStore } from "../token-usage/token-usage-store.js";
import { TerminalService } from "./terminal-service.js";
import { redactForUi } from "./ui-redaction.js";
import { resolveWorkspace, type WorkspaceRegistry } from "./workspace-registry.js";
import { readPromptConfig, savePromptConfig } from "../config/prompt-config.js";
import { readModelSettings, saveActiveModelSelection, saveModelSettings, type ModelSettingsInput } from "../config/model-settings.js";
import { officialUrls, type ModelFamily } from "../config/model-settings.js";
import { listModelIds } from "../config/model-catalog.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { defaultFileBrowserConfig, defaultTerminalConfig, type RuntimeFileBrowserConfig, type RuntimeTerminalConfig } from "../config/runtime-behavior.js";
import { zhCN } from "../i18n/catalog.js";
import type { ModelSelection } from "../contracts/types.js";

const execFileAsync = promisify(execFile);

interface WorkspaceRuntime {
  kernel: AgentKernel;
  coordinator: RunCoordinator;
  files: WorkspaceFileService;
  queries: WorkspaceQueryService;
  inspector: TraceInspectorQueryService;
  terminal: TerminalService;
  branch: string;
}

export interface LocalApiOptions {
  kernel: AgentKernel;
  port?: number;
  accessCode?: string;
  requireAccessCode?: boolean;
  secrets?: string[];
  modelConfigured?: boolean;
  branch?: string;
  staticRoot?: string;
  registry?: WorkspaceRegistry;
  createKernel?: (path: string) => Promise<AgentKernel>;
  branchForWorkspace?: (path: string) => string;
  configRoot?: string;
  fileBrowser?: RuntimeFileBrowserConfig;
  inspectorSettings?: TraceInspectorSettings;
  terminal?: RuntimeTerminalConfig;
  pickWorkspace?: () => Promise<string | null>;
  modelFetch?: typeof fetch;
}

export interface LocalApiHandle {
  url: string;
  accessCode: string;
  coordinator: RunCoordinator;
  kernel: AgentKernel;
  hasActiveWork(): boolean;
  close(): Promise<void>;
}

export async function startLocalApi(options: LocalApiOptions): Promise<LocalApiHandle> {
  // 轮换后仍保留旧值，用于脱敏同一服务生命周期内已经保存的历史事实。
  const secrets = [...new Set([...(options.secrets ?? []), ...options.kernel.modelConfigs().map((entry) => entry.apiKey)].filter(Boolean))];
  let modelConfigured = options.modelConfigured ?? true;
  const makeRuntime = (kernel: AgentKernel, branch: string): WorkspaceRuntime => {
    const coordinator = new RunCoordinator(kernel);
    return {
      kernel, coordinator, files: new WorkspaceFileService(kernel.storage.paths.workspaceRoot, options.fileBrowser ?? defaultFileBrowserConfig),
      queries: new WorkspaceQueryService(kernel.storage, secrets),
      inspector: new TraceInspectorQueryService(kernel.storage, secrets, options.inspectorSettings),
      terminal: new TerminalService(kernel.storage.paths.workspaceRoot, coordinator.events, kernel.session.id, options.terminal ?? defaultTerminalConfig), branch
    };
  };
  let active = makeRuntime(options.kernel, options.branch ?? "");
  let switching = false;
  let defaultModelUpdating = false;
  let modelSettingsUpdating = false;
  let switchFinished: Promise<void> = Promise.resolve();
  let finishSwitch: (() => void) | undefined;
  const accessCode = options.accessCode ?? randomBytes(24).toString("base64url");
  const requireAccessCode = options.requireAccessCode ?? true;
  const sessionToken = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const streams = new Set<ServerResponse>();
  let shuttingDown = false;
  let closing: Promise<void> | undefined;
  const toBrowserEvent = (event: UiEvent): UiEvent => ({
    ...event,
    payload: redactForUi(event.payload, secrets) as Record<string, unknown>
  });
  let origin = "";

  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(origin).host) return sendJson(response, 403, { error: "Host 被拒绝。" });
      if (request.headers.origin && request.headers.origin !== origin) return sendJson(response, 403, { error: "Origin 被拒绝。" });
      if (shuttingDown) {
        response.setHeader("Connection", "close");
        return sendJson(response, 503, { error: zhCN.workbench.serviceClosing });
      }
      const url = new URL(request.url ?? "/", origin);
      if (!url.pathname.startsWith("/api/v1/")) {
        if (request.method !== "GET" || !options.staticRoot) return sendJson(response, 404, { error: "未找到页面。" });
        return serveStatic(response, options.staticRoot, url.pathname);
      }

      if (requireAccessCode && request.method === "POST" && url.pathname === "/api/v1/auth") {
        const body = await readJson(request) as { accessCode?: unknown };
        if (!body || typeof body.accessCode !== "string" || !equalSecret(body.accessCode, accessCode)) {
          return sendJson(response, 401, { error: "访问码无效。" });
        }
        response.setHeader("Set-Cookie", `figo_sid=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`);
        return sendJson(response, 200, { csrf });
      }

      const cookie = request.headers.cookie?.split(";").map((part) => part.trim())
        .find((part) => part.startsWith("figo_sid="))?.slice("figo_sid=".length);
      if (requireAccessCode && (!cookie || !equalSecret(cookie, sessionToken))) {
        return sendJson(response, 401, { error: "请先验证本地访问码。" });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        if (!request.headers.origin || request.headers.origin !== origin || request.headers["x-figo-csrf"] !== csrf) {
          return sendJson(response, 403, { error: "CSRF 校验失败。" });
        }
      }

      if (switching) return sendJson(response, 409, { error: "工作区正在切换。" });
      if (modelSettingsUpdating && request.method !== "GET" && request.method !== "HEAD") {
        return sendJson(response, 409, { error: "模型配置正在更新，请稍后重试。" });
      }
      if (url.pathname === "/api/v1/settings/prompts" && options.configRoot) {
        if (request.method === "GET") return sendJson(response, 200, await readPromptConfig(options.configRoot));
        if (request.method === "PUT") {
          if (hasActiveRun()) return sendJson(response, 409, { error: "已有活动 Run。" });
          const body = await readJson(request, 40000) as { prompts?: unknown; version?: unknown };
          if (!body || typeof body.version !== "string") return sendJson(response, 400, { error: "提示词配置无效。" });
          const saved = await savePromptConfig(options.configRoot, body.prompts, body.version);
          active.coordinator.events.append({ sessionId: active.kernel.session.id, kind: "settings.prompts.updated", payload: { version: saved.version } });
          return sendJson(response, 200, saved);
        }
      }
      if (url.pathname === "/api/v1/settings/models" && options.configRoot) {
        if (request.method === "GET") return sendJson(response, 200, await readModelSettings(options.configRoot));
        if (request.method === "PUT") {
          if (hasActiveRun()) return sendJson(response, 409, { error: "已有活动 Run。" });
          if (defaultModelUpdating) return sendJson(response, 409, { error: "模型切换正在进行。" });
          modelSettingsUpdating = true;
          try {
            const body = await readJson(request, 120000) as ModelSettingsInput;
            if (switching || hasActiveRun()) return sendJson(response, 409, { error: "工作区切换或活动 Run 尚未结束。" });
            const saved = await saveModelSettings(options.configRoot, body, (models, activeModelId) => {
              const activate = active.kernel.prepareModelSettings(models, activeModelId);
              return () => {
                activate();
                for (const entry of models) if (entry.apiKey && !secrets.includes(entry.apiKey)) secrets.push(entry.apiKey);
                modelConfigured = Boolean(models.find((entry) => entry.id === activeModelId)?.apiKey.trim());
              };
            });
            active.coordinator.events.append({ sessionId: active.kernel.session.id, kind: "settings.models.updated", payload: {
              activeModelId: saved.activeModelId, modelIds: saved.models.map((entry) => entry.id), version: saved.version
            } });
            return sendJson(response, 200, saved);
          } finally { modelSettingsUpdating = false; }
        }
      }
      if (url.pathname === "/api/v1/settings/models/discover" && options.configRoot && request.method === "POST") {
        const body = await readJson(request, 10000) as { id?: unknown; baseUrl?: unknown; apiKey?: unknown };
        if (!body || !["minimax", "deepseek", "gpt-official", "gpt-relay"].includes(String(body.id)) ||
          (body.apiKey !== undefined && typeof body.apiKey !== "string") ||
          (body.baseUrl !== undefined && typeof body.baseUrl !== "string")) return sendJson(response, 400, { error: "模型连接配置无效。" });
        const id = body.id as ModelFamily;
        const baseUrl = id === "gpt-relay" ? String(body.baseUrl ?? "").trim() : officialUrls[id];
        const saved = (await loadRuntimeConfig(options.configRoot)).llm.find((entry) => entry.id === id);
        const apiKey = String(body.apiKey ?? "").trim() || (saved?.baseUrl.replace(/\/+$/, "") === baseUrl.replace(/\/+$/, "") ? saved.apiKey : "");
        try { return sendJson(response, 200, { models: await listModelIds({ baseUrl, apiKey }, options.modelFetch) }); }
        catch (error) { return sendJson(response, 502, { error: error instanceof Error ? error.message : "模型列表读取失败。" }); }
      }
      if (url.pathname === "/api/v1/models/available" && request.method === "GET") {
        const providers = await Promise.all(active.kernel.modelConfigs().filter((entry) => entry.enabled && entry.apiKey).map(async (entry) => {
          try { return { id: entry.id, defaultModel: entry.model, models: await listModelIds(entry, options.modelFetch) }; }
          catch (error) { return { id: entry.id, defaultModel: entry.model, models: [entry.model], error: error instanceof Error ? error.message : "模型列表读取失败。" }; }
        }));
        return sendJson(response, 200, { providers });
      }
      if (url.pathname === "/api/v1/models/default" && options.configRoot && request.method === "PUT") {
        if (defaultModelUpdating) return sendJson(response, 409, { error: "模型切换正在进行。" });
        defaultModelUpdating = true;
        try {
          const body = await readJson(request, 10000) as Partial<ModelSelection>;
          if (modelSettingsUpdating || switching) return sendJson(response, 409, { error: "模型配置正在更新，请稍后重试。" });
          if (!body || typeof body.providerId !== "string" || typeof body.modelId !== "string") {
            return sendJson(response, 400, { error: "所选模型配置无效。" });
          }
          const runtime = active;
          const selection = runtime.kernel.validateModelSelection(body as ModelSelection);
          const connection = runtime.kernel.modelConfigs().find((entry) => entry.id === selection.providerId)!;
          const saved = await saveActiveModelSelection(options.configRoot, selection, connection);
          runtime.kernel.setDefaultModelSelection(saved);
          modelConfigured = true;
          runtime.coordinator.events.append({ sessionId: runtime.kernel.session.id, kind: "settings.models.default.changed", payload: {
            providerId: saved.providerId, modelId: saved.modelId, version: saved.version
          } });
          return sendJson(response, 200, saved);
        } finally { defaultModelUpdating = false; }
      }
      if (request.method === "GET" && url.pathname === "/api/v1/workspaces") {
        return sendJson(response, 200, { recent: options.registry?.recent() ?? [] });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/workspaces/pick") {
        if (!options.createKernel) return sendJson(response, 404, { error: "未启用工作区切换。" });
        if (options.pickWorkspace) {
          const path = await options.pickWorkspace();
          return sendJson(response, 200, { path: path === null ? null : await resolveWorkspace(path) });
        }
        if (process.platform !== "darwin") return sendJson(response, 501, { error: "此系统请手动输入绝对路径。" });
        try {
          const { stdout } = await execFileAsync("osascript", ["-e", "POSIX path of (choose folder with prompt \"选择 Figo Agent 工作区\")"], { timeout: 120_000 });
          return sendJson(response, 200, { path: await resolveWorkspace(stdout.trim()) });
        } catch (error) {
          if (String((error as NodeJS.ErrnoException).code) === "1") return sendJson(response, 200, { path: null });
          return sendJson(response, 500, { error: "文件夹选择器未能打开，请手动输入路径。" });
        }
      }
      if (request.method === "POST" && url.pathname === "/api/v1/workspaces/open") {
        if (!options.createKernel) return sendJson(response, 404, { error: "未启用工作区切换。" });
        const body = await readJson(request) as { path?: unknown };
        if (!body || typeof body.path !== "string") return sendJson(response, 400, { error: "工作区路径无效。" });
        const path = await resolveWorkspace(body.path);
        if (path === await realpath(active.kernel.storage.paths.workspaceRoot)) return sendJson(response, 200, { path });
        if (hasActiveRun() || active.terminal.isRunning() || defaultModelUpdating || modelSettingsUpdating) return sendJson(response, 409, { error: "活动 Run、终端命令或模型切换尚未结束，无法切换工作区。" });
        switching = true;
        switchFinished = new Promise<void>((done) => { finishSwitch = done; });
        let release: (() => void) | undefined;
        let nextKernel: AgentKernel | undefined;
        try {
          release = new WorkspaceRunLease(active.kernel.storage).acquire(`ui-workspace-switch:${randomBytes(8).toString("hex")}`);
          nextKernel = await options.createKernel(path);
          const next = makeRuntime(nextKernel, options.branchForWorkspace?.(path) ?? "");
          options.registry?.record(path);
          const previous = active;
          previous.coordinator.events.append({ sessionId: previous.kernel.session.id, kind: "workspace.closed", payload: { nextPath: path } });
          for (const stream of streams) stream.end();
          previous.terminal.close();
          previous.coordinator.close();
          await previous.kernel.shutdown();
          release(); release = undefined;
          previous.kernel.storage.db.close();
          active = next;
          active.coordinator.events.append({ sessionId: active.kernel.session.id, kind: "workspace.opened", payload: { previousPath: previous.kernel.storage.paths.workspaceRoot } });
          return sendJson(response, 200, { path });
        } catch (error) {
          if (nextKernel && nextKernel !== active.kernel) {
            await nextKernel.shutdown();
            nextKernel.storage.db.close();
          }
          throw error;
        } finally {
          release?.();
          switching = false;
          finishSwitch?.();
          finishSwitch = undefined;
        }
      }

      if (url.pathname === "/api/v1/trace-inspector/file") {
        if (request.method !== "GET") return sendJson(response, 405, { error: "检查器只支持只读查询。" });
        const paths = url.searchParams.getAll("path");
        if (paths.length !== 1 || !paths[0] || paths[0].length > 4096) return sendJson(response, 400, { error: "文件路径参数无效。" });
        // 独立观察接口不能泄露编辑器原文；不创建 Turn 或文件预览运行事件。
        const preview = await active.files.preview(paths[0]);
        return sendJson(response, 200, redactForUi(preview, secrets));
      }
      const inspectorResult = routeTraceInspectorRequest(request.method ?? "GET", url, active.inspector);
      if (inspectorResult) return sendJson(response, inspectorResult.status, inspectorResult.body);
      const { kernel, coordinator, files, queries, terminal, branch } = active;
      const db = kernel.storage.db;
      if (request.method === "GET" && url.pathname === "/api/v1/bootstrap") {
        const tasks = queries.tasks(kernel.session.id);
        const currentTask = db.prepare("select t.id from sessions s join tasks t on t.id = s.current_task_id where s.id = ? and t.status in ('active', 'paused')")
          .get(kernel.session.id) as { id: string } | undefined;
        const active = db.prepare("select run_id from ui_runs where session_id = ? and status in ('accepted', 'running') limit 1")
          .get(kernel.session.id) as { run_id: string } | undefined;
        return sendJson(response, 200, {
          workspace: basename(kernel.storage.paths.workspaceRoot), workspacePath: kernel.storage.paths.workspaceRoot, branch,
          model: kernel.defaultModelSelection().modelId,
          modelProviderId: kernel.defaultModelSelection().providerId,
          modelConfigured, sessionId: kernel.session.id,
          tasks, currentTaskId: currentTask?.id ?? null, activeRun: active ? coordinator.getRun(active.run_id) : null,
          eventCursor: coordinator.events.cursor(), csrf,
          fileBrowser: options.fileBrowser ?? defaultFileBrowserConfig,
          terminal: options.terminal ?? defaultTerminalConfig
        });
      }

      if (request.method === "GET" && url.pathname === "/api/v1/sessions") {
        return sendJson(response, 200, { sessions: queries.sessions() });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/debug-events") {
        const taskId = url.searchParams.get("taskId");
        if (taskId && !db.prepare("select 1 from tasks where id = ?").get(taskId)) return sendJson(response, 404, { error: "Task 不存在。" });
        return sendJson(response, 200, { events: coordinator.events.recent(taskId, 200).map(toBrowserEvent) });
      }
      if (url.pathname === "/api/v1/terminal") {
        if (request.method === "GET") return sendJson(response, 200, terminal.snapshot());
        if (request.method === "POST") {
          const body = await readJson(request) as { command?: unknown };
          if (!body || typeof body.command !== "string") return sendJson(response, 400, { error: "终端命令无效。" });
          return sendJson(response, 202, await terminal.execute(body.command));
        }
      }
      if (request.method === "POST" && url.pathname === "/api/v1/terminal/stop") {
        terminal.stop();
        return sendJson(response, 200, terminal.snapshot());
      }
      const sessionTasks = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/tasks$/);
      if (sessionTasks && request.method === "GET") {
        const exists = db.prepare("select id from sessions where id = ?").get(sessionTasks[1]);
        if (!exists) return sendJson(response, 404, { error: "Session 不存在。" });
        return sendJson(response, 200, { tasks: queries.tasks(sessionTasks[1]) });
      }

      if (request.method === "GET" && url.pathname === "/api/v1/files/search") {
        return sendJson(response, 200, await files.search(url.searchParams.get("q") ?? ""));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/files") {
        const path = url.searchParams.get("path") ?? "";
        try { return sendJson(response, 200, await files.list(path)); }
        catch (error) { auditFileDenied(path, error); throw error; }
      }
      if (request.method === "GET" && url.pathname === "/api/v1/file") {
        const path = url.searchParams.get("path") ?? "";
        let preview;
        try { preview = await files.preview(path); }
        catch (error) { auditFileDenied(path, error); throw error; }
        coordinator.events.append({
          sessionId: kernel.session.id, kind: "file.previewed",
          payload: { path, size: preview.size, tooLarge: preview.tooLarge }
        });
        return sendJson(response, 200, preview);
      }
      if (request.method === "PUT" && url.pathname === "/api/v1/file") {
        const body = await readJson(request, 1024 * 1024 + 4096) as { path?: unknown; content?: unknown; version?: unknown };
        if (!body || typeof body.path !== "string" || typeof body.content !== "string" || typeof body.version !== "string") {
          return sendJson(response, 400, { error: "文件保存参数无效。" });
        }
        const release = new WorkspaceRunLease(kernel.storage).acquire(`ui-file-save:${randomBytes(8).toString("hex")}`);
        try {
          let saved;
          try { saved = await files.save(body.path, body.content, body.version); }
          catch (error) { auditFileDenied(body.path, error); throw error; }
          coordinator.events.append({
            sessionId: kernel.session.id, kind: "file.saved",
            payload: { path: saved.path, size: saved.size, version: saved.version }
          });
          return sendJson(response, 200, saved);
        } finally { release(); }
      }

      if (request.method === "POST" && url.pathname === "/api/v1/tasks") {
        const body = await readJson(request) as { title?: unknown };
        if (!body || typeof body.title !== "string" || !body.title.trim() || body.title.length > 120 || body.title.includes("\n")) {
          return sendJson(response, 400, { error: "Task 标题无效。" });
        }
        if (hasActiveRun()) return sendJson(response, 409, { error: "已有活动 Run。" });
        await kernel.handleCommand(`/task new ${body.title.trim()}`);
        const task = queries.tasks(kernel.session.id)[0];
        coordinator.events.append({ sessionId: kernel.session.id, taskId: String(task.id), kind: "task.created", payload: { title: task.title } });
        return sendJson(response, 201, task);
      }
      const taskActions = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/actions$/);
      if (taskActions && request.method === "POST") {
        const body = await readJson(request) as { action?: unknown; reason?: unknown };
        const action = body?.action;
        if (typeof action !== "string" || !["switch", "pause", "resume", "finish", "cancel", "compact"].includes(action)) {
          return sendJson(response, 400, { error: "Task 操作无效。" });
        }
        if (hasActiveRun()) return sendJson(response, 409, { error: "已有活动 Run。" });
        const task = db.prepare("select id, session_id from tasks where id = ?").get(taskActions[1]) as { id: string; session_id: string } | undefined;
        if (!task || task.session_id !== kernel.session.id) return sendJson(response, 409, { error: "历史 Task 只读。" });
        const current = db.prepare("select t.id from sessions s join tasks t on t.id = s.current_task_id where s.id = ? and t.status in ('active', 'paused')")
          .get(kernel.session.id) as { id: string } | undefined;
        if (action !== "switch" && action !== "resume" && current?.id !== task.id) {
          return sendJson(response, 409, { error: "请先切换到所选 Task。" });
        }
        const command = action === "switch" || action === "resume" ? `/task ${action} ${task.id}` :
          action === "compact" ? "/compact" : action === "cancel" ? `/task cancel ${String(body.reason ?? "用户取消")}` : `/task ${action}`;
        const result = await kernel.handleCommand(command);
        coordinator.events.append({ sessionId: kernel.session.id, taskId: task.id, kind: `task.${action}`, payload: { status: result.status } });
        return sendJson(response, result.status === "failed" ? 409 : 200, { result, tasks: queries.tasks(kernel.session.id) });
      }

      if (request.method === "GET" && url.pathname === "/api/v1/events") {
        const after = Number(url.searchParams.get("after") ?? "0");
        if (!Number.isSafeInteger(after) || after < 0) return sendJson(response, 400, { error: "事件游标无效。" });
        if (streams.size >= 4) return sendJson(response, 429, { error: "事件连接数已达上限。" });
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store",
          Connection: "keep-alive", "X-Content-Type-Options": "nosniff"
        });
        streams.add(response);
        let last = after;
        const pump = () => {
          if (response.destroyed) return;
          let batch: UiEvent[];
          do {
            batch = coordinator.events.replay(last);
            for (const event of batch) {
              response.write(`id: ${event.seq}\ndata: ${JSON.stringify(toBrowserEvent(event))}\n\n`);
              last = event.seq;
            }
          } while (batch.length === 500);
        };
        response.write(": connected\n\n");
        pump();
        const poll = setInterval(pump, 250);
        const heartbeat = setInterval(() => { if (!response.destroyed) response.write(": heartbeat\n\n"); }, 15000);
        response.on("close", () => { clearInterval(poll); clearInterval(heartbeat); streams.delete(response); });
        return;
      }

      const taskTurns = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/turns$/);
      const taskActivity = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/activity$/);
      if (taskActivity && request.method === "GET") {
        if (!db.prepare("select 1 from tasks where id = ?").get(taskActivity[1])) {
          return sendJson(response, 404, { error: "Task 不存在。" });
        }
        return sendJson(response, 200, { events: coordinator.events.taskHistory(taskActivity[1]).map(toBrowserEvent) });
      }
      const taskTools = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/tool-calls$/);
      if (taskTools && request.method === "GET") {
        const task = db.prepare("select id from tasks where id = ?").get(taskTools[1]) || queries.legacySessionId(taskTools[1]);
        if (!task) return sendJson(response, 404, { error: "Task 不存在。" });
        return sendJson(response, 200, { tools: queries.taskTools(taskTools[1]) });
      }
      const taskUsage = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/usage$/);
      if (taskUsage && request.method === "GET") {
        const task = db.prepare("select id from tasks where id = ?").get(taskUsage[1]);
        if (!task) return sendJson(response, 404, { error: "Task 不存在。" });
        return sendJson(response, 200, new TokenUsageStore(kernel.storage).summarizeTask(taskUsage[1]));
      }
      if (taskTurns && request.method === "POST") {
        if (queries.legacySessionId(taskTurns[1])) return sendJson(response, 409, { error: "历史对话只读。" });
        if (!modelConfigured) return sendJson(response, 409, { error: zhCN.workbench.modelKeyMissing });
        const body = await readJson(request) as { input?: unknown; clientRequestId?: unknown; fileReferences?: unknown; modelSelection?: unknown };
        if (!body || typeof body.input !== "string" || !body.input.trim() || body.input.length > 48000 ||
            typeof body.clientRequestId !== "string" || !/^[\w-]{4,100}$/.test(body.clientRequestId)) {
          return sendJson(response, 400, { error: "Turn 参数无效。" });
        }
        if (body.fileReferences !== undefined && (!Array.isArray(body.fileReferences) || body.fileReferences.length > 5)) {
          return sendJson(response, 400, { error: "文件引用数量无效。" });
        }
        if (body.modelSelection !== undefined && (!body.modelSelection || typeof body.modelSelection !== "object" || Array.isArray(body.modelSelection) ||
          typeof (body.modelSelection as Record<string, unknown>).providerId !== "string" ||
          typeof (body.modelSelection as Record<string, unknown>).modelId !== "string")) {
          return sendJson(response, 400, { error: "所选模型配置无效。" });
        }
        const fileReferences = [];
        for (const value of (body.fileReferences ?? []) as unknown[]) {
          if (!value || typeof value !== "object" || Array.isArray(value)) return sendJson(response, 400, { error: "文件引用无效。" });
          const ref = value as Record<string, unknown>;
          if (typeof ref.path !== "string" || typeof ref.version !== "string" ||
              typeof ref.startLine !== "number" || typeof ref.endLine !== "number") {
            return sendJson(response, 400, { error: "文件引用无效。" });
          }
          fileReferences.push(await files.validateReference(ref as unknown as FileReference));
        }
        // Body and file-reference reads can finish after shutdown has started.
        if (shuttingDown) {
          response.setHeader("Connection", "close");
          return sendJson(response, 503, { error: zhCN.workbench.serviceClosing });
        }
        if (modelSettingsUpdating || switching) return sendJson(response, 409, { error: "模型配置或工作区正在更新，请稍后重试。" });
        if (!modelConfigured) return sendJson(response, 409, { error: zhCN.workbench.modelKeyMissing });
        const run = coordinator.submit({ taskId: taskTurns[1], input: body.input, clientRequestId: body.clientRequestId, fileReferences,
          modelSelection: body.modelSelection as { providerId: string; modelId: string } | undefined });
        return sendJson(response, 202, run);
      }
      if (taskTurns && request.method === "GET") {
        const task = db.prepare("select session_id from tasks where id = ?").get(taskTurns[1]) as { session_id: string } | undefined;
        if (!task && !queries.legacySessionId(taskTurns[1])) return sendJson(response, 404, { error: "Task 不存在。" });
        const turns = queries.turns(taskTurns[1]);
        return sendJson(response, 200, { turns });
      }

      const inspector = url.pathname.match(/^\/api\/v1\/turns\/([^/]+)\/(context|captures|trace|tools)$/);
      if (inspector && request.method === "GET") {
        const turn = db.prepare("select id from turns where id = ?").get(inspector[1]);
        if (!turn) return sendJson(response, 404, { error: "Turn 不存在。" });
        const data = inspector[2] === "context" ? queries.context(inspector[1]) :
          inspector[2] === "captures" ? { captures: queries.captures(inspector[1]) } :
            inspector[2] === "tools" ? { tools: queries.tools(inspector[1]) } : { events: queries.trace(inspector[1]) };
        return sendJson(response, 200, data);
      }

      const runMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
      if (runMatch && request.method === "GET") return sendJson(response, 200, coordinator.getRun(runMatch[1]));
      const stopRunMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/stop$/);
      if (stopRunMatch && request.method === "POST") return sendJson(response, 202, coordinator.stop(stopRunMatch[1]));
      return sendJson(response, 404, { error: "接口不存在。" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求失败。";
      const status = /路径被拒绝/.test(message) ? 403 : /二进制/.test(message) ? 415 :
        /文件已变化|配置已变化|活动 Run|Run 不在当前进程执行|终端命令尚未结束|工作区已有执行中的 Agent|已有终端命令/.test(message) ? 409 :
          /不存在/.test(message) ? 404 : /无效|过大|过长|校验|Task 不属于|请先切换|绝对目录|不是目录|必须填写 API Key/.test(message) ? 400 : 500;
      sendJson(response, status, { error: status === 500 ? "服务处理失败。" : message });
    }
  });
  function hasActiveRun(): boolean {
    return Boolean(active.kernel.storage.db.prepare("select 1 from ui_runs where status in ('accepted', 'running') limit 1").get());
  }
  function auditFileDenied(path: string, error: unknown): void {
    active.coordinator.events.append({
      sessionId: active.kernel.session.id, kind: "file.denied",
      payload: {
        pathHash: createHash("sha256").update(path).digest("hex").slice(0, 16),
        reason: error instanceof Error ? error.message : "访问失败"
      }
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("本地服务地址无效。");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin, accessCode,
    get coordinator() { return active.coordinator; },
    get kernel() { return active.kernel; },
    hasActiveWork: () => hasActiveRun() || active.terminal.isRunning(),
    close: () => {
      if (closing) return closing;
      shuttingDown = true;
      closing = (async () => {
        await switchFinished;
        for (const stream of streams) stream.end();
        active.terminal.close();
        await active.coordinator.waitForIdle();
        active.coordinator.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
      return closing;
    }
  };
}

async function readJson(request: IncomingMessage, maxBytes = 65536): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Buffer);
    length += bytes.length;
    if (length > maxBytes) throw new Error("请求体过大。");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("JSON 无效。"); }
}

function equalSecret(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

async function serveStatic(response: ServerResponse, root: string, path: string): Promise<void> {
  const rootReal = await realpath(root);
  const requested = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
  if (requested.includes("\0") || requested.includes("\\")) return sendJson(response, 404, { error: "未找到页面。" });
  const target = resolve(rootReal, requested);
  const rel = relative(rootReal, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("/")) return sendJson(response, 404, { error: "未找到页面。" });
  let body: Buffer;
  try {
    const targetReal = await realpath(target);
    const actual = relative(rootReal, targetReal);
    if (actual === ".." || actual.startsWith(`..${sep}`) || actual.startsWith("/")) {
      return sendJson(response, 404, { error: "未找到页面。" });
    }
    body = await readFile(targetReal);
  }
  catch { return sendJson(response, 404, { error: "未找到页面。" }); }
  const nonce = randomBytes(18).toString("base64");
  if (extname(target) === ".html") {
    body = Buffer.from(body.toString("utf8").replace("</head>", `<meta name="figo-csp-nonce" content="${nonce}"></head>`));
  }
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
    ".ico": "image/x-icon", ".woff2": "font/woff2"
  };
  response.writeHead(200, {
    "Content-Type": mime[extname(target)] ?? "application/octet-stream", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'`
  });
  response.end(body);
}
