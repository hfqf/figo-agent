import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultRuntimeConfig } from "../../src/config/runtime-config.js";
import { WorkspaceRegistry } from "../../src/ui/workspace-registry.js";
import { ensureDesktopConfig } from "../../src/desktop/user-data.js";
import { importDesktopData } from "../../src/desktop/import-data.js";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("desktop import", () => {
  it("backs up config, imports prompts and merges recent workspaces", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-desktop-import-"));
    const source = join(root, "source");
    const target = join(root, "target");
    await mkdir(join(source, ".figo-agent"), { recursive: true });
    await ensureDesktopConfig(target);
    const sourceFile = join(source, "figo-agent.config.json");
    const config = { ...defaultRuntimeConfig, llm: [{ ...defaultRuntimeConfig.llm[0], apiKey: "test-secret" }] };
    await writeFile(sourceFile, JSON.stringify(config));
    await writeFile(join(source, ".figo-agent", "prompts.json"), JSON.stringify({ systemInstruction: "事实优先", userInstruction: "中文" }));
    const oldRegistry = await WorkspaceRegistry.open(source);
    oldRegistry.record(root);
    oldRegistry.close();

    const backup = await importDesktopData(sourceFile, target);
    expect(JSON.parse(await readFile(join(target, "figo-agent.config.json"), "utf8")).llm[0].apiKey).toBe("test-secret");
    expect(await readFile(backup, "utf8")).not.toContain("test-secret");
    expect(JSON.parse(await readFile(join(target, ".figo-agent", "prompts.json"), "utf8")).systemInstruction).toBe("事实优先");
    const registry = await WorkspaceRegistry.open(target);
    expect(registry.recent()).toContain(root);
    registry.close();
    await importDesktopData(sourceFile, target);
    const reopened = await WorkspaceRegistry.open(target);
    expect(reopened.recent().filter((path) => path === root)).toHaveLength(1);
    reopened.close();
  });

  it("leaves existing config unchanged when the imported file is invalid", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-desktop-invalid-"));
    const source = join(root, "source");
    const target = join(root, "target");
    await mkdir(source);
    const targetFile = await ensureDesktopConfig(target);
    const original = await readFile(targetFile, "utf8");
    const sourceFile = join(source, "figo-agent.config.json");
    await writeFile(sourceFile, "{bad");
    await expect(importDesktopData(sourceFile, target)).rejects.toThrow();
    expect(await readFile(targetFile, "utf8")).toBe(original);
    expect((await readdir(target)).filter((name) => name.includes("backup"))).toHaveLength(0);
  });

  it("rejects invalid imported prompts before changing desktop config", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-desktop-invalid-prompts-"));
    const source = join(root, "source");
    const target = join(root, "target");
    await mkdir(join(source, ".figo-agent"), { recursive: true });
    const targetFile = await ensureDesktopConfig(target);
    const original = await readFile(targetFile, "utf8");
    const sourceFile = join(source, "figo-agent.config.json");
    await writeFile(sourceFile, JSON.stringify(defaultRuntimeConfig));
    await writeFile(join(source, ".figo-agent", "prompts.json"), JSON.stringify({ systemInstruction: 1, userInstruction: "" }));
    await expect(importDesktopData(sourceFile, target)).rejects.toThrow();
    expect(await readFile(targetFile, "utf8")).toBe(original);
  });
});
