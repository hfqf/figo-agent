import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import type { AgentKernel } from "../kernel/agent-kernel.js";
import { RunCoordinator } from "./run-coordinator.js";
import type { UiEvent } from "./ui-event-store.js";
import { WorkspaceFileService, type FileReference } from "./workspace-files.js";
import { WorkspaceQueryService } from "./workspace-query-service.js";
import { TokenUsageStore } from "../token-usage/token-usage-store.js";

export interface LocalApiOptions {
  kernel: AgentKernel;
  port?: number;
  accessCode?: string;
  requireAccessCode?: boolean;
  secrets?: string[];
  model?: string;
  branch?: string;
  staticRoot?: string;
}

export interface LocalApiHandle {
  url: string;
  accessCode: string;
  coordinator: RunCoordinator;
  close(): Promise<void>;
}

export async function startLocalApi(options: LocalApiOptions): Promise<LocalApiHandle> {
  const coordinator = new RunCoordinator(options.kernel);
  const files = new WorkspaceFileService(options.kernel.storage.paths.workspaceRoot);
  const queries = new WorkspaceQueryService(options.kernel.storage, options.secrets);
  const accessCode = options.accessCode ?? randomBytes(24).toString("base64url");
  const requireAccessCode = options.requireAccessCode ?? true;
  const sessionToken = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const streams = new Set<ServerResponse>();
  let origin = "";

  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(origin).host) return sendJson(response, 403, { error: "Host 被拒绝。" });
      if (request.headers.origin && request.headers.origin !== origin) return sendJson(response, 403, { error: "Origin 被拒绝。" });
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

      const db = options.kernel.storage.db;
      if (request.method === "GET" && url.pathname === "/api/v1/bootstrap") {
        const tasks = queries.tasks(options.kernel.session.id);
        const currentTask = db.prepare("select t.id from sessions s join tasks t on t.id = s.current_task_id where s.id = ? and t.status in ('active', 'paused')")
          .get(options.kernel.session.id) as { id: string } | undefined;
        const active = db.prepare("select run_id from ui_runs where session_id = ? and status in ('accepted', 'running') limit 1")
          .get(options.kernel.session.id) as { run_id: string } | undefined;
        return sendJson(response, 200, {
          workspace: basename(options.kernel.storage.paths.workspaceRoot), branch: options.branch ?? "",
          model: options.model ?? "", sessionId: options.kernel.session.id,
          tasks, currentTaskId: currentTask?.id ?? null, activeRun: active ? coordinator.getRun(active.run_id) : null,
          eventCursor: coordinator.events.cursor(), csrf
        });
      }

      if (request.method === "GET" && url.pathname === "/api/v1/sessions") {
        return sendJson(response, 200, { sessions: queries.sessions() });
      }
      const sessionTasks = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/tasks$/);
      if (sessionTasks && request.method === "GET") {
        const exists = db.prepare("select id from sessions where id = ?").get(sessionTasks[1]);
        if (!exists) return sendJson(response, 404, { error: "Session 不存在。" });
        return sendJson(response, 200, { tasks: queries.tasks(sessionTasks[1]) });
      }

      if (request.method === "GET" && url.pathname === "/api/v1/files/search") {
        return sendJson(response, 200, { entries: await files.search(url.searchParams.get("q") ?? "") });
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
          sessionId: options.kernel.session.id, kind: "file.previewed",
          payload: { path, size: preview.size, tooLarge: preview.tooLarge }
        });
        return sendJson(response, 200, preview);
      }

      if (request.method === "POST" && url.pathname === "/api/v1/tasks") {
        const body = await readJson(request) as { title?: unknown };
        if (!body || typeof body.title !== "string" || !body.title.trim() || body.title.length > 120 || body.title.includes("\n")) {
          return sendJson(response, 400, { error: "Task 标题无效。" });
        }
        if (hasActiveRun()) return sendJson(response, 409, { error: "已有活动 Run。" });
        await options.kernel.handleCommand(`/task new ${body.title.trim()}`);
        const task = queries.tasks(options.kernel.session.id)[0];
        coordinator.events.append({ sessionId: options.kernel.session.id, taskId: String(task.id), kind: "task.created", payload: { title: task.title } });
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
        if (!task || task.session_id !== options.kernel.session.id) return sendJson(response, 409, { error: "历史 Task 只读。" });
        const current = db.prepare("select t.id from sessions s join tasks t on t.id = s.current_task_id where s.id = ? and t.status in ('active', 'paused')")
          .get(options.kernel.session.id) as { id: string } | undefined;
        if (action !== "switch" && action !== "resume" && current?.id !== task.id) {
          return sendJson(response, 409, { error: "请先切换到所选 Task。" });
        }
        const command = action === "switch" || action === "resume" ? `/task ${action} ${task.id}` :
          action === "compact" ? "/compact" : action === "cancel" ? `/task cancel ${String(body.reason ?? "用户取消")}` : `/task ${action}`;
        const result = await options.kernel.handleCommand(command);
        coordinator.events.append({ sessionId: options.kernel.session.id, taskId: task.id, kind: `task.${action}`, payload: { status: result.status } });
        return sendJson(response, result.status === "failed" ? 409 : 200, { result, tasks: queries.tasks(options.kernel.session.id) });
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
              response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
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
      const taskTools = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/tool-calls$/);
      if (taskTools && request.method === "GET") {
        const task = db.prepare("select id from tasks where id = ?").get(taskTools[1]);
        if (!task) return sendJson(response, 404, { error: "Task 不存在。" });
        return sendJson(response, 200, { tools: queries.taskTools(taskTools[1]) });
      }
      const taskUsage = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/usage$/);
      if (taskUsage && request.method === "GET") {
        const task = db.prepare("select id from tasks where id = ?").get(taskUsage[1]);
        if (!task) return sendJson(response, 404, { error: "Task 不存在。" });
        return sendJson(response, 200, new TokenUsageStore(options.kernel.storage).summarizeTask(taskUsage[1]));
      }
      if (taskTurns && request.method === "POST") {
        const body = await readJson(request) as { input?: unknown; clientRequestId?: unknown; fileReferences?: unknown };
        if (!body || typeof body.input !== "string" || !body.input.trim() || body.input.length > 48000 ||
            typeof body.clientRequestId !== "string" || !/^[\w-]{4,100}$/.test(body.clientRequestId)) {
          return sendJson(response, 400, { error: "Turn 参数无效。" });
        }
        if (body.fileReferences !== undefined && (!Array.isArray(body.fileReferences) || body.fileReferences.length > 5)) {
          return sendJson(response, 400, { error: "文件引用数量无效。" });
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
        const run = coordinator.submit({ taskId: taskTurns[1], input: body.input, clientRequestId: body.clientRequestId, fileReferences });
        return sendJson(response, 202, run);
      }
      if (taskTurns && request.method === "GET") {
        const task = db.prepare("select session_id from tasks where id = ?").get(taskTurns[1]) as { session_id: string } | undefined;
        if (!task) return sendJson(response, 404, { error: "Task 不存在。" });
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
      return sendJson(response, 404, { error: "接口不存在。" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求失败。";
      const status = /路径被拒绝/.test(message) ? 403 : /二进制/.test(message) ? 415 :
        /文件已变化|活动 Run|工作区已有执行中的 Agent/.test(message) ? 409 :
          /不存在/.test(message) ? 404 : /无效|过大|过长|校验|Task 不属于|请先切换/.test(message) ? 400 : 500;
      sendJson(response, status, { error: status === 500 ? "服务处理失败。" : message });
    }
  });
  function hasActiveRun(): boolean {
    return Boolean(options.kernel.storage.db.prepare("select 1 from ui_runs where status in ('accepted', 'running') limit 1").get());
  }
  function auditFileDenied(path: string, error: unknown): void {
    coordinator.events.append({
      sessionId: options.kernel.session.id, kind: "file.denied",
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
    url: origin, accessCode, coordinator,
    close: async () => {
      for (const stream of streams) stream.end();
      await coordinator.waitForIdle();
      coordinator.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Buffer);
    length += bytes.length;
    if (length > 65536) throw new Error("请求体过大。");
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
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
    ".ico": "image/x-icon", ".woff2": "font/woff2"
  };
  response.writeHead(200, {
    "Content-Type": mime[extname(target)] ?? "application/octet-stream", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"
  });
  response.end(body);
}
