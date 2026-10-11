import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Tool } from "../contracts/types.js";
import { assertInsideWorkspace } from "../utils/path.js";

export interface WriteFileOutput {
  path: string;
  bytes: number;
}

export interface ApplyPatchOutput {
  changedFiles: string[];
}

export function createWriteTools(): Array<Tool<Record<string, unknown>, unknown>> {
  return [writeFileTool, applyPatchTool];
}

const writeFileTool: Tool<Record<string, unknown>, WriteFileOutput> = {
  name: "write_file",
  description: "写入工作区内文件",
  execute: async (input, context) => {
    const path = assertInsideWorkspace(context.workspaceRoot, String(input.path ?? ""));
    const content = String(input.content ?? "");
    if (input.createDirs === true) {
      await mkdir(dirname(join(context.workspaceRoot, path)), { recursive: true });
    }
    await writeFile(join(context.workspaceRoot, path), content, "utf8");
    return {
      status: "completed",
      output: { path, bytes: Buffer.byteLength(content, "utf8") }
    };
  }
};

const applyPatchTool: Tool<Record<string, unknown>, ApplyPatchOutput> = {
  name: "apply_patch",
  description: "应用结构化文本替换补丁",
  execute: async (input, context) => {
    const patches = parsePatches(input.patches);
    const changedFiles: string[] = [];

    for (const patch of patches) {
      const path = assertInsideWorkspace(context.workspaceRoot, patch.path);
      const absolutePath = join(context.workspaceRoot, path);
      const content = await readFile(absolutePath, "utf8");
      if (!content.includes(patch.oldText)) {
        return {
          status: "failed",
          errorCode: "patch_anchor_not_found",
          errorMessage: `补丁锚点不存在：${path}`
        };
      }
      await writeFile(absolutePath, content.replace(patch.oldText, patch.newText), "utf8");
      changedFiles.push(path);
    }

    return { status: "completed", output: { changedFiles } };
  }
};

function parsePatches(value: unknown): Array<{ path: string; oldText: string; newText: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = item as Record<string, unknown>;
    return {
      path: String(record.path ?? ""),
      oldText: String(record.oldText ?? ""),
      newText: String(record.newText ?? "")
    };
  });
}
