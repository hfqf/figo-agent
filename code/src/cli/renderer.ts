import type { DispatchResult } from "./input-router.js";

export function renderDispatchResult(result: DispatchResult): string {
  if (!result.message) return "";
  return result.message;
}

export function renderStartup(sessionId: string): string {
  return `Figo Agent V1 已启动，会话：${sessionId}`;
}

export function renderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `执行失败：${message}`;
}
