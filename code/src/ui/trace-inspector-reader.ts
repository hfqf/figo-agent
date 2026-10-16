import type { SQLInputValue } from "node:sqlite";
import type { TraceInspectorDetail } from "../contracts/trace-inspector.js";
import type { StorageManager } from "../storage/storage-manager.js";
import { redactForUi } from "./ui-redaction.js";
import type { DbRow } from "./trace-inspector-facts.js";

export const detailLimit = 200;
const fieldLimit = 16384;
const responseBudget = 900000;
const readableTables = new Set(["trace_events", "llm_http_captures", "tool_calls", "context_packs", "context_items", "context_messages", "context_compactions", "task_compaction_checkpoints", "artifacts", "ui_events", "token_usage"]);

/** 仅处理受限读取和输出安全；不依赖任何运行态服务。每次详情独立持有限额状态。 */
export class TraceInspectorReader {
  truncated = false;
  readonly limitations = new Set<string>();
  constructor(private readonly storage: StorageManager, private readonly secrets: string[]) {}

  rows(table: string, where: string, params: SQLInputValue[], order = "rowid", limit = detailLimit): DbRow[] {
    if (!readableTables.has(table)) throw new Error("不允许读取该表");
    const columns = this.storage.db.prepare(`pragma table_info(${table})`).all() as { name: string }[];
    const guard = Math.max(128, ...this.secrets.map(secret => secret.length));
    const cap = fieldLimit + guard;
    const identity = (name: string) => name === "id" || name.endsWith("_id") || name.endsWith("_ref");
    const projection = columns.map(({ name }) => identity(name) ? `"${name}"` : `case when typeof("${name}") = 'text' then substr("${name}",1,${cap + 1}) else "${name}" end as "${name}"`).join(",");
    const rows = this.storage.db.prepare(`select ${projection} from ${table} where ${where} order by ${order} limit ?`).all(...params, limit + 1) as DbRow[];
    if (rows.length > limit) this.cut(`${table} 集合已截断，仍有记录未返回。`);
    return rows.slice(0, limit).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
      if (typeof value !== "string") return [key, value];
      if (identity(key)) return [key, value];
      const clipped = value.length > fieldLimit;
      if (clipped) this.cut(`${table}.${key} 正文已截断。`);
      if (key.endsWith("_json")) {
        // 不返回被切断或损坏的 JSON 文本，防止未解析的敏感字段绕过递归脱敏。
        if (clipped) return [key, { truncated: true, preview: null }];
        try { return [key, JSON.parse(value)]; }
        catch { this.limitations.add(`${table}.${key} JSON 无法解析，内容不可用。`); return [key, null]; }
      }
      // 在 SQL 护栏片段上先替换完整凭据，保持长度不缩短，避免尾部残片被拉入可见区。
      let safe = value;
      for (const secret of this.secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
        safe = safe.replaceAll(secret, "[REDACTED]".padEnd(secret.length, "*"));
      }
      return [key, redactForUi(safe.slice(0, fieldLimit), this.secrets)];
    })));
  }

  cut(message: string) { this.truncated = true; this.limitations.add(message); }

  finish(value: TraceInspectorDetail): TraceInspectorDetail {
    const safe = redactForUi(value, this.secrets) as TraceInspectorDetail;
    let remaining = responseBudget;
    const take = <T>(entry: T, fallback: T): T => {
      const cost = JSON.stringify(entry).length;
      if (cost <= remaining) { remaining -= cost; return entry; }
      this.cut("详情总响应预算已用尽，剩余条目已截断；关键引用不做部分替换。");
      return fallback;
    };
    const collection = <T>(entries: T[]): T[] => {
      const output: T[] = [];
      for (const entry of entries) {
        const cost = JSON.stringify(entry).length;
        if (cost > remaining) { this.cut("详情总响应预算已用尽，剩余条目已截断；关键引用不做部分替换。"); break; }
        remaining -= cost;
        output.push(entry);
      }
      return output;
    };
    if (JSON.stringify(safe.selection).length + JSON.stringify(safe.row).length > remaining) throw new Error("单个事件的关键引用超过详情响应预算");
    const selection = take(safe.selection, safe.selection);
    const row = take(safe.row, safe.row);
    const captures = collection(safe.captures);
    const compactions = collection(safe.compactions);
    const messages = collection(safe.messages);
    const record = take(safe.record, { truncated: true });
    const context = { pack: take(safe.context.pack, null), items: collection(safe.context.items), checkpoint: take(safe.context.checkpoint, null) };
    return { selection, row, captures, compactions, messages, record, context, events: collection(safe.events), tools: collection(safe.tools),
      legacyCheckpoints: collection(safe.legacyCheckpoints), artifacts: collection(safe.artifacts), limitations: [], truncated: this.truncated };
  }
}
