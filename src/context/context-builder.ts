import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextItem, ContextPack } from "../contracts/types.js";
import type { RuntimeContextConfig } from "../config/runtime-config.js";
import { defaultRuntimeConfig } from "../config/runtime-config.js";
import type { MemoryRecord, SqliteMemoryStore } from "../memory/sqlite-memory-store.js";
import type { StorageManager } from "../storage/storage-manager.js";
import type { TraceRecorder } from "../trace/trace-recorder.js";
import { nowIso } from "../utils/clock.js";
import { createId } from "../utils/id.js";
import { CompactionStore } from "./compaction-store.js";
import { parseCompactionSummary } from "./compaction-summary.js";
import { TaskHistoryReader } from "./task-history-reader.js";

export interface BuildContextInput {
  sessionId: string;
  taskId: string;
  turnId: string;
  input: string;
}

export class ContextBuilder {
  constructor(
    private readonly storage: StorageManager,
    private readonly memoryStore: SqliteMemoryStore,
    private readonly trace?: TraceRecorder,
    private readonly config: RuntimeContextConfig = defaultRuntimeConfig.context
  ) {}

  async build(input: BuildContextInput): Promise<ContextPack> {
    await this.trace?.record({
      sessionId: input.sessionId,
      taskId: input.taskId,
      turnId: input.turnId,
      type: "context.build.started",
      source: "ContextBuilder",
      payload: { inputLength: input.input.length }
    });

    const items: ContextItem[] = [
      createItem("turn", "turn.input", "当前用户输入", input.input, "当前 Turn 的直接输入")
    ];

    const historyReader = new TaskHistoryReader(this.storage);
    const currentSeq = historyReader.sequenceOf(input.turnId);
    const allHistory = historyReader.list(input.taskId, currentSeq).filter((turn) => turn.id !== input.turnId);
    let checkpoint = new CompactionStore(this.storage).latest(input.taskId);
    if (checkpoint) {
      try {
        parseCompactionSummary(
          checkpoint.summaryJson,
          allHistory.filter((turn) => turn.seq <= checkpoint!.throughSeq).map((turn) => turn.id),
          this.config.compaction.summaryMaxChars
        );
      } catch (error) {
        await this.trace?.record({
          sessionId: input.sessionId, taskId: input.taskId, turnId: input.turnId,
          type: "compaction.failed", source: "ContextBuilder",
          payload: { checkpointId: checkpoint.id, reason: error instanceof Error ? error.message : String(error) }
        });
        checkpoint = undefined;
      }
    }
    const taskHistory = allHistory.filter((turn) => turn.seq > (checkpoint?.throughSeq ?? 0));
    await this.trace?.record({
      sessionId: input.sessionId,
      taskId: input.taskId,
      turnId: input.turnId,
      type: "task.history.loaded",
      source: "ContextBuilder",
      payload: { count: taskHistory.length }
    });
    if (checkpoint) {
      items.push(createItem(
        "task_compaction",
        `task.compaction:${checkpoint.id}`,
        `当前 Task 已压缩历史 1-${checkpoint.throughSeq}`,
        checkpoint.summaryJson,
        `来源 Turn 序号 1-${checkpoint.throughSeq}；检查点 ${checkpoint.id}`
      ));
    }
    for (const turn of taskHistory) {
      items.push(
        createItem(
          "task_turn",
          `task.turn:${turn.id}`,
          `当前 Task 历史 Turn ${turn.seq}`,
          turn.content,
          "当前 Task 中尚未压缩的原始 Turn"
        )
      );
    }

    if (this.config.includeProjectDocs) {
      for (const file of this.config.projectDocPaths) {
        const content = await readWorkspaceFile(this.storage.paths.workspaceRoot, file);
        if (content) {
          items.push(createItem("file", file, `${file} 项目文档`, content, "运行时配置允许纳入项目文档"));
        }
      }
    }

    if (this.config.includeMemory) {
      await this.trace?.record({
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        type: "memory.search.started",
        source: "ContextBuilder",
        payload: { scopes: ["project", "user"] }
      });
      const memories = await this.memoryStore.search(["project", "user"]);
      await this.trace?.record({
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        type: "memory.search.completed",
        source: "ContextBuilder",
        payload: { count: memories.length }
      });
      for (const memory of memories) {
        items.push(memoryToItem(memory));
      }
    }

    const pack: ContextPack = {
      id: createId("ctx"),
      sessionId: input.sessionId,
      taskId: input.taskId,
      turnId: input.turnId,
      items,
      estimatedTokens: items.reduce((sum, item) => sum + item.estimatedTokens, 0),
      createdAt: nowIso()
    };

    this.storage.db
      .prepare(
        "insert into context_packs (id, session_id, task_id, turn_id, estimated_tokens, created_at) values (?, ?, ?, ?, ?, ?)"
      )
      .run(pack.id, pack.sessionId, pack.taskId, pack.turnId, pack.estimatedTokens, pack.createdAt);

    const insertItem = this.storage.db.prepare(
      "insert into context_items (id, context_pack_id, source_type, source_ref, summary, content, estimated_tokens, included, reason) values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const item of pack.items) {
      insertItem.run(
        item.id,
        pack.id,
        item.sourceType,
        item.sourceRef,
        item.summary,
        item.content,
        item.estimatedTokens,
        item.included ? 1 : 0,
        item.reason
      );
      await this.trace?.record({
        sessionId: input.sessionId,
        taskId: input.taskId,
        turnId: input.turnId,
        type: "context.item.included",
        source: "ContextBuilder",
        payload: {
          contextPackId: pack.id,
          contextItemId: item.id,
          sourceType: item.sourceType,
          sourceRef: item.sourceRef,
          estimatedTokens: item.estimatedTokens,
          reason: item.reason
        }
      });
    }

    return pack;
  }
}

function createItem(
  sourceType: string,
  sourceRef: string,
  summary: string,
  content: string,
  reason: string
): ContextItem {
  return {
    id: createId("ctx_item"),
    sourceType,
    sourceRef,
    summary,
    content,
    estimatedTokens: estimateTokens(content),
    included: true,
    reason
  };
}

function memoryToItem(memory: MemoryRecord): ContextItem {
  return createItem(
    "memory",
    `memory:${memory.key}`,
    `${memory.scope} memory: ${memory.key}`,
    memory.content,
    "V1 读取 SQLite memory_records，不自动写入 Memory"
  );
}

async function readWorkspaceFile(workspaceRoot: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(join(workspaceRoot, path), "utf8");
  } catch {
    return undefined;
  }
}

function estimateTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}
