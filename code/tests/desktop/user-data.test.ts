import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDesktopConfig } from "../../src/desktop/user-data.js";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("desktop user data", () => {
  it("creates a single writable config with empty model keys", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-desktop-data-"));
    const configRoot = join(root, "data");
    const path = await ensureDesktopConfig(configRoot);
    const config = JSON.parse(await readFile(path, "utf8")) as { llm: Array<{ apiKey: string }> };
    expect(config.llm.every((model) => model.apiKey === "")).toBe(true);
    // Windows 不支持 POSIX 的用户组和其他用户权限位。
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o077).toBe(0);
    await writeFile(path, "{\"custom\":true}");
    expect(await ensureDesktopConfig(configRoot)).toBe(path);
    expect(await readFile(path, "utf8")).toBe("{\"custom\":true}");
  });

  it("rejects malformed existing config without replacing it", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-desktop-invalid-config-"));
    const configRoot = join(root, "data");
    const path = await ensureDesktopConfig(configRoot);
    await writeFile(path, "{broken");
    await expect(ensureDesktopConfig(configRoot)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{broken");
  });
});
