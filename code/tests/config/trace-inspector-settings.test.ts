import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRuntimeConfig } from "../../src/config/runtime-config.js";
import { readTraceInspectorSettings } from "../../src/config/trace-inspector-settings.js";

it("检查器读取参数由统一 JSON 控制，旧配置使用兼容默认值", async () => {
  const root = await mkdtemp(join(tmpdir(), "figo-inspector-config-"));
  try {
    expect((await loadRuntimeConfig(root)).web).toHaveProperty("traceInspector.fieldPageChars", 32768);
    await writeFile(join(root, "figo-agent.config.json"), JSON.stringify({ web: { traceInspector: { fieldPreviewChars: 1024, detailCollectionLimit: 25 } } }));
    expect((await loadRuntimeConfig(root)).web).toHaveProperty("traceInspector.fieldPreviewChars", 1024);
    expect((await loadRuntimeConfig(root)).web).toHaveProperty("traceInspector.detailCollectionLimit", 25);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("拒绝非法或相互冲突的读取参数", () => {
  for (const value of [null, [], { fieldPageChars: 0 }, { fieldPageChars: 131073 }, { detailCollectionLimit: 1001 }, { maxFieldChars: 100 }]) {
    expect(() => readTraceInspectorSettings(value)).toThrow();
  }
});
