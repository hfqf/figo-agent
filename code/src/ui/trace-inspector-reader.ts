import type { SQLInputValue } from "node:sqlite";
import type { TraceInspectorDetail } from "../contracts/trace-inspector.js";
import type { StorageManager } from "../storage/storage-manager.js";
import { redactForUi } from "./ui-redaction.js";
import type { DbRow } from "./trace-inspector-facts.js";
import { defaultTraceInspectorSettings, type TraceInspectorSettings } from "../config/trace-inspector-settings.js";
import { previewField } from "./trace-inspector-fields.js";

const readableTables = new Set(["trace_events", "llm_http_captures", "tool_calls", "context_packs", "context_items", "context_messages", "context_compactions", "task_compaction_checkpoints", "artifacts", "ui_events", "token_usage"]);
const bodyColumns: Record<string, readonly string[]> = {
  trace_events: ["payload_json"], ui_events: ["payload_json"],
  llm_http_captures: ["request_headers_json", "request_body_json", "response_headers_json", "response_body_json"],
  tool_calls: ["input_json", "output_json"], context_items: ["content", "summary", "reason"],
  context_messages: ["message_json"], context_compactions: ["summary_markdown"], task_compaction_checkpoints: ["summary_json"]
};

/** 仅处理受限读取和输出安全；不依赖任何运行态服务。每次详情独立持有限额状态。 */
export class TraceInspectorReader {
  truncated = false;
  readonly limitations = new Set<string>();
  constructor(private readonly storage: StorageManager, private readonly secrets: string[],
    private readonly settings: TraceInspectorSettings = defaultTraceInspectorSettings) {}

  rows(table: string, where: string, params: SQLInputValue[], order = "rowid", limit = this.settings.detailCollectionLimit): DbRow[] {
    if (!readableTables.has(table)) throw new Error("不允许读取该表");
    const columns = this.storage.db.prepare(`pragma table_info(${table})`).all() as { name: string }[];
    const cap = this.settings.maxFieldChars;
    const identity = (name: string) => name === "id" || name.endsWith("_id") || name.endsWith("_ref");
    const projection = columns.map(({ name }) => identity(name) ? `"${name}"` : `case when typeof("${name}") = 'text' then substr("${name}",1,${cap + 1}) else "${name}" end as "${name}"`).join(",");
    const rows = this.storage.db.prepare(`select ${projection} from ${table} where ${where} order by ${order} limit ?`).iterate(...params, limit + 1);
    const output: DbRow[] = [];
    for (const raw of rows) {
      if (output.length === limit) { this.cut(`${table} 集合已截断，仍有记录未返回。`); break; }
      const row = raw as DbRow;
      output.push(Object.fromEntries(Object.entries(row).map(([key, value]) => {
      if (typeof value !== "string") return [key, value];
      if (identity(key)) return [key, value];
      const body = bodyColumns[table]?.includes(key) ?? false;
      if (value.length > cap) {
        this.cut(`${table}.${key} 超过字段读取上限，正文未完整返回。`);
        return [key, body ? { truncated: true, preview: null } : null];
      }
      if (key.endsWith("_json")) {
        let parsed: unknown;
        try { parsed = JSON.parse(value); }
        catch { this.limitations.add(`${table}.${key} JSON 无法解析，内容不可用。`); return [key, null]; }
        try { return [key, previewField(parsed, table, key, row, this.settings, this.secrets, !body)]; }
        catch (error) {
          if (error instanceof Error && error.message.includes("嵌套深度超过读取上限")) this.cut(`${table}.${key} 嵌套深度超过读取上限，内容未返回。`);
          else this.limitations.add(`${table}.${key} 预览不可用，内容未返回。`);
          return [key, null];
        }
      }
      return [key, body ? previewField(value, table, key, row, this.settings, this.secrets) : redactForUi(value, this.secrets)];
      })));
    }
    return output;
  }

  cut(message: string) { this.truncated = true; this.limitations.add(message); }

  finish(value: TraceInspectorDetail): TraceInspectorDetail {
    const safe = redactForUi(value, this.secrets) as TraceInspectorDetail;
    const budgetMessage = "详情总响应预算已用尽，剩余条目已截断；关键引用不做部分替换。";
    const shell = { selection: safe.selection, row: safe.row, record: { truncated: true },
      context: { pack: null, items: [], checkpoint: null }, captures: [], compactions: [], messages: [], events: [], tools: [],
      legacyCheckpoints: [], artifacts: [], limitations: [...new Set([...this.limitations, budgetMessage])], truncated: false };
    let remaining = this.settings.responseBudgetChars - JSON.stringify(shell).length;
    if (remaining < 0) throw new Error("单个事件的关键引用与范围说明超过详情响应预算");
    const take = <T>(entry: T, fallback: T): T => {
      const cost = JSON.stringify(entry).length;
      if (cost <= remaining) { remaining -= cost; return entry; }
      this.cut(budgetMessage);
      return fallback;
    };
    const collection = <T>(entries: T[]): T[] => {
      const output: T[] = [];
      for (const entry of entries) {
        const cost = JSON.stringify(entry).length + 1;
        if (cost > remaining) { this.cut(budgetMessage); break; }
        remaining -= cost;
        output.push(entry);
      }
      return output;
    };
    const selection = safe.selection;
    const row = safe.row;
    const captures = collection(safe.captures);
    const compactions = collection(safe.compactions);
    const messages = collection(safe.messages);
    const record = take(safe.record, { truncated: true });
    const context = { pack: take(safe.context.pack, null), items: collection(safe.context.items), checkpoint: take(safe.context.checkpoint, null) };
    return { selection, row, captures, compactions, messages, record, context, events: collection(safe.events), tools: collection(safe.tools),
      legacyCheckpoints: collection(safe.legacyCheckpoints), artifacts: collection(safe.artifacts), limitations: [...this.limitations], truncated: this.truncated };
  }
}
