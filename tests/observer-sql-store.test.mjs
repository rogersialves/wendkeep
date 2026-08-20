import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureObserverDatabase,
  ingestObserverEvents,
  readUsageBreakdown,
  readUsageCalls,
  readUsageSummary,
  registerSqlProject,
  observerFts5Support,
  rebuildSqlEvidenceIndex,
  searchSqlDocuments,
} from '../src/observer-sql-store.mjs';
import { makeDataDir } from './helpers/observer-fixture.mjs';

function event(kind, eventId, projectId, payload, occurredAt = '2026-08-17T12:00:00.000Z') {
  return { schema_version: 1, event_id: eventId, kind, project_id: projectId, occurred_at: occurredAt, payload };
}

function usagePayload({ agentId, sessionId, role = 'main', model = 'gpt-5.6-luna', cost = 0.12, total = 20 }) {
  return {
    session_id: sessionId,
    agent_id: agentId,
    role,
    provider: role === 'main' ? 'codex' : 'codex-subagent',
    model_provider: 'openai',
    model,
    effort: 'max',
    calls: 2,
    tokens: { input: 10, cache_write: 1, cache_read: 2, output: 4, reasoning: 3, total },
    cost_usd: cost,
    cost_status: 'known',
    pricing_source: 'test',
    pricing_version: 'test-1',
  };
}

test('[req:SQL-OBS-1] banco SQLite cria migrações e persiste no data dir', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    assert.equal(existsSync(join(dataDir, 'observer.sqlite')), true);
    registerSqlProject(db, { projectId: 'project-a', projectName: 'Projeto A', wendkeepVersion: '0.72.0' });
    const project = db.prepare('SELECT project_id, project_name FROM projects WHERE project_id = ?').get('project-a');
    assert.deepEqual({ ...project }, { project_id: 'project-a', project_name: 'Projeto A' });
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:SQL-OBS-2] eventos repetidos são no-op e payload divergente é conflito', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a', projectName: 'Projeto A' });
    const first = event('session.upsert', 'session-1', 'project-a', {
      session_id: 'session-a', provider: 'codex', status: 'done', started_at: '2026-08-17T11:00:00Z',
    });
    assert.equal(ingestObserverEvents(db, { projectId: 'project-a', events: [first] }).accepted, 1);
    const legacyHash = createHash('sha256').update(JSON.stringify({ kind: first.kind, project_id: first.project_id, occurred_at: first.occurred_at, payload: first.payload })).digest('hex');
    db.prepare('UPDATE ingest_events SET payload_hash = ? WHERE event_id = ?').run(legacyHash, first.event_id);
    assert.equal(ingestObserverEvents(db, { projectId: 'project-a', events: [{ ...first, occurred_at: '2026-08-17T12:01:00Z' }] }).duplicates, 1);
    const conflict = { ...first, payload: { ...first.payload, status: 'active' } };
    const result = ingestObserverEvents(db, { projectId: 'project-a', events: [conflict] });
    assert.equal(result.conflicts, 1);
    assert.equal(db.prepare('SELECT status FROM sessions WHERE session_id = ?').get('session-a').status, 'done');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:SQL-OBS-3] documento e memória são persistidos por projeto com revisão e hash', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a', projectName: 'Projeto A' });
    const content = '# Sessão SQL\n\nConteúdo persistido no banco.\n';
    const contentHash = createHash('sha256').update(content).digest('hex');
    const result = ingestObserverEvents(db, {
      projectId: 'project-a',
      events: [event('document.upsert', 'document-1', 'project-a', {
        logical_path: '02-Sessões/2026/08-AGO/DIA 17/sql.md',
        entity_type: 'session', content, content_hash: contentHash, revision: 1,
        metadata: { session_id: 'session-a', provider: 'codex' },
      })],
    });
    assert.equal(result.accepted, 1);
    const row = db.prepare('SELECT logical_path, content, content_hash, revision, entity_type FROM documents WHERE project_id = ?').get('project-a');
    assert.deepEqual({ ...row }, { logical_path: '02-Sessões/2026/08-AGO/DIA 17/sql.md', content, content_hash: contentHash, revision: 1, entity_type: 'session' });
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:SQL-OBS-3] republicação do mesmo documento por outro evento é stale e revisão divergente é conflito', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a', projectName: 'Projeto A' });
    const content = '# Documento idempotente\n';
    const contentHash = createHash('sha256').update(content).digest('hex');
    const payload = {
      logical_path: '04-Decisões/2026/08-AGO/ADR-0001.md',
      entity_type: 'decision', content, content_hash: contentHash, revision: 1,
    };
    assert.equal(ingestObserverEvents(db, { projectId: 'project-a', events: [event('document.upsert', 'migration-event', 'project-a', payload)] }).accepted, 1);
    const replay = ingestObserverEvents(db, { projectId: 'project-a', events: [event('document.upsert', 'publisher-event', 'project-a', payload)] });
    assert.equal(replay.stale, 1);
    assert.equal(replay.rejected, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_events WHERE project_id = ?').get('project-a').count, 1);
    const conflict = ingestObserverEvents(db, {
      projectId: 'project-a',
      events: [event('document.upsert', 'conflicting-event', 'project-a', { ...payload, content: '# Conteúdo divergente\n', content_hash: createHash('sha256').update('# Conteúdo divergente\n').digest('hex') })],
    });
    assert.equal(conflict.conflicts, 1);
    assert.equal(conflict.rejected, 0);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:RECALL-6] Observer indexes chunks, probes FTS5 and returns the matching evidence passage', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a', projectName: 'Projeto A' });
    const content = '# Observer\n\n## Introdução\n\nTexto genérico que não é a resposta.\n\n## Decisão de indexação\n\nO feature probe FTS5 ativa busca lexical com proveniência verificável.\n';
    const accepted = ingestObserverEvents(db, {
      projectId: 'project-a',
      events: [event('document.upsert', 'evidence-document', 'project-a', {
        logical_path: '04-Decisões/ADR-0099-evidence.md',
        entity_type: 'decision',
        content,
        revision: 1,
        metadata: { authority: 'verified', validity: 'active', change_slug: 'evidence-recall' },
      })],
    });
    assert.equal(accepted.accepted, 1);
    assert.ok(db.prepare('SELECT COUNT(*) AS count FROM document_chunks WHERE project_id = ?').get('project-a').count >= 2);
    const support = observerFts5Support(db);
    assert.ok(['fts5', 'lexical-fallback'].includes(support.engine));
    const results = searchSqlDocuments(db, 'project-a', 'feature probe FTS5');
    assert.equal(results[0].heading, 'Decisão de indexação');
    assert.match(results[0].excerpt, /feature probe FTS5 ativa/);
    assert.equal(results[0].logical_path, '04-Decisões/ADR-0099-evidence.md');
    assert.equal(results[0].authority, 'verified');
    assert.equal(results[0].validity, 'active');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:RECALL-6] enabling FTS5 later backfills chunks created under lexical fallback', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a', projectName: 'A' });
    ingestObserverEvents(db, {
      projectId: 'project-a',
      events: [event('document.upsert', 'fts-late-document', 'project-a', {
        logical_path: '04-Decisions/ADR-002.md',
        entity_type: 'decision',
        content: '# ADR\n\n## Evidência tardia\n\nO índice recupera a passagem depois do feature probe.\n',
        revision: 1,
      })],
    });
    const support = observerFts5Support(db);
    if (support.supported) {
      db.exec('DELETE FROM evidence_chunks_fts');
      const rebuilt = rebuildSqlEvidenceIndex(db, { missingOnly: true });
      assert.equal(rebuilt.fts.rebuilt, true);
      assert.match(searchSqlDocuments(db, 'project-a', 'feature probe')[0].excerpt, /passagem depois/);
    }
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:SQL-OBS-4] summary separa agente principal, subagente, modelo, tokens, custo e chamadas', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a', projectName: 'Projeto A' });
    const events = [
      event('session.upsert', 'session-1', 'project-a', { session_id: 'session-a', provider: 'codex', status: 'done', started_at: '2026-08-17T11:00:00Z' }),
      event('agent.upsert', 'agent-1', 'project-a', { agent_id: 'agent-main', session_id: 'session-a', role: 'main', agent_name: 'codex', agent_type: 'codex' }),
      event('agent.upsert', 'agent-2', 'project-a', { agent_id: 'agent-sub', session_id: 'session-a', parent_agent_id: 'agent-main', role: 'subagent', agent_name: 'reviewer', agent_type: 'reviewer' }),
      event('usage.rollup', 'usage-1', 'project-a', usagePayload({ agentId: 'agent-main', sessionId: 'session-a' })),
      event('usage.rollup', 'usage-2', 'project-a', usagePayload({ agentId: 'agent-sub', sessionId: 'session-a', role: 'subagent', model: 'gpt-5.5', cost: 0.03, total: 9 })),
      event('llm_call', 'call-1', 'project-a', { call_id: 'call-1', session_id: 'session-a', agent_id: 'agent-main', role: 'main', model_provider: 'openai', model: 'gpt-5.6-luna', occurred_at: '2026-08-17T11:01:00Z', tokens: { input: 10, cache_write: 1, cache_read: 2, output: 4, reasoning: 3, total: 20 }, cost_usd: 0.12, prompt: 'prompt local', response: 'response local' }),
    ];
    assert.equal(ingestObserverEvents(db, { projectId: 'project-a', events }).accepted, events.length);
    const summary = readUsageSummary(db, 'project-a');
    assert.equal(summary.sessions, 1);
    assert.equal(summary.agents, 2);
    assert.equal(summary.subagents, 1);
    assert.equal(summary.models, 2);
    assert.equal(summary.calls, 4);
    assert.equal(summary.cost_usd, 0.15);
    assert.deepEqual(summary.tokens, { input: 20, cache_write: 2, cache_read: 4, output: 8, reasoning: 6, total: 29 });
    const breakdown = readUsageBreakdown(db, 'project-a');
    assert.equal(breakdown.agents[0].agent_id, 'agent-main');
    assert.equal(breakdown.agents[0].models[0].model, 'gpt-5.6-luna');
    assert.equal(readUsageCalls(db, 'project-a').calls[0].prompt, 'prompt local');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:SQL-OBS-8] consultas não atravessam projetos', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a', projectName: 'Projeto A' });
    registerSqlProject(db, { projectId: 'project-b', projectName: 'Projeto B' });
    ingestObserverEvents(db, {
      projectId: 'project-a',
      events: [event('session.upsert', 'a-session', 'project-a', { session_id: 'a', provider: 'codex', status: 'done' }), event('usage.rollup', 'a-usage', 'project-a', usagePayload({ agentId: 'a-agent', sessionId: 'a' }))],
    });
    ingestObserverEvents(db, {
      projectId: 'project-b',
      events: [event('session.upsert', 'b-session', 'project-b', { session_id: 'b', provider: 'claude', status: 'done' }), event('usage.rollup', 'b-usage', 'project-b', usagePayload({ agentId: 'b-agent', sessionId: 'b', model: 'claude-opus-4.8', cost: 2 }))],
    });
    assert.equal(readUsageSummary(db, 'project-a').cost_usd, 0.12);
    assert.equal(readUsageSummary(db, 'project-b').cost_usd, 2);
    assert.equal(readUsageCalls(db, 'project-a').calls.length, 0);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
