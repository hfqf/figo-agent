import type { StorageManager } from "../storage/storage-manager.js";
import { redactForUi } from "./ui-redaction.js";

type Row = Record<string, unknown>;

export class WorkspaceQueryService {
  constructor(private readonly storage: StorageManager, private readonly secrets: string[] = []) {}

  sessions(limit = 100): Row[] {
    const rows = this.storage.db.prepare("select id, cwd, status, started_at as startedAt, ended_at as endedAt from sessions order by started_at desc, rowid desc limit ?")
      .all(Math.min(limit, 100)) as Row[];
    return rows.map((row) => ({ ...row, cwd: redactForUi(row.cwd, this.secrets, this.storage.paths.workspaceRoot) }));
  }

  tasks(sessionId: string): Row[] {
    return this.storage.db.prepare("select id, session_id as sessionId, title, status, created_at as createdAt, updated_at as updatedAt from tasks where session_id = ? order by updated_at desc, rowid desc")
      .all(sessionId) as Row[];
  }

  turns(taskId: string, limit = 200): Row[] {
    const rows = this.storage.db.prepare("select id, session_id as sessionId, task_id as taskId, task_seq as taskSeq, input, output, status, created_at as createdAt, completed_at as completedAt from turns where task_id = ? order by task_seq, rowid limit ?")
      .all(taskId, Math.min(limit, 200)) as Row[];
    return rows.map((row) => ({
      ...row,
      input: redactForUi(row.input, this.secrets, this.storage.paths.workspaceRoot),
      output: redactForUi(row.output, this.secrets, this.storage.paths.workspaceRoot)
    }));
  }

  context(turnId: string): { pack: Row | null; items: Row[]; checkpoint: Row | null } {
    const db = this.storage.db;
    const pack = db.prepare("select id, session_id as sessionId, task_id as taskId, turn_id as turnId, estimated_tokens as estimatedTokens, created_at as createdAt from context_packs where turn_id = ? order by created_at desc, rowid desc limit 1")
      .get(turnId) as Row | undefined;
    if (!pack) return { pack: null, items: [], checkpoint: null };
    const items = db.prepare(`
      select i.id, i.source_type as sourceType, i.source_ref as sourceRef, i.summary, i.content,
             i.estimated_tokens as estimatedTokens, i.included, i.reason,
             t.id as originTurnId, t.task_seq as originTaskSeq,
             t.input as originInput, t.created_at as originCreatedAt
      from context_items i
      left join turns t on t.task_id = ? and (
        (i.source_type = 'turn' and i.source_ref = 'turn.input' and t.id = ?)
        or (i.source_type = 'task_turn' and i.source_ref = 'task.turn:' || t.id)
      )
      where i.context_pack_id = ? order by i.rowid
    `).all(pack.taskId as string, turnId, pack.id as string) as Row[];
    const checkpoint = db.prepare("select c.id, c.from_seq as fromSeq, c.through_seq as throughSeq, c.source_turn_ids_json as sourceTurnIdsJson, c.created_at as createdAt from task_compaction_checkpoints c join turns t on t.id = ? where c.task_id = t.task_id and c.through_seq < t.task_seq and c.created_at <= ? order by c.through_seq desc limit 1")
      .get(turnId, pack.createdAt as string) as Row | undefined;
    return {
      pack,
      items: items.map(({ originTurnId, originTaskSeq, originInput, originCreatedAt, ...item }) => ({
        ...item, included: Boolean(item.included),
        content: redactForUi(item.content, this.secrets, this.storage.paths.workspaceRoot),
        summary: redactForUi(item.summary, this.secrets, this.storage.paths.workspaceRoot),
        originTurn: typeof originTurnId === "string" ? {
          id: originTurnId, taskSeq: originTaskSeq, createdAt: originCreatedAt,
          inputPreview: String(redactForUi(originInput, this.secrets, this.storage.paths.workspaceRoot) ?? "")
            .replace(/\s+/g, " ").trim().slice(0, 100)
        } : null
      })),
      checkpoint: checkpoint ? {
        ...checkpoint, sourceTurnIds: JSON.parse(checkpoint.sourceTurnIdsJson as string), sourceTurnIdsJson: undefined
      } : null
    };
  }

  captures(turnId: string): Row[] {
    const rows = this.storage.db.prepare(`
      select c.*, u.prompt_tokens, u.completion_tokens, u.total_tokens, u.status as usage_status,
             u.usage_turn_id
      from llm_http_captures c left join token_usage u on u.capture_id = c.id
      where c.turn_id = ? or u.usage_turn_id = ? order by c.created_at, c.rowid
    `).all(turnId, turnId) as Row[];
    return rows.map((row) => ({
      id: row.id, sessionId: row.session_id, taskId: row.task_id, turnId: row.turn_id,
      requestId: row.request_id, purpose: row.purpose, provider: row.provider, model: row.model,
      url: redactForUi(row.url, this.secrets, this.storage.paths.workspaceRoot), method: row.method,
      requestHeaders: redactForUi(parseJson(row.request_headers_json), this.secrets, this.storage.paths.workspaceRoot),
      requestBody: redactForUi(parseJson(row.request_body_json), this.secrets, this.storage.paths.workspaceRoot),
      responseStatus: row.response_status, responseStatusText: row.response_status_text,
      responseHeaders: redactForUi(parseJson(row.response_headers_json), this.secrets, this.storage.paths.workspaceRoot),
      responseBody: redactForUi(parseJson(row.response_body_json), this.secrets, this.storage.paths.workspaceRoot),
      durationMs: row.duration_ms, createdAt: row.created_at,
      usage: {
        status: row.usage_status ?? "unavailable", promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens, totalTokens: row.total_tokens,
        usageTurnId: row.usage_turn_id
      }
    }));
  }

  trace(turnId: string): Row[] {
    const rows = this.storage.db.prepare("select id, session_id, task_id, turn_id, type, source, payload_json, created_at from trace_events where turn_id = ? order by created_at, rowid")
      .all(turnId) as Row[];
    return rows.map((row) => ({
      id: row.id, sessionId: row.session_id, taskId: row.task_id, turnId: row.turn_id,
      type: row.type, source: row.source, createdAt: row.created_at,
      payload: redactForUi(parseJson(row.payload_json), this.secrets, this.storage.paths.workspaceRoot)
    }));
  }

  tools(turnId: string): Row[] {
    const rows = this.storage.db.prepare("select * from tool_calls where turn_id = ? order by started_at, rowid")
      .all(turnId) as Row[];
    return rows.map((row) => this.toolRow(row));
  }

  taskTools(taskId: string): Row[] {
    const rows = this.storage.db.prepare("select c.* from tool_calls c join turns t on t.id = c.turn_id where t.task_id = ? order by c.started_at, c.rowid limit 500")
      .all(taskId) as Row[];
    return rows.map((row) => this.toolRow(row));
  }

  private toolRow(row: Row): Row {
    return {
      id: row.id, turnId: row.turn_id, intentId: row.intent_id, round: row.round,
      name: row.tool_name, status: row.status, startedAt: row.started_at, completedAt: row.completed_at,
      input: redactForUi(parseJson(row.input_json), this.secrets, this.storage.paths.workspaceRoot),
      output: redactForUi(parseJson(row.output_json), this.secrets, this.storage.paths.workspaceRoot),
      errorMessage: redactForUi(row.error_message, this.secrets, this.storage.paths.workspaceRoot)
    };
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}
