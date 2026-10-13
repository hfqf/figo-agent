import type { LLMMessage, LLMToolDefinition } from "../contracts/types.js";

export function estimateMessageTokens(messages: LLMMessage[], availableTools: LLMToolDefinition[] = []): number {
  const messageChars = messages.reduce((sum, message) => sum + message.content.length +
    (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0) + (message.toolCallId?.length ?? 0), 0);
  const toolChars = availableTools.length ? JSON.stringify(availableTools).length : 0;
  return Math.max(messages.length, Math.ceil((messageChars + toolChars) / 4));
}
