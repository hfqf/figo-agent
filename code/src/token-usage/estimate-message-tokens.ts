import type { LLMMessage } from "../contracts/types.js";

export function estimateMessageTokens(messages: LLMMessage[]): number {
  return messages.reduce((sum, message) => sum + Math.max(1, Math.ceil(message.content.length / 4)), 0);
}
