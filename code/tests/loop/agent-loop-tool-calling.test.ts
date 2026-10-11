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
  it("compacts older tool rounds before the next LLM call and retains the latest tool result", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace);
    for (const tool of createReadOnlyTools()) registry.register(tool);
    const llm = new RoundCallingLlm();
    const host = await setupHost(storage, trace, llm, registry);
    const loop = new AgentLoop(host, trace, { maxToolRounds: 3, model: "M3", contextConfig: {
      includeProjectDocs: false, projectDocPaths: [], maxTaskHistoryTurns: 5, includeMemory: false,
      compaction: { autoEnabled: true, turnThreshold: 12, charThreshold: 100, summaryMaxChars: 12000 }
    } });
    const result = await loop.runTurn({ sessionId: "ses_1", taskId: "task_1", turnId: "turn_1", workspaceRoot: workspace, input: "查系统配置" });
    expect(result.status).toBe("completed");
    expect(llm.requests.filter((request) => request.purpose === "round_compaction")).toHaveLength(1);
    const third = llm.requests.filter((request) => request.purpose !== "round_compaction")[2];
    expect(third.messages.some((message) => message.content.includes("round_summary"))).toBe(true);
    expect(third.messages.at(-1)?.content).toContain("system_info");
  });
  it("executes inline tool calls before returning a final answer", async () => {
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

  it("executes structured tool calls and sends tool results to a second LLM call", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "AGENTS.MD"), "中文文档原则", "utf8");
    await writeFile(join(workspace, "readme.md"), "# 项目\nTool Calling Loop", "utf8");
    const storage = await setupStorage();
    const trace = new TraceRecorder(storage);
    const toolRegistry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace);
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

    expect(result.status).toBe("completed");
    expect(result.message).toContain("不支持的工具调用格式");
    expect(fakeLlm.requests).toHaveLength(1);

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
      ? '让我先获取电脑配置。{"type":"tool_calls","calls":[{"id":"call_1","name":"system_info","input":{}}]}'
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
            "需要查询系统信息。",
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
