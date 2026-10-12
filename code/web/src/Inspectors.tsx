import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, CircleAlert, Clipboard, Database, FileJson2, Link2, Search, X } from "lucide-react";
import { request, shortId, timeOf, type Capture, type ContextItem, type ContextView, type TraceEvent, type ToolCall } from "./api";

export type InspectorTab = "context" | "captures" | "trace";
interface Props { turnId: string | null; tab: InspectorTab; onTab(tab: InspectorTab): void; revision: number; focusToolId?: string | null; loadedTurnIds: string[]; onOpenTurn(turnId: string): void; onClose(): void }

export function Inspectors({ turnId, tab, onTab, revision, focusToolId, loadedTurnIds, onOpenTurn, onClose }: Props) {
  const [context, setContext] = useState<ContextView | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [tools, setTools] = useState<ToolCall[]>([]);
  const [focusRequestId, setFocusRequestId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => { setContext(null); setCaptures([]); setTrace([]); setTools([]); setFocusRequestId(null); }, [turnId]);

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
    void load.catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "记录读取失败"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [turnId, tab, revision]);

  return (
    <aside className="inspector-pane">
      <div className="inspector-tabs" role="tablist" aria-label="证据检查器">
        <button role="tab" aria-selected={tab === "context"} className={tab === "context" ? "active" : ""} onClick={() => onTab("context")}>上下文</button>
        <button role="tab" data-capture-tab aria-selected={tab === "captures"} className={tab === "captures" ? "active" : ""} onClick={() => onTab("captures")}>抓包</button>
        <button role="tab" aria-selected={tab === "trace"} className={tab === "trace" ? "active" : ""} onClick={() => onTab("trace")}>Trace</button>
        <button className="icon-button inspector-close" title="关闭检查器" aria-label="关闭检查器" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="inspector-scroll">
        {!turnId ? <div className="inspector-empty"><Database size={23} /><strong>选择一轮对话</strong><span>查看该 Turn 的上下文、抓包与事件。</span></div> :
          error ? <p className="inline-error">{error}</p> :
            loading && ((tab === "context" && !context) || (tab === "captures" && !captures.length) || (tab === "trace" && !trace.length)) ? <p className="muted small-pad">正在读取记录...</p> :
              tab === "context" ? <ContextInspector view={context} loadedTurnIds={loadedTurnIds} onOpenTurn={onOpenTurn} onCaptures={() => onTab("captures")} /> :
                tab === "captures" ? <CaptureInspector captures={captures} focusRequestId={focusRequestId} /> :
                  <TraceInspector events={trace} tools={tools} focusToolId={focusToolId} onCapture={(requestId) => { setFocusRequestId(requestId); onTab("captures"); }} onContext={() => onTab("context")} />}
      </div>
    </aside>
  );
}

function ContextInspector({ view, loadedTurnIds, onOpenTurn, onCaptures }: { view: ContextView | null; loadedTurnIds: string[]; onOpenTurn(turnId: string): void; onCaptures(): void }) {
  const [filter, setFilter] = useState<"all" | "included" | "excluded">("all");
  if (!view?.pack) return <EmptyState title="暂无 ContextPack" detail="本轮尚未构建上下文，或历史记录没有该数据。" />;
  const included = view.items.filter((item) => item.included).length;
  const excluded = view.items.length - included;
  const filtered = view.items.filter((item) => filter === "all" || (filter === "included" ? item.included : !item.included));
  return <>
    <div className="inspector-heading"><strong>当前 Turn · ContextPack</strong><small title={view.pack.id}>{shortId(view.pack.id)}</small></div>
    <div className="metrics-row"><div><span>已纳入</span><b className="positive">{included}</b></div><div><span>已排除</span><b className="negative">{excluded}</b></div><div><span>估算</span><b>{view.pack.estimatedTokens.toLocaleString()}</b><small> tokens</small></div></div>
    <div className="segmented" role="group" aria-label="上下文筛选">
      {(["all", "included", "excluded"] as const).map((value) => <button key={value} className={filter === value ? "selected" : ""} onClick={() => setFilter(value)}>{value === "all" ? `全部 (${view.items.length})` : value === "included" ? `已纳入 (${included})` : `已排除 (${excluded})`}</button>)}
    </div>
    <div className="context-list">{filtered.map((item) => <ContextRow key={item.id} item={item} canOpenTurn={Boolean(item.originTurn && loadedTurnIds.includes(item.originTurn.id))} onOpenTurn={onOpenTurn} />)}</div>
    {view.checkpoint && <div className="checkpoint-line"><Database size={16} /><span>压缩边界</span><small>Turn {view.checkpoint.fromSeq}–{view.checkpoint.throughSeq}</small><span title={view.checkpoint.id} className="truncate">{shortId(view.checkpoint.id)}</span></div>}
    <button className="inspector-link" onClick={onCaptures}><Link2 size={15} />查看实际请求：抓包</button>
  </>;
}

function ContextRow({ item, canOpenTurn, onOpenTurn }: { item: ContextItem; canOpenTurn: boolean; onOpenTurn(turnId: string): void }) {
  const [open, setOpen] = useState(false);
  const origin = item.originTurn;
  const turnLabel = origin ? item.sourceType === "turn" ? `本轮输入${origin.taskSeq ? ` · 第 ${origin.taskSeq} 轮` : ""}` :
    `历史第 ${origin.taskSeq ?? "?"} 轮` : null;
  return <div className="context-item">
    <button className="context-item-head" onClick={() => setOpen(!open)} aria-expanded={open} title={item.sourceRef}>
      {item.included ? <Check size={15} className="positive" /> : <CircleAlert size={15} className="negative" />}
      <span className="context-item-label"><b>{turnLabel ?? item.sourceType}</b><span className="truncate">{origin ? origin.inputPreview || "无输入摘要" : item.sourceRef}</span></span>
      <small>~{item.estimatedTokens}</small><ChevronDown size={15} className={open ? "rotated" : ""} />
    </button>
    {origin && <div className="context-turn-meta"><span title={origin.id}>{shortId(origin.id)}</span><span>{timeOf(origin.createdAt)}</span>{canOpenTurn ? <button onClick={() => onOpenTurn(origin.id)} aria-label={`定位到第 ${origin.taskSeq ?? "?"} 轮对话`}><Link2 size={13} />定位到对话</button> : <span>对话未加载</span>}</div>}
    <div className="context-item-summary"><div><span>摘要</span><p>{item.summary}</p></div><div><span>{item.included ? "纳入原因" : "排除原因"}</span><p>{item.reason}</p></div></div>
    {open && <pre className="detail-pre">{item.content || "无可用内容"}</pre>}
  </div>;
}

function CaptureInspector({ captures, focusRequestId }: { captures: Capture[]; focusRequestId: string | null }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const capture = captures.find((item) => item.id === selected) ?? captures.find((item) => item.requestId === focusRequestId) ?? captures[0];
  if (!capture) return <EmptyState title="暂无模型抓包" detail="本轮还没有记录 LLM 请求。" />;
  return <>
    <div className="inspector-heading"><strong>模型交互抓包</strong><small>{captures.length} 次请求</small></div>
    <label className="capture-search"><Search size={14} /><input placeholder="搜索请求或响应" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <div className="capture-selector">{captures.map((item, index) => <button key={item.id} className={item.id === capture.id ? "selected" : ""} onClick={() => setSelected(item.id)} title={item.requestId}>#{index + 1} {item.purpose} · {item.responseStatus || item.responseStatusText}</button>)}</div>
    <div className="capture-meta">
      <span className="muted">{timeOf(capture.createdAt)}</span><span className="status-dot" />
      <strong>{capture.method} {capture.url}</strong><span className="http-status">{capture.responseStatus || capture.responseStatusText}</span><span>{capture.durationMs}ms</span>
    </div>
    <dl className="capture-fields"><dt>请求</dt><dd title={capture.requestId}>{shortId(capture.requestId)}</dd><dt>模型</dt><dd>{capture.model}</dd><dt>Provider</dt><dd>{capture.provider}</dd><dt>用途</dt><dd>{capture.purpose}</dd><dt>Tokens</dt><dd>{capture.usage.status === "unavailable" ? "模型未提供" : `输入 ${capture.usage.promptTokens ?? "未知"} · 输出 ${capture.usage.completionTokens ?? "未知"} · 合计 ${capture.usage.totalTokens ?? "未知"}`}</dd></dl>
    <CaptureBlock title="请求头" value={capture.requestHeaders} search={search} />
    <CaptureBlock title="请求体" value={capture.requestBody} search={search} />
    <CaptureBlock title="响应头" value={capture.responseHeaders} search={search} />
    <CaptureBlock title="响应体" value={capture.responseBody} search={search} />
  </>;
}

function CaptureBlock({ title, value, search }: { title: string; value: unknown; search: string }) {
  const [open, setOpen] = useState(true);
  const text = JSON.stringify(value, null, 2) ?? "无可用记录";
  const index = search ? text.toLowerCase().indexOf(search.toLowerCase()) : -1;
  return <section className="capture-block"><div className="capture-block-head"><button onClick={() => setOpen(!open)} aria-expanded={open}><ChevronDown size={15} className={open ? "" : "closed-chevron"} /><strong>{title}</strong></button><button className="plain-icon" title={`复制脱敏后的${title}`} aria-label={`复制脱敏后的${title}`} onClick={() => void navigator.clipboard.writeText(text)}><Clipboard size={15} /></button></div>{open && <pre className="detail-pre">{search && index >= 0 ? <>{text.slice(0, index)}<mark>{text.slice(index, index + search.length)}</mark>{text.slice(index + search.length)}</> : text}</pre>}</section>;
}

function TraceInspector({ events, tools, focusToolId, onCapture, onContext }: {
  events: TraceEvent[]; tools: ToolCall[]; focusToolId?: string | null;
  onCapture(requestId: string): void; onContext(): void;
}) {
  const [filter, setFilter] = useState<"all" | "errors">("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!focusToolId) return;
    const match = events.find((event) => event.payload.toolCallId === focusToolId);
    if (match) setSelected(match.id);
  }, [focusToolId, events]);
  const visible = useMemo(() => events.filter((event) =>
    (filter === "all" || /failed|denied|error|rejected/.test(event.type)) &&
    (!search || `${event.type} ${event.source}`.toLowerCase().includes(search.toLowerCase()))
  ), [events, filter, search]);
  const detail = events.find((event) => event.id === selected) ?? visible[0];
  const linkedTool = tools.find((tool) => tool.id === detail?.payload.toolCallId);
  if (!events.length) return <EmptyState title="暂无 Trace" detail="本轮还没有结构化事件。" />;
  const calls = events.filter((event) => event.type === "llm.called").length;
  const toolCount = events.filter((event) => event.type === "tool.called").length;
  return <>
    <div className="inspector-heading"><strong>当前 Turn · Trace</strong></div>
    <p className="trace-summary">{events.length} 个事件 · {calls} 次模型请求 · {toolCount} 次工具调用</p>
    <div className="trace-controls"><div className="segmented" role="group" aria-label="事件筛选"><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>全部 ({events.length})</button><button className={filter === "errors" ? "selected" : ""} onClick={() => setFilter("errors")}>仅错误</button></div><label className="trace-search"><Search size={14} /><input placeholder="搜索事件" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
    <div className="trace-table"><div className="trace-table-header"><span>#</span><span>时间（上海）</span><span>事件类型</span><span>来源</span></div>{visible.map((event, index) => <button className={`trace-row ${detail?.id === event.id ? "selected" : ""}`} key={event.id} onClick={() => setSelected(event.id)} title={event.type}><span>{index + 1}</span><span>{event.createdAt.slice(11)}</span><span className="truncate">{event.type}</span><span className="truncate">{event.source}</span></button>)}</div>
    {detail && <section className="trace-detail"><h3>事件详情</h3><dl><dt>event_id</dt><dd title={detail.id}>{detail.id}</dd><dt>task_id</dt><dd title={detail.taskId}>{detail.taskId}</dd><dt>turn_id</dt><dd title={detail.turnId}>{detail.turnId}</dd><dt>来源</dt><dd>{detail.source}</dd></dl><pre className="detail-pre">{JSON.stringify(detail.payload, null, 2)}</pre>{linkedTool && <div className="linked-tool"><strong>关联工具 · {linkedTool.name}</strong><span>{linkedTool.status}</span><pre className="detail-pre">{JSON.stringify({ input: linkedTool.input, output: linkedTool.output, error: linkedTool.errorMessage }, null, 2)}</pre></div>}{typeof detail.payload.requestId === "string" && <button className="inspector-link" onClick={() => onCapture(detail.payload.requestId as string)}><Link2 size={15} />关联抓包 {shortId(detail.payload.requestId)}</button>}{typeof detail.payload.contextPackId === "string" && <button className="inspector-link" onClick={onContext}><Link2 size={15} />关联 ContextPack {shortId(detail.payload.contextPackId)}</button>}<p className="muted">仅展示已记录的程序事件；无直接关联时不推断请求或工具 ID。</p></section>}
  </>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="inspector-empty"><FileJson2 size={23} /><strong>{title}</strong><span>{detail}</span></div>;
}
