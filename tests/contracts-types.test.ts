import { describe, expect, it } from "vitest";
import type { TraceEvent, Tool, ToolResult } from "../src/contracts/types.js";

describe("contracts", () => {
  it("supports trace and tool contracts", async () => {
    const event: TraceEvent = {
      id: "trc_1",
      sessionId: "ses_1",
      turnId: "turn_1",
      type: "turn.received",
      source: "AgentKernel",
      payload: {},
      createdAt: "2026-10-10T00:00:00.000Z"
    };

    const tool: Tool<{ path: string }, { ok: boolean }> = {
      name: "read_file",
      description: "read",
      execute: async (): Promise<ToolResult<{ ok: boolean }>> => ({
        status: "completed",
        output: { ok: true }
      })
    };

    await expect(tool.execute({ path: "readme.md" }, {} as never)).resolves.toEqual({
      status: "completed",
      output: { ok: true }
    });
    expect(event.type).toBe("turn.received");
  });
});
