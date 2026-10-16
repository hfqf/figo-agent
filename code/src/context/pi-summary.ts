/**
 * Adapted from earendil-works/pi, MIT License.
 * Copyright (c) 2025 Mario Zechner
 * Commit: 6a1f799b675c8cb98320b71ff7ee44f160fe8d66
 * Sources: packages/coding-agent/src/core/compaction/{compaction,utils}.ts
 * License: ../../third-party/pi/LICENSE
 */
import { readFileSync } from "node:fs";
import type { LLMProvider, LLMRequest, LLMUsage } from "../contracts/types.js";
import { createId } from "../utils/id.js";
import { ToolCallParser } from "../loop/tool-call-parser.js";
import type { ConversationMessage } from "./conversation-message.js";
import type { PiMessage } from "./pi-compaction.js";

export interface PiSummaryInput {
  sessionId: string;
  taskId: string;
  turnId: string;
  usageTurnId?: string | null;
  model: string;
  maxTokens?: number;
  maxTokensField?: LLMRequest["maxTokensField"];
  reserveTokens: number;
  summaryToolResultMaxChars: number;
  history: ConversationMessage[];
  turnPrefix: ConversationMessage[];
  previousSummary?: string;
  previousReadFiles?: string[];
  previousModifiedFiles?: string[];
  instructions?: string;
  signal?: AbortSignal;
}

export interface PiSummaryResult {
  summaryMarkdown: string;
  requestId: string;
  requestIds: string[];
  readFiles: string[];
  modifiedFiles: string[];
  usage?: LLMUsage;
}

const locale = JSON.parse(readFileSync(new URL("../../locales/pi-summary.zh-CN.json", import.meta.url), "utf8")) as Record<string, string>;
const toolCallParser = new ToolCallParser();

export async function generatePiSummary(llm: LLMProvider, input: PiSummaryInput): Promise<PiSummaryResult> {
  input.signal?.throwIfAborted();
  const history = input.history.map(toSummaryMessage);
  const turnPrefix = input.turnPrefix.map(toSummaryMessage);
  const requestIds: string[] = [];
  const usages: Array<LLMUsage | undefined> = [];

  async function summarize(messages: PiMessage[], prefix: boolean): Promise<string> {
    input.signal?.throwIfAborted();
    const conversation = serializeConversation(messages, input.summaryToolResultMaxChars);
    let prompt = format(locale.conversation, { conversation });
    if (!prefix && input.previousSummary) prompt += format(locale.previousSummary, { summary: input.previousSummary });
    prompt += prefix ? locale.turnPrefixPrompt : input.previousSummary ? locale.updatePrompt : locale.initialPrompt;
    if (!prefix && input.instructions) prompt += format(locale.additionalFocus, { instructions: input.instructions });
    const requestId = createId("llm_req");
    requestIds.push(requestId);
    const response = await llm.complete({
      id: requestId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      turnId: input.turnId,
      usageTurnId: input.usageTurnId ?? null,
      model: input.model,
      purpose: "task_compaction",
      maxOutputTokens: Math.min(Math.floor((prefix ? 0.5 : 0.8) * input.reserveTokens),
        input.maxTokens !== undefined && input.maxTokens > 0 ? input.maxTokens : Number.POSITIVE_INFINITY),
      ...(input.maxTokensField ? { maxTokensField: input.maxTokensField } : {}),
      signal: input.signal,
      messages: [
        { role: "system", content: locale.systemPrompt },
        { role: "user", content: prompt }
      ]
    });
    input.signal?.throwIfAborted();
    if (response.finishReason === "error") throw new Error(locale.errorSummary);
    if (response.finishReason === "length") throw new Error(locale.lengthSummary);
    if (response.finishReason === "tool_calls" || response.toolCalls?.length) throw new Error(locale.toolCallsSummary);
    const text = stripThinking(response.content);
    if (toolCallParser.parse(text).kind === "tool_calls") throw new Error(locale.toolCallsSummary);
    if (!text) throw new Error(locale.emptySummary);
    usages.push(response.usage);
    return text;
  }

  let summaryMarkdown: string;
  if (turnPrefix.length > 0) {
    const historyText = history.length > 0 ? await summarize(history, false) : input.previousSummary ?? locale.noPriorHistory;
    const prefixText = await summarize(turnPrefix, true);
    summaryMarkdown = format(locale.splitSummary, { history: historyText, prefix: prefixText });
  } else {
    summaryMarkdown = await summarize(history, false);
  }
  input.signal?.throwIfAborted();
  const { readFiles, modifiedFiles } = fileLists([...history, ...turnPrefix], input.previousReadFiles, input.previousModifiedFiles);
  summaryMarkdown += formatFileOperations(readFiles, modifiedFiles);
  // 只有所有已发请求都返回 usage，才能提供完整聚合量；未知分量不补零。
  const usage = usages.every((item) => item !== undefined) ? usages.reduce<LLMUsage>((sum, item) => ({
    input: sum.input + item!.input,
    output: sum.output + item!.output,
    cacheRead: sum.cacheRead + item!.cacheRead,
    cacheWrite: sum.cacheWrite + item!.cacheWrite,
    totalTokens: sum.totalTokens + item!.totalTokens
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }) : undefined;
  return { summaryMarkdown, requestId: requestIds[requestIds.length - 1], requestIds, readFiles, modifiedFiles,
    ...(usage ? { usage } : {}) };
}

function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, key: string) => key in values ? String(values[key]) : whole);
}

function stripThinking(content: string): string {
  return content.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(?:think|thinking)>[\s\S]*$/gi, "").trim();
}

// 宿主适配：剥离 assistant 内联思考，转换原生和文本工具协议；保留用户与工具正文。
function toSummaryMessage(entry: ConversationMessage): PiMessage {
  const { message } = entry;
  if (message.role === "assistant") {
    const text = stripThinking(message.content);
    const parsed = message.toolCalls?.length ? undefined : toolCallParser.parse(text);
    const calls = message.toolCalls?.length ? message.toolCalls : parsed?.kind === "tool_calls" ? parsed.calls : [];
    return { role: "assistant", content: [
      ...(text && parsed?.kind !== "tool_calls" ? [{ type: "text" as const, text }] : []),
      ...calls.map((call) => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: call.input }))
    ] };
  }
  if (message.role === "tool") return { role: "toolResult", content: message.content, toolCallId: message.toolCallId };
  if (message.role === "system") return { role: "system", content: message.content };
  try {
    if (JSON.parse(message.content)?.type === "tool_results") return { role: "toolResult", content: message.content };
  } catch { /* 普通用户文本无需 JSON。 */ }
  return { role: "user", content: message.content };
}

function contentText(content: string | Array<{ type: string; text?: string }>, separator = "\n"): string {
  return typeof content === "string" ? content
    : content.filter((block) => block.type === "text").map((block) => block.text ?? "").join(separator);
}

// 直接参考固定 Pi utils.ts:serializeConversation；标记进入中文资源，预览上限由配置传入。
function serializeConversation(messages: PiMessage[], maxChars: number): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const content = contentText(msg.content, "");
      if (content) parts.push(format(locale.userMessage, { content }));
    } else if (msg.role === "assistant") {
      const toolCalls: string[] = [];
      for (const block of msg.content) {
        if (block.type === "toolCall") {
          const argsStr = Object.entries(block.arguments)
            .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ");
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }
      if (msg.content.some((block) => block.type === "text")) {
        parts.push(format(locale.assistantMessage, { content: contentText(msg.content) }));
      }
      if (toolCalls.length > 0) parts.push(format(locale.assistantCalls, { content: toolCalls.join("; ") }));
    } else if (msg.role === "toolResult") {
      const content = contentText(msg.content, "");
      if (content) {
        const preview = content.length <= maxChars ? content
          : content.slice(0, maxChars) + format(locale.truncation, { count: content.length - maxChars });
        parts.push(format(locale.toolResult, { content: preview }));
      }
    }
  }
  return parts.join("\n\n");
}

function fileLists(
  messages: PiMessage[], previousReadFiles: string[] = [], previousModifiedFiles: string[] = []
): { readFiles: string[]; modifiedFiles: string[] } {
  const read = new Set(previousReadFiles);
  const modified = new Set(previousModifiedFiles);
  const addPath = (paths: Set<string>, path: unknown) => { if (typeof path === "string" && path) paths.add(path); };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const args = block.arguments;
      switch (block.name) {
        case "read":
        case "read_file":
          addPath(read, args.path);
          break;
        case "read_many_files":
          if (Array.isArray(args.paths)) for (const path of args.paths) addPath(read, path);
          break;
        case "write":
        case "write_file":
        case "edit":
        case "edit_file":
          addPath(modified, args.path);
          break;
        case "apply_patch":
          if (Array.isArray(args.patches)) {
            for (const patch of args.patches) {
              if (patch && typeof patch === "object" && "path" in patch) addPath(modified, patch.path);
            }
          }
          break;
      }
    }
  }
  return { readFiles: [...read].filter((path) => !modified.has(path)).sort(), modifiedFiles: [...modified].sort() };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}
