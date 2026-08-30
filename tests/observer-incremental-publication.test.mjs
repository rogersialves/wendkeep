import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  buildObserverSqlIncrementalBatch,
  enqueueObserverDocumentChange,
  enqueueObserverSqlBatch,
  inspectObserverSqlOutbox,
  listSqlOutbox,
  observerSqlRequestTimeoutMs,
  retryObserverSqlOutbox,
  SQL_LEASE_STALE_MS,
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
      now: '2026-08-20T12:00:00Z',
    });
    const transcripts = batch.events.filter((item) => item.kind === 'transcript.upsert');
    const calls = batch.events.filter((item) => item.kind === 'llm_call');
    assert.deepEqual(transcripts.map((item) => item.payload.transcript_id), ['fixture-subagent']);
    assert.deepEqual(calls.map((item) => [item.occurred_at, item.payload.occurred_at]), [
      ['2026-08-20T12:00:00.000Z', '2026-08-20T12:00:00.000Z'],
    ]);
    assert.equal(batch.scanned, 1);
  } finally { fixture.cleanup(); }
});

test('[req:SQL-INCR-2] transcript call timestamps canonicalize epoch milliseconds and reject invalid input', () => {
  const fixture = makeObserverFixture();
  try {
    const { subagent } = prepareSession(fixture);
    writeFileSync(subagent, `${JSON.stringify({
      type: 'assistant',
      timestamp: Date.parse('2026-08-20T11:00:00Z'),
      message: { content: [{ type: 'text', text: 'subagent done' }] },
    })}\n`);
    const input = {
      hook_event_name: 'SubagentStop',
      session_id: 'fixture-session',
      agent_transcript_path: subagent,
      agent_transcript_id: 'fixture-subagent',
    };
    const batch = buildObserverSqlIncrementalBatch({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      input,
      state: { files: {}, transcripts: {} },
      captureLevel: 'full-transcript',
      now: '2026-08-20T12:00:00Z',
    });
    const call = batch.events.find((item) => item.kind === 'llm_call');
    assert.equal(call.occurred_at, '2026-08-20T11:00:00.000Z');
    assert.equal(call.payload.occurred_at, '2026-08-20T11:00:00.000Z');

    writeFileSync(subagent, `${JSON.stringify({
      type: 'assistant',
      timestamp: 'not-a-date',
      message: { content: [{ type: 'text', text: 'subagent done' }] },
    })}\n`);
    assert.throws(() => buildObserverSqlIncrementalBatch({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      input,
      state: { files: {}, transcripts: {} },
      captureLevel: 'full-transcript',
      now: '2026-08-20T12:00:00Z',
    }), /occurred_at inválido/);
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

test('[req:SQL-INCR-3] coalescing preserves every operational entity in one session', () => {
  const fixture = makeObserverFixture();
  try {
    const base = {
      schema_version: 1,
      project_id: fixture.projectId,
      occurred_at: '2026-08-20T12:00:00Z',
    };
    const events = [
      { ...base, event_id: 'call-event-1', kind: 'llm_call', payload: { session_id: 'same-session', call_id: 'call-1' } },
      { ...base, event_id: 'call-event-2', kind: 'llm_call', payload: { session_id: 'same-session', call_id: 'call-2' } },
      { ...base, event_id: 'agent-event-1', kind: 'agent.upsert', payload: { session_id: 'same-session', agent_id: 'agent-1' } },
      { ...base, event_id: 'agent-event-2', kind: 'agent.upsert', payload: { session_id: 'same-session', agent_id: 'agent-2' } },
      { ...base, event_id: 'rollup-event-1', kind: 'usage.rollup', payload: { session_id: 'same-session', rollup_key: 'rollup-1' } },
      { ...base, event_id: 'rollup-event-2', kind: 'usage.rollup', payload: { session_id: 'same-session', rollup_key: 'rollup-2' } },
      { ...base, event_id: 'transcript-event-1', kind: 'transcript.upsert', payload: { session_id: 'same-session', transcript_id: 'transcript-1' } },
      { ...base, event_id: 'transcript-event-2', kind: 'transcript.upsert', payload: { session_id: 'same-session', transcript_id: 'transcript-2' } },
    ];
    enqueueObserverSqlBatch(fixture.vaultBase, {
      schema_version: 1, project_id: fixture.projectId, events,
    }, { scope: 'session:same-session' });
    const pending = listSqlOutbox(fixture.vaultBase);
    assert.equal(pending.length, 1);
    assert.deepEqual(new Set(pending[0].events.map((event) => event.event_id)), new Set(events.map((event) => event.event_id)));
  } finally { fixture.cleanup(); }
});

test('[req:SQL-INCR-4] a live batch lease outlives the maximum request timeout', () => {
  const fixture = makeObserverFixture();
  try {
    const event = {
      schema_version: 1,
      event_id: 'lease-event-1',
      kind: 'document.upsert',
      project_id: fixture.projectId,
      occurred_at: '2026-08-20T12:00:00Z',
      payload: { logical_path: 'CORE.md', revision: 1 },
    };
    enqueueObserverSqlBatch(fixture.vaultBase, {
      schema_version: 1, project_id: fixture.projectId, events: [event],
    }, { scope: 'lease-duration' });
    const livePath = listSqlOutbox(fixture.vaultBase)[0].path;
    const lockPath = `${livePath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ token: 'still-live' }));
    const sixtyOneSecondsAgo = new Date(Date.now() - 61_000);
    utimesSync(lockPath, sixtyOneSecondsAgo, sixtyOneSecondsAgo);

    const fallback = enqueueObserverSqlBatch(fixture.vaultBase, {
      schema_version: 1,
      project_id: fixture.projectId,
      events: [{ ...event, event_id: 'lease-event-2', payload: { logical_path: 'DIGEST.md', revision: 1 } }],
    }, { scope: 'lease-duration' });

    assert.ok(SQL_LEASE_STALE_MS > observerSqlRequestTimeoutMs(1024 * 1024 * 1024));
    assert.equal(fallback.coalesced, false);
    assert.equal(existsSync(lockPath), true);
    assert.equal(JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')).token, 'still-live');
  } finally { fixture.cleanup(); }
});
