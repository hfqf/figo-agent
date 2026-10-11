import { parseModelJson } from "./model-json.js";

export interface SourcedStatement {
  text: string;
  sourceTurnIds: string[];
}

export interface CompactionSummary {
  goal: SourcedStatement;
  facts: SourcedStatement[];
  decisions: SourcedStatement[];
  completedWork: SourcedStatement[];
  openIssues: SourcedStatement[];
  constraints: SourcedStatement[];
  sourceTurnIds: string[];
}

export function parseCompactionSummary(content: string, allowedTurnIds: string[], maxChars: number): CompactionSummary {
  let value: unknown;
  try { value = parseModelJson(content); } catch { throw new Error("compaction summary is not JSON"); }
  if (JSON.stringify(value).length > maxChars) throw new Error("compaction summary exceeds configured limit");
  if (!isRecord(value)) throw new Error("compaction summary must be an object");
  const allowed = new Set(allowedTurnIds);
  const sourceTurnIds = stringList(value.sourceTurnIds);
  if (sourceTurnIds.length === 0 || new Set(sourceTurnIds).size !== sourceTurnIds.length || sourceTurnIds.some((id) => !allowed.has(id))) {
    throw new Error("compaction summary provenance does not match source turns");
  }
  const cited = new Set(sourceTurnIds);
  return {
    goal: statement(value.goal, cited),
    facts: statements(value.facts, cited),
    decisions: statements(value.decisions, cited),
    completedWork: statements(value.completedWork, cited),
    openIssues: statements(value.openIssues, cited),
    constraints: statements(value.constraints, cited),
    sourceTurnIds
  };
}

function statements(value: unknown, allowed: Set<string>): SourcedStatement[] {
  if (!Array.isArray(value)) throw new Error("compaction summary section must be an array");
  return value.map((entry) => statement(entry, allowed));
}

function statement(value: unknown, allowed: Set<string>): SourcedStatement {
  if (!isRecord(value) || typeof value.text !== "string" || !value.text.trim()) {
    throw new Error("compaction statement is empty");
  }
  const sourceTurnIds = stringList(value.sourceTurnIds);
  if (sourceTurnIds.length === 0 || sourceTurnIds.some((id) => !allowed.has(id))) {
    throw new Error("compaction statement has invalid provenance");
  }
  return { text: value.text.trim(), sourceTurnIds };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0)) {
    throw new Error("compaction provenance must be a string array");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
