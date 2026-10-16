import { describe, expect, it } from "vitest";
import { isContextOverflowError, LLMRequestError } from "../../src/llm/llm-request-error.js";

describe("LLMRequestError", () => {
  it("preserves HTTP metadata without exposing the upstream message", () => {
    const error = new LLMRequestError(400, { error: { code: "context_length_exceeded", message: "private-api-key" } });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "LLMRequestError", status: 400, code: "context_length_exceeded", contextOverflow: true });
    expect(error.message).toBe("llm request failed: 400");
    expect(error.stack).not.toContain("private-api-key");
    expect(isContextOverflowError(error)).toBe(true);
  });

  it.each([
    ["context_length_exceeded", true], ["context_window_exceeded", true],
    ["invalid_api_key", false], ["rate_limit_exceeded", false], ["payload_too_large", false]
  ])("classifies explicit code %s", (code, expected) => {
    expect(isContextOverflowError(new LLMRequestError(400, { error: { code } }))).toBe(expected);
  });

  it.each([
    ["This model's maximum context length is 128000 tokens", true],
    ["Prompt is too long for this model", true],
    ["INPUT EXCEEDS THE CONTEXT WINDOW", true],
    ["Input exceeds the model's context length", true],
    ["Request body too large", false], ["Input exceeds token rate limit", false],
    ["Invalid context_length parameter", false], ["Unauthorized", false]
  ])("classifies capacity message %s", (message, expected) => {
    expect(isContextOverflowError(new LLMRequestError(400, { error: { message } }))).toBe(expected);
  });

  it.each([400, 401, 413, 429, 500])("does not infer overflow from HTTP %s alone", (status) => {
    const error = new LLMRequestError(status);
    expect(error.code).toBeUndefined();
    expect(isContextOverflowError(error)).toBe(false);
  });

  it.each([null, undefined, "prompt too long", new Error("maximum context length"),
    new TypeError("fetch failed"), { contextOverflow: true }, { status: 400, code: "context_length_exceeded" }])(
    "rejects untyped errors: %j", (error) => {
      expect(isContextOverflowError(error)).toBe(false);
    }
  );
});
