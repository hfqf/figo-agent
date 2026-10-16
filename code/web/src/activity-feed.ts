import type { UiEvent } from "./api";
import { copy, formatCopy } from "./i18n";

export interface ActivityItem {
  key: string;
  label: string;
  detail?: string;
  state: "running" | "completed" | "failed";
  toolCallId?: string;
}

export function activityForTurn(events: UiEvent[], turnId: string): { items: ActivityItem[]; text: string } {
  const items: ActivityItem[] = [];
  const positions = new Map<string, number>();
  let text = "";
  let sourceOffset = 0;
  const seenChunks = new Set<number>();
  for (const event of events) {
    if (event.turnId !== turnId) continue;
    if (event.kind === "assistant.text.reset") {
      if (!seenChunks.has(event.seq)) {
        text = "";
        sourceOffset = 0;
        seenChunks.add(event.seq);
      }
      continue;
    }
    if (event.kind === "assistant.text.delta") {
      const delta = event.payload.text;
      const offset = event.payload.offset;
      const length = event.payload.sourceLength;
      if (!seenChunks.has(event.seq) && typeof delta === "string" && typeof offset === "number" && offset === sourceOffset) {
        text += delta;
        sourceOffset += typeof length === "number" ? length : delta.length;
        seenChunks.add(event.seq);
      }
      continue;
    }
    if (event.kind !== "trace.recorded") continue;
    const type = String(event.payload.type ?? "");
    const round = typeof event.payload.round === "number" ? event.payload.round + 1 : 1;
    const tool = typeof event.payload.tool === "string" ? event.payload.tool : copy.tool;
    const toolCallId = typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : undefined;
    let item: ActivityItem | undefined;
    if (type === "context.build.started" || type === "context.build.completed") {
      item = { key: "context", label: copy.organizeContext, state: type.endsWith("completed") ? "completed" : "running" };
    } else if (type === "compaction.started" || type === "compaction.completed" || type === "compaction.failed") {
      item = { key: `compaction-${event.payload.mode ?? "task"}`, label: copy.compactContext, state: type.endsWith("failed") ? "failed" : type.endsWith("completed") ? "completed" : "running" };
    } else if (type === "llm.called" || type === "llm.completed") {
      item = { key: `model-${round}`, label: formatCopy(copy.modelRound, { round }), state: type.endsWith("completed") ? "completed" : "running" };
    } else if (type === "tool.called" || type === "tool.completed" || type === "tool.failed" || type === "tool.denied") {
      item = { key: `tool-${toolCallId ?? event.seq}`, label: tool, detail: copy.toolCall, toolCallId, state: type.endsWith("called") ? "running" : type.endsWith("completed") ? "completed" : "failed" };
    } else if (type === "skill.activated") {
      item = { key: "skill", label: copy.runSkill, state: "completed" };
    } else if (type === "artifact.created") {
      item = { key: "artifact", label: copy.createArtifact, state: "completed" };
    }
    if (!item) continue;
    const position = positions.get(item.key);
    if (position === undefined) { positions.set(item.key, items.length); items.push(item); }
    else items[position] = item;
  }
  return { items, text };
}

export function visibleAnswer(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trimStart();
}
