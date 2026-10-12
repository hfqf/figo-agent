import type { ContextPack, LLMMessage, ToolResult } from "../contracts/types.js";
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
  availableTools: Array<{ name: string; description: string }>;
  maxToolRounds: number;
}

export function buildInitialMessages(
  input: string,
  contextPack: ContextPack,
  toolManifest: ToolPromptManifest = { availableTools: [], maxToolRounds: 3 },
  prompts: PromptConfig = { systemInstruction: "", userInstruction: "" }
): LLMMessage[] {
  const labels = zhCN.agent;
  return [
    {
      role: "system",
      content: formatLocaleTemplate(labels.systemTemplate, {
        systemInstruction: prompts.systemInstruction.trim() ? prompts.systemInstruction : "",
        maxToolRounds: toolManifest.maxToolRounds,
        availableTools: toolManifest.availableTools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")
      })
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

export function buildToolResultMessage(results: ToolExecutionRecord[], maxPreviewChars = defaultAgentBehavior.toolResultPreviewChars): LLMMessage {
  return {
    role: "user",
    content: JSON.stringify({
      type: "tool_results",
      results: results.map((result) => ({
        id: result.id,
        name: result.name,
        status: result.status,
        output: result.output === undefined ? undefined : limitOutput(result.output, maxPreviewChars),
        errorCode: result.errorCode,
        errorMessage: result.errorMessage
      }))
    })
  };
}

function limitOutput(output: unknown, maxPreviewChars: number): unknown {
  const json = JSON.stringify(output);
  if (json.length <= maxPreviewChars) return output;
  return {
    truncated: true,
    preview: json.slice(0, maxPreviewChars)
  };
}
