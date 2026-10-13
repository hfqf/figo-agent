import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { defaultRuntimeConfig, loadRuntimeConfig, runtimeConfigFileName } from "../config/runtime-config.js";

export async function ensureDesktopConfig(configRoot: string): Promise<string> {
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  const path = join(configRoot, runtimeConfigFileName);
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(defaultRuntimeConfig, null, 2) + "\n");
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await chmod(path, 0o600);
  await loadRuntimeConfig(configRoot);
  return path;
}
