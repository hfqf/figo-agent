import { describe, expect, it } from "vitest";
import type { LLMMessage, LLMProvider } from "../../src/contracts/types.js";
import { compactPriorRounds } from "../../src/context/round-compaction.js";

describe("compactPriorRounds", () => {
  it("preserves the entire latest native tool batch", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "system" }, { role: "user", content: "current" },
      { role: "assistant", content: "", toolCalls: [{ id: "old", name: "list_files", input: {} }] },
      { role: "tool", toolCallId: "old", content: "old result" },
      { role: "assistant", content: "", toolCalls: [
        { id: "latest_1", name: "read_file", input: { path: "README.md" } },
        { id: "latest_2", name: "read_file", input: { path: "package.json" } }
      ] },
      { role: "tool", toolCallId: "latest_1", content: "latest README" },
      { role: "tool", toolCallId: "latest_2", content: "latest package" }
    ];
    const llm: LLMProvider = { complete: async (request) => ({ id: "res", requestId: request.id,
      model: request.model, finishReason: "stop", outputLength: 20, durationMs: 1, content: '{"summary":"旧工具结果"}' }) };
    const compacted = await compactPriorRounds(llm, { sessionId: "ses", taskId: "task", turnId: "turn",
      model: "gpt", goal: "分析项目", messages, maxSummaryChars: 100 });
    expect(compacted.slice(-3)).toEqual(messages.slice(-3));
    expect(compacted[2].content).toContain("旧工具结果");
  });
  it("accepts a round summary after a complete thinking block", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "system" }, { role: "user", content: "current" },
      { role: "assistant", content: "old call" }, { role: "user", content: "old result" },
      { role: "assistant", content: "latest call" }, { role: "user", content: "latest result" }
    ];
    const llm: LLMProvider = { complete: async (request) => ({ id: "res", requestId: request.id, model: request.model, finishReason: "stop", outputLength: 50, durationMs: 1, content: '<think>梳理旧工具结果。</think>\n{"summary":"旧结果已完成"}' }) };
    const compacted = await compactPriorRounds(llm, { sessionId: "ses", taskId: "task", turnId: "turn", model: "M3", goal: "分析当前项目", messages, maxSummaryChars: 100 });
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
    await expect(compactPriorRounds(llm, { sessionId: "ses", taskId: "task", turnId: "turn", model: "M3", goal: "分析当前项目", messages, maxSummaryChars: 100 })).rejects.toThrow();
    expect(JSON.stringify(messages)).toBe(original);
  });

  it("includes the original goal in the summary request while retaining recent messages", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "system" }, { role: "user", content: "用户输入：分析当前项目" },
      { role: "assistant", content: "old call" }, { role: "user", content: "old result" },
      { role: "assistant", content: "latest call" }, { role: "user", content: "latest result" }
    ];
    let requestGoal = "";
    const llm: LLMProvider = { complete: async (request) => {
      requestGoal = (JSON.parse(request.messages[1].content) as { goal: string }).goal;
      return { id: "res", requestId: request.id, model: request.model, finishReason: "stop", outputLength: 20, durationMs: 1, content: '{"summary":"旧结果已核实"}' };
    } };
    await compactPriorRounds(llm, { sessionId: "ses", taskId: "task", turnId: "turn", model: "M3", goal: "分析当前项目", messages, maxSummaryChars: 100 });
    expect(requestGoal).toBe("分析当前项目");
  });
});
