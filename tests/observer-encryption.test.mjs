import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  configureObserverDatabaseSecurity,
  ensureObserverDatabase,
  ingestObserverEvents,
  migrateObserverProtectedData,
  readTranscript,
  readUsageCalls,
  registerSqlProject,
} from '../src/observer-sql-store.mjs';
import {
  createObserverEncryption,
  decryptObserverValue,
  encryptObserverValue,
  observerEncryptionFromEnvironment,
} from '../packages/observer/src/encryption.mjs';
import { createObserverPolicy } from '../packages/observer/src/policy.mjs';
import { makeDataDir } from './helpers/observer-fixture.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { enqueueObserverSqlBatch, listSqlOutbox, publishObserverSqlIncremental } from '../src/observer-sql-publish.mjs';
import { startObserverServer } from '../src/observer-server.mjs';
import { resolveObserverPublisherSecurity } from '../src/observer-publish.mjs';

const KEY = Buffer.alloc(32, 7);
const WRONG_KEY = Buffer.alloc(32, 9);

function event(kind, eventId, payload) {
  return { schema_version: 1, event_id: eventId, kind, project_id: 'project-a', occurred_at: '2026-08-29T12:00:00.000Z', payload };
}

test('[req:OBS-SEC-CRYPT] AES-256-GCM uses an external key provider and fails closed for missing/wrong keys', () => {
  const encryption = createObserverEncryption({ required: true, keyId: 'key-1', keyProvider: () => KEY });
  const envelope = encryptObserverValue(encryption, 'private payload', { aad: 'project-a:transcript:t-1' });
  assert.equal(JSON.stringify(envelope).includes('private payload'), false);
  assert.equal(decryptObserverValue(encryption, envelope, { aad: 'project-a:transcript:t-1' }), 'private payload');
  assert.throws(
    () => decryptObserverValue(createObserverEncryption({ required: true, keyId: 'key-1', keyProvider: () => WRONG_KEY }), envelope, { aad: 'project-a:transcript:t-1' }),
    (error) => error.code === 'observer_decryption_failed',
  );
  assert.throws(
    () => encryptObserverValue(createObserverEncryption({ required: true, keyId: 'missing', keyProvider: () => null }), 'secret'),
    (error) => error.code === 'observer_encryption_key_unavailable',
  );
});

test('[req:OBS-SEC-CRYPT] server encryption material is resolved from the environment and required mode rejects absence', () => {
  assert.equal(observerEncryptionFromEnvironment({ env: {} }), null);
  assert.throws(
    () => observerEncryptionFromEnvironment({ env: {}, required: true }),
    (error) => error.code === 'observer_encryption_key_unavailable',
  );
  const adapter = observerEncryptionFromEnvironment({ env: {
    WENDKEEP_OBSERVER_ENCRYPTION_KEY: KEY.toString('base64'),
    WENDKEEP_OBSERVER_ENCRYPTION_KEY_ID: 'env-key-1',
  } });
  assert.equal(adapter.keyId, 'env-key-1');
  assert.equal(adapter.required, true);
});

test('[req:OBS-SEC-HOOK] hook defaults to metadata policy and fails before persistence for an invalid required outbox key', () => {
  const defaults = resolveObserverPublisherSecurity({ env: {} });
  assert.equal(defaults.policy.document_capture, 'metadata');
  assert.equal(defaults.policy.transcript_capture, 'metadata');
  assert.equal(defaults.outboxEncryption, null);
  assert.throws(
    () => resolveObserverPublisherSecurity({ env: { WENDKEEP_OBSERVER_OUTBOX_KEY_ENV: 'OBSERVER_KEY', OBSERVER_KEY: 'too-short' } }),
    (error) => error.code === 'observer_encryption_key_invalid',
  );
  const configured = resolveObserverPublisherSecurity({
    env: { WENDKEEP_OBSERVER_OUTBOX_KEY_ENV: 'OBSERVER_KEY', OBSERVER_KEY: KEY.toString('hex') },
  });
  assert.equal(configured.outboxEncryption.required, true);
});

test('[req:OBS-SEC-BACKFILL] existing plaintext rows are protected transactionally before required-encryption reads', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a' });
    const base = { session_id: 'session-a', agent_id: 'agent-a', role: 'main' };
    const events = [
      event('session.upsert', 'backfill-s', { session_id: 'session-a' }),
      event('agent.upsert', 'backfill-a', base),
      event('document.upsert', 'backfill-d', { logical_path: 'private.md', content: 'historical document secret', revision: 1, metadata: { note: 'historical document metadata secret' } }),
      event('llm_call', 'backfill-c', { ...base, call_id: 'call-backfill', prompt: 'historical prompt secret', response: 'historical response secret', metadata: { note: 'historical call metadata secret' } }),
      event('transcript.upsert', 'backfill-t', { ...base, transcript_id: 'transcript-backfill', content: 'historical transcript secret', metadata: { note: 'historical transcript metadata secret' } }),
    ];
    assert.equal(ingestObserverEvents(db, { projectId: 'project-a', events }).accepted, events.length);
    const encryption = createObserverEncryption({ required: true, keyId: 'key-1', keyProvider: () => KEY });
    configureObserverDatabaseSecurity(db, { encryption });
    const migrated = migrateObserverProtectedData(db, { projectId: 'project-a', encryption });
    assert.equal(migrated.protected_rows >= 3, true);
    const raw = JSON.stringify({
      documents: db.prepare('SELECT content, content_envelope, metadata_json FROM documents').all(),
      calls: db.prepare('SELECT prompt_text, response_text, prompt_envelope, response_envelope FROM llm_calls').all(),
      transcripts: db.prepare('SELECT codec, hex(content_gzip) AS content FROM transcripts').all(),
      ingest: db.prepare('SELECT payload_json FROM ingest_events').all(),
      memory: db.prepare('SELECT payload_json FROM memory_events').all(),
      chunks: db.prepare('SELECT content FROM document_chunks').all(),
    });
    for (const secret of [
      'historical document secret', 'historical prompt secret', 'historical response secret', 'historical transcript secret',
      'historical document metadata secret', 'historical call metadata secret', 'historical transcript metadata secret',
    ]) {
      assert.equal(raw.includes(secret), false, secret);
    }
    assert.equal(readUsageCalls(db, 'project-a').calls[0].prompt, 'historical prompt secret');
    assert.equal(readTranscript(db, 'project-a', 'transcript-backfill').content, 'historical transcript secret');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-BACKFILL] encrypted server startup protects pre-existing plaintext before accepting requests', async () => {
  const dataDir = makeDataDir();
  let db = ensureObserverDatabase(dataDir);
  registerSqlProject(db, { projectId: 'project-a' });
  ingestObserverEvents(db, {
    projectId: 'project-a',
    events: [event('document.upsert', 'startup-d', {
      logical_path: 'startup-private.md', content: 'startup plaintext secret', revision: 1,
    })],
  });
  db.close();
  const encryption = createObserverEncryption({ required: true, keyId: 'key-1', keyProvider: () => KEY });
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, security: { encryption } });
  try {
    const health = await (await fetch(`http://127.0.0.1:${server.address().port}/healthz`)).json();
    assert.equal(health.database.protected_data_migration.protected_rows, 1);
  } finally {
    await server.close();
  }
  db = ensureObserverDatabase(dataDir);
  try {
    const raw = JSON.stringify(db.prepare('SELECT content, content_envelope FROM documents').all());
    assert.equal(raw.includes('startup plaintext secret'), false);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-CRYPT] encrypted Observer store contains no transcript, prompt or response plaintext', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a' });
    const encryption = createObserverEncryption({ required: true, keyId: 'key-1', keyProvider: () => KEY });
    configureObserverDatabaseSecurity(db, { encryption });
    const base = { session_id: 'session-a', agent_id: 'agent-a', role: 'main' };
    const events = [
      event('session.upsert', 's-1', { session_id: 'session-a' }),
      event('agent.upsert', 'a-1', base),
      event('llm_call', 'c-1', { ...base, call_id: 'call-a', prompt: 'private prompt', response: 'private response' }),
      event('transcript.upsert', 't-1', { ...base, transcript_id: 'transcript-a', content: 'private transcript' }),
    ];
    assert.equal(ingestObserverEvents(db, { projectId: 'project-a', events }).accepted, events.length);
    const rawCall = db.prepare('SELECT prompt_text, response_text, prompt_envelope, response_envelope FROM llm_calls WHERE project_id = ?').get('project-a');
    const rawTranscript = db.prepare('SELECT codec, content_gzip FROM transcripts WHERE project_id = ?').get('project-a');
    assert.equal(`${rawCall.prompt_text}${rawCall.response_text}${rawCall.prompt_envelope}${rawCall.response_envelope}`.includes('private prompt'), false);
    assert.equal(Buffer.from(rawTranscript.content_gzip).toString('utf8').includes('private transcript'), false);
    assert.equal(readUsageCalls(db, 'project-a').calls[0].prompt, 'private prompt');
    assert.equal(readUsageCalls(db, 'project-a').calls[0].response, 'private response');
    assert.equal(readTranscript(db, 'project-a', 'transcript-a').content, 'private transcript');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-OUTBOX] protected publisher outbox never persists full content as plaintext', () => {
  const vaultBase = makeDataDir();
  const encryption = createObserverEncryption({ required: true, keyId: 'key-1', keyProvider: () => KEY });
  try {
    mkdirSync(join(vaultBase, '.brain'), { recursive: true });
    const queued = enqueueObserverSqlBatch(vaultBase, {
      schema_version: 1,
      project_id: 'project-a',
      events: [{
        schema_version: 1, event_id: 'event-secret', kind: 'transcript.upsert', project_id: 'project-a',
        occurred_at: '2026-08-29T12:00:00.000Z', payload: { transcript_id: 't-1', content: 'outbox private transcript' },
      }],
    }, { scope: 'security-test', now: new Date('2026-08-29T12:00:00.000Z'), encryption });
    assert.equal(readFileSync(queued.path, 'utf8').includes('outbox private transcript'), false);
    assert.equal(listSqlOutbox(vaultBase, { encryption })[0].events[0].payload.content, 'outbox private transcript');
    assert.throws(
      () => listSqlOutbox(vaultBase),
      (error) => error.code === 'observer_encryption_key_unavailable',
    );
  } finally {
    rmSync(vaultBase, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-CRYPT] encryption_required refuses plaintext ingestion and queue persistence', () => {
  const dataDir = makeDataDir();
  const vaultBase = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  const requiredPolicy = createObserverPolicy({ encryption_required: true, document_capture: 'full' });
  try {
    registerSqlProject(db, { projectId: 'project-a' });
    configureObserverDatabaseSecurity(db, { policy: requiredPolicy, enforcePolicy: true });
    assert.throws(
      () => ingestObserverEvents(db, { projectId: 'project-a', events: [event('document.upsert', 'required-d', {
        logical_path: 'private.md', content: 'must never persist', revision: 1,
      })] }),
      (error) => error.code === 'observer_encryption_required',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ingest_events').get().count, 0);
    assert.throws(
      () => enqueueObserverSqlBatch(vaultBase, {
        schema_version: 1, project_id: 'project-a', events: [event('document.upsert', 'required-q', {
          logical_path: 'queued.md', content: 'must never queue', revision: 1,
        })],
      }, { policy: requiredPolicy }),
      (error) => error.code === 'observer_encryption_required',
    );
    assert.equal(listSqlOutbox(vaultBase).length, 0);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(vaultBase, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-CRYPT] encryption_required publisher refuses before an unsafe outbox can be created', async () => {
  const vaultBase = makeDataDir();
  try {
    await assert.rejects(
      publishObserverSqlIncremental({
        vaultBase,
        projectId: 'project-a',
        url: 'http://127.0.0.1:1',
        policy: createObserverPolicy({ encryption_required: true }),
        outboxEncryption: null,
      }),
      (error) => error.code === 'observer_encryption_required',
    );
    assert.equal(listSqlOutbox(vaultBase).length, 0);
  } finally { rmSync(vaultBase, { recursive: true, force: true }); }
});
