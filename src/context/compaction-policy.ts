import type { RuntimeCompactionConfig } from "../config/runtime-config.js";

export interface CompactionStats {
  turnCount: number;
  charCount: number;
}

export function evaluateCompactionPolicy(stats: CompactionStats, config: RuntimeCompactionConfig): { trigger: boolean; reason: string } {
  if (!config.autoEnabled) return { trigger: false, reason: "automatic compaction disabled" };
  if (stats.turnCount >= config.turnThreshold) return { trigger: true, reason: "turn threshold reached" };
  if (stats.charCount >= config.charThreshold) return { trigger: true, reason: "character threshold reached" };
  return { trigger: false, reason: "below compaction thresholds" };
}
