import type { TokenUsageSummary } from "./token-usage-store.js";

export function formatTokenUsageSummary(summary: TokenUsageSummary): string[] {
  return [
    `LLM 请求：${summary.requestCount}（完整 ${summary.completeCount}，部分 ${summary.partialCount}，未提供 ${summary.unavailableCount}）`,
    `实际输入 Token：${reported(summary.knownPromptTokens, summary.promptReportedCount)}`,
    `实际输出 Token：${reported(summary.knownCompletionTokens, summary.completionReportedCount)}`,
    `实际总量 Token：${reported(summary.knownTotalTokens, summary.totalReportedCount)}`,
    "实际值仅汇总 Provider 已提供的字段；缺失请求不计为 0。"
  ];
}

function reported(value: number, count: number): string {
  return count === 0 ? "未提供" : `${value}（${count} 次请求）`;
}
