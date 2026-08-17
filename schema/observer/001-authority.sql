PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  wendkeep_version TEXT NOT NULL DEFAULT '',
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted'
);

CREATE INDEX IF NOT EXISTS idx_ingest_events_project_time
  ON ingest_events(project_id, occurred_at);

CREATE TABLE IF NOT EXISTS memory_events (
  event_id TEXT PRIMARY KEY REFERENCES ingest_events(event_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  logical_path TEXT NOT NULL,
  operation TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL DEFAULT '',
  source_session_id TEXT NOT NULL DEFAULT '',
  source_turn_id TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(project_id, logical_path, revision)
);

CREATE INDEX IF NOT EXISTS idx_memory_events_project_path
  ON memory_events(project_id, logical_path, revision);

CREATE TABLE IF NOT EXISTS documents (
  document_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  logical_path TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  source_session_id TEXT NOT NULL DEFAULT '',
  source_turn_id TEXT NOT NULL DEFAULT '',
  captured_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(project_id, logical_path)
);

CREATE INDEX IF NOT EXISTS idx_documents_project_type
  ON documents(project_id, entity_type, deleted_at);

CREATE INDEX IF NOT EXISTS idx_documents_project_revision
  ON documents(project_id, revision);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unknown',
  summary TEXT NOT NULL DEFAULT '',
  change_slug TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  ended_at TEXT,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_time
  ON sessions(project_id, started_at, ended_at);

CREATE TABLE IF NOT EXISTS agent_runs (
  agent_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  parent_agent_id TEXT,
  role TEXT NOT NULL DEFAULT 'main',
  agent_name TEXT NOT NULL DEFAULT '',
  agent_type TEXT NOT NULL DEFAULT '',
  workflow TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unknown',
  model TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  ended_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(parent_agent_id) REFERENCES agent_runs(agent_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_project_session
  ON agent_runs(project_id, session_id, role);
