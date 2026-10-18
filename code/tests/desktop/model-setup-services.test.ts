import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readModelSettings } from "../../src/config/model-settings.js";
import { loadRuntimeConfig } from "../../src/config/runtime-config.js";
import * as setup from "../../src/desktop/model-setup.js";
import { ensureDesktopConfig } from "../../src/desktop/user-data.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });
async function fixture() {
  root = await mkdtemp(join(tmpdir(), "figo-setup-services-"));
  return ensureDesktopConfig(root);
}
const services = [
  ["minimax", "https://api.minimaxi.com/v1"],
  ["deepseek", "https://api.deepseek.com"],
  ["gpt-official", "https://api.openai.com/v1"],
  ["gpt-relay", "https://relay.example/v1"]
] as const;

describe("首次模型配置的多服务边界", () => {
  it.each(services)("首次直接配置 %s，不要求先保存 MiniMax", async (family, baseUrl) => {
    await fixture();
    const before = await readModelSettings(root);
    const saved = await setup.saveDesktopModelSetup(root, { family, baseUrl, model: "fixture-model", apiKey: "fixture-secret", version: before.version });
    const config = await loadRuntimeConfig(root);
    expect(config.activeModelId).toBe(family);
    expect(config.llm.find(entry => entry.id === family)).toMatchObject({ baseUrl, model: "fixture-model", apiKey: "fixture-secret", enabled: true });
    expect(saved).toMatchObject({ id: family, family, configured: true });
    expect(JSON.stringify(saved)).not.toContain("fixture-secret");
    if (family !== "minimax") expect(config.llm.find(entry => entry.id === "minimax")?.apiKey).toBe("");
  });

  it("保存保留其他服务、容量与非模型自定义字段，切换模型清除旧容量", async () => {
    const file = await fixture();
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.customFixture = { keep: true };
    raw.context.compaction.keepRecentTokens = 7000;
    raw.llm[0].contextWindow = 100000;
    await writeFile(file, JSON.stringify(raw));
    const before = await readModelSettings(root);
    await setup.saveDesktopModelSetup(root, { family: "deepseek", baseUrl: services[1][1], model: "fixture-model", apiKey: "fixture-secret", version: before.version });
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.customFixture).toEqual({ keep: true });
    expect(after.context.compaction.keepRecentTokens).toBe(7000);
    expect(after.llm.find((entry: { id: string }) => entry.id === "minimax").contextWindow).toBe(100000);
    const next = await readModelSettings(root);
    await setup.saveDesktopModelSetup(root, { family: "minimax", baseUrl: services[0][1], model: "different-model", apiKey: "fixture-new", version: next.version });
    expect((await loadRuntimeConfig(root)).llm.find(entry => entry.id === "minimax")?.contextWindow).toBeUndefined();
  });

  it("切换服务不能继承原服务密钥，失败不修改文件", async () => {
    const file = await fixture();
    const before = await readModelSettings(root);
    await setup.saveDesktopModelSetup(root, { family: "minimax", baseUrl: services[0][1], model: "fixture", apiKey: "fixture-original", version: before.version });
    const current = await readModelSettings(root);
    const content = await readFile(file, "utf8");
    await expect(setup.saveDesktopModelSetup(root, { family: "deepseek", baseUrl: services[1][1], model: "fixture", apiKey: "", version: current.version })).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(content);
  });

  it("中转地址改变时必须重新提供密钥", async () => {
    const file = await fixture();
    const before = await readModelSettings(root);
    await setup.saveDesktopModelSetup(root, { family: "gpt-relay", baseUrl: services[3][1], model: "fixture", apiKey: "fixture-original", version: before.version });
    const current = await readModelSettings(root);
    const content = await readFile(file, "utf8");
    await expect(setup.saveDesktopModelSetup(root, { family: "gpt-relay", baseUrl: "https://changed.example/v1", model: "fixture", apiKey: "", version: current.version })).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(content);
  });

  it("过期版本和并发保存不能覆盖新配置", async () => {
    await fixture();
    const before = await readModelSettings(root);
    const input = { family: "deepseek" as const, baseUrl: services[1][1], model: "fixture", apiKey: "fixture-secret", version: before.version };
    const results = await Promise.allSettled([setup.saveDesktopModelSetup(root, input), setup.saveDesktopModelSetup(root, input)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    await expect(setup.saveDesktopModelSetup(root, input)).rejects.toThrow("配置已变化");
  });

  it("兼容旧版错误命名的中转条目，新增官方服务时生成不冲突 ID", async () => {
    const file = await fixture();
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.llm[0].baseUrl = services[3][1];
    raw.llm[0].apiKey = "fixture-relay";
    await writeFile(file, JSON.stringify(raw));
    const before = await readModelSettings(root);
    const saved = await setup.saveDesktopModelSetup(root, { family: "minimax", baseUrl: services[0][1], model: "fixture", apiKey: "fixture-official", version: before.version });
    const config = await loadRuntimeConfig(root);
    expect(config.llm.find(entry => entry.id === "minimax")?.baseUrl).toBe(services[3][1]);
    expect(saved.family).toBe("minimax");
    expect(saved.id).not.toBe("minimax");
    expect(config.activeModelId).toBe(saved.id);
  });

  it("模型发现复用目录查询，只返回模型 ID，不回显密钥", async () => {
    await fixture();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "fixture-b" }, { id: "fixture-a" }] })));
    expect(await setup.discoverDesktopModels(root, { family: "deepseek", baseUrl: services[1][1], apiKey: "fixture-secret" }, fetchImpl as typeof fetch)).toEqual(["fixture-a", "fixture-b"]);
    expect(fetchImpl).toHaveBeenCalledWith(`${services[1][1]}/models`, expect.objectContaining({ headers: { Authorization: "Bearer fixture-secret" } }));
    await expect(setup.discoverDesktopModels(root, { family: "deepseek", baseUrl: "https://other.example", apiKey: "fixture-secret" }, fetchImpl as typeof fetch)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("模型发现仅在同服务同地址复用已保存密钥", async () => {
    await fixture();
    const before = await readModelSettings(root);
    await setup.saveDesktopModelSetup(root, { family: "gpt-relay", baseUrl: services[3][1], model: "fixture", apiKey: "fixture-secret", version: before.version });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "fixture" }] })));
    await setup.discoverDesktopModels(root, { family: "gpt-relay", baseUrl: services[3][1], apiKey: "" }, fetchImpl as typeof fetch);
    await expect(setup.discoverDesktopModels(root, { family: "gpt-relay", baseUrl: "https://changed.example/v1", apiKey: "" }, fetchImpl as typeof fetch)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
