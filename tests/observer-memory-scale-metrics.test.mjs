import assert from 'node:assert/strict';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MEMORY_SNAPSHOT_FILE,
  enqueueMemoryEvent,
  projectMemoryOutbox,
  rotateMemoryLedger,
  sealMemorySegments,
} from '../hooks/memory-store.mjs';
import {
  buildProjectSnapshot,
  validateObserverSnapshot,
} from '../src/observer-snapshot.mjs';
import {
  ensureObserverDatabase,
  readSqlProjectOverview,
  registerSqlProject,
  upsertSqlProjectSnapshot,
} from '../src/observer-sql-store.mjs';
import { renderCoreSkeleton } from '../src/validate-core.mjs';
import {
  makeDataDir,
  makeObserverFixture,
} from './helpers/observer-fixture.mjs';

const PROJECT_ID = 'observer-memory-scale';

function memoryEvent(index) {
  const suffix = String(index).padStart(3, '0');
  return {
    v: 1,
    project_id: PROJECT_ID,
    event_id: `mem-observer-scale-${suffix}`,
    memory_key: 'next.observer-scale',
    operation: 'assert',
    value: `observer-scale-${suffix}`,
    authority: 'verified',
    canonical_session_id: 'fixture-session',
    activation_id: 'observer-scale-activation',
    activation_epoch: 1,
    turn_sequence: index,
    source_turn_id: `observer-scale-turn-${suffix}`,
    observed_at: `2026-08-26T06:${String(index).padStart(2, '0')}:00.000Z`,
    evidence: ['observer-memory-scale-metrics.test.mjs'],
  };
}

function prepareFixture() {
  const fixture = makeObserverFixture({
    projectId: PROJECT_ID,
    projectName: 'Observer Memory Scale',
  });
  writeFileSync(
    join(fixture.vaultBase, '.brain', 'CORE.md'),
    renderCoreSkeleton(),
  );
  return fixture;
}

function seed(vaultBase, index, { snapshot = false } = {}) {
  enqueueMemoryEvent(vaultBase, memoryEvent(index));
  return projectMemoryOutbox(
    vaultBase,
    snapshot ? { snapshot: { force: true } } : {},
  );
}

test('[req:OBS-SCALE-1] Observer persists the same bounded memory scale metrics as doctor', () => {
  const fixture = prepareFixture();
  const dataDir = makeDataDir();
  let db;
  try {
    const first = seed(fixture.vaultBase, 1, { snapshot: true });
    assert.equal(first.snapshotStatus, 'written');
    const sealed = sealMemorySegments(fixture.vaultBase, {
      maxEvents: 1,
      maxBytes: 1024 * 1024,
      force: true,
    });
    assert.equal(sealed.coveredEvents, 1);
    const rotated = rotateMemoryLedger(fixture.vaultBase, {
      apply: true,
      reason: 'validar métricas de escala no Observer',
      authorizedBy: 'observer-scale-test',
      now: '2026-08-26T06:30:00.000Z',
    });
    assert.equal(rotated.status, 'rotated');

    const second = seed(fixture.vaultBase, 2);
    assert.equal(second.replayMode, 'snapshot-tail');
    assert.equal(second.replayedEvents, 1);

    const snapshot = buildProjectSnapshot({
      vaultBase: fixture.vaultBase,
      projectRoot: fixture.projectRoot,
      now: '2026-08-26T07:00:00.000Z',
    });
    const scale = snapshot.health.memory_scale;
    assert.equal(scale.schema_version, 1);
    assert.equal(scale.status, 'healthy');
    assert.deepEqual(scale.snapshot, {
      status: 'ok',
      event_count: 1,
      ledger_bytes: scale.snapshot.ledger_bytes,
      tail_events: 1,
      tail_bytes: scale.snapshot.tail_bytes,
    });
    assert.ok(scale.snapshot.ledger_bytes > 0);
    assert.ok(scale.snapshot.tail_bytes > 0);
    assert.deepEqual(scale.segments, {
      status: 'ok',
      count: 1,
      covered_events: 1,
      covered_bytes: scale.segments.covered_bytes,
      pending_events: 1,
    });
    assert.ok(scale.segments.covered_bytes > 0);
    assert.deepEqual(scale.generation, {
      status: 'ok',
      number: 1,
      source_events: 1,
      active_tail_events: 1,
      rotated_at: '2026-08-26T06:30:00.000Z',
    });
    assert.deepEqual(scale.rotation, {
      journal: 'missing',
      recovery_required: false,
      receipts_status: 'ok',
      receipts: 1,
      receipt_checkpoint: 'ok',
    });
    assert.equal(validateObserverSnapshot(snapshot, { projectId: PROJECT_ID }).ok, true);

    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(fixture.vaultBase), false);
    assert.equal(serialized.includes('observer-scale-001'), false);
    assert.equal(serialized.includes('observer-scale-002'), false);

    db = ensureObserverDatabase(dataDir);
    const registered = registerSqlProject(db, {
      projectId: PROJECT_ID,
      projectName: fixture.projectName,
      wendkeepVersion: snapshot.wendkeep_version,
    });
    assert.equal(registered.registered, true);
    assert.equal(upsertSqlProjectSnapshot(db, snapshot).accepted, true);
    const overview = readSqlProjectOverview(db, PROJECT_ID);
    assert.deepEqual(overview.snapshot.health.memory_scale, scale);
  } finally {
    db?.close();
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SCALE-2] unsafe scale artifacts publish only blocked sanitized metadata', (t) => {
  const fixture = prepareFixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-observer-scale-outside-'));
  try {
    seed(fixture.vaultBase, 1, { snapshot: true });
    const snapshotPath = join(fixture.vaultBase, '.brain', MEMORY_SNAPSHOT_FILE);
    try {
      linkSync(snapshotPath, join(outside, 'snapshot-hardlink.json'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    const snapshot = buildProjectSnapshot({
      vaultBase: fixture.vaultBase,
      projectRoot: fixture.projectRoot,
      now: '2026-08-26T07:30:00.000Z',
    });
    assert.equal(snapshot.health.ok, false);
    assert.equal(snapshot.health.status, 'blocked');
    assert.equal(snapshot.health.memory_scale.status, 'blocked');
    assert.equal(snapshot.health.memory_scale.error_code, 'VAULT_PATH_UNSAFE');
    assert.equal(validateObserverSnapshot(snapshot, { projectId: PROJECT_ID }).ok, true);

    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(fixture.vaultBase), false);
    assert.equal(serialized.includes(outside), false);
    assert.equal(serialized.includes('snapshot-hardlink.json'), false);
  } finally {
    fixture.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});
