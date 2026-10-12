import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeConfigFileName } from "./runtime-config.js";

export interface PromptConfig {
  systemInstruction: string;
  userInstruction: string;
}

export interface VersionedPrompts {
  prompts: PromptConfig;
  version: string;
}

export const defaultPromptConfig: PromptConfig = { systemInstruction: "", userInstruction: "" };
const promptDataPath = (configRoot: string) => join(configRoot, ".figo-agent", "prompts.json");

export function validatePromptConfig(value: unknown): PromptConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("提示词配置无效。");
  const prompts = value as Record<string, unknown>;
  for (const key of ["systemInstruction", "userInstruction"]) {
    if (typeof prompts[key] !== "string" || (prompts[key] as string).length > 16000 || (prompts[key] as string).includes("\0")) {
      throw new Error(`${key} 无效或过长。`);
    }
  }
  return { systemInstruction: prompts.systemInstruction as string, userInstruction: prompts.userInstruction as string };
}

export async function readPromptConfig(configRoot: string): Promise<VersionedPrompts> {
  const prompts = await readStoredPrompts(configRoot);
  return { prompts, version: fingerprint(prompts) };
}

export async function savePromptConfig(configRoot: string, value: unknown, expectedVersion: string): Promise<VersionedPrompts> {
  const prompts = validatePromptConfig(value);
  const current = await readStoredPrompts(configRoot);
  if (fingerprint(current) !== expectedVersion) throw new Error("提示词配置已变化，请刷新后重试。");
  const path = promptDataPath(configRoot);
  await mkdir(join(configRoot, ".figo-agent"), { recursive: true, mode: 0o700 });
  const temporary = join(configRoot, ".figo-agent", `.prompts-${randomUUID()}.json`);
  const mode = await stat(path).then((entry) => entry.mode & 0o777).catch(() => 0o600);
  try {
    await writeFile(temporary, `${JSON.stringify(prompts, null, 2)}\n`, { mode, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { prompts, version: fingerprint(prompts) };
}

function fingerprint(prompts: PromptConfig): string {
  return createHash("sha256").update(JSON.stringify(prompts)).digest("hex");
}

async function readStoredPrompts(configRoot: string): Promise<PromptConfig> {
  try { return validatePromptConfig(JSON.parse(await readFile(promptDataPath(configRoot), "utf8")) as unknown); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config = await readConfig(configRoot);
  return config.prompts === undefined ? { ...defaultPromptConfig } : validatePromptConfig(config.prompts);
}

async function readConfig(configRoot: string): Promise<Record<string, unknown>> {
  let content: string;
  try { content = await readFile(join(configRoot, runtimeConfigFileName), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("运行配置必须是 JSON 对象。");
  return value as Record<string, unknown>;
}
