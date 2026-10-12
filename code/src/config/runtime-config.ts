import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtimeConfigFileName = "figo-agent.config.json";

export interface RuntimeLlmConfig {
  id: string;
  enabled: boolean;
  provider: "openai-compatible";
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface RuntimeContextConfig {
  includeProjectDocs: boolean;
  projectDocPaths: string[];
  maxTaskHistoryTurns: number;
  includeMemory: boolean;
  compaction: RuntimeCompactionConfig;
}

export interface RuntimeCompactionConfig {
  autoEnabled: boolean;
  turnThreshold: number;
  charThreshold: number;
  summaryMaxChars: number;
}

export interface RuntimeToolsConfig {
  maxToolRounds: number;
  allowed: string[];
}

export interface RuntimeWebConfig {
  requireAccessCode: boolean;
}

export interface RuntimeConfig {
  version: 2;
  activeModelId: string;
  llm: RuntimeLlmConfig[];
  context: RuntimeContextConfig;
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
    includeProjectDocs: false,
    projectDocPaths: ["AGENTS.MD", "readme.md"],
    maxTaskHistoryTurns: 5,
    includeMemory: true,
    compaction: { autoEnabled: true, turnThreshold: 12, charThreshold: 24000, summaryMaxChars: 12000 }
  },
  tools: {
    maxToolRounds: 3,
    allowed: defaultAllowedTools
  },
  web: { requireAccessCode: true }
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
  const compaction = isRecord(context.compaction) ? context.compaction : {};
  const tools = isRecord(value.tools) ? value.tools : {};
  const web = isRecord(value.web) ? value.web : {};
  const maxTaskHistoryTurns = positiveIntegerValue(context.maxTaskHistoryTurns, defaultRuntimeConfig.context.maxTaskHistoryTurns);

  return {
    version: 2,
    activeModelId,
    llm,
    context: {
      includeProjectDocs: booleanValue(context.includeProjectDocs, defaultRuntimeConfig.context.includeProjectDocs),
      projectDocPaths: stringArrayValue(context.projectDocPaths, defaultRuntimeConfig.context.projectDocPaths),
      maxTaskHistoryTurns,
      includeMemory: booleanValue(context.includeMemory, defaultRuntimeConfig.context.includeMemory),
      compaction: {
        autoEnabled: booleanValue(compaction.autoEnabled, defaultRuntimeConfig.context.compaction.autoEnabled),
        turnThreshold: Math.max(maxTaskHistoryTurns + 1, positiveIntegerValue(compaction.turnThreshold, defaultRuntimeConfig.context.compaction.turnThreshold)),
        charThreshold: positiveIntegerValue(compaction.charThreshold, defaultRuntimeConfig.context.compaction.charThreshold),
        summaryMaxChars: positiveIntegerValue(compaction.summaryMaxChars, defaultRuntimeConfig.context.compaction.summaryMaxChars)
      }
    },
    tools: {
      maxToolRounds: positiveIntegerValue(tools.maxToolRounds, defaultRuntimeConfig.tools.maxToolRounds),
      allowed: stringArrayValue(tools.allowed, defaultRuntimeConfig.tools.allowed)
    },
    web: { requireAccessCode: booleanValue(web.requireAccessCode, defaultRuntimeConfig.web.requireAccessCode) }
  };
}

function cloneDefaultConfig(): RuntimeConfig {
  return {
    version: 2,
    activeModelId: defaultRuntimeConfig.activeModelId,
    llm: defaultRuntimeConfig.llm.map((entry) => ({ ...entry })),
    context: {
      ...defaultRuntimeConfig.context,
      projectDocPaths: [...defaultRuntimeConfig.context.projectDocPaths],
      compaction: { ...defaultRuntimeConfig.context.compaction }
    },
    tools: {
      ...defaultRuntimeConfig.tools,
      allowed: [...defaultRuntimeConfig.tools.allowed]
    },
    web: { ...defaultRuntimeConfig.web }
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
      model: stringValue(value.model, fallback.model)
    }];
    if (selected !== undefined && selected !== fallback.id) throw new Error(`启用的模型不存在：${String(selected)}`);
    return { llm, activeModelId: fallback.id };
  }

  if (!Array.isArray(value) || value.length === 0) throw new Error("llm 必须是非空模型数组。");
  const llm = value.map((entry, index): RuntimeLlmConfig => {
    if (!isRecord(entry)) throw new Error(`llm[${index}] 必须是对象。`);
    const { id, enabled, provider, apiKey, baseUrl, model } = entry;
    if (typeof id !== "string" || !id.trim()) throw new Error(`llm[${index}].id 不能为空。`);
    if (typeof enabled !== "boolean") throw new Error(`llm[${index}].enabled 必须是布尔值。`);
    if (provider !== "openai-compatible") throw new Error(`llm[${index}].provider 不受支持：${String(provider)}`);
    if (typeof apiKey !== "string" || typeof baseUrl !== "string" || !baseUrl.trim() || typeof model !== "string" || !model.trim()) {
      throw new Error(`llm[${index}] 缺少 apiKey、baseUrl 或 model。`);
    }
    return { id: id.trim(), enabled, provider, apiKey, baseUrl: baseUrl.trim(), model: model.trim() };
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

function positiveIntegerValue(value: unknown, fallback: number): number {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0 ? numericValue : fallback;
}
