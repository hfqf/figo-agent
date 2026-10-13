import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readPromptConfig } from "../config/prompt-config.js";
import { loadRuntimeConfig, runtimeConfigFileName } from "../config/runtime-config.js";
import { WorkspaceRegistry } from "../ui/workspace-registry.js";

async function readIfExists(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.figo-import-${randomUUID()}`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function importDesktopData(sourceFile: string, targetRoot: string): Promise<string> {
  if (!isAbsolute(sourceFile) || basename(sourceFile) !== runtimeConfigFileName) {
    throw new Error("请选择原项目的 figo-agent.config.json。");
  }
  const targetFile = join(targetRoot, runtimeConfigFileName);
  if (resolve(sourceFile) === resolve(targetFile)) throw new Error("不能导入当前配置文件。");
  const sourceRoot = dirname(sourceFile);
  const sourceContent = await readFile(sourceFile, "utf8");
  await loadRuntimeConfig(sourceRoot);
  const prompts = (await readPromptConfig(sourceRoot)).prompts;
  const promptContent = `${JSON.stringify(prompts, null, 2)}\n`;
  const sourceRegistryPath = join(sourceRoot, ".figo-agent", "workspaces.db");
  const recent = await stat(sourceRegistryPath).then(async () => {
    const registry = await WorkspaceRegistry.open(sourceRoot);
    try { return registry.recent(); }
    finally { registry.close(); }
  }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });

  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await mkdir(join(targetRoot, ".figo-agent"), { recursive: true, mode: 0o700 });
  const targetPrompt = join(targetRoot, ".figo-agent", "prompts.json");
  const originalConfig = await readIfExists(targetFile);
  const originalPrompt = await readIfExists(targetPrompt);
  const backup = `${targetFile}.backup-${Date.now()}-${randomUUID()}`;
  if (originalConfig !== undefined) await writeFile(backup, originalConfig, { flag: "wx", mode: 0o600 });
  if (originalPrompt !== undefined) await writeFile(`${targetPrompt}.backup-${Date.now()}-${randomUUID()}`, originalPrompt, { flag: "wx", mode: 0o600 });
  try {
    await atomicWrite(targetFile, sourceContent);
    await atomicWrite(targetPrompt, promptContent);
    if (recent.length) {
      const registry = await WorkspaceRegistry.open(targetRoot);
      try { for (const path of recent.reverse()) registry.record(path); }
      finally { registry.close(); }
    }
  } catch (error) {
    if (originalConfig !== undefined) await atomicWrite(targetFile, originalConfig);
    else await rm(targetFile, { force: true });
    if (originalPrompt !== undefined) await atomicWrite(targetPrompt, originalPrompt);
    else await rm(targetPrompt, { force: true });
    throw error;
  }
  return backup;
}
