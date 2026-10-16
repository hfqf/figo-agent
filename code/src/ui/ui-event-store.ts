import type { StorageManager } from "../storage/storage-manager.js";
import { nowShanghaiTime } from "../utils/clock.js";
import { createId } from "../utils/id.js";

export interface UiEvent {
  seq: number;
  eventId: string;
  runId?: string;
  sessionId: string;
  taskId?: string;
  turnId?: string;
  kind: string;
  subjectId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type UiEventInput = Omit<UiEvent, "seq" | "eventId" | "createdAt">;

export class UiEventStore {
  private readonly subscribers = new Set<(event: UiEvent) => void>();

  constructor(private readonly storage: StorageManager) {}

  appendWithinTransaction(input: UiEventInput): UiEvent {
    const eventId = createId("uie");
    const createdAt = nowShanghaiTime();
    const result = this.storage.db.prepare(
      "insert into ui_events (event_id, run_id, session_id, task_id, turn_id, kind, subject_id, payload_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(eventId, input.runId ?? null, input.sessionId, input.taskId ?? null, input.turnId ?? null,
      input.kind, input.subjectId ?? null, JSON.stringify(input.payload), createdAt);
    return { ...input, seq: Number(result.lastInsertRowid), eventId, createdAt };
  }

  append(input: UiEventInput): UiEvent {
    const event = this.appendWithinTransaction(input);
    this.publish(event);
    return event;
  }

  publish(event: UiEvent): void {
    for (const subscriber of this.subscribers) {
      try { subscriber(event); } catch { /* A disconnected observer cannot undo committed state. */ }
    }
  }

  subscribe(subscriber: (event: UiEvent) => void): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  replay(afterSeq: number, limit = 500): UiEvent[] {
    const rows = this.storage.db.prepare(
      "select * from ui_events where seq > ? order by seq limit ?"
    ).all(afterSeq, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      seq: Number(row.seq), eventId: String(row.event_id),
      runId: row.run_id ? String(row.run_id) : undefined,
      sessionId: String(row.session_id), taskId: row.task_id ? String(row.task_id) : undefined,
      turnId: row.turn_id ? String(row.turn_id) : undefined, kind: String(row.kind),
      subjectId: row.subject_id ? String(row.subject_id) : undefined,
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, createdAt: String(row.created_at)
    }));
  }

  recent(taskId: string | null, limit = 200): UiEvent[] {
    const rows = this.storage.db.prepare(
      `select * from ui_events where (? is null or task_id = ?) order by seq desc limit ?`
    ).all(taskId, taskId, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => ({
      seq: Number(row.seq), eventId: String(row.event_id),
      runId: row.run_id ? String(row.run_id) : undefined,
      sessionId: String(row.session_id), taskId: row.task_id ? String(row.task_id) : undefined,
      turnId: row.turn_id ? String(row.turn_id) : undefined, kind: String(row.kind),
      subjectId: row.subject_id ? String(row.subject_id) : undefined,
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, createdAt: String(row.created_at)
    }));
  }

  taskHistory(taskId: string, limit = 5000): UiEvent[] {
    const rows = this.storage.db.prepare(
      "select * from ui_events where task_id = ? and (kind = 'trace.recorded' or kind in ('assistant.text.delta', 'assistant.text.reset') or kind like 'run.%') order by seq desc limit ?"
    ).all(taskId, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => ({
      seq: Number(row.seq), eventId: String(row.event_id),
      runId: row.run_id ? String(row.run_id) : undefined,
      sessionId: String(row.session_id), taskId: String(row.task_id),
      turnId: row.turn_id ? String(row.turn_id) : undefined, kind: String(row.kind),
      subjectId: row.subject_id ? String(row.subject_id) : undefined,
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, createdAt: String(row.created_at)
    }));
  }

  cursor(): number {
    return Number((this.storage.db.prepare("select coalesce(max(seq), 0) as seq from ui_events").get() as { seq: number }).seq);
  }
}
