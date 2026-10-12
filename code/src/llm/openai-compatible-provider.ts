import type { LLMProvider, LLMRequest, LLMResponse } from "../contracts/types.js";
import type { RuntimeLlmConfig } from "../config/runtime-config.js";
import { defaultRuntimeConfig } from "../config/runtime-config.js";
import { createId } from "../utils/id.js";
import type { LLMHttpCaptureStore } from "./llm-http-capture-store.js";

export interface OpenAICompatibleProviderConfig {
  id: string;
  apiKey?: string;
  baseUrl: string;
  model: string;
}

export interface OpenAICompatibleProviderOptions {
  config?: RuntimeLlmConfig;
  fetchImpl?: typeof fetch;
  captureStore?: LLMHttpCaptureStore;
}

export class OpenAICompatibleProvider implements LLMProvider {
  public readonly config: OpenAICompatibleProviderConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly captureStore?: LLMHttpCaptureStore;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    const config = options.config ?? defaultRuntimeConfig.llm[0];
    this.config = {
      id: config.id,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.captureStore = options.captureStore;
  }

  async complete(request: LLMRequest, onTextDelta?: (delta: string) => void): Promise<LLMResponse> {
    const startedAt = Date.now();
    const model = request.model || this.config.model;
    if (!this.config.apiKey) {
      const content = `本地占位响应：当前模型 ${this.config.id} 未配置 apiKey，已跳过远程 LLM 调用。`;
      this.captureStore?.record({
        purpose: request.purpose,
        sessionId: request.sessionId,
        taskId: request.taskId,
        turnId: request.turnId,
        usageTurnId: request.usageTurnId,
        requestId: request.id,
        provider: this.config.id,
        model,
        url: "local:fallback",
        method: "LOCAL",
        requestHeaders: {},
        requestBody: { model, messages: request.messages },
        responseStatus: 0,
        responseStatusText: "LOCAL_FALLBACK",
        responseHeaders: {},
        responseBody: { content, finishReason: "stop" },
        durationMs: Date.now() - startedAt
      });
      return {
        id: createId("llm_res"),
        requestId: request.id,
        content,
        model,
        finishReason: "stop",
        outputLength: content.length,
        durationMs: Date.now() - startedAt
      };
    }

    const url = `${trimSlash(this.config.baseUrl)}/chat/completions`;
    const requestHeaders = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json"
    };
    const requestBody = {
      model,
      messages: request.messages,
      ...(onTextDelta && request.purpose !== "task_compaction" && request.purpose !== "round_compaction"
        ? { stream: true, stream_options: { include_usage: true } } : {})
    };
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody)
    });

    const streaming = "stream" in requestBody;
    let streamedWire = "";
    let responseBody: unknown;
    try {
      responseBody = response.ok && streaming && !response.headers.get("content-type")?.includes("application/json")
        ? await readChatStream(response, onTextDelta!, (part) => { streamedWire += part; })
        : parseJsonOrText(await response.text());
    } catch (error) {
      this.captureStore?.record({
        purpose: request.purpose, sessionId: request.sessionId, taskId: request.taskId,
        turnId: request.turnId, usageTurnId: request.usageTurnId, requestId: request.id,
        provider: this.config.id, model, url, method: "POST", requestHeaders, requestBody,
        responseStatus: response.status, responseStatusText: response.statusText,
        responseHeaders: headersToRecord(response.headers),
        responseBody: { wire: streamedWire, error: error instanceof Error ? error.message : String(error), interrupted: true },
        durationMs: Date.now() - startedAt
      });
      throw error;
    }
    this.captureStore?.record({
      purpose: request.purpose,
      sessionId: request.sessionId,
      taskId: request.taskId,
      turnId: request.turnId,
      usageTurnId: request.usageTurnId,
      requestId: request.id,
      provider: this.config.id,
      model,
      url,
      method: "POST",
      requestHeaders,
      requestBody,
      responseStatus: response.status,
      responseStatusText: response.statusText,
      responseHeaders: headersToRecord(response.headers),
      responseBody,
      durationMs: Date.now() - startedAt
    });

    if (!response.ok) {
      throw new Error(`llm request failed: ${response.status}`);
    }

    const body = responseBody as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const choice = body.choices?.[0];
    const content = choice?.message?.content ?? "";
    if (streaming && response.headers.get("content-type")?.includes("application/json") && content) onTextDelta?.(content);

    return {
      id: createId("llm_res"),
      requestId: request.id,
      content,
      model,
      finishReason: choice?.finish_reason === "length" ? "length" : "stop",
      outputLength: content.length,
      durationMs: Date.now() - startedAt
    };
  }
}

async function readChatStream(response: Response, onTextDelta: (delta: string) => void, onWire: (part: string) => void): Promise<unknown> {
  if (!response.body) throw new Error("llm stream body is missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let raw = "";
  let content = "";
  let finishReason = "stop";
  let usage: unknown;
  let ended = false;
  const consume = (frame: string) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { ended = true; return; }
    const chunk = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
      usage?: unknown;
      error?: { message?: string };
    };
    if (chunk.error) throw new Error(chunk.error.message ?? "llm stream failed");
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) {
      content += choice.delta.content;
      onTextDelta(choice.delta.content);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      const part = decoder.decode(value, { stream: !done });
      raw += part;
      onWire(part);
      pending += part.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) !== -1) {
        consume(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
      }
      if (done) break;
    }
    if (pending.trim()) consume(pending);
  } finally {
    reader.releaseLock();
  }
  if (raw.trimStart().startsWith("{")) {
    const body = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content;
    if (text) onTextDelta(text);
    return body;
  }
  if (!ended) throw new Error("llm stream ended before [DONE]");
  return { wire: raw, choices: [{ message: { content }, finish_reason: finishReason }], usage };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function parseJsonOrText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
