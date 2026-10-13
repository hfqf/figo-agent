import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getActiveLlmConfig, loadRuntimeConfig, runtimeConfigFileName } from "../config/runtime-config.js";

export interface DesktopModelSetup {
  id: string;
  baseUrl: string;
  model: string;
  configured: boolean;
}

export interface DesktopModelInput {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export async function readDesktopModelSetup(configRoot: string): Promise<DesktopModelSetup> {
  const active = getActiveLlmConfig(await loadRuntimeConfig(configRoot));
  return { id: active.id, baseUrl: active.baseUrl, model: active.model, configured: Boolean(active.apiKey.trim()) };
}

export async function saveDesktopModelSetup(configRoot: string, input: DesktopModelInput): Promise<DesktopModelSetup> {
  if (!input || typeof input.baseUrl !== "string" || typeof input.model !== "string" || typeof input.apiKey !== "string") {
    throw new Error("模型配置无效。");
  }
  const baseUrl = input.baseUrl.trim();
  const model = input.model.trim();
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !model || model.length > 200 || baseUrl.length > 2048) {
    throw new Error("模型地址或名称无效。");
  }
  const path = join(configRoot, runtimeConfigFileName);
  const config = await loadRuntimeConfig(configRoot);
  const active = getActiveLlmConfig(config);
  const apiKey = input.apiKey.trim() || active.apiKey;
  if (!apiKey) throw new Error("请填写 API Key。");
  const updated = { ...config, llm: config.llm.map((entry) => entry.id === active.id
    ? { ...entry, baseUrl, model, apiKey } : entry) };
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return readDesktopModelSetup(configRoot);
}
