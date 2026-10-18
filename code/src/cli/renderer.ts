import type { DispatchResult } from "./input-router.js";
import { formatLocaleTemplate, zhCN } from "../i18n/catalog.js";
import { appVersion } from "../version.js";

export function renderVersion(): string {
  return formatLocaleTemplate(zhCN.cli.version, { version: appVersion });
}

export function renderDispatchResult(result: DispatchResult): string {
  if (!result.message) return "";
  return result.message;
}

export function renderStartup(sessionId: string): string {
  return formatLocaleTemplate(zhCN.cli.startup, { version: appVersion, sessionId });
}

export function renderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `执行失败：${message}`;
}
