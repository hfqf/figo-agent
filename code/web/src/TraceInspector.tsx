import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  Activity,
  ArrowLeft,
  Clipboard,
  Download,
  FileDown,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type {
  TraceInspectorDetail,
  TraceInspectorEventPage,
  TraceInspectorEventRow,
} from "../../src/contracts/trace-inspector";
import { request, type Task } from "./api";
import { ResizeHandle } from "./ResizeHandle";
import { TraceInspectorSource } from "./TraceInspectorSource";
import { inspectorCopy as c } from "./i18n";
import {
  COMPACTION_TABS,
  INSPECTOR_TABS,
  IconButton,
  TraceInspectorDetails,
  compactionLabel,
  downloadEvidence,
  observed,
  tabLabel,
  type CompactionTab,
} from "./TraceInspectorDetails";
import {
  LAYOUT_KEY,
  canAppendPage,
  categorySources,
  matchesCategory,
  decodeLayout,
  detailPath,
  exportEvidence,
  initialInspectorState,
  inspectorReducer,
  jsonText,
  listPath,
  redact,
  InspectorRequestGate,
  type InspectorTab,
} from "./trace-inspector-state";
import "./trace-inspector.css";

export interface InspectorFocus {
  key?: string;
  requestId?: string;
  toolCallId?: string;
  turnId?: string;
  tab?: InspectorTab;
}
interface Props {
  workspace: string;
  taskId: string | null;
  currentTaskId?: string | null;
  tasks: Task[];
  revision: number;
  focus?: InspectorFocus;
  onClose(): void;
  onOpenTurn(id: string): void;
  onOpenFile(path: string): void;
}
export function TraceInspector(props: Props) {
  const [taskId, setTaskId] = useState(
    props.taskId ?? props.tasks[0]?.id ?? "",
  );
  const scopeFocus = useRef(props.focus);
  const lastTask = useRef(props.taskId);
  useEffect(() => {
    if (lastTask.current !== props.taskId) {
      lastTask.current = props.taskId;
      scopeFocus.current = undefined;
      setTaskId(props.taskId ?? "");
    }
  }, [props.taskId]);
  const [ratio, setRatio] = useState(() => {
    try {
      return decodeLayout(localStorage.getItem(LAYOUT_KEY));
    } catch {
      return 52;
    }
  });
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ratio }));
    } catch {
      /* 隐私模式下保持当前布局即可。 */
    }
  }, [ratio]);
  return (
    <InspectorScope
      key={`${props.workspace}\u0000${taskId}`}
      {...props}
      taskId={taskId}
      focus={scopeFocus.current}
      setTaskId={(id) => {
        scopeFocus.current = undefined;
        setTaskId(id);
      }}
      ratio={ratio}
      setRatio={setRatio}
      width={width}
    />
  );
}
function InspectorScope({
  workspace,
  taskId,
  currentTaskId,
  tasks,
  revision,
  focus,
  onClose,
  onOpenTurn,
  onOpenFile,
  setTaskId,
  ratio,
  setRatio,
  width,
}: Omit<Props, "taskId"> & {
  taskId: string;
  setTaskId(id: string): void;
  ratio: number;
  setRatio(value: number | ((old: number) => number)): void;
  width: number;
}) {
  const [state, dispatch] = useReducer(
    inspectorReducer,
    initialInspectorState(workspace, taskId),
  );
  const [category, setCategory] = useState("");
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState(
    focus?.requestId ?? focus?.toolCallId ?? focus?.turnId ?? "",
  );
  const [live, setLive] = useState(
    taskId === currentTaskId &&
      tasks.find((item) => item.id === taskId)?.status === "active",
  );
  const [tab, setTab] = useState<InspectorTab>(focus?.tab ?? "overview");
  const [compactionTab, setCompactionTab] = useState<CompactionTab>("process");
  const [detail, setDetail] = useState<{
    key: string;
    value: TraceInspectorDetail;
  } | null>(null);
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [liveTick, setLiveTick] = useState(0);
  const [read, setRead] = useState<{
    reason: "initial" | "more" | "live";
    cursor?: string;
    serial: number;
  }>({ reason: "initial", serial: 0 });
  const [loadedFilter, setLoadedFilter] = useState("");
  const [tailWindow, setTailWindow] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(Boolean(focus?.key));
  const [source, setSource] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    row: TraceInspectorEventRow;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const focusApplied = useRef(false);
  const lastLiveRevision = useRef(revision);
  const filterKey = `${category}\u0000${failed}\u0000${q}`;
  const currentQuery = useRef(filterKey);
  currentQuery.current = filterKey;
  const scrollAfterLoad = useRef(false);
  const listGate = useRef(new InspectorRequestGate());
  const detailGate = useRef(new InspectorRequestGate());
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = document.querySelector<HTMLElement>(
      '[data-testid="trace-inspector"]',
    );
    root?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    if (scrollAfterLoad.current && live && list.current && !loading) {
      list.current.scrollTop = list.current.scrollHeight;
      scrollAfterLoad.current = false;
    }
  }, [state.rows, loading, live]);

  // SSE 只作为变化通知。合并短时间内的通知，再读取服务端事实，绝不据 payload 造行。
  useEffect(() => {
    if (!live || lastLiveRevision.current === revision) return;
    const timer = window.setTimeout(() => {
      lastLiveRevision.current = revision;
      scrollAfterLoad.current = true;
      setRead((old) => ({ reason: "live", serial: old.serial + 1 }));
      setLiveTick((value) => value + 1);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [revision, live]);
  useEffect(() => {
    if (focus?.key && !focusApplied.current) {
      dispatch({
        type: "focus",
        key: focus.key,
        requestId: focus.requestId,
      });
      focusApplied.current = true;
    }
  }, [focus]);

  useEffect(() => {
    let cancelled = false;
    const ticket = listGate.current.begin();
    const currentFilter = filterKey;
    setLoading(true);
    const timer = window.setTimeout(
      () => {
        const url = listPath(taskId, {
          category: categorySources(category),
          failed,
          q,
          cursor: read.reason === "more" ? read.cursor : undefined,
          latest: read.reason === "live",
          limit:
            read.reason === "live"
              ? 500
              : read.reason === "more" && state.rows.length < 500
                ? Math.min(200, 500 - state.rows.length)
                : 200,
        });
        if (!taskId) {
          setLoading(false);
          return;
        }
        void request<TraceInspectorEventPage>(url)
          .then((page) => {
            if (
              cancelled ||
              !listGate.current.current(ticket) ||
              currentQuery.current !== currentFilter
            )
              return;
            const append = canAppendPage(
              read.reason,
              currentFilter,
              loadedFilter,
              state.rows.length,
            );
            // Live 读取服务端最新窗口，避免晚落库的早时间事件被 keyset 尾游标漏掉。
            dispatch({
              type: "page",
              scope: state.scope,
              page: {
                ...page,
                rows: page.events.filter((row) =>
                  matchesCategory(row, category),
                ),
              },
              append,
            });
            setLoadedFilter(currentFilter);
            setTailWindow(read.reason === "live");
            if (!focusApplied.current) {
              const target = focus?.key
                ? page.events.find((row) => row.key === focus.key)
                : focus?.requestId
                  ? page.events.find(
                      (row) => row.refs.requestId === focus.requestId,
                    )
                  : focus?.toolCallId
                    ? page.events.find(
                        (row) => row.refs.toolCallId === focus.toolCallId,
                      )
                    : focus?.turnId
                      ? page.events.find(
                          (row) =>
                            row.turnId === focus.turnId && !row.refs.requestId,
                        )
                      : undefined;
              if (target) {
                dispatch({ type: "select", row: target });
                setMobileDetail(true);
                focusApplied.current = true;
              }
            }
          })
          .catch((reason: unknown) => {
            if (!cancelled && currentQuery.current === currentFilter)
              dispatch({
                type: "error",
                error: reason instanceof Error ? reason.message : c.loadFailed,
              });
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      },
      q ? 220 : 0,
    );
    return () => {
      cancelled = true;
      listGate.current.cancel(ticket);
      window.clearTimeout(timer);
    };
  }, [taskId, filterKey, refresh, read]);

  const detailKey = state.selectedKey
    ? detailPath(
        state.selectedKey,
        tab,
        state.requestId,
        state.compactionEntryId,
      )
    : "";
  const latestDetailKey = useRef(detailKey);
  latestDetailKey.current = detailKey;
  useEffect(() => {
    if (!detailKey) return;
    let cancelled = false;
    const ticket = detailGate.current.begin();
    setDetailLoading(true);
    setDetailError("");
    void request<TraceInspectorDetail>(detailKey)
      .then((value) => {
        if (
          cancelled ||
          !detailGate.current.current(ticket) ||
          latestDetailKey.current !== detailKey
        )
          return;
        setDetail({ key: detailKey, value });
      })
      .catch((reason: unknown) => {
        if (!cancelled && latestDetailKey.current === detailKey)
          setDetailError(
            reason instanceof Error ? reason.message : c.loadFailed,
          );
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
      detailGate.current.cancel(ticket);
    };
  }, [detailKey, refresh, liveTick]);
  const visibleDetail = detail?.key === detailKey ? detail.value : null;
  const selected =
    state.rows.find((row) => row.key === state.selectedKey) ??
    visibleDetail?.row;
  function select(row: TraceInspectorEventRow) {
    dispatch({ type: "select", row });
    setMobileDetail(true);
    setSource(null);
  }
  function setFilter(action: () => void) {
    action();
    setRead((old) => ({ reason: "initial", serial: old.serial + 1 }));
  }
  function chooseRequest(id: string) {
    dispatch({ type: "request", id: id || null });
  }
  function chooseCompaction(id: string) {
    dispatch({ type: "compaction", id: id || null });
  }
  function chooseTool(id: string) {
    dispatch({ type: "focus", key: `tool:${id}` });
    setTab("tool-calls");
    setSource(null);
    setMobileDetail(true);
  }
  function openTurn(id: string) {
    onClose();
    onOpenTurn(id);
  }
  function openFile(path: string) {
    onClose();
    onOpenFile(path);
  }
  async function copyValue(value: unknown, text = false) {
    try {
      await navigator.clipboard.writeText(
        text ? String(redact(value)) : jsonText(value),
      );
      setNotice(c.copied);
    } catch {
      setNotice(c.copyFailed);
    }
    setContextMenu(null);
  }
  function exportRows(format: "json" | "md") {
    try {
      downloadEvidence(
        exportEvidence(
          state.rows,
          state.hasMore || state.truncated,
          format,
          taskId,
        ),
        `${taskId}-events.${format}`,
        format === "md",
      );
      setNotice(c.redacted);
    } catch {
      setNotice(c.exportFailed);
    }
  }
  function keyboard(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (event.key === "Tab") {
      const nodes = [
        ...event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,select,[tabindex="0"],a[href]',
        ),
      ].filter((node) => node.getClientRects().length > 0);
      const first = nodes[0],
        last = nodes.at(-1);
      if (
        first &&
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === event.currentTarget)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      search.current?.focus();
      return;
    }
    if (event.key === "Escape") {
      if (contextMenu) setContextMenu(null);
      else if (source) setSource(null);
      else if (q) setFilter(() => setQ(""));
      else if (mobileDetail && width <= 760) setMobileDetail(false);
      else onClose();
      return;
    }
    if (
      target.closest(
        "input,textarea,select,[contenteditable=true],[role=tablist],.ti-detail",
      )
    )
      return;
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "c" &&
      selected &&
      !window.getSelection()?.toString()
    ) {
      event.preventDefault();
      void copyValue(selected);
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = state.rows.findIndex(
        (row) => row.key === state.selectedKey,
      );
      const next =
        state.rows[
          Math.max(
            0,
            Math.min(
              state.rows.length - 1,
              index + (event.key === "ArrowDown" ? 1 : -1),
            ),
          )
        ];
      if (next) {
        select(next);
        window.requestAnimationFrame(() =>
          list.current
            ?.querySelector<HTMLElement>(`[data-selected="true"]`)
            ?.scrollIntoView({ block: "nearest" }),
        );
      }
    }
    if (event.key === "Enter" && selected) {
      event.preventDefault();
      setMobileDetail(true);
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="ti-detail"] [role="tab"][aria-selected="true"]',
        )
        ?.focus();
    }
  }
  function tabKeys(
    event: KeyboardEvent,
    values: readonly string[],
    current: string,
    change: (value: string) => void,
  ) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? values.length - 1
          : (values.indexOf(current) +
              (event.key === "ArrowRight" ? 1 : -1) +
              values.length) %
            values.length;
    change(values[index]);
    (event.currentTarget as HTMLElement)
      .querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [index]?.focus();
  }
  const sourceMessage = visibleDetail?.messages.find(
    (message) => message.sourceRef === source,
  );
  const sourceItem = visibleDetail?.context.items.find(
    (item) => item.sourceRef === source || item.source_ref === source,
  );

  return (
    <div
      data-testid="trace-inspector"
      role="dialog"
      aria-modal="true"
      aria-label={c.title}
      className={`trace-inspector ti-root ${mobileDetail ? "ti-mobile-detail" : ""}`}
      style={{ "--ti-list-ratio": `${ratio}%` } as CSSProperties}
      onKeyDown={keyboard}
      tabIndex={-1}
      onClick={() => contextMenu && setContextMenu(null)}
    >
      <header className="ti-header">
        <IconButton label={c.back} onClick={onClose}>
          <ArrowLeft size={18} />
        </IconButton>
        <Activity size={18} />
        <strong>{c.title}</strong>
        <span className="ti-spacer" />
        <small>{workspace}</small>
      </header>
      <div className="ti-toolbar">
        <label className="ti-task-select">
          <span>{c.task}</span>
          <select
            aria-label={c.task}
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
          >
            {!taskId && <option value="">{c.unknown}</option>}
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title} · {task.id}
              </option>
            ))}
          </select>
        </label>
        <label className="ti-toggle">
          <input
            type="checkbox"
            checked={live}
            onChange={(event) => {
              lastLiveRevision.current = -1;
              setLive(event.target.checked);
            }}
          />
          {c.live}
        </label>
        <label className="ti-toggle">
          <input
            type="checkbox"
            checked={failed}
            onChange={(event) =>
              setFilter(() => setFailed(event.target.checked))
            }
          />
          {c.failed}
        </label>
        <select
          aria-label={c.kind}
          value={category}
          onChange={(event) => setFilter(() => setCategory(event.target.value))}
        >
          {[
            ["", c.all],
            ["llm", c.llm],
            ["tool", c.tool],
            ["context", c.context],
            ["compaction", c.compaction],
            ["trace", c.events],
          ].map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <div className="ti-search">
          <Search size={15} />
          <input
            ref={search}
            aria-label={c.search}
            placeholder={c.search}
            value={q}
            onChange={(event) => setFilter(() => setQ(event.target.value))}
          />
          {q && (
            <IconButton
              label={c.close}
              onClick={() => setFilter(() => setQ(""))}
            >
              <X size={14} />
            </IconButton>
          )}
        </div>
        <IconButton
          label={c.refresh}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={16} />
        </IconButton>
        <IconButton label={c.exportJson} onClick={() => exportRows("json")}>
          <Download size={16} />
        </IconButton>
        <IconButton label={c.exportMarkdown} onClick={() => exportRows("md")}>
          <FileDown size={16} />
        </IconButton>
      </div>
      <div className="ti-body">
        <section className="ti-list">
          <div
            className="ti-list-scroll"
            ref={list}
            onWheel={() => setLive(false)}
            onTouchMove={() => setLive(false)}
            onScroll={(event) => {
              const node = event.currentTarget;
              if (
                node.scrollHeight - node.clientHeight - node.scrollTop > 90 &&
                !loading
              )
                setLive(false);
            }}
          >
            <table
              data-testid="ti-event-table"
              className="ti-event-table"
              aria-label={c.events}
            >
              <thead>
                <tr>
                  {[
                    "#",
                    c.time,
                    c.kind,
                    c.status,
                    c.task,
                    c.turn,
                    c.source,
                    c.name,
                    c.duration,
                    c.tokens,
                  ].map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.rows.map((row, index) => (
                  <tr
                    key={row.key}
                    data-event-key={row.key}
                    data-selected={state.selectedKey === row.key}
                    aria-selected={state.selectedKey === row.key}
                    tabIndex={
                      state.selectedKey === row.key ||
                      (!state.selectedKey && index === 0)
                        ? 0
                        : -1
                    }
                    onClick={() => select(row)}
                    onDoubleClick={() =>
                      row.turnId ? openTurn(row.turnId) : select(row)
                    }
                    onContextMenu={(event) => {
                      event.preventDefault();
                      select(row);
                      setContextMenu({
                        x: Math.min(event.clientX, width - 220),
                        y: Math.min(event.clientY, window.innerHeight - 190),
                        row,
                      });
                    }}
                  >
                    <td>{index + 1}</td>
                    <td title={row.time}>{row.time.slice(11)}</td>
                    <td title={row.kind}>{row.kind}</td>
                    <td>
                      <span className={`ti-status ti-${row.status}`}>
                        {
                          {
                            ok: c.ok,
                            info: c.info,
                            skipped: c.skipped,
                            denied: c.denied,
                            error: c.errorStatus,
                            interrupted: c.interrupted,
                            unknown: c.unknown,
                          }[row.status]
                        }
                      </span>
                    </td>
                    <td title={row.taskId ?? ""}>{row.taskId?.slice(0, 10)}</td>
                    <td title={row.turnId ?? ""}>
                      {row.turnSeq ?? row.turnId?.slice(0, 8) ?? c.unknown}
                    </td>
                    <td title={row.source}>{row.source}</td>
                    <td title={row.name}>{row.name}</td>
                    <td>
                      {row.durationMs === null
                        ? c.unknown
                        : `${row.durationMs} ms`}
                    </td>
                    <td title={observed(row.tokens)}>{observed(row.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!state.rows.length && !loading && (
              <p className="ti-empty">{c.empty}</p>
            )}
          </div>
          {state.error && (
            <div className="ti-error" role="alert">
              <span>{state.error}</span>
              <button onClick={() => setRefresh((value) => value + 1)}>
                {c.retry}
              </button>
            </div>
          )}
          <div className="ti-pagination">
            <span>
              {tailWindow ? c.tailScope : c.loadedScope} · {state.rows.length}
            </span>
            {state.rows.length >= 500 && <small>{c.limit}</small>}
            {tailWindow && (
              <button
                onClick={() => {
                  setLive(false);
                  setRead((old) => ({
                    reason: "initial",
                    serial: old.serial + 1,
                  }));
                }}
              >
                {c.historyStart}
              </button>
            )}
            {loading && <small role="status">{c.loading}</small>}
            {state.hasMore && state.nextCursor && !tailWindow && (
              <button
                disabled={loading}
                onClick={() => {
                  if (state.nextCursor) {
                    setLive(false);
                    setRead((old) => ({
                      reason: "more",
                      cursor: state.nextCursor!,
                      serial: old.serial + 1,
                    }));
                  }
                }}
              >
                {state.rows.length < 500 ? c.more : c.nextPage}
              </button>
            )}
          </div>
        </section>
        <ResizeHandle
          boundary="task"
          label={c.split}
          value={Math.round((width * ratio) / 100)}
          min={Math.round(width * 0.25)}
          max={Math.round(width * 0.75)}
          onDelta={(_, delta) =>
            setRatio((value) =>
              Math.max(25, Math.min(75, value + (delta / width) * 100)),
            )
          }
          onReset={() => setRatio(52)}
        />
        <section className="ti-detail" data-testid="ti-detail">
          <div className="ti-mobile-back">
            <button onClick={() => setMobileDetail(false)}>
              <ArrowLeft size={15} />
              {c.backList}
            </button>
          </div>
          <nav
            className="ti-tabs"
            role="tablist"
            aria-label={c.primaryTabs}
            onKeyDown={(event) =>
              tabKeys(event, INSPECTOR_TABS, tab, (value) =>
                setTab(value as InspectorTab),
              )
            }
          >
            {INSPECTOR_TABS.map((value) => (
              <button
                id={`ti-tab-${value}`}
                aria-controls="ti-tabpanel"
                tabIndex={tab === value ? 0 : -1}
                role="tab"
                key={value}
                aria-selected={tab === value}
                onClick={() => setTab(value)}
              >
                {tabLabel(value)}
              </button>
            ))}
          </nav>
          <div className="ti-selection">
            <label>
              <span>{c.requestSelection}</span>
              <select
                aria-label={c.requestSelection}
                value={
                  state.requestId ?? visibleDetail?.selection.requestId ?? ""
                }
                onChange={(event) => chooseRequest(event.target.value)}
              >
                <option value="">{c.selectRequest}</option>
                {state.requestId &&
                  !visibleDetail?.captures.some(
                    (item) => item.requestId === state.requestId,
                  ) && (
                    <option value={state.requestId}>{state.requestId}</option>
                  )}
                {visibleDetail?.captures.map((item) => (
                  <option key={item.id} value={item.requestId}>
                    {item.requestId} · {item.purpose} · {item.responseStatus}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{c.entrySelection}</span>
              <select
                aria-label={c.entrySelection}
                value={
                  state.compactionEntryId ??
                  visibleDetail?.selection.compactionEntryId ??
                  ""
                }
                onChange={(event) => chooseCompaction(event.target.value)}
              >
                <option value="">{c.selectEntry}</option>
                {state.compactionEntryId &&
                  !visibleDetail?.compactions.some(
                    (item) => item.id === state.compactionEntryId,
                  ) && (
                    <option value={state.compactionEntryId}>
                      {state.compactionEntryId}
                    </option>
                  )}
                {visibleDetail?.compactions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.seq} · {item.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {tab === "compaction" && (
            <nav
              className="ti-tabs ti-subtabs"
              role="tablist"
              aria-label={c.compactionTabs}
              onKeyDown={(event) =>
                tabKeys(event, COMPACTION_TABS, compactionTab, (value) =>
                  setCompactionTab(value as CompactionTab),
                )
              }
            >
              {COMPACTION_TABS.map((value) => (
                <button
                  key={value}
                  role="tab"
                  aria-selected={compactionTab === value}
                  tabIndex={compactionTab === value ? 0 : -1}
                  onClick={() => setCompactionTab(value)}
                >
                  {compactionLabel(value)}
                </button>
              ))}
            </nav>
          )}
          <div
            id="ti-tabpanel"
            role="tabpanel"
            aria-labelledby={`ti-tab-${tab}`}
            className="ti-detail-scroll"
            aria-busy={detailLoading}
          >
            {detailError && (
              <div className="ti-error" role="alert">
                <span>{detailError}</span>
                <button onClick={() => setRefresh((value) => value + 1)}>
                  {c.retry}
                </button>
              </div>
            )}
            {visibleDetail ? (
              <TraceInspectorDetails
                key={detailKey}
                detail={visibleDetail}
                tab={tab}
                requestId={state.requestId ?? visibleDetail.selection.requestId}
                compactionEntryId={
                  state.compactionEntryId ??
                  visibleDetail.selection.compactionEntryId
                }
                compactionTab={compactionTab}
                onRequest={chooseRequest}
                onCompaction={chooseCompaction}
                onSource={setSource}
                onTool={chooseTool}
                onOpenFile={openFile}
                onOpenTurn={openTurn}
              />
            ) : (
              <p className="ti-empty">
                {detailLoading ? c.loading : c.selectEvent}
              </p>
            )}
          </div>
        </section>
      </div>
      <footer className="ti-footer">
        <span className={live ? "ti-live-dot" : ""}>
          {live ? c.live : c.recordedScope}
        </span>
        <span>
          {state.hasMore || state.truncated ? c.truncated : c.complete}
        </span>
        <span>{c.redacted}</span>
        <span role="status">{notice}</span>
      </footer>
      {source && (
        <TraceInspectorSource
          key={source}
          source={source}
          snapshot={sourceMessage ?? sourceItem ?? null}
          file={Boolean(
            sourceItem &&
              (sourceItem.sourceType === "file_reference" ||
                sourceItem.source_type === "file_reference"),
          )}
          truncated={visibleDetail?.truncated ?? true}
          onClose={() => setSource(null)}
        />
      )}
      {contextMenu && (
        <div
          className="ti-context-menu"
          role="menu"
          style={{
            left: Math.max(0, contextMenu.x),
            top: Math.max(0, contextMenu.y),
          }}
        >
          <button
            role="menuitem"
            onClick={() => void copyValue(contextMenu.row.key, true)}
          >
            {c.copyId}
          </button>
          <button
            role="menuitem"
            onClick={() => void copyValue(contextMenu.row)}
          >
            <Clipboard size={14} />
            {c.copyRow}
          </button>
          <button
            role="menuitem"
            disabled={!visibleDetail}
            onClick={() => void copyValue(visibleDetail)}
          >
            {c.copy}
          </button>
          <button
            role="menuitem"
            disabled={!contextMenu.row.turnId}
            onClick={() => {
              if (contextMenu.row.turnId) openTurn(contextMenu.row.turnId);
            }}
          >
            {c.openTurn}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setTab("overview");
              setContextMenu(null);
            }}
          >
            {c.locate}
          </button>
        </div>
      )}
    </div>
  );
}
