-- wendkeep:structural
-- Rebuild the operational identity tables so external identifiers are scoped by project.
-- Internal primary keys remain deterministic and opaque to the public API.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE sessions_v5 (
  session_pk TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unknown',
  summary TEXT NOT NULL DEFAULT '',
  change_slug TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  ended_at TEXT,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(project_id, session_id)
);

INSERT INTO sessions_v5
SELECT project_id || char(31) || session_id, project_id, session_id, provider, status,
       summary, change_slug, started_at, ended_at, updated_at, metadata_json
FROM sessions;

INSERT OR IGNORE INTO sessions_v5(session_pk, project_id, session_id, updated_at)
SELECT project_id || char(31) || session_id, project_id, session_id,
       COALESCE(MAX(occurred_at), CURRENT_TIMESTAMP)
FROM (
  SELECT project_id, session_id, occurred_at FROM usage_rollups
  UNION ALL SELECT project_id, session_id, occurred_at FROM llm_calls
  UNION ALL SELECT project_id, session_id, occurred_at FROM transcripts
) GROUP BY project_id, session_id;

INSERT OR IGNORE INTO sessions_v5(session_pk, project_id, session_id, updated_at)
SELECT project_id || char(31) || session_id, project_id, session_id, CURRENT_TIMESTAMP
FROM agent_runs;

CREATE TABLE agent_runs_v5 (
  agent_pk TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
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
  UNIQUE(project_id, agent_id),
  FOREIGN KEY(project_id, session_id) REFERENCES sessions_v5(project_id, session_id) ON DELETE CASCADE,
  FOREIGN KEY(project_id, parent_agent_id) REFERENCES agent_runs_v5(project_id, agent_id) ON DELETE SET NULL
);

INSERT INTO agent_runs_v5
SELECT a.project_id || char(31) || a.agent_id, a.project_id, a.agent_id, a.session_id,
       CASE WHEN EXISTS (
         SELECT 1 FROM agent_runs parent
         WHERE parent.project_id = a.project_id AND parent.agent_id = a.parent_agent_id
       ) THEN a.parent_agent_id ELSE NULL END,
       a.role, a.agent_name, a.agent_type, a.workflow, a.status, a.model, a.effort,
       a.started_at, a.ended_at, a.metadata_json
FROM agent_runs a;

INSERT OR IGNORE INTO agent_runs_v5(
  agent_pk, project_id, agent_id, session_id, role, status
)
SELECT project_id || char(31) || agent_id, project_id, agent_id, session_id, role, 'unknown'
FROM (
  SELECT project_id, agent_id, session_id, role FROM usage_rollups
  UNION ALL SELECT project_id, agent_id, session_id, role FROM llm_calls
  UNION ALL SELECT project_id, agent_id, session_id, 'main' AS role FROM transcripts
);

CREATE TABLE usage_rollups_v5 (
  rollup_pk TEXT PRIMARY KEY,
  rollup_key TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'main',
  provider TEXT NOT NULL DEFAULT '',
  model_provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT '',
  calls INTEGER NOT NULL DEFAULT 0,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0,
  tokens_total INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_status TEXT NOT NULL DEFAULT 'unknown',
  pricing_source TEXT NOT NULL DEFAULT '',
  pricing_version TEXT NOT NULL DEFAULT '',
  wasted_usd REAL NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  occurred_at TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES ingest_events(event_id) ON DELETE CASCADE,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(project_id, rollup_key),
  FOREIGN KEY(project_id, session_id) REFERENCES sessions_v5(project_id, session_id) ON DELETE CASCADE,
  FOREIGN KEY(project_id, agent_id) REFERENCES agent_runs_v5(project_id, agent_id) ON DELETE CASCADE
);

INSERT INTO usage_rollups_v5
SELECT project_id || char(31) || rollup_key, rollup_key, project_id, session_id,
       agent_id, role, provider, model_provider, model, effort, calls, tokens_input,
       tokens_cache_write, tokens_cache_read, tokens_output, tokens_reasoning,
       tokens_total, cost_usd, cost_status, pricing_source, pricing_version,
       wasted_usd, revision, occurred_at, source_event_id, metadata_json
FROM usage_rollups;

CREATE TABLE llm_calls_v5 (
  call_pk TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'main',
  provider TEXT NOT NULL DEFAULT '',
  model_provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT '',
  sequence INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0,
  tokens_total INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_status TEXT NOT NULL DEFAULT 'unknown',
  transcript_id TEXT,
  prompt_text TEXT NOT NULL DEFAULT '',
  response_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'complete',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(project_id, call_id),
  FOREIGN KEY(project_id, session_id) REFERENCES sessions_v5(project_id, session_id) ON DELETE CASCADE,
  FOREIGN KEY(project_id, agent_id) REFERENCES agent_runs_v5(project_id, agent_id) ON DELETE CASCADE
);

INSERT INTO llm_calls_v5
SELECT project_id || char(31) || call_id, call_id, project_id, session_id, agent_id,
       role, provider, model_provider, model, effort, sequence, occurred_at,
       tokens_input, tokens_cache_write, tokens_cache_read, tokens_output,
       tokens_reasoning, tokens_total, cost_usd, cost_status, transcript_id,
       prompt_text, response_text, status, metadata_json
FROM llm_calls;

CREATE TABLE transcripts_v5 (
  transcript_pk TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  coverage TEXT NOT NULL DEFAULT 'summary_only',
  codec TEXT NOT NULL DEFAULT 'gzip',
  content_gzip BLOB NOT NULL,
  content_sha256 TEXT NOT NULL,
  original_bytes INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(project_id, transcript_id),
  FOREIGN KEY(project_id, session_id) REFERENCES sessions_v5(project_id, session_id) ON DELETE CASCADE,
  FOREIGN KEY(project_id, agent_id) REFERENCES agent_runs_v5(project_id, agent_id) ON DELETE CASCADE
);

INSERT INTO transcripts_v5
SELECT project_id || char(31) || transcript_id, transcript_id, project_id, session_id,
       agent_id, coverage, codec, content_gzip, content_sha256, original_bytes,
       compressed_bytes, source, occurred_at, metadata_json
FROM transcripts;

DROP TABLE llm_calls;
DROP TABLE transcripts;
DROP TABLE usage_rollups;
DROP TABLE agent_runs;
DROP TABLE sessions;

ALTER TABLE sessions_v5 RENAME TO sessions;
ALTER TABLE agent_runs_v5 RENAME TO agent_runs;
ALTER TABLE usage_rollups_v5 RENAME TO usage_rollups;
ALTER TABLE llm_calls_v5 RENAME TO llm_calls;
ALTER TABLE transcripts_v5 RENAME TO transcripts;

CREATE INDEX idx_sessions_project_time ON sessions(project_id, started_at, ended_at);
CREATE INDEX idx_agent_runs_project_session ON agent_runs(project_id, session_id, role);
CREATE INDEX idx_usage_rollups_project_time ON usage_rollups(project_id, occurred_at);
CREATE INDEX idx_usage_rollups_project_agent ON usage_rollups(project_id, agent_id, role);
CREATE INDEX idx_usage_rollups_project_model ON usage_rollups(project_id, model_provider, model);
CREATE INDEX idx_llm_calls_project_time ON llm_calls(project_id, occurred_at);
CREATE INDEX idx_llm_calls_project_agent ON llm_calls(project_id, agent_id, sequence);
CREATE INDEX idx_llm_calls_project_model ON llm_calls(project_id, model_provider, model);
CREATE INDEX idx_transcripts_project_session ON transcripts(project_id, session_id, occurred_at);
CREATE INDEX idx_transcripts_project_coverage ON transcripts(project_id, coverage);

CREATE TABLE project_snapshots (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  UNIQUE(project_id, event_id)
);

CREATE INDEX idx_project_snapshots_captured ON project_snapshots(captured_at);
