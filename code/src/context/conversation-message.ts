import { createHash } from "node:crypto";
import type { LLMMessage, LLMToolDefinition, LLMUsage } from "../contracts/types.js";

export interface ConversationMessage {
  sourceRef: string;
  turnId: string;
  message: LLMMessage;
  usage?: LLMUsage;
  usageScope?: string;
  stopReason?: "stop" | "length" | "tool_calls" | "error" | "aborted";
  omitted?: boolean;
}

export function conversationUsageScope(providerId: string, model: string, system: string, tools?: LLMToolDefinition[]): string {
  return wireUsageScope(providerId, model, system, wireToolDefinitions(tools));
}

export function wireToolDefinitions(tools?: LLMToolDefinition[]) {
  return tools?.map((tool) => ({ type: "function", function: {
    name: tool.name, description: tool.description, parameters: tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: true }
  } }));
}

export function wireUsageScope(providerId: string, model: string, system: string, tools?: unknown): string {
  return createHash("sha256").update(JSON.stringify({ providerId, model, system, tools: tools ?? [] })).digest("hex");
}
