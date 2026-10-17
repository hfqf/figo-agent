import type { ObservedNumber, TraceInspectorDetail, TraceInspectorEventRow, TraceInspectorEventPage, TraceInspectorListOptions } from "../../src/contracts/trace-inspector";
import type { InspectorFieldReference } from "../../src/contracts/trace-inspector-field";
import { inspectorCopy as c } from "./i18n";
export interface InspectorPage {
  rows: TraceInspectorEventRow[];
  nextCursor: string | null;
  hasMore: boolean;
  truncated: boolean;
  pagination?: TraceInspectorEventPage["pagination"];
}
export type InspectorTab =
  | "overview"
  | "context-flow"
  | "llm-request"
  | "llm-response"
  | "tool-calls"
  | "compaction"
  | "raw";
export type InspectorReadReason = "initial" | "more" | "live";
const businessCategories = "trace,capture,tool,context,compaction,legacy-compaction,message";
export function categorySources(filter: string): string {
  return (
    (
      {
        llm: "capture,trace",
        tool: "tool,trace",
        context: "context,message,trace",
        compaction: "compaction,legacy-compaction,trace",
        trace: "trace",
        ui: "ui",
        all: `${businessCategories},ui`,
      } as Record<string, string>
    )[filter] ?? businessCategories
  );
}
export function matchesCategory(
  row: TraceInspectorEventRow,
  filter: string,
): boolean {
  if (!filter) return row.category !== "ui";
  if (filter === "all") return true;
  if (row.category !== "trace")
    return categorySources(filter).split(",").includes(row.category);
  if (filter === "trace") return true;
  return (
    (
      {
        llm: /^(llm|protocol)\./,
        tool: /^(tool|policy)\./,
        context: /^(context|memory|file|task\.history)\./,
        compaction: /compaction/,
      } as Record<string, RegExp>
    )[filter]?.test(row.kind) ?? false
  );
}
export function canAppendPage(
  reason: InspectorReadReason,
  query: string,
  loadedQuery: string,
  count: number,
): boolean {
  return reason === "more" && query === loadedQuery && count < 500;
}
/** 每次读取拥有独立代次，A→B→A 也不能接受第一轮 A 的迟到结果。 */
export class InspectorRequestGate {
  private generation = 0;
  begin(): number {
    return ++this.generation;
  }
  current(ticket: number): boolean {
    return ticket === this.generation;
  }
  cancel(ticket: number): void {
    if (this.current(ticket)) this.generation++;
  }
}
export function fileReferencePath(sourceRef: string): string {
  return /^(.*)#L\d+-L\d+$/.exec(sourceRef)?.[1] ?? sourceRef;
}
export function snapshotDifference(
  sourceRef: string,
  snapshot: string,
  current: string | null,
): boolean | null {
  const range = /#L(\d+)-L(\d+)$/.exec(sourceRef);
  if (!range || current === null) return null;
  const normalize = (text: string) =>
    text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const selected = current
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(Number(range[1]) - 1, Number(range[2]))
    .join("\n");
  return normalize(snapshot) !== normalize(selected);
}
export interface InspectorState {
  scope: string;
  rows: TraceInspectorEventRow[];
  selectedKey: string | null;
  requestId: string | null;
  compactionEntryId: string | null;
  nextCursor: string | null;
  hasMore: boolean;
  truncated: boolean;
  error: string;
  pagination?: TraceInspectorEventPage["pagination"];
}
export type InspectorAction =
  | { type: "page"; scope: string; page: InspectorPage; append: boolean }
  | { type: "select"; row: TraceInspectorEventRow }
  | {
      type: "focus";
      key: string;
      requestId?: string;
      compactionEntryId?: string;
    }
  | { type: "error"; error: string }
  | { type: "request"; id: string | null }
  | { type: "compaction"; id: string | null };
export function initialInspectorState(
  workspace: string,
  taskId: string,
): InspectorState {
  return {
    scope: `${workspace}\u0000${taskId}`,
    rows: [],
    selectedKey: null,
    requestId: null,
    compactionEntryId: null,
    nextCursor: null,
    hasMore: false,
    truncated: false,
    error: "",
  };
}
export function inspectorReducer(
  state: InspectorState,
  action: InspectorAction,
): InspectorState {
  if (action.type === "error") return { ...state, error: action.error };
  if (action.type === "request") return { ...state, requestId: action.id };
  if (action.type === "compaction")
    return { ...state, compactionEntryId: action.id };
  if (action.type === "focus")
    return {
      ...state,
      selectedKey: action.key,
      requestId: action.requestId ?? null,
      compactionEntryId: action.compactionEntryId ?? null,
    };
  if (action.type === "select")
    return {
      ...state,
      selectedKey: action.row.key,
      requestId: action.row.refs.requestId ?? null,
      compactionEntryId: action.row.refs.compactionEntryId ?? null,
    };
  if (action.scope !== state.scope) return state;
  const rows = [
    ...new Map(
      [...(action.append ? state.rows : []), ...action.page.rows].map((row) => [
        row.key,
        row,
      ]),
    ).values(),
  ];
  return { ...state, ...action.page, pagination: action.page.pagination, rows, error: "" };
}
export function detailPath(
  key: string,
  tab: InspectorTab,
  request?: string | null,
  entry?: string | null,
): string {
  const params = new URLSearchParams();
  if (request) params.set("requestId", request);
  if (entry) params.set("compactionEntryId", entry);
  return `/api/v1/trace-inspector/events/${encodeURIComponent(key)}${tab === "overview" ? "" : `/${tab}`}${params.size ? `?${params}` : ""}`;
}
export function defaultRequestId(detail: Pick<TraceInspectorDetail, "selection" | "captures">, selected: string | null): string | null {
  return selected ?? detail.selection.requestId ?? detail.captures[0]?.requestId ?? null;
}
export function listPath(
  id: string,
  filter: {
    category?: string;
    failed?: boolean;
    q?: string;
    cursor?: string | null;
    latest?: boolean;
    limit?: number;
    page?: number;
    group?: TraceInspectorListOptions["group"];
  },
): string {
  const params = new URLSearchParams();
  params.set("category", filter.category || businessCategories);
  if (filter.failed) params.set("failed", "true");
  if (filter.q) params.set("q", filter.q);
  params.set("limit", String(filter.limit ?? 200));
  if (filter.latest) params.set("latest", "true");
  if (filter.cursor) params.set("cursor", filter.cursor);
  if (filter.page !== undefined) params.set("page", String(filter.page));
  if (filter.group) params.set("group", filter.group);
  return `/api/v1/tasks/${encodeURIComponent(id)}/trace-inspector/events?${params}`;
}
type DurationState = "recorded" | "not_applicable" | "pending" | "not_recorded";
type TokenState = DurationState | "provider_unavailable";
type MetricRow = { durationMs: number | null; tokens: ObservedNumber | null; durationState?: DurationState; tokenState?: TokenState };
function metricState(state?: TokenState): string | undefined {
  return state === "not_applicable" ? c.notApplicable
    : state === "pending" ? c.pending
    : state === "provider_unavailable" ? c.unavailable
    : state === "not_recorded" ? c.notRecorded : undefined;
}
export function durationText(row: Pick<MetricRow, "durationMs" | "durationState">): string {
  return metricState(row.durationState) ?? (typeof row.durationMs === "number" && Number.isSafeInteger(row.durationMs) && row.durationMs >= 0 ? `${row.durationMs} ms` : c.notRecorded);
}
export function tokenText(row: Pick<MetricRow, "tokens" | "tokenState">): string {
  const state = metricState(row.tokenState);
  if (state) return state;
  const value = row.tokens;
  if (!value || value.value === null || value.availability !== "recorded") return c.notRecorded;
  return `${value.value.toLocaleString()} · ${{ provider_actual: c.actual, estimate: c.estimate, usage_plus_estimate: c.mixed, count: c.count, unknown: c.unknown }[value.kind]}`;
}
export type InspectorField = InspectorFieldReference;
export function isInspectorField(value: unknown): value is InspectorField {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<InspectorField>;
  return item.__inspectorField === true && typeof item.eventKey === "string" && typeof item.field === "string"
    && Array.isArray(item.path) && item.path.every((part) => typeof part === "string" || (Number.isSafeInteger(part) && Number(part) >= 0))
    && typeof item.preview === "string" && typeof item.originalChars === "number" && Number.isFinite(item.originalChars)
    && item.originalChars >= 0 && typeof item.loadable === "boolean";
}
export function inspectorFieldPath(value: InspectorField, offset = 0, limit?: number): string {
  const params = new URLSearchParams({ field: value.field, path: JSON.stringify(value.path), offset: String(offset) });
  if (limit !== undefined) params.set("limit", String(limit));
  return `/api/v1/trace-inspector/events/${encodeURIComponent(value.eventKey)}/field?${params}`;
}
export function reduction(
  before: number | null,
  after: number | null,
): number | null {
  return before !== null && after !== null && before > 0
    ? 1 - after / before
    : null;
}
// 服务端是脱敏边界；展示和剪贴板再防御一次，token 数量字段不作凭据处理。
export function redact(value: unknown): unknown {
  if (typeof value === "string")
    return value
      .replace(
        /((?:authorization|api[-_ ]?key|access[-_]?token|secret|password)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"'<>}]+/gi,
        "$1[REDACTED]",
      )
      .replace(/\bBearer\s+[^\s,"'<>]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|apikey|api_key|api-key|token|access_token|secret|password)$/i.test(
          key,
        )
          ? "[REDACTED]"
          : redact(item),
      ]),
    );
  return value;
}
export function jsonText(value: unknown): string {
  return JSON.stringify(redact(value), null, 2) ?? "null";
}
export function exportEvidence(
  rows: TraceInspectorEventRow[],
  truncated: boolean,
  format: "json" | "md",
  task: string,
): string {
  const data = {
    taskId: task,
    scope: c.loadedScope,
    loadedRows: rows.length,
    truncated,
    redacted: true,
    events: redact(rows),
  };
  if (format === "json") return jsonText(data);
  return `# ${c.title}\n\n${c.loadedScope}: ${rows.length}\n\n${c.truncated}: ${truncated ? c.yes : c.no}\n\n${c.redacted}\n\n\`\`\`json\n${jsonText(data)}\n\`\`\`\n`;
}
export const LAYOUT_KEY = "figo.trace-inspector.layout.v1";
export function decodeLayout(raw: string | null): number {
  try {
    const value = JSON.parse(raw ?? "null")?.ratio;
    return typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 25 &&
      value <= 75
      ? value
      : 52;
  } catch {
    return 52;
  }
}
