CREATE TABLE IF NOT EXISTS usage_rollups (
  rollup_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_runs(agent_id) ON DELETE CASCADE,
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
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_usage_rollups_project_time
  ON usage_rollups(project_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_usage_rollups_project_agent
  ON usage_rollups(project_id, agent_id, role);

CREATE INDEX IF NOT EXISTS idx_usage_rollups_project_model
  ON usage_rollups(project_id, model_provider, model);

CREATE TABLE IF NOT EXISTS llm_calls (
  call_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_runs(agent_id) ON DELETE CASCADE,
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
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_llm_calls_project_time
  ON llm_calls(project_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_llm_calls_project_agent
  ON llm_calls(project_id, agent_id, sequence);

CREATE INDEX IF NOT EXISTS idx_llm_calls_project_model
  ON llm_calls(project_id, model_provider, model);
