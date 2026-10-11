import type { Tool } from "../contracts/types.js";

export interface NetworkFetchOutput {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  durationMs: number;
}

export function createNetworkTools(): Array<Tool<Record<string, unknown>, unknown>> {
  return [networkFetchTool];
}

const networkFetchTool: Tool<Record<string, unknown>, NetworkFetchOutput> = {
  name: "network_fetch",
  description: "执行受控 HTTP 请求并记录响应摘要",
  execute: async (input) => fetchText(input)
};

export async function fetchText(input: Record<string, unknown>) {
  const url = String(input.url ?? "");
  if (!isHttpUrl(url)) {
    return { status: "failed" as const, errorCode: "action_not_supported", errorMessage: "仅支持 http/https URL。" };
  }
  const method = String(input.method ?? "GET").toUpperCase();
  const timeoutMs = boundedInteger(input.timeoutMs, 30_000, 1_000, 120_000);
  const maxBytes = boundedInteger(input.maxBytes, 128 * 1024, 1024, 1024 * 1024);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method,
      headers: parseHeaders(input.headers),
      body: method === "GET" || method === "HEAD" ? undefined : String(input.body ?? ""),
      signal: controller.signal
    });
    const body = await response.text();
    const truncated = Buffer.byteLength(body, "utf8") > maxBytes;
    return {
      status: "completed" as const,
      output: {
        url,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response),
        body: truncateUtf8(body, maxBytes),
        truncated,
        durationMs: Date.now() - startedAt
      }
    };
  } catch (error) {
    return {
      status: "failed" as const,
      errorCode: "network_fetch_failed",
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = key.toLowerCase().includes("authorization") ? "[REDACTED]" : value;
  });
  return headers;
}

function parseHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    headers[key] = String(headerValue);
  }
  return headers;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numericValue)));
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString("utf8");
}
