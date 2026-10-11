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

CREATE INDEX IF NOT EXISTS idx_turns_session_created ON turns(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_session_status_updated ON tasks(session_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_trace_events_session_created ON trace_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trace_events_turn_created ON trace_events(turn_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trace_events_type_created ON trace_events(type, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_session_created ON artifacts(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_http_captures_turn_created ON llm_http_captures(turn_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_http_captures_request ON llm_http_captures(request_id);
CREATE INDEX IF NOT EXISTS idx_task_compaction_latest ON task_compaction_checkpoints(task_id, through_seq DESC);
`;
