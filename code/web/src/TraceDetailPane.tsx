import { Clipboard, Link2 } from "lucide-react";
import type { ToolCall, TraceEvent } from "./api";
import { shortId, timeOf } from "./api";
import { copy, formatCopy } from "./i18n";

interface Props {
  event: TraceEvent;
  tool?: ToolCall;
  onCapture(requestId: string): void;
  onContext(): void;
}

export function TraceDetailPane({ event, tool, onCapture, onContext }: Props) {
  const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : null;
  const contextPackId = typeof event.payload.contextPackId === "string" ? event.payload.contextPackId : null;
  return <section className="trace-detail-pane">
    <div className="trace-detail-heading"><div><small>{copy.eventDetail}</small><h2>{event.type}</h2></div><time>{timeOf(event.createdAt)}</time></div>
    <dl className="trace-detail-fields">
      <dt>event_id</dt><dd title={event.id}>{event.id}</dd>
      <dt>session_id</dt><dd title={event.sessionId}>{event.sessionId}</dd>
      <dt>task_id</dt><dd title={event.taskId ?? undefined}>{event.taskId ?? copy.none}</dd>
      <dt>turn_id</dt><dd title={event.turnId}>{event.turnId}</dd>
      <dt>{copy.source}</dt><dd>{event.source}</dd>
    </dl>
    {requestId && <button className="inspector-link" onClick={() => onCapture(requestId)}><Link2 size={15} />{formatCopy(copy.linkedCapture, { id: shortId(requestId) })}</button>}
    {contextPackId && <button className="inspector-link" onClick={onContext}><Link2 size={15} />{formatCopy(copy.linkedContextPack, { id: shortId(contextPackId) })}</button>}
    <TraceDataBlock title={copy.tracePayload} value={event.payload} />
    {tool && <section className="trace-linked-tool"><h3>{formatCopy(copy.linkedTool, { name: tool.name })}</h3><span>{tool.status}</span><TraceDataBlock title={copy.traceToolInput} value={tool.input} /><TraceDataBlock title={copy.traceToolOutput} value={tool.output ?? { error: tool.errorMessage }} /></section>}
  </section>;
}

function TraceDataBlock({ title, value }: { title: string; value: unknown }) {
  const content = JSON.stringify(value, null, 2) ?? copy.noRecord;
  return <section className="trace-data-block"><div><h3>{title}</h3><button className="plain-icon" title={formatCopy(copy.copyRedacted, { name: title })} aria-label={formatCopy(copy.copyRedacted, { name: title })} onClick={() => void navigator.clipboard.writeText(content)}><Clipboard size={15} /></button></div><pre>{content}</pre></section>;
}
