import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  ensureObserverDatabase,
  ingestObserverEvents,
  registerSqlProject,
} from '../src/observer-sql-store.mjs';
import { purgeObserverData, verifyObserverPurgeReceipt } from '../packages/observer/src/purge.mjs';
import { runObserverRetention } from '../packages/observer/src/retention.mjs';
import { makeDataDir } from './helpers/observer-fixture.mjs';

function event(kind, eventId, payload, occurredAt) {
  return { schema_version: 1, event_id: eventId, kind, project_id: 'project-a', occurred_at: occurredAt, payload };
}

function seed(db) {
  const base = { session_id: 'session-a', agent_id: 'agent-a', role: 'main' };
  const old = '2026-06-01T00:00:00.000Z';
  const fresh = '2026-08-28T00:00:00.000Z';
  return ingestObserverEvents(db, { projectId: 'project-a', events: [
    event('session.upsert', 's-1', { session_id: 'session-a' }, old),
    event('agent.upsert', 'a-1', base, old),
    event('document.upsert', 'd-old', { logical_path: 'old.md', content: '# old', revision: 1 }, old),
    event('document.upsert', 'd-new', { logical_path: 'new.md', content: '# new', revision: 1 }, fresh),
    event('llm_call', 'c-old', { ...base, call_id: 'call-old', prompt: 'old prompt' }, old),
    event('llm_call', 'c-new', { ...base, call_id: 'call-new', prompt: 'new prompt' }, fresh),
    event('transcript.upsert', 't-old', { ...base, transcript_id: 'transcript-old', content: 'old transcript' }, old),
    event('transcript.upsert', 't-new', { ...base, transcript_id: 'transcript-new', content: 'new transcript' }, fresh),
  ] });
}

test('[req:OBS-SEC-PURGE] purge is transactional, removes derived indexes and emits an idempotent verifiable receipt', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a' });
    assert.equal(seed(db).accepted, 8);
    const options = {
      projectId: 'project-a', before: '2026-08-01T00:00:00.000Z',
      classes: ['documents', 'calls', 'transcripts'], now: '2026-08-29T12:00:00.000Z',
    };
    const dryRun = purgeObserverData(db, { ...options, dryRun: true });
    assert.deepEqual(dryRun.counts, { documents: 1, calls: 1, transcripts: 1 });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 2);

    assert.throws(
      () => purgeObserverData(db, { ...options, beforeCommit: () => { throw new Error('interrupted'); } }),
      /interrupted/,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM observer_purge_receipts').get().count, 0);

    const first = purgeObserverData(db, options);
    assert.equal(first.receipt_hash.startsWith('sha256:'), true);
    assert.equal(verifyObserverPurgeReceipt(first), true);
    assert.equal(verifyObserverPurgeReceipt({ ...first, counts: { ...first.counts, documents: 99 } }), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM document_chunks WHERE logical_path = 'old.md'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM evidence_chunks_fts WHERE logical_path = 'old.md'").get().count, 0);
    const replay = purgeObserverData(db, options);
    assert.equal(replay.receipt_id, first.receipt_id);
    assert.equal(replay.idempotent, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM observer_purge_receipts').get().count, 1);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-PURGE] committed purge receipt remains retriable after sink failure and late arrivals are removed', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  const options = {
    projectId: 'project-a', before: '2026-08-01T00:00:00.000Z', classes: ['documents'],
    now: '2026-08-29T12:00:00.000Z', operationId: 'daily-project-a-documents',
  };
  try {
    registerSqlProject(db, { projectId: 'project-a' });
    seed(db);
    assert.throws(
      () => purgeObserverData(db, { ...options, receiptSink: () => { throw new Error('sink unavailable'); } }),
      /sink unavailable/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM documents WHERE logical_path = 'old.md'").get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM observer_purge_receipts').get().count, 1);
    const delivered = [];
    const retry = purgeObserverData(db, { ...options, receiptSink: (receipt) => delivered.push(receipt.receipt_id) });
    assert.equal(retry.idempotent, true);
    assert.deepEqual(delivered, [retry.receipt_id]);

    assert.equal(ingestObserverEvents(db, { projectId: 'project-a', events: [event(
      'document.upsert', 'd-late', { logical_path: 'late.md', content: '# late', revision: 1 }, '2026-06-02T00:00:00.000Z',
    )] }).accepted, 1);
    const late = purgeObserverData(db, options);
    assert.notEqual(late.receipt_id, retry.receipt_id);
    assert.equal(late.counts.documents, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM documents WHERE logical_path = 'late.md'").get().count, 0);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-RETENTION] retention applies independent TTL classes with deterministic receipts', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a' });
    seed(db);
    const result = runObserverRetention(db, {
      projectId: 'project-a',
      policy: { documents: 30, calls: 30, transcripts: 30 },
      clock: () => new Date('2026-08-29T12:00:00.000Z'),
      operationId: 'daily-2026-08-29',
    });
    assert.equal(result.receipts.length, 3);
    assert.equal(result.receipts.every((receipt) => receipt.receipt_hash.startsWith('sha256:')), true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM llm_calls').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transcripts').get().count, 1);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
