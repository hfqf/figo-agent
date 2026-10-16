import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/runtime-config.js";
import { ensureDesktopConfig } from "../../src/desktop/user-data.js";
import { readDesktopModelSetup, saveDesktopModelSetup } from "../../src/desktop/model-setup.js";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("desktop model setup", () => {
  it("starts with no key and saves the active model without changing other settings", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-desktop-model-"));
    const path = await ensureDesktopConfig(root);
    const original = await loadRuntimeConfig(root);
    original.llm.push({ ...original.llm[0], id: "other-model", enabled: false, apiKey: "other-secret" });
    original.context.compaction.keepRecentTokens = 7000;
    await writeFile(path, JSON.stringify(original));
    expect(await readDesktopModelSetup(root)).toMatchObject({ configured: false, model: "MiniMax-M3" });
    await saveDesktopModelSetup(root, { baseUrl: "https://example.com/v1", model: "test-model", apiKey: "secret" });
    const config = await loadRuntimeConfig(root);
    expect(config.llm[0]).toMatchObject({ baseUrl: "https://example.com/v1", model: "test-model", apiKey: "secret" });
    expect(config.llm[1]).toMatchObject({ id: "other-model", enabled: false, apiKey: "other-secret" });
    expect(config.context.compaction.keepRecentTokens).toBe(7000);
    expect(await readDesktopModelSetup(root)).toMatchObject({ configured: true, model: "test-model" });
    expect(JSON.stringify(await readDesktopModelSetup(root))).not.toContain("secret");
    expect((await readFile(path, "utf8")).includes("secret")).toBe(true);
  });

  it("rejects invalid settings without changing the config", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-desktop-model-"));
    const path = await ensureDesktopConfig(root);
    const before = await readFile(path, "utf8");
    await expect(saveDesktopModelSetup(root, { baseUrl: "file:///tmp/model", model: "x", apiKey: "secret" })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
  });
});
