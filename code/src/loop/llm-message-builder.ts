import type { ContextPack, LLMMessage, LLMToolDefinition, ToolResult } from "../contracts/types.js";
import type { PromptConfig } from "../config/prompt-config.js";
import { zhCN, formatLocaleTemplate } from "../i18n/catalog.js";
import { defaultAgentBehavior } from "../config/runtime-behavior.js";

export interface ToolExecutionRecord {
  id: string;
  name: string;
  status: ToolResult["status"];
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export interface ToolPromptManifest {
  availableTools: LLMToolDefinition[];
  workspaceRoot?: string;
  toolCallingMode?: "text" | "native";
}

export function buildInitialMessages(
  input: string,
  contextPack: ContextPack,
  toolManifest: ToolPromptManifest = { availableTools: [] },
  prompts: PromptConfig = { systemInstruction: "", userInstruction: "" }
): LLMMessage[] {
  const labels = zhCN.agent;
  return [
    {
      role: "system",
      content: formatLocaleTemplate(toolManifest.toolCallingMode === "native" ? labels.nativeSystemTemplate : labels.systemTemplate, {
        systemInstruction: prompts.systemInstruction.trim() ? prompts.systemInstruction : "",
        availableTools: toolManifest.availableTools.map((tool) => `- ${tool.name}: ${tool.description}`
          + (toolManifest.toolCallingMode !== "native" && tool.inputSchema
            ? `\n  ${labels.toolInputSchemaLabel}${JSON.stringify(tool.inputSchema)}` : "")).join("\n")
      }) + (toolManifest.workspaceRoot ? `\n${formatLocaleTemplate(labels.workspaceScopeTemplate, { workspaceRoot: toolManifest.workspaceRoot })}` : "")
    },
    {
      role: "user",
      content: [
        ...(prompts.userInstruction.trim() ? [`${labels.userInstructionLabel}\n${prompts.userInstruction}`, "---"] : []),
        `${labels.userInputLabel}${input}`,
        labels.contextLabel,
        ...contextPack.items
          .filter((item) => item.included)
          .map(
            (item) =>
              `\n---\n${labels.sourceLabel}${item.sourceRef}\n${labels.summaryLabel}${item.summary}\n${labels.reasonLabel}${item.reason}\n${labels.contentLabel}\n${item.content}`
          )
      ].join("\n")
    }
  ];
}

export function buildToolResultMessage(
  results: ToolExecutionRecord[],
  maxPreviewChars = defaultAgentBehavior.toolResultPreviewChars,
  maxBatchChars = defaultAgentBehavior.toolResultBatchChars
): LLMMessage {
  const serialize = (previewChars: number) => JSON.stringify({
    type: "tool_results",
    results: results.map((result) => ({
        id: result.id,
        name: result.name,
        status: result.status,
        output: result.output === undefined ? undefined : limitOutput(result.output, previewChars),
        errorCode: result.errorCode,
        errorMessage: result.errorMessage
    }))
  });
  let content = serialize(maxPreviewChars);
  if (content.length > maxBatchChars) {
    let low = 0;
    let high = maxPreviewChars;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (serialize(middle).length <= maxBatchChars) low = middle;
      else high = middle - 1;
    }
    content = serialize(low);
  }
  if (content.length > maxBatchChars) {
    content = JSON.stringify({ type: "tool_results", truncated: true, resultCount: results.length,
      results: results.map(({ id, name, status }) => ({ id, name, status })) });
  }
  if (content.length > maxBatchChars) {
    content = JSON.stringify({ type: "tool_results", truncated: true, resultCount: results.length });
  }
  return { role: "user", content };
}

export function buildNativeToolResultMessages(
  results: ToolExecutionRecord[],
  maxPreviewChars = defaultAgentBehavior.toolResultPreviewChars,
  maxBatchChars = defaultAgentBehavior.toolResultBatchChars
): LLMMessage[] {
  const serialize = (previewChars: number): LLMMessage[] => results.map((result) => ({
    role: "tool",
    toolCallId: result.id,
    content: JSON.stringify({
      name: result.name, status: result.status,
      output: result.output === undefined ? undefined : limitOutput(result.output, previewChars),
      errorCode: result.errorCode, errorMessage: result.errorMessage?.slice(0, previewChars)
    })
  }));
  const size = (messages: LLMMessage[]) => messages.reduce((sum, message) => sum + message.content.length, 0);
  let messages = serialize(maxPreviewChars);
  if (size(messages) <= maxBatchChars) return messages;
  let low = 0;
  let high = maxPreviewChars;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(serialize(middle)) <= maxBatchChars) low = middle;
    else high = middle - 1;
  }
  messages = serialize(low);
  if (size(messages) <= maxBatchChars) return messages;
  messages = results.map((result) => ({ role: "tool", toolCallId: result.id,
    content: JSON.stringify({ status: result.status, truncated: true }) }));
  if (size(messages) <= maxBatchChars) return messages;
  return results.map((result) => ({ role: "tool", toolCallId: result.id, content: "" }));
}

function limitOutput(output: unknown, maxPreviewChars: number): unknown {
  const json = JSON.stringify(output);
  if (json.length <= maxPreviewChars) return output;
  const reference = typeof output === "object" && output !== null && !Array.isArray(output)
    ? output as Record<string, unknown> : {};
  return {
    truncated: true,
    originalChars: json.length,
    ...(typeof reference.path === "string" ? { path: reference.path } : {}),
    ...(Array.isArray(reference.files) ? { paths: reference.files
      .map((file) => typeof file === "object" && file !== null && "path" in file ? file.path : undefined)
      .filter((path): path is string => typeof path === "string") } : {}),
    ...(Array.isArray(reference.errors) ? { errors: reference.errors
      .filter((error) => typeof error === "object" && error !== null && typeof error.path === "string")
      .map((error) => ({ path: error.path, code: error.code })) } : {}),
    preview: json.slice(0, maxPreviewChars)
  };
}
