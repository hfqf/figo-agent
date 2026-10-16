import { describe, expect, it } from "vitest";
import { estimateConversation, prepareConversationCompaction, toPiMessage } from "../../src/context/compaction-preparation.js";
import type { ConversationMessage } from "../../src/context/conversation-message.js";
import { conversationUsageScope, wireToolDefinitions } from "../../src/context/conversation-message.js";

const entry = (id: string, role: "user" | "assistant" | "tool", content: string): ConversationMessage => ({ sourceRef: id, turnId: "t", message: { role, content } });

describe("Pi 宿主消息准备", () => {
  it.each([[74996, "a1"], [75000, "u2"], [75004, "u2"]])("默认近期 20000 token 的实际边界：新用户正文 %i 字符", (chars, first) => {
    const messages = [entry("u1", "user", "goal"), entry("a1", "assistant", "x"), entry("u2", "user", "y".repeat(Number(chars))), entry("a2", "assistant", "z".repeat(5000))];
    const original = structuredClone(messages);
    const prepared = prepareConversationCompaction(messages, 20000, "scope");
    expect(prepared?.firstKeptSourceRef).toBe(first);
    expect(prepared?.retained).toEqual(messages.slice(messages.findIndex((entry) => entry.sourceRef === first)));
    expect(messages).toEqual(original);
  });
  it("fallback 包含原生工具定义；定义变化使旧 usage 失效", () => {
    const tools = [{ name: "read", description: "inspect", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
    const scope = conversationUsageScope("p", "m", "system", tools);
    const previousScope = conversationUsageScope("p", "m", "system", []);
    const messages = [{ ...entry("a", "assistant", "xxxx"), usage: { input: 90, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 100 }, usageScope: previousScope }];
    expect(estimateConversation(messages, scope, "system", undefined, tools)).toMatchObject({ source: "estimate", tokens: 1 + Math.ceil((6 + JSON.stringify(wireToolDefinitions(tools)).length) / 4) });
    expect(estimateConversation(messages, previousScope, "system", undefined, []).tokens).toBe(100);
  });
  it("原生和文本工具结果都不是用户交互起点", () => {
    expect(toPiMessage(entry("tool:a", "tool", "result")).role).toBe("toolResult");
    expect(toPiMessage(entry("tool:b", "user", '{"type":"tool_results","results":[]}')).role).toBe("toolResult");
    expect(toPiMessage(entry("turn:t:user", "user", "真实问题")).role).toBe("user");
  });
  it("使用有效 usage 加新增消息，不使用跨模型或过期系统指令的 usage", () => {
    const messages = [entry("u", "user", "a".repeat(400)), { ...entry("a", "assistant", "answer"), usage: { input: 90, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 100 }, usageScope: "scope" }, entry("r", "tool", "b".repeat(40))];
    expect(estimateConversation(messages, "scope").tokens).toBe(110);
    expect(estimateConversation(messages, "new-scope").tokens).toBe(112);
  });
  it("长单次交互按安全切点分割，保留原生工具调用及其结果", () => {
    const messages = [entry("u", "user", "goal"), entry("a1", "assistant", "a".repeat(400)), entry("r1", "tool", "r".repeat(400)), { ...entry("a2", "assistant", ""), message: { role: "assistant" as const, content: "", toolCalls: [{ id: "c", name: "read_file", input: { path: "x" } }] } }, { ...entry("r2", "tool", "tail"), message: { role: "tool" as const, toolCallId: "c", content: "tail" } }];
    const result = prepareConversationCompaction(messages, 5, "scope");
    expect(result?.isSplitTurn).toBe(true);
    expect(result?.firstKeptSourceRef).toBe("a2");
    expect(result?.turnPrefix.map((x) => x.sourceRef)).toEqual(["u", "a1", "r1"]);
    expect(result?.retained.map((x) => x.sourceRef)).toEqual(["a2", "r2"]);
  });
  it("无可摘要前缀不产生伪检查点", () => {
    expect(prepareConversationCompaction([entry("u", "user", "single")], 20000, "scope")).toBeUndefined();
  });
  it("恢复省略后缀允许把巨大用户前缀总结成摘要，保留边界仍指向原始失败响应", () => {
    const failed = { ...entry("request:failed:response", "assistant", ""), stopReason: "error" as const };
    const result = prepareConversationCompaction([entry("user", "user", "x".repeat(400))], 10, "scope", undefined, "", [failed]);
    expect(result?.firstKeptSourceRef).toBe("request:failed:response");
    expect(result?.turnPrefix.map((entry) => entry.sourceRef)).toEqual(["user"]);
    expect(result?.retained).toEqual([]);
  });
  it("滚动更新只总结旧摘要之后新增的前缀", () => {
    const messages = [entry("u1", "user", "a".repeat(400)), entry("a1", "assistant", "old"), entry("u2", "user", "tail")];
    const result = prepareConversationCompaction(messages, 1, "scope", "previous");
    expect(result?.previousSummary).toBe("previous");
    expect(result?.history.map((x) => x.sourceRef)).toEqual(["u1", "a1"]);
    expect(result?.retained[0].sourceRef).toBe("u2");
  });
});
