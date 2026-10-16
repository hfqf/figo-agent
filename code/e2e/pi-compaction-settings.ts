import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePiCompactionSettings } from "../src/config/pi-compaction-settings.js";
import type { RuntimeConfig } from "../src/config/runtime-config.js";

export type AcceptanceScenario = "off" | "auto-test-window" | "manual" | "stress-test-window";
export interface PiAcceptanceSettings {
  timeoutMs: number;
  pairRepetitions: number;
  testContextWindow: number;
  stressContextWindow: number;
  sourceSnapshotMinChars: number;
  sourceChunkMaxChars: number;
  scenarios: AcceptanceScenario[];
}

export async function readPiAcceptanceSettings(configRoot: string, config: RuntimeConfig, timeoutMs?: number): Promise<PiAcceptanceSettings> {
  const raw = JSON.parse(await readFile(join(configRoot, "figo-agent.config.json"), "utf8"));
  const input = raw?.acceptance?.piCompaction;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("缺少 acceptance.piCompaction 验收配置。");
  const number = (key: string): number => {
    const value = key === "timeoutMs" && timeoutMs !== undefined ? timeoutMs : input[key];
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`acceptance.piCompaction.${key} 必须是正安全整数。`);
    return value;
  };
  const allowed = ["off", "auto-test-window", "manual", "stress-test-window"];
  if (!Array.isArray(input.scenarios) || input.scenarios.length === 0 ||
    input.scenarios.some((value: unknown) => typeof value !== "string" || !allowed.includes(value)) ||
    new Set(input.scenarios).size !== input.scenarios.length) throw new Error("验收 scenarios 必须是不重复的有效场景列表。");
  const settings: PiAcceptanceSettings = {
    timeoutMs: number("timeoutMs"), pairRepetitions: number("pairRepetitions"), testContextWindow: number("testContextWindow"),
    stressContextWindow: number("stressContextWindow"), sourceSnapshotMinChars: number("sourceSnapshotMinChars"),
    sourceChunkMaxChars: number("sourceChunkMaxChars"), scenarios: [...input.scenarios]
  };
  if (settings.scenarios.includes("auto-test-window")) {
    for (const model of config.llm.filter((entry) => entry.enabled)) {
      const policy = resolvePiCompactionSettings(config.context.compaction, model.id, model.model);
      if (settings.testContextWindow <= policy.reserveTokens + policy.keepRecentTokens) {
        throw new Error(`${model.id} 正常测试窗口必须大于 reserveTokens + keepRecentTokens；极小窗口只用于 stress-test-window。`);
      }
    }
  }
  return settings;
}
