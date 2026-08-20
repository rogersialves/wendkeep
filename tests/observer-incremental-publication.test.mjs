import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  buildObserverSqlIncrementalBatch,
  enqueueObserverDocumentChange,
  enqueueObserverSqlBatch,
  inspectObserverSqlOutbox,
  listSqlOutbox,
  retryObserverSqlOutbox,
} from '../src/observer-sql-publish.mjs';
import { makeObserverFixture } from './helpers/observer-fixture.mjs';

function prepareSession(fixture) {
  const logicalPath = '02-Sessões/2026/08-AGO/DIA 16/fixture.md';
  const transcript = join(fixture.projectRoot, 'fixture-transcript.jsonl');
  const subagent = join(fixture.projectRoot, 'fixture-subagent.jsonl');
  mkdirSync(join(fixture.vaultBase, dirname(logicalPath)), { recursive: true });
  writeFileSync(transcript, [
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' }, timestamp: '2026-08-20T10:00:00Z' }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', turn_id: 'turn-1', message: 'one' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', turn_id: 'turn-1', message: 'done' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
  ].join('\n'));
  writeFileSync(subagent, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'subagent done' }] } })}\n`);
  writeFileSync(join(fixture.vaultBase, logicalPath), [
    '---',
    'type: session',
    'session_id: fixture-session',
    'provider: codex',
    'status: done',
    `transcript_path: "${transcript.replaceAll('\\', '/')}"`,
    'observability_transcript_id: fixture-transcript',
    '---', '', '# Fixture session', '',
  ].join('\n'));
  const registryPath = join(fixture.vaultBase, '.brain', 'SESSION_REGISTRY.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  registry.sessions['fixture-session'].transcript_path = transcript;
  registry.sessions['fixture-session'].transcript_id = 'fixture-transcript';
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return { logicalPath, transcript, subagent };
}

test('[req:SQL-INCR-1] Stop scans one session, SessionStart only drains, and enqueue p95 stays below 200 ms', () => {
  const fixture = makeObserverFixture();
  try {
    prepareSession(fixture);
    const durations = [];
    for (let index = 0; index < 60; index += 1) {
      const started = performance.now();
      const batch = buildObserverSqlIncrementalBatch({
        vaultBase: fixture.vaultBase,
        projectId: fixture.projectId,
        input: { hook_event_name: 'Stop', session_id: 'fixture-session' },
        now: '2026-08-20T12:00:00Z',
        state: { files: {}, transcripts: {} },
      });
      enqueueObserverSqlBatch(fixture.vaultBase, {
        schema_version: 1,
        project_id: fixture.projectId,
        events: batch.events,
      }, { scope: batch.scope, now: '2026-08-20T12:00:00Z' });
      durations.push(performance.now() - started);
      assert.equal(batch.scanned, 1);
      assert.ok(batch.events.some((item) => item.kind === 'document.upsert'));
    }
    durations.sort((a, b) => a - b);
    assert.ok(durations[Math.ceil(durations.length * 0.95) - 1] < 200);
    const startup = buildObserverSqlIncrementalBatch({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      input: { hook_event_name: 'SessionStart', session_id: 'fixture-session' },
    });
    assert.equal(startup.scanned, 0);
    assert.deepEqual(startup.events, []);
  } finally { fixture.cleanup(); }
});

test('[req:SQL-INCR-2] SubagentStop reads only the affected transcript', () => {
  const fixture = makeObserverFixture();
  try {
    const { subagent } = prepareSession(fixture);
    const batch = buildObserverSqlIncrementalBatch({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      input: {
        hook_event_name: 'SubagentStop',
        session_id: 'fixture-session',
        agent_transcript_path: subagent,
        agent_transcript_id: 'fixture-subagent',
      },
      state: { files: {}, transcripts: {} },
      captureLevel: 'full-transcript',
    });
    const transcripts = batch.events.filter((item) => item.kind === 'transcript.upsert');
    assert.deepEqual(transcripts.map((item) => item.payload.transcript_id), ['fixture-subagent']);
    assert.equal(batch.scanned, 1);
  } finally { fixture.cleanup(); }
});

test('[req:SQL-INCR-3] writer events debounce by logical scope and expose outbox age/size', () => {
  const fixture = makeObserverFixture();
  try {
    const logicalPath = '04-Decisões/2026/08-AGO/ADR-incremental.md';
    mkdirSync(join(fixture.vaultBase, dirname(logicalPath)), { recursive: true });
    writeFileSync(join(fixture.vaultBase, logicalPath), '# First\n');
    enqueueObserverDocumentChange({ vaultBase: fixture.vaultBase, projectId: fixture.projectId, logicalPath, now: '2026-08-20T10:00:00Z' });
    writeFileSync(join(fixture.vaultBase, logicalPath), '# Second\n');
    enqueueObserverDocumentChange({ vaultBase: fixture.vaultBase, projectId: fixture.projectId, logicalPath, now: '2026-08-20T10:00:01Z' });
    const pending = listSqlOutbox(fixture.vaultBase);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].events.length, 1);
    assert.match(pending[0].events[0].payload.content, /Second/);
    const health = inspectObserverSqlOutbox(fixture.vaultBase, Date.parse('2026-08-20T10:00:05Z'));
    assert.equal(health.batches, 1);
    assert.equal(health.events, 1);
    assert.ok(health.bytes > 0);
    assert.equal(health.oldest_age_ms, 5000);
  } finally { fixture.cleanup(); }
});

test('[req:SQL-INCR-4] only one publisher lease drains an outbox', async () => {
  const fixture = makeObserverFixture();
  try {
    const logicalPath = '06-Aprendizados/2026/08-AGO/APR-0001-lease.md';
    mkdirSync(join(fixture.vaultBase, dirname(logicalPath)), { recursive: true });
    writeFileSync(join(fixture.vaultBase, logicalPath), '# Lease\n');
    enqueueObserverDocumentChange({ vaultBase: fixture.vaultBase, projectId: fixture.projectId, logicalPath });
    let releaseRequest;
    let requestStarted;
    const started = new Promise((resolve) => { requestStarted = resolve; });
    const first = retryObserverSqlOutbox({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      url: 'http://observer.test',
      fetchImpl: async () => {
        requestStarted();
        await new Promise((resolve) => { releaseRequest = resolve; });
        return { ok: true, status: 201, json: async () => ({ accepted: 1 }) };
      },
    });
    await started;
    const second = await retryObserverSqlOutbox({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      url: 'http://observer.test',
      fetchImpl: async () => { throw new Error('second publisher must not send'); },
    });
    assert.equal(second.busy, true);
    releaseRequest();
    const completed = await first;
    assert.equal(completed.confirmed, 1);
    assert.equal(listSqlOutbox(fixture.vaultBase).length, 0);
  } finally { fixture.cleanup(); }
});
