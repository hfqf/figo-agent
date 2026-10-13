import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readPromptConfig, savePromptConfig } from "../../src/config/prompt-config.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

it("saves prompts without exposing or changing model credentials and detects stale edits", async () => {
  root = await mkdtemp(join(tmpdir(), "figo-prompts-"));
  const path = join(root, "figo-agent.config.json");
  await writeFile(path, JSON.stringify({ llm: [{ apiKey: "test-secret" }], tools: { allowed: ["read_file"] } }));
  const before = await readPromptConfig(root);
  expect(JSON.stringify(before)).not.toContain("test-secret");
  const saved = await savePromptConfig(root, { systemInstruction: "核对证据", userInstruction: "中文文档" }, before.version);
  expect(saved.version).not.toBe(before.version);
  expect((await readPromptConfig(root)).prompts.userInstruction).toBe("中文文档");
  const raw = JSON.parse(await readFile(path, "utf8")) as { llm: Array<{ apiKey: string }>; tools: { allowed: string[] } };
  expect(raw.llm[0].apiKey).toBe("test-secret");
  expect(raw.tools.allowed).toEqual(["read_file"]);
  expect(raw).not.toHaveProperty("prompts");
  expect(JSON.parse(await readFile(join(root, ".figo-agent", "prompts.json"), "utf8"))).toEqual(saved.prompts);
  await expect(savePromptConfig(root, { systemInstruction: "", userInstruction: "" }, before.version)).rejects.toThrow("配置已变化");
  await expect(savePromptConfig(root, { systemInstruction: 12, userInstruction: "" }, saved.version)).rejects.toThrow("无效");
});
