import { describe, expect, it } from "vitest";
import type { ContextPack } from "../../src/contracts/types.js";
import { buildInitialMessages, buildToolResultMessage } from "../../src/loop/llm-message-builder.js";

describe("LLM message builder", () => {
  it("includes ContextItem content instead of only summaries", () => {
    const messages = buildInitialMessages("命令执行完毕了吗", contextPack());
    const userMessage = messages.at(-1)?.content ?? "";

    expect(userMessage).toContain("用户输入：命令执行完毕了吗");
    expect(userMessage).toContain("task.turn:2");
    expect(userMessage).toContain("你自己查询当前电脑配置");
    expect(userMessage).toContain("上一轮模型输出了工具调用文本");
  });

  it("builds structured tool result messages with bounded output", () => {
    const message = buildToolResultMessage([
      {
        id: "call_1",
        name: "system_info",
        status: "completed",
        output: { platform: "darwin", cpuCount: 10 }
      }
    ]);

    expect(message.role).toBe("user");
    expect(message.content).toContain("\"type\":\"tool_results\"");
    expect(message.content).toContain("\"id\":\"call_1\"");
    expect(message.content).toContain("\"platform\":\"darwin\"");
  });
});

function contextPack(): ContextPack {
  return {
    id: "ctx_1",
    sessionId: "ses_1",
    taskId: "task_1",
    turnId: "turn_3",
    estimatedTokens: 10,
    createdAt: "2026-10-11T00:00:00.000Z",
    items: [
      {
        id: "ctx_item_1",
        sourceType: "turn",
        sourceRef: "turn.input",
        summary: "当前用户输入",
        content: "命令执行完毕了吗",
        estimatedTokens: 2,
        included: true,
        reason: "当前 Turn 的直接输入"
      },
      {
        id: "ctx_item_2",
        sourceType: "task_turn",
        sourceRef: "task.turn:2",
        summary: "当前 Task 历史 Turn 2",
        content: "你自己查询当前电脑配置\n上一轮模型输出了工具调用文本",
        estimatedTokens: 12,
        included: true,
        reason: "当前 Task 内最近 Turn 历史"
      }
    ]
  };
}
