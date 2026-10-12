import type { AgentKernel } from "../kernel/agent-kernel.js";
import { createHash } from "node:crypto";
import type { ContextFileReference, Turn } from "../contracts/types.js";
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
}

export interface SubmitRun {
  taskId: string;
  input: string;
  clientRequestId: string;
  fileReferences?: ContextFileReference[];
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
        payload: { type: event.type, source: event.source }
      });
    });
  }

  close(): void { this.unsubscribeTrace(); }

  submit(command: SubmitRun): UiRun {
    const db = this.kernel.storage.db;
    const fingerprint = createHash("sha256").update(JSON.stringify({
      taskId: command.taskId, input: command.input, fileReferences: command.fileReferences ?? []
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
          status: "accepted", createdAt: now, updatedAt: now
        };
        db.prepare("insert into ui_runs (run_id, turn_id, session_id, task_id, client_request_id, request_hash, owner_pid, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(run.runId, run.turnId, run.sessionId, run.taskId, run.clientRequestId, fingerprint, process.pid, run.status, now, now);
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
    try {
      this.updateStatus(run, "running");
      const result = await this.kernel.runPreparedTurn(turn);
      this.updateStatus(run, result.status, result.status === "failed" ? "Turn 执行失败，请查看 Trace。" : undefined, result.message);
    } catch (error) {
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
      kind, subjectId: run.runId, payload: errorMessage ? { errorMessage } : {}
    };
  }
}

type RunRow = {
  run_id: string; turn_id: string; session_id: string; task_id: string;
  client_request_id: string; status: RunStatus; created_at: string; updated_at: string;
  error_message: string | null;
  owner_pid: number | null;
  request_hash: string | null;
};

function toRun(row: RunRow): UiRun {
  return {
    runId: row.run_id, turnId: row.turn_id, sessionId: row.session_id, taskId: row.task_id,
    clientRequestId: row.client_request_id, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, errorMessage: row.error_message ?? undefined
  };
}
