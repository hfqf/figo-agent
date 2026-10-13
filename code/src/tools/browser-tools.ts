import type { Tool, ToolExecutionContext } from "../contracts/types.js";
import { fetchText } from "./network-tools.js";
import { defaultToolDefaults, type RuntimeToolDefaults } from "../config/runtime-behavior.js";

export interface BrowserSnapshotOutput {
  url: string;
  title: string;
  text: string;
  html: string;
}

const snapshots = new Map<string, BrowserSnapshotOutput>();

export function createBrowserTools(defaults: RuntimeToolDefaults = defaultToolDefaults): Array<Tool<Record<string, unknown>, unknown>> {
  const open: Tool<Record<string, unknown>, BrowserSnapshotOutput> = {
    ...browserOpenTool,
    execute: (input, context) => browserOpenTool.execute({ timeoutMs: defaults.networkTimeoutMs, maxBytes: defaults.browserMaxBytes, ...input }, context)
  };
  return [open, { ...browserSnapshotTool, execute: (input, context) =>
    typeof input.url === "string" && input.url.trim() ? open.execute(input, context) : browserSnapshotTool.execute(input, context) }];
}

const browserOpenTool: Tool<Record<string, unknown>, BrowserSnapshotOutput> = {
  name: "browser_open",
  description: "打开 URL 并生成文本快照",
  execute: async (input, context) => {
    const fetched = await fetchText({ ...input, maxBytes: input.maxBytes ?? 256 * 1024 }, context.signal);
    if (fetched.status === "failed") return fetched;
    const snapshot = htmlToSnapshot(fetched.output.url, fetched.output.body);
    snapshots.set(snapshotKey(context), snapshot);
    return { status: "completed", output: snapshot };
  }
};

const browserSnapshotTool: Tool<Record<string, unknown>, BrowserSnapshotOutput> = {
  name: "browser_snapshot",
  description: "返回最近一次浏览器快照",
  execute: async (input, context) => {
    if (typeof input.url === "string" && input.url.trim()) {
      return browserOpenTool.execute(input, context);
    }
    const snapshot = snapshots.get(snapshotKey(context));
    if (!snapshot) {
      return { status: "failed", errorCode: "browser_snapshot_missing", errorMessage: "当前没有浏览器快照。" };
    }
    return { status: "completed", output: snapshot };
  }
};

function snapshotKey(context: ToolExecutionContext): string {
  return context.sessionId;
}

function htmlToSnapshot(url: string, html: string): BrowserSnapshotOutput {
  const title = decodeHtml(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i).trim());
  return {
    url,
    title,
    html,
    text: decodeHtml(stripTags(html)).replace(/\s+/g, " ").trim()
  };
}

function matchFirst(value: string, pattern: RegExp): string {
  return pattern.exec(value)?.[1] ?? "";
}

function stripTags(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
