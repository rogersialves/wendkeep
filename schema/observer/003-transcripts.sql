CREATE TABLE IF NOT EXISTS transcripts (
  transcript_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_runs(agent_id) ON DELETE CASCADE,
  coverage TEXT NOT NULL DEFAULT 'summary_only',
  codec TEXT NOT NULL DEFAULT 'gzip',
  content_gzip BLOB NOT NULL,
  content_sha256 TEXT NOT NULL,
  original_bytes INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_transcripts_project_session
  ON transcripts(project_id, session_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_transcripts_project_coverage
  ON transcripts(project_id, coverage);
