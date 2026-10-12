export interface RuntimeAgentBehavior {
  toolResultPreviewChars: number;
}

export interface RuntimeToolDefaults {
  commandTimeoutMs: number;
  commandMaxOutputBytes: number;
  networkTimeoutMs: number;
  networkMaxBytes: number;
  browserMaxBytes: number;
  gitTimeoutMs: number;
  gitMaxOutputBytes: number;
  gitLogCount: number;
  readManyMaxFiles: number;
  readManyMaxBytesPerFile: number;
  readManyMaxTotalBytes: number;
  workspaceSummaryMaxFiles: number;
  skillReadmeChars: number;
  skillMatchCount: number;
  skillMatchChars: number;
  skillFileCount: number;
  toolTraceMaxChars: number;
}

export interface RuntimeFileBrowserConfig {
  searchMinChars: number;
  searchMaxChars: number;
  maxVisitedDirectories: number;
  maxSearchResults: number;
  maxDirectoryEntries: number;
  maxPreviewBytes: number;
  maxReferenceLines: number;
  maxReferenceChars: number;
}

export interface RuntimeTerminalConfig {
  maxCommandChars: number;
  historyEntries: number;
  maxOutputBytes: number;
  timeoutMs: number;
}

export const defaultAgentBehavior: RuntimeAgentBehavior = {
  toolResultPreviewChars: 8000
};

export const defaultToolDefaults: RuntimeToolDefaults = {
  commandTimeoutMs: 30000, commandMaxOutputBytes: 65536,
  networkTimeoutMs: 30000, networkMaxBytes: 131072, browserMaxBytes: 262144,
  gitTimeoutMs: 30000, gitMaxOutputBytes: 131072, gitLogCount: 5,
  readManyMaxFiles: 20, readManyMaxBytesPerFile: 65536, readManyMaxTotalBytes: 262144,
  workspaceSummaryMaxFiles: 200,
  skillReadmeChars: 6000, skillMatchCount: 10, skillMatchChars: 160, skillFileCount: 80,
  toolTraceMaxChars: 16000
};

export const defaultFileBrowserConfig: RuntimeFileBrowserConfig = {
  searchMinChars: 2, searchMaxChars: 80, maxVisitedDirectories: 200, maxSearchResults: 100,
  maxDirectoryEntries: 500, maxPreviewBytes: 1048576, maxReferenceLines: 200, maxReferenceChars: 16000
};

export const defaultTerminalConfig: RuntimeTerminalConfig = {
  maxCommandChars: 4096, historyEntries: 30, maxOutputBytes: 131072, timeoutMs: 120000
};

export function readAgentBehavior(value: unknown): RuntimeAgentBehavior {
  const input = record(value, "agent");
  return {
    toolResultPreviewChars: integer(input.toolResultPreviewChars, defaultAgentBehavior.toolResultPreviewChars, 100, 100000, "agent.toolResultPreviewChars")
  };
}

export function readToolDefaults(value: unknown): RuntimeToolDefaults {
  const input = record(value, "tools.defaults");
  const result = {} as RuntimeToolDefaults;
  for (const key of Object.keys(defaultToolDefaults) as Array<keyof RuntimeToolDefaults>) {
    result[key] = integer(input[key], defaultToolDefaults[key], 1, 1048576, `tools.defaults.${key}`);
  }
  if (result.commandTimeoutMs > 120000 || result.networkTimeoutMs > 120000 || result.gitTimeoutMs > 120000) throw new Error("工具默认超时不能超过 120000 毫秒。");
  return result;
}

export function readFileBrowserConfig(value: unknown): RuntimeFileBrowserConfig {
  const input = record(value, "web.fileBrowser");
  const result = {} as RuntimeFileBrowserConfig;
  for (const key of Object.keys(defaultFileBrowserConfig) as Array<keyof RuntimeFileBrowserConfig>) {
    result[key] = integer(input[key], defaultFileBrowserConfig[key], 1, 1048576, `web.fileBrowser.${key}`);
  }
  if (result.searchMinChars > result.searchMaxChars || result.maxPreviewBytes > 1048576) throw new Error("文件区配置范围无效。");
  return result;
}

export function readTerminalConfig(value: unknown): RuntimeTerminalConfig {
  const input = record(value, "web.terminal");
  const result = {} as RuntimeTerminalConfig;
  for (const key of Object.keys(defaultTerminalConfig) as Array<keyof RuntimeTerminalConfig>) {
    result[key] = integer(input[key], defaultTerminalConfig[key], 1, 1048576, `web.terminal.${key}`);
  }
  if (result.timeoutMs > 300000) throw new Error("终端超时不能超过 300000 毫秒。");
  return result;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error(`${name} 必须是 JSON 对象。`);
}

function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}-${max} 的整数。`);
  return value;
}
