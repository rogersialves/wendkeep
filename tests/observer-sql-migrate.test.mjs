import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureObserverDatabase, readSqlDocument, readUsageSummary } from '../src/observer-sql-store.mjs';
import { listMigrationDocuments, migrateObserverData } from '../src/observer-sql-migrate.mjs';
import { makeDataDir, makeObserverFixture } from './helpers/observer-fixture.mjs';

test('[req:SQL-OBS-5] migração importa documento, sessão e custos do frontmatter sem duplicar', () => {
  const fixture = makeObserverFixture();
  const dataDir = makeDataDir();
  const sessions = join(fixture.vaultBase, '02-Sessões/2026/08-AGO/DIA 17');
  mkdirSync(sessions, { recursive: true });
  const content = [
    '---',
    'type: session',
    'date: 2026-08-17',
    'started_at: 2026-08-17T10:00:00Z',
    'ended_at: 2026-08-17T11:00:00Z',
    'provider: codex',
    'session_id: "session-history"',
    'status: done',
    'summary: "Sessão histórica"',
    'modelo: "gpt-5.6-luna"',
    'tokens_total: 100',
    'custo_modelo_usd: 0.2',
    'subagents_count: 1',
    'subagents_tokens_total: 20',
    'subagents_custo_usd: 0.05',
    "custo_por_modelo_json: '[{\"provider\":\"openai\",\"model\":\"gpt-5.6-luna\",\"source\":\"main\",\"calls\":2,\"input\":10,\"output\":10,\"total\":100,\"cost\":0.2},{\"provider\":\"openai\",\"model\":\"gpt-5.5\",\"source\":\"subagent\",\"calls\":1,\"input\":5,\"output\":5,\"total\":20,\"cost\":0.05}]'",
    'observability_transcript_id: "transcript-history"',
    '---',
    '',
    '# Sessão histórica',
    '',
  ].join('\n');
  writeFileSync(join(sessions, 'history.md'), content, 'utf8');
  try {
    const first = migrateObserverData({ dataDir, vaultBase: fixture.vaultBase, projectId: fixture.projectId, projectName: fixture.projectName });
    assert.equal(first.documents, listMigrationDocuments(fixture.vaultBase).length);
    assert.equal(first.sessions, 1);
    assert.equal(first.rollups, 2);
    assert.equal(first.summary_only_transcripts, 1);
    const second = migrateObserverData({ dataDir, vaultBase: fixture.vaultBase, projectId: fixture.projectId, projectName: fixture.projectName });
    assert.equal(second.duplicates > 0, true);
    const db = ensureObserverDatabase(dataDir);
    try {
      const summary = readUsageSummary(db, fixture.projectId);
      assert.equal(summary.cost_usd, 0.25);
      assert.equal(summary.tokens.total, 120);
      assert.equal(readSqlDocument(db, fixture.projectId, '02-Sessões/2026/08-AGO/DIA 17/history.md').content, content);
    } finally { db.close(); }
  } finally {
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:SQL-OBS-5] migração reconcilia total do frontmatter sem perder o ledger detalhado', () => {
  const fixture = makeObserverFixture();
  const dataDir = makeDataDir();
  const sessions = join(fixture.vaultBase, '02-Sessões/2026/08-AGO/DIA 17');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'reconciliation.md'), [
    '---',
    'type: session',
    'date: 2026-08-17',
    'provider: codex',
    'session_id: "session-reconciliation"',
    'modelo: "gpt-5.6-luna"',
    'tokens_total: 100',
    'subagents_tokens_total: 20',
    'custo_modelo_usd: 1',
    'subagents_custo_usd: 0.2',
    "custo_por_modelo_json: '[{\"provider\":\"openai\",\"model\":\"gpt-5.6-luna\",\"source\":\"main\",\"total\":40,\"cost\":0.4},{\"provider\":\"openai\",\"model\":\"gpt-5.5\",\"source\":\"subagent\",\"total\":10,\"cost\":0.1}]'",
    '---',
    '',
    '# Reconciliação',
    '',
  ].join('\n'), 'utf8');
  try {
    const result = migrateObserverData({ dataDir, vaultBase: fixture.vaultBase, projectId: fixture.projectId, projectName: fixture.projectName });
    assert.equal(result.rollups, 4);
    const db = ensureObserverDatabase(dataDir);
    try {
      const summary = readUsageSummary(db, fixture.projectId);
      assert.equal(summary.cost_usd, 1.2);
      assert.equal(summary.main_cost_usd, 1);
      assert.equal(summary.subagent_cost_usd, 0.2);
      assert.equal(summary.tokens.total, 120);
    } finally { db.close(); }
  } finally {
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:SQL-OBS-5] migração não sobrescreve sessões históricas com session_id duplicado', () => {
  const fixture = makeObserverFixture();
  const dataDir = makeDataDir();
  const sessions = join(fixture.vaultBase, '02-Sessões/2026/08-AGO/DIA 17');
  mkdirSync(sessions, { recursive: true });
  const makeSession = (name, cost) => [
    '---', 'type: session', 'date: 2026-08-17', 'provider: codex',
    'session_id: "duplicate-session"', 'modelo: "gpt-5.6-luna"',
    `tokens_total: ${cost * 10}`, `custo_modelo_usd: ${cost}`,
    '---', '', `# ${name}`, '',
  ].join('\n');
  writeFileSync(join(sessions, 'first.md'), makeSession('Primeira', 1), 'utf8');
  writeFileSync(join(sessions, 'second.md'), makeSession('Segunda', 2), 'utf8');
  try {
    const result = migrateObserverData({ dataDir, vaultBase: fixture.vaultBase, projectId: fixture.projectId, projectName: fixture.projectName });
    assert.equal(result.sessions, 2);
    const db = ensureObserverDatabase(dataDir);
    try {
      const summary = readUsageSummary(db, fixture.projectId);
      assert.equal(summary.sessions, 2);
      assert.equal(summary.cost_usd, 3);
      assert.equal(summary.tokens.total, 30);
    } finally { db.close(); }
  } finally {
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
