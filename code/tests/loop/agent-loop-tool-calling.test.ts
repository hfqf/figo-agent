import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../src/contracts/types.js";
import { ContextBuilder } from "../../src/context/context-builder.js";
import { AgentLoop } from "../../src/loop/agent-loop.js";
import { SqliteMemoryStore } from "../../src/memory/sqlite-memory-store.js";
import { PluginHost } from "../../src/plugin/plugin-host.js";
import { ReadOnlyPolicy } from "../../src/policy/read-only-policy.js";
import { MarkdownReporter } from "../../src/reporter/markdown-reporter.js";
import { ProjectUnderstandingSkill } from "../../src/skill/project-understanding-skill.js";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { createReadOnlyTools } from "../../src/tools/read-only-tools.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { TraceRecorder } from "../../src/trace/trace-recorder.js";
import { CompactionService } from "../../src/context/compaction-service.js";
import { CompactionStore } from "../../src/context/compaction-store.js";
import { TaskHistoryReader } from "../../src/context/task-history-reader.js";
import { readPiCompactionSettings } from "../../src/config/pi-compaction-settings.js";
import { ContextMessageStore } from "../../src/context/context-message-store.js";
import { OpenAICompatibleProvider } from "../../src/llm/openai-compatible-provider.js";

import { TestDatabases } from "../helpers/test-databases.js";
import { deepseekDsmlResponse } from "../fixtures/deepseek-dsml.js";

const databases = new TestDatabases();
let workspace = "";

afterEach(async () => {
  databases.close();
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("AgentLoop tool calling", () => {
  it.each(["text", "native"] as const)("repairs DSML then completes real tools in %s mode", async (toolCallingMode) => {
    workspace = await mkdtemp(join(tmpdir(), "figo-dsml-repair-"));
    await writeFile(join(workspace, "README.md"), "verified-dsml-evidence", "utf8");
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const requests: LLMRequest[] = [];
    const streamed: string[] = [];
    const call = { id: "repaired_call", name: "read_file", input: { path: "README.md" } };
    const llm: LLMProvider = { toolCallingMode, complete: async (request, emit) => {
      requests.push(structuredClone({ ...request, signal: undefined }));
      if (requests.length === 2) {
        expect(storage.db.prepare("select count(*) count from tool_calls").get()).toEqual({ count: 0 });
      }
      if (requests.length === 3) expect(request.messages.at(-1)?.content).toContain("verified-dsml-evidence");
      const content = requests.length === 1 ? deepseekDsmlResponse : requests.length === 2
        ? toolCallingMode === "native" ? "" : JSON.stringify({ type: "tool_calls", calls: [call] })
        : "已读取 verified-dsml-evidence。";
      for (const character of content) emit?.(character);
      return { id: `res_${requests.length}`, requestId: request.id, model: request.model,
        content, outputLength: content.length, durationMs: 1,
        finishReason: requests.length === 2 && toolCallingMode === "native" ? "tool_calls" : "stop",
        ...(requests.length === 2 && toolCallingMode === "native" ? { toolCalls: [call] } : {}) };
    } };
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace).runTurn({ sessionId: "ses_1", taskId: "task_1", turnId: "turn_1",
      workspaceRoot: workspace, input: "读取 README.md 并回答其中的标记" }, (delta) => streamed.push(delta), () => {});
    expect(result.status).toBe("completed");
    expect(result.message).toBe("已读取 verified-dsml-evidence。");
    expect(streamed.join("")).toBe(result.message);
    expect(requests).toHaveLength(3);
    expect(storage.db.prepare("select tool_name, status from tool_calls").all())
      .toEqual([{ tool_name: "read_file", status: "completed" }]);
    expect(storage.db.prepare("select payload_json from trace_events where type = 'tool_call.parse.failed'").all())
      .toEqual([{ payload_json: JSON.stringify({ round: 0, reason: "unsupported_dsml_tool_calls" }) }]);
    expect(storage.db.prepare("select count(*) count from trace_events where type = 'tool_call.repair.requested'").get())
      .toEqual({ count: 1 });
  });

  it.each(["text", "native"] as const)("fails visibly if DSML repair also fails in %s mode", async (toolCallingMode) => {
    workspace = await mkdtemp(join(tmpdir(), "figo-dsml-failed-"));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    let requests = 0;
    const streamed: string[] = [];
    const llm: LLMProvider = { toolCallingMode, complete: async (request, emit) => {
      requests++;
      for (const character of deepseekDsmlResponse) emit?.(character);
      return { id: `res_${requests}`, requestId: request.id, model: request.model, content: deepseekDsmlResponse,
        outputLength: deepseekDsmlResponse.length, durationMs: 1, finishReason: "stop" };
    } };
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace).runTurn({ sessionId: "ses_1", taskId: "task_1", turnId: "turn_1",
      workspaceRoot: workspace, input: "读取项目" }, (delta) => streamed.push(delta), () => {});
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("model_protocol_error");
    expect(requests).toBe(2);
    expect(streamed).toEqual([]);
    expect(storage.db.prepare("select count(*) count from tool_calls").get()).toEqual({ count: 0 });
    expect(storage.db.prepare("select count(*) count from trace_events where type = 'turn.completed'").get()).toEqual({ count: 0 });
  });

  it("executes native tool calls and returns tool results with their call ids", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-native-loop-"));
    await writeFile(join(workspace, "README.md"), "# Root project\n", "utf8");
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const requests: LLMRequest[] = [];
    const llm: LLMProvider = { toolCallingMode: "native", complete: async (request) => {
      requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
      return requests.length === 1
        ? { id: "res_1", requestId: request.id, content: "", model: request.model, finishReason: "tool_calls",
          toolCalls: [{ id: "call_1", name: "read_file", input: { path: "README.md" } }], outputLength: 0, durationMs: 1 }
        : { id: "res_2", requestId: request.id, content: "根项目已确认。", model: request.model,
          finishReason: "stop", outputLength: 7, durationMs: 1 };
    } };
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace).runTurn({
      sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "分析项目"
    });
    expect(result.status).toBe("completed");
    expect(requests[0].availableTools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "read_file" })]));
    expect(requests[1].messages.slice(-2)).toMatchObject([
      { role: "assistant", toolCalls: [{ id: "call_1", name: "read_file", input: { path: "README.md" } }] },
      { role: "tool", toolCallId: "call_1" }
    ]);
    expect(requests[1].messages.at(-1)?.content).toContain("README.md");
    expect(storage.db.prepare("select count(*) count from tool_calls").get()).toMatchObject({ count: 1 });
  });
  it("executes native calls with explanatory content once and preserves the full archived exchange", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-native-content-"));
    await mkdir(join(workspace, "src/context"), { recursive: true });
    await writeFile(join(workspace, "src/context/compaction-policy.ts"), "contextTokens > contextWindow - reserveTokens\n", "utf8");
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const requests: LLMRequest[] = [];
    const streamed: string[] = [];
    const explanation = "我先读取目标文件，并基于实际文件内容核对自动压缩公式与配置边界；随后给出已确认结论和仍需工具验证的事项。";
    const call = { id: "call_archived", name: "read_file", input: { path: "src/context/compaction-policy.ts" } };
    const answer = "已依据目标文件确认压缩边界。";
    const llm: LLMProvider = { toolCallingMode: "native", complete: async (request, emit) => {
      requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
      if (requests.length === 1) {
        emit?.(explanation.slice(0, 20));
        emit?.(explanation.slice(20));
      } else {
        expect(streamed).toEqual([]);
        emit?.(answer);
      }
      return requests.length === 1
        ? { id: "res_1", requestId: request.id, content: explanation, model: request.model,
          finishReason: "tool_calls", toolCalls: [call], outputLength: explanation.length, durationMs: 1 }
        : { id: "res_2", requestId: request.id, content: answer, model: request.model,
          finishReason: "stop", outputLength: answer.length, durationMs: 1 };
    } };
    const host = await setupHost(storage, trace, llm, registry);
    const service = new CompactionService(new TaskHistoryReader(storage), new CompactionStore(storage), llm, trace,
      "native-test", readPiCompactionSettings({ enabled: false }), new ContextMessageStore(storage));
    const result = await new AgentLoop(host, trace, { compaction: service }).runTurn({
      sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "分析项目"
    }, (delta) => streamed.push(delta));
    expect(result.status).toBe("completed");
    expect(result.message).toBe(answer);
    expect(streamed).toEqual([answer]);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.slice(-2)).toMatchObject([
      { role: "assistant", content: explanation, toolCalls: [call] },
      { role: "tool", toolCallId: call.id }
    ]);
    expect(requests[1].messages.at(-1)?.content).toContain("contextTokens > contextWindow - reserveTokens");
    expect(storage.db.prepare("select intent_id, tool_name, status from tool_calls").all())
      .toEqual([{ intent_id: call.id, tool_name: call.name, status: "completed" }]);
    expect(storage.db.prepare("select count(*) count from trace_events where type = 'policy.evaluated'").get()).toEqual({ count: 1 });
    expect(storage.db.prepare("select count(*) count from trace_events where type in ('tool_call.parse.failed','tool_call.repair.requested')").get())
      .toEqual({ count: 0 });
    const snapshots = storage.db.prepare("select message_json from context_messages where turn_id = ? order by rowid")
      .all("turn_1") as Array<{ message_json: string }>;
    expect(snapshots.map((row) => JSON.parse(row.message_json)).slice(-3)).toMatchObject([
      { role: "assistant", content: explanation, toolCalls: [call] },
      { role: "tool", toolCallId: call.id },
      { role: "assistant", content: answer }
    ]);
  });

  it.each([
    ["unknown", "not_registered", {}, "tool_not_found", "failed"],
    ["outside", "read_file", { path: "../outside" }, "path_outside_workspace", "denied"],
    ["invalid-arguments", "read_file", {}, "invalid_input", "failed"]
  ] as const)("keeps native content calls subject to existing %s checks", async (_name, name, input, errorCode, status) => {
    workspace = await mkdtemp(join(tmpdir(), "figo-native-guard-"));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const requests: LLMRequest[] = [];
    const llm: LLMProvider = { toolCallingMode: "native", complete: async (request) => {
      requests.push(structuredClone({ ...request, signal: undefined }));
      return { id: `res_${requests.length}`, requestId: request.id, model: request.model, durationMs: 1,
        content: requests.length === 1 ? "先核实工具结果。" : "该请求未成功完成。", outputLength: 10,
        finishReason: requests.length === 1 ? "tool_calls" : "stop",
        ...(requests.length === 1 ? { toolCalls: [{ id: "guard", name, input }] } : {}) };
    } };
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace).runTurn({ sessionId: "ses_1", taskId: "task_1", turnId: "turn_1",
      workspaceRoot: workspace, input: "检查工具" });
    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "guard" });
    expect(JSON.parse(requests[1].messages.at(-1)!.content)).toMatchObject({ status: "failed", errorCode });
    expect(storage.db.prepare("select status from tool_calls").all()).toEqual([{ status }]);
  });

  it.each([
    ["invalid-json", [{ id: "c", type: "function", function: { name: "read_file", arguments: "{" } }]],
    ["invalid-id", [{ id: " ", type: "function", function: { name: "read_file", arguments: "{}" } }]],
    ["duplicate-id", [1, 2].map(() => ({ id: "c", type: "function", function: { name: "read_file", arguments: "{}" } }))]
  ])("does not bypass Provider native validation for %s with content", async (_name, toolCalls) => {
    workspace = await mkdtemp(join(tmpdir(), "figo-native-wire-guard-"));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    let requests = 0;
    const llm = new OpenAICompatibleProvider({ config: { id: "test", enabled: true, provider: "openai-compatible",
      apiKey: "test-key", baseUrl: "https://example.invalid/v1", model: "test", toolCallingMode: "native" },
      fetchImpl: async () => { requests++; return Response.json({ choices: [{
        message: { role: "assistant", content: "先核实工具结果。", tool_calls: toolCalls }, finish_reason: "tool_calls"
      }] }); } });
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace).runTurn({ sessionId: "ses_1", taskId: "task_1", turnId: "turn_1",
      workspaceRoot: workspace, input: "检查调用协议" });
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("invalid native tool call");
    expect(requests).toBe(1);
    expect(storage.db.prepare("select count(*) count from tool_calls").get()).toEqual({ count: 0 });
  });
  it("does not return XML tool syntax as a final answer in native mode", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-native-xml-"));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const requests: LLMRequest[] = [];
    const streamed: string[] = [];
    const llm: LLMProvider = { toolCallingMode: "native", complete: async (request, onTextDelta) => {
      requests.push(request);
      const content = requests.length === 1
        ? '<tool_calls><invoke name="system_info"></invoke></tool_calls>'
        : "已核实信息。";
      onTextDelta?.(content);
      return { id: `res_${requests.length}`, requestId: request.id, content, model: request.model,
        finishReason: "stop", outputLength: content.length, durationMs: 1 };
    } };
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace).runTurn({
      sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "查询系统信息"
    }, (delta) => streamed.push(delta));
    expect(result.status).toBe("completed");
    expect(result.message).toBe("已核实信息。");
    expect(streamed).toEqual(["已核实信息。"]);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)?.content).not.toContain("不得同时输出工具调用与正文");
    expect(storage.db.prepare("select count(*) count from tool_calls").get()).toMatchObject({ count: 0 });
  });
  it("does not treat unexpected native tool calls in text mode as an empty final answer", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-wrong-mode-"));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    let requests = 0;
    const llm: LLMProvider = { toolCallingMode: "text", complete: async (request) => {
      requests++;
      return { id: `res_${requests}`, requestId: request.id, content: "", model: request.model,
        finishReason: "tool_calls", toolCalls: [{ id: "call_1", name: "system_info", input: {} }],
        outputLength: 0, durationMs: 1 };
    } };
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace).runTurn({
      sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "查询系统信息"
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("model_protocol_error");
    expect(requests).toBe(2);
    expect(storage.db.prepare("select count(*) count from tool_calls").get()).toMatchObject({ count: 0 });
  });
  it("continues past three tool rounds until the model returns a final answer", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-long-loop-"));
    for (let index = 1; index <= 5; index++) await writeFile(join(workspace, `file_${index}.txt`), `evidence ${index}`);
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const requests: LLMRequest[] = [];
    const llm: LLMProvider = { complete: async (request) => {
      requests.push(request);
      const content = requests.length <= 5
        ? JSON.stringify({ type: "tool_calls", calls: [{ id: `call_${requests.length}`, name: "read_file", input: { path: `file_${requests.length}.txt` } }] })
        : "FINAL\n分析完成。";
      return { id: `res_${requests.length}`, requestId: request.id, content, model: request.model,
        finishReason: "stop", outputLength: content.length, durationMs: 1 };
    } };
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace).runTurn({
      sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "分析项目"
    });
    expect(result.status).toBe("completed");
    expect(result.message).toBe("分析完成。");
    expect(requests).toHaveLength(6);
    const traceText = await readFile(join(workspace, ".figo-agent/artifacts/sessions/ses_1/trace.jsonl"), "utf8");
    expect(traceText.match(/"type":"tool_call.round.completed"/g)).toHaveLength(5);
    expect(traceText).not.toContain("tool_call.round.limited");
  });

  it("asks for a conclusion when identical tools return identical evidence", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-stall-"));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const requests: LLMRequest[] = [];
    const llm: LLMProvider = { complete: async (request) => {
      requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
      const content = requests.length <= 2
        ? JSON.stringify({ type: "tool_calls", calls: [{ id: `call_${requests.length}`, name: "system_info", input: {} }] })
        : "FINAL\n已有证据足够。";
      return { id: `res_${requests.length}`, requestId: request.id, content, model: request.model,
        finishReason: "stop", outputLength: content.length, durationMs: 1 };
    } };
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace).runTurn({
      sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "分析项目"
    });
    expect(result.status).toBe("completed");
    expect(requests[2].messages.at(-1)?.content).toContain("没有新增证据");
    const traceText = await readFile(join(workspace, ".figo-agent/artifacts/sessions/ses_1/trace.jsonl"), "utf8");
    expect(traceText).toContain("tool_call.no_progress");
  });

  it("detects repeated file evidence even when batch order changes", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-reordered-evidence-"));
    await writeFile(join(workspace, "a.md"), "A", "utf8");
    await writeFile(join(workspace, "b.md"), "B", "utf8");
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const requests: LLMRequest[] = [];
    const llm: LLMProvider = { complete: async (request) => {
      requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
      const paths = requests.length === 1 ? ["a.md", "b.md"] : ["b.md", "a.md"];
      const content = requests.length <= 2
        ? JSON.stringify({ type: "tool_calls", calls: paths.map((path, index) => ({
          id: `call_${requests.length}_${index}`, name: "read_file", input: { path }
        })) })
        : "FINAL\n已有证据足够。";
      return { id: `res_${requests.length}`, requestId: request.id, content, model: request.model,
        finishReason: "stop", outputLength: content.length, durationMs: 1 };
    } };
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace).runTurn({
      sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "分析项目"
    });
    expect(result.status).toBe("completed");
    expect(requests[2].messages.at(-1)?.content).toContain("没有新增证据");
    const traceText = await readFile(join(workspace, ".figo-agent/artifacts/sessions/ses_1/trace.jsonl"), "utf8");
    expect(traceText).toContain("tool_call.no_progress");
  });

  it("recognizes the same file evidence across batch and single-file tools", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-cross-tool-evidence-"));
    await writeFile(join(workspace, "a.md"), "A", "utf8");
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const requests: LLMRequest[] = [];
    const llm: LLMProvider = { complete: async (request) => {
      requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
      const content = requests.length === 1
        ? JSON.stringify({ type: "tool_calls", calls: [{ id: "batch", name: "read_many_files", input: { paths: ["a.md"] } }] })
        : requests.length === 2
          ? JSON.stringify({ type: "tool_calls", calls: [{ id: "single", name: "read_file", input: { path: "a.md" } }] })
          : "FINAL\n已有证据足够。";
      return { id: `res_${requests.length}`, requestId: request.id, content, model: request.model,
        finishReason: "stop", outputLength: content.length, durationMs: 1 };
    } };
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace).runTurn({
      sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "分析项目"
    });
    expect(result.status).toBe("completed");
    expect(requests[2].messages.at(-1)?.content).toContain("没有新增证据");
  });
  it("applies the configured prompts and records their version for the turn", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-prompts-"));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const llm = new InlineToolCallingLlm();
    const host = await setupHost(storage, trace, llm, registry);
    const loop = new AgentLoop(host, trace, { loadPrompts: async () => ({
      prompts: { systemInstruction: "核对证据", userInstruction: "中文文档" }, version: "prompt-v1"
    }) });
    const result = await loop.runTurn({ sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "查询配置" });
    expect(result.status).toBe("completed");
    expect(llm.requests[0].messages[0].content).toContain("核对证据");
    expect(llm.requests[0].messages[1].content).toContain("持久用户指令：\n中文文档");
    const traceText = await readFile(join(workspace, ".figo-agent/artifacts/sessions/ses_1/trace.jsonl"), "utf8");
    expect(traceText).toContain('"type":"prompt.config.applied"');
    expect(traceText).toContain('"version":"prompt-v1"');
  });
  it("compacts older tool rounds before the next LLM call and retains the latest tool result", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const llm = new RoundCallingLlm();
    const host = await setupHost(storage, trace, llm, registry);
    const compaction = new CompactionService(new TaskHistoryReader(storage), new CompactionStore(storage), llm, trace, "M3", readPiCompactionSettings({ keepRecentTokens: 1, reserveTokens: 100 }));
    const loop = new AgentLoop(host, trace, { model: "M3", compaction,
      resolveModelConfig: () => ({ id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "", baseUrl: "", model: "M3", contextWindow: 101 }) });
    const result = await loop.runTurn({ sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "查系统配置" });
    expect(result.status).toBe("completed");
    expect(llm.requests.filter((request) => request.purpose === "task_compaction").length).toBeGreaterThanOrEqual(1);
    const third = llm.requests.filter((request) => request.purpose !== "task_compaction")[2];
    expect(third.messages.some((message) => message.content.includes("先前已查询过系统信息"))).toBe(true);
    expect(third.messages.some((message) => message.content.includes('"name":"system_info"'))).toBe(true);
  });
  it("does not retain a hidden character threshold when no Pi compaction service is installed", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-no-compaction-"));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const llm = new RoundCallingLlm();
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace, { contextConfig: {
      includeMemory: false,
      compaction: readPiCompactionSettings(undefined)
    } }).runTurn({ sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "查系统配置" });
    expect(result.status).toBe("completed");
    expect(llm.requests.filter((request) => request.purpose === "round_compaction")).toHaveLength(0);
  });

  it("persists the full redacted tool result while the model receives a preview", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-tool-output-"));
    await writeFile(join(workspace, "large.txt"), "x".repeat(20000));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    await registry.execute("read_file", { path: "large.txt" }, {
      sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, intentId: "call_1", round: 0
    });
    const stored = storage.db.prepare("select output_json from tool_calls where intent_id = 'call_1'").get() as { output_json: string };
    expect(JSON.parse(stored.output_json)).toMatchObject({ path: "large.txt", content: "x".repeat(20000) });
  });
  it("executes a single inline tool JSON before returning a final answer", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const toolRegistry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace);
    for (const tool of createReadOnlyTools()) toolRegistry.register(tool);
    const fakeLlm = new InlineToolCallingLlm();
    const host = await setupHost(storage, trace, fakeLlm, toolRegistry);
    const loop = new AgentLoop(host, trace);

    const result = await loop.runTurn({
      sessionId: "ses_1",
      taskId: "task_1",
      turnId: "turn_1",
      workspaceRoot: workspace,
      input: "查询当前电脑配置"
    });

    expect(result.message).toBe("已根据工具结果完成查询。");
    expect(fakeLlm.requests).toHaveLength(2);
    expect(fakeLlm.requests[1].messages.at(-1)?.content).toContain('"name":"system_info"');
    expect(fakeLlm.requests[1].estimatedInputTokens).toBeGreaterThan(fakeLlm.requests[0].estimatedInputTokens ?? 0);
    const traceEvents = (await readFile(join(workspace, ".figo-agent/artifacts/sessions/ses_1/trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    expect(traceEvents.some((event) => event.type === "tool.called")).toBe(true);
    expect(traceEvents.some((event) => event.type === "tool_call.parse.completed" && event.payload.callCount === 0)).toBe(true);
  });

  it("repairs a mixed response without executing its tool call", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-repair-"));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const requests: LLMRequest[] = [];
    const llm: LLMProvider = { complete: async (request) => {
      requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
      const content = requests.length === 1
        ? '```json\n{"type":"tool_calls","calls":[{"id":"call_1","name":"system_info","input":{}}]}\n```\n已经得到答案。'
        : "FINAL\n请先限定分析范围。";
      return { id: `res_${requests.length}`, requestId: request.id, content, model: request.model,
        finishReason: "stop", outputLength: content.length, durationMs: 1 };
    } };
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace).runTurn({
      sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "分析项目"
    });
    expect(result.status).toBe("completed");
    expect(result.message).toBe("请先限定分析范围。");
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)?.content).toContain("未执行任何工具");
    expect(storage.db.prepare("select count(*) count from tool_calls").get()).toMatchObject({ count: 0 });
  });

  it("repairs XML tool output after a completed tool round and continues to a final answer", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-xml-repair-"));
    await writeFile(join(workspace, "AGENTS.MD"), "中文文档原则", "utf8");
    await writeFile(join(workspace, "VERSION.md"), "v1", "utf8");
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const requests: LLMRequest[] = [];
    const responses = [
      JSON.stringify({ type: "tool_calls", calls: [{ id: "call_1", name: "read_file", input: { path: "AGENTS.MD" } }] }),
      '<tool_calls>\n<invoke name="read_many_files">\n<parameter name="paths">["VERSION.md"]</parameter>\n</invoke>\n</tool_calls>',
      JSON.stringify({ type: "tool_calls", calls: [{ id: "call_2", name: "read_many_files", input: { paths: ["VERSION.md"] } }] }),
      "FINAL\n项目已分析，版本为 v1。"
    ];
    const llm: LLMProvider = { complete: async (request) => {
      requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
      const content = responses[requests.length - 1];
      return { id: `res_${requests.length}`, requestId: request.id, content, model: request.model,
        finishReason: "stop", outputLength: content.length, durationMs: 1 };
    } };
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace).runTurn({
      sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "深度分析当前项目"
    });
    expect(result.status).toBe("completed");
    expect(result.message).toBe("项目已分析，版本为 v1。");
    expect(requests).toHaveLength(4);
    expect(requests[2].messages.at(-1)?.content).toContain("未执行任何工具");
    expect(storage.db.prepare("select tool_name from tool_calls order by rowid").all())
      .toEqual([{ tool_name: "read_file" }, { tool_name: "read_many_files" }]);
    const events = await readFile(join(workspace, ".figo-agent/artifacts/sessions/ses_1/trace.jsonl"), "utf8");
    expect(events).toContain("unsupported_tool_calls_xml");
  });

  it("fails visibly after a repeated protocol violation", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-repair-fail-"));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    let calls = 0;
    const llm: LLMProvider = { complete: async (request) => {
      calls++;
      const content = '```json\n{"type":"tool_calls","calls":[{"id":"call_1","name":"system_info","input":{}}]}\n```\n已经得到答案。';
      return { id: `res_${calls}`, requestId: request.id, content, model: request.model,
        finishReason: "stop", outputLength: content.length, durationMs: 1 };
    } };
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace).runTurn({
      sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "分析项目"
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("模型响应格式");
    expect(calls).toBe(2);
    expect(storage.db.prepare("select count(*) count from tool_calls").get()).toMatchObject({ count: 0 });
  });

  it("executes structured tool calls and sends tool results to a second LLM call", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "AGENTS.MD"), "中文文档原则", "utf8");
    await writeFile(join(workspace, "readme.md"), "# 项目\nTool Calling Loop", "utf8");
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const toolRegistry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) toolRegistry.register(tool);
    const fakeLlm = new ToolCallingLlm();
    const host = await setupHost(storage, trace, fakeLlm, toolRegistry);
    const loop = new AgentLoop(host, trace);

    const result = await loop.runTurn({
      sessionId: "ses_1",
      taskId: "task_1",
      turnId: "turn_1",
      workspaceRoot: workspace,
      input: "你自己查询当前电脑配置"
    });

    expect(result.status).toBe("completed");
    expect(result.message).toContain("真实系统信息");
    expect(fakeLlm.requests).toHaveLength(2);
    expect(fakeLlm.requests[0].messages.at(-1)?.content).toContain("内容：\n你自己查询当前电脑配置");
    expect(fakeLlm.requests[1].messages.at(-1)?.content).toContain("\"type\":\"tool_results\"");
    expect(fakeLlm.requests[1].messages.at(-1)?.content).toContain("\"system_info\"");

    const jsonl = await readFile(join(workspace, ".figo-agent/artifacts/sessions/ses_1/trace.jsonl"), "utf8");
    expect(jsonl).toContain("tool_call.parse.completed");
    expect(jsonl).toContain("tool_call.round.completed");
    expect(jsonl).toContain("policy.evaluated");
    expect(jsonl).toContain("tool.called");
    expect(jsonl).toContain("tool.completed");
    const call = storage.db.prepare("select id, intent_id, tool_name, status from tool_calls where turn_id = ?")
      .get("turn_1") as { id: string; intent_id: string; tool_name: string; status: string };
    expect(call).toMatchObject({ intent_id: "call_1", tool_name: "system_info", status: "completed" });
    expect(jsonl).toContain(call.id);
  });

  it("rejects function_calls XML without executing tools", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "AGENTS.MD"), "中文文档原则", "utf8");
    await writeFile(join(workspace, "readme.md"), "# 项目\nTool Calling Loop", "utf8");
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const toolRegistry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace);
    for (const tool of createReadOnlyTools()) toolRegistry.register(tool);
    const fakeLlm = new XmlToolCallingLlm();
    const host = await setupHost(storage, trace, fakeLlm, toolRegistry);
    const loop = new AgentLoop(host, trace);

    const result = await loop.runTurn({
      sessionId: "ses_1",
      taskId: "task_1",
      turnId: "turn_1",
      workspaceRoot: workspace,
      input: "你自己查询当前电脑配置"
    });

    expect(result.status).toBe("failed");
    expect(result.message).toContain("模型响应格式");
    expect(fakeLlm.requests).toHaveLength(2);

    const jsonl = await readFile(join(workspace, ".figo-agent/artifacts/sessions/ses_1/trace.jsonl"), "utf8");
    expect(jsonl).toContain("tool_call.parse.failed");
    expect(jsonl).not.toContain("tool.called");
    expect(jsonl).not.toContain("policy.evaluated");
  });
});

class RoundCallingLlm implements LLMProvider {
  public readonly requests: LLMRequest[] = [];
  private ordinaryCalls = 0;
  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
    let content: string;
    if (request.purpose === "task_compaction") {
      content = "## Goal\n先前已查询过系统信息";
    } else {
      this.ordinaryCalls++;
      content = this.ordinaryCalls <= 2
        ? JSON.stringify({ type: "tool_calls", calls: [{ id: `call_${this.ordinaryCalls}`, name: "system_info", input: {} }] })
        : "查询完成";
    }
    return { id: `res_${this.requests.length}`, requestId: request.id, content, model: request.model, finishReason: "stop", outputLength: content.length, durationMs: 1 };
  }
}

class InlineToolCallingLlm implements LLMProvider {
  public readonly requests: LLMRequest[] = [];

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const content = this.requests.length === 1
      ? '{"type":"tool_calls","calls":[{"id":"call_1","name":"system_info","input":{}}]}'
      : "已根据工具结果完成查询。";
    return {
      id: `llm_res_${this.requests.length}`,
      requestId: request.id,
      content,
      model: request.model,
      finishReason: "stop",
      outputLength: content.length,
      durationMs: 1
    };
  }
}

class ToolCallingLlm implements LLMProvider {
  public readonly requests: LLMRequest[] = [];

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
    const content =
      this.requests.length === 1
        ? [
            "```json",
            JSON.stringify({
              type: "tool_calls",
              calls: [{ id: "call_1", name: "system_info", input: {} }]
            }),
            "```"
          ].join("\n")
        : "真实系统信息已查询完成。";
    return {
      id: `llm_res_${this.requests.length}`,
      requestId: request.id,
      content,
      model: request.model,
      finishReason: "stop",
      outputLength: content.length,
      durationMs: 1
    };
  }
}

class XmlToolCallingLlm implements LLMProvider {
  public readonly requests: LLMRequest[] = [];

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
    const content = [
      "<function_calls>",
      "<invoke name=\"run_command\">",
      "<parameter name=\"command\">uname -a</parameter>",
      "</invoke>",
      "</function_calls>",
      "请稍等，命令正在执行中..."
    ].join("\n");
    return {
      id: "llm_res_xml",
      requestId: request.id,
      content,
      model: request.model,
      finishReason: "stop",
      outputLength: content.length,
      durationMs: 1
    };
  }
}

async function setupStorage(): Promise<StorageManager> {
  const storage = databases.track(await StorageManager.init(workspace));
  storage.db
    .prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)")
    .run("ses_1", workspace, "active", "2026-10-11T00:00:00.000Z");
  storage.db
    .prepare("insert into tasks (id, session_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
    .run("task_1", "ses_1", "default", "active", "2026-10-11T00:00:00.000Z", "2026-10-11T00:00:00.000Z");
  storage.db
    .prepare("insert into turns (id, session_id, task_id, input, status, created_at) values (?, ?, ?, ?, ?, ?)")
    .run("turn_1", "ses_1", "task_1", "你自己查询当前电脑配置", "processing", "2026-10-11T00:00:00.000Z");
  return storage;
}

async function setupHost(
  storage: StorageManager,
  trace: TraceRecorder,
  llm: LLMProvider,
  toolRegistry: ToolRegistry
): Promise<PluginHost> {
  const host = new PluginHost();
  host.register({
    manifest: {
      id: "builtin",
      name: "Builtin",
      version: "0.1.0",
      description: "builtin",
      capabilities: []
    },
    setup: async () => ({
      capabilities: [
        {
          type: "contextSource",
          name: "context-builder",
          value: new ContextBuilder(storage, new SqliteMemoryStore(storage), trace)
        },
        { type: "llmProvider", name: "minimax", value: llm },
        { type: "tool", name: "registry", value: toolRegistry },
        {
          type: "skill",
          name: "project-understanding-skill",
          value: new ProjectUnderstandingSkill(storage, toolRegistry)
        },
        { type: "reporter", name: "markdown", value: new MarkdownReporter(storage) }
      ]
    })
  });
  await host.setupAll({});
  return host;
}
