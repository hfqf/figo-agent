import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  Activity, ArrowLeft, Code2, Database, FileText, FolderOpen, GitBranch, History,
  LoaderCircle, MessageSquareText, MoreHorizontal, PanelRightOpen, Plus, Send,
  Settings2, ShieldCheck, SquarePen, X
} from "lucide-react";
import { request, shortId, timeOf, type AvailableModelProvider, type Bootstrap, type FilePreview, type FileReference, type ModelSelection, type Task, type Turn, type UiEvent, type UiRun, type UsageSummary, type ToolCall } from "./api";
import { FileTree } from "./FileTree";
import { FilePreviewPane } from "./FilePreviewPane";
import { Inspectors, type InspectorTab } from "./Inspectors";
import { ResizeHandle } from "./ResizeHandle";
import { ToolPanel } from "./ToolPanel";
import { copy, formatCopy } from "./i18n";
import { SettingsPage } from "./SettingsPage";
import { ActivityTimeline } from "./ActivityTimeline";
import { activityForTurn, visibleAnswer } from "./activity-feed";
import ReactMarkdown from "react-markdown";
import { DEFAULT_WORKSPACE_LAYOUT, WORKSPACE_LAYOUT_KEY, decodeWorkspaceLayout, fitWorkspaceLayout, resizeWorkspaceLayout, workspaceBoundaryLimits, type WorkspaceBoundary } from "./workspace-layout";

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [authState, setAuthState] = useState<"loading" | "locked" | "ready">("loading");
  const [accessCode, setAccessCode] = useState("");
  const [authError, setAuthError] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [scopeSessionId, setScopeSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Array<{ id: string; status: string; startedAt: string; turnCount: number }>>([]);
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
  const [activityEvents, setActivityEvents] = useState<UiEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [revision, setRevision] = useState(0);
  const [eventRevision, setEventRevision] = useState(0);
  const [mobileView, setMobileView] = useState<"tasks" | "file">("tasks");
  const [taskPanelView, setTaskPanelView] = useState<"list" | "conversation">("list");
  const [layout, setLayout] = useState(() => {
    try { return decodeWorkspaceLayout(window.localStorage.getItem(WORKSPACE_LAYOUT_KEY), window.innerWidth); }
    catch { return DEFAULT_WORKSPACE_LAYOUT; }
  });
  const [workspaceWidth, setWorkspaceWidth] = useState(window.innerWidth);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [fileDirty, setFileDirty] = useState(false);
  const [pendingRefs, setPendingRefs] = useState<FileReference[]>([]);
  const [draft, setDraft] = useState("");
  const [selectedModel, setSelectedModel] = useState<ModelSelection | null>(null);
  const [modelSaving, setModelSaving] = useState(false);
  const [availableModels, setAvailableModels] = useState<AvailableModelProvider[]>([]);
  const [modelListError, setModelListError] = useState("");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("context");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [taskDialog, setTaskDialog] = useState(false);
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskMenu, setTaskMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const messagesEnd = useRef<HTMLDivElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const workspaceGrid = useRef<HTMLDivElement>(null);
  const latestTask = useRef<string | null>(null);
  latestTask.current = selectedTaskId;
  const latestPreview = useRef<FilePreview | null>(null);
  latestPreview.current = preview;
  const scopeRef = useRef<string | null>(null);
  scopeRef.current = scopeSessionId;
  const sessionRequest = useRef(0);
  const activityByTurn = useMemo(() => {
    const grouped = new Map<string, UiEvent[]>();
    for (const event of activityEvents) {
      if (!event.turnId) continue;
      const group = grouped.get(event.turnId) ?? [];
      group.push(event);
      grouped.set(event.turnId, group);
    }
    return grouped;
  }, [activityEvents]);

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

  useEffect(() => {
    if (authState !== "ready") return;
    let cancelled = false;
    setSelectedModel(null);
    void request<{ providers: AvailableModelProvider[] }>("/api/v1/models/available")
      .then((value) => { if (!cancelled) { setAvailableModels(value.providers); setModelListError(""); } })
      .catch((reason) => { if (!cancelled) setModelListError(errorMessage(reason)); });
    return () => { cancelled = true; };
  }, [authState, boot?.sessionId]);

  useEffect(() => {
    if (authState !== "ready" || !workspaceGrid.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setWorkspaceWidth(width);
      if (width > 900) setLayout((current) => {
        const fitted = fitWorkspaceLayout(current, width);
        return fitted.tree === current.tree && fitted.task === current.task && fitted.inspector === current.inspector ? current : fitted;
      });
    });
    observer.observe(workspaceGrid.current);
    return () => observer.disconnect();
  }, [authState]);

  useLayoutEffect(() => {
    try { window.localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(layout)); }
    catch { /* Private browsing can disable local storage. */ }
  }, [layout]);

  function resizeBoundary(boundary: WorkspaceBoundary, delta: number) {
    const width = workspaceGrid.current?.getBoundingClientRect().width ?? workspaceWidth;
    setLayout((current) => resizeWorkspaceLayout(current, boundary, delta, width));
  }

  function resetBoundary(boundary: WorkspaceBoundary) {
    const width = workspaceGrid.current?.getBoundingClientRect().width ?? workspaceWidth;
    setLayout((current) => fitWorkspaceLayout({ ...current, [boundary]: DEFAULT_WORKSPACE_LAYOUT[boundary] }, width));
  }

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
  }, [boot?.sessionId, scopeSessionId, selectedTaskId, refreshTurns]);

  useEffect(() => {
    setActivityEvents([]);
    if (!selectedTaskId) return;
    let cancelled = false;
    void request<{ events: UiEvent[] }>(`/api/v1/tasks/${encodeURIComponent(selectedTaskId)}/activity`)
      .then(({ events }) => {
        if (cancelled) return;
        setActivityEvents((current) => {
          const merged = new Map([...events, ...current.filter((item) => item.taskId === selectedTaskId)].map((item) => [item.seq, item]));
          return [...merged.values()].sort((a, b) => a.seq - b.seq);
        });
      }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedTaskId]);

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
        setEventRevision((value) => value + 1);
        if (event.taskId === latestTask.current && (event.kind === "trace.recorded" || event.kind === "assistant.text.delta" || event.kind.startsWith("run."))) {
          setActivityEvents((current) => current.some((item) => item.seq === event.seq) ? current : [...current, event]);
        }
        if (event.turnId && event.kind === "trace.recorded") {
          setProgress((previous) => ({ ...previous, [event.turnId!]: String(event.payload.type ?? "") }));
          if (["tool.called", "tool.completed", "tool.failed", "context.build.completed", "llm.completed"].includes(String(event.payload.type))) setRevision((value) => value + 1);
        }
        if (event.kind.startsWith("run.") && event.turnId) {
          setActiveRun((current) => current && current.turnId === event.turnId ? { ...current, status: event.kind.slice(4) } : current);
        }
        if (event.kind.startsWith("run.") || event.kind.startsWith("task.")) {
          if (latestTask.current) void refreshTurns(latestTask.current).catch(() => {});
          if (event.kind.startsWith("task.")) void refreshBootstrap().catch(() => {});
          if (event.kind === "run.completed" || event.kind === "run.failed" || event.kind === "run.interrupted") setRevision((value) => value + 1);
        }
        if (event.kind === "settings.models.default.changed") void refreshBootstrap().catch(() => {});
      };
      source.onerror = () => {
        setConnected(false); source?.close();
        reconnectTimer = window.setTimeout(connect, 1800);
      };
    };
    connect();
    return () => { stopped = true; source?.close(); window.clearTimeout(reconnectTimer); };
  }, [boot?.sessionId, refreshTurns, refreshBootstrap]);

  useLayoutEffect(() => {
    if (followOutput.current && chatScroll.current) chatScroll.current.scrollTop = chatScroll.current.scrollHeight;
  }, [turns, activityEvents, taskPanelView]);

  useEffect(() => {
    if (!jumpTurnId) return;
    const target = document.getElementById(`chat-turn-${jumpTurnId}`);
    if (target) { followOutput.current = false; target.scrollIntoView({ block: "center" }); setJumpTurnId(null); }
  }, [jumpTurnId, turns]);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthError("");
    try {
      await request<{ csrf: string }>("/api/v1/auth", { method: "POST", body: { accessCode } });
      setAccessCode(""); await refreshBootstrap();
    } catch (reason) { setAuthError(errorMessage(reason)); }
  }

  async function showWorkspaces() {
    setWorkspacePath(boot?.workspacePath ?? "");
    setWorkspaceError("");
    setWorkspaceDialog(true);
    try {
      const { recent } = await request<{ recent: string[] }>("/api/v1/workspaces");
      setRecentWorkspaces(recent);
    } catch (reason) { setWorkspaceError(errorMessage(reason)); }
  }

  async function pickWorkspace() {
    if (!boot) return;
    setWorkspaceBusy(true); setWorkspaceError("");
    try {
      const { path } = await request<{ path: string | null }>("/api/v1/workspaces/pick", { method: "POST", csrf: boot.csrf });
      if (path) setWorkspacePath(path);
    } catch (reason) { setWorkspaceError(errorMessage(reason)); }
    finally { setWorkspaceBusy(false); }
  }

  async function openWorkspace(path: string) {
    if (!boot || workspaceBusy) return;
    if (fileDirty && !window.confirm(copy.discardFileSwitchWorkspace)) return;
    setWorkspaceBusy(true); setWorkspaceError("");
    try {
      await request("/api/v1/workspaces/open", { method: "POST", csrf: boot.csrf, body: { path: path.trim() } });
      window.location.reload();
    } catch (reason) { setWorkspaceError(errorMessage(reason)); setWorkspaceBusy(false); }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!boot || !taskTitle.trim()) return;
    setBusy(true); setError("");
    try {
      const task = await request<Task>("/api/v1/tasks", { method: "POST", body: { title: taskTitle.trim() }, csrf: boot.csrf });
      setTaskDialog(false); setTaskTitle(""); setScopeSessionId(boot.sessionId); await refreshBootstrap(); setSelectedTaskId(task.id); setTaskPanelView("conversation"); setMobileView("tasks");
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
      if (action === "switch" || action === "resume") { setSelectedTaskId(task.id); setTaskPanelView("conversation"); setMobileView("tasks"); }
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function sendTurn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!boot || !boot.modelConfigured || (!text && !pendingRefs.length) || busy || modelSaving) return;
    setBusy(true); setError("");
    try {
      let targetId = selectedTaskId;
      if (taskPanelView === "list") {
        const title = (text.split("\n")[0]?.trim() || copy.fileTask).slice(0, 120);
        const created = await request<Task>("/api/v1/tasks", { method: "POST", body: { title }, csrf: boot.csrf });
        targetId = created.id;
        scopeRef.current = boot.sessionId;
        latestTask.current = created.id;
        setScopeSessionId(boot.sessionId);
        setTasks((current) => [created, ...current.filter((item) => item.id !== created.id)]);
        setSelectedTaskId(created.id);
        setTaskPanelView("conversation");
        await refreshBootstrap();
      }
      if (!targetId) throw new Error(copy.selectTaskFirst);
      const run = await request<UiRun>(`/api/v1/tasks/${encodeURIComponent(targetId)}/turns`, {
        method: "POST", body: { input: text || copy.inspectReferencedFiles, clientRequestId: crypto.randomUUID(), fileReferences: pendingRefs }, csrf: boot.csrf
      });
      setActiveRun(run); setDraft(""); setPendingRefs([]); setMobileView("tasks");
      followOutput.current = true;
      await refreshTurns(targetId); setSelectedTurnId(run.turnId);
      const latest = await request<UiRun>(`/api/v1/runs/${encodeURIComponent(run.runId)}`);
      setActiveRun(latest);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function changeDefaultModel(selection: ModelSelection) {
    if (!boot || modelSaving) return;
    setSelectedModel(selection); setModelSaving(true); setError("");
    try {
      const saved = await request<ModelSelection>("/api/v1/models/default", { method: "PUT", body: selection, csrf: boot.csrf });
      setBoot((current) => current && ({ ...current, modelProviderId: saved.providerId, model: saved.modelId }));
      setAvailableModels((current) => current.map((provider) => provider.id === saved.providerId ? { ...provider, defaultModel: saved.modelId } : provider));
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message === "接口不存在。" || message === "HTTP 404" ? copy.modelServerOutdated : message);
    }
    finally { setSelectedModel(null); setModelSaving(false); }
  }

  async function openFile(path: string) {
    if (preview?.path === path) { setMobileView("file"); return; }
    if (fileDirty && !window.confirm(copy.discardFileOpenOther)) return;
    setError("");
    try {
      const file = await request<FilePreview>(`/api/v1/file?path=${encodeURIComponent(path)}`);
      setPreview(file); setFileDirty(false); setMobileView("file");
    } catch (reason) { setError(errorMessage(reason)); }
  }

  function closeFile() {
    if (fileDirty && !window.confirm(copy.discardFileClose)) return;
    setPreview(null); setFileDirty(false);
  }

  async function toggleHistory() {
    if (historyOpen) { setHistoryOpen(false); return; }
    try {
      const result = await request<{ sessions: Array<{ id: string; status: string; startedAt: string; turnCount: number }> }>("/api/v1/sessions");
      setSessions(result.sessions); setHistoryOpen(true);
    } catch (reason) { setError(errorMessage(reason)); }
  }

  async function selectSession(sessionId: string) {
    if (!boot) return;
    const requestNumber = ++sessionRequest.current;
    setError("");
    try {
      const list = sessionId === boot.sessionId ? boot.tasks :
        (await request<{ tasks: Task[] }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/tasks`)).tasks;
      if (requestNumber !== sessionRequest.current) return;
      const target = sessionId === boot.sessionId ? list.find((item) => item.id === boot.currentTaskId) ?? list[0] :
        list.find((item) => item.turnCount > 0) ?? list[0];
      scopeRef.current = sessionId;
      latestTask.current = target?.id ?? null;
      setScopeSessionId(sessionId); setTasks(list);
      setSelectedTaskId(target?.id ?? null);
      setMobileView("tasks"); setTaskPanelView(sessionId !== boot.sessionId && target && target.turnCount > 0 ? "conversation" : "list"); setHistoryOpen(false);
    } catch (reason) { setError(errorMessage(reason)); }
  }

  function referenceSelection(ref: FileReference) {
    setPendingRefs((current) => current.some((item) => item.path === ref.path && item.startLine === ref.startLine && item.endLine === ref.endLine) ? current : [...current, ref].slice(0, 5));
    setMobileView("tasks"); setTaskPanelView("conversation");
  }

  function openContextTurn(turnId: string) {
    setSelectedTurnId(turnId); setMobileView("tasks"); setTaskPanelView("conversation"); setInspectorOpen(false); setJumpTurnId(turnId);
  }

  const task = tasks.find((item) => item.id === selectedTaskId);
  const running = activeRun && ["accepted", "running"].includes(activeRun.status);
  const canSend = task?.status === "active" && boot?.currentTaskId === task.id;
  const composerEnabled = boot?.modelConfigured !== false && (taskPanelView === "list" || canSend);
  const shellStyle = {
    "--tree-width": `${layout.tree}px`, "--task-width": `${layout.task}px`, "--inspector-width": `${layout.inspector}px`
  } as CSSProperties;
  const defaultModel: ModelSelection = { providerId: boot?.modelProviderId ?? "minimax", modelId: boot?.model ?? "" };
  const modelChoice = selectedModel ?? defaultModel;
  const modelGroups = availableModels.map((provider) => ({ ...provider, models: [...new Set([provider.defaultModel, ...provider.models])] }));
  if (boot && !modelGroups.some((provider) => provider.id === defaultModel.providerId)) {
    modelGroups.unshift({ id: defaultModel.providerId, defaultModel: defaultModel.modelId, models: [defaultModel.modelId] });
  }

  if (authState === "loading") return <div className="auth-screen"><div className="auth-shell"><div className="brand-mark"><Code2 size={21} /></div><strong>{copy.connectingWorkbench}</strong></div></div>;
  if (authState === "locked") return <div className="auth-screen"><form className="auth-shell" onSubmit={authenticate}><div className="brand-lockup"><div className="brand-mark"><Code2 size={21} /></div><strong>Figo Agent</strong></div><h1>{copy.localWorkbench}</h1><label htmlFor="access-code">{copy.accessCode}</label><input id="access-code" autoFocus type="password" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder={copy.enterAccessCode} /><button className="primary-button" type="submit"><ShieldCheck size={16} />{copy.verifyAndEnter}</button>{authError && <p className="inline-error">{authError}</p>}</form></div>;

  return <div style={shellStyle} className={`app-shell ${settingsOpen ? "settings-visible" : ""} ${inspectorOpen ? "inspector-open" : ""} ${mobileView === "file" ? "mobile-file" : ""} ${taskPanelView === "conversation" ? "task-detail" : "task-list-view"}`}>
    <header className="topbar">
      <div className="brand-lockup"><div className="brand-mark"><Code2 size={19} /></div><strong>Figo Agent</strong></div>
      <div className="top-divider" />
      <button className="workspace-switcher" type="button" title={boot?.workspacePath} aria-label={copy.openOrSwitchWorkspace} onClick={() => void showWorkspaces()}><FolderOpen size={16} /><b>{boot?.workspace ?? copy.workspace}</b></button>
      <div className="top-divider optional" />
      <div className="top-meta branch-meta"><span>{copy.branch}</span><GitBranch size={14} /><b>{boot?.branch || copy.noGitBranch}</b></div>
      <div className="top-spacer" />
      <div className="model-label"><span>{copy.model}</span><b title={boot?.model}>{boot?.model || copy.notConfigured}</b></div>
      <span className={`connection-status ${connected ? "online" : "offline"}`}><span className="status-dot" />{connected ? running ? copy.running : copy.connected : copy.connectionLost}</span>
      <span className="usage-label" title={usage ? formatCopy(copy.usageTooltip, { requests: usage.requestCount, unavailable: usage.unavailableCount }) : copy.noUsageRecords}>Tokens {usage?.totalReportedCount ? `${formatCopy(copy.knownUsage, { count: usage.knownTotalTokens.toLocaleString() })}${usage.unavailableCount ? ` · ${formatCopy(copy.usageMissingCount, { count: usage.unavailableCount })}` : ""}` : copy.usageUnavailable}</span>
      <button className="icon-button" title={copy.settingsTitle} aria-label={copy.settingsTitle} onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></button>
      <button className="icon-button inspector-toggle" title={inspectorOpen ? copy.closeInspector : copy.openInspector} aria-label={inspectorOpen ? copy.closeInspector : copy.openInspector} onClick={() => setInspectorOpen((open) => !open)}><PanelRightOpen size={19} /></button>
    </header>

    {error && <div className="global-error"><span>{error}</span><button className="plain-icon" title={copy.closeError} aria-label={copy.closeError} onClick={() => setError("")}><X size={15} /></button></div>}

    <div className="workspace-grid" ref={workspaceGrid}>
      <nav className="mobile-workspace-tabs" aria-label={copy.workspaceViews}><button className={mobileView === "file" ? "active" : ""} onClick={() => setMobileView("file")}><FileText size={15} />{copy.files}</button><button className={mobileView === "tasks" ? "active" : ""} onClick={() => setMobileView("tasks")}><MessageSquareText size={15} />{copy.tasks}</button></nav>
      <div className="task-pane">
      <main className="main-pane task-panel-conversation">
        <div className="main-tabs"><button className="task-back" title={copy.backToTaskList} aria-label={copy.backToTaskList} onClick={() => setTaskPanelView("list")}><ArrowLeft size={17} /></button><span className="pane-title truncate" title={task?.title}>{task?.title ?? copy.taskConversation}</span>{scopeSessionId && boot && scopeSessionId !== boot.sessionId && <button className="history-return" title={copy.backToCurrentSession} aria-label={copy.backToCurrentSession} onClick={() => void selectSession(boot.sessionId)}><History size={13} />{copy.history}</button>}<span className={`mini-status ${task?.status ?? ""}`} title={statusLabel(task?.status ?? "")} /></div>
        <div className="chat-scroll" ref={chatScroll} onScroll={(event) => { const node = event.currentTarget; followOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 90; }}>
          {!turns.length && <div className="chat-empty"><MessageSquareText size={27} /><strong>{copy.startTask}</strong></div>}
          {turns.map((turn) => {
            const activity = activityForTurn(activityByTurn.get(turn.id) ?? [], turn.id);
            const activityItems = activity.items.length ? activity.items : toolCalls.filter((call) => call.turnId === turn.id).map((call) => ({
              key: call.id, label: call.name, state: call.status === "completed" ? "completed" as const : call.status === "running" ? "running" as const : "failed" as const, toolCallId: call.id
            }));
            const inFlight = turn.status === "received" || turn.status === "processing";
            const answer = visibleAnswer(turn.output || activity.text);
            return <section id={`chat-turn-${turn.id}`} className={`turn-group ${selectedTurnId === turn.id ? "focused" : ""}`} key={turn.id}>
              <div className="turn-header"><span title={turn.id}>{turn.taskSeq ? formatCopy(copy.turnNumber, { count: turn.taskSeq }) : copy.historicalTurn}</span>{turn.modelId && <span className="turn-model" title={`${turn.providerId ?? ""} · ${turn.modelId}`}>{turn.modelId}</span>}<time>{timeOf(turn.createdAt)}</time><span className={`turn-status ${turn.status}`}>{statusLabel(turn.status)}</span></div>
              <div className="turn-prompt"><p>{turn.input}</p></div>
              <div className="turn-work"><div className="turn-agent-heading"><span className="agent-symbol"><Code2 size={14} /></span><strong>Figo Agent</strong>{inFlight && <LoaderCircle size={13} className="spinning" />}</div>
                <ActivityTimeline items={activityItems} running={inFlight} expanded={turn.id === turns.at(-1)?.id} onTool={(id) => { setSelectedTurnId(turn.id); setFocusToolId(id); setInspectorTab("trace"); setInspectorOpen(true); }} />
                {answer ? <div className={`turn-answer ${inFlight ? "streaming" : ""}`}><ReactMarkdown>{answer}</ReactMarkdown></div> : inFlight ? <div className="answer-pending">{progress[turn.id] ? progressLabel(progress[turn.id]) : copy.processing}</div> : null}
                <div className="message-links"><button onClick={() => { setSelectedTurnId(turn.id); setInspectorTab("context"); setInspectorOpen(true); }}><Database size={14} />{copy.context}</button><button onClick={() => { setSelectedTurnId(turn.id); setInspectorTab("captures"); setInspectorOpen(true); }}><Activity size={14} />{copy.capture}</button><button onClick={() => { setSelectedTurnId(turn.id); setInspectorTab("trace"); setInspectorOpen(true); }}><Code2 size={14} />Trace</button></div>
              </div>
            </section>;
          })}<div ref={messagesEnd} />
        </div>
      </main>

      <aside className="sidebar-pane task-panel-list">
        <div className="sidebar-section-title task-heading"><strong>{copy.tasks}</strong><div className="inline-actions"><button className="icon-button" title={copy.historicalSession} aria-label={copy.historicalSession} onClick={() => void toggleHistory()}><History size={16} /></button><button className="outline-button" onClick={() => setTaskDialog(true)}><Plus size={15} />{copy.newTaskShort}</button></div></div>
        {scopeSessionId && boot && scopeSessionId !== boot.sessionId && <button className="historical-banner" onClick={() => void selectSession(boot.sessionId)}><History size={13} />{copy.historicalSessionReadOnly}<span>{copy.returnCurrent}</span></button>}
        {historyOpen && <div className="session-list">{sessions.map((session) => <button key={session.id} className={scopeSessionId === session.id ? "selected" : ""} onClick={() => void selectSession(session.id)}><span className="truncate" title={session.id}>{session.id === boot?.sessionId ? copy.currentSession : shortId(session.id)}</span><small>{formatCopy(copy.turnCount, { count: session.turnCount })} · {session.startedAt.slice(5, 16)}</small></button>)}</div>}
        <div className="task-list">{tasks.map((item) => <div className={`task-row ${selectedTaskId === item.id ? "selected" : ""}`} key={item.id}>
          <button className="task-select" title={item.title} onClick={() => { setSelectedTaskId(item.id); setTaskPanelView("conversation"); setMobileView("tasks"); }}><span className="task-title truncate">{item.title}</span><span className="task-sub"><span className={`mini-status ${item.status}`} />{statusLabel(item.status)} · {timeOf(item.updatedAt)}</span></button>
          {item.sessionId === boot?.sessionId && <button className="plain-icon task-more" title={formatCopy(copy.taskActions, { name: item.title })} aria-label={formatCopy(copy.taskActions, { name: item.title })} onClick={() => setTaskMenu(taskMenu === item.id ? null : item.id)}><MoreHorizontal size={17} /></button>}
          {taskMenu === item.id && item.sessionId === boot?.sessionId && <div className="task-menu">{(["switch", "pause", "resume", "finish", "cancel", "compact"] as const).filter((action) => action === "switch" ? item.status === "active" : action === "resume" ? item.status === "paused" : item.status === "active").map((action) => <button key={action} onClick={() => void taskAction(item, action)}>{actionLabel(action)}</button>)}</div>}
        </div>)}</div>
      </aside>
      <form className="composer" onSubmit={sendTurn}>
        {boot?.modelConfigured === false && <p className="composer-warning" role="status">{copy.modelKeyMissing}</p>}
        {pendingRefs.length > 0 && <div className="pending-refs">{pendingRefs.map((ref, index) => <span key={`${ref.path}-${index}`}><FileText size={13} />{ref.path} L{ref.startLine}–{ref.endLine}<button type="button" title={copy.removeReference} aria-label={copy.removeReference} onClick={() => setPendingRefs((current) => current.filter((_, position) => position !== index))}><X size={12} /></button></span>)}</div>}
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={boot?.modelConfigured === false ? "" : taskPanelView === "list" ? copy.newTaskPlaceholder : canSend ? copy.messagePlaceholder : copy.inactiveTaskPlaceholder} disabled={!composerEnabled || Boolean(running)} rows={2} />
        <div className="composer-bottom"><span>{taskPanelView === "list" ? copy.newTask : pendingRefs.length ? formatCopy(copy.fileReferenceCount, { count: pendingRefs.length }) : ""}</span><select className="composer-model-select" aria-label={copy.chatModel} title={modelListError || copy.chatModel} value={JSON.stringify(modelChoice)} onChange={(event) => void changeDefaultModel(JSON.parse(event.target.value) as ModelSelection)} disabled={Boolean(running) || busy || modelSaving}>
          {modelGroups.map((provider) => <optgroup key={provider.id} label={provider.id}>{provider.models.map((modelId) => <option key={modelId} value={JSON.stringify({ providerId: provider.id, modelId })}>{modelId}</option>)}</optgroup>)}
        </select><button className="primary-button" type="submit" disabled={!composerEnabled || Boolean(running) || busy || modelSaving || (!draft.trim() && !pendingRefs.length)}><Send size={15} />{copy.send}</button></div>
      </form>
      </div>

      <section className="editor-pane" aria-label={copy.fileWorkspace}>
        <div className="editor-top">
          {boot && <FileTree selected={preview?.path ?? null} onOpen={(path) => void openFile(path)} searchMinChars={boot.fileBrowser.searchMinChars} searchMaxChars={boot.fileBrowser.searchMaxChars} maxDirectoryEntries={boot.fileBrowser.maxDirectoryEntries} />}
          <div className="editor-workspace">
            <div className="main-tabs"><span className="pane-title"><FileText size={15} />{preview ? <span className="truncate" title={preview.path}>{preview.path.split("/").at(-1)}</span> : copy.files}</span></div>
            {preview && boot ? <FilePreviewPane key={preview.path} preview={preview} maxPreviewBytes={boot.fileBrowser.maxPreviewBytes} csrf={boot.csrf} onSaved={(saved) => { if (latestPreview.current?.path === saved.path) { setPreview(saved); setFileDirty(false); } }} onDirtyChange={setFileDirty} onReference={referenceSelection} onClose={closeFile} /> :
              <div className="editor-empty"><FileText size={27} /><strong>{copy.selectFile}</strong></div>}
          </div>
          <ResizeHandle boundary="tree" label={copy.resizeFileTree} value={layout.tree} min={workspaceBoundaryLimits(layout, "tree", workspaceWidth)[0]} max={workspaceBoundaryLimits(layout, "tree", workspaceWidth)[1]} onDelta={resizeBoundary} onReset={resetBoundary} />
        </div>
        {boot && <ToolPanel csrf={boot.csrf} eventRevision={eventRevision} maxCommandChars={boot.terminal.maxCommandChars} />}
      </section>

      <ResizeHandle boundary="task" label={copy.resizeTaskPanel} value={layout.task} min={workspaceBoundaryLimits(layout, "task", workspaceWidth)[0]} max={workspaceBoundaryLimits(layout, "task", workspaceWidth)[1]} onDelta={resizeBoundary} onReset={resetBoundary} />

      {inspectorOpen && <Inspectors turnId={selectedTurnId} tab={inspectorTab} onTab={setInspectorTab} revision={revision} focusToolId={focusToolId} loadedTurnIds={turns.map((turn) => turn.id)} onOpenTurn={openContextTurn} onClose={() => setInspectorOpen(false)} resizeHandle={<ResizeHandle boundary="inspector" label={copy.resizeInspector} value={layout.inspector} min={workspaceBoundaryLimits(layout, "inspector", workspaceWidth)[0]} max={workspaceBoundaryLimits(layout, "inspector", workspaceWidth)[1]} onDelta={resizeBoundary} onReset={resetBoundary} />} />}
    </div>
    {taskDialog && <div className="dialog-backdrop" onClick={() => setTaskDialog(false)}><form className="task-dialog" onClick={(event) => event.stopPropagation()} onSubmit={createTask}><div className="dialog-title"><SquarePen size={19} /><strong>{copy.newTaskTitle}</strong><button className="plain-icon" type="button" title={copy.close} aria-label={copy.close} onClick={() => setTaskDialog(false)}><X size={17} /></button></div><label htmlFor="task-title">{copy.taskName}</label><input id="task-title" autoFocus maxLength={120} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder={copy.taskNameExample} /><div className="dialog-actions"><button type="button" className="outline-button" onClick={() => setTaskDialog(false)}>{copy.cancel}</button><button type="submit" className="primary-button" disabled={!taskTitle.trim() || busy}><Plus size={15} />{copy.create}</button></div></form></div>}
    {workspaceDialog && <div className="dialog-backdrop" onClick={() => { if (!workspaceBusy) setWorkspaceDialog(false); }}><form className="task-dialog workspace-dialog" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void openWorkspace(workspacePath); }}><div className="dialog-title"><FolderOpen size={19} /><strong>{copy.openFolder}</strong><button className="plain-icon" type="button" title={copy.close} aria-label={copy.close} disabled={workspaceBusy} onClick={() => setWorkspaceDialog(false)}><X size={17} /></button></div><label htmlFor="workspace-path">{copy.folderPath}</label><div className="workspace-path-row"><input id="workspace-path" autoFocus value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder={copy.absolutePathPlaceholder} /><button type="button" className="outline-button" disabled={workspaceBusy} onClick={() => void pickWorkspace()}><FolderOpen size={15} />{copy.browse}</button></div>{recentWorkspaces.length > 0 && <div className="recent-workspaces"><span>{copy.recentOpened}</span>{recentWorkspaces.map((path) => <button type="button" key={path} title={path} disabled={workspaceBusy} onClick={() => void openWorkspace(path)}><FolderOpen size={14} /><span className="recent-workspace-text"><b>{path.split("/").filter(Boolean).at(-1) ?? path}</b><small>{path}</small></span></button>)}</div>}{workspaceError && <p className="inline-error" role="alert">{workspaceError}</p>}<div className="dialog-actions"><button type="button" className="outline-button" disabled={workspaceBusy} onClick={() => setWorkspaceDialog(false)}>{copy.cancel}</button><button type="submit" className="primary-button" disabled={!workspacePath.trim() || workspaceBusy}>{workspaceBusy ? <LoaderCircle size={15} className="spinning" /> : <FolderOpen size={15} />}{copy.open}</button></div></form></div>}
    {settingsOpen && <SettingsPage csrf={boot?.csrf ?? ""} onClose={() => setSettingsOpen(false)} />}
  </div>;
}

function statusLabel(status: string): string {
  return ({ active: copy.statusActive, paused: copy.statusPaused, completed: copy.statusCompleted, cancelled: copy.statusCancelled, archived: copy.statusArchived, received: copy.statusReceived, processing: copy.statusProcessing, failed: copy.statusFailed } as Record<string, string>)[status] ?? status;
}
function actionLabel(action: string): string {
  return ({ switch: copy.actionSwitch, pause: copy.actionPause, resume: copy.actionResume, finish: copy.actionFinish, cancel: copy.actionCancel, compact: copy.actionCompact } as Record<string, string>)[action] ?? action;
}
function progressLabel(type: string): string {
  return ({ "turn.received": copy.statusReceived, "turn.processing": copy.progressProcessing, "context.build.started": copy.progressBuildingContext, "llm.called": copy.progressCallingModel, "tool.called": copy.progressCallingTool, "tool.completed": copy.progressToolCompleted, "turn.completed": copy.progressFinishing, "turn.failed": copy.progressFailed } as Record<string, string>)[type] ?? formatCopy(copy.progressOther, { type });
}
function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : copy.operationFailed; }
