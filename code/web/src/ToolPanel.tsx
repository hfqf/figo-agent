import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from "react";
import { Bug, ChevronDown, ChevronUp, Play, Square, Terminal as TerminalIcon } from "lucide-react";
import { request, timeOf, type TerminalSnapshot, type UiEvent } from "./api";
import { copy, formatCopy } from "./i18n";

const HEIGHT_KEY = "figo-workbench-tool-height";

export function ToolPanel({ csrf, eventRevision, maxCommandChars }: { csrf: string; eventRevision: number; maxCommandChars: number }) {
  const [tab, setTab] = useState<"debug" | "terminal">("debug");
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(() => Math.max(140, Math.min(500, Number(localStorage.getItem(HEIGHT_KEY)) || 230)));
  const [events, setEvents] = useState<UiEvent[]>([]);
  const [terminal, setTerminal] = useState<TerminalSnapshot>({ cwd: "", entries: [] });
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");
  const [historyIndex, setHistoryIndex] = useState(-1);
  const end = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; height: number } | null>(null);

  useEffect(() => { try { localStorage.setItem(HEIGHT_KEY, String(height)); } catch { /* Storage can be disabled. */ } }, [height]);

  useEffect(() => {
    if (tab !== "debug" || collapsed) return;
    void request<{ events: UiEvent[] }>("/api/v1/debug-events")
      .then((data) => setEvents(data.events)).catch((reason) => setError(messageOf(reason)));
  }, [tab, collapsed, eventRevision]);

  useEffect(() => {
    if (tab !== "terminal" || collapsed) return;
    const update = () => void request<TerminalSnapshot>("/api/v1/terminal")
      .then(setTerminal).catch((reason) => setError(messageOf(reason)));
    update();
    const timer = window.setInterval(update, 400);
    return () => window.clearInterval(timer);
  }, [tab, collapsed]);

  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [terminal.entries.at(-1)?.output, events.length, tab]);

  function resizeStart(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, height };
  }
  function resizeMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    setHeight(Math.max(120, Math.min(window.innerHeight * 0.65, drag.current.height + drag.current.y - event.clientY)));
  }
  function resizeEnd() {
    drag.current = null;
  }

  async function execute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = command.trim();
    if (!value || terminal.entries.some((entry) => entry.status === "running")) return;
    setError("");
    try {
      await request("/api/v1/terminal", { method: "POST", body: { command: value }, csrf });
      setTerminal(await request<TerminalSnapshot>("/api/v1/terminal"));
      setCommand(""); setHistoryIndex(-1);
    } catch (reason) { setError(messageOf(reason)); }
  }

  const running = terminal.entries.some((entry) => entry.status === "running");
  const history = terminal.entries.map((entry) => entry.command).reverse();
  return <section className={`bottom-tools ${collapsed ? "collapsed" : ""}`} style={{ "--tool-height": `${height}px` } as CSSProperties} aria-label={copy.toolsArea}>
    {!collapsed && <div className="tool-resize" role="separator" aria-label={copy.resizeToolsArea} aria-orientation="horizontal" tabIndex={0}
      aria-valuenow={Math.round(height)} aria-valuemin={120} aria-valuemax={Math.round(window.innerHeight * 0.65)}
      onPointerDown={resizeStart} onPointerMove={resizeMove} onPointerUp={resizeEnd} onLostPointerCapture={resizeEnd}
      onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setHeight((value) => Math.max(120, Math.min(window.innerHeight * 0.65, value + (event.key === "ArrowUp" ? 16 : -16)))); } }} />}
    <div className="tool-tabs" role="tablist" aria-label={copy.toolsView}>
      <button role="tab" aria-selected={tab === "debug"} className={tab === "debug" ? "active" : ""} onClick={() => { setTab("debug"); setCollapsed(false); }}><Bug size={14} />Debug Console</button>
      <button role="tab" aria-selected={tab === "terminal"} className={tab === "terminal" ? "active" : ""} onClick={() => { setTab("terminal"); setCollapsed(false); }}><TerminalIcon size={14} />Terminal</button>
      <button className="plain-icon tool-collapse" title={collapsed ? copy.expandToolsArea : copy.collapseToolsArea} aria-label={collapsed ? copy.expandToolsArea : copy.collapseToolsArea} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
    </div>
    {!collapsed && <div className="tool-content">
      {tab === "debug" ? <div className="debug-log" role="tabpanel">
        {events.map((item) => <div className="debug-row" key={item.seq}><time>{timeOf(item.createdAt)}</time><span className="debug-kind">{item.kind}</span><span className="debug-detail">{item.turnId ? item.turnId.slice(0, 13) : item.taskId ? item.taskId.slice(0, 13) : ""}{item.payload.type ? ` · ${String(item.payload.type)}` : ""}{item.payload.exitCode !== undefined ? ` · exit ${String(item.payload.exitCode)}` : ""}</span></div>)}
        {events.length === 0 && <div className="tool-empty">{copy.noExecutionEvents}</div>}<div ref={end} />
      </div> : <div className="terminal-view" role="tabpanel">
        <div className="terminal-output">{terminal.entries.map((entry) => <div className="terminal-entry" key={entry.id}><div className="terminal-command"><span>{entry.cwd} $</span> {entry.command}</div><pre>{entry.output}{entry.truncated ? `\n${copy.outputTruncated}` : ""}</pre><div className="terminal-status">{entry.status === "running" ? copy.running : entry.status === "stopped" ? copy.stopped : formatCopy(copy.exitCode, { code: entry.exitCode ?? "-" })}</div></div>)}<div ref={end} /></div>
        <form className="terminal-form" onSubmit={execute}><span className="terminal-prompt" title={terminal.cwd}>$</span><input aria-label={copy.terminalCommand} value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => {
          if (event.key === "ArrowUp" && history.length) { event.preventDefault(); const next = Math.min(history.length - 1, historyIndex + 1); setHistoryIndex(next); setCommand(history[next]); }
          if (event.key === "ArrowDown" && historyIndex >= 0) { event.preventDefault(); const next = historyIndex - 1; setHistoryIndex(next); setCommand(next < 0 ? "" : history[next]); }
        }} placeholder={terminal.cwd || copy.enterCommand} maxLength={maxCommandChars} disabled={running} /><button type="submit" title={copy.executeCommand} aria-label={copy.executeCommand} disabled={!command.trim() || running}><Play size={15} /></button>{running && <button type="button" title={copy.stopCommand} aria-label={copy.stopCommand} onClick={() => void request("/api/v1/terminal/stop", { method: "POST", csrf }).then(() => request<TerminalSnapshot>("/api/v1/terminal")).then(setTerminal).catch((reason) => setError(messageOf(reason)))}><Square size={15} /></button>}</form>
      </div>}
      {error && <div className="tool-error">{error}</div>}
    </div>}
  </section>;
}

function messageOf(reason: unknown): string { return reason instanceof Error ? reason.message : copy.toolRequestFailed; }
