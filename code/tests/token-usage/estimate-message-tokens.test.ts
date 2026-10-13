import { describe, expect, it } from "vitest";
import { estimateMessageTokens } from "../../src/token-usage/estimate-message-tokens.js";

describe("estimateMessageTokens", () => {
  it("accounts for native tool definitions and assistant tool-call arguments", () => {
    const base = [{ role: "user" as const, content: "分析项目" }];
    const withCalls = [...base, { role: "assistant" as const, content: "",
      toolCalls: [{ id: "call_1", name: "read_file", input: { path: "README.md" } }] }];
    const tool = { name: "read_file", description: "读取工作区文件",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
    expect(estimateMessageTokens(withCalls, [tool])).toBeGreaterThan(estimateMessageTokens(base));
    expect(estimateMessageTokens(withCalls, [tool])).toBeGreaterThan(estimateMessageTokens(withCalls));
  });
});
