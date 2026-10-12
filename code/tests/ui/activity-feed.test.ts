import { describe, expect, it } from "vitest";
import { activityForTurn, visibleAnswer } from "../../web/src/activity-feed.js";
import type { UiEvent } from "../../web/src/api.js";

function event(seq: number, kind: string, payload: Record<string, unknown>, turnId = "turn-1"): UiEvent {
  return { seq, eventId: `event-${seq}`, kind, taskId: "task-1", turnId, createdAt: "2026-10-12 12:00:00.000", payload };
}

describe("activityForTurn", () => {
  it("folds stage and tool status, preserving each round", () => {
    const result = activityForTurn([
      event(1, "trace.recorded", { type: "context.build.started" }),
      event(2, "trace.recorded", { type: "context.build.completed" }),
      event(3, "trace.recorded", { type: "llm.called", round: 0 }),
      event(4, "trace.recorded", { type: "tool.called", tool: "system_info", toolCallId: "tool-1" }),
      event(5, "trace.recorded", { type: "tool.completed", tool: "system_info", toolCallId: "tool-1" }),
      event(6, "trace.recorded", { type: "llm.called", round: 1 }),
      event(7, "trace.recorded", { type: "artifact.created" }),
      event(8, "trace.recorded", { type: "artifact.created" })
    ], "turn-1");
    expect(result.items.map((item) => item.label)).toEqual(["整理上下文", "模型调用 · 第 1 轮", "system_info", "模型调用 · 第 2 轮", "生成工作产物"]);
    expect(result.items[2]).toMatchObject({ toolCallId: "tool-1", state: "completed" });
  });

  it("reconstructs streamed text by offset without duplicating replayed chunks", () => {
    const result = activityForTurn([
      event(1, "assistant.text.delta", { offset: 0, text: "你" }),
      event(1, "assistant.text.delta", { offset: 0, text: "你" }),
      event(2, "assistant.text.delta", { offset: 1, text: "好" }),
      event(3, "assistant.text.delta", { offset: 5, text: "丢失" }),
      event(4, "assistant.text.delta", { offset: 2, text: "别的 Turn" }, "turn-2")
    ], "turn-1");
    expect(result.text).toBe("你好");
    expect(visibleAnswer("<think>内部</think>\nFINAL\n你好")).toBe("FINAL\n你好");
  });

  it("uses source length when transport redaction changes a chunk's visible length", () => {
    const result = activityForTurn([
      event(1, "assistant.text.delta", { offset: 0, sourceLength: 12, text: "[REDACTED]" }),
      event(2, "assistant.text.delta", { offset: 12, sourceLength: 1, text: "。" })
    ], "turn-1");
    expect(result.text).toBe("[REDACTED]。");
  });
});
