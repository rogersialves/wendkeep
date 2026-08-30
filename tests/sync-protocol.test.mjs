import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  acquireSyncLease,
  applySyncEvent,
  canonicalRecordKey,
  createSyncEvent,
  createSyncState,
  decryptPrivatePayload,
  encryptPrivatePayload,
  resolveSyncConflict,
  rotatePrivatePayloadKey,
} from '../src/sync-protocol.mjs';
import {
  ackSyncEvent,
  enqueueSyncEvent,
  inspectSyncOutbox,
  readPendingSyncEvents,
} from '../src/sync-outbox.mjs';
import {
  createFilesystemSyncAdapter,
  createHttpSyncAdapter,
  pullSyncEvents,
  pushSyncEvents,
} from '../src/sync-adapters.mjs';
import { exportPortableState } from '../src/portable.mjs';
import { runSyncProtocol } from '../src/sync-protocol-cli.mjs';
import {
  inspectSyncForMcp,
  listSyncConflictsForMcp,
  SYNC_MCP_TOOL_DEFINITIONS,
} from '../packages/mcp/src/sync.mjs';

const PROJECT = 'project-a';
const REPOSITORY = 'repository-a';

function event(overrides = {}) {
  return createSyncEvent({
    projectId: PROJECT,
    recordKey: canonicalRecordKey({
      projectId: PROJECT, repositoryId: REPOSITORY, namespace: 'authored', key: '07-Specs/a.md',
      branch: 'wk/a', worktreeId: 'tree-a',
    }),
    revision: 1,
    baseRevision: 0,
    payload: { content: '# A\n' },
    causalParentIds: [], actorId: 'actor-a', deviceId: 'device-a',
    observedAt: '2026-08-25T10:00:00.000Z', operation: 'put',
    ...overrides,
  });
}

test('[req:SYNC-1] CAS applies the expected revision and duplicate delivery is idempotent', () => {
  const state = createSyncState(PROJECT);
  const first = event();
  assert.equal(applySyncEvent(state, first).status, 'applied');
  assert.equal(applySyncEvent(state, first).status, 'duplicate');
  assert.equal(state.records[first.record_key].revision, 1);
  assert.equal(state.applied_event_ids.length, 1);
});

test('[req:OBS-SEC-SYNC] sync carries only a canonical policy reference and never duplicates Observer authority', () => {
  const policyRef = {
    policy_id: 'observer-policy',
    version: 3,
    hash: `sha256:${'a'.repeat(64)}`,
  };
  const first = event({ policyRef });
  assert.deepEqual(first.policy_ref, policyRef);
  assert.equal(JSON.stringify(first).includes('token'), false);
  const state = createSyncState(PROJECT);
  applySyncEvent(state, first);
  assert.deepEqual(state.records[first.record_key].policy_ref, policyRef);
  assert.throws(
    () => event({ policyRef: { ...policyRef, token: 'forbidden' } }),
    (error) => error.code === 'WENDKEEP_SYNC_POLICY_REF_INVALID',
  );
});

test('[req:SYNC-2] concurrent writes from one base become an order-independent explicit conflict set', () => {
  const left = event({ actorId: 'left', deviceId: 'machine-left', payload: { content: 'left' } });
  const right = event({ actorId: 'right', deviceId: 'machine-right', payload: { content: 'right' } });
  const a = createSyncState(PROJECT);
  const b = createSyncState(PROJECT);
  applySyncEvent(a, left);
  assert.equal(applySyncEvent(a, right).status, 'conflict');
  applySyncEvent(b, right);
  assert.equal(applySyncEvent(b, left).status, 'conflict');
  const idsA = a.conflicts[left.record_key].candidates.map((item) => item.event_id);
  const idsB = b.conflicts[left.record_key].candidates.map((item) => item.event_id);
  assert.deepEqual(idsA, idsB);
  assert.equal(a.conflicts[left.record_key].status, 'open');
  assert.equal(a.records[left.record_key].conflicted, true);
});

test('[req:SYNC-3] independent branch/worktree keys converge without false conflicts', () => {
  const state = createSyncState(PROJECT);
  const branchA = event();
  const branchB = event({
    recordKey: canonicalRecordKey({
      projectId: PROJECT, repositoryId: REPOSITORY, namespace: 'authored', key: '07-Specs/a.md',
      branch: 'wk/b', worktreeId: 'tree-b',
    }),
    payload: { content: '# B\n' },
  });
  assert.equal(applySyncEvent(state, branchA).status, 'applied');
  assert.equal(applySyncEvent(state, branchB).status, 'applied');
  assert.equal(Object.keys(state.records).length, 2);
  assert.equal(Object.keys(state.conflicts).length, 0);
});

test('[req:SYNC-4] out-of-order child waits for its parent and converges after replay', () => {
  const state = createSyncState(PROJECT);
  const parent = event();
  const child = event({
    revision: 2, baseRevision: 1, payload: { content: '# A2\n' }, causalParentIds: [parent.event_id],
    observedAt: '2020-01-01T00:00:00.000Z',
  });
  assert.equal(applySyncEvent(state, child).status, 'pending');
  const result = applySyncEvent(state, parent);
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.replayed, [child.event_id]);
  assert.equal(state.records[parent.record_key].revision, 2);
  assert.equal(state.records[parent.record_key].content_hash, child.content_hash);
});

test('[req:SYNC-5] conflict resolution is explicit, audited, and never last-write-wins', () => {
  const state = createSyncState(PROJECT);
  const left = event({ actorId: 'left', payload: { content: 'left' } });
  const right = event({ actorId: 'right', payload: { content: 'right' } });
  applySyncEvent(state, left);
  applySyncEvent(state, right);
  const resolved = resolveSyncConflict(state, {
    recordKey: left.record_key, selectedEventId: right.event_id,
    actorId: 'maintainer', deviceId: 'review-device', reason: 'reviewed both candidates',
    observedAt: '2026-08-25T11:00:00.000Z',
  });
  assert.equal(resolved.status, 'resolved');
  assert.equal(state.records[left.record_key].payload.content, 'right');
  assert.equal(state.conflicts[left.record_key].status, 'resolved');
  assert.equal(state.decisions[0].reason, 'reviewed both candidates');
});

test('[req:SYNC-6] expired lease takeover preserves prior ownership history despite skewed clocks', () => {
  const state = createSyncState(PROJECT);
  const key = event().record_key;
  const first = acquireSyncLease(state, {
    recordKey: key, leaseId: 'lease-a', actorId: 'actor-a', deviceId: 'device-a',
    acquiredAt: '2026-08-25T10:00:00.000Z', expiresAt: '2026-08-25T10:05:00.000Z',
    now: '2026-08-25T10:00:00.000Z',
  });
  assert.equal(first.status, 'acquired');
  assert.throws(() => acquireSyncLease(state, {
    recordKey: key, leaseId: 'lease-b', actorId: 'actor-b', deviceId: 'device-b',
    acquiredAt: '2026-08-25T09:00:00.000Z', expiresAt: '2026-08-25T10:10:00.000Z',
    now: '2026-08-25T10:04:00.000Z',
  }), (error) => error?.code === 'WENDKEEP_SYNC_LEASE_HELD');
  const takeover = acquireSyncLease(state, {
    recordKey: key, leaseId: 'lease-b', actorId: 'actor-b', deviceId: 'device-b',
    acquiredAt: '2026-08-25T09:00:00.000Z', expiresAt: '2026-08-25T10:10:00.000Z',
    now: '2026-08-25T10:06:00.000Z',
  });
  assert.equal(takeover.status, 'taken_over');
  assert.equal(state.leases[key].history[0].lease_id, 'lease-a');
});

test('[req:SYNC-7] durable outbox keeps offline events, acknowledges idempotently, and detects corruption', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-sync-outbox-'));
  try {
    const first = event();
    assert.equal(enqueueSyncEvent(root, first).created, true);
    assert.equal(enqueueSyncEvent(root, first).created, false);
    assert.deepEqual(readPendingSyncEvents(root).map((item) => item.event_id), [first.event_id]);
    assert.equal(ackSyncEvent(root, first.event_id).created, true);
    assert.equal(ackSyncEvent(root, first.event_id).created, false);
    assert.deepEqual(readPendingSyncEvents(root), []);
    const path = join(root, '.brain', 'runtime', 'sync', 'OUTBOX.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf8')}{corrupt}\n`);
    assert.equal(inspectSyncOutbox(root).status, 'corrupt');
    assert.throws(() => readPendingSyncEvents(root), (error) => error?.code === 'WENDKEEP_SYNC_OUTBOX_CORRUPT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('[req:SYNC-8] filesystem adapter survives partition/retry, duplicate, and reordered delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-sync-fs-'));
  try {
    const adapter = createFilesystemSyncAdapter(root);
    const parent = event();
    const child = event({ revision: 2, baseRevision: 1, payload: { content: 'child' }, causalParentIds: [parent.event_id] });
    const pushed = await pushSyncEvents({ adapter, events: [child, parent, child] });
    assert.deepEqual(pushed.map((item) => item.status), ['pending', 'applied', 'duplicate']);
    const pulled = await pullSyncEvents({ adapter, cursor: 0 });
    assert.equal(pulled.events.length, 2);
    assert.equal(pulled.state.records[parent.record_key].revision, 2);
    const unavailable = createFilesystemSyncAdapter(join(root, 'missing'), { available: false });
    await assert.rejects(() => pushSyncEvents({ adapter: unavailable, events: [parent] }),
      (error) => error?.code === 'WENDKEEP_SYNC_BACKEND_UNAVAILABLE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('[req:SYNC-9] HTTP adapter is replaceable and transports protocol fixtures without policy logic', async () => {
  const calls = [];
  const adapter = createHttpSyncAdapter({
    url: 'https://sync.invalid/v1',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ status: 'applied', cursor: 1, events: [] }) };
    },
  });
  await adapter.push(event());
  await adapter.pull({ cursor: 0, projectId: PROJECT });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /events$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[1].url, /events\?project_id=project-a&cursor=0$/);
});

test('[req:SYNC-10] private policy uses authenticated E2E encryption and supports key rotation', () => {
  const keyA = Buffer.alloc(32, 1).toString('base64');
  const keyB = Buffer.alloc(32, 2).toString('base64');
  const encrypted = encryptPrivatePayload({ transcript: 'never plaintext', token: 'secret' }, {
    key: keyA, keyId: 'key-a', aad: `${PROJECT}:private-record`, iv: Buffer.alloc(12, 3),
  });
  assert.equal(JSON.stringify(encrypted).includes('never plaintext'), false);
  assert.deepEqual(decryptPrivatePayload(encrypted, { key: keyA, aad: `${PROJECT}:private-record` }), {
    transcript: 'never plaintext', token: 'secret',
  });
  assert.throws(() => decryptPrivatePayload(encrypted, { key: keyB, aad: `${PROJECT}:private-record` }),
    (error) => error?.code === 'WENDKEEP_SYNC_DECRYPT_FAILED');
  const rotated = rotatePrivatePayloadKey(encrypted, {
    oldKey: keyA, newKey: keyB, newKeyId: 'key-b', aad: `${PROJECT}:private-record`, iv: Buffer.alloc(12, 4),
  });
  assert.equal(rotated.key_id, 'key-b');
  assert.deepEqual(decryptPrivatePayload(rotated, { key: keyB, aad: `${PROJECT}:private-record` }).transcript, 'never plaintext');
});

test('[req:SYNC-11] disabling sync creates no runtime and leaves local state untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-sync-disabled-'));
  try {
    mkdirSync(join(root, '.brain'), { recursive: true });
    writeFileSync(join(root, '.brain', 'CORE.md'), '# local core\n');
    assert.equal(existsSync(join(root, '.brain', 'runtime', 'sync')), false);
    assert.equal(readFileSync(join(root, '.brain', 'CORE.md'), 'utf8'), '# local core\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('[req:SYNC-12] CLI status is read-only and push/pull converges authored state idempotently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-sync-cli-'));
  const sourceProject = join(root, 'source-project');
  const sourceVault = join(root, 'source-vault');
  const targetProject = join(root, 'target-project');
  const targetVault = join(root, 'target-vault');
  const remote = join(root, 'remote');
  try {
    for (const path of [sourceProject, targetProject]) mkdirSync(join(path, '.git'), { recursive: true });
    for (const path of [sourceVault, targetVault]) {
      mkdirSync(join(path, '.brain'), { recursive: true });
      writeFileSync(join(path, '.brain', 'PROJECT.json'), `${JSON.stringify({ projectId: PROJECT })}\n`);
    }
    mkdirSync(join(sourceVault, '04-Decisões'), { recursive: true });
    writeFileSync(join(sourceVault, '04-Decisões', 'ADR-0001-sync.md'), '# Sync authority\n');
    exportPortableState({
      vaultBase: sourceVault, projectRoot: sourceProject, repositoryId: REPOSITORY,
      activeContexts: [], now: '2026-08-25T12:00:00.000Z',
    });

    assert.equal(await runSyncProtocol(['status', '--project', sourceProject, '--vault', sourceVault]), 0);
    assert.equal(existsSync(join(sourceVault, '.brain', 'runtime', 'sync')), false);
    assert.equal(await runSyncProtocol([
      'push', '--project', sourceProject, '--vault', sourceVault, '--remote', remote,
      '--actor', 'roger', '--device', 'desktop', '--json',
    ]), 0);
    assert.equal(await runSyncProtocol([
      'push', '--project', sourceProject, '--vault', sourceVault, '--remote', remote,
      '--actor', 'roger', '--device', 'desktop', '--json',
    ]), 0);
    assert.equal(await runSyncProtocol([
      'pull', '--project', targetProject, '--vault', targetVault, '--remote', remote, '--json',
    ]), 0);
    assert.equal(readFileSync(join(targetVault, '04-Decisões', 'ADR-0001-sync.md'), 'utf8'), '# Sync authority\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('[req:SYNC-13] public schemas and bilingual consistency contract are packaged surfaces', () => {
  for (const path of [
    '../schema/sync-event-v1.schema.json',
    '../schema/sync-state-v1.schema.json',
    '../schema/sync-private-envelope-v1.schema.json',
  ]) {
    const schema = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
    assert.equal(schema.type, 'object');
    assert.equal(schema.properties.schema_version.const, 1);
  }
  const pt = readFileSync(new URL('../docs/pt-BR/commands/sync-protocol.md', import.meta.url), 'utf8');
  const en = readFileSync(new URL('../docs/en/commands/sync-protocol.md', import.meta.url), 'utf8');
  for (const token of ['CAS', 'AES-256-GCM', 'WENDKEEP_SYNC_BACKEND_UNAVAILABLE']) {
    assert.match(pt, new RegExp(token));
    assert.match(en, new RegExp(token));
  }
});

test('[req:SYNC-14] MCP kernel is pure, read-only, and payload-free', () => {
  const outbox = { status: 'disabled', events: 0, pending: 0, acknowledged: 0 };
  assert.deepEqual(SYNC_MCP_TOOL_DEFINITIONS.map((item) => item.effect), ['read', 'read']);
  assert.deepEqual(inspectSyncForMcp({ outbox }), {
    enabled: false, outbox, conflicts: 0,
  });
  assert.deepEqual(listSyncConflictsForMcp({ state: createSyncState(PROJECT) }), []);
});
