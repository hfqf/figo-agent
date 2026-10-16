import type { TraceInspectorCategory, TraceInspectorEventRow } from "../contracts/trace-inspector.js";

export const categories: TraceInspectorCategory[] = ["trace", "capture", "tool", "context", "compaction", "legacy-compaction", "message", "ui"];
export type DbRow = Record<string, any>;
export const factTables: Record<TraceInspectorCategory, { table: string; id: string }> = {
  trace: { table: "trace_events", id: "id" }, capture: { table: "llm_http_captures", id: "id" },
  tool: { table: "tool_calls", id: "id" }, context: { table: "context_packs", id: "id" },
  compaction: { table: "context_compactions", id: "id" }, "legacy-compaction": { table: "task_compaction_checkpoints", id: "id" },
  message: { table: "context_messages", id: "source_ref" }, ui: { table: "ui_events", id: "event_id" }
};
export const jsonField = (column: string, path: string) => `json_extract(case when json_valid(${column}) then ${column} else '{}' end, '$.${path}')`;
const payload = (path: string) => jsonField("r.payload_json", path);

/** UNION 只投影标识、时间与短标量；列表不把正文加载到进程中。 */
export const factsSql = categories.map((category, rank) => {
  const spec = factTables[category];
  const isEntry = category === "compaction" || category === "legacy-compaction";
  const task = category === "tool" ? "t.task_id" : "r.task_id";
  const turn = isEntry ? "null" : "r.turn_id";
  const session = isEntry ? "k.session_id" : category === "message" ? "t.session_id" : "r.session_id";
  const expressions: Record<string, string> = {
    category: `'${category}'`, rank: String(rank), rid: "r.rowid", id: `r.${spec.id}`,
    time: category === "tool" ? "r.started_at" : "r.created_at", taskId: task,
    turnId: turn, sessionId: session, turnSeq: isEntry ? "null" : "t.task_seq",
    kind: `'${category}'`, source: `'${spec.table}'`, name: `r.${spec.id}`, state: "'info'",
    requestId: "null", contextPackId: "null", toolCallId: "null", intentId: "null",
    compactionEntryId: "null", legacyCheckpointId: "null", sourceRef: "null", compactionAttemptId: "null",
    durationMs: "null", tokenValue: "null", tokenKind: "null", searchPath: "null"
  };
  if (category === "trace" || category === "ui") {
    expressions.kind = category === "trace" ? "r.type" : "r.kind";
    expressions.source = category === "trace" ? "r.source" : "'UI'";
    expressions.name = `coalesce(${payload("toolName")}, ${payload("model")}, ${payload("name")}, ${expressions.kind})`;
    expressions.state = `coalesce(${payload("status")}, '')`;
    for (const key of ["requestId", "contextPackId", "toolCallId", "intentId", "compactionAttemptId"]) expressions[key] = payload(key);
    expressions.compactionEntryId = `coalesce(${payload("compactionEntryId")}, ${payload("checkpointId")})`;
    expressions.durationMs = payload("durationMs");
    expressions.searchPath = payload("path");
  } else if (category === "capture") {
    Object.assign(expressions, { name: "r.model", requestId: "r.request_id", kind: "'llm.capture'", state: "case when r.response_status >= 400 or r.response_status = 0 then 'error' else 'ok' end", durationMs: "r.duration_ms",
      tokenValue: "(select u.total_tokens from token_usage u where u.capture_id = r.id)", tokenKind: "'provider_actual'" });
  } else if (category === "tool") {
    Object.assign(expressions, { name: "r.tool_name", state: "r.status", toolCallId: "r.id", intentId: "r.intent_id" });
  } else if (category === "context") {
    Object.assign(expressions, { contextPackId: "r.id", tokenValue: "r.estimated_tokens", tokenKind: "'estimate'" });
  } else if (category === "compaction") {
    Object.assign(expressions, { compactionEntryId: "r.id", requestId: "r.request_id", state: "'committed'", tokenValue: "r.tokens_before", tokenKind: `case ${jsonField("r.details_json", "estimateSource")} when 'usage' then 'usage_plus_estimate' when 'estimate' then 'estimate' else 'unknown' end` });
  } else if (category === "legacy-compaction") {
    Object.assign(expressions, { legacyCheckpointId: "r.id", requestId: "r.request_id", state: "'committed'" });
  } else if (category === "message") {
    expressions.sourceRef = "r.source_ref";
    expressions.name = "r.source_ref";
  }
  const preview = new Set(["name", "kind", "source", "state", "searchPath"]);
  const columns = Object.entries(expressions).map(([key, expression]) =>
    `${preview.has(key) ? `substr(cast((${expression}) as text), 1, 513)` : expression} as ${key}`);
  return `select ${columns.join(",")} from ${spec.table} r ${isEntry
    ? "left join tasks k on k.id = r.task_id"
    : "left join turns t on t.id = r.turn_id"}`;
}).join(" union all ");

export const statusSql = `case
  when instr(lower(kind || ' ' || state), 'denied') > 0 then 'denied'
  when instr(lower(kind || ' ' || state), 'interrupt') > 0 or instr(lower(kind || ' ' || state), 'cancel') > 0 then 'interrupted'
  when instr(lower(kind || ' ' || state), 'fail') > 0 or instr(lower(kind || ' ' || state), 'error') > 0 or instr(lower(kind || ' ' || state), 'repair') > 0 then 'error'
  when instr(lower(kind || ' ' || state), 'skip') > 0 then 'skipped'
  when instr(lower(kind || ' ' || state), 'complete') > 0 or state in ('ok','committed') then 'ok'
  else 'info' end`;

export function eventKey(category: TraceInspectorCategory, id: string): string {
  return `${category}:${category === "message" ? encodeURIComponent(id) : id}`;
}
export function parseEventKey(key: string): { category: TraceInspectorCategory; id: string } {
  if (typeof key !== "string" || key.length > 800000) throw new Error("无效事件标识");
  const colon = key.indexOf(":");
  const category = key.slice(0, colon) as TraceInspectorCategory;
  if (!categories.includes(category) || colon < 0) throw new Error("无效事件类别");
  let id = key.slice(colon + 1);
  try { if (category === "message") id = decodeURIComponent(id); } catch { throw new Error("无效消息标识编码"); }
  if (!id) throw new Error("无效事件标识");
  return { category, id };
}
export function toEventRow(row: DbRow): TraceInspectorEventRow {
  const refs: TraceInspectorEventRow["refs"] = {};
  for (const key of ["requestId", "contextPackId", "toolCallId", "intentId", "compactionEntryId", "legacyCheckpointId", "sourceRef", "compactionAttemptId"] as const) {
    if (typeof row[key] === "string") refs[key] = row[key];
  }
  if (row.category === "trace") refs.traceEventId = row.id;
  if (row.category === "capture") refs.captureId = row.id;
  return { key: eventKey(row.category, row.id), category: row.category, time: row.time, kind: row.kind,
    status: row.status, sessionId: row.sessionId, taskId: row.taskId, turnId: row.turnId, turnSeq: row.turnSeq,
    source: row.source, name: row.name, durationMs: typeof row.durationMs === "number" ? row.durationMs : null,
    tokens: row.tokenKind ? { value: row.tokenValue, kind: row.tokenKind, availability: row.tokenValue === null ? "unavailable" : "recorded" } : null, refs };
}
