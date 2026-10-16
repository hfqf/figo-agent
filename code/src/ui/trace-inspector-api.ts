import type { TraceInspectorCategory, TraceInspectorListOptions } from "../contracts/trace-inspector.js";
import type { TraceInspectorQueryService } from "./trace-inspector-query-service.js";

const categories = new Set<TraceInspectorCategory>(["trace", "capture", "tool", "context", "compaction", "legacy-compaction", "message", "ui"]);
const tabs = new Set(["context-flow", "llm-request", "llm-response", "tool-calls", "compaction", "raw"]);

/** 传输层只解析只读查询；鉴权与同源检查继续由 LocalApi 统一执行。 */
export function routeTraceInspectorRequest(method: string, url: URL, service: TraceInspectorQueryService): { status: number; body: unknown } | undefined {
  const list = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/trace-inspector\/events$/);
  const detail = url.pathname.match(/^\/api\/v1\/trace-inspector\/events\/([^/]+)(?:\/([^/]+))?$/);
  if (!list && !detail) return undefined;
  if (method !== "GET") return { status: 405, body: { error: "检查器只支持只读查询。" } };
  if (detail?.[2] && !tabs.has(detail[2])) return { status: 404, body: { error: "检查器标签不存在。" } };
  try {
    const get = (name: string, max: number) => {
      const values = url.searchParams.getAll(name);
      if (values.length > 1 || (values[0]?.length ?? 0) > max) throw new Error("检查器查询参数无效。");
      return values[0];
    };
    if (list) {
      const options: TraceInspectorListOptions = {};
      const category = get("category", 150);
      if (category) {
        const selected = category.split(",") as TraceInspectorCategory[];
        if (selected.some((item) => !categories.has(item))) throw new Error("事件类别无效。");
        options.category = selected;
      }
      const failed = get("failed", 5);
      if (failed !== undefined && !["true", "false", "1", "0"].includes(failed)) throw new Error("失败筛选参数无效。");
      if (failed !== undefined) options.failed = failed === "true" || failed === "1";
      const limit = get("limit", 8);
      if (limit !== undefined) {
        if (!/^\d+$/.test(limit) || Number(limit) < 1) throw new Error("分页参数无效。");
        options.limit = Math.min(Number(limit), 500);
      }
      options.q = get("q", 160);
      options.cursor = get("cursor", 4096);
      const latest = get("latest", 5);
      if (latest !== undefined && !["true", "false", "1", "0"].includes(latest)) throw new Error("实时窗口参数无效。");
      if (latest !== undefined) options.latest = latest === "true" || latest === "1";
      return { status: 200, body: service.listEvents(decodeURIComponent(list[1]), options) };
    }
    return { status: 200, body: service.detail(decodeURIComponent(detail![1]), {
      requestId: get("requestId", 300), compactionEntryId: get("compactionEntryId", 300)
    }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "检查器查询失败。";
    const status = /不存在|未找到/.test(message) ? 404
      : error instanceof URIError || /无效|不属于|归属|游标|参数|非法|超过|超出/.test(message) ? 400 : 500;
    // 不把未知异常、SQL 或原始记录内容作为浏览器错误返回。
    return { status, body: { error: status === 500 ? "检查器查询失败。" : status === 404 ? "检查器记录不存在。" : "检查器查询参数无效或关联不匹配。" } };
  }
}
