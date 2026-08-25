import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { startObserverServer } from '../src/observer-server.mjs';
import {
  buildObserverSqlEventBatch,
  listSqlOutbox,
  observerSqlRequestTimeoutMs,
  publishObserverSql,
  retryObserverSqlOutbox,
  SQL_EVENT_BATCH_SIZE,
  SQL_EVENT_BATCH_BYTES,
} from '../src/observer-sql-publish.mjs';
import { makeDataDir, makeObserverFixture } from './helpers/observer-fixture.mjs';

const TOKEN = 'observer-test-token';
const MUTATION_HEADERS = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

test('[req:SQL-OBS-10] timeout de ingestão cresce com o payload e permanece limitado', () => {
  assert.equal(observerSqlRequestTimeoutMs(0), 15_000);
  assert.equal(observerSqlRequestTimeoutMs(8 * 1024 * 1024), 15_000);
  assert.equal(observerSqlRequestTimeoutMs(70 * 1024 * 1024), 77_000);
  assert.equal(observerSqlRequestTimeoutMs(1024 * 1024 * 1024), 120_000);
});

function sessionFixture(fixture, transcriptPath) {
  const sessionDir = join(fixture.vaultBase, '02-Sessões/2026/08-AGO/DIA 17');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'live.md'), [
    '---',
    'type: session',
    'date: 2026-08-17',
    'started_at: 2026-08-17T10:00:00Z',
    'ended_at: 2026-08-17T11:00:00Z',
    'provider: codex',
    'session_id: "live-session"',
    'status: done',
    'modelo: "gpt-5.6-luna"',
    'observability_transcript_id: "live-transcript"',
    `transcript_path: "${transcriptPath.replaceAll('\\', '/')}"`,
    'custo_por_modelo_json: \'[{"provider":"openai","model":"gpt-5.6-luna","source":"main","calls":1,"input":10,"output":20,"total":30,"cost":0.2},{"provider":"openai","model":"gpt-5.5","source":"subagent","calls":1,"input":4,"output":8,"total":12,"cost":0.05}]\'',
    '---',
    '',
    '# Live session',
    '',
  ].join('\n'));
}

function transcriptFixture(path) {
  writeFileSync(path, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'live-session', model: 'gpt-5.6-luna' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' }, timestamp: '2026-08-17T10:01:00Z' }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', turn_id: 'turn-1', message: 'Mostre o resumo do projeto.' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { model: 'gpt-5.6-luna', last_token_usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', turn_id: 'turn-1', message: 'Resumo pronto.' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
    '',
  ].join('\n'));
}

test('[req:SQL-OBS-SEC] captura padrão omite mensagens, transcript bruto e caminho absoluto', () => {
  const fixture = makeObserverFixture();
  const transcriptPath = join(fixture.projectRoot, 'private-transcript.jsonl');
  transcriptFixture(transcriptPath);
  sessionFixture(fixture, transcriptPath);
  try {
    const batch = buildObserverSqlEventBatch({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      input: { session_id: 'live-session', transcript_path: transcriptPath, transcript_id: 'live-transcript' },
      now: '2026-08-17T11:00:00Z',
    });
    assert.equal(batch.events.some((event) => event.kind === 'transcript.upsert' && event.payload.content), false);
    assert.equal(batch.events.some((event) => event.kind === 'transcript.upsert' && event.payload.coverage === 'complete'), false);
    const call = batch.events.find((event) => event.kind === 'llm_call');
    assert.equal(call.payload.prompt_text, '');
    assert.equal(call.payload.response_text, '');
    assert.doesNotMatch(JSON.stringify(batch.events), new RegExp(fixture.projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fixture.cleanup();
  }
});

test('[req:TDD-7] Observer publishes the TDD attestation as change evidence', () => {
  const fixture = makeObserverFixture();
  try {
    const changeDir = join(fixture.vaultBase, '08-Mudanças', 'tdd-attestation');
    mkdirSync(changeDir, { recursive: true });
    writeFileSync(join(changeDir, 'tdd-attestations.json'), JSON.stringify({
      schema_version: 1,
      attestations: [{
        schema_version: 1,
        attestation_id: 'a'.repeat(64),
        task_id: '1.1',
        requirement_id: 'TDD-1',
        state: 'green-observed',
        test_paths: ['tests/tdd.test.mjs'],
      }],
    }));
    const batch = buildObserverSqlEventBatch({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      now: '2026-08-24T20:00:00Z',
    });
    const event = batch.events.find((item) => (
      item.kind === 'document.upsert'
      && item.payload.logical_path === '08-Mudanças/tdd-attestation/tdd-attestations.json'
    ));
    assert.ok(event);
    assert.equal(event.payload.entity_type, 'change');
    assert.match(event.payload.content, /green-observed/);
  } finally {
    fixture.cleanup();
  }
});

test('[req:SQL-INCR-5] forced reconciliation rebuilds operational rows despite a complete local cursor', async () => {
  const fixture = makeObserverFixture();
  const transcriptPath = join(fixture.projectRoot, 'reconcile-transcript.jsonl');
  transcriptFixture(transcriptPath);
  sessionFixture(fixture, transcriptPath);
  try {
    const input = { session_id: 'live-session', transcript_path: transcriptPath, transcript_id: 'live-transcript' };
    const baseline = buildObserverSqlEventBatch({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      input,
      captureLevel: 'full-transcript',
      now: '2026-08-20T12:00:00Z',
    });
    for (const file of Object.values(baseline.nextState.files)) file.revision = 7;
    writeFileSync(join(fixture.vaultBase, '.brain', 'observer-sql-state.json'), `${JSON.stringify(baseline.nextState, null, 2)}\n`);
    const posted = [];
    const result = await publishObserverSql({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      url: 'http://observer.test',
      input,
      captureLevel: 'full-transcript',
      forceFull: true,
      now: '2026-08-20T12:01:00Z',
      fetchImpl: async (url, init = {}) => {
        if (!init.method) return { ok: false, status: 503, json: async () => ({}) };
        const body = JSON.parse(gunzipSync(init.body).toString('utf8'));
        posted.push(...body.events);
        return { ok: true, status: 201, json: async () => ({ accepted: body.events.length }) };
      },
    });
    assert.equal(result.ok, true);
    assert.ok(posted.some((event) => event.kind === 'document.upsert'));
    assert.ok(posted.some((event) => event.kind === 'usage.rollup'));
    assert.ok(posted.some((event) => event.kind === 'llm_call'));
    assert.ok(posted.some((event) => event.kind === 'transcript.upsert' && event.payload.coverage === 'complete'));
    assert.ok(posted.filter((event) => event.kind === 'document.upsert').every((event) => event.payload.revision === 7));
    const persisted = JSON.parse(readFileSync(join(fixture.vaultBase, '.brain', 'observer-sql-state.json'), 'utf8'));
    assert.ok(Object.values(persisted.files).every((file) => file.revision === 7));
  } finally { fixture.cleanup(); }
});

test('[req:SQL-OBS-10] publisher envia lote gzip quando o JSON puro excede 64 MB', async () => {
  const fixture = makeObserverFixture();
  const dataDir = makeDataDir();
  const decisions = join(fixture.vaultBase, '04-Decisões/2026/08-AGO');
  mkdirSync(decisions, { recursive: true });
  writeFileSync(join(decisions, 'ADR-large-transcript.md'), `# Histórico grande\n${'linha de evidência repetida para medir transporte.\n'.repeat(1_400_000)}`);
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, token: TOKEN });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const registration = await fetch(`${url}/v1/projects/${fixture.projectId}`, {
      method: 'PUT',
      headers: MUTATION_HEADERS,
      body: JSON.stringify({ project_id: fixture.projectId, project_name: fixture.projectName }),
    });
    assert.equal(registration.ok, true);
    const result = await publishObserverSql({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      url,
      now: '2026-08-17T11:00:00Z',
      token: TOKEN,
    });
    assert.equal(result.ok, true);
    assert.equal(result.pending, 0);
    const tree = await (await fetch(`${url}/v1/projects/${fixture.projectId}/memory/tree`)).json();
    assert.ok(tree.documents.some((document) => document.logical_path === '04-Decisões/2026/08-AGO/ADR-large-transcript.md'));
  } finally {
    await server.close();
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:SQL-OBS-4] publisher envia rollups, chamada individual e transcript completo', async () => {
  const fixture = makeObserverFixture();
  const dataDir = makeDataDir();
  const transcriptPath = join(fixture.projectRoot, 'live-transcript.jsonl');
  transcriptFixture(transcriptPath);
  sessionFixture(fixture, transcriptPath);
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, token: TOKEN });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const registration = await fetch(`${url}/v1/projects/${fixture.projectId}`, {
      method: 'PUT',
      headers: MUTATION_HEADERS,
      body: JSON.stringify({ project_id: fixture.projectId, project_name: fixture.projectName }),
    });
    assert.equal(registration.ok, true);
    const result = await publishObserverSql({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      url,
      input: { session_id: 'live-session', transcript_path: transcriptPath, transcript_id: 'live-transcript' },
      now: '2026-08-17T11:00:00Z',
      token: TOKEN,
      captureLevel: 'full-transcript',
    });
    assert.equal(result.ok, true);
    assert.equal(result.queued, false);
    const summary = await (await fetch(`${url}/v1/projects/${fixture.projectId}/usage/summary`)).json();
    assert.equal(summary.cost_usd, 0.25);
    assert.equal(summary.tokens.total, 42);
    assert.equal(summary.raw_calls, 1);
    const calls = await (await fetch(`${url}/v1/projects/${fixture.projectId}/usage/calls`)).json();
    assert.equal(calls.total, 1);
    assert.equal(calls.calls[0].prompt, 'Mostre o resumo do projeto.');
    const transcript = await (await fetch(`${url}/v1/projects/${fixture.projectId}/transcripts/live-transcript`)).json();
    assert.equal(transcript.coverage, 'complete');
    assert.match(transcript.content, /Resumo pronto/);
  } finally {
    await server.close();
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:SQL-OBS-8] publisher preserva outbox e faz replay depois da indisponibilidade', async () => {
  const fixture = makeObserverFixture();
  const dataDir = makeDataDir();
  const transcriptPath = join(fixture.projectRoot, 'live-transcript.jsonl');
  transcriptFixture(transcriptPath);
  sessionFixture(fixture, transcriptPath);
  try {
    const queued = await publishObserverSql({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      url: 'http://127.0.0.1:1',
      input: { session_id: 'live-session', transcript_path: transcriptPath, transcript_id: 'live-transcript' },
      now: '2026-08-17T11:00:00Z',
    });
    assert.equal(queued.ok, false);
    assert.equal(queued.queued, true);
    assert.equal(listSqlOutbox(fixture.vaultBase).length, 1);
    const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, token: TOKEN });
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const registration = await fetch(`${url}/v1/projects/${fixture.projectId}`, {
        method: 'PUT',
        headers: MUTATION_HEADERS,
        body: JSON.stringify({ project_id: fixture.projectId, project_name: fixture.projectName }),
      });
      assert.equal(registration.ok, true);
      const replay = await retryObserverSqlOutbox({ vaultBase: fixture.vaultBase, projectId: fixture.projectId, url, token: TOKEN });
      assert.equal(replay.confirmed, 1);
      assert.equal(replay.pending, 0);
      const summary = await (await fetch(`${url}/v1/projects/${fixture.projectId}/usage/summary`)).json();
      assert.equal(summary.cost_usd, 0.25);
    } finally {
      await server.close();
    }
  } finally {
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:SQL-OBS-8] publisher divide migração volumosa em lotes idempotentes', async () => {
  const fixture = makeObserverFixture();
  const decisions = join(fixture.vaultBase, '04-Decisões/2026/08-AGO');
  mkdirSync(decisions, { recursive: true });
  for (let index = 0; index < SQL_EVENT_BATCH_SIZE + 7; index += 1) {
    writeFileSync(join(decisions, `ADR-${String(index).padStart(4, '0')}.md`), `# Decisão ${index}\n`);
  }
  const requestSizes = [];
  const requestBytes = [];
  try {
    const result = await publishObserverSql({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      url: 'http://observer.test',
      fetchImpl: async (_url, init) => {
        assert.equal(init.headers['content-encoding'], 'gzip');
        const body = JSON.parse(gunzipSync(init.body).toString('utf8'));
        requestSizes.push(body.events.length);
        requestBytes.push(Buffer.byteLength(init.body));
        return { ok: true, status: 201, json: async () => ({ accepted: body.events.length, duplicates: 0, conflicts: 0, rejected: 0 }) };
      },
      now: '2026-08-17T11:00:00Z',
    });
    assert.equal(result.ok, true);
    assert.ok(requestSizes.length >= 2);
    assert.ok(requestSizes.every((size) => size <= SQL_EVENT_BATCH_SIZE));
    assert.ok(requestBytes.every((size) => size <= SQL_EVENT_BATCH_BYTES));
    assert.equal(requestSizes.reduce((sum, size) => sum + size, 0), result.response.accepted);
  } finally {
    fixture.cleanup();
  }
});
