import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { OnboardingStore } from "../../src/ui/onboarding-store.js";
import { loadRuntimeConfig } from "../../src/config/runtime-config.js";

let root = "";
const stores: OnboardingStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("引导状态与运行配置", () => {
  it("两张图独立记录，重开同一本机数据库仍保留，素材版本改变才重新引导", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-onboarding-"));
    const first = await OnboardingStore.open(root);
    expect(first.seen("1")).toEqual([]);
    first.markSeen("workbench", "1"); first.markSeen("workbench", "1");
    expect(first.seen("1")).toEqual(["workbench"]);
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const inspection = new DatabaseSync(join(root, ".figo-agent/onboarding.db"), { readOnly: true });
    try {
      const rows = inspection.prepare("select seen_at from onboarding_views").all();
      expect(rows).toHaveLength(1);
      expect(rows[0].seen_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    } finally { inspection.close(); }
    first.close();
    const second = await OnboardingStore.open(root); stores.push(second);
    expect(second.seen("1")).toEqual(["workbench"]);
    second.markSeen("trace-inspector", "1");
    expect(second.seen("1").sort()).toEqual(["trace-inspector", "workbench"]);
    expect(second.seen("2")).toEqual([]);
  });

  it("统一 JSON 控制开关和素材版本，拒绝非法参数", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-onboarding-config-"));
    expect((await loadRuntimeConfig(root)).web.onboarding).toEqual({ enabled: true, revision: "1" });
    await writeFile(join(root, "figo-agent.config.json"), JSON.stringify({ web: { onboarding: { enabled: false, revision: "2" } } }));
    expect((await loadRuntimeConfig(root)).web.onboarding).toEqual({ enabled: false, revision: "2" });
    for (const onboarding of [{ enabled: "yes" }, { revision: "" }, { revision: "../bad" }, []]) {
      await writeFile(join(root, "figo-agent.config.json"), JSON.stringify({ web: { onboarding } }));
      await expect(loadRuntimeConfig(root)).rejects.toThrow(/onboarding/);
    }
  });
});
