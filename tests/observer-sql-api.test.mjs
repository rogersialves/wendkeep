import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { startObserverServer } from '../src/observer-server.mjs';
import { ensureObserverDatabase, registerSqlProject } from '../src/observer-sql-store.mjs';
import { makeDataDir, observerBootstrap } from './helpers/observer-fixture.mjs';

const TOKEN = 'observer-test-token';
const MUTATION_HEADERS = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

async function request(base, path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

function event(kind, eventId, payload, occurredAt = '2026-08-17T12:00:00.000Z') {
  return { schema_version: 1, event_id: eventId, kind, project_id: 'project-a', occurred_at: occurredAt, payload };
}

test('[req:SQL-OBS-6] API local ingere eventos e consulta summary, breakdown, calls e transcript', async () => {
  const dataDir = makeDataDir();
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, ...observerBootstrap(TOKEN) });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = MUTATION_HEADERS;
  try {
    const registered = await request(base, '/v1/projects/project-a', {
      method: 'PUT', headers, body: JSON.stringify({ project_id: 'project-a', project_name: 'Project A' }),
    });
    assert.equal(registered.status, 201);
    const events = [
      event('session.upsert', 'api-session', { session_id: 'session-a', provider: 'codex', status: 'done' }),
      event('agent.upsert', 'api-agent', { agent_id: 'agent-a', session_id: 'session-a', role: 'main', agent_name: 'codex', agent_type: 'codex' }),
      event('usage.rollup', 'api-usage', { session_id: 'session-a', agent_id: 'agent-a', role: 'main', provider: 'codex', model_provider: 'openai', model: 'gpt-5.6-luna', effort: 'max', calls: 1, tokens: { input: 1, output: 2, total: 3 }, cost_usd: 0.04 }),
      event('llm_call', 'api-call', { call_id: 'call-a', session_id: 'session-a', agent_id: 'agent-a', role: 'main', model_provider: 'openai', model: 'gpt-5.6-luna', tokens: { input: 1, output: 2, total: 3 }, cost_usd: 0.04, prompt: 'pergunta', response: 'resposta' }),
      event('transcript.upsert', 'api-transcript', { transcript_id: 'transcript-a', session_id: 'session-a', agent_id: 'agent-a', coverage: 'complete', content: '{"messages":[]}', source: 'test' }),
    ];
    const ingested = await request(base, '/v1/projects/project-a/ingest', { method: 'POST', headers, body: JSON.stringify({ events }) });
    assert.equal(ingested.status, 201, JSON.stringify(ingested.body));
    assert.equal(ingested.body.accepted, events.length);

    const summary = await request(base, '/v1/projects/project-a/usage/summary');
    assert.equal(summary.status, 200);
    assert.equal(summary.body.cost_usd, 0.04);
    assert.equal(summary.body.tokens.total, 3);
    assert.equal(summary.body.coverage.complete, 1);

    const breakdown = await request(base, '/v1/projects/project-a/usage/breakdown');
    assert.equal(breakdown.status, 200);
    assert.equal(breakdown.body.agents[0].agent_id, 'agent-a');

    const calls = await request(base, '/v1/projects/project-a/usage/calls', { headers });
    assert.equal(calls.status, 200);
    assert.equal(calls.body.calls[0].prompt, 'pergunta');

    const transcript = await request(base, '/v1/projects/project-a/transcripts/transcript-a', { headers });
    assert.equal(transcript.status, 200);
    assert.equal(transcript.body.content, '{"messages":[]}');
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:SQL-OBS-2] API retorna conflito e duplicate sem alterar o evento original', async () => {
  const dataDir = makeDataDir();
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, ...observerBootstrap(TOKEN) });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = MUTATION_HEADERS;
  try {
    await request(base, '/v1/projects/project-a', { method: 'PUT', headers, body: JSON.stringify({ project_id: 'project-a', project_name: 'Project A' }) });
    const first = event('session.upsert', 'api-conflict', { session_id: 'session-a', provider: 'codex', status: 'done' });
    const accepted = await request(base, '/v1/projects/project-a/ingest', { method: 'POST', headers, body: JSON.stringify({ events: [first] }) });
    assert.equal(accepted.status, 201);
    const duplicate = await request(base, '/v1/projects/project-a/ingest', { method: 'POST', headers, body: JSON.stringify({ events: [first] }) });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicates, 1);
    const conflict = await request(base, '/v1/projects/project-a/ingest', { method: 'POST', headers, body: JSON.stringify({ events: [{ ...first, payload: { ...first.payload, status: 'active' } }] }) });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.conflicts, 1);
    const summary = await request(base, '/v1/projects/project-a/usage/summary');
    assert.equal(summary.body.sessions, 0);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:SQL-OBS-7] filtros distinguem subagente e changes de projeto somente-SQL', async () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  registerSqlProject(db, { projectId: 'sql-only', projectName: 'SQL Only' });
  db.close();
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, ...observerBootstrap(TOKEN) });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = MUTATION_HEADERS;
  try {
    const events = [
      { ...event('agent.upsert', 'parent-filter-agent', { agent_id: 'agent-a', session_id: 'session-a', role: 'main', agent_name: 'codex' }), project_id: 'sql-only' },
      { ...event('agent.upsert', 'subagent-filter-agent', { agent_id: 'sub-a', session_id: 'session-a', parent_agent_id: 'agent-a', role: 'subagent', agent_name: 'reviewer' }), project_id: 'sql-only' },
      { ...event('usage.rollup', 'subagent-filter-usage', { session_id: 'session-a', agent_id: 'sub-a', role: 'subagent', provider: 'anthropic', model_provider: 'anthropic', model: 'claude-test', calls: 2, tokens: { input: 4, output: 6, total: 10 }, cost_usd: 0.2 }), project_id: 'sql-only' },
    ];
    const ingested = await request(base, '/v1/projects/sql-only/ingest', { method: 'POST', headers, body: JSON.stringify({ events }) });
    assert.equal(ingested.status, 201, JSON.stringify(ingested.body));
    const usage = await request(base, '/v1/projects/sql-only/usage/summary?subagent_id=sub-a');
    assert.equal(usage.status, 200);
    assert.equal(usage.body.subagents, 1);
    assert.equal(usage.body.tokens.total, 10);
    const changes = await request(base, '/v1/projects/sql-only/changes');
    assert.equal(changes.status, 200);
    assert.deepEqual(changes.body.changes, []);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
