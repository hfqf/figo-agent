import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readPiCompactionSettings, type PiCompactionSettings } from "./pi-compaction-settings.js";
import {
  defaultAgentBehavior, defaultFileBrowserConfig, defaultStorageConfig, defaultTerminalConfig, defaultToolDefaults,
  readAgentBehavior, readFileBrowserConfig, readStorageConfig, readTerminalConfig, readToolDefaults,
  type RuntimeAgentBehavior, type RuntimeFileBrowserConfig, type RuntimeStorageConfig, type RuntimeTerminalConfig, type RuntimeToolDefaults
} from "./runtime-behavior.js";

export const runtimeConfigFileName = "figo-agent.config.json";

export interface RuntimeLlmConfig {
  id: string;
  enabled: boolean;
  provider: "openai-compatible";
  apiKey: string;
  baseUrl: string;
  model: string;
  toolCallingMode?: "text" | "native";
  contextWindow?: number;
  maxTokens?: number;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  metadataSource?: string;
}

export interface RuntimeContextConfig {
  includeMemory: boolean;
  compaction: RuntimeCompactionConfig;
}

export type RuntimeCompactionConfig = PiCompactionSettings;

export interface RuntimeToolsConfig {
  allowed: string[];
  defaults: RuntimeToolDefaults;
}

export interface RuntimeWebConfig {
  requireAccessCode: boolean;
  fileBrowser: RuntimeFileBrowserConfig;
  terminal: RuntimeTerminalConfig;
}

export interface RuntimeConfig {
  version: 2;
  locale: "zh-CN";
  activeModelId: string;
  llm: RuntimeLlmConfig[];
  context: RuntimeContextConfig;
  agent: RuntimeAgentBehavior;
  storage: RuntimeStorageConfig;
  tools: RuntimeToolsConfig;
  web: RuntimeWebConfig;
}

export const defaultAllowedTools = [
  "list_files",
  "read_file",
  "search_text",
  "system_info",
  "path_stat",
  "read_many_files",
  "workspace_summary",
  "write_file",
  "apply_patch",
  "run_command",
  "git_status",
  "git_diff",
  "git_log",
  "git_add",
  "git_commit",
  "network_fetch",
  "browser_open",
  "browser_snapshot"
];

export const defaultRuntimeConfig: RuntimeConfig = {
  version: 2,
  locale: "zh-CN",
  activeModelId: "minimax",
  llm: [{
    id: "minimax",
    enabled: true,
    provider: "openai-compatible",
    apiKey: "",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "MiniMax-M3"
  }],
  context: {
    includeMemory: true,
    compaction: readPiCompactionSettings(undefined)
  },
  agent: defaultAgentBehavior,
  storage: defaultStorageConfig,
  tools: {
    allowed: defaultAllowedTools,
    defaults: defaultToolDefaults
  },
  web: { requireAccessCode: true, fileBrowser: defaultFileBrowserConfig, terminal: defaultTerminalConfig }
};

export async function loadRuntimeConfig(workspaceRoot: string): Promise<RuntimeConfig> {
  let content: string;
  try {
    content = await readFile(join(workspaceRoot, runtimeConfigFileName), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return cloneDefaultConfig();
    throw error;
  }

  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error("运行配置必须是 JSON 对象。");
  return mergeRuntimeConfig(parsed);
}

function mergeRuntimeConfig(value: Record<string, unknown>): RuntimeConfig {
  const { llm, activeModelId } = readLlmConfig(value.llm, value.activeModelId);
  const context = isRecord(value.context) ? value.context : {};
  const tools = isRecord(value.tools) ? value.tools : {};
  const web = isRecord(value.web) ? value.web : {};

  return {
    version: 2,
    locale: readLocale(value.locale),
    activeModelId,
    llm,
    agent: readAgentBehavior(value.agent),
    storage: readStorageConfig(value.storage),
    context: {
      includeMemory: booleanValue(context.includeMemory, defaultRuntimeConfig.context.includeMemory),
      compaction: readPiCompactionSettings(context.compaction)
    },
    tools: {
      allowed: stringArrayValue(tools.allowed, defaultRuntimeConfig.tools.allowed),
      defaults: readToolDefaults(tools.defaults)
    },
    web: {
      requireAccessCode: booleanValue(web.requireAccessCode, defaultRuntimeConfig.web.requireAccessCode),
      fileBrowser: readFileBrowserConfig(web.fileBrowser), terminal: readTerminalConfig(web.terminal)
    }
  };
}

function cloneDefaultConfig(): RuntimeConfig {
  return {
    version: 2,
    locale: defaultRuntimeConfig.locale,
    activeModelId: defaultRuntimeConfig.activeModelId,
    llm: defaultRuntimeConfig.llm.map((entry) => ({ ...entry })),
    context: {
      ...defaultRuntimeConfig.context,
      compaction: readPiCompactionSettings(defaultRuntimeConfig.context.compaction)
    },
    agent: { ...defaultRuntimeConfig.agent },
    storage: { ...defaultRuntimeConfig.storage },
    tools: {
      ...defaultRuntimeConfig.tools,
      allowed: [...defaultRuntimeConfig.tools.allowed],
      defaults: { ...defaultRuntimeConfig.tools.defaults }
    },
    web: { ...defaultRuntimeConfig.web, fileBrowser: { ...defaultRuntimeConfig.web.fileBrowser }, terminal: { ...defaultRuntimeConfig.web.terminal } }
  };
}

export function getActiveLlmConfig(config: RuntimeConfig): RuntimeLlmConfig {
  const active = config.llm.find((entry) => entry.id === config.activeModelId);
  if (!active || !active.enabled) throw new Error(`启用的模型不存在或已关闭：${config.activeModelId}`);
  return active;
}

function readLlmConfig(value: unknown, selected: unknown): Pick<RuntimeConfig, "llm" | "activeModelId"> {
  if (value === undefined) {
    const config = cloneDefaultConfig();
    if (selected !== undefined && selected !== config.activeModelId) throw new Error(`启用的模型不存在：${String(selected)}`);
    return { llm: config.llm, activeModelId: config.activeModelId };
  }

  if (isRecord(value)) {
    const fallback = defaultRuntimeConfig.llm[0];
    const llm: RuntimeLlmConfig[] = [{
      ...fallback,
      apiKey: stringValue(value.apiKey, fallback.apiKey),
      baseUrl: stringValue(value.baseUrl, fallback.baseUrl),
      model: stringValue(value.model, fallback.model),
      ...readModelCapacity(value)
    }];
    if (selected !== undefined && selected !== fallback.id) throw new Error(`启用的模型不存在：${String(selected)}`);
    return { llm, activeModelId: fallback.id };
  }

  if (!Array.isArray(value) || value.length === 0) throw new Error("llm 必须是非空模型数组。");
  const llm = value.map((entry, index): RuntimeLlmConfig => {
    if (!isRecord(entry)) throw new Error(`llm[${index}] 必须是对象。`);
    const { id, enabled, provider, apiKey, baseUrl, model, toolCallingMode } = entry;
    if (typeof id !== "string" || !id.trim()) throw new Error(`llm[${index}].id 不能为空。`);
    if (typeof enabled !== "boolean") throw new Error(`llm[${index}].enabled 必须是布尔值。`);
    if (provider !== "openai-compatible") throw new Error(`llm[${index}].provider 不受支持：${String(provider)}`);
    if (typeof apiKey !== "string" || typeof baseUrl !== "string" || !baseUrl.trim() || typeof model !== "string" || !model.trim()) {
      throw new Error(`llm[${index}] 缺少 apiKey、baseUrl 或 model。`);
    }
    if (toolCallingMode !== undefined && toolCallingMode !== "text" && toolCallingMode !== "native") {
      throw new Error(`llm[${index}].toolCallingMode 不受支持。`);
    }
    return { id: id.trim(), enabled, provider, apiKey, baseUrl: baseUrl.trim(), model: model.trim(),
      toolCallingMode: toolCallingMode ?? "text", ...readModelCapacity(entry) };
  });
  if (new Set(llm.map((entry) => entry.id)).size !== llm.length) throw new Error("llm 模型 id 不能重复。");
  if (typeof selected !== "string" || !selected.trim()) throw new Error("activeModelId 必须指定模型 id。");
  const activeModelId = selected.trim();
  if (!llm.some((entry) => entry.id === activeModelId && entry.enabled)) {
    throw new Error(`启用的模型不存在或已关闭：${activeModelId}`);
  }
  return { llm, activeModelId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringArrayValue(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return [...fallback];
  return value;
}

export function readModelCapacity(value: Record<string, unknown>): Pick<RuntimeLlmConfig, "contextWindow" | "maxTokens" | "maxTokensField" | "metadataSource"> {
  const output: Pick<RuntimeLlmConfig, "contextWindow" | "maxTokens" | "maxTokensField" | "metadataSource"> = {};
  for (const field of ["contextWindow", "maxTokens"] as const) {
    const number = value[field];
    if (number === undefined) continue;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new Error(`${field} 必须是正安全整数。`);
    output[field] = number;
  }
  if (value.maxTokensField !== undefined) {
    if (value.maxTokensField !== "max_tokens" && value.maxTokensField !== "max_completion_tokens") throw new Error("maxTokensField 无效。");
    output.maxTokensField = value.maxTokensField;
  }
  if (value.metadataSource !== undefined) {
    if (typeof value.metadataSource !== "string" || value.metadataSource.length > 2048) throw new Error("metadataSource 无效。");
    output.metadataSource = value.metadataSource;
  }
  return output;
}

function readLocale(value: unknown): "zh-CN" {
  if (value === undefined || value === "zh-CN") return "zh-CN";
  throw new Error(`不支持的语言：${String(value)}`);
}
