export class LLMRequestError extends Error {
  public readonly code?: string;
  public readonly contextOverflow: boolean;

  constructor(public readonly status: number, responseBody?: unknown) {
    super(`llm request failed: ${status}`);
    this.name = "LLMRequestError";
    const body = isRecord(responseBody) && isRecord(responseBody.error) ? responseBody.error : responseBody;
    this.code = isRecord(body) && typeof body.code === "string" ? body.code : undefined;
    const message = typeof body === "string" ? body : isRecord(body) && typeof body.message === "string" ? body.message : "";
    this.contextOverflow = this.code === "context_length_exceeded" || this.code === "context_window_exceeded" ||
      /\bmaximum context length\b|\bprompt (?:is )?too long\b|\binput exceeds (?:the )?(?:model(?:'s)? )?context\b/i.test(message);
  }
}

export function isContextOverflowError(error: unknown): boolean {
  return error instanceof LLMRequestError && error.contextOverflow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
