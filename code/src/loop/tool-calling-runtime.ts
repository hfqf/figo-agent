import type { ToolExecutionContext, ToolResult } from "../contracts/types.js";
import type { ToolIntentCall } from "./tool-call-parser.js";
import type { ToolExecutionRecord } from "./llm-message-builder.js";

export interface ToolExecutor {
  execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult>;
}

export interface ToolExecutionRecordWithRound extends ToolExecutionRecord {
  round: number;
}

export class ToolCallingRuntime {
  constructor(private readonly registry: ToolExecutor) {}

  async executeBatch(
    calls: ToolIntentCall[],
    context: ToolExecutionContext,
    round: number
  ): Promise<ToolExecutionRecordWithRound[]> {
    const records: ToolExecutionRecordWithRound[] = [];
    for (const call of calls) {
      context.signal?.throwIfAborted();
      const result = await this.registry.execute(call.name, call.input, { ...context, intentId: call.id, round });
      context.signal?.throwIfAborted();
      records.push(toRecord(call, result, round));
    }
    return records;
  }
}

function toRecord(
  call: ToolIntentCall,
  result: ToolResult,
  round: number
): ToolExecutionRecordWithRound {
  if (result.status === "completed") {
    return {
      id: call.id,
      name: call.name,
      status: result.status,
      output: result.output,
      round
    };
  }

  return {
    id: call.id,
    name: call.name,
    status: result.status,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    round
  };
}
