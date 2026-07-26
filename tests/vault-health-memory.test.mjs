import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
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
import { checkMemoryBundle } from '../hooks/vault-health.mjs';
import { renderSharedMemory } from '../hooks/memory-schema.mjs';
import { reduceMemoryEvents } from '../hooks/memory-store.mjs';
import { renderCoreSkeleton } from '../src/validate-core.mjs';

const PROJECT_ID = 'project-health';

function event(eventId = 'mem-health-1', extra = {}) {
  return {
    v: 1,
    project_id: PROJECT_ID,
    event_id: eventId,
    memory_key: 'next.ui',
    operation: 'assert',
    value: 'review',
    authority: 'verified',
    activation_id: 'activation-health',
    turn_sequence: 1,
    observed_at: '2026-07-26T04:00:00Z',
    evidence: ['tests/vault-health-memory.test.mjs'],
    ...extra,
  };
}

function createBundle(events = [event()]) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-health-memory-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  const reduced = reduceMemoryEvents(events);
  writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID })}\n`);
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), events.map((item) => JSON.stringify(item)).join('\n') + '\n');
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory({
    revision: reduced.revision,
    eventCursor: reduced.eventCursor,
    stateHash: reduced.stateHash,
    events: reduced.activeEvents,
    updatedAt: '2026-07-26T04:00:00Z',
    reviewAfter: '2026-08-02T04:00:00Z',
  }));
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
  return vault;
}

function byteSnapshot(vault) {
  const brain = join(vault, '.brain');
  const entries = [];
  const walk = (dir, rel = '') => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const itemRel = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, itemRel);
      else entries.push([itemRel, readFileSync(path, 'utf8')]);
    }
  };
  walk(brain);
  return entries;
}

test('[req:DIAG-8] doctor names a healthy bundle and reports schema/revision/cursor/hash', () => {
  const vault = createBundle();
  try {
    const before = byteSnapshot(vault);
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, true, result.failures.join('; '));
    assert.equal(result.status, 'healthy');
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.metrics.schemaVersion, 2);
    assert.equal(result.metrics.revision, 1);
    assert.equal(result.metrics.eventCursor, 'mem-health-1');
    assert.match(result.metrics.stateHash, /^[a-f0-9]{64}$/);
    assert.equal(result.metrics.ledgerEvents, 1);
    assert.deepEqual(byteSnapshot(vault), before, 'doctor must be byte-for-byte read-only');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:DIAG-8] pending outbox and an ordinary candidate are warnings, not failures', () => {
  const vault = createBundle();
  try {
    const outbox = join(vault, '.brain', 'memory-outbox');
    mkdirSync(outbox);
    writeFileSync(join(outbox, 'mem-pending.json'), `${JSON.stringify(event('mem-pending'))}\n`);
    writeFileSync(join(vault, '.brain', 'MEMORY_CANDIDATES.jsonl'), `${JSON.stringify({
      candidate_id: 'candidate-review', reason: 'reported', memory_key: 'next.ui', status: 'pending',
    })}\n`);

    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, true, result.failures.join('; '));
    assert.equal(result.status, 'warning');
    assert.equal(result.metrics.pendingOutbox, 1);
    assert.equal(result.metrics.candidates, 1);
    assert.match(result.warnings.join('\n'), /outbox/i);
    assert.match(result.warnings.join('\n'), /candidate/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:DIAG-8] corrupt/partial ledger is blocking and points to safe repair', () => {
  const vault = createBundle();
  try {
    writeFileSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl'), `${JSON.stringify(event())}\n{"v":1`);
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.failures.join('\n'), /linha 2|partial|parcial/i);
    assert.match(result.failures.join('\n'), /wendkeep memory repair/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:DIAG-8] ledger/projection lag and hash divergence are blocking', () => {
  const vault = createBundle();
  try {
    const second = event('mem-health-2', { memory_key: 'blocker.e2e', value: 'worker-down', turn_sequence: 2 });
    writeFileSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl'), `${JSON.stringify(event())}\n${JSON.stringify(second)}\n`);
    const lag = checkMemoryBundle(vault);
    assert.equal(lag.ok, false);
    assert.match(lag.failures.join('\n'), /proje[cç][aã]o|cursor|revision|hash/i);
    assert.match(lag.failures.join('\n'), /wendkeep memory status --gate/);

    const sharedPath = join(vault, '.brain', 'SHARED_MEMORY.md');
    const reduced = reduceMemoryEvents([event(), second]);
    writeFileSync(sharedPath, renderSharedMemory({
      revision: reduced.revision,
      eventCursor: reduced.eventCursor,
      stateHash: '0'.repeat(64),
      events: reduced.activeEvents,
      updatedAt: '2026-07-26T04:00:00Z',
      reviewAfter: '2026-08-02T04:00:00Z',
    }));
    const hash = checkMemoryBundle(vault);
    assert.equal(hash.ok, false);
    assert.match(hash.failures.join('\n'), /state_hash|hash/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:DIAG-8] an unresolved conflict candidate for an active key is blocking', () => {
  const vault = createBundle();
  try {
    writeFileSync(join(vault, '.brain', 'MEMORY_CANDIDATES.jsonl'), `${JSON.stringify({
      candidate_id: 'conflict-next-ui', reason: 'conflict', memory_key: 'next.ui', status: 'active',
      event_ids: ['mem-health-1', 'mem-competing'], values: ['review', 'discard'],
    })}\n`);
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.equal(result.metrics.activeConflicts, 1);
    assert.match(result.failures.join('\n'), /conflito ativo/i);
    assert.match(result.failures.join('\n'), /wendkeep memory status --gate/);
    assert.equal(existsSync(join(vault, '.brain', 'MEMORY.lock')), false, 'doctor does not acquire a mutation lock');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
