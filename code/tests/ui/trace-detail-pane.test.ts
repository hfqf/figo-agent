import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCall, TraceEvent } from "../../web/src/api.js";
import { TraceDetailPane } from "../../web/src/TraceDetailPane.js";

describe("TraceDetailPane", () => {
  it("renders the selected event and linked tool in the editor workspace", () => {
    const event: TraceEvent = {
      id: "trace_1", type: "tool.completed", source: "ToolRegistry",
      createdAt: "2026-10-13 23:00:00.000", sessionId: "ses_1", taskId: "task_1", turnId: "turn_1",
      payload: { toolCallId: "tool_1", requestId: "request_1", status: "completed" }
    };
    const tool: ToolCall = {
      id: "tool_1", turnId: "turn_1", intentId: "call_1", round: 0, name: "read_file",
      status: "completed", input: { path: "README.md" }, output: { content: "hello" }, errorMessage: null,
      startedAt: "2026-10-13 23:00:00.000", completedAt: "2026-10-13 23:00:00.100"
    };
    const html = renderToStaticMarkup(createElement(TraceDetailPane, { event, tool, onCapture: () => {}, onContext: () => {} }));

    expect(html).toContain("trace-detail-pane");
    expect(html).toContain("tool.completed");
    expect(html).toContain("trace_1");
    expect(html).toContain("ses_1");
    expect(html).toContain("read_file");
    expect(html).toContain("README.md");
    expect(html).toContain("request_1");
  });
});
