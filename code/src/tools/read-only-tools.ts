import { readdir, readFile, stat } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "../contracts/types.js";
import { assertInsideWorkspace } from "../utils/path.js";
import { defaultToolDefaults, type RuntimeToolDefaults } from "../config/runtime-behavior.js";
import { zhCN } from "../i18n/catalog.js";

const excludedDirs = new Set([".git", "node_modules", ".figo-agent", "dist", "build", "coverage"]);

export interface ListFilesOutput {
  files: string[];
}

export interface ReadFileOutput {
  path: string;
  content: string;
}

export interface SearchTextOutput {
  matches: Array<{ path: string; line: number; text: string }>;
}

export interface SystemInfoOutput {
  platform: NodeJS.Platform;
  release: string;
  arch: string;
  cpuCount: number;
  totalMemoryBytes: number;
  nodeVersion: string;
  workspaceRoot: string;
  shell?: string;
}

export interface PathStatOutput {
  path: string;
  kind: "file" | "directory" | "other" | "missing";
  sizeBytes: number;
  modifiedAt?: string;
}

export interface ReadManyFilesOutput {
  files: Array<{ path: string; content: string; sizeBytes: number; truncated: boolean }>;
  errors: Array<{ path: string; code: string; message: string }>;
}

export interface WorkspaceSummaryOutput {
  root: string;
  files: string[];
  packageJson?: { name?: string; version?: string; scripts?: Record<string, string> };
}

export function createReadOnlyTools(defaults: RuntimeToolDefaults = defaultToolDefaults): Array<Tool<Record<string, unknown>, unknown>> {
  return [
    listFilesTool,
    readFileTool,
    searchTextTool,
    systemInfoTool,
    pathStatTool,
    { ...readManyFilesTool, execute: (input, context) => readManyFilesTool.execute({
      maxFiles: defaults.readManyMaxFiles, maxBytesPerFile: defaults.readManyMaxBytesPerFile,
      maxTotalBytes: defaults.readManyMaxTotalBytes, ...input
    }, context) },
    { ...workspaceSummaryTool, execute: (input, context) => workspaceSummaryTool.execute({
      maxFiles: defaults.workspaceSummaryMaxFiles, ...input
    }, context) }
  ];
}

const listFilesTool: Tool<Record<string, unknown>, ListFilesOutput> = {
  name: "list_files",
  description: "递归列出工作区文件；path 指定起点，depth=0 仅当前目录，省略 depth 则递归全部子目录",
  execute: async (input, context) => {
    const startPath = assertInsideWorkspace(context.workspaceRoot, String(input.path ?? "."));
    const depth = input.depth;
    if (depth !== undefined && (!Number.isSafeInteger(depth) || (depth as number) < 0 || (depth as number) > 100)) {
      throw new Error("depth 必须是 0-100 的整数。");
    }
    const files = await listFiles(context.workspaceRoot, startPath, depth as number | undefined);
    return { status: "completed", output: { files } };
  }
};

const readFileTool: Tool<Record<string, unknown>, ReadFileOutput> = {
  name: "read_file",
  description: "读取工作区内文本文件",
  inputSchema: {
    type: "object", properties: { path: { type: "string", minLength: 1 } }, required: ["path"], additionalProperties: false
  },
  execute: async (input, context) => {
    if (typeof input.path !== "string" || !input.path.trim()) {
      return { status: "failed", errorCode: "invalid_input", errorMessage: zhCN.tools.readFilePathRequired };
    }
    const path = assertInsideWorkspace(context.workspaceRoot, input.path);
    const content = await readFile(join(context.workspaceRoot, path), "utf8");
    return { status: "completed", output: { path, content } };
  }
};

const searchTextTool: Tool<Record<string, unknown>, SearchTextOutput> = {
  name: "search_text",
  description: "搜索工作区文本内容",
  execute: async (input, context) => {
    const query = String(input.query ?? "");
    const startPath = assertInsideWorkspace(context.workspaceRoot, String(input.path ?? "."));
    const files = await listFiles(context.workspaceRoot, startPath);
    const matches: SearchTextOutput["matches"] = [];

    for (const file of files) {
      const content = await readTextIfReadable(context, file);
      if (content === undefined) continue;
      const lines = content.split(/\r?\n/);
      lines.forEach((lineText, index) => {
        if (lineText.includes(query)) {
          matches.push({ path: file, line: index + 1, text: lineText });
        }
      });
    }

    return { status: "completed", output: { matches } };
  }
};

const systemInfoTool: Tool<Record<string, unknown>, SystemInfoOutput> = {
  name: "system_info",
  description: "读取本机运行环境摘要，不返回环境变量",
  execute: async (_input, context) => ({
    status: "completed",
    output: {
      platform: platform(),
      release: release(),
      arch: process.arch,
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      nodeVersion: process.version,
      workspaceRoot: context.workspaceRoot,
      shell: process.env.SHELL ? process.env.SHELL.split("/").at(-1) : undefined
    }
  })
};

const pathStatTool: Tool<Record<string, unknown>, PathStatOutput> = {
  name: "path_stat",
  description: "检查工作区内路径状态",
  execute: async (input, context) => {
    const path = assertInsideWorkspace(context.workspaceRoot, String(input.path ?? "."));
    try {
      const currentStat = await stat(join(context.workspaceRoot, path));
      return {
        status: "completed",
        output: {
          path,
          kind: currentStat.isFile() ? "file" : currentStat.isDirectory() ? "directory" : "other",
          sizeBytes: currentStat.size,
          modifiedAt: currentStat.mtime.toISOString()
        }
      };
    } catch {
      return { status: "completed", output: { path, kind: "missing", sizeBytes: 0 } };
    }
  }
};

const readManyFilesTool: Tool<Record<string, unknown>, ReadManyFilesOutput> = {
  name: "read_many_files",
  description: "批量读取工作区内文本文件；逐文件返回 files 成功结果和 errors 失败结果",
  execute: async (input, context) => {
    const paths = Array.isArray(input.paths) ? input.paths.map(String) : [];
    const maxFiles = toPositiveInteger(input.maxFiles, 20);
    const maxBytesPerFile = toPositiveInteger(input.maxBytesPerFile, 64 * 1024);
    const maxTotalBytes = toPositiveInteger(input.maxTotalBytes, 256 * 1024);
    const files: ReadManyFilesOutput["files"] = [];
    const errors: ReadManyFilesOutput["errors"] = [];
    let totalBytes = 0;
    const safePaths = paths.slice(0, maxFiles).map((path) => assertInsideWorkspace(context.workspaceRoot, path));

    for (const path of safePaths) {
      context.signal?.throwIfAborted();
      if (totalBytes >= maxTotalBytes) break;
      let content: string;
      try {
        content = await readFile(join(context.workspaceRoot, path), "utf8");
      } catch (error) {
        if (context.signal?.aborted) throw error;
        const code = (error as NodeJS.ErrnoException).code ?? "READ_FAILED";
        const message = code === "ENOENT" ? "文件不存在" : code === "EISDIR" ? "路径是目录"
          : code === "EACCES" || code === "EPERM" ? "没有读取权限" : "读取失败";
        errors.push({ path, code, message });
        continue;
      }
      const contentBytes = Buffer.byteLength(content, "utf8");
      const remainingBytes = Math.max(0, maxTotalBytes - totalBytes);
      const byteLimit = Math.min(maxBytesPerFile, remainingBytes);
      const truncated = contentBytes > byteLimit;
      files.push({
        path,
        content: truncateUtf8(content, byteLimit),
        sizeBytes: contentBytes,
        truncated
      });
      totalBytes += Math.min(contentBytes, byteLimit);
    }

    return { status: "completed", output: { files, errors } };
  }
};

const workspaceSummaryTool: Tool<Record<string, unknown>, WorkspaceSummaryOutput> = {
  name: "workspace_summary",
  description: "生成工作区文件与 package.json 摘要",
  execute: async (input, context) => {
    const files = await listFiles(context.workspaceRoot, ".");
    const output: WorkspaceSummaryOutput = {
      root: context.workspaceRoot,
      files: files.slice(0, toPositiveInteger(input.maxFiles, 200))
    };
    const packageJsonContent = await readTextIfReadable(context, "package.json");
    if (packageJsonContent) {
      const packageJson = JSON.parse(packageJsonContent) as {
        name?: string;
        version?: string;
        scripts?: Record<string, string>;
      };
      output.packageJson = {
        name: packageJson.name,
        version: packageJson.version,
        scripts: packageJson.scripts
      };
    }
    return { status: "completed", output };
  }
};

async function listFiles(workspaceRoot: string, startPath: string, maxDepth = Number.POSITIVE_INFINITY): Promise<string[]> {
  const results: string[] = [];
  await walk(workspaceRoot, startPath === "." ? "" : startPath, results, maxDepth, 0);
  return results.sort();
}

async function walk(workspaceRoot: string, relativePath: string, results: string[], maxDepth: number, depth: number): Promise<void> {
  const absolutePath = join(workspaceRoot, relativePath);
  const currentStat = await stat(absolutePath);
  if (currentStat.isFile()) {
    results.push(relativePath);
    return;
  }

  const entries = await readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirs.has(entry.name)) continue;
    const nextPath = relativePath ? join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (depth < maxDepth) await walk(workspaceRoot, nextPath, results, maxDepth, depth + 1);
    } else if (entry.isFile()) {
      results.push(nextPath);
    }
  }
}

async function readTextIfReadable(
  context: ToolExecutionContext,
  path: string
): Promise<string | undefined> {
  try {
    return await readFile(join(context.workspaceRoot, path), "utf8");
  } catch {
    return undefined;
  }
}

function toPositiveInteger(value: unknown, fallback: number): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? Math.floor(numericValue) : fallback;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString("utf8");
}

export type ReadOnlyToolResult = ToolResult<
  ListFilesOutput | ReadFileOutput | SearchTextOutput | SystemInfoOutput | PathStatOutput | ReadManyFilesOutput
>;
