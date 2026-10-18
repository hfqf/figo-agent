import type { LLMToolCall } from "../contracts/types.js";

export type ToolIntentCall = LLMToolCall;

export type ParsedToolCalls =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "tool_calls"; calls: ToolIntentCall[] };

export class ToolCallParser {
  parse(content: string): ParsedToolCalls {
    if (/<\s*\/?\s*[|｜]+DSML[|｜]+\s*(?:tool_calls|calls|invoke|parameter)\b/i.test(content)) {
      return { kind: "invalid", reason: "unsupported_dsml_tool_calls" };
    }
    if (content.includes("<function_calls>")) {
      return { kind: "invalid", reason: "unsupported_function_calls_xml" };
    }
    if (/<\s*(?:tool_calls|invoke)\b/i.test(content)) {
      return { kind: "invalid", reason: "unsupported_tool_calls_xml" };
    }
    const trimmed = content.trimStart();
    if (trimmed.startsWith("<think>") && !trimmed.includes("</think>")) {
      return { kind: "invalid", reason: "unclosed_thinking_block" };
    }
    const candidate = trimmed.startsWith("<think>")
      ? trimmed.slice(trimmed.indexOf("</think>") + "</think>".length).trim()
      : trimmed.trim();
    if (candidate.startsWith("FINAL\n")) {
      return /"type"\s*:\s*"tool_calls"/.test(candidate)
        ? { kind: "invalid", reason: "mixed_tool_call_response" }
        : { kind: "none" };
    }

    const fenced = [...candidate.matchAll(/```json\s*([\s\S]*?)\s*```/gi)];
    if (fenced.length > 1) return { kind: "invalid", reason: "multiple_tool_call_blocks" };
    let jsonBlock: string | undefined;
    if (fenced.length === 1) {
      const block = fenced[0];
      if (candidate.slice(0, block.index).trim() || candidate.slice(block.index! + block[0].length).trim()) {
        return { kind: "invalid", reason: "mixed_tool_call_response" };
      }
      jsonBlock = block[1];
    } else if (candidate.startsWith("{")) {
      jsonBlock = readJsonObject(candidate, 0);
      if (!jsonBlock) return { kind: "invalid", reason: "invalid_json" };
      if (candidate.slice(jsonBlock.length).trim()) return { kind: "invalid", reason: "multiple_tool_call_blocks" };
    } else {
      const inline = findInlineToolCallJson(candidate);
      if (inline) {
        if (!readJsonObject(inline, 0)) return { kind: "invalid", reason: "invalid_json" };
        return { kind: "invalid", reason: "mixed_tool_call_response" };
      }
      if (candidate.includes('"tool_calls"')) return { kind: "invalid", reason: "invalid_json" };
      return { kind: "none" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonBlock);
    } catch {
      return { kind: "invalid", reason: "invalid_json" };
    }

    if (!isRecord(parsed) || parsed.type !== "tool_calls") return { kind: "none" };
    if (!Array.isArray(parsed.calls) || parsed.calls.length === 0) return { kind: "invalid", reason: "invalid_tool_calls_shape" };

    const seenIds = new Set<string>();
    const calls: ToolIntentCall[] = [];
    for (const rawCall of parsed.calls) {
      if (!isRecord(rawCall)) return { kind: "invalid", reason: "invalid_tool_call_shape" };
      const id = typeof rawCall.id === "string" ? rawCall.id.trim() : "";
      const name = typeof rawCall.name === "string" ? rawCall.name.trim() : "";
      const input = isRecord(rawCall.input) ? rawCall.input : undefined;
      if (!id || !name || !input) return { kind: "invalid", reason: "invalid_tool_call_shape" };
      if (seenIds.has(id)) return { kind: "invalid", reason: "duplicate_tool_call_id" };
      seenIds.add(id);
      calls.push({ id, name, input });
    }

    return { kind: "tool_calls", calls };
  }
}

function findInlineToolCallJson(content: string): string | undefined {
  const marker = /"type"\s*:\s*"tool_calls"/g;
  for (const match of content.matchAll(marker)) {
    const start = findContainingObjectStart(content, match.index);
    if (start === undefined) continue;
    return readJsonObject(content, start) ?? content.slice(start);
  }
  return undefined;
}

function findContainingObjectStart(content: string, end: number): number | undefined {
  const openings: number[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < end; index++) {
    const char = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") openings.push(index);
    else if (char === "}") openings.pop();
  }
  return openings.at(-1);
}

function readJsonObject(content: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index++) {
    const char = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return content.slice(start, index + 1);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
