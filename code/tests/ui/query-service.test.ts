import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentKernel } from "../../src/kernel/agent-kernel.js";
import { WorkspaceQueryService } from "../../src/ui/workspace-query-service.js";
import { LLMHttpCaptureStore } from "../../src/llm/llm-http-capture-store.js";
import { CompactionStore } from "../../src/context/compaction-store.js";

import { TestDatabases } from "../helpers/test-databases.js";

const databases = new TestDatabases();
let workspace = "";
afterEach(async () => {
  databases.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = "";
});

it("returns the full workspace path in chat turns", async () => {
  workspace = await mkdtemp(join(tmpdir(), "figo-ui-path-"));
  const kernel = await AgentKernel.start({ workspaceRoot: workspace });
  databases.track(kernel.storage);
  const result = await kernel.submitTurn("当前项目路径是什么");
  kernel.storage.db.prepare("update turns set output = ? where id = ?").run(workspace, result.turnId);
  const service = new WorkspaceQueryService(kernel.storage);
  expect(service.turns(result.taskId)).toEqual([expect.objectContaining({ output: workspace })]);
});

it("exposes the message-level checkpoint actually referenced by a historical ContextPack", async () => {
  workspace = await mkdtemp(join(tmpdir(), "figo-ui-message-checkpoint-"));
  const kernel = await AgentKernel.start({ workspaceRoot: workspace });
  databases.track(kernel.storage);
  try {
    const first = await kernel.submitTurn("第一轮");
    const request = kernel.storage.db.prepare("select request_id from llm_http_captures where turn_id = ?").get(first.turnId) as { request_id: string };
    const store = new CompactionStore(kernel.storage);
    const checkpoint = store.appendEntry({ taskId: first.taskId, firstKeptSourceRef: `request:${request.request_id}:response`,
      coveredSourceRefs: [`turn:${first.turnId}:user`], summaryMarkdown: "## Goal\n第一轮目标", details: { readFiles: [], modifiedFiles: [] }, tokensBefore: 100, requestId: "summary-request" });
    const second = await kernel.submitTurn("继续");
    const query = new WorkspaceQueryService(kernel.storage);
    expect(query.context(first.turnId).checkpoint).toBeNull();
    expect(query.context(second.turnId).checkpoint).toMatchObject({ kind: "messages", id: checkpoint.id,
      firstKeptSourceRef: `request:${request.request_id}:response`, coveredSourceRefs: [`turn:${first.turnId}:user`], tokensBefore: 100 });
    store.appendEntry({ taskId: first.taskId, baseEntryId: checkpoint.id, firstKeptSourceRef: `turn:${second.turnId}:user`,
      coveredSourceRefs: [`request:${request.request_id}:response`], summaryMarkdown: "后来的摘要", details: { readFiles: [], modifiedFiles: [] }, tokensBefore: 120, requestId: "later-summary" });
    expect(query.context(second.turnId).checkpoint?.id).toBe(checkpoint.id);
  } finally { kernel.storage.db.close(); }
});

it("projects the actual context, captures, usage and trace while redacting secrets", async () => {
  workspace = await mkdtemp(join(tmpdir(), "figo-ui-query-"));
  const kernel = await AgentKernel.start({ workspaceRoot: workspace });
  databases.track(kernel.storage);
  const result = await kernel.submitTurn("查看上下文");
  const service = new WorkspaceQueryService(kernel.storage, ["sk-test-secret-long-enough"]);
  const context = service.context(result.turnId);
  expect(context.pack?.turnId).toBe(result.turnId);
  expect(context.items.some((item) => item.sourceType === "turn")).toBe(true);

  kernel.storage.db.prepare("update llm_http_captures set request_body_json = ?, request_headers_json = ? where turn_id = ?")
    .run(JSON.stringify({ messages: [{ content: "key sk-test-secret-long-enough" }], apiKey: "raw-key" }),
      JSON.stringify({ Authorization: "Bearer sk-test-secret-long-enough" }), result.turnId);
  const captures = service.captures(result.turnId);
  expect(captures).toHaveLength(1);
  expect(captures[0].usage.status).toBe("unavailable");
  expect(JSON.stringify(captures)).not.toContain("sk-test-secret-long-enough");
  expect(JSON.stringify(captures)).not.toContain("raw-key");

  const trace = service.trace(result.turnId);
  expect(trace.some((event) => event.type === "turn.completed")).toBe(true);
  expect(trace.every((event) => event.turnId === result.turnId)).toBe(true);
  expect(trace.find((event) => event.type === "llm.called")?.payload.requestId).toBe(captures[0].requestId);
  kernel.storage.db.prepare("update turns set input = ?, output = ? where id = ?")
    .run("请检查 sk-test-secret-long-enough", "key sk-test-secret-long-enough", result.turnId);
  expect(JSON.stringify(service.turns(result.taskId))).not.toContain("sk-test-secret-long-enough");
  kernel.storage.db.prepare("insert into tool_calls (id, session_id, turn_id, intent_id, round, tool_name, input_json, output_json, status, started_at, completed_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("tool_1", result.sessionId, result.turnId, "call_1", 0, "read_file", "{}", '{"ok":true}', "completed", "2026-10-12 01:00:00.000", "2026-10-12 01:00:00.001");
  expect(service.tools(result.turnId)).toMatchObject([{ id: "tool_1", intentId: "call_1", name: "read_file", status: "completed" }]);
  const next = await kernel.submitTurn("第二轮");
  const nextContext = service.context(next.turnId);
  expect(nextContext.items.find((item) => item.sourceType === "task_turn")).toMatchObject({
    sourceRef: `task.turn:${result.turnId}`,
    originTurn: { id: result.turnId, taskSeq: 1, inputPreview: "请检查 [REDACTED]" }
  });
  expect(nextContext.items.find((item) => item.sourceRef === "turn.input")).toMatchObject({
    originTurn: { id: next.turnId, taskSeq: 2, inputPreview: "第二轮" }
  });
  expect(service.turns(result.taskId).map((turn) => turn.taskSeq)).toEqual([1, 2]);
  new LLMHttpCaptureStore(kernel.storage).record({
    purpose: "task_compaction", sessionId: result.sessionId, taskId: result.taskId,
    turnId: result.turnId, usageTurnId: next.turnId, requestId: "compact-request",
    provider: "test", model: "test", url: "local:test", method: "LOCAL",
    requestHeaders: {}, requestBody: { messages: [] }, responseStatus: 200,
    responseStatusText: "OK", responseHeaders: {}, responseBody: { summary: "第二轮前压缩" }, durationMs: 1
  });
  expect(service.captures(next.turnId).some((capture) => capture.requestId === "compact-request" && capture.purpose === "task_compaction")).toBe(true);
  kernel.storage.db.prepare("insert into task_compaction_checkpoints (id, task_id, from_seq, through_seq, source_turn_ids_json, summary_json, request_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("later_checkpoint", result.taskId, 1, 1, JSON.stringify([result.turnId]), "{}", "later-request", "2026-10-12 23:00:00.000");
  expect(service.context(result.turnId).checkpoint).toBeNull();
});
