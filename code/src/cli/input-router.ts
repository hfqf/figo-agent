import type { TurnResult } from "../contracts/types.js";

export type CliRoute =
  | { kind: "empty" }
  | { kind: "turn"; input: string }
  | { kind: "command"; command: "help" | "exit" | "context" | "memory" | "report" | "task" | "compact" | "usage" | "unknown"; raw?: string };

export interface KernelLike {
  submitTurn(input: string): Promise<TurnResult>;
  handleCommand(command: string): Promise<{ message: string }>;
  shutdown(): Promise<void>;
}

export interface DispatchResult {
  exit: boolean;
  message: string;
}

export function routeInput(input: string): CliRoute {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "empty" };
  if (!trimmed.startsWith("/")) return { kind: "turn", input: trimmed };
  if (/^\/skill\s+project-understanding(?:\s|$)/i.test(trimmed)) return { kind: "turn", input: trimmed };

  if (trimmed === "/help") return { kind: "command", command: "help" };
  if (trimmed === "/exit") return { kind: "command", command: "exit" };
  if (trimmed === "/context") return { kind: "command", command: "context" };
  if (trimmed === "/memory") return { kind: "command", command: "memory" };
  if (trimmed === "/report") return { kind: "command", command: "report" };
  if (/^\/compact(?:\s|$)/.test(trimmed)) return { kind: "command", command: "compact", raw: trimmed };
  if (trimmed === "/usage") return { kind: "command", command: "usage", raw: trimmed };
  if (trimmed === "/task" || trimmed.startsWith("/task ")) {
    return { kind: "command", command: "task", raw: trimmed };
  }
  return { kind: "command", command: "unknown", raw: trimmed };
}

export async function dispatchInput(route: CliRoute, kernel: KernelLike): Promise<DispatchResult> {
  if (route.kind === "empty") return { exit: false, message: "" };
  if (route.kind === "turn") {
    const result = await kernel.submitTurn(route.input);
    const artifactPaths = result.artifacts.map((artifact) => artifact.path).join("\n");
    return {
      exit: false,
      message: artifactPaths ? `${result.message}\n${artifactPaths}` : result.message
    };
  }

  if (route.command === "exit") {
    await kernel.shutdown();
    return { exit: true, message: "会话已结束。" };
  }
  if (route.command === "help") {
    return { exit: false, message: helpText() };
  }
  if (route.command === "context") {
    return { exit: false, message: "最近上下文产物位于 .figo-agent/artifacts/sessions/<session>/<turn>/context.md" };
  }
  if (route.command === "memory") {
    return { exit: false, message: "V1 Memory 状态源为 SQLite memory_records，当前版本不自动写入 Memory。" };
  }
  if (route.command === "report") {
    return { exit: false, message: "最近报告产物位于 .figo-agent/artifacts/sessions/<session>/<turn>/report.md" };
  }
  if (route.command === "task" || route.command === "compact" || route.command === "usage") {
    const result = await kernel.handleCommand(route.raw ?? "/task current");
    return { exit: false, message: result.message };
  }
  return { exit: false, message: `未知命令：${route.raw ?? ""}` };
}

function helpText(): string {
  return [
    "Figo Agent V1 命令：",
    "/help 查看帮助",
    "/context 查看上下文产物位置",
    "/memory 查看 Memory 说明",
    "/report 查看报告产物位置",
    "/task current 查看当前 Task",
    "/task finish 结束当前 Task 并生成 task-summary.md",
    "/compact 压缩当前 Task 的历史上下文",
    "/usage 查看当前 Task 与 Session 的模型用量",
    "/skill project-understanding <需求> 显式执行项目理解 Skill",
    "/exit 结束会话",
    "直接输入文本会创建一个 Turn。"
  ].join("\n");
}
