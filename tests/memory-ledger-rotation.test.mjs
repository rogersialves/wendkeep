import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_LOCK_BUSY,
  MEMORY_ROTATION_JOURNAL_FILE,
  MemoryLedgerRotationBlocked,
  enqueueMemoryEvent,
  memoryLedgerRotationStatus,
  planMemoryLedgerRotation,
  projectMemoryOutbox,
  readMemoryLedger,
  readMemoryLedgerGeneration,
  readMemoryProjectionSnapshot,
  readMemoryRotationJournal,
  readMemoryRotationReceipts,
  recoverMemoryLedgerRotation,
  rotateMemoryLedger,
  sealMemorySegments,
  verifyMemorySegments,
  withMemoryLock,
} from '../hooks/memory-store.mjs';

const PROJECT_ID = 'project-rotation';

function scratch() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-rotation-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  writeFileSync(
    join(vault, '.brain', 'PROJECT.json'),
    `${JSON.stringify({ projectId: PROJECT_ID }, null, 2)}\n`,
  );
  return vault;
}

function memoryEvent(index, extra = {}) {
  const suffix = String(index).padStart(3, '0');
  return {
    v: 1,
    project_id: PROJECT_ID,
    event_id: `mem-rotation-${suffix}`,
    memory_key: `next.rotation-${suffix}`,
    operation: 'assert',
    value: `value-${suffix}`,
    authority: 'verified',
    canonical_session_id: 'session-rotation',
    activation_id: 'activation-rotation',
    activation_epoch: 1,
    turn_sequence: index,
    source_turn_id: `turn-rotation-${suffix}`,
    observed_at: `2026-08-26T04:${String(index).padStart(2, '0')}:00.000Z`,
    evidence: ['rotation-test'],
    ...extra,
  };
}

function seed(vault, from, to) {
  for (let index = from; index <= to; index += 1) enqueueMemoryEvent(vault, memoryEvent(index));
  const projected = projectMemoryOutbox(vault, { snapshot: { force: true } });
  assert.equal(projected.status, 'projected');
  const sealed = sealMemorySegments(vault, { maxEvents: 2, force: true });
  assert.ok(['sealed', 'noop'].includes(sealed.status));
  assert.equal(verifyMemorySegments(vault).status, 'ok');
  return { projected, sealed };
}

function activeLedgerPath(vault) { return join(vault, '.brain', 'MEMORY_EVENTS.jsonl'); }
function generationPath(vault) { return join(vault, '.brain', 'MEMORY_LEDGER_GENERATION.json'); }
function receiptsPath(vault) { return join(vault, '.brain', 'MEMORY_ROTATION_RECEIPTS.jsonl'); }
function checkpointPath(vault) { return join(vault, '.brain', 'MEMORY_ROTATION_RECEIPTS.checkpoint.json'); }
function journalPath(vault) { return join(vault, '.brain', MEMORY_ROTATION_JOURNAL_FILE); }
function candidatePath(vault, operationId) {
  return join(vault, '.brain', `MEMORY_ROTATION_CANDIDATE.${operationId}.jsonl`);
}
function backups(vault) {
  const dir = join(vault, '.brain', 'memory-ledger-generations');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort() : [];
}

function applyOptions(extra = {}) {
  return {
    apply: true,
    reason: 'reduce active replay cost while retaining the complete source backup',
    authorizedBy: 'repository-maintainer',
    now: '2026-08-26T05:00:00.000Z',
    ...extra,
  };
}

test('[req:MEM-ROT-1] dry-run is byte-identical and reports the retained-backup policy', () => {
  const vault = scratch();
  try {
    seed(vault, 1, 5);
    const before = {
      ledger: readFileSync(activeLedgerPath(vault)),
      snapshot: readFileSync(join(vault, '.brain', 'MEMORY_SNAPSHOT.json')),
      manifest: readFileSync(join(vault, '.brain', 'MEMORY_SEGMENTS.json')),
    };

    const preview = planMemoryLedgerRotation(vault, {
      reason: 'preview rotation',
      authorizedBy: 'maintainer',
      now: '2026-08-26T05:00:00.000Z',
    });
    assert.equal(preview.status, 'preview');
    assert.equal(preview.apply, false);
    assert.equal(preview.sourceEvents, 5);
    assert.equal(preview.policy, 'retain-source-backup');
    assert.ok(preview.activeBytesAfter < preview.activeBytesBefore);
    assert.equal(preview.backupBytes, preview.sourceBytes);
    assert.equal(existsSync(generationPath(vault)), false);
    assert.equal(existsSync(receiptsPath(vault)), false);
    assert.equal(existsSync(journalPath(vault)), false);
    assert.deepEqual(readFileSync(activeLedgerPath(vault)), before.ledger);
    assert.deepEqual(readFileSync(join(vault, '.brain', 'MEMORY_SNAPSHOT.json')), before.snapshot);
    assert.deepEqual(readFileSync(join(vault, '.brain', 'MEMORY_SEGMENTS.json')), before.manifest);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-ROT-2] apply keeps a full immutable backup and compacts the active ledger to one anchor', () => {
  const vault = scratch();
  try {
    seed(vault, 1, 5);
    const source = readMemoryLedger(vault);
    const physicalBytesBefore = readFileSync(activeLedgerPath(vault)).length;
    const rotated = rotateMemoryLedger(vault, applyOptions());

    assert.equal(rotated.status, 'rotated');
    assert.equal(rotated.apply, true);
    assert.equal(rotated.generation, 1);
    assert.equal(rotated.sourceEvents, 5);
    assert.equal(rotated.activeBytesBefore, physicalBytesBefore);
    assert.equal(rotated.reclaimedActiveBytes, physicalBytesBefore - rotated.activeBytesAfter);
    assert.equal(rotated.backupRetained, true);
    assert.equal(rotated.policy, 'retain-source-backup');
    assert.equal(existsSync(journalPath(vault)), false);
    assert.equal(backups(vault).length, 1);
    assert.ok(readFileSync(activeLedgerPath(vault)).length < physicalBytesBefore);
    assert.equal(readFileSync(activeLedgerPath(vault), 'utf8').trimEnd().split('\n').length, 1);

    const logical = readMemoryLedger(vault);
    assert.equal(logical.status, 'ok');
    assert.deepEqual(logical.events.map((event) => event.event_id), source.events.map((event) => event.event_id));
    assert.equal(logical.activeTailEvents.length, 0);

    const generation = readMemoryLedgerGeneration(vault);
    const snapshot = readMemoryProjectionSnapshot(vault);
    assert.equal(generation.status, 'ok');
    assert.equal(generation.state.generation, 1);
    assert.equal(generation.state.source_event_count, 5);
    assert.equal(snapshot.status, 'ok');
    assert.equal(generation.state.snapshot_hash, snapshot.snapshot.snapshot_hash);
    assert.equal(snapshot.snapshot.ledger_generation_operation_id, generation.state.operation_id);
    assert.equal(snapshot.snapshot.ledger_generation_source_hash, generation.state.source_ledger_hash);
    assert.equal(Object.hasOwn(snapshot.snapshot, 'ledger_generation_state_hash'), false);

    const receipts = readMemoryRotationReceipts(vault);
    assert.equal(receipts.status, 'ok');
    assert.equal(receipts.checkpointStatus, 'ok');
    assert.equal(receipts.receipts.length, 1);
    assert.equal(receipts.receipts[0].generation_state_hash, generation.state.state_hash);
    assert.equal(memoryLedgerRotationStatus(vault).status, 'ok');

    const noopProjection = projectMemoryOutbox(vault);
    assert.equal(noopProjection.status, 'projected');
    assert.equal(noopProjection.replayMode, 'snapshot-tail');
    assert.equal(noopProjection.replayedEvents, 0);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-ROT-3] new events append after the anchor and a second generation remains fully readable', () => {
  const vault = scratch();
  try {
    seed(vault, 1, 4);
    rotateMemoryLedger(vault, applyOptions());

    enqueueMemoryEvent(vault, memoryEvent(5, {
      observed_at: '2026-08-26T05:01:00.000Z',
    }));
    const appended = projectMemoryOutbox(vault, { snapshot: { force: true } });
    assert.equal(appended.status, 'projected');
    assert.equal(readMemoryLedger(vault).events.length, 5);
    assert.equal(readMemoryLedger(vault).activeTailEvents.length, 1);
    assert.equal(readFileSync(activeLedgerPath(vault), 'utf8').trimEnd().split('\n').length, 2);

    const sealed = sealMemorySegments(vault, { maxEvents: 2, force: true });
    assert.equal(sealed.coveredEvents, 5);
    const second = rotateMemoryLedger(vault, applyOptions({
      now: '2026-08-26T05:02:00.000Z',
    }));
    assert.equal(second.status, 'rotated');
    assert.equal(second.generation, 2);
    assert.equal(backups(vault).length, 2);
    assert.equal(readMemoryLedger(vault).events.length, 5);
    assert.equal(readMemoryLedger(vault).activeTailEvents.length, 0);
    assert.equal(readMemoryRotationReceipts(vault).receipts.length, 2);
    assert.equal(readMemoryLedgerGeneration(vault).state.generation, 2);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

for (const stage of ['after-prepared', 'after-switch', 'after-state', 'after-snapshot', 'after-receipt']) {
  test(`[req:MEM-ROT-4] crash at ${stage} keeps a recoverable chain and converges`, () => {
    const vault = scratch();
    try {
      seed(vault, 1, 4);
      assert.throws(
        () => rotateMemoryLedger(vault, applyOptions({ faultAt: stage })),
        /Injected memory-rotation fault/,
      );
      const pending = readMemoryRotationJournal(vault);
      assert.equal(pending.status, 'ok');
      assert.equal(recoverMemoryLedgerRotation(vault).status, 'preview');
      if (stage !== 'after-prepared') assert.equal(readMemoryLedger(vault).status, 'corrupt');

      const recovered = recoverMemoryLedgerRotation(vault, { apply: true });
      assert.equal(recovered.status, 'rotated');
      assert.equal(existsSync(journalPath(vault)), false);
      assert.equal(readMemoryLedger(vault).status, 'ok');
      assert.equal(readMemoryLedger(vault).events.length, 4);
      assert.equal(readMemoryRotationReceipts(vault).receipts.length, 1);
      assert.equal(backups(vault).length, 1);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
}

test('[req:MEM-ROT-4] crash after journal removal leaves only a safe candidate cleanup', () => {
  const vault = scratch();
  try {
    seed(vault, 1, 4);
    assert.throws(
      () => rotateMemoryLedger(vault, applyOptions({ faultAt: 'after-journal-removal' })),
      /Injected memory-rotation fault/,
    );

    const generation = readMemoryLedgerGeneration(vault);
    assert.equal(generation.status, 'ok');
    assert.equal(readMemoryRotationJournal(vault).status, 'missing');
    assert.equal(readMemoryLedger(vault).status, 'ok');
    assert.equal(readMemoryRotationReceipts(vault).receipts.length, 1);
    assert.equal(existsSync(candidatePath(vault, generation.state.operation_id)), true);

    const preview = recoverMemoryLedgerRotation(vault);
    assert.equal(preview.status, 'preview');
    assert.equal(preview.stage, 'candidate-cleanup');
    assert.equal(preview.operationId, generation.state.operation_id);

    const finalized = recoverMemoryLedgerRotation(vault, { apply: true });
    assert.equal(finalized.status, 'finalized');
    assert.equal(finalized.recoveryRequired, false);
    assert.equal(existsSync(candidatePath(vault, generation.state.operation_id)), false);
    assert.equal(readMemoryLedger(vault).status, 'ok');
    assert.equal(readMemoryRotationReceipts(vault).receipts.length, 1);
    assert.equal(backups(vault).length, 1);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-ROT-5] apply requires explicit authority and a live memory lock serializes rotations', () => {
  const vault = scratch();
  try {
    seed(vault, 1, 3);
    assert.throws(
      () => rotateMemoryLedger(vault, { apply: true }),
      (error) => error instanceof MemoryLedgerRotationBlocked
        && error.errors.some((item) => /reason/.test(item))
        && error.errors.some((item) => /authorizedBy/.test(item)),
    );

    const nested = withMemoryLock(vault, () => rotateMemoryLedger(vault, applyOptions({
      lock: { timeoutMs: 20, pollMs: 5 },
    })));
    assert.equal(nested.status, 'busy');
    assert.notEqual(nested, MEMORY_LOCK_BUSY);
    assert.equal(existsSync(generationPath(vault)), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-ROT-6] tampered backup or receipt checkpoint blocks the logical ledger without deleting evidence', () => {
  const vault = scratch();
  try {
    seed(vault, 1, 3);
    rotateMemoryLedger(vault, applyOptions());
    const backup = join(vault, '.brain', 'memory-ledger-generations', backups(vault)[0]);
    const originalBackup = readFileSync(backup, 'utf8');
    writeFileSync(backup, originalBackup.replace('value-001', 'backup-tampered'));
    const invalidBackup = readMemoryLedger(vault);
    assert.equal(invalidBackup.status, 'corrupt');
    assert.match(invalidBackup.errors.map((error) => error.message).join('\n'), /backup hash mismatch/);
    assert.match(readFileSync(backup, 'utf8'), /backup-tampered/);

    writeFileSync(backup, originalBackup);
    const checkpoint = JSON.parse(readFileSync(checkpointPath(vault), 'utf8'));
    checkpoint.last_hash = 'f'.repeat(64);
    writeFileSync(checkpointPath(vault), `${JSON.stringify(checkpoint, null, 2)}\n`);
    const invalidReceipt = readMemoryLedger(vault);
    assert.equal(invalidReceipt.status, 'corrupt');
    assert.match(invalidReceipt.errors.map((error) => error.message).join('\n'), /checkpoint/);
    assert.equal(existsSync(receiptsPath(vault)), true);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-ROT-7] hardlinked backup is rejected before external bytes or active generation change', (t) => {
  const vault = scratch();
  const outside = mkdtempSync(join(tmpdir(), 'wk-memory-rotation-alias-'));
  try {
    seed(vault, 1, 3);
    const preview = planMemoryLedgerRotation(vault, {
      reason: 'preview alias test',
      authorizedBy: 'maintainer',
      now: '2026-08-26T05:00:00.000Z',
    });
    const external = join(outside, 'external-backup.jsonl');
    writeFileSync(external, preview.plan.sourceContent);
    const backup = join(vault, '.brain', ...preview.plan.backupFile.split('/'));
    mkdirSync(join(vault, '.brain', 'memory-ledger-generations'), { recursive: true });
    try {
      linkSync(external, backup);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    const externalBefore = readFileSync(external);
    const ledgerBefore = readFileSync(activeLedgerPath(vault));

    assert.throws(
      () => rotateMemoryLedger(vault, applyOptions()),
      (error) => error?.code === 'VAULT_PATH_UNSAFE' && /hardlink|nlink|backup/i.test(error.message),
    );
    assert.deepEqual(readFileSync(external), externalBefore);
    assert.deepEqual(readFileSync(activeLedgerPath(vault)), ledgerBefore);
    assert.equal(existsSync(generationPath(vault)), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
