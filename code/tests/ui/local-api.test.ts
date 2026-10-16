import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKernel } from "../../src/kernel/agent-kernel.js";
import { startLocalApi } from "../../src/ui/local-api.js";
import { WorkspaceRegistry } from "../../src/ui/workspace-registry.js";

let workspace = "";
afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = "";
});

describe("local API security", () => {
  it("rejects a turn whose request body finishes after shutdown begins", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-close-body-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const api = await startLocalApi({ kernel, port: 0, requireAccessCode: false });
    const boot = await (await fetch(`${api.url}/api/v1/bootstrap`)).json() as { csrf: string; currentTaskId: string };
    const body = JSON.stringify({ input: "关闭期间不应创建任务执行", clientRequestId: "shutdown-partial-body" });
    let entered!: () => void;
    let release!: () => void;
    const draining = new Promise<void>((resolve) => { entered = resolve; });
    const finishDrain = new Promise<void>((resolve) => { release = resolve; });
    const wait = vi.spyOn(api.coordinator, "waitForIdle").mockImplementationOnce(async () => { entered(); await finishDrain; });
    let continued!: () => void;
    const headersAccepted = new Promise<void>((resolve) => { continued = resolve; });
    const request = httpRequest(`${api.url}/api/v1/tasks/${boot.currentTaskId}/turns`, {
      method: "POST", headers: { origin: api.url, "x-figo-csrf": boot.csrf, "content-type": "application/json",
        "content-length": Buffer.byteLength(body), expect: "100-continue" }
    });
    const response = new Promise<number>((resolve, reject) => {
      request.on("response", (incoming) => { incoming.resume(); resolve(incoming.statusCode!); });
      request.on("error", reject);
    });
    request.once("continue", continued);
    request.flushHeaders();
    await headersAccepted;
    const closing = api.close();
    try {
      await draining;
      expect(api.close()).toBe(closing);
      request.end(body);
      expect(await response).toBe(503);
      expect(kernel.storage.db.prepare("select count(*) n from ui_runs").get()).toMatchObject({ n: 0 });
    } finally {
      request.destroy();
      release();
      await closing;
      wait.mockRestore();
      await kernel.shutdown();
      kernel.storage.db.close();
    }
  });
  it("rejects an SSE reconnect while shutdown drains the coordinator", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-close-sse-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const api = await startLocalApi({ kernel, port: 0, requireAccessCode: false });
    let entered!: () => void;
    let release!: () => void;
    const draining = new Promise<void>((resolve) => { entered = resolve; });
    const finishDrain = new Promise<void>((resolve) => { release = resolve; });
    const wait = vi.spyOn(api.coordinator, "waitForIdle").mockImplementationOnce(async () => {
      entered();
      await finishDrain;
    });
    const abort = new AbortController();
    const closing = api.close();
    try {
      await draining;
      const response = await fetch(`${api.url}/api/v1/events?after=0`, { signal: abort.signal });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "工作台服务正在关闭。" });
    } finally {
      abort.abort();
      release();
      await closing;
      wait.mockRestore();
      await kernel.shutdown();
      kernel.storage.db.close();
    }
  });
  it("requires CSRF to stop a running agent and reports interruption", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-stop-api-"));
    await writeFile(join(workspace, "figo-agent.config.json"), JSON.stringify({ activeModelId: "minimax", llm: [{
      id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "test-key",
      baseUrl: "https://model.example/v1", model: "test-model"
    }] }));
    const originalFetch = globalThis.fetch;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    globalThis.fetch = (url, init) => String(url).startsWith("https://model.example/")
      ? new Promise<Response>((_resolve, reject) => {
        requestStarted();
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })
      : originalFetch(url, init);
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const api = await startLocalApi({ kernel, port: 0, requireAccessCode: false });
    try {
      const boot = await (await fetch(`${api.url}/api/v1/bootstrap`)).json() as { csrf: string; currentTaskId: string };
      const sent = await fetch(`${api.url}/api/v1/tasks/${boot.currentTaskId}/turns`, {
        method: "POST", headers: { origin: api.url, "x-figo-csrf": boot.csrf, "content-type": "application/json" },
        body: JSON.stringify({ input: "分析项目", clientRequestId: "stop-api-request" })
      });
      const run = await sent.json() as { runId: string };
      await started;
      const stopUrl = `${api.url}/api/v1/runs/${run.runId}/stop`;
      expect((await fetch(stopUrl, { method: "POST", headers: { origin: api.url } })).status).toBe(403);
      expect((await fetch(stopUrl, { method: "POST", headers: { origin: api.url, "x-figo-csrf": boot.csrf } })).status).toBe(202);
      await api.coordinator.waitForIdle();
      expect((await (await fetch(`${api.url}/api/v1/runs/${run.runId}`)).json() as { status: string }).status).toBe("interrupted");
    } finally { await api.close(); await kernel.shutdown(); kernel.storage.db.close(); globalThis.fetch = originalFetch; }
  });
  it("persists a workbench model switch and immediately exposes it as the default", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-model-default-"));
    const path = join(workspace, "figo-agent.config.json");
    await writeFile(path, JSON.stringify({ activeModelId: "minimax", llm: [
      { id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "mini-secret", baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3" },
      { id: "deepseek", enabled: true, provider: "openai-compatible", apiKey: "deep-secret", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" }
    ] }));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const api = await startLocalApi({ kernel, port: 0, requireAccessCode: false, configRoot: workspace });
    try {
      const before = await (await fetch(`${api.url}/api/v1/bootstrap`)).json() as { csrf: string; model: string; modelProviderId: string };
      expect(before).toMatchObject({ model: "MiniMax-M3", modelProviderId: "minimax" });
      const change = (csrf = before.csrf) => fetch(`${api.url}/api/v1/models/default`, {
        method: "PUT", headers: { origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" },
        body: JSON.stringify({ providerId: "deepseek", modelId: "deepseek-reasoner" })
      });
      expect((await change("wrong")).status).toBe(403);
      const changed = await change();
      expect(changed.status).toBe(200);
      const payload = await changed.json();
      expect(payload).toMatchObject({ providerId: "deepseek", modelId: "deepseek-reasoner" });
      expect((await (await fetch(`${api.url}/api/v1/bootstrap`)).json() as { model: string; modelProviderId: string }))
        .toMatchObject({ model: "deepseek-reasoner", modelProviderId: "deepseek" });
      expect(kernel.defaultModelSelection()).toEqual({ providerId: "deepseek", modelId: "deepseek-reasoner" });
      expect((await (await fetch(`${api.url}/api/v1/settings/models`)).json() as { activeModelId: string; models: Array<{ id: string; model: string }> }))
        .toMatchObject({ activeModelId: "deepseek", models: [{ id: "minimax", model: "MiniMax-M3" }, { id: "deepseek", model: "deepseek-reasoner" }] });
      expect((JSON.parse(await readFile(path, "utf8")) as { activeModelId: string }).activeModelId).toBe("deepseek");
      expect(JSON.stringify(payload)).not.toContain("secret");
    } finally { await api.close(); await kernel.shutdown(); kernel.storage.db.close(); }
  });
  it("discovers saved and newly entered model ids without exposing keys", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-catalog-"));
    await writeFile(join(workspace, "figo-agent.config.json"), JSON.stringify({ activeModelId: "minimax", llm: [
      { id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "saved-secret", baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3" }
    ] }));
    const calls: Array<{ url: string; key: string }> = [];
    const modelFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, key: new Headers(init?.headers).get("authorization") ?? "" });
      return new Response(JSON.stringify({ data: [{ id: "model-two" }, { id: "model-one" }] }), { status: 200 });
    }) as typeof fetch;
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const api = await startLocalApi({ kernel, port: 0, requireAccessCode: false, configRoot: workspace, modelFetch });
    try {
      const { csrf } = await (await fetch(`${api.url}/api/v1/bootstrap`)).json() as { csrf: string };
      const available = await (await fetch(`${api.url}/api/v1/models/available`)).json() as { providers: Array<{ id: string; models: string[] }> };
      expect(available.providers[0]).toMatchObject({ id: "minimax", models: ["model-one", "model-two"] });
      const discovered = await fetch(`${api.url}/api/v1/settings/models/discover`, { method: "POST", headers: {
        origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json"
      }, body: JSON.stringify({ id: "gpt-official", apiKey: "new-secret" }) });
      expect(discovered.status).toBe(200);
      expect(await discovered.json()).toEqual({ models: ["model-one", "model-two"] });
      expect(calls).toEqual([
        { url: "https://api.minimaxi.com/v1/models", key: "Bearer saved-secret" },
        { url: "https://api.openai.com/v1/models", key: "Bearer new-secret" }
      ]);
      expect(JSON.stringify(available)).not.toContain("saved-secret");
      expect((await fetch(`${api.url}/api/v1/settings/models/discover`, { method: "POST", headers: { origin: api.url, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    } finally { await api.close(); await kernel.shutdown(); kernel.storage.db.close(); }
  });
  it("requires CSRF for model edits and never returns model keys", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-models-"));
    await writeFile(join(workspace, "figo-agent.config.json"), JSON.stringify({
      activeModelId: "minimax", llm: [{ id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "test-secret", baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3" }]
    }));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace, configRoot: join(workspace, "absent") });
    const api = await startLocalApi({ kernel, port: 0, requireAccessCode: false, configRoot: workspace });
    try {
      const { csrf } = await (await fetch(`${api.url}/api/v1/bootstrap`)).json() as { csrf: string };
      const before = await (await fetch(`${api.url}/api/v1/settings/models`)).json() as { version: string; activeModelId: string; models: Array<{ id: string; enabled: boolean; family: string; baseUrl: string; model: string; hasApiKey: boolean }> };
      expect(JSON.stringify(before)).not.toContain("test-secret");
      const body = JSON.stringify({ ...before, models: before.models.map(({ hasApiKey: _hasApiKey, ...model }) => model) });
      expect((await fetch(`${api.url}/api/v1/settings/models`, { method: "PUT", headers: { origin: api.url, "content-type": "application/json" }, body })).status).toBe(403);
      const saved = await fetch(`${api.url}/api/v1/settings/models`, { method: "PUT", headers: { origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" }, body });
      expect(saved.status).toBe(200);
      expect(await saved.text()).not.toContain("test-secret");
      expect((await fetch(`${api.url}/api/v1/settings/models`, { method: "PUT", headers: { origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" }, body })).status).toBe(409);
    } finally { await api.close(); await kernel.shutdown(); kernel.storage.db.close(); }
  });
  it("edits only prompts behind same-origin and CSRF checks", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-prompts-"));
    await writeFile(join(workspace, "figo-agent.config.json"), JSON.stringify({ llm: [{ apiKey: "test-secret" }] }));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace, configRoot: join(workspace, "absent") });
    const api = await startLocalApi({ kernel, port: 0, requireAccessCode: false, configRoot: workspace });
    try {
      const { csrf } = await (await fetch(`${api.url}/api/v1/bootstrap`)).json() as { csrf: string };
      const before = await (await fetch(`${api.url}/api/v1/settings/prompts`)).json() as { prompts: { systemInstruction: string }; version: string };
      expect(JSON.stringify(before)).not.toContain("test-secret");
      const body = JSON.stringify({ prompts: { systemInstruction: "核对证据", userInstruction: "中文文档" }, version: before.version });
      const rejected = await fetch(`${api.url}/api/v1/settings/prompts`, { method: "PUT", headers: { origin: api.url, "content-type": "application/json" }, body });
      expect(rejected.status).toBe(403);
      const saved = await fetch(`${api.url}/api/v1/settings/prompts`, { method: "PUT", headers: { origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" }, body });
      expect(saved.status).toBe(200);
      expect((await saved.json() as { prompts: { userInstruction: string } }).prompts.userInstruction).toBe("中文文档");
      const stale = await fetch(`${api.url}/api/v1/settings/prompts`, { method: "PUT", headers: { origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" }, body });
      expect(stale.status).toBe(409);
    } finally {
      await api.close(); await kernel.shutdown(); kernel.storage.db.close();
    }
  });
  it("switches the whole workspace, persists recents and rejects unsafe switches", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-workspaces-"));
    const first = join(workspace, "first");
    const second = join(workspace, "second");
    await mkdir(first); await mkdir(second);
    await writeFile(join(first, "first.txt"), "one");
    await writeFile(join(second, "second.txt"), "two");
    const registry = await WorkspaceRegistry.open(workspace);
    const kernel = await AgentKernel.start({ workspaceRoot: first });
    const api = await startLocalApi({
      kernel, port: 0, requireAccessCode: false, registry,
      createKernel: (path) => AgentKernel.start({ workspaceRoot: path })
    });
    try {
      const before = await (await fetch(`${api.url}/api/v1/bootstrap`)).json() as { sessionId: string; csrf: string; workspacePath: string };
      expect(before.workspacePath).toBe(first);
      const open = (path: string, csrf = before.csrf) => fetch(`${api.url}/api/v1/workspaces/open`, {
        method: "POST", headers: { origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" },
        body: JSON.stringify({ path })
      });
      expect((await open(second, "bad")).status).toBe(403);
      expect((await open("relative")).status).toBe(400);
      expect((await open(join(workspace, "missing"))).status).toBe(404);
      expect((await open(join(first, "first.txt"))).status).toBe(400);
      const terminal = await fetch(`${api.url}/api/v1/terminal`, {
        method: "POST", headers: { origin: api.url, "x-figo-csrf": before.csrf, "content-type": "application/json" },
        body: JSON.stringify({ command: "sleep 5" })
      });
      expect(terminal.status).toBe(202);
      expect((await open(second)).status).toBe(409);
      await fetch(`${api.url}/api/v1/terminal/stop`, { method: "POST", headers: { origin: api.url, "x-figo-csrf": before.csrf } });
      while ((await (await fetch(`${api.url}/api/v1/terminal`)).json() as { entries: Array<{ status: string }> }).entries.at(-1)?.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const task = kernel.storage.db.prepare("select current_task_id as id from sessions where id = ?").get(kernel.session.id) as { id: string };
      const pending = kernel.createTurnWithinTransaction(task.id, "仍在执行");
      kernel.storage.db.prepare("insert into ui_runs (run_id, turn_id, session_id, task_id, client_request_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("run_switch_busy", pending.id, kernel.session.id, task.id, "switch-busy", "running", "2026-10-12 15:00:00.000", "2026-10-12 15:00:00.000");
      expect((await open(second)).status).toBe(409);
      kernel.storage.db.prepare("delete from ui_runs where run_id = ?").run("run_switch_busy");
      expect((await open(second)).status).toBe(200);
      const after = await (await fetch(`${api.url}/api/v1/bootstrap`)).json() as { sessionId: string; workspacePath: string };
      expect(after.workspacePath).toBe(await realpath(second));
      expect(after.sessionId).not.toBe(before.sessionId);
      const files = await (await fetch(`${api.url}/api/v1/files?path=`)).json() as { entries: Array<{ name: string }> };
      expect(files.entries.map((entry) => entry.name)).toContain("second.txt");
      expect(files.entries.map((entry) => entry.name)).not.toContain("first.txt");
      expect((await (await fetch(`${api.url}/api/v1/workspaces`)).json() as { recent: string[] }).recent[0]).toBe(await realpath(second));
      expect(kernel.storage.db.isOpen).toBe(false);
    } finally {
      await api.close();
      await api.kernel.shutdown();
      api.kernel.storage.db.close();
      registry.close();
    }
  });

  it("exposes legacy taskless turns through a read-only session task", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-legacy-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const legacyTurnId = "turn_legacy_api_test";
    kernel.storage.db.prepare("insert into turns (id, session_id, input, output, status, created_at, completed_at) values (?, ?, ?, ?, ?, ?, ?)")
      .run(legacyTurnId, kernel.session.id, "旧版提问", "旧版回复", "completed", "2026-10-11 08:00:00.000", "2026-10-11 08:00:01.000");
    const api = await startLocalApi({ kernel, port: 0, requireAccessCode: false });
    try {
      const tasksResponse = await fetch(`${api.url}/api/v1/sessions/${kernel.session.id}/tasks`);
      const { tasks } = await tasksResponse.json() as { tasks: Array<{ id: string; title: string; turnCount: number }> };
      const legacy = tasks.find((task) => task.title === "历史对话（未归属 Task）");
      expect(legacy).toMatchObject({ id: `legacy_${kernel.session.id}`, turnCount: 1 });
      const turnsResponse = await fetch(`${api.url}/api/v1/tasks/${legacy?.id}/turns`);
      expect(turnsResponse.status).toBe(200);
      const { turns } = await turnsResponse.json() as { turns: Array<{ id: string; input: string; output: string }> };
      expect(turns).toEqual([expect.objectContaining({ id: legacyTurnId, input: "旧版提问", output: "旧版回复" })]);
      const toolsResponse = await fetch(`${api.url}/api/v1/tasks/${legacy?.id}/tool-calls`);
      expect(toolsResponse.status).toBe(200);
      expect(kernel.storage.db.prepare("select task_id from turns where id = ?").get(legacyTurnId)).toMatchObject({ task_id: null });
    } finally {
      await api.close();
      await kernel.shutdown();
    }
  });

  it("runs terminal commands with CSRF protection and replays audited debug events", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-terminal-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const api = await startLocalApi({ kernel, port: 0, requireAccessCode: false });
    try {
      const { csrf } = await (await fetch(`${api.url}/api/v1/bootstrap`)).json() as { csrf: string };
      const denied = await fetch(`${api.url}/api/v1/terminal`, {
        method: "POST", headers: { origin: api.url, "content-type": "application/json" }, body: JSON.stringify({ command: "pwd" })
      });
      expect(denied.status).toBe(403);
      const started = await fetch(`${api.url}/api/v1/terminal`, {
        method: "POST", headers: { origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" },
        body: JSON.stringify({ command: "pwd" })
      });
      expect(started.status).toBe(202);
      let snapshot: { entries: Array<{ output: string; status: string; exitCode: number | null }> };
      do {
        await new Promise((resolve) => setTimeout(resolve, 20));
        snapshot = await (await fetch(`${api.url}/api/v1/terminal`)).json() as typeof snapshot;
      } while (snapshot.entries.at(-1)?.status === "running");
      expect(snapshot.entries.at(-1)).toMatchObject({ status: "completed", exitCode: 0 });
      expect(snapshot.entries.at(-1)?.output.trim()).toBe(await realpath(workspace));
      const debug = await (await fetch(`${api.url}/api/v1/debug-events`)).json() as { events: Array<{ kind: string }> };
      expect(debug.events.map((item) => item.kind)).toContain("terminal.completed");
      const rows = kernel.storage.db.prepare("select payload_json from ui_events where kind = 'terminal.started'").all() as Array<{ payload_json: string }>;
      expect(rows[0].payload_json).not.toContain("pwd");
      expect(JSON.parse(rows[0].payload_json)).toHaveProperty("commandHash");
      const run = (command: string) => fetch(`${api.url}/api/v1/terminal`, {
        method: "POST", headers: { origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" },
        body: JSON.stringify({ command })
      });
      expect((await run("cd ..")).status).toBe(202);
      const moved = await (await fetch(`${api.url}/api/v1/terminal`)).json() as { cwd: string };
      expect(moved.cwd).toBe(await realpath(join(workspace, "..")));
      expect((await run("sleep 10")).status).toBe(202);
      const stopped = await fetch(`${api.url}/api/v1/terminal/stop`, {
        method: "POST", headers: { origin: api.url, "x-figo-csrf": csrf }
      });
      expect(stopped.status).toBe(200);
      do {
        await new Promise((resolve) => setTimeout(resolve, 20));
        snapshot = await (await fetch(`${api.url}/api/v1/terminal`)).json() as typeof snapshot;
      } while (snapshot.entries.at(-1)?.status === "running");
      expect(snapshot.entries.at(-1)?.status).toBe("stopped");
    } finally {
      await api.close();
      await kernel.shutdown();
    }
  });

  it("opens the local workbench without a login when configured, while retaining same-origin write checks", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-open-"));
    await writeFile(join(workspace, "note.md"), "保存前\n");
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const api = await startLocalApi({ kernel, port: 0, requireAccessCode: false });
    try {
      const bootstrap = await fetch(`${api.url}/api/v1/bootstrap`);
      expect(bootstrap.status).toBe(200);
      const state = await bootstrap.json() as { tasks: Array<{ id: string }>; csrf: string };
      expect(state.csrf).toBeTruthy();

      const before = await fetch(`${api.url}/api/v1/file?path=note.md`);
      const version = (await before.json() as { version: string }).version;
      const saveUrl = `${api.url}/api/v1/file`;
      const deniedSave = await fetch(saveUrl, {
        method: "PUT", headers: { origin: api.url, "content-type": "application/json" },
        body: JSON.stringify({ path: "note.md", content: "保存后\n", version })
      });
      expect(deniedSave.status).toBe(403);
      const savedResponse = await fetch(saveUrl, {
        method: "PUT", headers: { origin: api.url, "x-figo-csrf": state.csrf, "content-type": "application/json" },
        body: JSON.stringify({ path: "note.md", content: "保存后\n", version })
      });
      expect(savedResponse.status).toBe(200);
      expect((await savedResponse.json() as { version: string }).version).not.toBe(version);
      const stale = await fetch(saveUrl, {
        method: "PUT", headers: { origin: api.url, "x-figo-csrf": state.csrf, "content-type": "application/json" },
        body: JSON.stringify({ path: "note.md", content: "错误覆盖", version })
      });
      expect(stale.status).toBe(409);
      expect((await (await fetch(`${api.url}/api/v1/file?path=note.md`)).json() as { content: string }).content).toBe("保存后\n");
      expect(kernel.storage.db.prepare("select count(*) as count from turns").get()).toEqual({ count: 0 });
      expect(kernel.storage.db.prepare("select kind from ui_events where kind = 'file.saved' order by seq desc limit 1").get()).toMatchObject({ kind: "file.saved" });

      const deniedOrigin = await fetch(`${api.url}/api/v1/bootstrap`, { headers: { origin: "https://evil.example" } });
      expect(deniedOrigin.status).toBe(403);
      const turnUrl = `${api.url}/api/v1/tasks/${state.tasks[0].id}/turns`;
      const withoutCsrf = await fetch(turnUrl, {
        method: "POST", headers: { origin: api.url, "content-type": "application/json" },
        body: JSON.stringify({ input: "你好", clientRequestId: "no-login-1" })
      });
      expect(withoutCsrf.status).toBe(403);
      const accepted = await fetch(turnUrl, {
        method: "POST", headers: { origin: api.url, "x-figo-csrf": state.csrf, "content-type": "application/json" },
        body: JSON.stringify({ input: "你好", clientRequestId: "no-login-1" })
      });
      expect(accepted.status).toBe(202);
      await api.coordinator.waitForIdle();
    } finally {
      await api.close();
    }
  });

  it("requires a local session and CSRF before exposing state or accepting a turn", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-api-"));
    await writeFile(join(workspace, "note.md"), "甲\n乙\n");
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    await writeFile(join(workspace, "figo-agent.config.json"), '{"apiKey":"local-secret"}');
    const api = await startLocalApi({ kernel, port: 0, accessCode: "test-access-code", secrets: ["local-secret"] });
    try {
      const unauthorized = await fetch(`${api.url}/api/v1/bootstrap`);
      expect(unauthorized.status).toBe(401);
      const wrongHost = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(`${api.url}/api/v1/bootstrap`, { headers: { Host: "evil.example" } }, (response) => {
          response.resume(); resolve(response.statusCode ?? 0);
        });
        request.on("error", reject); request.end();
      });
      expect(wrongHost).toBe(403);

      const evil = await fetch(`${api.url}/api/v1/auth`, {
        method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ accessCode: "test-access-code" })
      });
      expect(evil.status).toBe(403);

      const nullAuth = await fetch(`${api.url}/api/v1/auth`, {
        method: "POST", headers: { origin: api.url, "content-type": "application/json" }, body: "null"
      });
      expect(nullAuth.status).toBe(401);

      const auth = await fetch(`${api.url}/api/v1/auth`, {
        method: "POST", headers: { origin: api.url, "content-type": "application/json" },
        body: JSON.stringify({ accessCode: "test-access-code" })
      });
      expect(auth.status).toBe(200);
      expect(auth.headers.get("set-cookie")).toContain("HttpOnly");
      expect(auth.headers.get("set-cookie")).toContain("SameSite=Strict");
      const cookie = auth.headers.get("set-cookie")!.split(";")[0];
      const csrf = (await auth.json() as { csrf: string }).csrf;
      const bootstrap = await fetch(`${api.url}/api/v1/bootstrap`, { headers: { cookie } });
      expect(bootstrap.status).toBe(200);
      const state = await bootstrap.json() as { sessionId: string; tasks: Array<{ id: string }>; csrf: string };
      expect(state.sessionId).toBe(kernel.session.id);
      expect(state.csrf).toBe(csrf);

      const fileList = await fetch(`${api.url}/api/v1/files?path=`, { headers: { cookie } });
      expect(fileList.status).toBe(200);
      expect(JSON.stringify(await fileList.json())).toContain("note.md");
      const searchResults = await fetch(`${api.url}/api/v1/files/search?q=note`, { headers: { cookie } });
      expect(searchResults.status).toBe(200);
      expect(JSON.stringify(await searchResults.json())).toContain("note.md");
      const previewResponse = await fetch(`${api.url}/api/v1/file?path=note.md`, { headers: { cookie } });
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as { version: string };
      expect(kernel.storage.db.prepare("select count(*) as count from turns").get()).toEqual({ count: 0 });
      const secretFile = await fetch(`${api.url}/api/v1/file?path=figo-agent.config.json`, { headers: { cookie } });
      expect(secretFile.status).toBe(403);
      expect(JSON.stringify(await secretFile.json())).not.toContain("local-secret");
      expect(kernel.storage.db.prepare("select kind from ui_events where kind = 'file.denied' order by seq desc limit 1").get()).toMatchObject({ kind: "file.denied" });

      const turnUrl = `${api.url}/api/v1/tasks/${state.tasks[0].id}/turns`;
      const withoutCsrf = await fetch(turnUrl, {
        method: "POST", headers: { cookie, origin: api.url, "content-type": "application/json" },
        body: JSON.stringify({ input: "你好", clientRequestId: "test-1" })
      });
      expect(withoutCsrf.status).toBe(403);
      const accepted = await fetch(turnUrl, {
        method: "POST", headers: { cookie, origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" },
        body: JSON.stringify({ input: "你好", clientRequestId: "test-1" })
      });
      expect(accepted.status).toBe(202);
      const firstRun = await accepted.json() as { status: string; taskId: string; runId: string; turnId: string };
      expect(firstRun).toMatchObject({ status: "accepted", taskId: state.tasks[0].id });
      await api.coordinator.waitForIdle();
      api.coordinator.events.append({ runId: firstRun.runId, sessionId: kernel.session.id, taskId: firstRun.taskId, turnId: firstRun.turnId,
        kind: "assistant.text.delta", payload: { text: "local-secret", offset: 0, sourceLength: 12 } });
      const activityResponse = await fetch(`${api.url}/api/v1/tasks/${firstRun.taskId}/activity`, { headers: { cookie } });
      expect(activityResponse.status).toBe(200);
      const activityBody = JSON.stringify(await activityResponse.json());
      expect(activityBody).toContain("[REDACTED]");
      expect(activityBody).not.toContain("local-secret");
      const usageResponse = await fetch(`${api.url}/api/v1/tasks/${state.tasks[0].id}/usage`, { headers: { cookie } });
      expect(usageResponse.status).toBe(200);
      expect(await usageResponse.json()).toMatchObject({ requestCount: 1, unavailableCount: 1, totalReportedCount: 0 });

      const referenceRun = await fetch(turnUrl, {
        method: "POST", headers: { cookie, origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" },
        body: JSON.stringify({ input: "引用文件", clientRequestId: "test-ref", fileReferences: [
          { path: "note.md", startLine: 2, endLine: 2, version: preview.version }
        ] })
      });
      expect(referenceRun.status).toBe(202);
      const refRun = await referenceRun.json() as { turnId: string };
      await api.coordinator.waitForIdle();
      const contextResponse = await fetch(`${api.url}/api/v1/turns/${refRun.turnId}/context`, { headers: { cookie } });
      expect(contextResponse.status).toBe(200);
      expect(JSON.stringify(await contextResponse.json())).toContain("note.md#L2-L2");
      const captureResponse = await fetch(`${api.url}/api/v1/turns/${refRun.turnId}/captures`, { headers: { cookie } });
      expect(captureResponse.status).toBe(200);
      const traceResponse = await fetch(`${api.url}/api/v1/turns/${refRun.turnId}/trace`, { headers: { cookie } });
      expect(traceResponse.status).toBe(200);
      const toolsResponse = await fetch(`${api.url}/api/v1/tasks/${state.tasks[0].id}/tool-calls`, { headers: { cookie } });
      expect(toolsResponse.status).toBe(200);
      const newTask = await fetch(`${api.url}/api/v1/tasks`, {
        method: "POST", headers: { cookie, origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" },
        body: JSON.stringify({ title: "第二个 Task" })
      });
      expect(newTask.status).toBe(201);
      const switchBack = await fetch(`${api.url}/api/v1/tasks/${state.tasks[0].id}/actions`, {
        method: "POST", headers: { cookie, origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" },
        body: JSON.stringify({ action: "switch" })
      });
      expect(switchBack.status).toBe(200);
      const afterSwitch = await fetch(`${api.url}/api/v1/bootstrap`, { headers: { cookie } });
      expect((await afterSwitch.json() as { currentTaskId: string }).currentTaskId).toBe(state.tasks[0].id);
    } finally {
      await api.close();
    }
  });

  it("replays more than one event page and keeps streaming later events", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-api-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const api = await startLocalApi({ kernel, port: 0, accessCode: "test-access-code" });
    const abort = new AbortController();
    try {
      const denied = await fetch(`${api.url}/api/v1/events?after=0`);
      expect(denied.status).toBe(401);
      const auth = await fetch(`${api.url}/api/v1/auth`, {
        method: "POST", headers: { origin: api.url, "content-type": "application/json" },
        body: JSON.stringify({ accessCode: "test-access-code" })
      });
      const cookie = auth.headers.get("set-cookie")!.split(";")[0];
      for (let index = 0; index < 510; index++) {
        api.coordinator.events.append({ sessionId: kernel.session.id, kind: "test.event", payload: { index } });
      }
      const response = await fetch(`${api.url}/api/v1/events?after=0`, { headers: { cookie }, signal: abort.signal });
      expect(response.status).toBe(200);
      api.coordinator.events.append({ sessionId: kernel.session.id, kind: "test.live", payload: {} });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let stream = "";
      await Promise.race([
        (async () => {
          while (!stream.includes("\"kind\":\"test.live\"")) {
            const chunk = await reader.read();
            if (chunk.done) break;
            stream += decoder.decode(chunk.value);
          }
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("SSE replay timed out")), 2500))
      ]);
      expect((stream.match(/data: /g) ?? []).length).toBe(511);
    } finally {
      abort.abort();
      await api.close();
    }
  });
});
