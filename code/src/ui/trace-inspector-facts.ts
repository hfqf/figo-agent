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
const taskOwner = "(r.task_id is null or exists (select 1 from tasks owner where owner.id = r.task_id and owner.session_id is r.session_id))";
const turnOwner = `t.id is not null and t.session_id is r.session_id and t.task_id is r.task_id and ${taskOwner}`;
const usageJoin = (capture: string) => `left join token_usage u on u.capture_id = ${capture}.id and u.request_id = ${capture}.request_id
  and u.session_id is ${capture}.session_id and u.task_id is ${capture}.task_id and u.turn_id is ${capture}.turn_id and ${turnOwner}`;
const usageState = (capture: string, pending = "0") => `case when ${capture}.method = 'LOCAL' then 'not_applicable'
  when u.capture_id is not null then 'provider_unavailable' when ${capture}.id is null and (${pending}) then 'pending' else 'not_recorded' end`;
const estimateKind = (source: string) => `case ${source} when 'usage' then 'usage_plus_estimate' when 'usage_plus_estimate' then 'usage_plus_estimate'
  when 'estimate' then 'estimate' else 'unknown' end`;
const toolPending = (alias: string) => `${alias}.status in ('received','pending','running','started','processing','executing')`;

/** 时间列为上海毫秒文本；整数秒加毫秒余数，避免 julianday 浮点差值。 */
export function toolDurationSql(alias: string): string {
  const start = `${alias}.started_at`, end = `${alias}.completed_at`;
  const millis = (column: string) => `(unixepoch(substr(${column},1,19) || '+08:00') * 1000 + cast(substr(${column},21,3) as integer))`;
  return `case when length(${start}) = 23 and length(${end}) = 23
    and strftime('%Y-%m-%d %H:%M:%f', ${start}) = ${start} and strftime('%Y-%m-%d %H:%M:%f', ${end}) = ${end}
    and ${millis(end)} >= ${millis(start)} then ${millis(end)} - ${millis(start)} end`;
}

/** UNION 只投影标识、时间与短标量；列表不把正文加载到进程中。 */
export const factsSql = categories.map((category, rank) => {
  const spec = factTables[category];
  const isEntry = category === "compaction" || category === "legacy-compaction";
  const task = category === "tool" ? "t.task_id" : "r.task_id";
  const turn = isEntry ? "null" : "r.turn_id";
  const session = isEntry ? "k.session_id" : category === "message" ? "t.session_id" : "r.session_id";
  let joins = "";
  const expressions: Record<string, string> = {
    category: `'${category}'`, rank: String(rank), rid: "r.rowid", id: `r.${spec.id}`,
    time: category === "tool" ? "r.started_at" : "r.created_at", taskId: task,
    turnId: turn, sessionId: session, turnSeq: isEntry ? "null" : "t.task_seq",
    kind: `'${category}'`, source: `'${spec.table}'`, name: `r.${spec.id}`, state: "'info'",
    requestId: "null", contextPackId: "null", toolCallId: "null", intentId: "null",
    compactionEntryId: "null", legacyCheckpointId: "null", sourceRef: "null", compactionAttemptId: "null",
    durationMs: "null", durationState: "'not_applicable'", tokenValue: "null", tokenKind: "null", tokenState: "'not_applicable'", searchPath: "null"
  };
  if (category === "trace" || category === "ui") {
    expressions.kind = category === "trace" ? "r.type" : "r.kind";
    expressions.source = category === "trace" ? "r.source" : "'UI'";
    expressions.name = `coalesce(${payload("toolName")}, ${payload("tool")}, ${payload("model")}, ${payload("name")}, ${expressions.kind})`;
    expressions.state = `coalesce(${payload("status")}, '')`;
    for (const key of ["requestId", "contextPackId", "toolCallId", "intentId", "compactionAttemptId"]) expressions[key] = payload(key);
    expressions.compactionEntryId = `coalesce(${payload("compactionEntryId")}, ${payload("checkpointId")})`;
    expressions.durationMs = payload("durationMs");
    expressions.searchPath = payload("path");
    if (category === "trace") {
      const llm = "r.type in ('llm.called','llm.started','llm.requested','llm.completed','llm.failed','llm.interrupted')";
      const llmPending = "r.type in ('llm.called','llm.started','llm.requested')";
      const tool = "r.type in ('tool.called','tool.started','tool.completed','tool.failed','tool.denied')";
      const toolStart = "r.type in ('tool.called','tool.started')";
      const context = "r.type = 'context.build.completed'";
      const compaction = "r.type like 'compaction.%'";
      // 同一精确引用出现多条抓包时不任选一条，且不增加 UNION 事实行数。
      joins = `left join llm_http_captures c on c.rowid = (select case when count(*) = 1 then min(candidate.rowid) end
        from llm_http_captures candidate where (${llm}) and candidate.request_id = ${payload("requestId")}
        and candidate.session_id is r.session_id and candidate.task_id is r.task_id and candidate.turn_id is r.turn_id and ${turnOwner})
        ${usageJoin("c")}
        left join tool_calls tc on (${tool}) and tc.id = ${payload("toolCallId")} and tc.session_id is r.session_id
        and tc.turn_id is r.turn_id and ${turnOwner}`;
      expressions.durationMs = `case when ${llm} then c.duration_ms when ${tool} then ${toolDurationSql("tc")} else ${payload("durationMs")} end`;
      expressions.durationState = `case when ${llm} then case when c.id is null and (${llmPending}) then 'pending' else 'not_recorded' end
        when ${tool} then case when ${toolPending("tc")} or (tc.id is null and (${toolStart})) then 'pending' else 'not_recorded' end else 'not_applicable' end`;
      expressions.tokenValue = `case when (${llm}) and c.method != 'LOCAL' then u.total_tokens when ${context} then ${payload("estimatedTokens")}
        when ${compaction} then coalesce(${payload("tokens")}, ${payload("contextTokens")}, ${payload("tokensBefore")}) end`;
      expressions.tokenKind = `case when (${llm}) and c.method != 'LOCAL' then 'provider_actual' when ${context} then 'estimate'
        when ${compaction} then ${estimateKind(`coalesce(${payload("source")}, ${payload("estimateSource")})`)} end`;
      expressions.tokenState = `case when ${llm} then ${usageState("c", llmPending)} when (${context}) or (${compaction}) then 'not_recorded' else 'not_applicable' end`;
    }
  } else if (category === "capture") {
    joins = usageJoin("r");
    Object.assign(expressions, { name: "r.model", requestId: "r.request_id", kind: "'llm.capture'", state: "case when r.response_status >= 400 or r.response_status = 0 then 'error' else 'ok' end", durationMs: "r.duration_ms",
      durationState: "'not_recorded'", tokenValue: "case when r.method != 'LOCAL' then u.total_tokens end",
      tokenKind: "case when r.method != 'LOCAL' then 'provider_actual' end", tokenState: usageState("r") });
  } else if (category === "tool") {
    Object.assign(expressions, { name: "r.tool_name", state: "r.status", toolCallId: "r.id", intentId: "r.intent_id",
      durationMs: toolDurationSql("r"), durationState: `case when ${toolPending("r")} then 'pending' else 'not_recorded' end` });
  } else if (category === "context") {
    Object.assign(expressions, { contextPackId: "r.id", tokenValue: "r.estimated_tokens", tokenKind: "'estimate'", tokenState: "'not_recorded'" });
  } else if (category === "compaction") {
    Object.assign(expressions, { compactionEntryId: "r.id", requestId: "r.request_id", state: "'committed'", tokenValue: "r.tokens_before",
      tokenKind: estimateKind(jsonField("r.details_json", "estimateSource")), tokenState: "'not_recorded'" });
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
    : "left join turns t on t.id = r.turn_id"} ${joins}`;
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
  const recorded = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const durationMs = recorded(row.durationMs) ? row.durationMs : null;
  const tokenValue = recorded(row.tokenValue) ? row.tokenValue : null;
  const durationState = durationMs !== null ? "recorded" : row.durationState ?? "not_recorded";
  const tokenState = tokenValue !== null ? "recorded" : row.tokenState ?? "not_recorded";
  return { key: eventKey(row.category, row.id), category: row.category, time: row.time, kind: row.kind,
    status: row.status, sessionId: row.sessionId, taskId: row.taskId, turnId: row.turnId, turnSeq: row.turnSeq,
    source: row.source, name: row.name, durationMs, durationState, tokenState,
    tokens: row.tokenKind ? { value: tokenValue, kind: row.tokenKind, availability: tokenValue === null ? "unavailable" : "recorded" } : null, refs };
}
