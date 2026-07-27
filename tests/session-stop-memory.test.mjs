import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { commitSessionMemory } from '../hooks/session-stop.mjs';
import { canonicalMemoryJson } from '../hooks/memory-store.mjs';
import {
  SYNTHETIC_MEMORY,
  makeSyntheticHandoff,
  seedSyntheticMemoryVault,
} from './fixtures/synthetic-memory-lifecycle.mjs';

test('[req:MEM-STOP-7] synthetic session memory commits through the projector', () => {
  const vault = seedSyntheticMemoryVault();
  const result = commitSessionMemory(vault, makeSyntheticHandoff());

  assert.equal(result.status, 'projected');
  assert.equal(result.eventCount, 1);
  assert.equal(result.checkpoint.revision, 1);
  assert.match(result.checkpoint.state_hash, /^[a-f0-9]{64}$/);
  assert.match(
    readFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), 'utf8'),
    new RegExp(SYNTHETIC_MEMORY.nextActionId),
  );
  assert.match(
    readFileSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl'), 'utf8'),
    /handoff\.latest/,
  );
});

test('[req:OP-10] legacy commit helper returns the projector physical checkpoint verbatim', () => {
  const vault = seedSyntheticMemoryVault();
  const causalTail = {
    v: 1,
    project_id: SYNTHETIC_MEMORY.projectId,
    event_id: 'mem-wk-fixture-causal-tail',
    memory_key: 'fixture.later',
    operation: 'assert',
    value: '[wk-fixture] later causal event',
    authority: 'reported',
    canonical_session_id: 'wk-fixture-other-session',
    activation_id: 'wk-fixture-other-activation',
    activation_epoch: 1,
    turn_sequence: 1,
    source_turn_id: 'wk-fixture-other-turn',
    observed_at: '2100-01-01T00:00:00.000Z',
    evidence: ['wk-fixture:causal-tail'],
  };
  writeFileSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl'), `${canonicalMemoryJson(causalTail)}\n`);

  const result = commitSessionMemory(vault, makeSyntheticHandoff());

  assert.equal(result.status, 'projected');
  assert.equal(result.checkpoint.event_cursor, result.eventIds[0], 'cursor durável aponta para o tail físico recém-anexado');
  assert.equal(result.checkpoint.causal_event_cursor, causalTail.event_id);
});

test('[req:MEM-STOP-7] synthetic projector failure preserves replayable outbox data', () => {
  const vault = seedSyntheticMemoryVault();
  const result = commitSessionMemory(vault, makeSyntheticHandoff(), {
    projectOptions: { faultAt: 'after-ledger' },
  });

  assert.equal(result.status, 'degraded');
  assert.match(result.error, /Injected memory-store fault/);
  assert.ok(existsSync(join(
    vault,
    '.brain',
    'memory-outbox',
    `${result.eventIds[0]}.json`,
  )));
});

test('[req:MEM-STOP-7] synthetic legacy memory remains untouched without v2 evidence', () => {
  const vault = seedSyntheticMemoryVault();
  const sharedPath = join(vault, '.brain', 'SHARED_MEMORY.md');
  const ledgerPath = join(vault, '.brain', 'MEMORY_EVENTS.jsonl');
  const candidatesPath = join(vault, '.brain', 'MEMORY_CANDIDATES.jsonl');
  const legacy = '# Legacy WK Fixture Memory\n\n- [wk-fixture] artificial legacy fact.\n';
  writeFileSync(sharedPath, legacy);

  const result = commitSessionMemory(vault, makeSyntheticHandoff());

  assert.equal(result.status, 'legacy');
  assert.equal(result.eventCount, 0);
  assert.deepEqual(result.eventIds, []);
  assert.equal(result.checkpoint, null);
  assert.equal(readFileSync(sharedPath, 'utf8'), legacy);
  assert.equal(readFileSync(ledgerPath, 'utf8'), '');
  assert.equal(readFileSync(candidatesPath, 'utf8'), '');
  assert.equal(existsSync(join(vault, '.brain', 'memory-outbox')), false);
});

test('[req:MEM-STOP-7] synthetic unreadable shared memory degrades without losing outbox data', () => {
  const vault = seedSyntheticMemoryVault();
  const sharedPath = join(vault, '.brain', 'SHARED_MEMORY.md');
  rmSync(sharedPath);
  mkdirSync(sharedPath);

  const result = commitSessionMemory(vault, makeSyntheticHandoff());

  assert.equal(result.status, 'degraded');
  assert.notEqual(result.error, undefined);
  assert.ok(existsSync(join(
    vault,
    '.brain',
    'memory-outbox',
    `${result.eventIds[0]}.json`,
  )));
});
