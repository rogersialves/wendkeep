import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_SNAPSHOT_FILE,
  MemoryEventCollision,
  MemoryLedgerCorruption,
  enqueueMemoryEvent,
  hashMemoryValue,
  projectMemoryOutbox,
  readMemoryLedger,
  readMemoryProjectionSnapshot,
  reprojectMemoryLedger,
} from '../hooks/memory-store.mjs';

const PROJECT_ID = 'project-snapshot';

function scratch() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-snapshot-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  writeFileSync(
    join(vault, '.brain', 'PROJECT.json'),
    `${JSON.stringify({ projectId: PROJECT_ID }, null, 2)}\n`,
  );
  return vault;
}

function memoryEvent(eventId, memoryKey, value, extra = {}) {
  return {
    v: 1,
    project_id: PROJECT_ID,
    event_id: eventId,
    memory_key: memoryKey,
    operation: 'assert',
    value,
    authority: 'verified',
    canonical_session_id: 'session-snapshot',
    activation_id: 'activation-snapshot',
    activation_epoch: 1,
    turn_sequence: 1,
    source_turn_id: `turn-${eventId}`,
    observed_at: '2026-08-26T02:00:00.000Z',
    evidence: ['snapshot-test'],
    ...extra,
  };
}

function snapshotFile(vault) {
  return join(vault, '.brain', MEMORY_SNAPSHOT_FILE);
}

test('[req:MEM-SNAPSHOT-1] first projection snapshots authority and unchanged replay reads only the tail', () => {
  const vault = scratch();
  try {
    enqueueMemoryEvent(vault, memoryEvent('mem-snapshot-001', 'next.snapshot-a', 'alpha'));
    const first = projectMemoryOutbox(vault);

    assert.equal(first.status, 'projected');
    assert.equal(first.replayMode, 'full');
    assert.equal(first.replayedEvents, 1);
    assert.equal(first.snapshotStatus, 'written');
    assert.equal(first.snapshotFallback, 'snapshot-missing');
    assert.equal(existsSync(snapshotFile(vault)), true);

    const anchored = readMemoryProjectionSnapshot(vault);
    assert.equal(anchored.status, 'ok');
    assert.equal(anchored.snapshot.event_count, 1);
    assert.equal(anchored.snapshot.through_event_id, 'mem-snapshot-001');
    assert.equal(anchored.tail.status, 'ok');
    assert.equal(anchored.tail.events.length, 0);

    const unchanged = projectMemoryOutbox(vault);
    assert.equal(unchanged.status, 'projected');
    assert.equal(unchanged.replayMode, 'snapshot-tail');
    assert.equal(unchanged.replayedEvents, 0);
    assert.equal(unchanged.appended, 0);
    assert.equal(unchanged.stateHash, first.stateHash);
    assert.equal(unchanged.snapshotStatus, 'deferred');

    enqueueMemoryEvent(vault, memoryEvent('mem-snapshot-002', 'next.snapshot-b', 'beta', {
      turn_sequence: 2,
      observed_at: '2026-08-26T02:01:00.000Z',
    }));
    const incremental = projectMemoryOutbox(vault);
    assert.equal(incremental.replayMode, 'snapshot-tail');
    assert.equal(incremental.replayedEvents, 1);
    assert.equal(incremental.appended, 1);
    assert.equal(incremental.snapshotStatus, 'deferred');
    assert.equal(readMemoryLedger(vault).events.length, 2);

    const withTail = readMemoryProjectionSnapshot(vault);
    assert.equal(withTail.status, 'ok');
    assert.deepEqual(withTail.tail.events.map((event) => event.event_id), ['mem-snapshot-002']);

    const reprojected = reprojectMemoryLedger(vault);
    assert.equal(reprojected.status, 'reprojected');
    assert.equal(reprojected.replayMode, 'snapshot-tail');
    assert.equal(reprojected.replayedEvents, 1);
    assert.match(readFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), 'utf8'), /alpha|beta/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-SNAPSHOT-2] forced snapshot advancement collapses the replay tail again', () => {
  const vault = scratch();
  try {
    enqueueMemoryEvent(vault, memoryEvent('mem-advance-001', 'next.advance-a', 'alpha'));
    projectMemoryOutbox(vault);
    enqueueMemoryEvent(vault, memoryEvent('mem-advance-002', 'next.advance-b', 'beta', {
      turn_sequence: 2,
      observed_at: '2026-08-26T02:02:00.000Z',
    }));

    const advanced = projectMemoryOutbox(vault, { snapshot: { force: true } });
    assert.equal(advanced.replayMode, 'snapshot-tail');
    assert.equal(advanced.snapshotStatus, 'written');
    assert.equal(advanced.snapshotEventCount, 2);

    const current = readMemoryProjectionSnapshot(vault);
    assert.equal(current.status, 'ok');
    assert.equal(current.snapshot.event_count, 2);
    assert.equal(current.snapshot.through_event_id, 'mem-advance-002');
    assert.equal(current.tail.events.length, 0);
    assert.equal(projectMemoryOutbox(vault).replayedEvents, 0);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-SNAPSHOT-3] corrupt snapshot or changed CORE falls back to full authority and rebuilds', () => {
  const vault = scratch();
  try {
    enqueueMemoryEvent(vault, memoryEvent('mem-rebuild-001', 'next.rebuild-a', 'alpha'));
    projectMemoryOutbox(vault);

    const corrupted = JSON.parse(readFileSync(snapshotFile(vault), 'utf8'));
    corrupted.projection.records['next.rebuild-a'].value = 'tampered';
    writeFileSync(snapshotFile(vault), `${JSON.stringify(corrupted, null, 2)}\n`);
    enqueueMemoryEvent(vault, memoryEvent('mem-rebuild-002', 'next.rebuild-b', 'beta', {
      turn_sequence: 2,
      observed_at: '2026-08-26T02:03:00.000Z',
    }));

    const repaired = projectMemoryOutbox(vault);
    assert.equal(repaired.replayMode, 'full');
    assert.equal(repaired.snapshotStatus, 'written');
    assert.equal(repaired.snapshotFallback, 'snapshot-schema');
    assert.doesNotMatch(readFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), 'utf8'), /tampered/);
    assert.equal(readMemoryProjectionSnapshot(vault).status, 'ok');

    writeFileSync(
      join(vault, '.brain', 'CORE.md'),
      '# Core\n\n<!-- wk-memory: constraint.snapshot="core-authority" -->\n',
    );
    enqueueMemoryEvent(vault, memoryEvent('mem-rebuild-003', 'next.rebuild-c', 'gamma', {
      turn_sequence: 3,
      observed_at: '2026-08-26T02:04:00.000Z',
    }));
    const coreChanged = projectMemoryOutbox(vault);
    assert.equal(coreChanged.replayMode, 'full');
    assert.equal(coreChanged.snapshotStatus, 'written');
    assert.equal(coreChanged.snapshotFallback, 'snapshot-schema');
    assert.equal(readMemoryLedger(vault).events.length, 3);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-SNAPSHOT-4] partial tail remains blocking and preserves the valid snapshot', () => {
  const vault = scratch();
  try {
    enqueueMemoryEvent(vault, memoryEvent('mem-tail-001', 'next.tail', 'alpha'));
    projectMemoryOutbox(vault);
    const before = readFileSync(snapshotFile(vault), 'utf8');
    appendFileSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl'), '{"v":1');

    assert.throws(() => reprojectMemoryLedger(vault), MemoryLedgerCorruption);
    assert.equal(readFileSync(snapshotFile(vault), 'utf8'), before);
    assert.equal(readMemoryProjectionSnapshot(vault).tail.status, 'corrupt');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-SNAPSHOT-5] non-monotonic or conflicting tail deterministically falls back to full replay', () => {
  const vault = scratch();
  try {
    const base = memoryEvent('mem-order-100', 'next.order-base', 'base', {
      turn_sequence: 100,
      observed_at: '2026-08-26T02:10:00.000Z',
    });
    enqueueMemoryEvent(vault, base);
    projectMemoryOutbox(vault);

    enqueueMemoryEvent(vault, memoryEvent('mem-order-001', 'next.order-older', 'older', {
      turn_sequence: 1,
      observed_at: '2026-08-26T02:00:00.000Z',
    }));
    const nonMonotonic = projectMemoryOutbox(vault);
    assert.equal(nonMonotonic.replayMode, 'full');
    assert.equal(nonMonotonic.snapshotFallback, 'non-monotonic-event-order');
    assert.equal(nonMonotonic.snapshotStatus, 'written');

    const revision = nonMonotonic.revision;
    const baseHash = hashMemoryValue(base.value);
    enqueueMemoryEvent(vault, memoryEvent('mem-conflict-a', 'next.order-base', 'left', {
      operation: 'replace',
      activation_id: 'activation-left',
      base_revision: 1,
      base_value_hash: baseHash,
      turn_sequence: 101,
      observed_at: '2026-08-26T02:11:00.000Z',
    }));
    enqueueMemoryEvent(vault, memoryEvent('mem-conflict-b', 'next.order-base', 'right', {
      operation: 'replace',
      activation_id: 'activation-right',
      base_revision: 1,
      base_value_hash: baseHash,
      turn_sequence: 101,
      observed_at: '2026-08-26T02:11:00.000Z',
    }));
    const conflict = projectMemoryOutbox(vault);
    assert.equal(conflict.replayMode, 'full');
    assert.equal(conflict.snapshotStatus, 'candidate-conflict');
    assert.equal(conflict.candidates, 1);
    assert.equal(conflict.revision, revision);
    assert.match(readFileSync(join(vault, '.brain', 'MEMORY_CANDIDATES.jsonl'), 'utf8'), /mem-conflict-a/);
    assert.match(readFileSync(join(vault, '.brain', 'MEMORY_CANDIDATES.jsonl'), 'utf8'), /mem-conflict-b/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-SNAPSHOT-6] prefix duplicate uses full proof and divergent payload still collides', () => {
  const vault = scratch();
  const original = memoryEvent('mem-prefix-duplicate', 'next.duplicate', 'alpha');
  try {
    enqueueMemoryEvent(vault, original);
    projectMemoryOutbox(vault);

    enqueueMemoryEvent(vault, original);
    const duplicate = projectMemoryOutbox(vault);
    assert.equal(duplicate.replayMode, 'full');
    assert.equal(duplicate.snapshotFallback, 'snapshot-bloom-hit');
    assert.equal(duplicate.appended, 0);
    assert.equal(duplicate.consumed, 1);
    assert.equal(readMemoryLedger(vault).events.length, 1);

    enqueueMemoryEvent(vault, { ...original, value: 'divergent' });
    assert.throws(() => projectMemoryOutbox(vault), MemoryEventCollision);
    assert.equal(existsSync(join(vault, '.brain', 'memory-outbox', 'mem-prefix-duplicate.json')), true);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-SNAPSHOT-7] snapshot hardlink is rejected before derived or external bytes change', (t) => {
  const vault = scratch();
  const outside = mkdtempSync(join(tmpdir(), 'wk-memory-snapshot-alias-'));
  try {
    enqueueMemoryEvent(vault, memoryEvent('mem-alias-001', 'next.alias', 'alpha'));
    projectMemoryOutbox(vault);
    const alias = join(outside, 'snapshot-alias.json');
    try {
      linkSync(snapshotFile(vault), alias);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    const externalBefore = readFileSync(alias);

    assert.throws(
      () => projectMemoryOutbox(vault),
      (error) => error?.code === 'VAULT_PATH_UNSAFE' && /hardlink|nlink|snapshot/i.test(error.message),
    );
    assert.deepEqual(readFileSync(alias), externalBefore);
    assert.equal(readMemoryLedger(vault).events.length, 1);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
