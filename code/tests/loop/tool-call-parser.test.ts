import { describe, expect, it } from "vitest";
import { ToolCallParser } from "../../src/loop/tool-call-parser.js";

describe("ToolCallParser", () => {
  it("parses strict fenced JSON tool calls", () => {
    const parsed = new ToolCallParser().parse(`
\`\`\`json
{
  "type": "tool_calls",
  "calls": [
    {
      "id": "call_1",
      "name": "system_info",
      "input": {}
    }
  ]
}
\`\`\`
`);

    expect(parsed).toEqual({
      kind: "tool_calls",
      calls: [{ id: "call_1", name: "system_info", input: {} }]
    });
  });

  it("parses one inline JSON tool call after a complete thinking block", () => {
    const parsed = new ToolCallParser().parse(`<think>用户问当前电脑是否可以部署 https://github.com/duixcom/Duix-Avatar 这个项目。我需要先查看一下项目的部署要求，然后再检查本机环境。让我先获取项目信息和本机环境。</think>

{"type":"tool_calls","calls":[{"id":"call_1","name":"browser_open","input":{"url": "https://github.com/duixcom/Duix-Avatar"}},{"id":"call_2","name":"system_info","input":{}}]}`);

    expect(parsed).toEqual({
      kind: "tool_calls",
      calls: [
        { id: "call_1", name: "browser_open", input: { url: "https://github.com/duixcom/Duix-Avatar" } },
        { id: "call_2", name: "system_info", input: {} }
      ]
    });
  });

  it("rejects repeated tool blocks instead of silently executing only the first", () => {
    const block = '```json\n{"type":"tool_calls","calls":[{"id":"call_1","name":"system_info","input":{}}]}\n```';
    expect(new ToolCallParser().parse(`${block}\n${block}`)).toEqual({ kind: "invalid", reason: "multiple_tool_call_blocks" });
  });

  it("rejects a tool block mixed with a final answer", () => {
    const content = '```json\n{"type":"tool_calls","calls":[{"id":"call_1","name":"system_info","input":{}}]}\n```\n当前项目已分析完成。';
    expect(new ToolCallParser().parse(content)).toEqual({ kind: "invalid", reason: "mixed_tool_call_response" });
  });

  it("rejects a final marker followed by a tool call block", () => {
    const content = 'FINAL\n分析结果如下。\n```json\n{"type":"tool_calls","calls":[{"id":"call_1","name":"system_info","input":{}}]}\n```';
    expect(new ToolCallParser().parse(content)).toEqual({ kind: "invalid", reason: "mixed_tool_call_response" });
  });

  it("rejects explanatory prose before inline tool JSON", () => {
    const content = '我先查询。{"type":"tool_calls","calls":[{"id":"call_1","name":"system_info","input":{}}]}';
    expect(new ToolCallParser().parse(content)).toEqual({ kind: "invalid", reason: "mixed_tool_call_response" });
  });

  it("rejects malformed inline tool call JSON", () => {
    const parsed = new ToolCallParser().parse('准备查询。{"type":"tool_calls","calls":[{"id":"call_1"}');

    expect(parsed).toEqual({ kind: "invalid", reason: "invalid_json" });
  });

  it("rejects function_calls XML instead of executing it", () => {
    const parsed = new ToolCallParser().parse(`
<function_calls>
<invoke name="run_command">
<parameter name="command">uname -a</parameter>
</invoke>
</function_calls>
`);

    expect(parsed).toEqual({
      kind: "invalid",
      reason: "unsupported_function_calls_xml"
    });
  });

  it("rejects tool_calls XML instead of treating it as a final answer", () => {
    const content = `<tool_calls>
<invoke name="read_many_files">
<parameter name="paths">["AGENTS.MD", "VERSION.md"]</parameter>
</invoke>
</tool_calls>`;

    expect(new ToolCallParser().parse(content)).toEqual({ kind: "invalid", reason: "unsupported_tool_calls_xml" });
    expect(new ToolCallParser().parse(`FINAL\n已完成。\n${content}`))
      .toEqual({ kind: "invalid", reason: "unsupported_tool_calls_xml" });
  });

  it("rejects invalid or duplicate tool call ids", () => {
    const parsed = new ToolCallParser().parse(`
\`\`\`json
{
  "type": "tool_calls",
  "calls": [
    { "id": "call_1", "name": "system_info", "input": {} },
    { "id": "call_1", "name": "path_stat", "input": { "path": "." } }
  ]
}
\`\`\`
`);

    expect(parsed).toEqual({
      kind: "invalid",
      reason: "duplicate_tool_call_id"
    });
  });

  it("returns none when the model provides a normal final answer", () => {
    const parsed = new ToolCallParser().parse("这是最终回答，没有工具调用。");

    expect(parsed).toEqual({ kind: "none" });
  });
});
