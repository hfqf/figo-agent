import type { InspectorFieldPage, InspectorFieldReference, InspectorFieldSelection } from "../contracts/trace-inspector-field.js";
import type { StorageManager } from "../storage/storage-manager.js";
import type { TraceInspectorSettings } from "../config/trace-inspector-settings.js";
import { eventKey, factTables, parseEventKey, type DbRow } from "./trace-inspector-facts.js";
import { redactForUi } from "./ui-redaction.js";

const fields: Record<string, readonly string[]> = {
  trace_events: ["payload_json"], ui_events: ["payload_json"],
  llm_http_captures: ["request_headers_json", "request_body_json", "response_headers_json", "response_body_json"],
  tool_calls: ["input_json", "output_json", "error_message"],
  context_items: ["content", "summary", "reason"],
  context_messages: ["message_json", "usage_json"],
  context_compactions: ["summary_markdown", "details_json", "source_refs_json"],
  task_compaction_checkpoints: ["summary_json", "source_turn_ids_json"]
};

function validFieldPath(path: Array<string | number>): boolean {
  return path.length <= 32 && path.every(part => typeof part === "string"
    ? !["__proto__", "constructor", "prototype"].includes(part) && part.length <= 4096
    : typeof part === "number" && Number.isSafeInteger(part) && part >= 0);
}

export function fieldEventKey(table: string, row: DbRow): string | undefined {
  if (table === "context_items") return `context-item:${row.id}`;
  for (const [category, spec] of Object.entries(factTables)) {
    if (spec.table === table) return eventKey(category as Parameters<typeof eventKey>[0], row[spec.id]);
  }
}

export function assertFieldDepth(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (!current.value || typeof current.value !== "object") continue;
    if (current.depth >= 128) throw new Error("嵌套深度超过读取上限");
    for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
  }
}

const payloadMetadata = new Set(["requestId", "requestIds", "contextPackId", "toolCallId", "intentId", "compactionEntryId", "checkpointId",
  "legacyCheckpointId", "compactionAttemptId", "recoveryOfRequestId", "sourceRef", "sourceRefs", "sourceTurnIds", "firstKeptSourceRef", "projection"]);

export function previewField(value: unknown, table: string, column: string, row: DbRow,
  settings: TraceInspectorSettings, secrets: string[], preserveMetadata = false): unknown {
  assertFieldDepth(value);
  const key = fieldEventKey(table, row);
  const allowed = Boolean(key && fields[table]?.includes(column));
  let nodes = settings.maxPreviewNodes;
  function reference(entry: unknown, path: Array<string | number>): InspectorFieldReference {
    const text = typeof entry === "string" ? entry : JSON.stringify(entry);
    return { __inspectorField: true, eventKey: key ?? "", field: column, path, originalChars: text.length,
      preview: text.slice(0, settings.fieldPreviewChars), loadable: allowed && validFieldPath(path) && text.length <= settings.maxFieldChars };
  }
  function walk(entry: unknown, path: Array<string | number>, metadata = preserveMetadata): unknown {
    if (!metadata) nodes--;
    if (typeof entry === "string") return !metadata && entry.length > settings.fieldPreviewChars ? reference(entry, path) : entry;
    if (!entry || typeof entry !== "object") return entry;
    // 原始正文不能伪装成服务端生成的可加载引用。
    if (Object.hasOwn(entry, "__inspectorField")) return walk(JSON.stringify(entry), path, metadata);
    const payloadRoot = path.length === 0 && column === "payload_json" && (table === "trace_events" || table === "ui_events");
    const protectedRoot = payloadRoot && Object.keys(entry).some(name => payloadMetadata.has(name));
    if (!metadata && !protectedRoot && (nodes < 1 || path.length >= 32 || (Array.isArray(entry) ? entry.length : Object.keys(entry).length) > nodes)) return reference(entry, path);
    return Array.isArray(entry) ? entry.map((item, index) => walk(item, [...path, index], metadata))
      : Object.fromEntries(Object.entries(entry).map(([name, item]) => [name, walk(item, [...path, name], metadata || (payloadRoot && payloadMetadata.has(name)))]));
  }
  return walk(redactForUi(value, secrets), []);
}

export function readInspectorField(storage: StorageManager, secrets: string[], settings: TraceInspectorSettings,
  key: string, selection: InspectorFieldSelection): InspectorFieldPage {
  const spec = key.startsWith("context-item:") ? { table: "context_items", id: "id", value: key.slice("context-item:".length) }
    : (() => { const parsed = parseEventKey(key); return { ...factTables[parsed.category], value: parsed.id }; })();
  if (!spec.value || !fields[spec.table]?.includes(selection.field)) throw new Error("检查器字段参数无效。");
  const path = selection.path ?? [];
  if (!Array.isArray(path) || !validFieldPath(path)) throw new Error("检查器字段路径无效。");
  const offset = selection.offset ?? 0;
  const limit = selection.limit ?? settings.fieldPageChars;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > settings.fieldMaxPageChars) throw new Error("检查器字段分页参数无效。");
  const column = selection.field;
  const record = storage.db.prepare(`select length("${column}") n, substr("${column}",1,?) content from ${spec.table} where ${spec.id} = ?`)
    .get(settings.maxFieldChars + 1, spec.value) as { n: number | null; content: string | null } | undefined;
  if (!record) throw new Error("检查器字段记录不存在。");
  if ((record.n ?? 0) > settings.maxFieldChars || (record.content?.length ?? 0) > settings.maxFieldChars) throw new Error("检查器字段超过读取上限，请缩小记录范围。");
  let value: unknown = record.content;
  if (column.endsWith("_json") && record.content !== null) {
    try { value = JSON.parse(record.content); } catch { if (path.length) throw new Error("检查器字段 JSON 无效。"); }
  }
  assertFieldDepth(value);
  value = redactForUi(value, secrets);
  for (const part of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)
      || (Array.isArray(value) && typeof part !== "number") || (!Array.isArray(value) && typeof part !== "string")) throw new Error("检查器字段路径不存在。");
    value = (value as Record<string | number, unknown>)[part];
  }
  const format = typeof value === "string" ? "text" : "json";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (offset > text.length) throw new Error("检查器字段偏移超出范围。");
  let end = Math.min(offset + limit, text.length);
  // 不在 UTF-16 代理对中间切页，下一页从安全边界继续。
  if (end < text.length && end > offset && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  if (end === offset && offset < text.length) end = Math.min(offset + 2, text.length);
  return { eventKey: key, field: column, path, format, content: text.slice(offset, end), offset,
    nextOffset: end < text.length ? end : null, totalChars: text.length, complete: end === text.length };
}
