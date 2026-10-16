import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentKernel } from "../src/kernel/agent-kernel.js";
import { TurnManager } from "../src/kernel/turn-manager.js";
import { ContextBuilder } from "../src/context/context-builder.js";
import { ContextMessageStore } from "../src/context/context-message-store.js";
import { CompactionStore } from "../src/context/compaction-store.js";
import { SqliteMemoryStore } from "../src/memory/sqlite-memory-store.js";
import { LLMHttpCaptureStore } from "../src/llm/llm-http-capture-store.js";
import { TraceRecorder } from "../src/trace/trace-recorder.js";
import type { LLMMessage } from "../src/contracts/types.js";

/** 隔离的 UI 验收事实：写真实 SQLite/抓包/消息表，不发送模型请求。 */
export async function createTraceInspectorFixture(workspace: string) {
  await writeFile(join(workspace, "验收说明.md"), "# 检查器验收\n这是文件的当前版本，历史引用快照保留旧内容。\n");
  const kernel = await AgentKernel.start({ workspaceRoot: workspace });
  const db = kernel.storage.db;
  const task = db.prepare("select id from tasks where session_id = ? limit 1").get(kernel.session.id) as { id: string };
  db.prepare("update tasks set title = ? where id = ?").run("Trace Inspector 隔离验收", task.id);
  const turns = new TurnManager(kernel.storage);
  const first = turns.create(kernel.session.id, task.id, "分析项目中的上下文来源和压缩过程");
  const second = turns.create(kernel.session.id, task.id, "继续核对实际请求与摘要边界");
  const trace = new TraceRecorder(kernel.storage);
  const captures = new LLMHttpCaptureStore(kernel.storage);
  const messages = new ContextMessageStore(kernel.storage);
  const compactions = new CompactionStore(kernel.storage);
  const scope = "fixture-scope";
  const sourceUser = `turn:${first.id}:user`;
  const toolSource = "tool:fixture_tool_read:result";
  const toolCall = { id: "fixture_intent_read", name: "read_file", input: { path: "验收说明.md" } };
  const history: Array<{ sourceRef: string; turnId: string; message: LLMMessage }> = [
    { sourceRef: sourceUser, turnId: first.id, message: { role: "user", content: "分析项目中的上下文来源和压缩过程\n引用文件历史内容：旧版说明" } },
    { sourceRef: "request:fixture_request_one:response", turnId: first.id, message: { role: "assistant", content: "先读取文件核对内容。", toolCalls: [toolCall] } },
    { sourceRef: toolSource, turnId: first.id, message: { role: "tool", toolCallId: toolCall.id, content: "文件历史内容：旧版说明" } },
    { sourceRef: "request:fixture_request_two:response", turnId: first.id, message: { role: "assistant", content: "已核对项目结构。" } },
    { sourceRef: `turn:${second.id}:user`, turnId: second.id, message: { role: "user", content: second.input } }
  ];
  messages.append(task.id, history);
  db.prepare("insert into tool_calls (id,session_id,turn_id,intent_id,round,tool_name,input_json,output_json,status,started_at,completed_at) values (?,?,?,?,?,?,?,?,?,?,?)")
    .run("fixture_tool_read", kernel.session.id, first.id, toolCall.id, 0, "read_file", JSON.stringify(toolCall.input), JSON.stringify({ path: "验收说明.md", content: "文件历史内容：旧版说明" }), "completed", "2026-10-16 09:00:01.000", "2026-10-16 09:00:01.120");
  for (const [id, status, error] of [["fixture_tool_failed", "failed", "fixture exit code 1"], ["fixture_tool_denied", "denied", "路径越界"]]) {
    db.prepare("insert into tool_calls (id,session_id,turn_id,intent_id,round,tool_name,input_json,status,error_message,started_at,completed_at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, kernel.session.id, second.id, id, 1, status === "failed" ? "run_command" : "read_file", "{}", status, error, "2026-10-16 09:00:02.000", "2026-10-16 09:00:02.020");
  }
  const capture = (requestId: string, turnId: string, requestMessages: unknown[], content: string, purpose: "turn" | "task_compaction" = "turn", toolCalls?: unknown[]) => {
    captures.record({ sessionId: kernel.session.id, taskId: task.id, turnId, requestId, purpose,
      provider: "fixture", model: "fixture-inspector-model", method: "POST", url: "https://fixture.invalid/v1/chat/completions",
      requestHeaders: { Authorization: "Bearer fixture-only-secret" }, requestBody: { model: "fixture-inspector-model", messages: requestMessages },
      responseStatus: 200, responseStatusText: "OK", responseHeaders: {},
      responseBody: { choices: [{ message: { content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 4000, completion_tokens: 200, total_tokens: 4200 } }, durationMs: 1540 });
  };
  const pack = await new ContextBuilder(kernel.storage, new SqliteMemoryStore(kernel.storage), trace).build({
    sessionId: kernel.session.id, taskId: task.id, turnId: first.id, input: first.input,
    fileReferences: [{ path: "验收说明.md", startLine: 1, endLine: 2, version: "fixture-old-version", content: "# 检查器验收\n文件历史内容：旧版说明" }]
  });
  capture("fixture_request_one", first.id, [history[0].message], "先读取文件核对内容。", "turn", [{ id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) } }]);
  const wireMessage = (message: LLMMessage) => message.role === "tool"
    ? { role: "tool", tool_call_id: message.toolCallId, content: message.content }
    : { role: message.role, content: message.content, ...(message.toolCalls ? {
      tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }))
    } : {}) };
  capture("fixture_request_two", first.id, history.slice(0, 3).map((entry) => wireMessage(entry.message)), "已核对项目结构。");
  for (const [requestId, refs] of [["fixture_request_one", [sourceUser]], ["fixture_request_two", history.slice(0, 3).map((entry) => entry.sourceRef)]] as const) {
    await trace.record({ sessionId: kernel.session.id, taskId: task.id, turnId: first.id, type: "llm.called", source: "AgentLoop", payload: {
      requestId, contextPackId: pack.id, providerId: "fixture", modelId: "fixture-inspector-model", projection: { compactionEntryId: null, sourceRefs: refs, usageScope: scope }
    } });
  }
  const summary = "## 目标\n核对上下文来源和实际传输。\n\n## 进度\n已读取项目文件。\n\n## 后续步骤\n检查保留消息和错误证据。";
  capture("fixture_summary_history", second.id, [{ role: "user", content: "较早历史" }], summary, "task_compaction");
  capture("fixture_summary_prefix", second.id, [{ role: "user", content: "用户交互前缀" }], summary, "task_compaction");
  const retained = history.slice(3);
  const entry = compactions.appendEntry({ taskId: task.id, firstKeptSourceRef: retained[0].sourceRef,
    coveredSourceRefs: history.slice(0, 3).map((entry) => entry.sourceRef), summaryMarkdown: summary, tokensBefore: 12000,
    requestId: "fixture_summary_prefix", details: { readFiles: ["验收说明.md"], modifiedFiles: [],
      requestIds: ["fixture_summary_history", "fixture_summary_prefix"], isSplitTurn: true, compactionAttemptId: "fixture_attempt", estimateSource: "estimate" } });
  for (const [type, payload] of [
    ["compaction.requested", { mode: "auto", contextTokens: 12000, contextWindow: 24000, reserveTokens: 16384, keepRecentTokens: 2000 }],
    ["compaction.started", { mode: "auto", firstKeptSourceRef: entry.firstKeptSourceRef, sourceRefs: entry.coveredSourceRefs, isSplitTurn: true }],
    ["compaction.completed", { mode: "auto", checkpointId: entry.id, requestId: entry.requestId, requestIds: entry.details.requestIds, tokensBefore: 12000, tokensAfter: 3000, tokensBeforeSource: "estimate", tokensAfterSource: "estimate" }]
  ] as const) {
    await trace.record({ sessionId: kernel.session.id, taskId: task.id, turnId: second.id, type, source: "CompactionService", payload: { ...payload, compactionAttemptId: "fixture_attempt" } });
  }
  const afterPack = await new ContextBuilder(kernel.storage, new SqliteMemoryStore(kernel.storage), trace).build({
    sessionId: kernel.session.id, taskId: task.id, turnId: second.id, input: second.input,
    fileReferences: [{ path: "验收说明.md", startLine: 1, endLine: 2, version: "fixture-old-version", content: "# 检查器验收\n文件历史内容：旧版说明" }]
  });
  const actualMessages = [{ role: "system", content: "基于真实证据回答。" }, { role: "user", content: summary }, ...retained.map((entry) => wireMessage(entry.message))];
  capture("fixture_after_compaction", second.id, actualMessages, "已完成来源与保留边界核对。");
  await trace.record({ sessionId: kernel.session.id, taskId: task.id, turnId: second.id, type: "llm.called", source: "AgentLoop", payload: {
    requestId: "fixture_after_compaction", contextPackId: afterPack.id, providerId: "fixture", modelId: "fixture-inspector-model",
    projection: { compactionEntryId: entry.id, sourceRefs: retained.map((entry) => entry.sourceRef), usageScope: scope }
  } });
  await trace.record({ sessionId: kernel.session.id, taskId: task.id, turnId: second.id, type: "compaction.skipped", source: "CompactionService", payload: {
    compactionAttemptId: "fixture_skipped", mode: "auto", reason: "below_threshold", tokens: 3000, source: "estimate", contextWindow: 24000, reserveTokens: 16384
  } });
  await trace.record({ sessionId: kernel.session.id, taskId: task.id, turnId: second.id, type: "tool.failed", source: "ToolRegistry", payload: { toolCallId: "fixture_tool_failed", tool: "run_command" } });
  const artifact = await kernel.storage.writeArtifact({ id: "fixture_artifact", sessionId: kernel.session.id, taskId: task.id, turnId: second.id,
    type: "report", path: ".figo-agent/artifacts/inspector-fixture-report.md", content: "# 验收报告\n检查器隔离数据。" });
  turns.complete(first.id);
  turns.complete(second.id);
  db.prepare("update turns set output = ? where id in (?,?)").run("已完成检查器隔离数据准备。", first.id, second.id);
  return { kernel, taskId: task.id, firstTurnId: first.id, secondTurnId: second.id, compactionEntryId: entry.id, artifact };
}
