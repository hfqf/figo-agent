import { randomUUID } from "node:crypto";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { readModelSettings, saveModelSettings, type VersionedModelSettings } from "../config/model-settings.js";
import { modelFamilies, officialUrls } from "../config/model-services.js";
import { listModelIds } from "../config/model-catalog.js";
import { zhCN } from "../i18n/catalog.js";
import type { DesktopModelSetup, DesktopModelInput, DesktopModelDiscoveryInput } from "./model-setup-contracts.js";

export type { DesktopModelSetup, DesktopModelInput, DesktopModelDiscoveryInput } from "./model-setup-contracts.js";

export async function readDesktopModelSetup(configRoot: string): Promise<DesktopModelSetup> {
  return setupSnapshot(await readModelSettings(configRoot));
}

function setupSnapshot(settings: VersionedModelSettings): DesktopModelSetup {
  const active = settings.models.find(entry => entry.id === settings.activeModelId && entry.enabled);
  if (!active) throw new Error(zhCN.desktopSetup.invalidConnection);
  return { id: active.id, family: active.family, baseUrl: active.baseUrl, model: active.model,
    configured: active.hasApiKey, settings };
}

function connectionUrl(input: DesktopModelDiscoveryInput): string {
  if (!input || !modelFamilies.includes(input.family) || typeof input.baseUrl !== "string" || typeof input.apiKey !== "string") {
    throw new Error(zhCN.desktopSetup.invalidConnection);
  }
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if ((input.family !== "gpt-relay" && baseUrl !== officialUrls[input.family]) ||
    (input.family === "gpt-relay" && Object.values(officialUrls).includes(baseUrl))) {
    throw new Error(zhCN.desktopSetup.invalidConnection);
  }
  return baseUrl;
}

export async function saveDesktopModelSetup(configRoot: string, input: DesktopModelInput): Promise<DesktopModelSetup> {
  const baseUrl = connectionUrl(input);
  if (typeof input.version !== "string" || typeof input.model !== "string") throw new Error(zhCN.desktopSetup.invalidConnection);
  const previous = await readModelSettings(configRoot);
  const current = previous.models.find(entry => entry.family === input.family && entry.id === previous.activeModelId)
    ?? previous.models.find(entry => entry.family === input.family);
  if (!input.apiKey.trim() && !(current?.hasApiKey && current.baseUrl.replace(/\/+$/, "") === baseUrl)) {
    throw new Error(zhCN.desktopSetup.keyRequired);
  }
  const id = current?.id ?? (previous.models.some(entry => entry.id === input.family) ? `${input.family}-${randomUUID()}` : input.family);
  const selected = { id, family: input.family, baseUrl, model: input.model, apiKey: input.apiKey, enabled: true };
  const models = current ? previous.models.map(entry => entry.id === id ? selected : entry) : [...previous.models, selected];
  const saved = await saveModelSettings(configRoot, { version: input.version, activeModelId: id, models });
  return setupSnapshot(saved);
}

export async function discoverDesktopModels(configRoot: string, input: DesktopModelDiscoveryInput, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const baseUrl = connectionUrl(input);
  const config = await loadRuntimeConfig(configRoot);
  const stored = config.llm.find(entry => entry.baseUrl.replace(/\/+$/, "") === baseUrl && entry.id === config.activeModelId)
    ?? config.llm.find(entry => entry.baseUrl.replace(/\/+$/, "") === baseUrl);
  const apiKey = input.apiKey.trim() || stored?.apiKey || "";
  return listModelIds({ baseUrl, apiKey }, fetchImpl);
}
