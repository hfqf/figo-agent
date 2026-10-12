export interface Task {
  id: string;
  sessionId: string;
  title: string;
  status: string;
  turnCount: number;
  updatedAt: string;
}

export interface Turn {
  id: string;
  sessionId: string;
  taskId: string | null;
  taskSeq: number | null;
  input: string;
  output: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export interface Bootstrap {
  fileBrowser: { searchMinChars: number; searchMaxChars: number; maxDirectoryEntries: number; maxPreviewBytes: number };
  terminal: { maxCommandChars: number };
  workspace: string;
  workspacePath: string;
  branch: string;
  model: string;
  sessionId: string;
  tasks: Task[];
  currentTaskId: string | null;
  eventCursor: number;
  csrf: string;
  activeRun: UiRun | null;
}

export interface FileEntry { name: string; path: string; kind: "file" | "directory" }
export interface FilePreview {
  path: string;
  content: string | null;
  size: number;
  lineCount: number;
  version: string | null;
  tooLarge: boolean;
}
export interface FileReference { path: string; startLine: number; endLine: number; version: string }
export interface UiRun { runId: string; turnId: string; taskId: string; status: string; errorMessage?: string }
export interface UsageSummary {
  requestCount: number;
  unavailableCount: number;
  partialCount: number;
  knownTotalTokens: number;
  totalReportedCount: number;
}
export interface ToolCall {
  id: string;
  turnId: string;
  intentId: string | null;
  round: number | null;
  name: string;
  status: string;
  input: unknown;
  output: unknown;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ContextItem {
  id: string; sourceType: string; sourceRef: string; summary: string; content: string;
  estimatedTokens: number; included: boolean; reason: string;
  originTurn: { id: string; taskSeq: number | null; inputPreview: string; createdAt: string } | null;
}
export interface ContextView {
  pack: { id: string; turnId: string; estimatedTokens: number; createdAt: string } | null;
  items: ContextItem[];
  checkpoint: { id: string; fromSeq: number; throughSeq: number; sourceTurnIds: string[] } | null;
}
export interface Capture {
  id: string; requestId: string; purpose: string; provider: string; model: string;
  method: string; url: string; durationMs: number; createdAt: string;
  responseStatus: number; responseStatusText: string;
  requestHeaders: unknown; requestBody: unknown; responseHeaders: unknown; responseBody: unknown;
  usage: { status: string; promptTokens: number | null; completionTokens: number | null; totalTokens: number | null };
}
export interface TraceEvent {
  id: string; type: string; source: string; createdAt: string; payload: Record<string, unknown>;
  sessionId: string; taskId: string | null; turnId: string;
}
export interface UiEvent { seq: number; eventId: string; kind: string; taskId?: string; turnId?: string; createdAt: string; payload: Record<string, unknown> }
export interface TerminalEntry { id: string; command: string; cwd: string; output: string; status: "running" | "completed" | "failed" | "stopped"; exitCode: number | null; truncated: boolean }
export interface TerminalSnapshot { cwd: string; entries: TerminalEntry[] }

export async function request<T>(path: string, options: { method?: string; body?: unknown; csrf?: string } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.csrf ? { "X-Figo-CSRF": options.csrf } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

export function timeOf(value?: string | null): string {
  if (!value) return "";
  return value.slice(11, 16);
}

export function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 12)}...${value.slice(-5)}` : value;
}
