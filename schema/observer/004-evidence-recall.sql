CREATE TABLE IF NOT EXISTS document_chunks (
  chunk_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  logical_path TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  heading TEXT NOT NULL DEFAULT '',
  entity_type TEXT NOT NULL DEFAULT 'document',
  change_slug TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  work_session_id TEXT NOT NULL DEFAULT '',
  authority TEXT NOT NULL DEFAULT 'candidate',
  observed_at TEXT NOT NULL,
  validity TEXT NOT NULL DEFAULT 'active',
  content_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  FOREIGN KEY(project_id, logical_path) REFERENCES documents(project_id, logical_path) ON DELETE CASCADE,
  UNIQUE(project_id, logical_path, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_project_path
  ON document_chunks(project_id, logical_path, ordinal);

CREATE INDEX IF NOT EXISTS idx_document_chunks_project_type
  ON document_chunks(project_id, entity_type, validity, observed_at);
