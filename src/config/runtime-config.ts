import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtimeConfigFileName = "figo-agent.config.json";

export interface RuntimeLlmConfig {
  provider: "minimax";
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

export interface RuntimeConfig {
  version: 1;
  llm: RuntimeLlmConfig;
  context: RuntimeContextConfig;
  tools: RuntimeToolsConfig;
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
  version: 1,
  llm: {
    provider: "minimax",
    apiKey: "",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "MiniMax-M3"
  },
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
  }
};

export async function loadRuntimeConfig(workspaceRoot: string): Promise<RuntimeConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(workspaceRoot, runtimeConfigFileName), "utf8"));
  } catch {
    return cloneDefaultConfig();
  }

  if (!isRecord(parsed)) return cloneDefaultConfig();
  return mergeRuntimeConfig(parsed);
}

function mergeRuntimeConfig(value: Record<string, unknown>): RuntimeConfig {
  const llm = isRecord(value.llm) ? value.llm : {};
  const context = isRecord(value.context) ? value.context : {};
  const compaction = isRecord(context.compaction) ? context.compaction : {};
  const tools = isRecord(value.tools) ? value.tools : {};
  const maxTaskHistoryTurns = positiveIntegerValue(context.maxTaskHistoryTurns, defaultRuntimeConfig.context.maxTaskHistoryTurns);

  return {
    version: 1,
    llm: {
      provider: "minimax",
      apiKey: stringValue(llm.apiKey, defaultRuntimeConfig.llm.apiKey),
      baseUrl: stringValue(llm.baseUrl, defaultRuntimeConfig.llm.baseUrl),
      model: stringValue(llm.model, defaultRuntimeConfig.llm.model)
    },
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
    }
  };
}

function cloneDefaultConfig(): RuntimeConfig {
  return {
    version: 1,
    llm: { ...defaultRuntimeConfig.llm },
    context: {
      ...defaultRuntimeConfig.context,
      projectDocPaths: [...defaultRuntimeConfig.context.projectDocPaths],
      compaction: { ...defaultRuntimeConfig.context.compaction }
    },
    tools: {
      ...defaultRuntimeConfig.tools,
      allowed: [...defaultRuntimeConfig.tools.allowed]
    }
  };
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
