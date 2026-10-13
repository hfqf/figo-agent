import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelSelection } from "../contracts/types.js";
import { defaultRuntimeConfig, loadRuntimeConfig, runtimeConfigFileName, type RuntimeLlmConfig } from "./runtime-config.js";

export type ModelFamily = "minimax" | "deepseek" | "gpt-official" | "gpt-relay";
export interface ModelSetting {
  id: string;
  family: ModelFamily;
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}
export interface VersionedModelSettings { activeModelId: string; models: ModelSetting[]; version: string }
export interface ModelSettingInput extends Omit<ModelSetting, "hasApiKey"> { apiKey?: string; clearApiKey?: boolean }
export interface ModelSettingsInput { version: string; activeModelId: string; models: ModelSettingInput[] }

export const officialUrls: Record<Exclude<ModelFamily, "gpt-relay">, string> = {
  minimax: "https://api.minimaxi.com/v1",
  deepseek: "https://api.deepseek.com",
  "gpt-official": "https://api.openai.com/v1"
};
const pendingSaves = new Map<string, Promise<void>>();

async function serializeSave<T>(configRoot: string, save: () => Promise<T>): Promise<T> {
  const previous = pendingSaves.get(configRoot) ?? Promise.resolve();
  const saving = previous.then(save);
  const completed = saving.then(() => undefined, () => undefined);
  pendingSaves.set(configRoot, completed);
  try { return await saving; }
  finally { if (pendingSaves.get(configRoot) === completed) pendingSaves.delete(configRoot); }
}

async function writeRaw(configRoot: string, raw: Record<string, unknown>): Promise<string> {
  const path = join(configRoot, runtimeConfigFileName);
  const temp = `${path}.${randomUUID()}.tmp`;
  const updated = `${JSON.stringify(raw, null, 2)}\n`;
  try {
    await writeFile(temp, updated, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
  return fingerprint(updated);
}

function familyOf(baseUrl: string): ModelFamily {
  const normalized = baseUrl.replace(/\/+$/, "");
  for (const [family, url] of Object.entries(officialUrls)) if (normalized === url) return family as ModelFamily;
  return "gpt-relay";
}

function fingerprint(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function snapshot(llm: RuntimeLlmConfig[], activeModelId: string, version: string): VersionedModelSettings {
  return { activeModelId, version, models: llm.map(({ id, enabled, baseUrl, model, apiKey }) => ({
    id, enabled, baseUrl, model, family: familyOf(baseUrl), hasApiKey: Boolean(apiKey.trim())
  })) };
}

async function readRaw(configRoot: string): Promise<{ raw: Record<string, unknown>; content: string }> {
  let content: string;
  try { content = await readFile(join(configRoot, runtimeConfigFileName), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    content = `${JSON.stringify(defaultRuntimeConfig, null, 2)}\n`;
  }
  const raw: unknown = JSON.parse(content);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("模型配置无效。");
  return { raw: raw as Record<string, unknown>, content };
}

export async function readModelSettings(configRoot: string): Promise<VersionedModelSettings> {
  const [{ content }, config] = await Promise.all([readRaw(configRoot), loadRuntimeConfig(configRoot)]);
  return snapshot(config.llm, config.activeModelId, fingerprint(content));
}

export async function saveModelSettings(configRoot: string, input: ModelSettingsInput): Promise<VersionedModelSettings> {
  return serializeSave(configRoot, () => saveModelSettingsUnlocked(configRoot, input));
}

export async function saveActiveModelSelection(
  configRoot: string, selection: ModelSelection, expectedConnection: { baseUrl: string; apiKey: string }
): Promise<ModelSelection & { version: string }> {
  return serializeSave(configRoot, async () => {
    if (!selection || typeof selection.providerId !== "string" || typeof selection.modelId !== "string" ||
      !selection.modelId.trim() || selection.modelId.length > 200 || /[\u0000-\u001f]/.test(selection.modelId)) {
      throw new Error("所选模型配置无效。");
    }
    const { raw, content } = await readRaw(configRoot);
    const config = await loadRuntimeConfig(configRoot);
    const selected = config.llm.find((entry) => entry.id === selection.providerId && entry.enabled && entry.apiKey.trim());
    if (!selected) throw new Error("所选模型配置无效或未启用。");
    if (selected.baseUrl !== expectedConnection.baseUrl || selected.apiKey !== expectedConnection.apiKey) {
      throw new Error("模型连接配置已变化，请重启工作台。");
    }
    const modelId = selection.modelId.trim();
    if (config.activeModelId === selected.id && selected.model === modelId) {
      return { providerId: selected.id, modelId, version: fingerprint(content) };
    }
    const source = Array.isArray(raw.llm) ? raw.llm : config.llm;
    const llm = source.map((entry) => {
      const value = entry as Record<string, unknown>;
      return value.id === selected.id ? { ...value, model: modelId } : value;
    });
    const version = await writeRaw(configRoot, { ...raw, activeModelId: selected.id, llm });
    return { providerId: selected.id, modelId, version };
  });
}

async function saveModelSettingsUnlocked(configRoot: string, input: ModelSettingsInput): Promise<VersionedModelSettings> {
  if (!input || typeof input.version !== "string" || typeof input.activeModelId !== "string" || !Array.isArray(input.models) || !input.models.length || input.models.length > 50) {
    throw new Error("模型配置无效。");
  }
  const { raw, content } = await readRaw(configRoot);
  if (fingerprint(content) !== input.version) throw new Error("模型配置已变化，请刷新后重试。");
  const previous = (await loadRuntimeConfig(configRoot)).llm;
  const llm = input.models.map((item): RuntimeLlmConfig => {
    if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) ||
      typeof item.enabled !== "boolean" || typeof item.model !== "string" || !item.model.trim() || item.model.length > 200 ||
      typeof item.baseUrl !== "string" || item.baseUrl.length > 2048 ||
      !["minimax", "deepseek", "gpt-official", "gpt-relay"].includes(item.family)) throw new Error("模型配置无效。");
    const baseUrl = item.baseUrl.trim().replace(/\/+$/, "");
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error("模型地址无效。"); }
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash ||
      (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
      (item.family !== "gpt-relay" && baseUrl !== officialUrls[item.family]) ||
      (item.family === "gpt-relay" && familyOf(baseUrl) !== "gpt-relay")) throw new Error("模型地址无效。");
    const old = previous.find((entry) => entry.id === item.id);
    const newKey = typeof item.apiKey === "string" ? item.apiKey.trim() : "";
    if (item.apiKey !== undefined && typeof item.apiKey !== "string") throw new Error("API Key 无效。");
    const apiKey = item.clearApiKey === true ? "" : newKey || (old?.baseUrl.replace(/\/+$/, "") === baseUrl ? old.apiKey : "");
    if (item.enabled && !apiKey) throw new Error("启用的模型必须填写 API Key。");
    return { id: item.id, enabled: item.enabled, provider: "openai-compatible", apiKey, baseUrl, model: item.model.trim(),
      toolCallingMode: old?.baseUrl.replace(/\/+$/, "") === baseUrl ? old.toolCallingMode : "text" };
  });
  if (new Set(llm.map((entry) => entry.id)).size !== llm.length || !llm.some((entry) => entry.id === input.activeModelId && entry.enabled)) {
    throw new Error("启用的模型配置无效。");
  }
  const version = await writeRaw(configRoot, { ...raw, activeModelId: input.activeModelId, llm });
  return snapshot(llm, input.activeModelId, version);
}
