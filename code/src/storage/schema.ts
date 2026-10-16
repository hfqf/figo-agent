export const schemaSql = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT,
  input TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paused_at TEXT,
  resumed_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  archived_at TEXT,
  close_reason TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS context_packs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT,
  turn_id TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_items (
  id TEXT PRIMARY KEY,
  context_pack_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  included INTEGER NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_records (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  intent_id TEXT,
  round INTEGER,
  skill_run_id TEXT,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS trace_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT,
  turn_id TEXT,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT,
  turn_id TEXT,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_http_captures (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT,
  turn_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  request_body_json TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_status_text TEXT NOT NULL,
  response_headers_json TEXT NOT NULL,
  response_body_json TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS token_usage (
  capture_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  task_id TEXT,
  turn_id TEXT NOT NULL,
  usage_turn_id TEXT,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  status TEXT NOT NULL CHECK(status IN ('complete', 'partial', 'unavailable')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_compaction_checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  base_checkpoint_id TEXT,
  from_seq INTEGER NOT NULL,
  through_seq INTEGER NOT NULL,
  source_turn_ids_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, through_seq),
  CHECK(through_seq >= from_seq)
);

CREATE TABLE IF NOT EXISTS context_messages (
  source_ref TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  message_json TEXT NOT NULL,
  usage_json TEXT,
  usage_scope TEXT,
  stop_reason TEXT,
  omitted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_messages_turn ON context_messages(turn_id);

CREATE TABLE IF NOT EXISTS context_compactions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK(seq > 0),
  base_entry_id TEXT,
  first_kept_source_ref TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  summary_markdown TEXT NOT NULL,
  details_json TEXT NOT NULL,
  tokens_before REAL NOT NULL CHECK(tokens_before >= 0),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, seq),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (base_entry_id) REFERENCES context_compactions(id)
);

CREATE TABLE IF NOT EXISTS ui_runs (
  run_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT,
  model_provider_id TEXT,
  model_id TEXT,
  owner_pid INTEGER,
  status TEXT NOT NULL CHECK(status IN ('accepted', 'running', 'completed', 'failed', 'interrupted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS agent_run_lease (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  holder_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ui_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  run_id TEXT,
  session_id TEXT NOT NULL,
  task_id TEXT,
  turn_id TEXT,
  kind TEXT NOT NULL,
  subject_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_session_created ON turns(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_session_status_updated ON tasks(session_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_trace_events_session_created ON trace_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trace_events_turn_created ON trace_events(turn_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trace_events_type_created ON trace_events(type, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_session_created ON artifacts(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_http_captures_turn_created ON llm_http_captures(turn_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_http_captures_request ON llm_http_captures(request_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_task_created ON token_usage(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_session_created ON token_usage(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_compaction_latest ON task_compaction_checkpoints(task_id, through_seq DESC);
CREATE INDEX IF NOT EXISTS idx_ui_events_run_seq ON ui_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_ui_runs_status ON ui_runs(status);
`;
