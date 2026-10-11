import type { LLMProvider } from "../contracts/types.js";
import type { TraceRecorder } from "../trace/trace-recorder.js";
import { createId } from "../utils/id.js";
import type { RuntimeCompactionConfig } from "../config/runtime-config.js";
import { evaluateCompactionPolicy } from "./compaction-policy.js";
import { parseCompactionSummary } from "./compaction-summary.js";
import type { CompactionSummary } from "./compaction-summary.js";
import type { CompactionStore } from "./compaction-store.js";
import type { TaskHistoryReader, TaskHistoryTurn } from "./task-history-reader.js";

export interface CompactInput {
  sessionId: string;
  taskId: string;
  mode: "manual" | "auto";
  keepRawTurns: number;
  beforeSeq?: number;
  usageTurnId?: string;
  policyReason?: string;
}

export interface CompactResult {
  status: "completed" | "skipped" | "failed";
  checkpointId?: string;
  coveredTurnIds: string[];
  reason: string;
}

export class CompactionService {
  constructor(
    private readonly history: TaskHistoryReader,
    private readonly store: CompactionStore,
    private readonly llm: LLMProvider,
    private readonly trace: TraceRecorder,
    private readonly model: string,
    private readonly maxSummaryChars: number
  ) {}

  async compactIfNeeded(
    input: { sessionId: string; taskId: string; turnId: string; keepRawTurns: number },
    config: RuntimeCompactionConfig
  ): Promise<CompactResult> {
    const beforeSeq = this.history.sequenceOf(input.turnId);
    const base = this.store.latest(input.taskId);
    const tail = this.history.list(input.taskId, beforeSeq)
      .filter((turn) => turn.id !== input.turnId && turn.seq > (base?.throughSeq ?? 0));
    const decision = evaluateCompactionPolicy({
      turnCount: tail.length,
      charCount: tail.reduce((sum, turn) => sum + turn.content.length, 0)
    }, config);
    if (!decision.trigger) return { status: "skipped", coveredTurnIds: [], reason: decision.reason };
    return this.compact({
      sessionId: input.sessionId,
      taskId: input.taskId,
      mode: "auto",
      keepRawTurns: input.keepRawTurns,
      beforeSeq,
      usageTurnId: input.turnId,
      policyReason: decision.reason
    });
  }

  async compact(input: CompactInput): Promise<CompactResult> {
    const base = this.store.latest(input.taskId);
    const history = this.history.list(input.taskId, input.beforeSeq);
    const tail = history.filter((turn) => turn.seq > (base?.throughSeq ?? 0));
    await this.record(input, "compaction.requested", { mode: input.mode, tailCount: tail.length, keepRawTurns: input.keepRawTurns, policyReason: input.policyReason ?? "manual command" });

    const prefix = contiguousTerminalPrefix(tail);
    const candidates = prefix.slice(0, Math.max(0, prefix.length - input.keepRawTurns));
    if (candidates.length === 0) {
      await this.record(input, "compaction.skipped", { reason: "no terminal prefix to compact" });
      return { status: "skipped", coveredTurnIds: [], reason: "无需压缩" };
    }
    const anchor = [...prefix].reverse()[0];
    const sourceIds = candidates.map((turn) => turn.id);
    const requestId = createId("llm_req");
    try {
      const storedSummary = base ? JSON.parse(base.summaryJson) as { sourceTurnIds: string[] } : null;
      const previousSummary = base ? parseCompactionSummary(base.summaryJson, storedSummary!.sourceTurnIds, this.maxSummaryChars) : null;
      const previousIds = previousSummary?.sourceTurnIds ?? [];
      const allowedIds = [...previousIds, ...sourceIds];
      const realToRef = new Map(allowedIds.map((id, index) => [id, `t${index + 1}`]));
      const refToReal = new Map([...realToRef].map(([id, ref]) => [ref, id]));
      await this.record(input, "compaction.started", {
        fromSeq: candidates[0].seq,
        throughSeq: candidates.at(-1)?.seq,
        sourceIds,
        requestId,
        references: [...realToRef].map(([turnId, ref]) => ({ ref, turnId }))
      });
      const response = await this.llm.complete({
        id: requestId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: anchor.id,
        usageTurnId: input.mode === "auto" ? input.usageTurnId ?? null : null,
        model: this.model,
        purpose: "task_compaction",
        messages: [
          { role: "system", content: `将 Task 历史压缩为严格 JSON，不输出解释。输入中的 Turn id 是本次请求的短引用，sourceTurnIds 只能原样引用这些 id，不要改写或猜测。字段：goal 为 {text,sourceTurnIds}；facts、decisions、completedWork、openIssues、constraints 为同结构数组；顶层 sourceTurnIds 只列摘要实际引用的 Turn id，不需要列出全部被覆盖的 Turn。每条事实必须标注来源，不编造事实。摘要 JSON 不超过 ${this.maxSummaryChars} 字符。` },
          { role: "user", content: JSON.stringify({ previousSummary: previousSummary ? mapSummaryIds(previousSummary, (id) => realToRef.get(id)!) : null, turns: candidates.map((turn) => ({ id: realToRef.get(turn.id), status: turn.status, content: turn.content })) }) }
        ]
      });
      const referencedSummary = parseCompactionSummary(response.content, [...refToReal.keys()], this.maxSummaryChars);
      const summary = parseCompactionSummary(
        JSON.stringify(mapSummaryIds(referencedSummary, (ref) => refToReal.get(ref)!)),
        allowedIds,
        this.maxSummaryChars
      );
      const checkpoint = this.store.append({
        taskId: input.taskId,
        baseCheckpointId: base?.id,
        fromSeq: candidates[0].seq,
        throughSeq: candidates.at(-1)!.seq,
        sourceTurnIds: sourceIds,
        summaryJson: JSON.stringify(summary),
        requestId
      });
      try {
        await this.record(input, "compaction.completed", { checkpointId: checkpoint.id, requestId, throughSeq: checkpoint.throughSeq, summaryLength: checkpoint.summaryJson.length });
      } catch {
        return { status: "completed", checkpointId: checkpoint.id, coveredTurnIds: sourceIds, reason: "压缩完成，但完成事件记录失败" };
      }
      return { status: "completed", checkpointId: checkpoint.id, coveredTurnIds: sourceIds, reason: "压缩完成" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.record(input, "compaction.failed", { reason, requestId, sourceIds });
      return { status: "failed", coveredTurnIds: sourceIds, reason };
    }
  }

  private async record(input: CompactInput, type: "compaction.requested" | "compaction.started" | "compaction.completed" | "compaction.skipped" | "compaction.failed", payload: Record<string, unknown>): Promise<void> {
    await this.trace.record({ sessionId: input.sessionId, taskId: input.taskId, type, source: "CompactionService", payload });
  }
}

function mapSummaryIds(summary: CompactionSummary, mapId: (id: string) => string): CompactionSummary {
  const mapStatement = (statement: CompactionSummary["goal"]) => ({
    text: statement.text,
    sourceTurnIds: statement.sourceTurnIds.map(mapId)
  });
  return {
    goal: mapStatement(summary.goal),
    facts: summary.facts.map(mapStatement),
    decisions: summary.decisions.map(mapStatement),
    completedWork: summary.completedWork.map(mapStatement),
    openIssues: summary.openIssues.map(mapStatement),
    constraints: summary.constraints.map(mapStatement),
    sourceTurnIds: summary.sourceTurnIds.map(mapId)
  };
}

function contiguousTerminalPrefix(turns: TaskHistoryTurn[]): TaskHistoryTurn[] {
  const prefix: TaskHistoryTurn[] = [];
  for (const turn of turns) {
    if (turn.status !== "completed" && turn.status !== "failed") break;
    prefix.push(turn);
  }
  return prefix;
}
