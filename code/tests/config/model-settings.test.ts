import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readModelSettings, saveActiveModelSelection, saveModelSettings } from "../../src/config/model-settings.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

describe("model settings", () => {
  it("does not persist changes when preparing runtime activation fails", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-model-activation-"));
    const path = join(root, "figo-agent.config.json");
    const content = JSON.stringify({ activeModelId: "minimax", llm: [{ id: "minimax", enabled: true,
      provider: "openai-compatible", apiKey: "fixture-old", baseUrl: "https://api.minimaxi.com/v1", model: "mini-test" }] });
    await writeFile(path, content);
    const before = await readModelSettings(root);
    await expect(saveModelSettings(root, { ...before, models: [{ ...before.models[0], apiKey: "fixture-new" }] },
      () => { throw new Error("fixture-runtime-activation-failed"); })).rejects.toThrow("fixture-runtime-activation-failed");
    expect(await readFile(path, "utf8")).toBe(content);
  });

  it.each(["minimax", "gpt-relay"])("saves the %s key without requiring keys for unchanged enabled templates", async (providerId) => {
    root = await mkdtemp(join(tmpdir(), "figo-model-template-"));
    const path = join(root, "figo-agent.config.json");
    await writeFile(path, JSON.stringify({ activeModelId: "gpt-relay", llm: [
      { id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "", baseUrl: "https://api.minimaxi.com/v1", model: "mini-test" },
      { id: "gpt-relay", enabled: true, provider: "openai-compatible", apiKey: "", baseUrl: "https://relay.example/v1", model: "gpt-test", toolCallingMode: "native" },
      { id: "deepseek", enabled: true, provider: "openai-compatible", apiKey: "", baseUrl: "https://api.deepseek.com", model: "deep-test" }
    ] }));
    const before = await readModelSettings(root);
    const saved = await saveModelSettings(root, { ...before, models: before.models.map((model) =>
      model.id === providerId ? { ...model, apiKey: "fixture-replacement" } : model) });
    expect(saved.models.map(({ id, enabled, hasApiKey }) => ({ id, enabled, hasApiKey }))).toEqual([
      { id: "minimax", enabled: true, hasApiKey: providerId === "minimax" },
      { id: "gpt-relay", enabled: true, hasApiKey: providerId === "gpt-relay" },
      { id: "deepseek", enabled: true, hasApiKey: false }
    ]);
    expect(JSON.stringify(saved)).not.toContain("fixture-replacement");
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.activeModelId).toBe("gpt-relay");
    expect(raw.llm[1]).toMatchObject({ apiKey: providerId === "gpt-relay" ? "fixture-replacement" : "", toolCallingMode: "native" });
    expect(raw.llm[0].apiKey).toBe(providerId === "minimax" ? "fixture-replacement" : "");
    expect(raw.llm[2].apiKey).toBe("");
  });

  it.each(["enable", "endpoint", "clear", "active"] as const)("still rejects an unconfigured provider after %s changes", async (change) => {
    root = await mkdtemp(join(tmpdir(), "figo-model-template-guard-"));
    const path = join(root, "figo-agent.config.json");
    const content = JSON.stringify({ activeModelId: "minimax", llm: [
      { id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "fixture-existing", baseUrl: "https://api.minimaxi.com/v1", model: "mini-test" },
      { id: "relay", enabled: change !== "enable", provider: "openai-compatible", apiKey: "", baseUrl: "https://relay.example/v1", model: "gpt-test" }
    ] });
    await writeFile(path, content);
    const before = await readModelSettings(root);
    await expect(saveModelSettings(root, { ...before, activeModelId: change === "active" ? "relay" : before.activeModelId,
      models: before.models.map((model) => {
        if (change === "clear" && model.id === "minimax") return { ...model, clearApiKey: true };
        if (model.id !== "relay") return model;
        return { ...model, enabled: true, baseUrl: change === "endpoint" ? "https://changed.example/v1" : model.baseUrl };
      }) })).rejects.toThrow("API Key");
    expect(await readFile(path, "utf8")).toBe(content);
  });

  it("preserves capacity only for the same endpoint and exact model", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-model-capacity-"));
    const path = join(root, "figo-agent.config.json");
    await writeFile(path, JSON.stringify({ activeModelId: "relay", llm: [{ id: "relay", enabled: true, provider: "openai-compatible", apiKey: "test-key", baseUrl: "https://relay.example/v1", model: "known", contextWindow: 128000, maxTokens: 16000, metadataSource: "endpoint:/models" }] }));
    const before = await readModelSettings(root);
    await saveModelSettings(root, { version: before.version, activeModelId: "relay", models: before.models });
    let raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.llm[0]).toMatchObject({ contextWindow: 128000, maxTokens: 16000 });
    await saveActiveModelSelection(root, { providerId: "relay", modelId: "unknown" }, { baseUrl: "https://relay.example/v1", apiKey: "test-key" });
    raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.llm[0]).not.toHaveProperty("contextWindow");
    expect(raw.llm[0]).not.toHaveProperty("maxTokens");
    expect(raw.llm[0]).not.toHaveProperty("metadataSource");
  });
  it("preserves the native tool mode when editing an existing relay", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-model-native-"));
    const path = join(root, "figo-agent.config.json");
    await writeFile(path, JSON.stringify({ activeModelId: "gpt-relay", llm: [
      { id: "gpt-relay", enabled: true, provider: "openai-compatible", apiKey: "test-key",
        baseUrl: "https://relay.example/v1", model: "gpt-test", toolCallingMode: "native" }
    ] }));
    const before = await readModelSettings(root);
    await saveModelSettings(root, { version: before.version, activeModelId: "gpt-relay", models: [
      { id: "gpt-relay", family: "gpt-relay", enabled: true, baseUrl: "https://relay.example/v1", model: "gpt-test-2" }
    ] });
    const raw = JSON.parse(await readFile(path, "utf8")) as { llm: Array<{ toolCallingMode: string }> };
    expect(raw.llm[0].toolCallingMode).toBe("native");
  });
  it("changes only the active provider and its model while keeping keys and other config", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-model-default-"));
    const path = join(root, "figo-agent.config.json");
    await writeFile(path, JSON.stringify({ activeModelId: "minimax", custom: { intact: true }, llm: [
      { id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "mini-secret", baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3" },
      { id: "deepseek", enabled: true, provider: "openai-compatible", apiKey: "deep-secret", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" }
    ] }));
    const saved = await saveActiveModelSelection(root, { providerId: "deepseek", modelId: "deepseek-reasoner" },
      { baseUrl: "https://api.deepseek.com", apiKey: "deep-secret" });
    expect(saved).toMatchObject({ providerId: "deepseek", modelId: "deepseek-reasoner" });
    expect(JSON.stringify(saved)).not.toContain("secret");
    const raw = JSON.parse(await readFile(path, "utf8")) as { activeModelId: string; custom: unknown; llm: Array<{ id: string; model: string; apiKey: string }> };
    expect(raw.activeModelId).toBe("deepseek");
    expect(raw.llm.map(({ id, model, apiKey }) => ({ id, model, apiKey }))).toEqual([
      { id: "minimax", model: "MiniMax-M3", apiKey: "mini-secret" },
      { id: "deepseek", model: "deepseek-reasoner", apiKey: "deep-secret" }
    ]);
    expect(raw.custom).toEqual({ intact: true });
    expect((await readModelSettings(root)).activeModelId).toBe("deepseek");
    await expect(saveActiveModelSelection(root, { providerId: "minimax", modelId: "MiniMax-M3" },
      { baseUrl: "https://old.example/v1", apiKey: "mini-secret" })).rejects.toThrow("重新保存");
    expect((await readModelSettings(root)).activeModelId).toBe("deepseek");
  });
  it("redacts keys, preserves unrelated config, and saves multiple models atomically", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-model-settings-"));
    const path = join(root, "figo-agent.config.json");
    await writeFile(path, JSON.stringify({ version: 2, locale: "zh-CN", activeModelId: "minimax", llm: [
      { id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "secret-one", baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3" }
    ], context: { maxTaskHistoryTurns: 8 }, custom: { intact: true } }));
    const before = await readModelSettings(root);
    expect(JSON.stringify(before)).not.toContain("secret-one");
    expect(before.models[0].hasApiKey).toBe(true);
    const saved = await saveModelSettings(root, {
      version: before.version, activeModelId: "deepseek", models: [
        { id: "minimax", family: "minimax", enabled: false, baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3" },
        { id: "deepseek", family: "deepseek", enabled: true, baseUrl: "https://api.deepseek.com", model: "deepseek-flash", apiKey: "secret-two" }
      ]
    });
    expect(JSON.stringify(saved)).not.toContain("secret-two");
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(raw.custom).toEqual({ intact: true });
    expect(raw.context).toEqual({ maxTaskHistoryTurns: 8 });
    expect((raw.llm as Array<{ apiKey: string }>).map((model) => model.apiKey)).toEqual(["secret-one", "secret-two"]);
    // POSIX mode 不表示 Windows ACL；配置保存行为仍在所有平台验收。
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(saveModelSettings(root, { version: before.version, activeModelId: "deepseek", models: saved.models })).rejects.toThrow("配置已变化");
  });

  it("requires a replacement key when a model endpoint changes", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-model-settings-"));
    const before = await readModelSettings(root);
    await expect(saveModelSettings(root, { version: before.version, activeModelId: "minimax", models: [
      { id: "minimax", family: "gpt-relay", enabled: true, baseUrl: "https://relay.example/v1", model: "gpt-test" }
    ] })).rejects.toThrow("API Key");
  });

  it("accepts only one concurrent update for the same version", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-model-settings-"));
    const before = await readModelSettings(root);
    const input = { version: before.version, activeModelId: "minimax", models: [{
      id: "minimax", family: "minimax" as const, enabled: true, baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3", apiKey: "test-key"
    }] };
    const results = await Promise.allSettled([saveModelSettings(root, input), saveModelSettings(root, input)]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("rejects a provider label that disagrees with its endpoint", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-model-settings-"));
    const before = await readModelSettings(root);
    await expect(saveModelSettings(root, { version: before.version, activeModelId: "minimax", models: [{
      id: "minimax", family: "gpt-relay", enabled: true, baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3", apiKey: "test-key"
    }] })).rejects.toThrow("模型地址无效");
  });
});
