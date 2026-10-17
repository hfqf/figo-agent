import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { StorageManager } from "../storage/storage-manager.js";
import type { InspectorRelation, ObservedNumber, TraceInspectorCategory, TraceInspectorDetail, TraceInspectorDetailSelection, TraceInspectorEventPage, TraceInspectorListOptions, TraceInspectorSelection } from "../contracts/trace-inspector.js";
import { categories, factsSql, factTables, jsonField, parseEventKey, statusSql, toEventRow, toolDurationSql, type DbRow } from "./trace-inspector-facts.js";
import { TraceInspectorReader } from "./trace-inspector-reader.js";
import { WorkspaceQueryService } from "./workspace-query-service.js";
import { redactForUi } from "./ui-redaction.js";
import { defaultTraceInspectorSettings, type TraceInspectorSettings } from "../config/trace-inspector-settings.js";
import type { InspectorFieldSelection } from "../contracts/trace-inspector-field.js";
import { readInspectorField } from "./trace-inspector-fields.js";
import { zhCN } from "../i18n/catalog.js";

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const object = (value: unknown): DbRow => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const observed = (value: unknown, source: unknown): ObservedNumber => ({ value: typeof value === "number" ? value : null,
  kind: source === "usage" || source === "usage_plus_estimate" ? "usage_plus_estimate" : source === "estimate" ? "estimate" : "unknown",
  availability: typeof value === "number" ? "recorded" : "unavailable" });
const placeholders = (values: unknown[]) => values.map(() => "?").join(",") || "null";
const associationLimit = 1000;
const entryRef = (payload: DbRow) => text(payload.compactionEntryId) ?? text(payload.checkpointId);
const facts = `with facts as (${factsSql}), normalized as (select *, ${statusSql} as status from facts)`;
const groupSql = {
  llm: "(category = 'capture' or (category = 'trace' and (substr(kind,1,4) = 'llm.' or substr(kind,1,9) = 'protocol.')))",
  tool: "(category = 'tool' or (category = 'trace' and (substr(kind,1,5) = 'tool.' or substr(kind,1,7) = 'policy.')))",
  context: "(category in ('context','message') or (category = 'trace' and (substr(kind,1,8) = 'context.' or substr(kind,1,7) = 'memory.' or substr(kind,1,5) = 'file.' or substr(kind,1,13) = 'task.history.')))",
  compaction: "(category in ('compaction','legacy-compaction') or (category = 'trace' and instr(kind,'compaction') > 0))"
};
export const traceInspectorPageBudgetError = zhCN.traceInspector.pageBudgetExceeded;

interface Cursor { v: number; task: string; filter: string; time: string; rank: number; rid: number }

/** Task 和 Session 必须同时匹配；NULL Task 也不是跨 Session 的共同归组。 */
function sessionScope(taskId: string | null, sessionId: string | null): { sql: string; params: SQLInputValue[] } {
  return { sql: "task_id is ? and session_id is ?", params: [taskId, sessionId] };
}

/** 各组查询关联最多一千个，保证重复绑定后仍远低于 SQLite 参数上限。 */
function boundedReferences(reader: TraceInspectorReader, values: Iterable<string>, label: string): string[] {
  const refs = new Set<string>();
  for (const value of values) {
    if (refs.has(value)) continue;
    if (refs.size === associationLimit) {
      reader.cut(`${label}关联超过 ${associationLimit} 项，查询关联已截断；未返回的来源不能视为完整结果。`);
      break;
    }
    refs.add(value);
  }
  return [...refs];
}

export class TraceInspectorQueryService {
  constructor(private readonly storage: StorageManager, private readonly secrets: string[] = [],
    private readonly settings: TraceInspectorSettings = defaultTraceInspectorSettings) {}

  field(eventKey: string, selection: InspectorFieldSelection) {
    return readInspectorField(this.storage, this.secrets, this.settings, eventKey, selection);
  }
  listEvents(taskId: string, options: TraceInspectorListOptions = {}): TraceInspectorEventPage {
    const limit = options.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("无效列表数量");
    const selected = options.category === undefined ? categories : Array.isArray(options.category) ? options.category : [options.category];
    if (selected.some(category => !categories.includes(category))) throw new Error("无效事件类别");
    if (options.q !== undefined && (typeof options.q !== "string" || options.q.length > 500)) throw new Error("无效搜索文本");
    if (options.failed !== undefined && typeof options.failed !== "boolean") throw new Error("无效失败筛选");
    if (options.latest !== undefined && typeof options.latest !== "boolean") throw new Error("无效尾窗口参数");
    if (options.latest && options.cursor !== undefined) throw new Error("尾窗口不能与游标混用");
    const paged = options.page !== undefined;
    if (paged && (!Number.isSafeInteger(options.page) || options.page! < 1)) throw new Error("无效分页参数");
    if (paged && (options.cursor !== undefined || options.latest)) throw new Error("分页不能与游标或尾窗口混用");
    if (options.group !== undefined && !Object.hasOwn(groupSql, options.group)) throw new Error("无效事件分组");
    const filterValues: unknown[] = [categories.filter(c => selected.includes(c)), options.failed ?? false, options.q ?? ""];
    // 无 group 时保持既有游标指纹，升级前的 keyset 游标仍可使用。
    if (options.group !== undefined) filterValues.push(options.group);
    const filter = createHash("sha256").update(JSON.stringify(filterValues)).digest("hex");
    const legacySessionId = new WorkspaceQueryService(this.storage, this.secrets).legacySessionId(taskId);
    const where = [legacySessionId ? "taskId is null and sessionId = ?" : "taskId = ?", `category in (${placeholders(selected)})`];
    const params: SQLInputValue[] = [legacySessionId ?? taskId, ...selected];
    if (options.group !== undefined) where.push(groupSql[options.group]);
    if (options.failed) where.push("status in ('error','denied','interrupted')");
    if (options.q) {
      where.push("instr(lower(coalesce(kind,'') || ' ' || coalesce(name,'') || ' ' || coalesce(source,'') || ' ' || coalesce(turnId,'') || ' ' || coalesce(id,'') || ' ' || coalesce(requestId,'') || ' ' || coalesce(contextPackId,'') || ' ' || coalesce(searchPath,'')), lower(?)) > 0");
      params.push(options.q);
    }
    const { totalCount } = this.storage.db.prepare(`${facts} select count(*) as totalCount from normalized where ${where.join(" and ")}`)
      .get(...params) as { totalCount: number };
    const size = Math.min(limit, 500);
    const totalPages = Math.ceil(totalCount / size);
    const effectivePage = totalCount === 0 ? 0 : Math.min(options.page ?? 1, totalPages);
    const offset = effectivePage > 0 ? (effectivePage - 1) * size : 0;
    if (options.cursor !== undefined) {
      const cursor = this.cursor(options.cursor, taskId, filter);
      where.push("(time,rank,rid) > (?,?,?)");
      params.push(cursor.time, cursor.rank, cursor.rid);
    }
    const order = options.latest ? "time desc,rank desc,rid desc" : "time,rank,rid";
    const rows = this.storage.db.prepare(`${facts} select * from normalized where ${where.join(" and ")} order by ${order} limit ?${paged ? " offset ?" : ""}`)
      .all(...params, paged ? size : size + 1, ...(paged ? [offset] : [])) as DbRow[];
    const page: DbRow[] = [];
    const events: TraceInspectorEventPage["events"] = [];
    let remaining = 800000;
    for (const raw of rows.slice(0, size)) {
      const event = redactForUi(toEventRow(raw), this.secrets) as TraceInspectorEventPage["events"][number];
      const cost = JSON.stringify(event).length;
      if (cost > remaining) {
        if (paged) throw new Error(traceInspectorPageBudgetError);
        if (!page.length) throw new Error("单个事件的关键引用超过只读响应预算");
        break;
      }
      remaining -= cost;
      page.push(raw);
      events.push(event);
    }
    const hasMore = paged ? effectivePage < totalPages : rows.length > page.length;
    if (options.latest) { page.reverse(); events.reverse(); }
    const last = page.at(-1);
    const endCursor = last ? Buffer.from(JSON.stringify({ v: 1, task: taskId, filter, time: last.time, rank: last.rank, rid: last.rid })).toString("base64url") : null;
    const nextCursor = hasMore && !options.latest ? endCursor : null;
    const pagination = { totalCount, page: paged ? effectivePage : null, totalPages: paged ? totalPages : null, pageSize: size,
      from: paged ? events.length ? offset + 1 : 0 : options.latest ? events.length ? totalCount - events.length + 1 : 0 : null,
      to: paged ? events.length ? offset + events.length : 0 : options.latest ? events.length ? totalCount : 0 : null };
    const result = redactForUi({ events, nextCursor, endCursor, hasMore, pagination,
      truncated: hasMore || page.some(row => [row.name, row.kind, row.source, row.searchPath].some(value => typeof value === "string" && value.length >= 513)) }, this.secrets) as TraceInspectorEventPage;
    if (paged && JSON.stringify(result).length > 800000) throw new Error(traceInspectorPageBudgetError);
    return result;
  }

  detail(eventKey: string, selected: TraceInspectorDetailSelection = {}): TraceInspectorDetail {
    const { category, id } = parseEventKey(eventKey);
    const raw = this.storage.db.prepare(`${facts} select * from normalized where category = ? and id = ?`).get(category, id) as DbRow | undefined;
    if (!raw) throw new Error("事件不存在");
    const row = toEventRow(raw);
    const taskId = row.taskId;
    const turnId = row.turnId;
    const owner = sessionScope(taskId, row.sessionId);
    const reader = new TraceInspectorReader(this.storage, this.secrets, this.settings);
    reader.limitations.add("同毫秒跨表排序只保证稳定展示，不表示因果。scope_only 仅表示同一范围。");
    const spec = factTables[category];
    const record = reader.rows(spec.table, `${spec.id} = ?`, [id], "rowid", 1)[0];
    const rootPayload = object(record.payload_json);
    const directRequest = category === "capture" ? text(record.request_id) : category === "trace" || category === "ui" ? text(rootPayload.requestId) ?? row.refs.requestId ?? null : null;
    const requestId = selected.requestId ?? directRequest;
    const directEntry = category === "compaction" ? id : entryRef(rootPayload) ?? row.refs.compactionEntryId ?? null;
    let compactionEntryId = selected.compactionEntryId ?? directEntry;
    for (const [name, value] of Object.entries(selected)) {
      if (!["requestId", "compactionEntryId"].includes(name) || (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > 4096))) throw new Error("无效详情选择");
    }
    if (selected.requestId) {
      // 根引用可证明请求存在；仅在全库尚无抓包时降级，已有抓包仍须验证归属。
      const missingDirectRequest = selected.requestId === row.refs.requestId &&
        !this.storage.db.prepare("select 1 from llm_http_captures where request_id = ? limit 1").get(selected.requestId);
      if (!missingDirectRequest) this.assertTask("llm_http_captures", "request_id", selected.requestId, taskId, row.sessionId);
    }
    if (selected.compactionEntryId) {
      const matchesRoot = selected.compactionEntryId === directEntry;
      const entry = this.storage.db.prepare("select task_id from context_compactions where id = ?").get(selected.compactionEntryId);
      const legacy = matchesRoot && !entry ? this.storage.db.prepare("select task_id from task_compaction_checkpoints where id = ?")
        .get(selected.compactionEntryId) as { task_id: string } | undefined : undefined;
      // 兼容只适用于根引用；已有新条目不能借同名旧记录绕过归属校验。
      const missingOrLegacyRoot = matchesRoot && !entry && (!legacy || legacy.task_id === taskId);
      if (!missingOrLegacyRoot) this.assertTask("context_compactions", "id", selected.compactionEntryId, taskId, row.sessionId);
    }
    if (requestId && !this.belongs("llm_http_captures", "request_id", requestId, taskId, row.sessionId)) reader.limitations.add("所选请求抓包缺失或尚未落库，只展示已有调用证据。");
    if (compactionEntryId && !this.belongs("context_compactions", "id", compactionEntryId, taskId, row.sessionId)) {
      const legacy = this.storage.db.prepare("select 1 from task_compaction_checkpoints where id = ? and task_id is ?").get(compactionEntryId, taskId);
      if (legacy) {
        compactionEntryId = null;
        reader.limitations.add("根引用对应旧 JSON 检查点，按历史格式展示，不作为消息级压缩条目。");
      }
      else reader.limitations.add("事件引用的成功摘要条目缺失或归属错误，不能认定已持久化成功。");
    }

    // 精确读取 llm.called；决不以同 Turn、文字相同或 latestEntry 推测请求投影。
    const called = requestId ? reader.rows("trace_events", `${owner.sql} and type = 'llm.called' and ${jsonField("payload_json", "requestId")} = ?`, [...owner.params, requestId], "created_at,rowid", 2) : [];
    const callPayload = object(called[0]?.payload_json);
    const p = object(callPayload.projection);
    const projectionRecorded = called.length === 1 && Array.isArray(p.sourceRefs) && p.sourceRefs.every((ref: unknown) => typeof ref === "string") && typeof p.usageScope === "string" && (p.compactionEntryId === null || typeof p.compactionEntryId === "string");
    let projection: TraceInspectorSelection["projection"] = projectionRecorded ? { status: "recorded", compactionEntryId: p.compactionEntryId,
      legacyCheckpointId: p.legacyCheckpointId === null || typeof p.legacyCheckpointId === "string" ? p.legacyCheckpointId : undefined,
      sourceRefs: strings(p.sourceRefs), usageScope: p.usageScope } : { status: "unknown", compactionEntryId: null, sourceRefs: [], usageScope: null };
    if (projection.compactionEntryId && !this.belongs("context_compactions", "id", projection.compactionEntryId, taskId, row.sessionId)) {
      reader.limitations.add("请求投影引用的摘要条目缺失或归属错误，来源未知。");
      projection = { status: "unknown", compactionEntryId: null, sourceRefs: [], usageScope: null };
    }
    if (projection.legacyCheckpointId && !this.storage.db.prepare("select 1 from task_compaction_checkpoints where id = ? and task_id is ?").get(projection.legacyCheckpointId, taskId)) {
      reader.limitations.add("请求引用的旧 JSON 检查点缺失或归属错误，不能确定历史摘要来源。");
      projection = { status: "unknown", compactionEntryId: null, legacyCheckpointId: null, sourceRefs: [], usageScope: null };
    }
    if (!compactionEntryId) compactionEntryId = projection.compactionEntryId;
    const compactionAttemptId = text(rootPayload.compactionAttemptId) ?? (category === "compaction" ? text(object(record.details_json).compactionAttemptId) : null);
    const selection: TraceInspectorSelection = { taskId, turnId, requestId, requestAssociation: requestId ? selected.requestId ? "selected" : "direct" : "unknown",
      compactionEntryId, compactionAttemptId, recoveryOfRequestId: text(callPayload.recoveryOfRequestId) ?? text(rootPayload.recoveryOfRequestId),
      contextPackId: text(callPayload.contextPackId) ?? row.refs.contextPackId ?? null, projection };
    if (projection.status === "unknown") reader.limitations.add("所选请求缺少唯一的消息级投影记录，来源未知；实际传输以抓包为准。");
    reader.limitations.add("消息 omitted 是当前记录标记；历史请求仅按当次 projection 解释，不据此倒推。");

    return this.buildDetail(reader, row, record, selection, category, id, text(called[0]?.turn_id) ?? turnId);
  }

  private cursor(encoded: string, task: string, filter: string): Cursor {
    try {
      if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 4096) throw new Error();
      const cursor = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Cursor;
      if (cursor.v !== 1 || cursor.task !== task || cursor.filter !== filter || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(cursor.time) || !Number.isSafeInteger(cursor.rank) || cursor.rank < 0 || cursor.rank >= categories.length || !Number.isSafeInteger(cursor.rid) || cursor.rid < 1) throw new Error();
      return cursor;
    } catch { throw new Error("无效游标或游标不属于当前筛选范围"); }
  }

  private belongs(table: "llm_http_captures" | "context_compactions", key: "request_id" | "id", id: string, taskId: string | null, sessionId: string | null): boolean {
    const owner = table === "llm_http_captures" ? sessionScope(taskId, sessionId) : { sql: "task_id is ?", params: [taskId] };
    return Boolean(this.storage.db.prepare(`select 1 from ${table} where ${key} = ? and ${owner.sql}`).get(id, ...owner.params));
  }
  private assertTask(table: "llm_http_captures" | "context_compactions", key: "request_id" | "id", id: string, taskId: string | null, sessionId: string | null) {
    if (!this.belongs(table, key, id, taskId, sessionId)) throw new Error("所选引用归属无法验证");
  }

  private buildDetail(reader: TraceInspectorReader, row: TraceInspectorDetail["row"], record: DbRow, selection: TraceInspectorSelection, category: TraceInspectorCategory, id: string, contextTurnId: string | null): TraceInspectorDetail {
    const { taskId, turnId, requestId, compactionEntryId, projection } = selection;
    const owner = sessionScope(taskId, row.sessionId);
    const priorityEntries = [...new Set([compactionEntryId, projection.compactionEntryId].filter((value): value is string => Boolean(value)))];
    const seeds = `id in (${placeholders(priorityEntries)}) or id in (
      select coalesce(${jsonField("payload_json", "compactionEntryId")},${jsonField("payload_json", "checkpointId")})
      from trace_events where task_id is ? and turn_id in (?,?)
    ) or request_id = ? or exists (
      select 1 from json_each(case when json_valid(details_json) then details_json else '{}' end, '$.requestIds') where value = ?
    ) or (? is not null and ${jsonField("details_json", "compactionAttemptId")} = ?)`;
    // 显式 base_entry_id 是滚动摘要证据；只沿同 Task 且序号递减的基链读取。
    const ancestry = `with recursive chain(id,base_entry_id,seq) as (
      select id,base_entry_id,seq from context_compactions where task_id is ? and (${seeds})
      union select c.id,c.base_entry_id,c.seq from context_compactions c join chain p on c.id = p.base_entry_id
      where c.task_id is ? and c.seq < p.seq limit ${this.settings.detailCollectionLimit + 1}
    ) select id from chain`;
    const entries = reader.rows("context_compactions", `task_id is ? and id in (${ancestry})`,
      [taskId, taskId, ...priorityEntries, taskId, turnId, contextTurnId, requestId, requestId, selection.compactionAttemptId, selection.compactionAttemptId, taskId, ...priorityEntries],
      `case when id in (${placeholders(priorityEntries)}) then 0 else 1 end,seq`);
    const committedAttempt = selection.compactionAttemptId ? entries.filter(entry => object(entry.details_json).compactionAttemptId === selection.compactionAttemptId) : [];
    if (committedAttempt.length === 1 && !selection.compactionEntryId) {
      selection.compactionEntryId = committedAttempt[0].id;
      priorityEntries.push(committedAttempt[0].id);
    }
    const projectionLineage = new Set<string>();
    let ancestor = entries.find(entry => entry.id === projection.compactionEntryId);
    while (ancestor && !projectionLineage.has(ancestor.id)) {
      projectionLineage.add(ancestor.id);
      ancestor = entries.find(entry => entry.id === ancestor!.base_entry_id && entry.seq < ancestor!.seq);
    }
    const requestIds = (entry: DbRow) => [...new Set([...strings(object(entry.details_json).requestIds), entry.request_id])];
    const selectedEntries = entries.filter(entry => priorityEntries.includes(entry.id));
    const selectedDetails = object(selectedEntries.find(entry => entry.id === selection.compactionEntryId)?.details_json);
    selection.compactionAttemptId ??= text(selectedDetails.compactionAttemptId);
    selection.recoveryOfRequestId ??= text(selectedDetails.recoveryOfRequestId);
    const { compactionAttemptId, recoveryOfRequestId } = selection;
    const summaryIds = boundedReferences(reader, selectedEntries.flatMap(requestIds), "摘要请求");
    const rootPayload = object(record.payload_json);
    // 恢复边来自当次 llm.called 的明确引用，不能依靠同 Turn 猜测重试请求。
    const retryOf = recoveryOfRequestId ?? requestId;
    const retries = retryOf ? reader.rows("trace_events", `${owner.sql} and type = 'llm.called' and ${jsonField("payload_json", "recoveryOfRequestId")} = ?`,
      [...owner.params, retryOf], "created_at,rowid") : [];
    const retryRequestIds = retries.map(event => text(object(event.payload_json).requestId)).filter((value): value is string => Boolean(value));
    const linkedRequests = boundedReferences(reader, [requestId, recoveryOfRequestId, ...retryRequestIds, ...summaryIds, ...strings(rootPayload.requestIds)]
      .filter((value): value is string => Boolean(value)), "请求");
    const related = ["id = ?", "(? is not null and turn_id = ?)", `(? is not null and ${jsonField("payload_json", "requestId")} = ?)`,
      `(? is not null and ${jsonField("payload_json", "compactionAttemptId")} = ?)`,
      `(? is not null and coalesce(${jsonField("payload_json", "compactionEntryId")},${jsonField("payload_json", "checkpointId")}) = ?)`,
      `${jsonField("payload_json", "requestId")} in (${placeholders(summaryIds)})`,
      `${jsonField("payload_json", "requestId")} in (${placeholders(linkedRequests)})`,
      `${jsonField("payload_json", "recoveryOfRequestId")} in (${placeholders(linkedRequests)})`];
    const eventParams: SQLInputValue[] = [...owner.params, category === "trace" ? id : "", turnId, turnId, requestId, requestId,
      compactionAttemptId, compactionAttemptId, compactionEntryId, compactionEntryId, ...summaryIds, ...linkedRequests, ...linkedRequests, category === "trace" ? id : ""];
    const traceRows = reader.rows("trace_events", `${owner.sql} and (${related.join(" or ")})`, eventParams,
      `case when id = ? then 0 else 1 end,created_at,rowid`);
    const directRelation = (event: DbRow): InspectorRelation => {
      const payload = object(event.payload_json);
      if ((category === "trace" && event.id === id) || linkedRequests.includes(payload.requestId) || linkedRequests.includes(payload.recoveryOfRequestId) ||
        (compactionAttemptId && payload.compactionAttemptId === compactionAttemptId) ||
        (compactionEntryId && entryRef(payload) === compactionEntryId) || summaryIds.includes(payload.requestId)) return "direct";
      return turnId && event.turn_id === turnId ? "scope_only" : "unknown";
    };
    const events = traceRows.map(event => ({ id: event.id, type: event.type, source: event.source, turnId: event.turn_id,
      payload: event.payload_json, createdAt: event.created_at, relation: directRelation(event) }));
    const compactions: TraceInspectorDetail["compactions"] = entries.map(entry => {
      const completion = reader.rows("trace_events", `${owner.sql} and type = 'compaction.completed' and coalesce(${jsonField("payload_json", "compactionEntryId")},${jsonField("payload_json", "checkpointId")}) = ?`, [...owner.params, entry.id], "created_at,rowid", 2);
      const completed = object(completion[0]?.payload_json);
      const details = object(entry.details_json);
      return { id: entry.id, taskId: entry.task_id, seq: entry.seq, baseEntryId: entry.base_entry_id,
        firstKeptSourceRef: entry.first_kept_source_ref, coveredSourceRefs: strings(entry.source_refs_json), summaryMarkdown: entry.summary_markdown,
        details: entry.details_json, requestId: entry.request_id, requestIds: requestIds(entry), createdAt: entry.created_at,
        commitStatus: "committed", completionEventStatus: completion.length === 1 ? "recorded" : completion.length === 0 ? "missing" : "unknown",
        tokensBefore: observed(entry.tokens_before, details.estimateSource ?? completed.tokensBeforeSource),
        tokensAfter: observed(completion.length === 1 ? completed.tokensAfter : null, completed.tokensAfterSource),
        relation: priorityEntries.includes(entry.id) || projectionLineage.has(entry.id) ? "direct" : "scope_only" };
    });
    const captureRows = reader.rows("llm_http_captures", `${owner.sql} and ((? is not null and turn_id = ?) or request_id in (${placeholders(linkedRequests)}) or id in (select capture_id from token_usage where ${owner.sql} and usage_turn_id = ?))`,
      [...owner.params, turnId, turnId, ...linkedRequests, ...owner.params, turnId, requestId], "case when request_id = ? then 0 else 1 end,created_at,rowid");
    const captures: TraceInspectorDetail["captures"] = captureRows.map(capture => {
      const usage = reader.rows("token_usage", `capture_id = ? and ${owner.sql}`, [capture.id, ...owner.params], "rowid", 1)[0];
      return { id: capture.id, requestId: capture.request_id, taskId: capture.task_id, turnId: capture.turn_id,
        provider: capture.provider, model: capture.model, purpose: capture.purpose, url: capture.url, method: capture.method,
        requestHeaders: capture.request_headers_json, requestBody: capture.request_body_json,
        responseStatus: capture.response_status, responseStatusText: capture.response_status_text,
        responseHeaders: capture.response_headers_json, responseBody: capture.response_body_json,
        durationMs: capture.duration_ms, createdAt: capture.created_at,
        usage: { status: usage?.status ?? "unavailable", promptTokens: usage?.prompt_tokens ?? null, completionTokens: usage?.completion_tokens ?? null,
          totalTokens: usage?.total_tokens ?? null, usageTurnId: usage?.usage_turn_id ?? null }, relation: linkedRequests.includes(capture.request_id) ? "direct" : "scope_only" };
    });
    const covered = new Set(entries.filter(entry => projectionLineage.has(entry.id)).flatMap(entry => strings(entry.source_refs_json)));
    const messageRefs = boundedReferences(reader, [...(category === "message" ? [id] : []), ...projection.sourceRefs,
      ...selectedEntries.flatMap(entry => [entry.first_kept_source_ref, ...strings(entry.source_refs_json)]), ...covered, ...strings(rootPayload.sourceRefs)], "消息来源");
    const messageRows = reader.rows("context_messages", `task_id is ? and turn_id in (select id from turns where ${owner.sql}) and (turn_id in (?,?) or source_ref in (${placeholders(messageRefs)}))`,
      [taskId, ...owner.params, turnId, contextTurnId, ...messageRefs, ...messageRefs], `case when source_ref in (${placeholders(messageRefs)}) then 0 else 1 end,created_at,rowid`);
    const messages: TraceInspectorDetail["messages"] = messageRows.map(message => {
      const raw = projection.status === "recorded" && projection.sourceRefs.includes(message.source_ref);
      const isCovered = projection.status === "recorded" && covered.has(message.source_ref);
      const match = /^tool:(.+):result$/.exec(message.source_ref);
      const refs = boundedReferences(reader, match ? match[1].split(",") : [], "工具来源");
      const toolRowIds = refs.filter(toolId => Boolean(this.storage.db.prepare("select 1 from tool_calls c join turns t on t.id = c.turn_id where c.id = ? and c.turn_id = ? and t.task_id is ?").get(toolId, message.turn_id, taskId)));
      if (toolRowIds.length < refs.length) reader.limitations.add("部分工具来源引用无对应 ToolCall 记录，不能将 intentId 当作工具记录 ID。");
      return { sourceRef: message.source_ref, turnId: message.turn_id, message: message.message_json,
        usage: message.usage_json, usageScope: message.usage_scope, stopReason: message.stop_reason, omitted: message.omitted === 1,
        state: raw ? "raw" : isCovered ? "covered" : "unknown", stateScope: raw || isCovered ? "selected_request" : "current_record",
        toolRowIds, relation: raw || isCovered || (category === "message" && message.source_ref === id) ? "direct" : "scope_only", createdAt: message.created_at };
    });
    if (projection.sourceRefs.some(ref => !messageRows.some(message => message.source_ref === ref))) reader.limitations.add("请求引用的部分原始消息未返回或已缺失，不能用审计正文或当前工具输出替代。");
    const toolIds = boundedReferences(reader, messages.filter(message => message.relation === "direct").flatMap(message => message.toolRowIds), "工具记录");
    const toolRows = reader.rows("tool_calls", `turn_id in (select id from turns where ${owner.sql}) and (? is not null or session_id is ?) and ((? is not null and turn_id = ?) or id in (${placeholders(toolIds)}) or id = ?)`, [...owner.params, taskId, row.sessionId, turnId, turnId, ...toolIds, category === "tool" ? id : ""]);
    const toolDurations = new Map((this.storage.db.prepare(`select id, ${toolDurationSql("tool_calls")} as durationMs from tool_calls where id in (${placeholders(toolRows)})`)
      .all(...toolRows.map(tool => tool.id)) as DbRow[]).map(tool => [tool.id, tool.durationMs]));
    const tools: TraceInspectorDetail["tools"] = toolRows.map(tool => ({ id: tool.id, intentId: tool.intent_id, turnId: tool.turn_id,
      name: tool.tool_name, round: tool.round, status: tool.status, input: tool.input_json, output: tool.output_json, errorMessage: tool.error_message,
      durationMs: toolDurations.get(tool.id) ?? null,
      durationState: toolDurations.get(tool.id) != null ? "recorded" : ["received", "pending", "running", "started", "processing", "executing"].includes(tool.status) ? "pending" : "not_recorded",
      startedAt: tool.started_at, completedAt: tool.completed_at, relation: toolIds.includes(tool.id) || (category === "tool" && tool.id === id) || row.refs.toolCallId === tool.id ? "direct" : "scope_only" }));
    const legacyCheckpoints: TraceInspectorDetail["legacyCheckpoints"] = reader.rows("task_compaction_checkpoints", "task_id is ?", [taskId]).map(checkpoint => ({
      id: checkpoint.id, taskId: checkpoint.task_id, baseCheckpointId: checkpoint.base_checkpoint_id, fromSeq: checkpoint.from_seq, throughSeq: checkpoint.through_seq,
      sourceTurnIds: strings(checkpoint.source_turn_ids_json), summaryJson: checkpoint.summary_json, requestId: checkpoint.request_id,
      createdAt: checkpoint.created_at, relation: (category === "legacy-compaction" && checkpoint.id === id) || entryRef(rootPayload) === checkpoint.id || projection.legacyCheckpointId === checkpoint.id ? "direct" : "scope_only" }));
    const artifacts = reader.rows("artifacts", `${owner.sql} and (? is null or turn_id = ? or turn_id is null)`, [...owner.params, turnId, turnId]).map(artifact => ({
      id: artifact.id, taskId: artifact.task_id, turnId: artifact.turn_id, type: artifact.type, path: artifact.path, bytes: artifact.bytes,
      createdAt: artifact.created_at, relation: "scope_only" }));
    const context = this.context(reader, contextTurnId, selection.contextPackId, taskId, row.sessionId);
    const result = reader.finish({ selection, row, record, events, context, captures, tools, messages, compactions, legacyCheckpoints, artifacts,
      limitations: [], truncated: false });
    result.limitations = [...reader.limitations];
    result.truncated = reader.truncated;
    return result;
  }

  private context(reader: TraceInspectorReader, turnId: string | null, packId: string | null, taskId: string | null, sessionId: string | null): TraceInspectorDetail["context"] {
    if (!turnId) return { pack: null, items: [], checkpoint: null };
    const owner = sessionScope(taskId, sessionId);
    const turn = this.storage.db.prepare(`select 1 from turns where id = ? and ${owner.sql}`).get(turnId, ...owner.params);
    if (!turn) {
      reader.limitations.add("构建快照的 Turn 不存在或 Task/Session 归属不匹配，来源未知，未读取上下文正文。");
      return { pack: null, items: [], checkpoint: null };
    }
    const pack = reader.rows("context_packs", `${owner.sql} and ${packId ? "id = ? and turn_id = ?" : "turn_id = ?"}`, [...owner.params, ...(packId ? [packId, turnId] : [turnId])], "created_at desc,rowid desc", 1)[0];
    if (!pack) {
      if (packId) reader.limitations.add("构建快照不存在或 ContextPack 的 Task/Session/Turn 归属不匹配，来源未知。");
      return { pack: null, items: [], checkpoint: null };
    }
    const foreignCheckpoint = this.storage.db.prepare("select 1 from context_items i join context_compactions c on i.source_ref = 'task.compaction:' || c.id where i.context_pack_id = ? and c.task_id is not ? limit 1").get(pack.id, taskId);
    if (foreignCheckpoint) reader.limitations.add("构建快照的压缩检查点引用归属不匹配，未读取其他 Task 的摘要边界；条目快照仍按当时记录展示。");
    const stats = this.storage.db.prepare("select count(*) as n, coalesce(sum(length(content)+length(summary)+length(reason)+length(source_ref)),0) as chars, coalesce(max(length(content)),0) as biggest from context_items where context_pack_id = ?").get(pack.id) as DbRow;
    const latest = this.storage.db.prepare("select id from context_packs where turn_id = ? order by created_at desc,rowid desc limit 1").get(turnId) as DbRow;
    const inputSize = this.storage.db.prepare(`select coalesce(max(length(input)),0) as n from turns where ${owner.sql}`).get(...owner.params) as DbRow;
    const refsSize = this.storage.db.prepare("select max(n) as n from (select coalesce(max(length(source_refs_json)),0) as n from context_compactions where task_id is ? union all select coalesce(max(length(source_turn_ids_json)),0) as n from task_compaction_checkpoints where task_id is ?)").get(pack.task_id, pack.task_id) as DbRow;
    if (latest.id === pack.id && stats.n <= this.settings.detailCollectionLimit && stats.chars <= 65536 && stats.biggest <= this.settings.fieldPreviewChars && inputSize.n <= this.settings.fieldPreviewChars && refsSize.n <= this.settings.fieldPreviewChars) {
      try {
        const context = new WorkspaceQueryService(this.storage, this.secrets).context(turnId) as TraceInspectorDetail["context"];
        if (context.pack && context.pack.id === pack.id && context.pack.taskId === taskId && context.pack.sessionId === sessionId && context.pack.turnId === turnId) return context;
        reader.limitations.add("构建快照读取期间归属发生变化，来源未知，已忽略不匹配的上下文。");
        return { pack: null, items: [], checkpoint: null };
      }
      catch { reader.limitations.add("构建快照中的历史检查点 JSON 无法解析，改为限量读取原始条目。"); }
    }
    // 只读持久化快照，不补读原始 Turn 输入；未返回的原始输入长度不代表快照被截断。
    reader.limitations.add("构建快照按指定 ContextPack 限量读取；不代表实际请求的全部消息。");
    const items = reader.rows("context_items", "context_pack_id = ?", [pack.id]).map(item => ({ id: item.id, sourceType: item.source_type, sourceRef: item.source_ref,
      summary: item.summary, content: item.content, estimatedTokens: item.estimated_tokens, included: item.included === 1, reason: item.reason }));
    return { pack: { id: pack.id, sessionId: pack.session_id, taskId: pack.task_id, turnId: pack.turn_id, estimatedTokens: pack.estimated_tokens, createdAt: pack.created_at }, items, checkpoint: null };
  }
}
