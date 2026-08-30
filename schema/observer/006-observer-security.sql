-- wendkeep:structural
-- Security lifecycle: hash-only credentials, access audit, retention, purge receipts and encrypted columns.

ALTER TABLE llm_calls ADD COLUMN prompt_envelope TEXT NOT NULL DEFAULT '';
ALTER TABLE llm_calls ADD COLUMN response_envelope TEXT NOT NULL DEFAULT '';
ALTER TABLE llm_calls ADD COLUMN metadata_envelope TEXT NOT NULL DEFAULT '';
ALTER TABLE documents ADD COLUMN content_envelope TEXT NOT NULL DEFAULT '';
ALTER TABLE documents ADD COLUMN metadata_envelope TEXT NOT NULL DEFAULT '';
ALTER TABLE transcripts ADD COLUMN metadata_envelope TEXT NOT NULL DEFAULT '';
ALTER TABLE project_snapshots ADD COLUMN snapshot_envelope TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS observer_tokens (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('viewer', 'auditor', 'publisher', 'admin')),
  project_ids_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  rotated_from TEXT REFERENCES observer_tokens(token_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_observer_tokens_hash_active ON observer_tokens(token_hash, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS observer_access_audit (
  audit_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  token_id TEXT REFERENCES observer_tokens(token_id) ON DELETE SET NULL,
  capability TEXT NOT NULL,
  outcome TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_observer_audit_project_time ON observer_access_audit(project_id, occurred_at);

CREATE TABLE IF NOT EXISTS observer_retention_policies (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  policy_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observer_purge_receipts (
  receipt_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  cutoff_at TEXT NOT NULL,
  classes_json TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  purged_at TEXT NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_observer_purge_project_time ON observer_purge_receipts(project_id, purged_at);
CREATE INDEX IF NOT EXISTS idx_observer_purge_request ON observer_purge_receipts(project_id, request_hash, purged_at);

CREATE TABLE IF NOT EXISTS observer_security_backfill (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  protected_rows INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
