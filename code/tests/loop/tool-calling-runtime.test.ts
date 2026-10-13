import { describe, expect, it } from "vitest";
import type { ToolExecutionContext, ToolResult } from "../../src/contracts/types.js";
import type { ToolIntentCall } from "../../src/loop/tool-call-parser.js";
import { ToolCallingRuntime } from "../../src/loop/tool-calling-runtime.js";

describe("ToolCallingRuntime", () => {
  it("does not start the next tool after the user stops the run", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const runtime = new ToolCallingRuntime({ execute: async (name) => {
      calls.push(name);
      controller.abort(new Error("stopped"));
      return { status: "completed", output: {} };
    } });
    await expect(runtime.executeBatch([
      { id: "call_1", name: "first", input: {} },
      { id: "call_2", name: "second", input: {} }
    ], { ...toolContext(), signal: controller.signal }, 0)).rejects.toThrow("stopped");
    expect(calls).toEqual(["first"]);
  });
  it("executes tool calls through the registry and preserves call ids", async () => {
    const registry = new FakeRegistry({
      system_info: { status: "completed", output: { platform: "darwin" } }
    });
    const runtime = new ToolCallingRuntime(registry);

    const results = await runtime.executeBatch(
      [{ id: "call_1", name: "system_info", input: {} }],
      toolContext(),
      0
    );

    expect(registry.calls).toEqual([{ name: "system_info", input: {} }]);
    expect(results).toEqual([
      {
        id: "call_1",
        name: "system_info",
        status: "completed",
        output: { platform: "darwin" },
        round: 0
      }
    ]);
  });

  it("keeps failed tool results structured", async () => {
    const registry = new FakeRegistry({
      run_command: { status: "failed", errorCode: "action_not_supported", errorMessage: "命令被拒绝" }
    });
    const runtime = new ToolCallingRuntime(registry);

    const results = await runtime.executeBatch(
      [{ id: "call_2", name: "run_command", input: { command: "sudo rm -rf /" } }],
      toolContext(),
      1
    );

    expect(results).toEqual([
      {
        id: "call_2",
        name: "run_command",
        status: "failed",
        errorCode: "action_not_supported",
        errorMessage: "命令被拒绝",
        round: 1
      }
    ]);
  });
});

class FakeRegistry {
  public readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];

  constructor(private readonly results: Record<string, ToolResult>) {}

  async execute(name: string, input: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    this.calls.push({ name, input });
    return this.results[name] ?? { status: "failed", errorCode: "tool_not_found", errorMessage: "missing" };
  }
}

function toolContext(): ToolExecutionContext {
  return {
    sessionId: "ses_1",
    taskId: "task_1",
    turnId: "turn_1",
    workspaceRoot: "/tmp/workspace"
  };
}
