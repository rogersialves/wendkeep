import assert from 'node:assert/strict';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
  augmentVaultHealthWithMemoryScale,
  inspectMemoryScaleHealth,
} from '../src/memory-scale-health.mjs';
import { renderVaultHealthLines } from '../src/doctor.mjs';

const PROJECT_ID = 'doctor-memory-scale';

function scratch() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-doctor-memory-scale-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  writeFileSync(
    join(vault, '.brain', 'PROJECT.json'),
    `${JSON.stringify({ projectId: PROJECT_ID }, null, 2)}\n`,
  );
  return vault;
}

function memoryEvent(index) {
  const suffix = String(index).padStart(3, '0');
  return {
    v: 1,
    project_id: PROJECT_ID,
    event_id: `mem-doctor-scale-${suffix}`,
    memory_key: 'next.doctor-scale',
    operation: 'assert',
    value: `doctor-scale-${suffix}`,
    authority: 'verified',
    canonical_session_id: 'doctor-scale-session',
    activation_id: 'doctor-scale-activation',
    activation_epoch: 1,
    turn_sequence: index,
    source_turn_id: `doctor-scale-turn-${suffix}`,
    observed_at: `2026-08-26T04:${String(index).padStart(2, '0')}:00.000Z`,
    evidence: ['doctor-memory-scale-metrics.test.mjs'],
  };
}

function seed(vault, from, to, { snapshot = false } = {}) {
  for (let index = from; index <= to; index += 1) {
    enqueueMemoryEvent(vault, memoryEvent(index));
  }
  return projectMemoryOutbox(vault, snapshot ? { snapshot: { force: true } } : {});
}

function baseHealth(ledgerEvents) {
  return {
    ok: true,
    session: '',
    failures: [],
    warnings: [],
    memoryStatus: 'healthy',
    metrics: {
      registrySessions: 0,
      derivedNotes: 0,
      memory: {
        schemaVersion: 2,
        revision: ledgerEvents,
        eventCursor: `mem-doctor-scale-${String(ledgerEvents).padStart(3, '0')}`,
        stateHash: 'a'.repeat(64),
        ledgerEvents,
        pendingOutbox: 0,
        candidates: 0,
        activeConflicts: 0,
        repairableHandoffs: 0,
        semanticCode: 'healthy',
        semanticActiveKeys: ['next.doctor-scale'],
        semanticProjectedKeys: ['next.doctor-scale'],
        semanticMissingKeys: [],
      },
    },
  };
}

function byteSnapshot(vault) {
  const entries = [];
  const walk = (dir, rel = '') => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const itemRel = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, itemRel);
      else entries.push([itemRel, readFileSync(path)]);
    }
  };
  walk(join(vault, '.brain'));
  return entries;
}

test('[req:MEM-SCALE-3] doctor exposes snapshot, segment and generation coverage read-only', () => {
  const vault = scratch();
  try {
    const projected = seed(vault, 1, 4, { snapshot: true });
    assert.equal(projected.snapshotStatus, 'written');
    const sealed = sealMemorySegments(vault, {
      maxEvents: 2,
      maxBytes: 1024 * 1024,
      force: true,
    });
    assert.equal(sealed.coveredEvents, 4);

    const before = byteSnapshot(vault);
    const initial = augmentVaultHealthWithMemoryScale(baseHealth(4), vault);
    assert.deepEqual(byteSnapshot(vault), before, 'doctor scale inspection must be read-only');
    assert.equal(initial.metrics.memory.scaleStatus, 'healthy');
    assert.equal(initial.metrics.memory.snapshotStatus, 'ok');
    assert.equal(initial.metrics.memory.snapshotEvents, 4);
    assert.equal(initial.metrics.memory.snapshotTailEvents, 0);
    assert.equal(initial.metrics.memory.segmentStatus, 'ok');
    assert.equal(initial.metrics.memory.segmentCount, 2);
    assert.equal(initial.metrics.memory.segmentCoveredEvents, 4);
    assert.equal(initial.metrics.memory.segmentPendingEvents, 0);
    assert.equal(initial.metrics.memory.generationStatus, 'missing');
    assert.equal(initial.metrics.memory.rotationJournal, 'missing');
    assert.equal(initial.metrics.memory.rotationReceipts, 0);

    const rendered = renderVaultHealthLines(initial).join('\n');
    assert.match(rendered, /replay: snapshot saudável/i);
    assert.match(rendered, /segmentos: saudável.*2 segmento\(s\).*cobertos: 4/i);
    assert.match(rendered, /rotação: geração ausente #0.*journal: ausente/i);

    const rotated = rotateMemoryLedger(vault, {
      apply: true,
      reason: 'validar métricas de escala do doctor',
      authorizedBy: 'doctor-scale-test',
      now: '2026-08-26T05:00:00.000Z',
    });
    assert.equal(rotated.status, 'rotated');

    const afterRotation = augmentVaultHealthWithMemoryScale(baseHealth(4), vault);
    assert.equal(afterRotation.metrics.memory.generationStatus, 'ok');
    assert.equal(afterRotation.metrics.memory.generation, 1);
    assert.equal(afterRotation.metrics.memory.generationSourceEvents, 4);
    assert.equal(afterRotation.metrics.memory.generationActiveTailEvents, 0);
    assert.equal(afterRotation.metrics.memory.rotationJournal, 'missing');
    assert.equal(afterRotation.metrics.memory.rotationRecoveryRequired, false);
    assert.equal(afterRotation.metrics.memory.rotationReceiptsStatus, 'ok');
    assert.equal(afterRotation.metrics.memory.rotationReceipts, 1);
    assert.equal(afterRotation.metrics.memory.rotationReceiptCheckpoint, 'ok');

    const incremental = seed(vault, 5, 5);
    assert.equal(incremental.replayMode, 'snapshot-tail');
    assert.equal(incremental.replayedEvents, 1);
    const withTail = augmentVaultHealthWithMemoryScale(baseHealth(5), vault);
    assert.equal(withTail.metrics.memory.snapshotEvents, 4);
    assert.equal(withTail.metrics.memory.snapshotTailEvents, 1);
    assert.equal(withTail.metrics.memory.segmentCoveredEvents, 4);
    assert.equal(withTail.metrics.memory.segmentPendingEvents, 1);
    assert.equal(withTail.metrics.memory.generationActiveTailEvents, 1);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-SCALE-4] unsafe optional scale artifact blocks doctor with a safe command', (t) => {
  const vault = scratch();
  const outside = mkdtempSync(join(tmpdir(), 'wk-doctor-memory-scale-outside-'));
  try {
    seed(vault, 1, 1, { snapshot: true });
    const snapshot = join(vault, '.brain', MEMORY_SNAPSHOT_FILE);
    const alias = join(outside, 'snapshot-alias.json');
    try {
      linkSync(snapshot, alias);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    const before = byteSnapshot(vault);

    assert.throws(
      () => inspectMemoryScaleHealth(vault, { ledgerEvents: 1 }),
      (error) => error?.code === 'VAULT_PATH_UNSAFE',
    );
    const result = augmentVaultHealthWithMemoryScale(baseHealth(1), vault);
    assert.equal(result.ok, false);
    assert.equal(result.memoryStatus, 'blocked');
    assert.equal(result.metrics.memory.scaleStatus, 'blocked');
    assert.match(result.failures.join('\n'), /Artefatos de escala da memória.*inseguros/i);
    assert.ok(result.failures.join('\n').includes(
      `npx --no-install wendkeep memory status --gate --vault "${vault}"`,
    ));
    assert.deepEqual(byteSnapshot(vault), before, 'blocked inspection must remain read-only');
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
