import type { LLMProvider, LLMRequest, LLMResponse } from "../contracts/types.js";
import type { RuntimeLlmConfig } from "../config/runtime-config.js";
import { defaultRuntimeConfig } from "../config/runtime-config.js";
import { createId } from "../utils/id.js";
import type { LLMHttpCaptureStore } from "./llm-http-capture-store.js";

export interface OpenAICompatibleProviderConfig {
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
    const config = options.config ?? defaultRuntimeConfig.llm;
    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.captureStore = options.captureStore;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const startedAt = Date.now();
    const model = request.model || this.config.model;
    if (!this.config.apiKey) {
      const content = "本地占位响应：figo-agent.config.json 未配置 llm.apiKey，已跳过远程 LLM 调用。";
      this.captureStore?.record({
        purpose: request.purpose,
        sessionId: request.sessionId,
        taskId: request.taskId,
        turnId: request.turnId,
        requestId: request.id,
        provider: "minimax",
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
      messages: request.messages
    };
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody)
    });

    const responseText = await response.text();
    const responseBody = parseJsonOrText(responseText);
    this.captureStore?.record({
      purpose: request.purpose,
      sessionId: request.sessionId,
      taskId: request.taskId,
      turnId: request.turnId,
      requestId: request.id,
      provider: "minimax",
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
