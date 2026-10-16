import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readModelSettings, type ModelSettingsInput } from "../../src/config/model-settings.js";
import { AgentKernel } from "../../src/kernel/agent-kernel.js";
import { startLocalApi, type LocalApiHandle } from "../../src/ui/local-api.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let root = "";
let kernel: AgentKernel | undefined;
let api: LocalApiHandle | undefined;
const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];

afterEach(async () => {
  await api?.close();
  await kernel?.shutdown();
  kernel?.storage.db.close();
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = ""; kernel = undefined; api = undefined; calls.length = 0;
});

async function start(waitForModel?: Promise<void>, onModelRequest?: () => void) {
  root = await mkdtemp(join(tmpdir(), "figo-model-live-"));
  await writeFile(join(root, "figo-agent.config.json"), JSON.stringify({ activeModelId: "relay", llm: [
    { id: "relay", enabled: true, provider: "openai-compatible", apiKey: "fixture-old-value", baseUrl: "https://old.example/v1", model: "old-model", toolCallingMode: "native" }
  ], context: { compaction: { keepRecentTokens: 1, reserveTokens: 32 } } }));
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("https://")) return originalFetch(url, init);
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") ?? "", body });
    onModelRequest?.();
    await waitForModel;
    return new Response(JSON.stringify({ choices: [{ message: { content: body.stream ? "FINAL\n本地模拟答复" : "## Goal\n继续测试。\n\n## Progress\n### Done\n- 已完成本地验证。" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  kernel = await AgentKernel.start({ workspaceRoot: root });
  api = await startLocalApi({ kernel, configRoot: root, port: 0, requireAccessCode: false,
    modelFetch: (async () => new Response(JSON.stringify({ data: [{ id: "catalog-model" }] }), { headers: { "content-type": "application/json" } })) as typeof fetch });
  const boot = await (await originalFetch(`${api.url}/api/v1/bootstrap`)).json() as { csrf: string; sessionId: string; currentTaskId: string };
  const save = (body: ModelSettingsInput) => originalFetch(`${api!.url}/api/v1/settings/models`, { method: "PUT",
    headers: { origin: api!.url, "x-figo-csrf": boot.csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { boot, save };
}

describe("模型设置即时生效", () => {
  it("reserves the model update lock before reading a default-selection request body", async () => {
    const { boot, save } = await start();
    const before = await readModelSettings(root);
    const body = JSON.stringify({ providerId: "relay", modelId: "queued-model" });
    const pending = httpRequest(`${api!.url}/api/v1/models/default`, { method: "PUT", headers: {
      origin: api!.url, "x-figo-csrf": boot.csrf, "content-type": "application/json", "content-length": Buffer.byteLength(body), expect: "100-continue"
    } });
    const response = new Promise<number>((resolve, reject) => { pending.on("response", (value) => { value.resume(); resolve(value.statusCode!); }); pending.on("error", reject); });
    const continued = new Promise<void>((resolve) => pending.once("continue", resolve));
    pending.flushHeaders();
    await continued;
    try {
      expect((await save({ ...before, models: [{ ...before.models[0], apiKey: "fixture-new-value", baseUrl: "https://new.example/v1", model: "new-model" }] })).status).toBe(409);
    } finally { pending.end(body); await response; pending.destroy(); }
    expect(kernel!.modelConfigs()[0].apiKey).toBe("fixture-old-value");
  });

  it("does not change the file or runtime when validation fails", async () => {
    const { save } = await start();
    const before = await readModelSettings(root);
    const content = await readFile(join(root, "figo-agent.config.json"), "utf8");
    const response = await save({ ...before, models: [{ ...before.models[0], clearApiKey: true }] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "启用的模型必须填写 API Key。" });
    expect(await readFile(join(root, "figo-agent.config.json"), "utf8")).toBe(content);
    expect(kernel!.modelConfigs()[0].apiKey).toBe("fixture-old-value");
  });

  it("does not activate prepared providers when writing the config fails", async () => {
    const { save } = await start();
    const before = await readModelSettings(root);
    const content = await readFile(join(root, "figo-agent.config.json"), "utf8");
    vi.mocked(rename).mockRejectedValueOnce(new Error("fixture-write-failed"));
    const response = await save({ ...before, models: [{ ...before.models[0], apiKey: "fixture-new-value" }] });
    expect(response.status).toBe(500);
    expect(await readFile(join(root, "figo-agent.config.json"), "utf8")).toBe(content);
    expect(kernel!.modelConfigs()[0].apiKey).toBe("fixture-old-value");
    expect((await save({ ...before, models: [{ ...before.models[0], apiKey: "fixture-new-value" }] })).status).toBe(200);
  });

  it("rejects saving during an active run without interrupting or changing its connection", async () => {
    let release!: () => void;
    let requested!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { requested = resolve; });
    const { boot, save } = await start(blocked, requested);
    const before = await readModelSettings(root);
    const content = await readFile(join(root, "figo-agent.config.json"), "utf8");
    const run = api!.coordinator.submit({ taskId: boot.currentTaskId, input: "运行期间", clientRequestId: "active-settings" });
    try {
      await started;
      expect((await save({ ...before, models: [{ ...before.models[0], apiKey: "fixture-new-value" }] })).status).toBe(409);
      expect(await readFile(join(root, "figo-agent.config.json"), "utf8")).toBe(content);
      expect(kernel!.modelConfigs()[0].apiKey).toBe("fixture-old-value");
    } finally { release(); await api!.coordinator.waitForIdle(); }
    expect(api!.coordinator.getRun(run.runId).status).toBe("completed");
    expect(calls[0].authorization).toBe("Bearer fixture-old-value");
  });

  it("updates provider connections, catalog, default, capacity and compaction without replacing the session", async () => {
    const { boot, save } = await start();
    const first = api!.coordinator.submit({ taskId: boot.currentTaskId, input: "旧连接", clientRequestId: "before-save" });
    await api!.coordinator.waitForIdle();
    expect(api!.coordinator.getRun(first.runId).status).toBe("completed");
    const before = await readModelSettings(root);
    const saved = await save({ ...before, models: [
      { ...before.models[0], baseUrl: "https://new.example/v1", model: "new-model", apiKey: "fixture-new-value", contextWindow: 65536, maxTokens: 1234, maxTokensField: "max_completion_tokens" },
      { id: "deepseek", family: "deepseek", enabled: true, baseUrl: "https://api.deepseek.com", model: "deep-test", apiKey: "fixture-deep-value" }
    ] });
    expect(saved.status).toBe(200);
    expect(kernel!.defaultModelSelection()).toEqual({ providerId: "relay", modelId: "new-model" });
    const after = await (await originalFetch(`${api!.url}/api/v1/bootstrap`)).json();
    expect(after).toMatchObject({ sessionId: boot.sessionId, currentTaskId: boot.currentTaskId, model: "new-model", modelConfigured: true });
    const available = await (await originalFetch(`${api!.url}/api/v1/models/available`)).json();
    expect(available.providers.map((entry: { id: string }) => entry.id)).toEqual(["relay", "deepseek"]);
    const next = api!.coordinator.submit({ taskId: boot.currentTaskId, input: "新连接", clientRequestId: "after-save" });
    await api!.coordinator.waitForIdle();
    expect(api!.coordinator.getRun(next.runId).status).toBe("completed");
    expect(calls[1]).toMatchObject({ url: "https://new.example/v1/chat/completions", authorization: "Bearer fixture-new-value", body: { model: "new-model" } });
    expect(kernel!.modelConfigs()[0]).toMatchObject({ contextWindow: 65536, maxTokens: 1234, maxTokensField: "max_completion_tokens" });
    expect(calls[0].body.tools).toBeDefined();
    // 更换端点沿用已有保存语义，协议回到 text；普通请求未新增输出上限行为。
    expect(calls[1].body.tools).toBeUndefined();
    const compacted = await kernel!.handleCommand("/compact");
    expect(compacted.status).toBe("completed");
    expect(calls.at(-1)).toMatchObject({ url: "https://new.example/v1/chat/completions", authorization: "Bearer fixture-new-value", body: { model: "new-model", max_completion_tokens: 16 } });
    const latest = await readModelSettings(root);
    expect((await save({ ...latest, activeModelId: "deepseek", models: latest.models.filter((entry) => entry.id === "deepseek") })).status).toBe(200);
    expect(() => kernel!.validateModelSelection({ providerId: "relay", modelId: "new-model" })).toThrow();
    const third = api!.coordinator.submit({ taskId: boot.currentTaskId, input: "新服务商", clientRequestId: "added-provider" });
    await api!.coordinator.waitForIdle();
    expect(api!.coordinator.getRun(third.runId).status).toBe("completed");
    expect(calls.at(-1)).toMatchObject({ url: "https://api.deepseek.com/chat/completions", authorization: "Bearer fixture-deep-value", body: { model: "deep-test" } });
    expect(kernel!.storage.db.prepare("select count(*) n from sessions").get()).toEqual({ n: 1 });
    expect(kernel!.storage.db.prepare("select count(*) n from turns").get()).toEqual({ n: 3 });
  });

  it("keeps both old and rotated keys redacted in existing UI query services", async () => {
    const { boot, save } = await start();
    const before = await readModelSettings(root);
    expect((await save({ ...before, models: [{ ...before.models[0], apiKey: "fixture-new-value" }] })).status).toBe(200);
    api!.coordinator.events.append({ sessionId: boot.sessionId, kind: "test.redaction", payload: { note: "fixture-old-value fixture-new-value" } });
    const events = await (await originalFetch(`${api!.url}/api/v1/debug-events`)).text();
    expect(events).not.toContain("fixture-old-value");
    expect(events).not.toContain("fixture-new-value");
    expect(events).toContain("[REDACTED]");
    api!.coordinator.submit({ taskId: boot.currentTaskId, input: "轮换后", clientRequestId: "after-rotation" });
    await api!.coordinator.waitForIdle();
    expect(calls[0].authorization).toBe("Bearer fixture-new-value");
    expect(calls[0].body.tools).toBeDefined();
  });

  it("rejects concurrent runs and model writes while a settings request body is pending", async () => {
    const { boot, save } = await start();
    const before = await readModelSettings(root);
    const input = { ...before, models: [{ ...before.models[0], apiKey: "fixture-new-value" }] };
    const body = JSON.stringify(input);
    const pending = httpRequest(`${api!.url}/api/v1/settings/models`, { method: "PUT", headers: {
      origin: api!.url, "x-figo-csrf": boot.csrf, "content-type": "application/json", "content-length": Buffer.byteLength(body), expect: "100-continue"
    } });
    const response = new Promise<number>((resolve, reject) => { pending.on("response", (value) => { value.resume(); resolve(value.statusCode!); }); pending.on("error", reject); });
    const continued = new Promise<void>((resolve) => pending.once("continue", resolve));
    pending.flushHeaders();
    await continued;
    try {
      const run = await originalFetch(`${api!.url}/api/v1/tasks/${boot.currentTaskId}/turns`, { method: "POST", headers: {
        origin: api!.url, "x-figo-csrf": boot.csrf, "content-type": "application/json"
      }, body: JSON.stringify({ input: "不得抢跑", clientRequestId: "during-save" }) });
      expect(run.status).toBe(409);
      expect((await save(input)).status).toBe(409);
    } finally { pending.end(body); await response; pending.destroy(); }
    expect(kernel!.storage.db.prepare("select count(*) n from turns").get()).toEqual({ n: 0 });
    expect(kernel!.modelConfigs()[0].apiKey).toBe("fixture-new-value");
  });
});
