import type { PiCompactionSettings } from "../config/pi-compaction-settings.js";
import { shouldCompact } from "./pi-compaction.js";

export interface CompactionStats {
  contextTokens: number;
  contextWindow?: number;
}

export function evaluateCompactionPolicy(stats: CompactionStats, config: Pick<PiCompactionSettings, "enabled" | "reserveTokens">): { trigger: boolean; reason: string } {
  if (!config.enabled) return { trigger: false, reason: "disabled" };
  if (stats.contextWindow === undefined) return { trigger: false, reason: "model_context_unknown" };
  const trigger = shouldCompact(stats.contextTokens, stats.contextWindow, config);
  return { trigger, reason: trigger ? "threshold" : "below_threshold" };
}
