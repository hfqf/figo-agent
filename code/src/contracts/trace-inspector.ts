import type { InspectorFieldReference } from "./trace-inspector-field.js";
/** 只读检查器的 JSON 契约；关联表示证据强度，不表示模型思维链。 */
export type TraceInspectorCategory = "trace" | "capture" | "tool" | "context" | "compaction" | "legacy-compaction" | "message" | "ui";
export type InspectorJson = null | boolean | number | string | InspectorJson[] | { [key: string]: InspectorJson };
export type InspectorObject = { [key: string]: InspectorJson };
export type InspectorRelation = "direct" | "scope_only" | "unknown";
export interface ObservedNumber {
  value: number | null;
  kind: "provider_actual" | "estimate" | "usage_plus_estimate" | "count" | "unknown";
  availability: "recorded" | "unavailable";
}
export interface TraceInspectorEventRow {
  key: string;
  category: TraceInspectorCategory;
  time: string;
  kind: string;
  status: "ok" | "info" | "skipped" | "denied" | "error" | "interrupted" | "unknown";
  sessionId: string | null;
  taskId: string | null;
  turnId: string | null;
  turnSeq: number | null;
  source: string;
  name: string;
  durationMs: number | null;
  durationState?: "recorded" | "not_applicable" | "pending" | "not_recorded";
  tokens: ObservedNumber | null;
  tokenState?: "recorded" | "not_applicable" | "pending" | "provider_unavailable" | "not_recorded";
  refs: {
    traceEventId?: string;
    requestId?: string;
    captureId?: string;
    toolCallId?: string;
    intentId?: string;
    contextPackId?: string;
    compactionEntryId?: string;
    legacyCheckpointId?: string;
    sourceRef?: string;
    compactionAttemptId?: string;
  };
}
export interface TraceInspectorListOptions {
  limit?: number;
  /** 正整数页码；不能与 cursor 或 latest=true 混用。 */
  page?: number;
  group?: "llm" | "tool" | "context" | "compaction";
  cursor?: string;
  category?: TraceInspectorCategory | TraceInspectorCategory[];
  failed?: boolean;
  q?: string;
  /** Live 使用最近窗口快照；不能与 cursor 混用。 */
  latest?: boolean;
}
export interface TraceInspectorEventPage {
  events: TraceInspectorEventRow[];
  nextCursor: string | null;
  /** 当前正序页最后一行的游标。Live 使用 latest 快照，不能仅靠它捕获迟落库记录。 */
  endCursor: string | null;
  hasMore: boolean;
  /** 包括仍有后续页或字段被限制，不代表当前页是完整 Task。 */
  truncated: boolean;
  pagination?: {
    totalCount: number;
    page: number | null;
    totalPages: number | null;
    pageSize: number;
    from: number | null;
    to: number | null;
  };
}
export type InspectorEventRow = TraceInspectorEventRow;
export interface TraceInspectorDetailSelection {
  requestId?: string;
  compactionEntryId?: string;
}
export interface TraceInspectorSelection {
  taskId: string | null;
  turnId: string | null;
  requestId: string | null;
  requestAssociation: "direct" | "selected" | "unknown";
  compactionEntryId: string | null;
  compactionAttemptId: string | null;
  recoveryOfRequestId: string | null;
  contextPackId: string | null;
  projection: {
    status: "recorded" | "unknown";
    compactionEntryId: string | null;
    legacyCheckpointId?: string | null;
    sourceRefs: string[];
    usageScope: string | null;
  };
}
export interface TraceInspectorCapture {
  id: string;
  requestId: string;
  taskId: string | null;
  turnId: string | null;
  purpose: string;
  provider: string;
  model: string;
  url: string;
  method: string;
  requestHeaders: InspectorJson;
  requestBody: InspectorJson;
  responseStatus: number;
  responseStatusText: string;
  responseHeaders: InspectorJson;
  responseBody: InspectorJson;
  durationMs: number;
  createdAt: string;
  usage: { status: string; promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; usageTurnId: string | null };
  relation: InspectorRelation;
}
export interface TraceInspectorMessage {
  sourceRef: string;
  turnId: string;
  message: InspectorJson;
  usage: InspectorJson;
  usageScope: string | null;
  stopReason: string | null;
  /** 当前持久化标记，不用于倒推历史请求是否省略。 */
  omitted: boolean;
  state: "raw" | "covered" | "unknown";
  stateScope: "selected_request" | "current_record";
  toolRowIds: string[];
  relation: InspectorRelation;
  createdAt: string;
}
export interface TraceInspectorCompaction {
  id: string;
  taskId: string;
  seq: number;
  baseEntryId: string | null;
  firstKeptSourceRef: string;
  coveredSourceRefs: string[];
  summaryMarkdown: string | InspectorFieldReference;
  details: InspectorJson;
  requestId: string;
  requestIds: string[];
  createdAt: string;
  commitStatus: "committed";
  completionEventStatus: "recorded" | "missing" | "unknown";
  tokensBefore: ObservedNumber;
  tokensAfter: ObservedNumber;
  relation: InspectorRelation;
}
export interface TraceInspectorDetail {
  row: TraceInspectorEventRow;
  /** 原始选中对象，JSON 列解析后脱敏，过长字段以预览替代。 */
  record: InspectorObject;
  events: Array<{ id: string; type: string; source: string; turnId: string | null; payload: InspectorJson; createdAt: string; relation: InspectorRelation }>;
  /** 构建快照，与 selection.projection 和抓包实际消息分开。 */
  context: { pack: InspectorObject | null; items: InspectorObject[]; checkpoint: InspectorObject | null };
  captures: TraceInspectorCapture[];
  tools: Array<{ id: string; intentId: string | null; turnId: string; name: string; round: number | null; status: string; input: InspectorJson; output: InspectorJson; errorMessage: string | InspectorFieldReference | null; startedAt: string; completedAt: string | null; durationMs?: number | null; durationState?: TraceInspectorEventRow["durationState"]; relation: InspectorRelation }>;
  messages: TraceInspectorMessage[];
  compactions: TraceInspectorCompaction[];
  legacyCheckpoints: Array<{ id: string; taskId: string; baseCheckpointId: string | null; fromSeq: number; throughSeq: number; sourceTurnIds: string[]; summaryJson: InspectorJson; requestId: string; createdAt: string; relation: InspectorRelation }>;
  artifacts: InspectorObject[];
  selection: TraceInspectorSelection;
  limitations: string[];
  truncated: boolean;
}
