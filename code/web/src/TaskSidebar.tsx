import { useEffect, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, History, LoaderCircle, MessageSquareText, MoreHorizontal, RefreshCw, Search, Settings2, SquarePen, X } from "lucide-react";
import type { TaskListItem, TaskListPage } from "../../src/contracts/task-list.js";
import { defaultTaskListSettings, type TaskListSettings } from "../../src/config/task-list-settings.js";
import { request, type SessionSummary, type Task } from "./api";
import { copy, formatCopy } from "./i18n";
import { relativeTaskTime, taskListPath } from "./task-sidebar-state";
import "./task-sidebar.css";

interface Props {
  workspace: string;
  currentSessionId: string;
  selectedTaskId: string | null;
  selectedSessionId: string | null;
  sessions: SessionSummary[];
  historyOpen: boolean;
  mode: "recent" | "all";
  visible: boolean;
  busy: boolean;
  revision: number;
  settings?: TaskListSettings;
  onMode(mode: "recent" | "all"): void;
  onHistory(): void;
  onSession(sessionId: string): void;
  onSettings(): void;
  onNew(): void;
  onOpen(task: TaskListItem): void;
  onAction(task: Task, action: string): void;
}

type TaskAction = "switch" | "pause" | "resume" | "finish" | "cancel" | "compact";
const actionNames: Record<TaskAction, string> = { switch: copy.actionSwitch, pause: copy.actionPause,
  resume: copy.actionResume, finish: copy.actionFinish, cancel: copy.actionCancel, compact: copy.actionCompact };

export function TaskSidebar(props: Props) {
  const settings = props.settings ?? defaultTaskListSettings;
  const [data, setData] = useState<TaskListPage | null>(null);
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);

  useEffect(() => {
    if (input === q) return;
    const timer = window.setTimeout(() => { setQ(input); setPage(1); }, settings.searchDebounceMs);
    return () => window.clearTimeout(timer);
  }, [input, q, settings.searchDebounceMs]);

  useEffect(() => {
    if (!props.visible) return;
    let cancelled = false;
    setLoading(true); setError(""); setData(null);
    void request<TaskListPage>(taskListPath({ mode: props.mode, page, q }, settings))
      .then((result) => {
        if (cancelled) return;
        setData(result);
        if (result.page > 0 && result.page !== page) setPage(result.page);
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : copy.taskListLoadFailed); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.workspace, props.mode, props.visible, props.revision, page, q, retry, settings]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => { if (!(event.target as Element)?.closest(".task-menu, .task-more")) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [menu]);

  function changeMode(mode: "recent" | "all") {
    setPage(1); setInput(""); setQ(""); setMenu(null); props.onMode(mode);
  }

  return <aside className="sidebar-pane task-panel-list task-sidebar" aria-label={copy.tasks}>
    <div className="sidebar-section-title task-heading"><strong>{copy.tasks}</strong><div className="inline-actions">
      <button className={`plain-icon ${props.historyOpen ? "active" : ""}`} title={copy.historicalSession} aria-label={copy.historicalSession} aria-expanded={props.historyOpen} onClick={props.onHistory}><History size={19} /></button>
      <button className="plain-icon" title={copy.settingsTitle} aria-label={copy.taskListSettings} onClick={props.onSettings}><Settings2 size={19} /></button>
      <button className="plain-icon" title={copy.newTaskShort} aria-label={copy.newTaskShort} disabled={props.busy} onClick={props.onNew}><SquarePen size={19} /></button>
    </div></div>
    {props.historyOpen && <div className="session-list task-session-list" aria-label={copy.historicalSession}>
      {props.sessions.map((session) => <button key={session.id} title={session.title || copy.untitledSession} className={props.selectedSessionId === session.id ? "selected" : ""} onClick={() => props.onSession(session.id)}>
        <span className="truncate">{session.title || copy.untitledSession}</span><small>{formatCopy(copy.turnCount, { count: session.turnCount })}</small>
      </button>)}
    </div>}
    {props.mode === "all" && <div className="task-list-tools">
      <button className="plain-icon" title={copy.taskListRecent} aria-label={copy.taskListRecent} onClick={() => changeMode("recent")}><ArrowLeft size={17} /></button>
      <label className="task-search"><Search size={15} /><input aria-label={copy.taskListSearch} placeholder={copy.taskListSearch} value={input} maxLength={settings.searchMaxChars} onChange={(event) => setInput(event.target.value)} />{input && <button type="button" className="plain-icon" title={copy.close} aria-label={copy.close} onClick={() => setInput("")}><X size={13} /></button>}</label>
    </div>}
    <div className="task-list" aria-busy={loading}>
      {loading && <div className="task-list-state" role="status"><LoaderCircle size={17} className="spinning" />{copy.taskListLoading}</div>}
      {error && <div className="task-list-state" role="alert"><span>{error}</span><button className="plain-icon" title={copy.taskListRetry} aria-label={copy.taskListRetry} onClick={() => setRetry((value) => value + 1)}><RefreshCw size={17} /></button></div>}
      {!loading && !error && data?.tasks.length === 0 && <div className="task-list-state task-list-empty"><MessageSquareText size={30} /><span>{q ? copy.taskListNoResults : copy.taskListEmpty}</span></div>}
      {!loading && !error && data?.tasks.map((task) => {
        const actions: TaskAction[] = task.sessionId !== props.currentSessionId || task.id.startsWith("legacy_") ? []
          : task.status === "active" ? ["switch", "pause", "finish", "cancel", "compact"] : task.status === "paused" ? ["resume"] : [];
        const title = task.displayTitle || task.title;
        return <div className={`task-row ${props.selectedTaskId === task.id ? "selected" : ""} ${actions.length ? "has-actions" : ""}`} key={task.id}>
          <button className="task-select" aria-label={title} aria-current={props.selectedTaskId === task.id ? "true" : undefined} title={`${title}\n${formatCopy(copy.taskListSession, { title: task.sessionTitle })}`} onClick={() => { setMenu(null); props.onOpen(task); }}>
            <span className="task-title truncate">{title}</span>
          </button>
          <time className="task-age" dateTime={task.updatedAt.replace(" ", "T") + "+08:00"} title={task.updatedAt}>{relativeTaskTime(task.updatedAt)}</time>
          {actions.length > 0 && <button className="plain-icon task-more" title={formatCopy(copy.taskActions, { name: title })} aria-label={formatCopy(copy.taskActions, { name: title })} aria-expanded={menu === task.id} aria-haspopup="menu" onClick={() => setMenu(menu === task.id ? null : task.id)}><MoreHorizontal size={17} /></button>}
          {menu === task.id && <div className="task-menu" role="menu">{actions.map((action) => <button role="menuitem" disabled={props.busy} key={action} onClick={() => { setMenu(null); props.onAction(task, action); }}>{actionNames[action]}</button>)}</div>}
        </div>;
      })}
      {props.mode === "recent" && data && !loading && !error && data.totalCount > 0 && <button className="task-view-all" onClick={() => changeMode("all")}>{formatCopy(copy.taskListViewAll, { count: data.totalCount })}</button>}
    </div>
    {props.mode === "all" && data && !loading && !error && <footer className="task-list-pagination">
      <span>{formatCopy(copy.taskListSummary, { count: data.totalCount })}<small>{formatCopy(copy.taskListPages, { page: data.page, pages: data.totalPages })}</small></span>
      <button className="plain-icon" title={copy.taskListPrevious} aria-label={copy.taskListPrevious} disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}><ChevronLeft size={17} /></button>
      <button className="plain-icon" title={copy.taskListNext} aria-label={copy.taskListNext} disabled={data.page >= data.totalPages} onClick={() => setPage(data.page + 1)}><ChevronRight size={17} /></button>
    </footer>}
  </aside>;
}
