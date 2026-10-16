import { describe, expect, it } from "vitest";
import type { ContextPack } from "../../src/contracts/types.js";
import { buildInitialMessages, buildNativeToolResultMessages, buildToolResultMessage } from "../../src/loop/llm-message-builder.js";
import { createWriteTools } from "../../src/tools/write-tools.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { ControlledToolPolicy } from "../../src/policy/controlled-tool-policy.js";

describe("LLM message builder", () => {
  it("exposes the registered write_file parent directory option to text models", () => {
    const registry = new ToolRegistry(new ControlledToolPolicy(process.cwd()));
    for (const tool of createWriteTools()) registry.register(tool);
    const tools = registry.listTools();
    const writeFile = tools.find((tool) => tool.name === "write_file")!;
    expect(writeFile.inputSchema).toMatchObject({ properties: { createDirs: { type: "boolean", default: false } } });
    const messages = buildInitialMessages("新建目录并写入报告", contextPack(), {
      availableTools: tools, toolCallingMode: "text"
    });
    expect(messages[0].content).toContain(JSON.stringify(writeFile.inputSchema));
    expect(messages[0].content).toContain("createDirs=true");
  });

  it("includes declared input schemas in text tool prompts", () => {
    const inputSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    const tool = { name: "read_file", description: "读取文件", inputSchema };
    const messages = buildInitialMessages("读取 order.json", contextPack(), { availableTools: [tool], toolCallingMode: "text" });
    expect(messages[0].content).toContain(JSON.stringify(inputSchema));
    expect(buildInitialMessages("读取文件", contextPack(), { availableTools: [tool], toolCallingMode: "native" })[0].content)
      .not.toContain(JSON.stringify(inputSchema));
  });
  it("includes ContextItem content instead of only summaries", () => {
    const messages = buildInitialMessages("命令执行完毕了吗", contextPack());
    const userMessage = messages.at(-1)?.content ?? "";

    expect(userMessage).toContain("用户输入：命令执行完毕了吗");
    expect(userMessage).toContain("task.turn:2");
    expect(userMessage).toContain("你自己查询当前电脑配置");
    expect(userMessage).toContain("上一轮模型输出了工具调用文本");
  });

  it("keeps the tool protocol and separates persistent user instructions from turn input", () => {
    const messages = buildInitialMessages("本轮任务", contextPack(), { availableTools: [] }, {
      systemInstruction: "始终说明证据", userInstruction: "文档使用中文"
    });
    expect(messages[0].content).toContain("严格 JSON 协议");
    expect(messages[0].content).toContain("<tool_calls>");
    expect(messages[0].content).toContain("始终说明证据");
    expect(messages[1].content).toContain("持久用户指令：\n文档使用中文");
    expect(messages[1].content).toContain("用户输入：本轮任务");
  });

  it("binds current-project requests to the workspace root", () => {
    const messages = buildInitialMessages("分析当前项目", contextPack(), {
      availableTools: [], workspaceRoot: "/tmp/figo-wiki"
    });
    expect(messages[0].content).toContain("/tmp/figo-wiki");
    expect(messages[0].content).toContain("子项目");
  });

  it("uses native tool instructions without the text JSON protocol", () => {
    const messages = buildInitialMessages("分析当前项目", contextPack(), {
      availableTools: [], workspaceRoot: "/tmp/project", toolCallingMode: "native"
    });
    expect(messages[0].content).toContain("原生工具调用");
    expect(messages[0].content).not.toContain("fenced json");
  });

  it("builds structured tool result messages with bounded output", () => {
    const message = buildToolResultMessage([
      {
        id: "call_1",
        name: "system_info",
        status: "completed",
        output: { platform: "darwin", cpuCount: 10 }
      }
    ]);

    expect(message.role).toBe("user");
    expect(message.content).toContain("\"type\":\"tool_results\"");
    expect(message.content).toContain("\"id\":\"call_1\"");
    expect(message.content).toContain("\"platform\":\"darwin\"");
  });

  it("applies one budget to the entire tool batch and preserves file references", () => {
    const message = buildToolResultMessage([1, 2, 3].map((index) => ({
      id: `call_${index}`, name: "read_file", status: "completed" as const,
      output: { path: `file_${index}.md`, content: "x".repeat(7000) }
    })), 8000, 6000);
    const parsed = JSON.parse(message.content) as { results: Array<{ id: string; output: { truncated: boolean; path: string } }> };
    expect(message.content.length).toBeLessThanOrEqual(6000);
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results.map((result) => result.output.path)).toEqual(["file_1.md", "file_2.md", "file_3.md"]);
    expect(parsed.results.every((result) => result.output.truncated)).toBe(true);
  });

  it("preserves per-file errors when a batch result preview is truncated", () => {
    const message = buildToolResultMessage([{
      id: "call_1", name: "read_many_files", status: "completed" as const,
      output: {
        files: [{ path: "large.md", content: "x".repeat(9000), sizeBytes: 9000, truncated: false }],
        errors: [{ path: "missing.md", code: "ENOENT", message: "文件不存在" }]
      }
    }], 1000, 4000);
    const parsed = JSON.parse(message.content) as { results: Array<{ output: { errors: Array<{ path: string; code: string }> } }> };
    expect(parsed.results[0].output.errors).toEqual([{ path: "missing.md", code: "ENOENT" }]);
  });

  it("bounds native tool results across the batch and retains call ids", () => {
    const messages = buildNativeToolResultMessages([1, 2, 3].map((index) => ({
      id: `call_${index}`, name: "read_file", status: "completed" as const,
      output: { path: `file_${index}.md`, content: "x".repeat(7000) }
    })), 8000, 6000);
    expect(messages).toHaveLength(3);
    expect(messages.map((message) => message.toolCallId)).toEqual(["call_1", "call_2", "call_3"]);
    expect(messages.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(6000);
    expect(messages.map((message) => JSON.parse(message.content).output.path)).toEqual([
      "file_1.md", "file_2.md", "file_3.md"
    ]);
  });
});

function contextPack(): ContextPack {
  return {
    id: "ctx_1",
    sessionId: "ses_1",
    taskId: "task_1",
    turnId: "turn_3",
    estimatedTokens: 10,
    createdAt: "2026-10-11T00:00:00.000Z",
    items: [
      {
        id: "ctx_item_1",
        sourceType: "turn",
        sourceRef: "turn.input",
        summary: "当前用户输入",
        content: "命令执行完毕了吗",
        estimatedTokens: 2,
        included: true,
        reason: "当前 Turn 的直接输入"
      },
      {
        id: "ctx_item_2",
        sourceType: "task_turn",
        sourceRef: "task.turn:2",
        summary: "当前 Task 历史 Turn 2",
        content: "你自己查询当前电脑配置\n上一轮模型输出了工具调用文本",
        estimatedTokens: 12,
        included: true,
        reason: "当前 Task 内最近 Turn 历史"
      }
    ]
  };
}
