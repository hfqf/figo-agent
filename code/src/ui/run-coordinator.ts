import type { AgentKernel } from "../kernel/agent-kernel.js";
import { createHash } from "node:crypto";
import type { ContextFileReference, ModelSelection, Turn } from "../contracts/types.js";
import { nowShanghaiTime } from "../utils/clock.js";
import { createId } from "../utils/id.js";
import { UiEventStore, type UiEvent } from "./ui-event-store.js";
import { WorkspaceRunLease, isProcessAlive } from "./workspace-run-lease.js";

export type RunStatus = "accepted" | "running" | "completed" | "failed" | "interrupted";

export interface UiRun {
  runId: string;
  turnId: string;
  sessionId: string;
  taskId: string;
  clientRequestId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
  providerId?: string;
  modelId?: string;
}

export interface SubmitRun {
  taskId: string;
  input: string;
  clientRequestId: string;
  fileReferences?: ContextFileReference[];
  modelSelection?: ModelSelection;
}

export class RunCoordinator {
  readonly events: UiEventStore;
  private activePromise: Promise<void> | undefined;
  private readonly unsubscribeTrace: () => void;

  constructor(private readonly kernel: AgentKernel) {
    this.events = new UiEventStore(kernel.storage);
    this.recoverInterrupted();
    this.unsubscribeTrace = kernel.onTraceEvent((event) => {
      if (!event.turnId) return;
      const row = kernel.storage.db.prepare("select run_id from ui_runs where turn_id = ?").get(event.turnId) as { run_id: string } | undefined;
      if (!row) return;
      this.events.append({
        runId: row.run_id, sessionId: event.sessionId, taskId: event.taskId, turnId: event.turnId,
        kind: "trace.recorded", subjectId: event.id,
        payload: {
          type: event.type, source: event.source,
          ...pickActivityFields(event.payload)
        }
      });
    });
  }

  close(): void { this.unsubscribeTrace(); }

  submit(command: SubmitRun): UiRun {
    const db = this.kernel.storage.db;
    const requestedSelection = command.modelSelection ? this.kernel.validateModelSelection(command.modelSelection) : undefined;
    const defaultSelection = this.kernel.defaultModelSelection();
    const defaultProvider = this.kernel.modelConfigs().find((entry) => entry.id === defaultSelection.providerId);
    const modelSelection = requestedSelection ?? (defaultProvider?.apiKey.trim() ? defaultSelection : undefined);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      taskId: command.taskId, input: command.input, fileReferences: command.fileReferences ?? [], modelSelection: requestedSelection ?? null
    })).digest("hex");
    const already = db.prepare("select * from ui_runs where client_request_id = ?").get(command.clientRequestId) as RunRow | undefined;
    if (already) {
      const input = db.prepare("select input from turns where id = ?").get(already.turn_id) as { input: string };
      if (already.task_id !== command.taskId || input.input !== command.input ||
          (already.request_hash && already.request_hash !== fingerprint)) throw new Error("幂等键已用于其他请求。");
      return toRun(already);
    }
    const current = db.prepare("select run_id from ui_runs where status in ('accepted', 'running') limit 1")
      .get() as { run_id: string } | undefined;
    if (current) throw new Error(`已有活动 Run：${current.run_id}`);
    const runId = createId("run");
    const release = new WorkspaceRunLease(this.kernel.storage).acquire(runId);
    let transactionStarted = false;
    let run: UiRun;
    let turn: Turn | undefined;
    let accepted: UiEvent | undefined;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const existing = db.prepare("select * from ui_runs where client_request_id = ?").get(command.clientRequestId) as RunRow | undefined;
      if (existing) {
        const previous = db.prepare("select input from turns where id = ?").get(existing.turn_id) as { input: string };
        if (existing.task_id !== command.taskId || previous.input !== command.input ||
            (existing.request_hash && existing.request_hash !== fingerprint)) {
          throw new Error("幂等键已用于其他请求。");
        }
        run = toRun(existing);
      } else {
        const active = db.prepare("select run_id from ui_runs where status in ('accepted', 'running') limit 1").get() as { run_id: string } | undefined;
        if (active) throw new Error(`已有活动 Run：${active.run_id}`);
        turn = this.kernel.createTurnWithinTransaction(command.taskId, command.input);
        turn.fileReferences = command.fileReferences;
        const now = nowShanghaiTime();
        run = {
          runId, turnId: turn.id, sessionId: this.kernel.session.id,
          taskId: command.taskId, clientRequestId: command.clientRequestId,
          status: "accepted", createdAt: now, updatedAt: now,
          providerId: modelSelection?.providerId, modelId: modelSelection?.modelId
        };
        db.prepare("insert into ui_runs (run_id, turn_id, session_id, task_id, client_request_id, request_hash, model_provider_id, model_id, owner_pid, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(run.runId, run.turnId, run.sessionId, run.taskId, run.clientRequestId, fingerprint, modelSelection?.providerId ?? null, modelSelection?.modelId ?? null, process.pid, run.status, now, now);
        accepted = this.events.appendWithinTransaction(this.eventInput(run, "run.accepted"));
      }
      db.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) db.exec("ROLLBACK");
      release();
      throw error;
    }
    if (accepted) this.events.publish(accepted);
    if (turn) {
      const pending = turn;
      queueMicrotask(() => {
        const execution = this.execute(run, pending).finally(release);
        execution.catch(() => {});
        this.activePromise = execution;
      });
    } else {
      release();
    }
    return run;
  }

  getRun(runId: string): UiRun {
    const row = this.kernel.storage.db.prepare("select * from ui_runs where run_id = ?").get(runId) as RunRow | undefined;
    if (!row) throw new Error("Run 不存在。");
    return toRun(row);
  }

  async waitForIdle(): Promise<void> {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await this.activePromise;
  }

  private async execute(run: UiRun, turn: Turn): Promise<void> {
    let pending = "";
    let offset = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (!pending) return;
      const text = pending;
      pending = "";
      this.events.append({
        runId: run.runId, sessionId: run.sessionId, taskId: run.taskId, turnId: run.turnId,
        kind: "assistant.text.delta", payload: { text, offset, sourceLength: text.length }
      });
      offset += text.length;
    };
    const onTextDelta = (delta: string) => {
      pending += delta;
      if (pending.length >= 512) {
        if (timer) clearTimeout(timer);
        flush();
      } else if (!timer) timer = setTimeout(flush, 100);
    };
    try {
      this.updateStatus(run, "running");
      const result = await this.kernel.runPreparedTurn(turn, onTextDelta, run.providerId && run.modelId ? { providerId: run.providerId, modelId: run.modelId } : undefined);
      if (timer) clearTimeout(timer);
      flush();
      this.updateStatus(run, result.status, result.status === "failed" ? "Turn 执行失败，请查看 Trace。" : undefined, result.message);
    } catch (error) {
      if (timer) clearTimeout(timer);
      flush();
      const current = this.getRun(run.runId);
      if (current.status === "accepted" || current.status === "running") {
        this.updateStatus(run, "failed", "Turn 执行失败，请查看 Trace。", "Turn 执行失败。");
      }
    }
  }

  private updateStatus(run: UiRun, status: RunStatus, errorMessage?: string, output?: string): void {
    const db = this.kernel.storage.db;
    db.exec("BEGIN IMMEDIATE");
    let event: UiEvent;
    try {
      const now = nowShanghaiTime();
      db.prepare("update ui_runs set status = ?, updated_at = ?, error_message = ? where run_id = ?")
        .run(status, now, errorMessage ?? null, run.runId);
      if (status === "running") {
        db.prepare("update turns set status = 'processing' where id = ?").run(run.turnId);
      } else if (status === "completed" || status === "failed" || status === "interrupted") {
        db.prepare("update turns set status = ?, completed_at = ?, output = coalesce(?, output) where id = ?")
          .run(status === "completed" ? "completed" : "failed", now, output ?? null, run.turnId);
      }
      event = this.events.appendWithinTransaction(this.eventInput(run, `run.${status}`, errorMessage));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    this.events.publish(event);
  }

  private recoverInterrupted(): void {
    const db = this.kernel.storage.db;
    const old = db.prepare("select * from ui_runs where status in ('accepted', 'running')").all() as RunRow[];
    for (const row of old) {
      if (isProcessAlive(row.owner_pid)) continue;
      const run = toRun(row);
      this.updateStatus(run, "interrupted", "服务已重启，未自动重放 Agent 操作。");
    }
  }

  private eventInput(run: UiRun, kind: string, errorMessage?: string) {
    return {
      runId: run.runId, sessionId: run.sessionId, taskId: run.taskId, turnId: run.turnId,
      kind, subjectId: run.runId, payload: { ...(run.providerId ? { providerId: run.providerId, modelId: run.modelId } : {}), ...(errorMessage ? { errorMessage } : {}) }
    };
  }
}

function pickActivityFields(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["round", "tool", "toolCallId", "callCount", "status", "mode"]) {
    const value = payload[key];
    if (typeof value === "string" || typeof value === "number") result[key] = value;
  }
  return result;
}

type RunRow = {
  run_id: string; turn_id: string; session_id: string; task_id: string;
  client_request_id: string; status: RunStatus; created_at: string; updated_at: string;
  error_message: string | null;
  owner_pid: number | null;
  request_hash: string | null;
  model_provider_id: string | null;
  model_id: string | null;
};

function toRun(row: RunRow): UiRun {
  return {
    runId: row.run_id, turnId: row.turn_id, sessionId: row.session_id, taskId: row.task_id,
    clientRequestId: row.client_request_id, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, errorMessage: row.error_message ?? undefined,
    providerId: row.model_provider_id ?? undefined, modelId: row.model_id ?? undefined
  };
}
