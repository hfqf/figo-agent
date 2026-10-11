import { describe, expect, it } from "vitest";
import { dispatchInput, routeInput } from "../../src/cli/input-router.js";

describe("CLI input router", () => {
  it("routes empty input, turns, known commands, and unknown commands", () => {
    expect(routeInput("")).toEqual({ kind: "empty" });
    expect(routeInput("理解当前项目")).toEqual({ kind: "turn", input: "理解当前项目" });
    expect(routeInput("/report")).toEqual({ kind: "command", command: "report" });
    expect(routeInput("/task current")).toEqual({ kind: "command", command: "task", raw: "/task current" });
    expect(routeInput("/compact")).toEqual({ kind: "command", command: "compact", raw: "/compact" });
    expect(routeInput("/wat")).toEqual({ kind: "command", command: "unknown", raw: "/wat" });
  });

  it("dispatches turns and exit without creating turns for read-only commands", async () => {
    const calls: string[] = [];
    const kernel = {
      submitTurn: async (input: string) => {
        calls.push(`turn:${input}`);
        return {
          sessionId: "ses_1",
          turnId: "turn_1",
          status: "completed" as const,
          message: "完成",
          artifacts: []
        };
      },
      handleCommand: async (command: string) => {
        calls.push(`command:${command}`);
        return {
          status: "completed" as const,
          message: "Task task_1：default（active）",
          artifacts: []
        };
      },
      shutdown: async () => {
        calls.push("shutdown");
      }
    };

    await expect(dispatchInput(routeInput("理解当前项目"), kernel)).resolves.toMatchObject({
      exit: false,
      message: "完成"
    });
    await expect(dispatchInput(routeInput("/context"), kernel)).resolves.toMatchObject({
      exit: false
    });
    await expect(dispatchInput(routeInput("/memory"), kernel)).resolves.toMatchObject({
      exit: false
    });
    await expect(dispatchInput(routeInput("/report"), kernel)).resolves.toMatchObject({
      exit: false
    });
    await expect(dispatchInput(routeInput("/help"), kernel)).resolves.toMatchObject({
      exit: false
    });
    await expect(dispatchInput(routeInput("/task current"), kernel)).resolves.toMatchObject({
      exit: false,
      message: "Task task_1：default（active）"
    });
    await expect(dispatchInput(routeInput("/compact"), kernel)).resolves.toMatchObject({ exit: false });
    await expect(dispatchInput(routeInput("/exit"), kernel)).resolves.toMatchObject({
      exit: true
    });
    expect(calls).toEqual(["turn:理解当前项目", "command:/task current", "command:/compact", "shutdown"]);
  });
});
