import { describe, expect, it } from "vitest";
import type { LLMMessage, LLMProvider } from "../../src/contracts/types.js";
import { compactPriorRounds } from "../../src/context/round-compaction.js";

describe("compactPriorRounds", () => {
  it("accepts a round summary after a complete thinking block", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "system" }, { role: "user", content: "current" },
      { role: "assistant", content: "old call" }, { role: "user", content: "old result" },
      { role: "assistant", content: "latest call" }, { role: "user", content: "latest result" }
    ];
    const llm: LLMProvider = { complete: async (request) => ({ id: "res", requestId: request.id, model: request.model, finishReason: "stop", outputLength: 50, durationMs: 1, content: '<think>梳理旧工具结果。</think>\n{"summary":"旧结果已完成"}' }) };
    const compacted = await compactPriorRounds(llm, { sessionId: "ses", taskId: "task", turnId: "turn", model: "M3", messages, maxSummaryChars: 100 });
    expect(compacted[2].content).toContain("旧结果已完成");
    expect(compacted.at(-1)?.content).toBe("latest result");
  });
  it("rejects an invalid summary without modifying the original in-flight messages", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "system" }, { role: "user", content: "current" },
      { role: "assistant", content: "old tool call" }, { role: "user", content: "old result" },
      { role: "assistant", content: "latest tool call" }, { role: "user", content: "latest result" }
    ];
    const original = JSON.stringify(messages);
    const llm: LLMProvider = { complete: async (request) => ({ id: "res", requestId: request.id, model: request.model, finishReason: "stop", outputLength: 3, durationMs: 1, content: "bad" }) };
    await expect(compactPriorRounds(llm, { sessionId: "ses", taskId: "task", turnId: "turn", model: "M3", messages, maxSummaryChars: 100 })).rejects.toThrow();
    expect(JSON.stringify(messages)).toBe(original);
  });
});
