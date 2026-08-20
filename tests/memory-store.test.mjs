import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryEventCollision,
  MemoryLedgerCorruption,
  canonicalMemoryJson,
  deriveMemoryProjection,
  enqueueMemoryEvent,
  hashMemoryValue,
  memoryFileIdentityMatches,
  prepareMemoryProjection,
  projectMemoryOutbox,
  readMemoryLedger,
  reduceMemoryEvents,
  reprojectMemoryLedger,
  repairMemoryLedger,
} from '../hooks/memory-store.mjs';

const PROJECT_ID = 'project-a';

test('[req:OP-10] file identity tolerates only the known Windows volume serial mismatch', () => {
  const descriptor = { dev: 11n, ino: 9007199254740993n };
  const sameVolumeIdentity = { dev: 11n, ino: 9007199254740993n };
  const inconsistentWindowsVolume = { dev: 22n, ino: 9007199254740993n };
  const replacedFile = { dev: 11n, ino: 9007199254740995n };

  assert.equal(memoryFileIdentityMatches(descriptor, sameVolumeIdentity, { platform: 'linux' }), true);
  assert.equal(memoryFileIdentityMatches(descriptor, inconsistentWindowsVolume, { platform: 'linux' }), false);
  assert.equal(memoryFileIdentityMatches(descriptor, inconsistentWindowsVolume, { platform: 'win32' }), true);
  assert.equal(memoryFileIdentityMatches(descriptor, replacedFile, { platform: 'win32' }), false);
});

function scratch() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-store-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  return vault;
}

function event(eventId, memoryKey, operation, value, extra = {}) {
  return {
    v: 1,
    project_id: PROJECT_ID,
    event_id: eventId,
    memory_key: memoryKey,
    operation,
    value,
    authority: 'verified',
    canonical_session_id: 'session-1',
    activation_id: 'activation-1',
    turn_sequence: 1,
    observed_at: '2026-07-26T12:00:00.000Z',
    evidence: ['ADR-0107'],
    ...extra,
  };
}

function deferredAssertReplayFixture({ assertOverrides = {}, correctionOverrides = {} } = {}) {
  const selected = event('mem-replay-selected', 'handoff.latest', 'assert', 'resumo promovido', {
    canonical_session_id: 'replay-session',
    activation_id: 'replay-activation',
    activation_epoch: 7,
    turn_sequence: 1,
    source_turn_id: 'replay-turn-1',
    observed_at: '2026-07-26T12:01:00.000Z',
  });
  const competing = event('mem-replay-competing', 'handoff.latest', 'assert', 'resumo concorrente', {
    canonical_session_id: 'competing-session',
    activation_id: 'competing-activation',
    activation_epoch: 7,
    turn_sequence: 1,
    source_turn_id: 'competing-turn-1',
    observed_at: '2026-07-26T12:02:00.000Z',
  });
  const initialCandidate = reduceMemoryEvents([selected, competing]).candidates[0];
  const legacyPromotion = event(
    'mem-replay-legacy-promotion', 'handoff.latest', 'replace', selected.value, {
      canonical_session_id: undefined,
      activation_id: selected.activation_id,
      activation_epoch: selected.activation_epoch,
      turn_sequence: selected.turn_sequence,
      observed_at: '2026-07-26T12:04:00.000Z',
      candidate_decision: {
        candidate_id: initialCandidate.candidate_id,
        action: 'promote',
        event_ids: [...initialCandidate.event_ids],
        selected_event_id: selected.event_id,
      },
      supersedes: [...initialCandidate.event_ids],
    },
  );
  const correction = event(
    'mem-replay-modern-correction', 'handoff.latest', 'replace', selected.value, {
      canonical_session_id: selected.canonical_session_id,
      activation_id: selected.activation_id,
      activation_epoch: selected.activation_epoch,
      turn_sequence: selected.turn_sequence,
      source_turn_id: selected.source_turn_id,
      observed_at: '2026-07-26T12:06:00.000Z',
      supersedes: [...initialCandidate.event_ids, legacyPromotion.event_id],
      ...correctionOverrides,
    },
  );
  const deferredAssert = event(
    'mem-replay-physical-late', 'handoff.latest', 'assert', 'resumo do Stop posterior', {
      canonical_session_id: selected.canonical_session_id,
      activation_id: selected.activation_id,
      activation_epoch: selected.activation_epoch,
      turn_sequence: 2,
      source_turn_id: 'replay-turn-2',
      observed_at: '2026-07-26T12:05:00.000Z',
      ...assertOverrides,
    },
  );
  return {
    selected,
    competing,
    legacyPromotion,
    correction,
    deferredAssert,
    events: [selected, competing, legacyPromotion, correction, deferredAssert],
  };
}

function transientDeferredCandidate(fixture) {
  return reduceMemoryEvents([
    fixture.selected,
    fixture.competing,
    fixture.legacyPromotion,
    fixture.deferredAssert,
  ]).candidates.find((candidate) => candidate.event_ids.includes(fixture.deferredAssert.event_id));
}

function transientNames(vault) {
  return readdirSync(join(vault, '.brain'), { recursive: true })
    .map(String)
    .filter((name) => /\.tmp$|\.lock$/i.test(name));
}

function flatSnapshot(dir) {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => [entry.name, entry.isDirectory()
      ? '<directory>'
      : readFileSync(join(dir, entry.name)).toString('base64')]));
}

function makeAlias(t, source, target, type = 'hardlink') {
  try {
    if (type === 'hardlink') linkSync(source, target);
    else symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
      t.skip(`${type}s indisponíveis neste filesystem: ${error.code}`);
      return false;
    }
    throw error;
  }
}

test('[req:MEM-HYB-4] reducer is idempotent and preserves independent patches', () => {
  const events = [
    event('mem-1', 'next.ui', 'assert', 'review'),
    event('mem-2', 'blocker.e2e', 'assert', 'postgres-not-ready'),
  ];

  const once = reduceMemoryEvents(events);
  const twice = reduceMemoryEvents([...events, events[0], events[1]]);

  assert.deepEqual(twice, once, 'duplicate IDs are exact no-ops');
  assert.deepEqual(once.state, {
    'blocker.e2e': 'postgres-not-ready',
    'next.ui': 'review',
  });
  assert.equal(once.appliedEventIds.length, 2);
  assert.equal(once.candidates.length, 0);
});

test('[req:MEM-HYB-4] concurrent scalar patches preserve the common base and both values', () => {
  const base = event('mem-1', 'next.ui', 'assert', 'review');
  const baseHash = hashMemoryValue('review');
  const approve = event('mem-2', 'next.ui', 'replace', 'approve', {
    activation_id: 'activation-2', base_revision: 1, base_value_hash: baseHash,
  });
  const discard = event('mem-3', 'next.ui', 'replace', 'discard', {
    activation_id: 'activation-3', base_revision: 1, base_value_hash: baseHash,
  });

  const forward = reduceMemoryEvents([base, approve, discard]);
  const reverse = reduceMemoryEvents([base, discard, approve]);

  assert.equal(forward.state['next.ui'], 'review', 'published scalar stays at common base');
  assert.deepEqual(reverse, forward, 'arrival order cannot choose a scalar winner');
  assert.equal(forward.candidates.length, 1);
  assert.equal(forward.candidates[0].reason, 'conflict');
  assert.deepEqual(forward.candidates[0].event_ids, ['mem-2', 'mem-3']);
  assert.deepEqual(forward.candidates[0].values, ['approve', 'discard']);
});

test('[req:MEM-HYB-11] pending conflict keeps independent state and renders a safe review marker', () => {
  const base = event('mem-review-base', 'next.ui', 'assert', 'review', {
    activation_id: 'activation-review-base',
    activation_epoch: 1,
    source_turn_id: 'turn-review-base',
  });
  const baseHash = hashMemoryValue(base.value);
  const approve = event('mem-review-approve', 'next.ui', 'replace', 'approve', {
    activation_id: 'activation-review-approve',
    activation_epoch: 1,
    source_turn_id: 'turn-review-approve',
    base_revision: 1,
    base_value_hash: baseHash,
  });
  const discard = event('mem-review-discard', 'next.ui', 'replace', 'discard', {
    activation_id: 'activation-review-discard',
    activation_epoch: 1,
    source_turn_id: 'turn-review-discard',
    base_revision: 1,
    base_value_hash: baseHash,
  });
  const independent = event('mem-review-independent', 'objective.current', 'assert', 'continue');
  const events = [base, approve, discard, independent];
  const reduced = reduceMemoryEvents(events);

  assert.equal(reduced.state['next.ui'], 'review', 'conflict keeps the last known common base');
  assert.equal(reduced.state['objective.current'], 'continue');
  assert.equal(reduced.candidates.length, 1);
  assert.deepEqual(reduced.candidates[0].event_ids, ['mem-review-approve', 'mem-review-discard']);

  const vault = scratch();
  try {
    const prepared = prepareMemoryProjection(vault, events);
    assert.match(prepared.sharedContent, /revis[aã]o pendente.*next\.ui/i);
    assert.match(prepared.sharedContent, /candidates?:\s*1/i);
    assert.match(prepared.sharedContent, /continue/);
    assert.doesNotMatch(prepared.sharedContent, /approve|discard/);
    assert.match(prepared.candidatesContent, /mem-review-approve/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-HYB-4] stale same-activation event is superseded and tombstone keeps provenance', () => {
  const base = event('mem-1', 'blocker.e2e', 'assert', 'postgres-not-ready', {
    turn_sequence: 5,
  });
  const stale = event('mem-2', 'blocker.e2e', 'replace', 'ready', {
    turn_sequence: 4,
    base_revision: 1,
    base_value_hash: hashMemoryValue('postgres-not-ready'),
  });
  const removed = event('mem-3', 'next.ui', 'assert', 'review', { turn_sequence: 6 });
  const tombstone = event('mem-4', 'next.ui', 'remove', null, {
    turn_sequence: 7,
    base_revision: 1,
    base_value_hash: hashMemoryValue('review'),
  });

  const reduced = reduceMemoryEvents([base, stale, removed, tombstone]);

  assert.equal(reduced.state['blocker.e2e'], 'postgres-not-ready');
  assert.equal('next.ui' in reduced.state, false);
  assert.deepEqual(reduced.superseded, [{ event_id: 'mem-2', by_event_id: 'mem-1' }]);
  assert.deepEqual(reduced.tombstones['next.ui'], {
    event_id: 'mem-4', removed_event_id: 'mem-3', value_hash: hashMemoryValue('review'),
  });
});

test('[req:MEM-HYB-4] newer same-session activation turn supersedes an older handoff deterministically', () => {
  const older = event('mem-handoff-1', 'handoff.latest', 'assert', 'primeiro resumo', {
    activation_id: 'activation-handoff',
    turn_sequence: 1,
    observed_at: '2026-07-26T12:00:00.000Z',
  });
  const newer = event('mem-handoff-2', 'handoff.latest', 'assert', 'segundo resumo', {
    activation_id: 'activation-handoff',
    turn_sequence: 2,
    observed_at: '2026-07-26T12:01:00.000Z',
  });

  const forward = reduceMemoryEvents([older, newer]);
  const reverse = reduceMemoryEvents([newer, older]);

  assert.deepEqual(reverse, forward, 'ledger replay order cannot change the causal winner');
  assert.equal(forward.state['handoff.latest'], 'segundo resumo');
  assert.equal(forward.records['handoff.latest'].source.event_id, 'mem-handoff-2');
  assert.deepEqual(forward.superseded, [{ event_id: 'mem-handoff-1', by_event_id: 'mem-handoff-2' }]);
  assert.equal(forward.candidates.length, 0);
});

test('[req:MEM-CUR-2] compatibilidade legacy mantém precedência sem source_turn_id', () => {
  const older = event('mem-legacy-handoff-1', 'handoff.latest', 'assert', 'legacy primeiro', {
    canonical_session_id: 'legacy-session',
    activation_id: 'legacy-activation',
    source_turn_id: undefined,
    turn_sequence: 1,
  });
  const newer = event('mem-legacy-handoff-2', 'handoff.latest', 'assert', 'legacy segundo', {
    canonical_session_id: 'legacy-session',
    activation_id: 'legacy-activation',
    source_turn_id: undefined,
    turn_sequence: 2,
  });

  const reduced = reduceMemoryEvents([older, newer]);

  assert.equal(older.source_turn_id, undefined);
  assert.equal(newer.source_turn_id, undefined);
  assert.equal(reduced.records['handoff.latest'].source.event_id, newer.event_id);
  assert.deepEqual(reduced.superseded, [{
    event_id: older.event_id, by_event_id: newer.event_id,
  }]);
  assert.equal(reduced.candidates.length, 0);
});

test('[req:MEM-HYB-4] distinct activations asserting different handoffs remain in conflict', () => {
  const left = event('mem-handoff-left', 'handoff.latest', 'assert', 'resumo esquerdo', {
    activation_id: 'activation-left',
  });
  const right = event('mem-handoff-right', 'handoff.latest', 'assert', 'resumo direito', {
    activation_id: 'activation-right',
  });

  const reduced = reduceMemoryEvents([left, right]);

  assert.equal(reduced.candidates.length, 1);
  assert.equal(reduced.candidates[0].reason, 'conflict');
  assert.deepEqual(reduced.candidates[0].event_ids, ['mem-handoff-left', 'mem-handoff-right']);
});

test('[req:MEM-HYB-4] late older handoff from the same activation stays superseded', () => {
  const olderLate = event('mem-handoff-late-old', 'handoff.latest', 'assert', 'resumo antigo', {
    activation_id: 'activation-handoff',
    turn_sequence: 1,
    observed_at: '2026-07-26T12:02:00.000Z',
  });
  const newer = event('mem-handoff-new', 'handoff.latest', 'assert', 'resumo atual', {
    activation_id: 'activation-handoff',
    turn_sequence: 2,
    observed_at: '2026-07-26T12:01:00.000Z',
  });

  const reduced = reduceMemoryEvents([olderLate, newer]);

  assert.equal(reduced.state['handoff.latest'], 'resumo atual');
  assert.deepEqual(reduced.superseded, [{
    event_id: 'mem-handoff-late-old', by_event_id: 'mem-handoff-new',
  }]);
  assert.equal(reduced.candidates.length, 0);
});

test('[req:MEM-CUR-2] assert fisicamente posterior converge contra a fonte moderna final', () => {
  const fixture = deferredAssertReplayFixture();

  const forward = reduceMemoryEvents(fixture.events);
  const reverse = reduceMemoryEvents([...fixture.events].reverse());

  assert.deepEqual(reverse, forward, 'a ordem de chegada não altera o fixpoint causal');
  assert.equal(forward.state['handoff.latest'], fixture.deferredAssert.value);
  assert.equal(forward.records['handoff.latest'].source.event_id, fixture.deferredAssert.event_id);
  assert.equal(forward.records['handoff.latest'].revision, 4);
  assert.equal(forward.revision, 4);
  assert.equal(forward.candidates.length, 0, JSON.stringify(forward.candidates));
  assert.ok(forward.appliedEventIds.includes(fixture.deferredAssert.event_id));
  assert.ok(forward.superseded.some((entry) => entry.event_id === fixture.correction.event_id
    && entry.by_event_id === fixture.deferredAssert.event_id));
});

test('[req:MEM-CUR-2] replay legado pode ser derivado sem pós-passe para validar checkpoint antigo', () => {
  const vault = scratch();
  try {
    const fixture = deferredAssertReplayFixture();
    const legacy = reduceMemoryEvents(fixture.events, { resolveDeferredAsserts: false });
    const legacyReverse = reduceMemoryEvents([...fixture.events].reverse(), {
      resolveDeferredAsserts: false,
    });
    const legacyProjection = deriveMemoryProjection(
      vault, fixture.events, { resolveDeferredAsserts: false },
    );
    const current = deriveMemoryProjection(vault, fixture.events);
    const explicitCurrent = deriveMemoryProjection(
      vault, fixture.events, { resolveDeferredAsserts: true },
    );

    assert.equal(legacy.state['handoff.latest'], fixture.correction.value);
    assert.deepEqual(legacyReverse, legacy, 'replay antigo também independe da ordem de chegada');
    assert.equal(legacy.records['handoff.latest'].source.event_id, fixture.correction.event_id);
    assert.equal(legacy.candidates.length, 1, 'semântica anterior reproduz o candidate transitório');
    assert.equal(legacy.appliedEventIds.includes(fixture.deferredAssert.event_id), false);
    assert.equal(legacyProjection.stateHash, legacy.stateHash);
    assert.equal(legacyProjection.revision, legacy.revision);
    assert.deepEqual(explicitCurrent, current, 'default true e opção explícita convergem igualmente');
    assert.equal(current.state['handoff.latest'], fixture.deferredAssert.value);
    assert.equal(current.candidates.length, 0);
    assert.notEqual(current.stateHash, legacyProjection.stateHash);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-CUR-2] assert pendente de turno menor é superseded pela fonte moderna final', () => {
  const fixture = deferredAssertReplayFixture({ assertOverrides: { turn_sequence: 0 } });

  const reduced = reduceMemoryEvents(fixture.events);
  const withoutStaleAssert = reduceMemoryEvents(
    fixture.events.filter((item) => item.event_id !== fixture.deferredAssert.event_id),
  );

  assert.equal(reduced.state['handoff.latest'], fixture.correction.value);
  assert.equal(reduced.records['handoff.latest'].source.event_id, fixture.correction.event_id);
  assert.equal(reduced.revision, 3, 'supersede não cria uma revisão artificial');
  assert.equal(reduced.stateHash, withoutStaleAssert.stateHash, 'supersede não altera estado ou hash');
  assert.equal(reduced.candidates.length, 0);
  assert.equal(reduced.appliedEventIds.includes(fixture.deferredAssert.event_id), false);
  assert.ok(reduced.superseded.some((entry) => entry.event_id === fixture.deferredAssert.event_id
    && entry.by_event_id === fixture.correction.event_id));
});

test('[req:MEM-CUR-2] fixpoint preserva conflito com linhagem incompleta, divergente ou turno ambíguo', () => {
  const scenarios = [
    ['sessão divergente', { canonical_session_id: 'other-session' }],
    ['activation divergente', { activation_id: 'other-activation' }],
    ['epoch divergente', { activation_epoch: 8 }],
    ['identidade incompleta', { activation_epoch: undefined }],
    ['turno de origem ausente', { source_turn_id: undefined }],
    ['turno ambíguo', { turn_sequence: 1 }],
  ];

  for (const [name, assertOverrides] of scenarios) {
    const fixture = deferredAssertReplayFixture({ assertOverrides });
    const reduced = reduceMemoryEvents(fixture.events);

    assert.equal(reduced.state['handoff.latest'], fixture.correction.value, name);
    assert.equal(reduced.records['handoff.latest'].source.event_id, fixture.correction.event_id, name);
    assert.equal(reduced.candidates.length, 1, name);
    assert.deepEqual(
      reduced.candidates[0].event_ids.sort(),
      [fixture.legacyPromotion.event_id, fixture.deferredAssert.event_id].sort(),
      name,
    );
    assert.equal(reduced.appliedEventIds.includes(fixture.deferredAssert.event_id), false, name);
  }
});

test('[req:MEM-CUR-2] decisão explícita prevalece sobre reavaliação do assert pendente', () => {
  const fixture = deferredAssertReplayFixture();
  const transient = transientDeferredCandidate(fixture);
  assert.ok(transient);
  const reject = event('mem-replay-explicit-reject', `candidate.decision.${transient.candidate_id}`, 'assert', 'rejected', {
    observed_at: '2026-07-26T12:07:00.000Z',
    candidate_decision: {
      candidate_id: transient.candidate_id,
      action: 'reject',
      event_ids: [...transient.event_ids],
    },
  });

  const reduced = reduceMemoryEvents([...fixture.events, reject]);

  assert.equal(reduced.state['handoff.latest'], fixture.correction.value);
  assert.equal(reduced.records['handoff.latest'].source.event_id, fixture.correction.event_id);
  assert.equal(reduced.candidates.length, 0, 'a decisão explícita aposenta o candidate');
  assert.equal(reduced.appliedEventIds.includes(fixture.deferredAssert.event_id), false);
  assert.equal(reduced.superseded.some((entry) => entry.event_id === fixture.deferredAssert.event_id), false);
});

test('[req:OP-10] ledger-only reprojection separates the physical checkpoint from causal order without consuming outbox', () => {
  const vault = scratch();
  try {
    const older = event('mem-physical-last', 'handoff.latest', 'assert', 'resumo antigo', {
      activation_id: 'activation-handoff',
      turn_sequence: 1,
      observed_at: '2026-07-26T12:00:00.000Z',
    });
    const newer = event('mem-causal-last', 'handoff.latest', 'assert', 'resumo atual', {
      activation_id: 'activation-handoff',
      turn_sequence: 2,
      observed_at: '2026-07-26T12:01:00.000Z',
    });
    const ledgerPath = join(vault, '.brain', 'MEMORY_EVENTS.jsonl');
    writeFileSync(ledgerPath, `${JSON.stringify(newer)}\n${JSON.stringify(older)}\n`);
    const ledgerBefore = readFileSync(ledgerPath);

    const pending = event('mem-pending', 'next.pending', 'assert', 'não consumir', {
      turn_sequence: 3,
      observed_at: '2026-07-26T12:02:00.000Z',
    });
    const enqueued = enqueueMemoryEvent(vault, pending);
    const outboxBefore = readFileSync(enqueued.path);
    const outboxNamesBefore = readdirSync(join(vault, '.brain', 'memory-outbox'));

    const projected = reprojectMemoryLedger(vault);

    assert.equal(projected.status, 'reprojected');
    assert.equal(projected.eventCursor, newer.event_id, 'causal cursor follows deterministic reducer order');
    assert.equal(projected.ledgerCursor, older.event_id, 'ledger cursor follows the physical prefix boundary');
    assert.deepEqual(projected.checkpoint, {
      revision: 2,
      event_cursor: older.event_id,
      causal_event_cursor: newer.event_id,
      state_hash: projected.stateHash,
    });
    assert.match(readFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), 'utf8'), /event_cursor: mem-physical-last/);
    assert.deepEqual(readFileSync(ledgerPath), ledgerBefore, 'ledger-only replay cannot rewrite the ledger');
    assert.deepEqual(readdirSync(join(vault, '.brain', 'memory-outbox')), outboxNamesBefore);
    assert.deepEqual(readFileSync(enqueued.path), outboxBefore, 'pending outbox bytes remain untouched');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-HYB-4] late event from an older activation cannot regress newer effective state', () => {
  const newer = event('mem-new', 'handoff.state', 'assert', 'e2e-blocked', {
    activation_id: 'activation-2',
    effective_at: '2026-07-26T12:00:00.000Z',
    observed_at: '2026-07-26T12:01:00.000Z',
    turn_sequence: 2,
  });
  const lateOldStop = event('mem-old-stop', 'handoff.state', 'replace', 'done', {
    activation_id: 'activation-1',
    effective_at: '2026-07-26T11:00:00.000Z',
    observed_at: '2026-07-26T13:00:00.000Z',
    turn_sequence: 9,
    base_revision: 1,
    base_value_hash: hashMemoryValue('e2e-blocked'),
  });

  const reduced = reduceMemoryEvents([newer, lateOldStop]);

  assert.equal(reduced.state['handoff.state'], 'e2e-blocked');
  assert.deepEqual(reduced.superseded, [{ event_id: 'mem-old-stop', by_event_id: 'mem-new' }]);
  assert.equal(reduced.candidates.length, 0, 'causally old work is not a live conflict');
});

test('[req:MEM-HYB-5] exclusive outbox is immutable, canonical and collision-observable', () => {
  const vault = scratch();
  try {
    const original = event('mem-exclusive', 'next.ui', 'assert', 'review');
    const first = enqueueMemoryEvent(vault, original);
    const bytes = readFileSync(first.path, 'utf8');

    const duplicate = enqueueMemoryEvent(vault, { ...original, evidence: ['ADR-0107'] });
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(readFileSync(first.path, 'utf8'), bytes, 'same canonical payload is a no-op');

    const originalWait = Atomics.wait;
    let waits = 0;
    Atomics.wait = () => { waits += 1; return 'timed-out'; };
    try {
      assert.throws(
        () => enqueueMemoryEvent(vault, { ...original, value: 'discard' }),
        (error) => error instanceof MemoryEventCollision && error.eventId === 'mem-exclusive',
      );
    } finally {
      Atomics.wait = originalWait;
    }
    assert.equal(waits, 0, 'a valid different payload collides without entering publication polling');
    assert.equal(readFileSync(first.path, 'utf8'), bytes, 'collision never overwrites winner bytes');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-HYB-5] permanently unreadable outbox event stays fail-closed after bounded reconciliation', () => {
  const vault = scratch();
  try {
    const payload = event('mem-unreadable-outbox', 'next.ui', 'assert', 'review');
    const outbox = join(vault, '.brain', 'memory-outbox');
    mkdirSync(outbox);
    const target = join(outbox, `${payload.event_id}.json`);
    writeFileSync(target, '{');
    const startedAt = Date.now();

    assert.throws(
      () => enqueueMemoryEvent(vault, payload),
      (error) => error instanceof MemoryEventCollision
        && error.eventId === payload.event_id
        && /unreadable/i.test(error.message),
    );

    assert.equal(readFileSync(target, 'utf8'), '{', 'reconciliation never rewrites corrupt winner bytes');
    assert.ok(Date.now() - startedAt < 2_000, 'an unreadable event fails within the bounded window');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-10] producer rejeita outbox preexistente por hardlink antes de ler ou alterar bytes externos', (t) => {
  const vault = scratch();
  const outside = mkdtempSync(join(tmpdir(), 'wk-memory-outbox-hardlink-outside-'));
  try {
    const payload = event('mem-hardlinked-outbox', 'next.ui', 'assert', 'review');
    const outsideFile = join(outside, 'event.json');
    const outbox = join(vault, '.brain', 'memory-outbox');
    mkdirSync(outbox);
    writeFileSync(outsideFile, `${JSON.stringify(payload)}\n`);
    const before = readFileSync(outsideFile);
    if (!makeAlias(t, outsideFile, join(outbox, `${payload.event_id}.json`))) return;

    assert.throws(
      () => enqueueMemoryEvent(vault, payload),
      /hardlink|nlink|Vault/i,
    );
    assert.deepEqual(readFileSync(outsideFile), before);
    assert.equal(existsSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl')), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-10] projector rejeita ledger por hardlink antes do append e preserva outbox e bytes externos', (t) => {
  const vault = scratch();
  const outside = mkdtempSync(join(tmpdir(), 'wk-memory-ledger-hardlink-outside-'));
  try {
    const source = join(outside, 'external-ledger.jsonl');
    writeFileSync(source, '');
    const before = readFileSync(source);
    if (!makeAlias(t, source, join(vault, '.brain', 'MEMORY_EVENTS.jsonl'))) return;
    enqueueMemoryEvent(vault, event('mem-hardlinked-ledger', 'next.ui', 'assert', 'review'));

    assert.throws(
      () => projectMemoryOutbox(vault),
      /hardlink|nlink|Vault/i,
    );
    assert.deepEqual(readFileSync(source), before, 'append nunca alcança o inode externo');
    assert.ok(existsSync(join(vault, '.brain', 'memory-outbox', 'mem-hardlinked-ledger.json')));
    assert.equal(existsSync(join(vault, '.brain', 'SHARED_MEMORY.md')), false);
    assert.equal(existsSync(join(vault, '.brain', 'MEMORY_CANDIDATES.jsonl')), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-10] projector preflighta ambos sidecars por hardlink antes de append ou publicação parcial', async (t) => {
  for (const name of ['SHARED_MEMORY.md', 'MEMORY_CANDIDATES.jsonl']) {
    await t.test(name, (subtest) => {
      const vault = scratch();
      const outside = mkdtempSync(join(tmpdir(), 'wk-memory-sidecar-hardlink-outside-'));
      try {
        const source = join(outside, name);
        writeFileSync(source, `external sentinel for ${name}\n`);
        const before = readFileSync(source);
        if (!makeAlias(subtest, source, join(vault, '.brain', name))) return;
        enqueueMemoryEvent(vault, event(`mem-hardlinked-${name}`, 'next.ui', 'assert', 'review'));

        assert.throws(
          () => projectMemoryOutbox(vault),
          /hardlink|nlink|Vault/i,
        );
        assert.deepEqual(readFileSync(source), before);
        assert.equal(existsSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl')), false);
        assert.ok(existsSync(join(vault, '.brain', 'memory-outbox', `mem-hardlinked-${name}.json`)));
        const other = name === 'SHARED_MEMORY.md' ? 'MEMORY_CANDIDATES.jsonl' : 'SHARED_MEMORY.md';
        assert.equal(existsSync(join(vault, '.brain', other)), false, 'nenhum sidecar é publicado parcialmente');
      } finally {
        rmSync(vault, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }
});

test('[req:OP-10] leituras de PROJECT e CORE rejeitam hardlinks sem criar ou consumir memória', async (t) => {
  await t.test('PROJECT.json', (subtest) => {
    const vault = scratch();
    const outside = mkdtempSync(join(tmpdir(), 'wk-memory-project-hardlink-outside-'));
    try {
      const source = join(outside, 'PROJECT.json');
      writeFileSync(source, '{"schemaVersion":1,"projectId":"project-a"}\n');
      const before = readFileSync(source);
      if (!makeAlias(subtest, source, join(vault, '.brain', 'PROJECT.json'))) return;
      assert.throws(
        () => enqueueMemoryEvent(vault, event('mem-hardlinked-project', 'next.ui', 'assert', 'review')),
        /hardlink|nlink|Vault/i,
      );
      assert.deepEqual(readFileSync(source), before);
      assert.equal(existsSync(join(vault, '.brain', 'memory-outbox')), false);
    } finally {
      rmSync(vault, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  await t.test('CORE.md', (subtest) => {
    const vault = scratch();
    const outside = mkdtempSync(join(tmpdir(), 'wk-memory-core-hardlink-outside-'));
    try {
      const source = join(outside, 'CORE.md');
      writeFileSync(source, '<!-- wk-memory: release.push="manual-only" -->\n');
      const before = readFileSync(source);
      if (!makeAlias(subtest, source, join(vault, '.brain', 'CORE.md'))) return;
      enqueueMemoryEvent(vault, event('mem-hardlinked-core', 'next.ui', 'assert', 'review'));
      assert.throws(
        () => projectMemoryOutbox(vault),
        /hardlink|nlink|Vault/i,
      );
      assert.deepEqual(readFileSync(source), before);
      assert.equal(existsSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl')), false);
      assert.ok(existsSync(join(vault, '.brain', 'memory-outbox', 'mem-hardlinked-core.json')));
    } finally {
      rmSync(vault, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('[req:OP-10] raiz .brain por junction é rejeitada antes de lock, leitura ou publicação externa', (t) => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-brain-junction-'));
  const outside = mkdtempSync(join(tmpdir(), 'wk-memory-brain-junction-outside-'));
  try {
    const ledgerEvent = event('mem-external-ledger', 'next.ui', 'assert', 'external sentinel');
    writeFileSync(join(outside, 'MEMORY_EVENTS.jsonl'), `${JSON.stringify(ledgerEvent)}\n`);
    writeFileSync(join(outside, 'PROJECT.json'), '{"schemaVersion":1,"projectId":"project-a"}\n');
    const before = flatSnapshot(outside);
    const brain = join(vault, '.brain');
    if (!makeAlias(t, outside, brain, 'junction')) return;

    assert.throws(
      () => reprojectMemoryLedger(vault),
      /link simbólico|junction|reparse|Vault/i,
    );
    assert.deepEqual(flatSnapshot(outside), before);
    assert.equal(lstatSync(brain).isSymbolicLink(), true, 'a boundary não remove nem substitui o junction');
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function runProducer({ vault, barrier, payload }) {
  const moduleUrl = new URL('../hooks/memory-store.mjs', import.meta.url).href;
  const code = [
    "import { existsSync } from 'node:fs';",
    `import { enqueueMemoryEvent } from ${JSON.stringify(moduleUrl)};`,
    'const signal = new Int32Array(new SharedArrayBuffer(4));',
    'while (!existsSync(process.env.WK_STORE_BARRIER)) Atomics.wait(signal, 0, 0, 5);',
    'try {',
    '  const result = enqueueMemoryEvent(process.env.WK_STORE_VAULT, JSON.parse(process.env.WK_STORE_EVENT));',
    "  process.stdout.write(result.status);",
    '} catch (error) {',
    "  process.stdout.write(error.code || error.name);",
    '}',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: {
      ...process.env,
      WK_STORE_BARRIER: barrier,
      WK_STORE_VAULT: vault,
      WK_STORE_EVENT: JSON.stringify(payload),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (codeValue) => resolve({ code: codeValue, stdout, stderr }));
  });
}

function startDelayedOutboxPublication({ vault, payload, delayMs = 150 }) {
  const outbox = join(vault, '.brain', 'memory-outbox');
  mkdirSync(outbox, { recursive: true });
  const target = join(outbox, `${payload.event_id}.json`);
  const code = [
    "import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';",
    'const signal = new Int32Array(new SharedArrayBuffer(4));',
    "const fd = openSync(process.env.WK_STORE_TARGET, 'wx');",
    "process.stdout.write('ready\\n');",
    'Atomics.wait(signal, 0, 0, Number(process.env.WK_STORE_DELAY_MS));',
    "writeFileSync(fd, process.env.WK_STORE_PAYLOAD, 'utf8');",
    'fsyncSync(fd);',
    'closeSync(fd);',
    "process.stdout.write('published\\n');",
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: {
      ...process.env,
      WK_STORE_DELAY_MS: String(delayMs),
      WK_STORE_PAYLOAD: `${canonicalMemoryJson(payload)}\n`,
      WK_STORE_TARGET: target,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.includes('ready\n')) readyResolve();
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', readyReject);
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (codeValue) => {
      if (!stdout.includes('ready\n')) readyReject(new Error(stderr || `delayed writer exited ${codeValue}`));
      resolve({ code: codeValue, stdout, stderr });
    });
  });
  return { ready, closed, target };
}

test('[req:MEM-HYB-5] equal-ID retry waits for an exclusively created event still being published', async () => {
  const vault = scratch();
  const payload = event('mem-delayed-publication', 'decision.adr', 'assert', 'ADR-0107');
  let writer;
  try {
    writer = startDelayedOutboxPublication({ vault, payload });
    await writer.ready;

    const duplicate = enqueueMemoryEvent(vault, payload);

    assert.equal(duplicate.status, 'duplicate');
    const outcome = await writer.closed;
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(readFileSync(writer.target, 'utf8'), `${canonicalMemoryJson(payload)}\n`);
  } finally {
    if (writer) await writer.closed;
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-HYB-5] every publication poll rejects an outbox file swapped to a hardlink', (t) => {
  const vault = scratch();
  const outside = mkdtempSync(join(tmpdir(), 'wk-memory-outbox-poll-swap-'));
  const payload = event('mem-poll-alias-swap', 'decision.adr', 'assert', 'ADR-0107');
  const externalPath = join(outside, 'external-event.json');
  writeFileSync(externalPath, `${canonicalMemoryJson(payload)}\n`);
  const externalBefore = readFileSync(externalPath);
  const originalWait = Atomics.wait;
  try {
    const outbox = join(vault, '.brain', 'memory-outbox');
    mkdirSync(outbox, { recursive: true });
    const target = join(outbox, `${payload.event_id}.json`);
    const swap = `${target}.swap`;
    writeFileSync(target, '');
    if (!makeAlias(t, externalPath, swap)) return;
    let waits = 0;
    Atomics.wait = () => {
      waits += 1;
      if (waits === 1) renameSync(swap, target);
      return 'timed-out';
    };

    assert.throws(
      () => enqueueMemoryEvent(vault, payload),
      (error) => error?.code === 'VAULT_PATH_UNSAFE' && /hardlink|nlink|Vault/i.test(error.message),
    );
    assert.equal(waits, 1, 'the alias swap happens exactly between the first and second read');
    assert.deepEqual(readFileSync(externalPath), externalBefore, 'polling never mutates external bytes');
  } finally {
    Atomics.wait = originalWait;
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:MEM-HYB-5] real producers converge for equal IDs and lose no independent event', async () => {
  const vault = scratch();
  try {
    const barrier = join(vault, 'go');
    const left = event('mem-race', 'next.ui', 'assert', 'approve');
    const right = event('mem-race', 'next.ui', 'assert', 'discard');
    const producers = [
      runProducer({ vault, barrier, payload: left }),
      runProducer({ vault, barrier, payload: right }),
    ];
    writeFileSync(barrier, 'go');
    const results = await Promise.all(producers);

    assert.deepEqual(results.map((item) => item.code), [0, 0]);
    assert.deepEqual(
      results.map((item) => item.stdout).sort(),
      ['MEMORY_EVENT_COLLISION', 'enqueued'],
    );
    const stored = JSON.parse(readFileSync(join(vault, '.brain', 'memory-outbox', 'mem-race.json'), 'utf8'));
    assert.ok(['approve', 'discard'].includes(stored.value));

    const retryBarrier = join(vault, 'go-retry');
    const retry = event('mem-retry', 'decision.adr', 'assert', 'ADR-0107');
    const retries = [
      runProducer({ vault, barrier: retryBarrier, payload: retry }),
      runProducer({ vault, barrier: retryBarrier, payload: retry }),
    ];
    writeFileSync(retryBarrier, 'go');
    const retryResults = await Promise.all(retries);
    assert.deepEqual(retryResults.map((item) => item.stdout).sort(), ['duplicate', 'enqueued']);

    const independentBarrier = join(vault, 'go-independent');
    const independent = [
      runProducer({ vault, barrier: independentBarrier, payload: event('mem-left', 'next.docs', 'assert', 'write') }),
      runProducer({ vault, barrier: independentBarrier, payload: event('mem-right', 'blocker.push', 'assert', 'not-pushed') }),
    ];
    writeFileSync(independentBarrier, 'go');
    const independentResults = await Promise.all(independent);
    assert.deepEqual(independentResults.map((item) => item.stdout), ['enqueued', 'enqueued']);

    projectMemoryOutbox(vault);
    assert.deepEqual(
      readMemoryLedger(vault).events.map((item) => item.event_id).sort(),
      ['mem-left', 'mem-race', 'mem-retry', 'mem-right'],
      'both independent producer events survive the barrier and projection',
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-HYB-5] projector appends under lock and atomically publishes convergent projections', () => {
  const vault = scratch();
  try {
    enqueueMemoryEvent(vault, event('mem-1', 'next.ui', 'assert', 'review'));
    enqueueMemoryEvent(vault, event('mem-2', 'blocker.e2e', 'assert', 'postgres-not-ready'));

    const first = projectMemoryOutbox(vault);
    const shared = readFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), 'utf8');
    const candidates = readFileSync(join(vault, '.brain', 'MEMORY_CANDIDATES.jsonl'), 'utf8');
    const ledger = readMemoryLedger(vault);

    assert.equal(first.status, 'projected');
    assert.deepEqual(first.checkpoint, {
      revision: first.revision,
      event_cursor: first.ledgerCursor,
      state_hash: first.stateHash,
    });
    assert.equal(ledger.status, 'ok');
    assert.deepEqual(ledger.events.map((item) => item.event_id), ['mem-1', 'mem-2']);
    assert.match(shared, /schema_version:\s*2/);
    assert.match(shared, /review|postgres-not-ready/);
    assert.equal(candidates, '');
    assert.equal(readdirSync(join(vault, '.brain', 'memory-outbox')).length, 0, 'projected files consumed');
    assert.deepEqual(transientNames(vault), []);

    const sharedMtime = statSync(join(vault, '.brain', 'SHARED_MEMORY.md')).mtimeMs;
    const replay = projectMemoryOutbox(vault);
    assert.equal(replay.stateHash, first.stateHash);
    assert.equal(readFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), 'utf8'), shared);
    assert.equal(statSync(join(vault, '.brain', 'SHARED_MEMORY.md')).mtimeMs, sharedMtime, 'empty replay does not rewrite projection');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-HYB-5] busy lock preserves pending outbox and stale lock is recovered', () => {
  const vault = scratch();
  try {
    enqueueMemoryEvent(vault, event('mem-lock', 'next.ui', 'assert', 'review'));
    const lock = join(vault, '.brain', 'MEMORY.lock');
    mkdirSync(lock);

    const busy = projectMemoryOutbox(vault, { lock: { timeoutMs: 40, staleMs: 60_000 } });
    assert.deepEqual(busy, { status: 'busy', pending: 1 });
    assert.ok(existsSync(join(vault, '.brain', 'memory-outbox', 'mem-lock.json')));
    assert.equal(existsSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl')), false);

    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const recovered = projectMemoryOutbox(vault, { lock: { timeoutMs: 1000, staleMs: 1000 } });
    assert.equal(recovered.status, 'projected');
    assert.equal(existsSync(lock), false);
    assert.deepEqual(transientNames(vault), []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-HYB-5] replay converges after crash at ledger and projection boundaries', () => {
  for (const faultAt of ['after-ledger', 'after-projection']) {
    const vault = scratch();
    try {
      enqueueMemoryEvent(vault, event(`mem-${faultAt}`, 'next.ui', 'assert', 'review'));
      assert.throws(
        () => projectMemoryOutbox(vault, { faultAt }),
        new RegExp(`Injected memory-store fault: ${faultAt}`),
      );
      assert.ok(existsSync(join(vault, '.brain', 'memory-outbox', `mem-${faultAt}.json`)), 'unacknowledged outbox survives');

      const replay = projectMemoryOutbox(vault);
      const again = projectMemoryOutbox(vault);
      assert.equal(again.stateHash, replay.stateHash);
      assert.equal(readMemoryLedger(vault).events.length, 1, 'ledger append is idempotent on replay');
      assert.deepEqual(transientNames(vault), []);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  }
});

test('[req:MEM-HYB-5] partial ledger is observable and repair quarantines bytes before replay', () => {
  const vault = scratch();
  try {
    const valid = event('mem-ledger', 'next.ui', 'assert', 'review');
    writeFileSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl'), `${JSON.stringify(valid)}\n{"v":1`);
    enqueueMemoryEvent(vault, event('mem-after-corruption', 'blocker.e2e', 'assert', 'postgres-not-ready'));

    const broken = readMemoryLedger(vault);
    assert.equal(broken.status, 'corrupt');
    assert.equal(broken.events.length, 1, 'valid prefix is retained, not treated as empty');
    assert.equal(broken.errors[0].line, 2);
    assert.throws(() => projectMemoryOutbox(vault), MemoryLedgerCorruption);
    assert.ok(existsSync(join(vault, '.brain', 'memory-outbox', 'mem-after-corruption.json')));

    const repaired = repairMemoryLedger(vault);
    assert.equal(repaired.status, 'repaired');
    assert.ok(existsSync(repaired.backupPath), 'original corrupt bytes are quarantined');
    assert.equal(readMemoryLedger(vault).status, 'ok');

    const projected = projectMemoryOutbox(vault);
    assert.equal(projected.status, 'projected');
    assert.equal(readMemoryLedger(vault).events.length, 2);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
