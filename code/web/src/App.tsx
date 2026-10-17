import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  Activity, ArrowLeft, Code2, Database, FileText, FolderOpen, GitBranch, History,
  LoaderCircle, MessageSquareText, PanelRightOpen, Plus, Send,
  Settings2, ShieldCheck, Square, SquarePen, X
} from "lucide-react";
import { request, timeOf, type AvailableModelProvider, type Bootstrap, type FilePreview, type FileReference, type ModelSelection, type SessionSummary, type Task, type Turn, type UiEvent, type UiRun, type UsageSummary, type ToolCall, type TraceEvent } from "./api";
import { FileTree } from "./FileTree";
import { FilePreviewPane } from "./FilePreviewPane";
import { Inspectors, type InspectorTab } from "./Inspectors";
import { TraceDetailPane } from "./TraceDetailPane";
import { TraceInspector, type InspectorFocus } from "./TraceInspector";
import { ResizeHandle } from "./ResizeHandle";
import { ToolPanel } from "./ToolPanel";
import { copy, formatCopy, inspectorCopy } from "./i18n";
import { SettingsPage } from "./SettingsPage";
import { ActivityTimeline } from "./ActivityTimeline";
import { activityForTurn, visibleAnswer } from "./activity-feed";
import ReactMarkdown from "react-markdown";
import { DEFAULT_WORKSPACE_LAYOUT, WORKSPACE_LAYOUT_KEY, decodeWorkspaceLayout, fitWorkspaceLayout, resizeWorkspaceLayout, workspaceBoundaryLimits, type WorkspaceBoundary } from "./workspace-layout";
import { TaskSidebar } from "./TaskSidebar";
import { decodeTaskView, taskViewKey, type TaskViewPreference } from "./task-sidebar-state";
import type { TaskListItem } from "../../src/contracts/task-list.js";
import { BrandLogo } from "./BrandLogo";

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [authState, setAuthState] = useState<"loading" | "locked" | "ready">("loading");
  const [accessCode, setAccessCode] = useState("");
  const [authError, setAuthError] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [scopeSessionId, setScopeSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [focusToolId, setFocusToolId] = useState<string | null>(null);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [jumpTurnId, setJumpTurnId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<UiRun | null>(null);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [activityEvents, setActivityEvents] = useState<UiEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [revision, setRevision] = useState(0);
  const [eventRevision, setEventRevision] = useState(0);
  const [mobileView, setMobileView] = useState<"tasks" | "file">("tasks");
  const [taskPanelView, setTaskPanelView] = useState<"list" | "conversation">("list");
  const [taskListMode, setTaskListMode] = useState<"recent" | "all">("recent");
  const [layout, setLayout] = useState(() => {
    try { return decodeWorkspaceLayout(window.localStorage.getItem(WORKSPACE_LAYOUT_KEY), window.innerWidth); }
    catch { return DEFAULT_WORKSPACE_LAYOUT; }
  });
  const [workspaceWidth, setWorkspaceWidth] = useState(window.innerWidth);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [fileDirty, setFileDirty] = useState(false);
  const [traceSelection, setTraceSelection] = useState<{ event: TraceEvent; tool?: ToolCall } | null>(null);
  const [editorView, setEditorView] = useState<"file" | "trace">("file");
  const [pendingRefs, setPendingRefs] = useState<FileReference[]>([]);
  const [draft, setDraft] = useState("");
  const [selectedModel, setSelectedModel] = useState<ModelSelection | null>(null);
  const [modelSaving, setModelSaving] = useState(false);
  const [availableModels, setAvailableModels] = useState<AvailableModelProvider[]>([]);
  const [modelListError, setModelListError] = useState("");
  const [modelSettingsVersion, setModelSettingsVersion] = useState("");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("context");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [traceInspectorFocus, setTraceInspectorFocus] = useState<InspectorFocus | null>(null);
  const [focusRequestId, setFocusRequestId] = useState<string | null>(null);
  const [taskDialog, setTaskDialog] = useState(false);
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
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
  const bootstrapRequest = useRef(0);
  const restoredTaskView = useRef(false);
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
    const requestId = ++bootstrapRequest.current;
    const data = await request<Bootstrap>("/api/v1/bootstrap");
    if (requestId !== bootstrapRequest.current) return data;
    if (!restoredTaskView.current) {
      let preference: TaskViewPreference | null = null;
      try { preference = decodeTaskView(window.localStorage.getItem(taskViewKey(data.workspacePath))); }
      catch { /* 浏览器存储不可用时仍可使用工作台。 */ }
      let restoredTasks = data.tasks;
      if (preference) {
        try {
          restoredTasks = preference.sessionId === data.sessionId ? data.tasks
            : (await request<{ tasks: Task[] }>(`/api/v1/sessions/${encodeURIComponent(preference.sessionId)}/tasks`)).tasks;
          if (!restoredTasks.some((item) => item.id === preference!.taskId && item.sessionId === preference!.sessionId)) preference = null;
        } catch { preference = null; }
      }
      let restoredSessions: SessionSummary[] = [];
      if (preference?.historyOpen) {
        try { restoredSessions = (await request<{ sessions: SessionSummary[] }>("/api/v1/sessions")).sessions; }
        catch { preference = { ...preference, historyOpen: false }; }
      }
      if (requestId !== bootstrapRequest.current) return data;
      const sessionId = preference?.sessionId ?? data.sessionId;
      const taskId = preference?.taskId ?? data.currentTaskId ?? data.tasks[0]?.id ?? null;
      scopeRef.current = sessionId; latestTask.current = taskId;
      setScopeSessionId(sessionId); setSelectedTaskId(taskId);
      setTasks(preference ? restoredTasks : data.tasks);
      setTaskPanelView(preference?.view ?? "list"); setTaskListMode(preference?.listMode ?? "recent");
      setHistoryOpen(preference?.historyOpen ?? false); setSessions(restoredSessions);
      restoredTaskView.current = true;
    } else if (!scopeRef.current || scopeRef.current === data.sessionId) setTasks(data.tasks);
    setBoot(data);
    setActiveRun(data.activeRun); setAuthState("ready");
    setScopeSessionId((current) => current ?? data.sessionId);
    setSelectedTaskId((current) => current ?? data.currentTaskId ?? data.tasks[0]?.id ?? null);
    return data;
  }, []);

  useEffect(() => {
    if (!boot || !scopeSessionId || !selectedTaskId || !restoredTaskView.current) return;
    const preference: TaskViewPreference = { version: 1, sessionId: scopeSessionId, taskId: selectedTaskId,
      view: taskPanelView, historyOpen, listMode: taskListMode };
    try { window.localStorage.setItem(taskViewKey(boot.workspacePath), JSON.stringify(preference)); }
    catch { /* 视图偏好不影响数据库事实或运行权限。 */ }
  }, [boot?.workspacePath, scopeSessionId, selectedTaskId, taskPanelView, historyOpen, taskListMode]);

  const modelsSaved = useCallback((version: string) => {
    setModelSettingsVersion(version);
    void refreshBootstrap().catch((reason) => setError(errorMessage(reason)));
  }, [refreshBootstrap]);

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
  }, [authState, boot?.sessionId, modelSettingsVersion]);

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

  useEffect(() => { setTraceSelection(null); setEditorView("file"); setFocusRequestId(null); }, [selectedTaskId, selectedTurnId]);

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
        if (event.taskId === latestTask.current && (event.kind === "trace.recorded" || event.kind === "assistant.text.delta" || event.kind === "assistant.text.reset" || event.kind.startsWith("run."))) {
          setActivityEvents((current) => current.some((item) => item.seq === event.seq) ? current : [...current, event]);
        }
        if (event.turnId && event.kind === "trace.recorded") {
          setProgress((previous) => ({ ...previous, [event.turnId!]: String(event.payload.type ?? "") }));
          if (["tool.called", "tool.completed", "tool.failed", "context.build.completed", "llm.completed"].includes(String(event.payload.type))) setRevision((value) => value + 1);
        }
        if (event.kind.startsWith("run.") && event.turnId) {
          setActiveRun((current) => current && current.turnId === event.turnId ? { ...current, status: event.kind.slice(4) } : current);
          if (["run.completed", "run.failed", "run.interrupted"].includes(event.kind)) setStoppingRunId(null);
        }
        if (event.kind.startsWith("run.") || event.kind.startsWith("task.")) {
          if (latestTask.current) void refreshTurns(latestTask.current).catch(() => {});
          if (event.kind.startsWith("task.")) void refreshBootstrap().catch(() => {});
          if (event.kind === "run.completed" || event.kind === "run.failed" || event.kind === "run.interrupted") setRevision((value) => value + 1);
        }
        if (event.kind === "settings.models.default.changed" || event.kind === "settings.models.updated") {
          modelsSaved(String(event.payload.version));
        }
      };
      source.onerror = () => {
        setConnected(false); source?.close();
        reconnectTimer = window.setTimeout(connect, 1800);
      };
    };
    connect();
    return () => { stopped = true; source?.close(); window.clearTimeout(reconnectTimer); };
  }, [boot?.sessionId, refreshTurns, refreshBootstrap, modelsSaved]);

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

  function beginTaskSelection() {
    return ++sessionRequest.current;
  }

  function showTask(sessionId: string, taskId: string, list: Task[]) {
    scopeRef.current = sessionId; latestTask.current = taskId;
    setTasks(list); setScopeSessionId(sessionId); setSelectedTaskId(taskId);
    setHistoryOpen(false); setTaskPanelView("conversation"); setMobileView("tasks");
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!boot || !taskTitle.trim()) return;
    const requestNumber = beginTaskSelection();
    setBusy(true); setError("");
    try {
      const task = await request<Task>("/api/v1/tasks", { method: "POST", body: { title: taskTitle.trim() }, csrf: boot.csrf });
      setTaskDialog(false); setTaskTitle("");
      const data = await refreshBootstrap();
      if (requestNumber === sessionRequest.current) showTask(task.sessionId, task.id, data.tasks);
    } catch (reason) { if (requestNumber === sessionRequest.current) setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function taskAction(task: Task, action: string) {
    if (!boot) return;
    const changesSelection = action === "switch" || action === "resume";
    const requestNumber = changesSelection ? beginTaskSelection() : sessionRequest.current;
    setBusy(true); setError("");
    try {
      await request(`/api/v1/tasks/${encodeURIComponent(task.id)}/actions`, {
        method: "POST", body: { action }, csrf: boot.csrf
      });
      const data = await refreshBootstrap();
      if (changesSelection && requestNumber === sessionRequest.current) showTask(task.sessionId, task.id, data.tasks);
    } catch (reason) { if (requestNumber === sessionRequest.current) setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function sendTurn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!boot || !boot.modelConfigured || (!text && !pendingRefs.length) || busy || modelSaving) return;
    const requestNumber = taskPanelView === "list" ? beginTaskSelection() : sessionRequest.current;
    setBusy(true); setError("");
    try {
      let targetId = selectedTaskId;
      if (taskPanelView === "list") {
        const title = (text.split("\n")[0]?.trim() || copy.fileTask).slice(0, 120);
        const created = await request<Task>("/api/v1/tasks", { method: "POST", body: { title }, csrf: boot.csrf });
        targetId = created.id;
        if (requestNumber === sessionRequest.current) {
          showTask(created.sessionId, created.id, [created, ...boot.tasks.filter((item) => item.id !== created.id)]);
        }
        await refreshBootstrap();
      }
      if (!targetId) throw new Error(copy.selectTaskFirst);
      const run = await request<UiRun>(`/api/v1/tasks/${encodeURIComponent(targetId)}/turns`, {
        method: "POST", body: { input: text || copy.inspectReferencedFiles, clientRequestId: crypto.randomUUID(), fileReferences: pendingRefs }, csrf: boot.csrf
      });
      setActiveRun(run); setStoppingRunId(null); setDraft(""); setPendingRefs([]); setMobileView("tasks");
      followOutput.current = true;
      await refreshTurns(targetId);
      if (requestNumber === sessionRequest.current) setSelectedTurnId(run.turnId);
      await refreshBootstrap();
      const latest = await request<UiRun>(`/api/v1/runs/${encodeURIComponent(run.runId)}`);
      setActiveRun(latest);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function stopRun() {
    if (!boot || !activeRun || stoppingRunId) return;
    const runId = activeRun.runId;
    setStoppingRunId(runId); setError("");
    try {
      const run = await request<UiRun>(`/api/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", csrf: boot.csrf });
      setActiveRun((current) => current?.runId === runId ? run : current);
      if (!["accepted", "running"].includes(run.status)) setStoppingRunId(null);
    } catch (reason) { setStoppingRunId(null); setError(errorMessage(reason)); }
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
    if (preview?.path === path) { setEditorView("file"); setMobileView("file"); return; }
    if (fileDirty && !window.confirm(copy.discardFileOpenOther)) return;
    setError("");
    try {
      const file = await request<FilePreview>(`/api/v1/file?path=${encodeURIComponent(path)}`);
      setPreview(file); setFileDirty(false); setEditorView("file"); setMobileView("file");
    } catch (reason) { setError(errorMessage(reason)); }
  }

  function closeFile() {
    if (fileDirty && !window.confirm(copy.discardFileClose)) return;
    setPreview(null); setFileDirty(false);
  }

  async function toggleHistory() {
    if (historyOpen) { setHistoryOpen(false); return; }
    try {
      const result = await request<{ sessions: SessionSummary[] }>("/api/v1/sessions");
      setSessions(result.sessions); setHistoryOpen(true);
    } catch (reason) { setError(errorMessage(reason)); }
  }

  async function openTask(item: TaskListItem) {
    const requestNumber = beginTaskSelection();
    setError("");
    try {
      const { tasks: list } = await request<{ tasks: Task[] }>(`/api/v1/sessions/${encodeURIComponent(item.sessionId)}/tasks`);
      if (requestNumber !== sessionRequest.current) return;
      if (!list.some((entry) => entry.id === item.id && entry.sessionId === item.sessionId)) throw new Error(copy.taskListUnavailable);
      showTask(item.sessionId, item.id, list);
    } catch (reason) { if (requestNumber === sessionRequest.current) setError(errorMessage(reason)); }
  }

  async function selectSession(sessionId: string) {
    if (!boot) return;
    const requestNumber = beginTaskSelection();
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

  const selectTrace = useCallback((event: TraceEvent, tool?: ToolCall) => {
    setTraceSelection({ event, tool });
    setEditorView("trace");
    setMobileView("file");
    setFocusToolId(null);
    if (window.innerWidth <= 1200) setInspectorOpen(false);
  }, []);

  function showTraceCapture(requestId: string) {
    setFocusRequestId(requestId); setInspectorTab("captures"); setInspectorOpen(true);
  }

  const task = tasks.find((item) => item.id === selectedTaskId);
  const running = activeRun && ["accepted", "running"].includes(activeRun.status);
  const canSend = task?.status === "active" && task.sessionId === boot?.sessionId && boot?.currentTaskId === task.id;
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

  if (authState === "loading") return <div className="auth-screen"><div className="auth-shell"><BrandLogo /><strong>{copy.connectingWorkbench}</strong></div></div>;
  if (authState === "locked") return <div className="auth-screen"><form className="auth-shell" onSubmit={authenticate}><div className="brand-lockup"><BrandLogo /><strong>Figo Agent</strong></div><h1>{copy.localWorkbench}</h1><label htmlFor="access-code">{copy.accessCode}</label><input id="access-code" autoFocus type="password" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder={copy.enterAccessCode} /><button className="primary-button" type="submit"><ShieldCheck size={16} />{copy.verifyAndEnter}</button>{authError && <p className="inline-error">{authError}</p>}</form></div>;

  return <div style={shellStyle} className={`app-shell ${settingsOpen ? "settings-visible" : ""} ${inspectorOpen ? "inspector-open" : ""} ${mobileView === "file" ? "mobile-file" : ""} ${taskPanelView === "conversation" ? "task-detail" : "task-list-view"}`}>
    <header className="topbar">
      <div className="brand-lockup"><BrandLogo /><strong>Figo Agent</strong></div>
      <div className="top-divider" />
      <button className="workspace-switcher" type="button" title={boot?.workspacePath} aria-label={copy.openOrSwitchWorkspace} onClick={() => void showWorkspaces()}><FolderOpen size={16} /><b>{boot?.workspace ?? copy.workspace}</b></button>
      <div className="top-divider optional" />
      <div className="top-meta branch-meta"><span>{copy.branch}</span><GitBranch size={14} /><b>{boot?.branch || copy.noGitBranch}</b></div>
      <div className="top-spacer" />
      <div className="model-label"><span>{copy.model}</span><b title={boot?.model}>{boot?.model || copy.notConfigured}</b></div>
      <span className={`connection-status ${connected ? "online" : "offline"}`}><span className="status-dot" />{connected ? running ? copy.running : copy.connected : copy.connectionLost}</span>
      <span className="usage-label" title={usage ? formatCopy(copy.usageTooltip, { requests: usage.requestCount, unavailable: usage.unavailableCount }) : copy.noUsageRecords}>Tokens {usage?.totalReportedCount ? `${formatCopy(copy.knownUsage, { count: usage.knownTotalTokens.toLocaleString() })}${usage.unavailableCount ? ` · ${formatCopy(copy.usageMissingCount, { count: usage.unavailableCount })}` : ""}` : copy.usageUnavailable}</span>
      <button className="icon-button" title={copy.settingsTitle} aria-label={copy.settingsTitle} onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></button>
      <button className="icon-button" title={inspectorCopy.title} aria-label={inspectorCopy.title} onClick={() => setTraceInspectorFocus({})}><Activity size={18} /></button>
      <button className="icon-button inspector-toggle" title={inspectorOpen ? copy.closeInspector : copy.openInspector} aria-label={inspectorOpen ? copy.closeInspector : copy.openInspector} onClick={() => setInspectorOpen((open) => !open)}><PanelRightOpen size={19} /></button>
    </header>

    {error && <div className="global-error"><span>{error}</span><button className="plain-icon" title={copy.closeError} aria-label={copy.closeError} onClick={() => setError("")}><X size={15} /></button></div>}

    <div className="workspace-grid" ref={workspaceGrid}>
      <nav className="mobile-workspace-tabs" aria-label={copy.workspaceViews}><button className={mobileView === "file" ? "active" : ""} onClick={() => setMobileView("file")}><FileText size={15} />{copy.files}</button><button className={mobileView === "tasks" ? "active" : ""} onClick={() => setMobileView("tasks")}><MessageSquareText size={15} />{copy.tasks}</button></nav>
      <div className="task-pane">
      <main className="main-pane task-panel-conversation">
        <div className="main-tabs"><button className="task-back" title={copy.backToTaskList} aria-label={copy.backToTaskList} onClick={() => setTaskPanelView("list")}><ArrowLeft size={17} /></button><span className="pane-title truncate" title={task?.displayTitle || task?.title}>{task?.displayTitle || task?.title || copy.taskConversation}</span>{scopeSessionId && boot && scopeSessionId !== boot.sessionId && <><span className="history-readonly-badge">{copy.historicalSessionReadOnly}</span><button className="history-return" title={copy.backToCurrentSession} aria-label={copy.backToCurrentSession} onClick={() => void selectSession(boot.sessionId)}><History size={13} /></button></>}<span className={`mini-status ${task?.status ?? ""}`} title={statusLabel(task?.status ?? "")} /></div>
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
              <div className="turn-work"><div className="turn-agent-heading"><BrandLogo className="agent-symbol" /><strong>Figo Agent</strong>{inFlight && <LoaderCircle size={13} className="spinning" />}</div>
                <ActivityTimeline items={activityItems} running={inFlight} expanded={turn.id === turns.at(-1)?.id} onTool={(id) => { setSelectedTurnId(turn.id); setFocusToolId(id); setInspectorTab("trace"); setInspectorOpen(true); }} />
                {answer ? <div className={`turn-answer ${inFlight ? "streaming" : ""}`}><ReactMarkdown>{answer}</ReactMarkdown></div> : inFlight ? <div className="answer-pending">{progress[turn.id] ? progressLabel(progress[turn.id]) : copy.processing}</div> : null}
                <div className="message-links"><button onClick={() => { setSelectedTurnId(turn.id); setInspectorTab("context"); setInspectorOpen(true); }}><Database size={14} />{copy.context}</button><button onClick={() => { setSelectedTurnId(turn.id); setInspectorTab("captures"); setInspectorOpen(true); }}><Activity size={14} />{copy.capture}</button><button onClick={() => { setSelectedTurnId(turn.id); setInspectorTab("trace"); setInspectorOpen(true); }}><Code2 size={14} />Trace</button></div>
              </div>
            </section>;
          })}<div ref={messagesEnd} />
        </div>
      </main>

      {boot && <TaskSidebar key={boot.workspacePath} workspace={boot.workspacePath} currentSessionId={boot.sessionId}
        selectedTaskId={selectedTaskId} selectedSessionId={scopeSessionId} sessions={sessions} historyOpen={historyOpen}
        mode={taskListMode} onMode={setTaskListMode} visible={taskPanelView === "list"} busy={busy || Boolean(running)} revision={revision}
        settings={boot.taskList} onHistory={() => void toggleHistory()} onSession={(id) => void selectSession(id)}
        onSettings={() => setSettingsOpen(true)} onNew={() => setTaskDialog(true)} onOpen={(item) => void openTask(item)} onAction={(item, action) => void taskAction(item, action)} />}
      <form className="composer" onSubmit={sendTurn}>
        {boot?.modelConfigured === false && <p className="composer-warning" role="status">{copy.modelKeyMissing}</p>}
        {pendingRefs.length > 0 && <div className="pending-refs">{pendingRefs.map((ref, index) => <span key={`${ref.path}-${index}`}><FileText size={13} />{ref.path} L{ref.startLine}–{ref.endLine}<button type="button" title={copy.removeReference} aria-label={copy.removeReference} onClick={() => setPendingRefs((current) => current.filter((_, position) => position !== index))}><X size={12} /></button></span>)}</div>}
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={boot?.modelConfigured === false ? "" : taskPanelView === "list" ? copy.newTaskPlaceholder : canSend ? copy.messagePlaceholder : copy.inactiveTaskPlaceholder} disabled={!composerEnabled || Boolean(running)} rows={2} />
        <div className="composer-bottom"><span>{taskPanelView === "list" ? copy.newTask : pendingRefs.length ? formatCopy(copy.fileReferenceCount, { count: pendingRefs.length }) : ""}</span><select className="composer-model-select" aria-label={copy.chatModel} title={modelListError || copy.chatModel} value={JSON.stringify(modelChoice)} onChange={(event) => void changeDefaultModel(JSON.parse(event.target.value) as ModelSelection)} disabled={Boolean(running) || busy || modelSaving}>
          {modelGroups.map((provider) => <optgroup key={provider.id} label={provider.id}>{provider.models.map((modelId) => <option key={modelId} value={JSON.stringify({ providerId: provider.id, modelId })}>{modelId}</option>)}</optgroup>)}
        </select>{running ? <button className="outline-button" type="button" title={copy.stopRun} onClick={() => void stopRun()} disabled={Boolean(stoppingRunId)}><Square size={15} />{stoppingRunId ? copy.stoppingRun : copy.stopRun}</button> : <button className="primary-button" type="submit" disabled={!composerEnabled || busy || modelSaving || (!draft.trim() && !pendingRefs.length)}><Send size={15} />{copy.send}</button>}</div>
      </form>
      </div>

      <section className="editor-pane" aria-label={copy.fileWorkspace}>
        <div className="editor-top">
          {boot && <FileTree selected={preview?.path ?? null} onOpen={(path) => void openFile(path)} searchMinChars={boot.fileBrowser.searchMinChars} searchMaxChars={boot.fileBrowser.searchMaxChars} maxDirectoryEntries={boot.fileBrowser.maxDirectoryEntries} />}
          <div className="editor-workspace">
            <div className="main-tabs editor-tabs">
              <button className={editorView === "file" ? "active" : ""} title={copy.returnToFileView} aria-label={copy.returnToFileView} onClick={() => setEditorView("file")}><FileText size={15} /><span className="truncate" title={preview?.path}>{preview ? preview.path.split("/").at(-1) : copy.files}</span>{fileDirty && <span className="dirty-dot" title={copy.unsaved} />}</button>
              {traceSelection && <button className={editorView === "trace" ? "active" : ""} onClick={() => setEditorView("trace")} title={traceSelection.event.type}><Activity size={15} /><span className="truncate">Trace · {traceSelection.event.type}</span></button>}
              {traceSelection && <button className="icon-button editor-trace-close" title={copy.closeTraceDetail} aria-label={copy.closeTraceDetail} onClick={() => { setTraceSelection(null); setEditorView("file"); }}><X size={15} /></button>}
            </div>
            <div className="editor-file-view" hidden={editorView === "trace"}>
              {preview && boot ? <FilePreviewPane key={preview.path} preview={preview} maxPreviewBytes={boot.fileBrowser.maxPreviewBytes} csrf={boot.csrf} onSaved={(saved) => { if (latestPreview.current?.path === saved.path) { setPreview(saved); setFileDirty(false); } }} onDirtyChange={setFileDirty} onReference={referenceSelection} onClose={closeFile} /> :
                <div className="editor-empty"><FileText size={27} /><strong>{copy.selectFile}</strong></div>}
            </div>
            {editorView === "trace" && traceSelection && <TraceDetailPane key={traceSelection.event.id} event={traceSelection.event} tool={traceSelection.tool} onCapture={showTraceCapture} onContext={() => { setInspectorTab("context"); setInspectorOpen(true); }} />}
          </div>
          <ResizeHandle boundary="tree" label={copy.resizeFileTree} value={layout.tree} min={workspaceBoundaryLimits(layout, "tree", workspaceWidth)[0]} max={workspaceBoundaryLimits(layout, "tree", workspaceWidth)[1]} onDelta={resizeBoundary} onReset={resetBoundary} />
        </div>
        {boot && <ToolPanel csrf={boot.csrf} eventRevision={eventRevision} maxCommandChars={boot.terminal.maxCommandChars} />}
      </section>

      <ResizeHandle boundary="task" label={copy.resizeTaskPanel} value={layout.task} min={workspaceBoundaryLimits(layout, "task", workspaceWidth)[0]} max={workspaceBoundaryLimits(layout, "task", workspaceWidth)[1]} onDelta={resizeBoundary} onReset={resetBoundary} />

      {inspectorOpen && <div className="ti-legacy-inspector"><div className="ti-sidebar-entry"><button className="icon-button" title={inspectorCopy.title} aria-label={inspectorCopy.title} onClick={() => setTraceInspectorFocus({ key: traceSelection ? `trace:${traceSelection.event.id}` : focusToolId ? `tool:${focusToolId}` : undefined, requestId: focusRequestId ?? undefined, toolCallId: focusToolId ?? undefined, turnId: selectedTurnId ?? undefined, tab: inspectorTab === "captures" ? "llm-request" : inspectorTab === "context" ? "context-flow" : "overview" })}><Activity size={16} /></button></div><Inspectors turnId={selectedTurnId} tab={inspectorTab} onTab={setInspectorTab} revision={revision} focusToolId={focusToolId} focusRequestId={focusRequestId} loadedTurnIds={turns.map((turn) => turn.id)} onOpenTurn={openContextTurn} onSelectTrace={selectTrace} onClose={() => setInspectorOpen(false)} resizeHandle={<ResizeHandle boundary="inspector" label={copy.resizeInspector} value={layout.inspector} min={workspaceBoundaryLimits(layout, "inspector", workspaceWidth)[0]} max={workspaceBoundaryLimits(layout, "inspector", workspaceWidth)[1]} onDelta={resizeBoundary} onReset={resetBoundary} />} /></div>}
    </div>
    {taskDialog && <div className="dialog-backdrop" onClick={() => setTaskDialog(false)}><form className="task-dialog" onClick={(event) => event.stopPropagation()} onSubmit={createTask}><div className="dialog-title"><SquarePen size={19} /><strong>{copy.newTaskTitle}</strong><button className="plain-icon" type="button" title={copy.close} aria-label={copy.close} onClick={() => setTaskDialog(false)}><X size={17} /></button></div><label htmlFor="task-title">{copy.taskName}</label><input id="task-title" autoFocus maxLength={120} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder={copy.taskNameExample} /><div className="dialog-actions"><button type="button" className="outline-button" onClick={() => setTaskDialog(false)}>{copy.cancel}</button><button type="submit" className="primary-button" disabled={!taskTitle.trim() || busy}><Plus size={15} />{copy.create}</button></div></form></div>}
    {workspaceDialog && <div className="dialog-backdrop" onClick={() => { if (!workspaceBusy) setWorkspaceDialog(false); }}><form className="task-dialog workspace-dialog" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void openWorkspace(workspacePath); }}><div className="dialog-title"><FolderOpen size={19} /><strong>{copy.openFolder}</strong><button className="plain-icon" type="button" title={copy.close} aria-label={copy.close} disabled={workspaceBusy} onClick={() => setWorkspaceDialog(false)}><X size={17} /></button></div><label htmlFor="workspace-path">{copy.folderPath}</label><div className="workspace-path-row"><input id="workspace-path" autoFocus value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder={copy.absolutePathPlaceholder} /><button type="button" className="outline-button" disabled={workspaceBusy} onClick={() => void pickWorkspace()}><FolderOpen size={15} />{copy.browse}</button></div>{recentWorkspaces.length > 0 && <div className="recent-workspaces"><span>{copy.recentOpened}</span>{recentWorkspaces.map((path) => <button type="button" key={path} title={path} disabled={workspaceBusy} onClick={() => void openWorkspace(path)}><FolderOpen size={14} /><span className="recent-workspace-text"><b>{path.split("/").filter(Boolean).at(-1) ?? path}</b><small>{path}</small></span></button>)}</div>}{workspaceError && <p className="inline-error" role="alert">{workspaceError}</p>}<div className="dialog-actions"><button type="button" className="outline-button" disabled={workspaceBusy} onClick={() => setWorkspaceDialog(false)}>{copy.cancel}</button><button type="submit" className="primary-button" disabled={!workspacePath.trim() || workspaceBusy}>{workspaceBusy ? <LoaderCircle size={15} className="spinning" /> : <FolderOpen size={15} />}{copy.open}</button></div></form></div>}
    {settingsOpen && <SettingsPage csrf={boot?.csrf ?? ""} onClose={() => setSettingsOpen(false)} onModelsSaved={modelsSaved} />}
    {traceInspectorFocus && <TraceInspector key={boot?.workspacePath} workspace={boot?.workspacePath ?? ""} taskId={selectedTaskId} currentTaskId={boot?.currentTaskId} tasks={tasks} revision={eventRevision} focus={traceInspectorFocus} onClose={() => setTraceInspectorFocus(null)} onOpenTurn={openContextTurn} onOpenFile={(path) => { void openFile(path); }} />}
  </div>;
}

function statusLabel(status: string): string {
  return ({ active: copy.statusActive, paused: copy.statusPaused, completed: copy.statusCompleted, cancelled: copy.statusCancelled, archived: copy.statusArchived, received: copy.statusReceived, processing: copy.statusProcessing, failed: copy.statusFailed, interrupted: copy.stopped } as Record<string, string>)[status] ?? status;
}
function progressLabel(type: string): string {
  return ({ "turn.received": copy.statusReceived, "turn.processing": copy.progressProcessing, "context.build.started": copy.progressBuildingContext, "llm.called": copy.progressCallingModel, "tool.called": copy.progressCallingTool, "tool.completed": copy.progressToolCompleted, "turn.completed": copy.progressFinishing, "turn.failed": copy.progressFailed } as Record<string, string>)[type] ?? formatCopy(copy.progressOther, { type });
}
function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : copy.operationFailed; }
