import type { Artifact, ContextPack } from "../contracts/types.js";
import type { StorageManager } from "../storage/storage-manager.js";
import { createId } from "../utils/id.js";

export interface WriteTurnArtifactsInput {
  sessionId: string;
  taskId: string;
  turnId: string;
  input: string;
  contextPack: ContextPack;
  summary: string;
}

export class MarkdownReporter {
  constructor(private readonly storage: StorageManager) {}

  async writeTurnArtifacts(input: WriteTurnArtifactsInput): Promise<Artifact[]> {
    const basePath = `.figo-agent/artifacts/sessions/${input.sessionId}/tasks/${input.taskId}/${input.turnId}`;
    const context = await this.storage.writeArtifact({
      id: createId("art"),
      sessionId: input.sessionId,
      taskId: input.taskId,
      turnId: input.turnId,
      type: "context",
      path: `${basePath}/context.md`,
      content: renderContext(input.contextPack)
    });
    const report = await this.storage.writeArtifact({
      id: createId("art"),
      sessionId: input.sessionId,
      taskId: input.taskId,
      turnId: input.turnId,
      type: "report",
      path: `${basePath}/report.md`,
      content: renderReport(input)
    });
    return [context, report];
  }

  async writeTaskSummary(sessionId: string, taskId: string): Promise<Artifact> {
    const task = this.storage.db.prepare("select * from tasks where id = ?").get(taskId) as {
      title: string;
      status: string;
      created_at: string;
      completed_at: string | null;
      cancelled_at: string | null;
    };
    const turns = this.storage.db
      .prepare("select id, input, status, created_at from turns where task_id = ? order by created_at")
      .all(taskId) as Array<{ id: string; input: string; status: string; created_at: string }>;
    const captures = this.storage.db
      .prepare(
        "select request_id, model, response_status, duration_ms from llm_http_captures where task_id = ? order by created_at"
      )
      .all(taskId) as Array<{ request_id: string; model: string; response_status: number; duration_ms: number }>;
    const artifacts = this.storage.db
      .prepare("select type, path from artifacts where task_id = ? order by created_at")
      .all(taskId) as Array<{ type: string; path: string }>;

    return this.storage.writeArtifact({
      id: createId("art"),
      sessionId,
      taskId,
      type: "task-summary",
      path: `.figo-agent/artifacts/sessions/${sessionId}/tasks/${taskId}/task-summary.md`,
      content: renderTaskSummary({ taskId, task, turns, captures, artifacts })
    });
  }
}

function renderContext(pack: ContextPack): string {
  const lines = [
    "# 上下文包",
    "",
    `ContextPack：${pack.id}`,
    `Task：${pack.taskId}`,
    `估算 Token：${pack.estimatedTokens}`,
    "",
    "## 已纳入内容"
  ];

  for (const item of pack.items.filter((entry) => entry.included)) {
    lines.push(
      "",
      `### ${item.sourceRef}`,
      `来源：${item.sourceType}`,
      `摘要：${item.summary}`,
      `原因：${item.reason}`,
      `估算 Token：${item.estimatedTokens}`
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderTaskSummary(input: {
  taskId: string;
  task: {
    title: string;
    status: string;
    created_at: string;
    completed_at: string | null;
    cancelled_at: string | null;
  };
  turns: Array<{ id: string; input: string; status: string; created_at: string }>;
  captures: Array<{ request_id: string; model: string; response_status: number; duration_ms: number }>;
  artifacts: Array<{ type: string; path: string }>;
}): string {
  return [
    "# Task Summary",
    "",
    "## 基本信息",
    "",
    `Task：${input.taskId}`,
    `标题：${input.task.title}`,
    `状态：${input.task.status}`,
    `创建时间：${input.task.created_at}`,
    `结束时间：${input.task.completed_at ?? input.task.cancelled_at ?? ""}`,
    "",
    "## Turn 时间线",
    "",
    ...input.turns.map((turn, index) => `${index + 1}. ${turn.input}（${turn.status}）`),
    "",
    "## LLM 请求与返回索引",
    "",
    ...input.captures.map(
      (capture) =>
        `- ${capture.request_id} / ${capture.model} / status ${capture.response_status} / ${capture.duration_ms}ms`
    ),
    "",
    "## 产物列表",
    "",
    ...input.artifacts.map((artifact) => `- ${artifact.type}: ${artifact.path}`)
  ].join("\n");
}

function renderReport(input: WriteTurnArtifactsInput): string {
  return [
    "# 执行报告",
    "",
    `用户输入：${input.input}`,
    "",
    "## 执行摘要",
    "",
    input.summary,
    "",
    "## Token 估算",
    "",
    `上下文估算 Token：${input.contextPack.estimatedTokens}`,
    `输出字符数：${input.summary.length}`
  ].join("\n");
}
