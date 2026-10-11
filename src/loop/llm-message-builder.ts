import type { ContextPack, LLMMessage, ToolResult } from "../contracts/types.js";

export interface ToolExecutionRecord {
  id: string;
  name: string;
  status: ToolResult["status"];
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export interface ToolPromptManifest {
  availableTools: Array<{ name: string; description: string }>;
  maxToolRounds: number;
}

export function buildInitialMessages(
  input: string,
  contextPack: ContextPack,
  toolManifest: ToolPromptManifest = { availableTools: [], maxToolRounds: 3 }
): LLMMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是 Figo Agent V1，输出中文。",
        "你可以通过严格 JSON 协议请求工具调用。",
        "如果需要调用工具，只输出 fenced json，格式为 {\"type\":\"tool_calls\",\"calls\":[{\"id\":\"call_1\",\"name\":\"system_info\",\"input\":{}}]}。",
        "不要输出 <function_calls>。不要把自然语言命令当作工具执行结果。",
        `工具调用轮次上限：${toolManifest.maxToolRounds}`,
        "当前实际注册工具：",
        ...toolManifest.availableTools.map((tool) => `- ${tool.name}: ${tool.description}`)
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `用户输入：${input}`,
        "上下文内容：",
        ...contextPack.items
          .filter((item) => item.included)
          .map(
            (item) =>
              `\n---\n来源：${item.sourceRef}\n摘要：${item.summary}\n原因：${item.reason}\n内容：\n${item.content}`
          )
      ].join("\n")
    }
  ];
}

export function buildToolResultMessage(results: ToolExecutionRecord[]): LLMMessage {
  return {
    role: "user",
    content: JSON.stringify({
      type: "tool_results",
      results: results.map((result) => ({
        id: result.id,
        name: result.name,
        status: result.status,
        output: result.output === undefined ? undefined : limitOutput(result.output),
        errorCode: result.errorCode,
        errorMessage: result.errorMessage
      }))
    })
  };
}

function limitOutput(output: unknown): unknown {
  const json = JSON.stringify(output);
  if (json.length <= 8000) return output;
  return {
    truncated: true,
    preview: json.slice(0, 8000)
  };
}
