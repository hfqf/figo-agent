import type { StorageManager } from "../storage/storage-manager.js";

export interface TaskHistoryTurn {
  id: string;
  seq: number;
  status: string;
  content: string;
}

type TurnRow = { id: string; task_seq: number; status: string; input: string };
type CaptureRow = { request_body_json: string; response_body_json: string };

export class TaskHistoryReader {
  constructor(private readonly storage: StorageManager) {}

  sequenceOf(turnId: string): number | undefined {
    const row = this.storage.db.prepare("select task_seq from turns where id = ?").get(turnId) as { task_seq: number | null } | undefined;
    return row?.task_seq ?? undefined;
  }

  list(taskId: string, beforeSeq?: number): TaskHistoryTurn[] {
    const turns = this.storage.db.prepare(
      "select id, task_seq, status, input from turns where task_id = ? and task_seq is not null and (? is null or task_seq < ?) order by task_seq"
    ).all(taskId, beforeSeq ?? null, beforeSeq ?? null) as TurnRow[];
    return turns.map((turn) => ({ id: turn.id, seq: turn.task_seq, status: turn.status, content: this.content(turn) }));
  }

  private content(turn: TurnRow): string {
    const captures = this.storage.db.prepare(
      "select request_body_json, response_body_json from llm_http_captures where turn_id = ? and purpose = 'turn' order by created_at, rowid"
    ).all(turn.id) as CaptureRow[];
    const results: unknown[] = [];
    const resultKeys = new Set<string>();
    let answer = "";
    for (const capture of captures) {
      const request = parseJson(capture.request_body_json);
      if (isRecord(request) && Array.isArray(request.messages)) {
        for (const message of request.messages) {
          if (!isRecord(message) || typeof message.content !== "string") continue;
          const content = parseJson(message.content);
          if (isRecord(content) && content.type === "tool_results" && Array.isArray(content.results)) {
            for (const result of content.results) {
              const key = JSON.stringify(result);
              if (resultKeys.has(key)) continue;
              resultKeys.add(key);
              results.push(result);
            }
          }
        }
      }
      const response = parseJson(capture.response_body_json);
      if (isRecord(response)) {
        if (typeof response.content === "string") answer = response.content;
        else if (Array.isArray(response.choices)) {
          const choice = response.choices[0];
          if (isRecord(choice) && isRecord(choice.message) && typeof choice.message.content === "string") {
            answer = choice.message.content;
          }
        }
      }
    }
    const parts = [`状态：${turn.status}`, `用户输入：\n${turn.input}`];
    if (results.length) parts.push(`工具结果：\n${JSON.stringify({ type: "tool_results", results }, null, 2)}`);
    if (answer) parts.push(`助手回答：\n${answer}`);
    return parts.join("\n\n");
  }
}

function parseJson(content: string): unknown {
  try { return JSON.parse(content); } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
