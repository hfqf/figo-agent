import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("AgentLoop tool calling", () => {
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
  it("repairs a mixed native response without executing its tool call", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-native-repair-"));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace, storage);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const requests: LLMRequest[] = [];
    const llm: LLMProvider = { toolCallingMode: "native", complete: async (request) => {
      requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
      return requests.length === 1
        ? { id: "res_1", requestId: request.id, content: "已经完成", model: request.model,
          finishReason: "tool_calls", toolCalls: [{ id: "call_1", name: "system_info", input: {} }], outputLength: 4, durationMs: 1 }
        : { id: "res_2", requestId: request.id, content: "请先核实范围。", model: request.model,
          finishReason: "stop", outputLength: 7, durationMs: 1 };
    } };
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace).runTurn({
      sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "分析项目"
    });
    expect(result.status).toBe("completed");
    expect(storage.db.prepare("select count(*) count from tool_calls").get()).toMatchObject({ count: 0 });
    expect(requests[1].messages.at(-1)?.content).toContain("原生工具");
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
    const loop = new AgentLoop(host, trace, { model: "M3", contextConfig: {
      maxTaskHistoryTurns: 5, includeMemory: false,
      compaction: { autoEnabled: true, turnThreshold: 12, charThreshold: 100, summaryMaxChars: 50 }
    } });
    const result = await loop.runTurn({ sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "查系统配置" });
    expect(result.status).toBe("completed");
    expect(llm.requests.filter((request) => request.purpose === "round_compaction")).toHaveLength(1);
    const third = llm.requests.filter((request) => request.purpose !== "round_compaction")[2];
    expect(third.messages.some((message) => message.content.includes("round_summary"))).toBe(true);
    expect(third.messages.some((message) => message.content.includes('"name":"system_info"'))).toBe(true);
  });
  it("skips round compaction when older messages cannot save meaningful space", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-no-compaction-"));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const llm = new RoundCallingLlm();
    const host = await setupHost(storage, trace, llm, registry);
    const result = await new AgentLoop(host, trace, { contextConfig: {
      maxTaskHistoryTurns: 5, includeMemory: false,
      compaction: { autoEnabled: true, turnThreshold: 12, charThreshold: 100, summaryMaxChars: 12000 }
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
    if (request.purpose === "round_compaction") {
      content = JSON.stringify({ summary: "先前已查询过系统信息" });
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
  const storage = await StorageManager.init(workspace);
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
