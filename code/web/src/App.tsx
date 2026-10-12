import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Activity, ChevronDown, Code2, Database, FileText, GitBranch, History,
  LoaderCircle, Menu, MessageSquareText, MoreHorizontal, PanelRightOpen, Plus, Send, Wrench,
  ShieldCheck, SquarePen, X
} from "lucide-react";
import { request, shortId, timeOf, type Bootstrap, type FilePreview, type FileReference, type Task, type Turn, type UiEvent, type UiRun, type UsageSummary, type ToolCall } from "./api";
import { FileTree } from "./FileTree";
import { FilePreviewPane } from "./FilePreviewPane";
import { Inspectors, type InspectorTab } from "./Inspectors";

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [authState, setAuthState] = useState<"loading" | "locked" | "ready">("loading");
  const [accessCode, setAccessCode] = useState("");
  const [authError, setAuthError] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [scopeSessionId, setScopeSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Array<{ id: string; status: string; startedAt: string }>>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [focusToolId, setFocusToolId] = useState<string | null>(null);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [jumpTurnId, setJumpTurnId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<UiRun | null>(null);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<"chat" | "file">("chat");
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [pendingRefs, setPendingRefs] = useState<FileReference[]>([]);
  const [draft, setDraft] = useState("");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("context");
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth > 1200);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [taskDialog, setTaskDialog] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskMenu, setTaskMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const messagesEnd = useRef<HTMLDivElement>(null);
  const latestTask = useRef<string | null>(null);
  latestTask.current = selectedTaskId;
  const scopeRef = useRef<string | null>(null);
  scopeRef.current = scopeSessionId;

  const refreshBootstrap = useCallback(async () => {
    const data = await request<Bootstrap>("/api/v1/bootstrap");
    setBoot(data);
    if (!scopeRef.current || scopeRef.current === data.sessionId) setTasks(data.tasks);
    setActiveRun(data.activeRun); setAuthState("ready");
    setScopeSessionId((current) => current ?? data.sessionId);
    setSelectedTaskId((current) => current ?? data.currentTaskId ?? data.tasks[0]?.id ?? null);
    return data;
  }, []);

  useEffect(() => {
    void refreshBootstrap().catch(() => setAuthState("locked"));
  }, [refreshBootstrap]);

  const refreshTurns = useCallback(async (taskId: string) => {
    const data = await request<{ turns: Turn[] }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/turns`);
    if (latestTask.current !== taskId) return;
    setTurns(data.turns);
    setSelectedTurnId((current) => current && data.turns.some((turn) => turn.id === current) ? current : data.turns.at(-1)?.id ?? null);
  }, []);

  useEffect(() => {
    if (!boot || !selectedTaskId) { setTurns([]); setSelectedTurnId(null); return; }
    setTurns([]); setSelectedTurnId(null);
    void refreshTurns(selectedTaskId).catch((reason) => setError(errorMessage(reason)));
  }, [boot?.sessionId, selectedTaskId, refreshTurns]);

  useEffect(() => {
    if (!selectedTaskId) { setUsage(null); return; }
    let cancelled = false;
    void request<UsageSummary>(`/api/v1/tasks/${encodeURIComponent(selectedTaskId)}/usage`)
      .then((data) => { if (!cancelled) setUsage(data); }).catch(() => { if (!cancelled) setUsage(null); });
    return () => { cancelled = true; };
  }, [selectedTaskId, revision]);

  useEffect(() => {
    if (!selectedTaskId) { setToolCalls([]); return; }
    let cancelled = false;
    void request<{ tools: ToolCall[] }>(`/api/v1/tasks/${encodeURIComponent(selectedTaskId)}/tool-calls`)
      .then((data) => { if (!cancelled) setToolCalls(data.tools); }).catch(() => { if (!cancelled) setToolCalls([]); });
    return () => { cancelled = true; };
  }, [selectedTaskId, revision]);

  useEffect(() => {
    if (!boot) return;
    let last = boot.eventCursor;
    let source: EventSource | null = null;
    let reconnectTimer: number | undefined;
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      source = new EventSource(`/api/v1/events?after=${last}`);
      source.onopen = () => setConnected(true);
      source.onmessage = (message) => {
        const event = JSON.parse(message.data) as UiEvent;
        if (event.seq <= last) return;
        last = event.seq;
        if (event.turnId && event.kind === "trace.recorded") {
          setProgress((previous) => ({ ...previous, [event.turnId!]: String(event.payload.type ?? "") }));
          setRevision((value) => value + 1);
        }
        if (event.kind.startsWith("run.") && event.turnId) {
          setActiveRun((current) => current && current.turnId === event.turnId ? { ...current, status: event.kind.slice(4) } : current);
        }
        if (event.kind.startsWith("run.") || event.kind.startsWith("task.")) {
          if (latestTask.current) void refreshTurns(latestTask.current).catch(() => {});
          if (event.kind.startsWith("task.")) void refreshBootstrap().catch(() => {});
          if (event.kind === "run.completed" || event.kind === "run.failed" || event.kind === "run.interrupted") setRevision((value) => value + 1);
        }
      };
      source.onerror = () => {
        setConnected(false); source?.close();
        reconnectTimer = window.setTimeout(connect, 1800);
      };
    };
    connect();
    return () => { stopped = true; source?.close(); window.clearTimeout(reconnectTimer); };
  }, [boot?.sessionId, refreshTurns, refreshBootstrap]);

  useEffect(() => {
    if (view === "chat") messagesEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, view]);

  useEffect(() => {
    if (!jumpTurnId || view !== "chat") return;
    const target = document.getElementById(`chat-turn-${jumpTurnId}`);
    if (target) { target.scrollIntoView({ block: "center" }); setJumpTurnId(null); }
  }, [jumpTurnId, view, turns]);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthError("");
    try {
      await request<{ csrf: string }>("/api/v1/auth", { method: "POST", body: { accessCode } });
      setAccessCode(""); await refreshBootstrap();
    } catch (reason) { setAuthError(errorMessage(reason)); }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!boot || !taskTitle.trim()) return;
    setBusy(true); setError("");
    try {
      const task = await request<Task>("/api/v1/tasks", { method: "POST", body: { title: taskTitle.trim() }, csrf: boot.csrf });
      setTaskDialog(false); setTaskTitle(""); setScopeSessionId(boot.sessionId); await refreshBootstrap(); setSelectedTaskId(task.id); setView("chat");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function taskAction(task: Task, action: string) {
    if (!boot) return;
    setTaskMenu(null); setBusy(true); setError("");
    try {
      await request(`/api/v1/tasks/${encodeURIComponent(task.id)}/actions`, {
        method: "POST", body: { action }, csrf: boot.csrf
      });
      await refreshBootstrap();
      if (action === "switch" || action === "resume") setSelectedTaskId(task.id);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function sendTurn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!boot || !selectedTaskId || (!text && !pendingRefs.length) || busy) return;
    setBusy(true); setError("");
    try {
      const run = await request<UiRun>(`/api/v1/tasks/${encodeURIComponent(selectedTaskId)}/turns`, {
        method: "POST", body: { input: text || "请查看引用的文件。", clientRequestId: crypto.randomUUID(), fileReferences: pendingRefs }, csrf: boot.csrf
      });
      setActiveRun(run); setDraft(""); setPendingRefs([]); setView("chat");
      await refreshTurns(selectedTaskId); setSelectedTurnId(run.turnId);
      const latest = await request<UiRun>(`/api/v1/runs/${encodeURIComponent(run.runId)}`);
      setActiveRun(latest);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function openFile(path: string) {
    setError("");
    try {
      const file = await request<FilePreview>(`/api/v1/file?path=${encodeURIComponent(path)}`);
      setPreview(file); setView("file"); setSidebarOpen(false);
    } catch (reason) { setError(errorMessage(reason)); }
  }

  async function toggleHistory() {
    if (historyOpen) { setHistoryOpen(false); return; }
    try {
      const result = await request<{ sessions: Array<{ id: string; status: string; startedAt: string }> }>("/api/v1/sessions");
      setSessions(result.sessions); setHistoryOpen(true);
    } catch (reason) { setError(errorMessage(reason)); }
  }

  async function selectSession(sessionId: string) {
    if (!boot) return;
    setError("");
    try {
      const list = sessionId === boot.sessionId ? boot.tasks :
        (await request<{ tasks: Task[] }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/tasks`)).tasks;
      setScopeSessionId(sessionId); setTasks(list);
      setSelectedTaskId(sessionId === boot.sessionId ? boot.currentTaskId ?? list[0]?.id ?? null : list[0]?.id ?? null);
      setView("chat"); setHistoryOpen(false);
    } catch (reason) { setError(errorMessage(reason)); }
  }

  function referenceSelection(ref: FileReference) {
    setPendingRefs((current) => current.some((item) => item.path === ref.path && item.startLine === ref.startLine && item.endLine === ref.endLine) ? current : [...current, ref].slice(0, 5));
    setView("chat");
  }

  function openContextTurn(turnId: string) {
    setSelectedTurnId(turnId); setView("chat"); setInspectorOpen(false); setJumpTurnId(turnId);
  }

  const task = tasks.find((item) => item.id === selectedTaskId);
  const running = activeRun && ["accepted", "running"].includes(activeRun.status);
  const canSend = task?.status === "active" && boot?.currentTaskId === task.id;

  if (authState === "loading") return <div className="auth-screen"><div className="auth-shell"><div className="brand-mark"><Code2 size={21} /></div><strong>正在连接工作台...</strong></div></div>;
  if (authState === "locked") return <div className="auth-screen"><form className="auth-shell" onSubmit={authenticate}><div className="brand-lockup"><div className="brand-mark"><Code2 size={21} /></div><strong>Figo Agent</strong></div><h1>本地工作台</h1><label htmlFor="access-code">访问码</label><input id="access-code" autoFocus type="password" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder="输入终端显示的访问码" /><button className="primary-button" type="submit"><ShieldCheck size={16} />验证并进入</button>{authError && <p className="inline-error">{authError}</p>}</form></div>;

  return <div className={`app-shell ${sidebarOpen ? "sidebar-open" : ""} ${inspectorOpen ? "inspector-open" : ""}`}>
    <header className="topbar">
      <button className="icon-button mobile-menu" title="打开导航" aria-label="打开导航" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button>
      <div className="brand-lockup"><div className="brand-mark"><Code2 size={19} /></div><strong>Figo Agent</strong></div>
      <div className="top-divider" />
      <div className="top-meta"><span>项目</span><b title={boot?.workspace}>{boot?.workspace}</b><ChevronDown size={14} /></div>
      <div className="top-divider optional" />
      <div className="top-meta branch-meta"><span>分支</span><GitBranch size={14} /><b>{boot?.branch || "无 Git 分支"}</b></div>
      <div className="top-spacer" />
      <div className="model-label"><span>模型</span><b title={boot?.model}>{boot?.model || "未配置"}</b></div>
      <span className={`connection-status ${connected ? "online" : "offline"}`}><span className="status-dot" />{connected ? running ? "运行中" : "已连接" : "连接中断"}</span>
      <span className="usage-label" title={usage ? `${usage.requestCount} 次请求；${usage.unavailableCount} 次未提供用量` : "无用量记录"}>Tokens {usage?.totalReportedCount ? `已知 ${usage.knownTotalTokens.toLocaleString()}${usage.unavailableCount ? ` · ${usage.unavailableCount} 未提供` : ""}` : "未提供"}</span>
      <button className="icon-button mobile-inspector" title="打开检查器" aria-label="打开检查器" onClick={() => setInspectorOpen(true)}><PanelRightOpen size={19} /></button>
    </header>

    <div className="workspace-grid">
      <aside className="sidebar-pane">
        <div className="sidebar-section-title task-heading"><strong>任务</strong><div className="inline-actions"><button className="icon-button" title="历史 Session" aria-label="历史 Session" onClick={() => void toggleHistory()}><History size={16} /></button><button className="outline-button" onClick={() => setTaskDialog(true)}><Plus size={15} />新建任务</button><button className="icon-button sidebar-close" title="关闭导航" aria-label="关闭导航" onClick={() => setSidebarOpen(false)}><X size={16} /></button></div></div>
        {scopeSessionId && boot && scopeSessionId !== boot.sessionId && <button className="historical-banner" onClick={() => void selectSession(boot.sessionId)}><History size={13} />历史 Session（只读）<span>返回当前</span></button>}
        {historyOpen && <div className="session-list">{sessions.map((session) => <button key={session.id} className={scopeSessionId === session.id ? "selected" : ""} onClick={() => void selectSession(session.id)}><span className="truncate" title={session.id}>{session.id === boot?.sessionId ? "当前 Session" : shortId(session.id)}</span><small>{session.status} · {session.startedAt.slice(5, 16)}</small></button>)}</div>}
        <div className="task-list">{tasks.map((item) => <div className={`task-row ${selectedTaskId === item.id ? "selected" : ""}`} key={item.id}>
          <button className="task-select" title={item.title} onClick={() => { setSelectedTaskId(item.id); setView("chat"); setSidebarOpen(false); }}><span className="task-title truncate">{item.title}</span><span className="task-sub"><span className={`mini-status ${item.status}`} />{statusLabel(item.status)} · {timeOf(item.updatedAt)}</span></button>
          {item.sessionId === boot?.sessionId && <button className="plain-icon task-more" title={`${item.title} 操作`} aria-label={`${item.title} 操作`} onClick={() => setTaskMenu(taskMenu === item.id ? null : item.id)}><MoreHorizontal size={17} /></button>}
          {taskMenu === item.id && item.sessionId === boot?.sessionId && <div className="task-menu">{(["switch", "pause", "resume", "finish", "cancel", "compact"] as const).filter((action) => action === "switch" ? item.status === "active" : action === "resume" ? item.status === "paused" : item.status === "active").map((action) => <button key={action} onClick={() => void taskAction(item, action)}>{actionLabel(action)}</button>)}</div>}
        </div>)}</div>
        <FileTree selected={preview?.path ?? null} onOpen={(path) => void openFile(path)} />
      </aside>

      <main className="main-pane">
        <div className="main-tabs"><button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}><MessageSquareText size={15} />对话</button>{preview && <button className={view === "file" ? "active" : ""} title={preview.path} onClick={() => setView("file")}><FileText size={15} /><span className="truncate">{preview.path.split("/").at(-1)}</span></button>}</div>
        {error && <div className="global-error"><span>{error}</span><button className="plain-icon" title="关闭错误提示" aria-label="关闭错误提示" onClick={() => setError("")}><X size={15} /></button></div>}
        {view === "chat" ? <div className="chat-scroll">
          <div className="chat-context-heading"><h2>{task?.title ?? "当前任务"}</h2><span title={task?.id}>{task ? shortId(task.id) : ""}</span></div>
          {!turns.length && <div className="chat-empty"><MessageSquareText size={27} /><strong>开始一轮对话</strong><span>消息会归入当前 Task，并留下可核对的上下文与执行记录。</span></div>}
          {turns.map((turn) => <div id={`chat-turn-${turn.id}`} className={`turn-group ${selectedTurnId === turn.id ? "focused" : ""}`} key={turn.id}>
            <div className="chat-message user-message"><div className="avatar user-avatar">U</div><div className="message-content"><div className="message-head"><strong>你</strong><span className="turn-identity" title={turn.id}>{turn.taskSeq ? <span>第 {turn.taskSeq} 轮</span> : <span>历史 Turn</span>}<code>{shortId(turn.id)}</code></span><button title="查看本轮证据" onClick={() => { setSelectedTurnId(turn.id); setInspectorOpen(true); }}><Database size={14} />查看记录</button><time>{timeOf(turn.createdAt)}</time></div><p>{turn.input}</p></div></div>
            <div className="chat-message assistant-message"><div className="avatar agent-avatar"><Code2 size={17} /></div><div className="message-content"><div className="message-head"><strong>Figo Agent</strong><span className={`turn-status ${turn.status}`}>{statusLabel(turn.status)}</span><time>{timeOf(turn.completedAt)}</time></div>{toolCalls.filter((call) => call.turnId === turn.id).map((call) => <button className="tool-event" key={call.id} onClick={() => { setSelectedTurnId(turn.id); setFocusToolId(call.id); setInspectorTab("trace"); setInspectorOpen(true); }} title={`查看工具 ${call.name} 的 Trace`}><Wrench size={15} /><strong>{call.name}</strong><span className={call.status === "completed" ? "positive" : "negative"}>{statusLabel(call.status)}</span><small>{timeOf(call.completedAt)}</small></button>)}{turn.output ? <p>{turn.output}</p> : <div className="run-card"><LoaderCircle size={16} className="spinning" /><span>{progress[turn.id] ? progressLabel(progress[turn.id]) : "已接收，等待执行记录..."}</span></div>}<div className="message-links"><button onClick={() => { setSelectedTurnId(turn.id); setInspectorTab("context"); setInspectorOpen(true); }}><Database size={14} />上下文</button><button onClick={() => { setSelectedTurnId(turn.id); setInspectorTab("captures"); setInspectorOpen(true); }}><Activity size={14} />抓包</button><button onClick={() => { setSelectedTurnId(turn.id); setInspectorTab("trace"); setInspectorOpen(true); }}><Code2 size={14} />Trace</button></div></div></div>
          </div>)}<div ref={messagesEnd} />
        </div> : preview ? <FilePreviewPane preview={preview} onReference={referenceSelection} /> : null}
        <form className="composer" onSubmit={sendTurn}>{pendingRefs.length > 0 && <div className="pending-refs">{pendingRefs.map((ref, index) => <span key={`${ref.path}-${index}`}><FileText size={13} />{ref.path} L{ref.startLine}–{ref.endLine}<button type="button" title="移除引用" aria-label="移除引用" onClick={() => setPendingRefs((current) => current.filter((_, position) => position !== index))}><X size={12} /></button></span>)}</div>}<textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={canSend ? "输入消息..." : "当前 Task 不可发送；请切换到 active Task"} disabled={!canSend || Boolean(running)} rows={2} /><div className="composer-bottom"><span>{pendingRefs.length ? `${pendingRefs.length} 个文件引用` : ""}</span><span className="composer-model truncate">{boot?.model}</span><button className="primary-button" type="submit" disabled={!canSend || Boolean(running) || busy || (!draft.trim() && !pendingRefs.length)}><Send size={15} />发送</button></div></form>
      </main>

      {inspectorOpen && <Inspectors turnId={selectedTurnId} tab={inspectorTab} onTab={setInspectorTab} revision={revision} focusToolId={focusToolId} loadedTurnIds={turns.map((turn) => turn.id)} onOpenTurn={openContextTurn} onClose={() => setInspectorOpen(false)} />}
    </div>
    {taskDialog && <div className="dialog-backdrop" onClick={() => setTaskDialog(false)}><form className="task-dialog" onClick={(event) => event.stopPropagation()} onSubmit={createTask}><div className="dialog-title"><SquarePen size={19} /><strong>新建任务</strong><button className="plain-icon" type="button" title="关闭" aria-label="关闭" onClick={() => setTaskDialog(false)}><X size={17} /></button></div><label htmlFor="task-title">任务名称</label><input id="task-title" autoFocus maxLength={120} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="例如：梳理 AgentLoop 实现" /><div className="dialog-actions"><button type="button" className="outline-button" onClick={() => setTaskDialog(false)}>取消</button><button type="submit" className="primary-button" disabled={!taskTitle.trim() || busy}><Plus size={15} />创建</button></div></form></div>}
    {sidebarOpen && <button className="mobile-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}
  </div>;
}

function statusLabel(status: string): string {
  return ({ active: "进行中", paused: "已暂停", completed: "已完成", cancelled: "已取消", archived: "已归档", received: "已接收", processing: "执行中", failed: "失败" } as Record<string, string>)[status] ?? status;
}
function actionLabel(action: string): string {
  return ({ switch: "切换到此任务", pause: "暂停任务", resume: "恢复任务", finish: "完成任务", cancel: "取消任务", compact: "压缩上下文" } as Record<string, string>)[action] ?? action;
}
function progressLabel(type: string): string {
  return ({ "turn.received": "已接收", "turn.processing": "正在处理", "context.build.started": "正在构建上下文", "llm.called": "正在请求模型", "tool.called": "正在调用工具", "tool.completed": "工具已完成", "turn.completed": "正在整理结果", "turn.failed": "执行失败" } as Record<string, string>)[type] ?? `正在处理：${type}`;
}
function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : "操作失败。"; }
