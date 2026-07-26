import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryEventCollision,
  MemoryLedgerCorruption,
  enqueueMemoryEvent,
  hashMemoryValue,
  projectMemoryOutbox,
  readMemoryLedger,
  reduceMemoryEvents,
  repairMemoryLedger,
} from '../hooks/memory-store.mjs';

const PROJECT_ID = 'project-a';

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

function transientNames(vault) {
  return readdirSync(join(vault, '.brain'), { recursive: true })
    .map(String)
    .filter((name) => /\.tmp$|\.lock$/i.test(name));
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

    assert.throws(
      () => enqueueMemoryEvent(vault, { ...original, value: 'discard' }),
      (error) => error instanceof MemoryEventCollision && error.eventId === 'mem-exclusive',
    );
    assert.equal(readFileSync(first.path, 'utf8'), bytes, 'collision never overwrites winner bytes');
  } finally {
    rmSync(vault, { recursive: true, force: true });
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
    const recovered = projectMemoryOutbox(vault, { lock: { timeoutMs: 100, staleMs: 1000 } });
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
