export type SessionStatus = "active" | "ended" | "failed";
export type TaskStatus = "active" | "paused" | "completed" | "cancelled" | "archived";
export type TurnStatus = "received" | "processing" | "completed" | "failed" | "interrupted";

export interface Session {
  id: string;
  cwd: string;
  status: SessionStatus;
  startedAt: string;
  endedAt?: string;
}

export interface Task {
  id: string;
  sessionId: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  pausedAt?: string;
  resumedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  archivedAt?: string;
  closeReason?: string;
}

export interface Turn {
  id: string;
  sessionId: string;
  taskId: string;
  input: string;
  status: TurnStatus;
  createdAt: string;
  completedAt?: string;
  fileReferences?: ContextFileReference[];
}

export interface ModelSelection { providerId: string; modelId: string }

export interface ContextFileReference {
  path: string;
  startLine: number;
  endLine: number;
  version: string;
  content: string;
}

export type TraceEventType =
  | "session.started"
  | "session.ended"
  | "session.failed"
  | "task.created"
  | "task.switched"
  | "task.active"
  | "task.paused"
  | "task.resumed"
  | "task.finish.requested"
  | "task.completed"
  | "task.cancel.requested"
  | "task.cancelled"
  | "task.summary.created"
  | "task.command.rejected"
  | "task.history.loaded"
  | "turn.received"
  | "turn.processing"
  | "turn.completed"
  | "turn.failed"
  | "turn.interrupted"
  | "context.build.started"
  | "context.item.candidate"
  | "context.item.included"
  | "context.item.excluded"
  | "context.build.completed"
  | "context.messages.appended"
  | "context.messages.omitted"
  | "prompt.config.applied"
  | "compaction.requested"
  | "compaction.started"
  | "compaction.completed"
  | "compaction.skipped"
  | "compaction.failed"
  | "memory.search.started"
  | "memory.search.completed"
  | "plugin.registered"
  | "plugin.ready"
  | "plugin.failed"
  | "capability.registered"
  | "capability.lookup.failed"
  | "skill.activated"
  | "skill.skipped"
  | "skill.completed"
  | "skill.failed"
  | "tool.called"
  | "tool.completed"
  | "tool.failed"
  | "tool.denied"
  | "tool_call.parse.started"
  | "tool_call.parse.completed"
  | "tool_call.parse.failed"
  | "tool_call.repair.requested"
  | "tool_call.no_progress"
  | "tool_call.round.started"
  | "tool_call.round.completed"
  | "tool_call.result.appended"
  | "policy.evaluated"
  | "policy.denied"
  | "llm.called"
  | "llm.completed"
  | "llm.failed"
  | "artifact.created"
  | "error.occurred";

export interface TraceEvent {
  id: string;
  sessionId: string;
  taskId?: string;
  turnId?: string;
  type: TraceEventType;
  source: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Artifact {
  id: string;
  sessionId: string;
  taskId?: string;
  turnId?: string;
  type: "context" | "report" | "memory" | "trace" | "task-summary";
  path: string;
  bytes: number;
  createdAt: string;
}

export interface ContextItem {
  id: string;
  sourceType: string;
  sourceRef: string;
  summary: string;
  content: string;
  estimatedTokens: number;
  included: boolean;
  reason: string;
}

export interface ContextPack {
  id: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  items: ContextItem[];
  estimatedTokens: number;
  createdAt: string;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: LLMToolCall[];
  toolCallId?: string;
}

export interface LLMToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface LLMRequest {
  id: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  contextPackId?: string;
  usageTurnId?: string | null;
  messages: LLMMessage[];
  availableTools?: LLMToolDefinition[];
  model: string;
  purpose?: "turn" | "task_compaction" | "round_compaction";
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  signal?: AbortSignal;
}

export interface LLMUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface LLMResponse {
  id: string;
  requestId: string;
  content: string;
  model: string;
  finishReason: "stop" | "length" | "error" | "tool_calls";
  toolCalls?: LLMToolCall[];
  usage?: LLMUsage;
  outputLength: number;
  durationMs: number;
}

export interface LLMProvider {
  toolCallingMode?: "text" | "native";
  complete(request: LLMRequest, onTextDelta?: (delta: string) => void): Promise<LLMResponse>;
}

export type PolicyAction =
  | "tool.list_files"
  | "tool.read_file"
  | "tool.search_text"
  | "tool.system_info"
  | "tool.path_stat"
  | "tool.read_many_files"
  | "tool.workspace_summary"
  | "tool.write_file"
  | "tool.apply_patch"
  | "tool.run_command"
  | "tool.git"
  | "tool.git_status"
  | "tool.git_diff"
  | "tool.git_log"
  | "tool.git_add"
  | "tool.git_commit"
  | "tool.network"
  | "tool.network_fetch"
  | "tool.browser_open"
  | "tool.browser_snapshot"
  | "tool.browser";

export interface PolicyRequest {
  sessionId: string;
  taskId: string;
  turnId: string;
  action: PolicyAction;
  resource: string;
  metadata: Record<string, unknown>;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  code:
    | "allowed"
    | "tool_not_allowed"
    | "path_outside_workspace"
    | "read_limit_exceeded"
    | "result_limit_exceeded"
    | "action_not_supported";
}

export interface Policy {
  evaluate(request: PolicyRequest): Promise<PolicyDecision>;
}

export interface ToolExecutionContext {
  sessionId: string;
  taskId: string;
  turnId: string;
  workspaceRoot: string;
  intentId?: string;
  round?: number;
  signal?: AbortSignal;
}

export type ToolResult<TOutput = unknown> =
  | {
      status: "completed";
      output: TOutput;
    }
  | {
      status: "failed";
      errorMessage: string;
      errorCode: string;
    };

export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult<TOutput>>;
}

export interface SkillRunResult {
  status: "completed" | "failed" | "skipped";
  message: string;
  artifacts: Artifact[];
}

export interface TurnResult {
  sessionId: string;
  taskId: string;
  turnId: string;
  status: "completed" | "failed";
  message: string;
  artifacts: Artifact[];
  error?: { code: string; message: string };
}

export interface CommandResult {
  status: "completed" | "failed";
  message: string;
  artifacts: Artifact[];
  error?: { code: string; message: string };
}
