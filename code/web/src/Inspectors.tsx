import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, CircleAlert, Clipboard, Database, FileJson2, Link2, Search, X } from "lucide-react";
import { request, shortId, timeOf, type Capture, type ContextItem, type ContextView, type TraceEvent, type ToolCall } from "./api";
import { copy, formatCopy } from "./i18n";

export type InspectorTab = "context" | "captures" | "trace";
interface Props { turnId: string | null; tab: InspectorTab; onTab(tab: InspectorTab): void; revision: number; focusToolId?: string | null; focusRequestId: string | null; loadedTurnIds: string[]; onOpenTurn(turnId: string): void; onSelectTrace(event: TraceEvent, tool?: ToolCall): void; onClose(): void; resizeHandle?: ReactNode }

export function Inspectors({ turnId, tab, onTab, revision, focusToolId, focusRequestId, loadedTurnIds, onOpenTurn, onSelectTrace, onClose, resizeHandle }: Props) {
  const [context, setContext] = useState<ContextView | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [tools, setTools] = useState<ToolCall[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => { setContext(null); setCaptures([]); setTrace([]); setTools([]); }, [turnId]);

  useEffect(() => {
    if (!turnId) { setContext(null); setCaptures([]); setTrace([]); setTools([]); return; }
    let cancelled = false;
    setLoading(true);
    setError("");
    const path = `/api/v1/turns/${encodeURIComponent(turnId)}`;
    const load = tab === "context" ? request<ContextView>(`${path}/context`).then((data) => { if (!cancelled) setContext(data); }) :
      tab === "captures" ? request<{ captures: Capture[] }>(`${path}/captures`).then((data) => { if (!cancelled) setCaptures(data.captures); }) :
        Promise.all([
          request<{ events: TraceEvent[] }>(`${path}/trace`),
          request<{ tools: ToolCall[] }>(`${path}/tools`)
        ]).then(([events, calls]) => { if (!cancelled) { setTrace(events.events); setTools(calls.tools); } });
    void load.catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : copy.recordLoadFailed); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [turnId, tab, revision]);

  return (
    <aside className="inspector-pane">
      {resizeHandle}
      <div className="inspector-tabs" role="tablist" aria-label={copy.evidenceInspector}>
        <button role="tab" aria-selected={tab === "context"} className={tab === "context" ? "active" : ""} onClick={() => onTab("context")}>{copy.context}</button>
        <button role="tab" data-capture-tab aria-selected={tab === "captures"} className={tab === "captures" ? "active" : ""} onClick={() => onTab("captures")}>{copy.capture}</button>
        <button role="tab" aria-selected={tab === "trace"} className={tab === "trace" ? "active" : ""} onClick={() => onTab("trace")}>Trace</button>
        <button className="icon-button inspector-close" title={copy.closeEvidenceInspector} aria-label={copy.closeEvidenceInspector} onClick={onClose}><X size={17} /></button>
      </div>
      <div className="inspector-scroll">
        {!turnId ? <div className="inspector-empty"><Database size={23} /><strong>{copy.selectTurn}</strong><span>{copy.inspectorIntro}</span></div> :
          error ? <p className="inline-error">{error}</p> :
            loading && ((tab === "context" && !context) || (tab === "captures" && !captures.length) || (tab === "trace" && !trace.length)) ? <p className="muted small-pad">{copy.loadingRecords}</p> :
              tab === "context" ? <ContextInspector view={context} loadedTurnIds={loadedTurnIds} onOpenTurn={onOpenTurn} onCaptures={() => onTab("captures")} /> :
                tab === "captures" ? <CaptureInspector key={turnId ?? ""} captures={captures} focusRequestId={focusRequestId} /> :
                  <TraceInspector events={trace} tools={tools} focusToolId={focusToolId} onSelectTrace={onSelectTrace} />}
      </div>
    </aside>
  );
}

function ContextInspector({ view, loadedTurnIds, onOpenTurn, onCaptures }: { view: ContextView | null; loadedTurnIds: string[]; onOpenTurn(turnId: string): void; onCaptures(): void }) {
  const [filter, setFilter] = useState<"all" | "included" | "excluded">("all");
  if (!view?.pack) return <EmptyState title={copy.noContextPack} detail={copy.noContextPackDetail} />;
  const included = view.items.filter((item) => item.included).length;
  const excluded = view.items.length - included;
  const filtered = view.items.filter((item) => filter === "all" || (filter === "included" ? item.included : !item.included));
  return <>
    <div className="inspector-heading"><strong>{copy.currentContextPack}</strong><small title={view.pack.id}>{shortId(view.pack.id)}</small></div>
    <div className="metrics-row"><div><span>{copy.included}</span><b className="positive">{included}</b></div><div><span>{copy.excluded}</span><b className="negative">{excluded}</b></div><div><span>{copy.estimated}</span><b>{view.pack.estimatedTokens.toLocaleString()}</b><small> tokens</small></div></div>
    <div className="segmented" role="group" aria-label={copy.contextFilter}>
      {(["all", "included", "excluded"] as const).map((value) => <button key={value} className={filter === value ? "selected" : ""} onClick={() => setFilter(value)}>{value === "all" ? formatCopy(copy.allCount, { count: view.items.length }) : value === "included" ? formatCopy(copy.includedCount, { count: included }) : formatCopy(copy.excludedCount, { count: excluded })}</button>)}
    </div>
    <div className="context-list">{filtered.map((item) => <ContextRow key={item.id} item={item} canOpenTurn={Boolean(item.originTurn && loadedTurnIds.includes(item.originTurn.id))} onOpenTurn={onOpenTurn} />)}</div>
    {view.checkpoint && <div className="checkpoint-line"><Database size={16} /><span>{copy.compactionBoundary}</span><small>Turn {view.checkpoint.fromSeq}–{view.checkpoint.throughSeq}</small><span title={view.checkpoint.id} className="truncate">{shortId(view.checkpoint.id)}</span></div>}
    <button className="inspector-link" onClick={onCaptures}><Link2 size={15} />{copy.viewActualRequest}</button>
  </>;
}

function ContextRow({ item, canOpenTurn, onOpenTurn }: { item: ContextItem; canOpenTurn: boolean; onOpenTurn(turnId: string): void }) {
  const [open, setOpen] = useState(false);
  const origin = item.originTurn;
  const turnLabel = origin ? item.sourceType === "turn" ? `${copy.currentInput}${origin.taskSeq ? ` · ${formatCopy(copy.turnNumber, { count: origin.taskSeq })}` : ""}` :
    formatCopy(copy.historicalTurnNumber, { count: origin.taskSeq ?? "?" }) : null;
  return <div className="context-item">
    <button className="context-item-head" onClick={() => setOpen(!open)} aria-expanded={open} title={item.sourceRef}>
      {item.included ? <Check size={15} className="positive" /> : <CircleAlert size={15} className="negative" />}
      <span className="context-item-label"><b>{turnLabel ?? item.sourceType}</b><span className="truncate">{origin ? origin.inputPreview || copy.noInputSummary : item.sourceRef}</span></span>
      <small>~{item.estimatedTokens}</small><ChevronDown size={15} className={open ? "rotated" : ""} />
    </button>
    {origin && <div className="context-turn-meta"><span title={origin.id}>{shortId(origin.id)}</span><span>{timeOf(origin.createdAt)}</span>{canOpenTurn ? <button onClick={() => onOpenTurn(origin.id)} aria-label={formatCopy(copy.locateTurn, { count: origin.taskSeq ?? "?" })}><Link2 size={13} />{copy.locateConversation}</button> : <span>{copy.conversationNotLoaded}</span>}</div>}
    <div className="context-item-summary"><div><span>{copy.summary}</span><p>{item.summary}</p></div><div><span>{item.included ? copy.inclusionReason : copy.exclusionReason}</span><p>{item.reason}</p></div></div>
    {open && <pre className="detail-pre">{item.content || copy.noContent}</pre>}
  </div>;
}

type CaptureFilter = "turn" | "compaction" | "other" | "all";

function captureKind(purpose: string): Exclude<CaptureFilter, "all"> {
  if (purpose === "turn") return "turn";
  if (purpose === "round_compaction" || purpose === "task_compaction") return "compaction";
  return "other";
}

function capturePurposeLabel(purpose: string): string {
  if (purpose === "turn") return copy.captureTurnPurpose;
  if (purpose === "round_compaction") return copy.captureRoundCompactionPurpose;
  if (purpose === "task_compaction") return copy.captureTaskCompactionPurpose;
  return purpose;
}

export function CaptureInspector({ captures, focusRequestId }: { captures: Capture[]; focusRequestId: string | null }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const dialogueCount = captures.filter((item) => captureKind(item.purpose) === "turn").length;
  const compactionCount = captures.filter((item) => captureKind(item.purpose) === "compaction").length;
  const otherCount = captures.length - dialogueCount - compactionCount;
  const [filter, setFilter] = useState<CaptureFilter>(() => {
    const focused = captures.find((item) => item.requestId === focusRequestId);
    if (focused) return captureKind(focused.purpose);
    return dialogueCount ? "turn" : compactionCount ? "compaction" : "all";
  });
  useEffect(() => {
    const focused = captures.find((item) => item.requestId === focusRequestId);
    if (focused) { setFilter(captureKind(focused.purpose)); setSelected(focused.id); }
  }, [captures, focusRequestId]);
  const visible = captures.filter((item) => filter === "all" || captureKind(item.purpose) === filter);
  const capture = visible.find((item) => item.id === selected) ?? visible[0];
  if (!captures.length) return <EmptyState title={copy.noCaptures} detail={copy.noCapturesDetail} />;
  return <>
    <div className="inspector-heading capture-heading"><strong>{copy.modelCaptures}</strong><small>{formatCopy(copy.captureBreakdown, { dialogue: dialogueCount, compaction: compactionCount })}{otherCount ? ` · ${formatCopy(copy.captureOtherCount, { count: otherCount })}` : ""}</small></div>
    <div className="segmented capture-filters" role="group" aria-label={copy.captureFilter}>
      {dialogueCount > 0 && <button className={filter === "turn" ? "selected" : ""} onClick={() => setFilter("turn")}>{formatCopy(copy.captureDialogueCount, { count: dialogueCount })}</button>}
      {compactionCount > 0 && <button className={filter === "compaction" ? "selected" : ""} onClick={() => setFilter("compaction")}>{formatCopy(copy.captureCompactionCount, { count: compactionCount })}</button>}
      {otherCount > 0 && <button className={filter === "other" ? "selected" : ""} onClick={() => setFilter("other")}>{formatCopy(copy.captureOtherFilter, { count: otherCount })}</button>}
      <button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>{formatCopy(copy.captureAllHttpCount, { count: captures.length })}</button>
    </div>
    <label className="capture-search"><Search size={14} /><input placeholder={copy.searchRequestResponse} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <div className="capture-selector">{visible.map((item, index) => <button data-capture-item key={item.id} className={item.id === capture?.id ? "selected" : ""} onClick={() => setSelected(item.id)} title={item.requestId}>#{index + 1} {capturePurposeLabel(item.purpose)} · {item.responseStatus || item.responseStatusText}</button>)}</div>
    {capture && <>
    <div className="capture-meta">
      <span className="muted">{timeOf(capture.createdAt)}</span><span className="status-dot" />
      <strong>{capture.method} {capture.url}</strong><span className="http-status">{capture.responseStatus || capture.responseStatusText}</span><span>{capture.durationMs}ms</span>
    </div>
    <dl className="capture-fields"><dt>{copy.request}</dt><dd title={capture.requestId}>{shortId(capture.requestId)}</dd><dt>{copy.model}</dt><dd>{capture.model}</dd><dt>Provider</dt><dd>{capture.provider}</dd><dt>{copy.purpose}</dt><dd>{capturePurposeLabel(capture.purpose)}</dd><dt>Tokens</dt><dd>{capture.usage.status === "unavailable" ? copy.modelUsageUnavailable : formatCopy(copy.tokenUsageDetail, { input: capture.usage.promptTokens ?? copy.unknown, output: capture.usage.completionTokens ?? copy.unknown, total: capture.usage.totalTokens ?? copy.unknown })}</dd></dl>
    <CaptureBlock title={copy.requestHeaders} value={capture.requestHeaders} search={search} />
    <CaptureBlock title={copy.requestBody} value={capture.requestBody} search={search} />
    <CaptureBlock title={copy.responseHeaders} value={capture.responseHeaders} search={search} />
    <CaptureBlock title={copy.responseBody} value={capture.responseBody} search={search} />
    </>}
  </>;
}

function CaptureBlock({ title, value, search }: { title: string; value: unknown; search: string }) {
  const [open, setOpen] = useState(true);
  const text = JSON.stringify(value, null, 2) ?? copy.noRecord;
  const index = search ? text.toLowerCase().indexOf(search.toLowerCase()) : -1;
  return <section className="capture-block"><div className="capture-block-head"><button onClick={() => setOpen(!open)} aria-expanded={open}><ChevronDown size={15} className={open ? "" : "closed-chevron"} /><strong>{title}</strong></button><button className="plain-icon" title={formatCopy(copy.copyRedacted, { name: title })} aria-label={formatCopy(copy.copyRedacted, { name: title })} onClick={() => void navigator.clipboard.writeText(text)}><Clipboard size={15} /></button></div>{open && <pre className="detail-pre">{search && index >= 0 ? <>{text.slice(0, index)}<mark>{text.slice(index, index + search.length)}</mark>{text.slice(index + search.length)}</> : text}</pre>}</section>;
}

function TraceInspector({ events, tools, focusToolId, onSelectTrace }: {
  events: TraceEvent[]; tools: ToolCall[]; focusToolId?: string | null;
  onSelectTrace(event: TraceEvent, tool?: ToolCall): void;
}) {
  const [filter, setFilter] = useState<"all" | "errors">("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!focusToolId) return;
    const match = events.find((event) => event.payload.toolCallId === focusToolId);
    if (match) { setSelected(match.id); onSelectTrace(match, tools.find((tool) => tool.id === match.payload.toolCallId)); }
  }, [focusToolId, events, tools, onSelectTrace]);
  const visible = useMemo(() => events.filter((event) =>
    (filter === "all" || /failed|denied|error|rejected/.test(event.type)) &&
    (!search || `${event.type} ${event.source}`.toLowerCase().includes(search.toLowerCase()))
  ), [events, filter, search]);
  if (!events.length) return <EmptyState title={copy.noTrace} detail={copy.noTraceDetail} />;
  const calls = events.filter((event) => event.type === "llm.called").length;
  const toolCount = events.filter((event) => event.type === "tool.called").length;
  return <>
    <div className="inspector-heading"><strong>{copy.currentTrace}</strong></div>
    <p className="trace-summary">{formatCopy(copy.traceSummary, { events: events.length, calls, tools: toolCount })}</p>
    <div className="trace-controls"><div className="segmented" role="group" aria-label={copy.eventFilter}><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>{formatCopy(copy.allCount, { count: events.length })}</button><button className={filter === "errors" ? "selected" : ""} onClick={() => setFilter("errors")}>{copy.errorsOnly}</button></div><label className="trace-search"><Search size={14} /><input placeholder={copy.searchEvents} value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
    <div className="trace-table"><div className="trace-table-header"><span>#</span><span>{copy.shanghaiTime}</span><span>{copy.eventType}</span><span>{copy.source}</span></div>{visible.map((event, index) => <button className={`trace-row ${selected === event.id ? "selected" : ""}`} key={event.id} onClick={() => { setSelected(event.id); onSelectTrace(event, tools.find((tool) => tool.id === event.payload.toolCallId)); }} title={event.type}><span>{index + 1}</span><span>{event.createdAt.slice(11)}</span><span className="truncate">{event.type}</span><span className="truncate">{event.source}</span></button>)}</div>
  </>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="inspector-empty"><FileJson2 size={23} /><strong>{title}</strong><span>{detail}</span></div>;
}
