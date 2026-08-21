import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalMemoryJson, reduceMemoryEvents } from '../hooks/memory-store.mjs';
import { planScopedMemoryMigration, rescopeMemoryEvents } from '../src/memory.mjs';

function event(id, key, value, overrides = {}) {
  return {
    v: 1,
    event_id: id,
    project_id: 'project-a',
    memory_key: key,
    operation: 'assert',
    value,
    authority: 'reported',
    canonical_session_id: 'session-a',
    activation_id: 'activation-a',
    activation_epoch: 1,
    turn_sequence: 1,
    source_turn_id: `turn-${id}`,
    observed_at: '2026-08-20T12:00:00.000Z',
    evidence: ['fixture.md'],
    ...overrides,
  };
}

function vaultFixture(events) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-scoped-memory-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'PROJECT.json'), JSON.stringify({ projectId: 'project-a' }));
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), events.map(canonicalMemoryJson).join('\n') + '\n');
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
  return vault;
}

test('[req:MEM-SCOPE-1] main and feature branch HEADs coexist without a global conflict', () => {
  const reduced = reduceMemoryEvents([
    event('head-main', 'git.local-head', { commit: 'a'.repeat(40) }, {
      scope: { type: 'branch', id: 'repo:wendkeep|worktree:main|branch:main' },
    }),
    event('head-feature', 'git.local-head', { commit: 'b'.repeat(40) }, {
      canonical_session_id: 'session-b',
      activation_id: 'activation-b',
      scope: { type: 'branch', id: 'repo:wendkeep|worktree:feature|branch:feature' },
    }),
  ]);
  assert.equal(reduced.candidates.length, 0);
  assert.equal(Object.keys(reduced.state).filter((key) => key.startsWith('git.local-head@')).length, 2);
  assert.deepEqual(new Set(reduced.activeEvents.map((item) => item.value.commit)), new Set(['a'.repeat(40), 'b'.repeat(40)]));
});

test('[req:MEM-SCOPE-2] a scoped register advances only inside the same causal lineage', () => {
  const scope = { type: 'work_session', id: 'work-a' };
  const reduced = reduceMemoryEvents([
    event('handoff-old', 'handoff.latest', 'old', { scope }),
    event('handoff-new', 'handoff.latest', 'new', {
      scope, activation_id: 'activation-b', activation_epoch: 2, turn_sequence: 2,
      observed_at: '2026-08-20T12:01:00.000Z', authority: 'verified',
    }),
  ]);
  assert.equal(reduced.candidates.length, 0);
  assert.equal(reduced.state['handoff.latest@work_session:work-a'], 'new');

  const incomparable = reduceMemoryEvents([
    event('handoff-a', 'handoff.latest', 'a', { scope }),
    event('handoff-b', 'handoff.latest', 'b', {
      scope, canonical_session_id: 'session-b', activation_id: 'activation-b',
    }),
  ]);
  assert.equal(incomparable.candidates.length, 1);
});

test('[req:MEM-SCOPE-3] an ambiguous scoped handoff is omitted while independent decisions survive', () => {
  const scope = { type: 'work_session', id: 'work-a' };
  const reduced = reduceMemoryEvents([
    event('decision-a', 'decision.active', 'Use SQLite', {
      scope: { type: 'project', id: 'project-a' }, authority: 'verified',
    }),
    event('handoff-a', 'handoff.latest', 'resume A', { scope }),
    event('handoff-b', 'handoff.latest', 'resume B', {
      scope, canonical_session_id: 'session-b', activation_id: 'activation-b',
    }),
  ]);
  assert.equal(reduced.candidates.length, 1);
  assert.ok(reduced.activeEvents.some((item) => item.memory_key === 'decision.active'));
  assert.ok(reduced.activeEvents.some((item) => item.review_pending === true));
  assert.ok(!reduced.activeEvents.some((item) => item.memory_key === 'handoff.latest' && !item.review_pending));
});

test('[req:MEM-SCOPE-3] legacy ambiguity also omits the unsafe key while preserving independent state', () => {
  const first = event('legacy-handoff-a', 'handoff.latest', 'continuar A', {});
  delete first.scope;
  const second = event('legacy-handoff-b', 'handoff.latest', 'continuar B', {
    canonical_session_id: 'other-session',
    activation_id: 'other-activation',
  });
  delete second.scope;
  const decision = event('legacy-decision', 'decision.active', 'usar SQLite', {});
  delete decision.scope;
  const projection = reduceMemoryEvents([first, second, decision]);

  assert.equal(projection.candidates.length, 1);
  assert.equal(projection.activeEvents.some((item) => item.memory_key === 'handoff.latest'
    && !item.review_pending), false);
  assert.equal(projection.activeEvents.some((item) => item.memory_key === 'decision.active'), true);
});

test('[req:MEM-SCOPE-4] rescope migration is dry-run first, append-only and idempotent', () => {
  const legacy = event('legacy-head', 'git.local-head', {
    commit: 'c'.repeat(40), branch: 'main', worktree_id: 'primary', repository_id: 'wendkeep',
  });
  const vault = vaultFixture([legacy]);
  try {
    const ledgerPath = join(vault, '.brain', 'MEMORY_EVENTS.jsonl');
    const before = readFileSync(ledgerPath, 'utf8');
    const dry = planScopedMemoryMigration(vault);
    assert.equal(dry.planned, 1);
    assert.deepEqual(dry.events[0].scope, {
      type: 'branch', id: 'repo:wendkeep|worktree:primary|branch:main',
    });
    assert.equal(readFileSync(ledgerPath, 'utf8'), before);

    const applied = rescopeMemoryEvents(vault, { apply: true });
    assert.equal(applied.status, 'migrated');
    assert.ok(readFileSync(ledgerPath, 'utf8').startsWith(before), 'legacy ledger bytes remain an exact prefix');
    assert.equal(rescopeMemoryEvents(vault, { apply: true }).status, 'unchanged');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-HANDOFF-1] rescope separates ambiguous legacy handoffs by proven session without choosing a winner', () => {
  const left = event('legacy-handoff-session-a', 'handoff.latest', 'resume A');
  delete left.scope;
  const right = event('legacy-handoff-session-b', 'handoff.latest', 'resume B', {
    canonical_session_id: 'session-b',
    activation_id: 'activation-b',
    observed_at: '2026-08-20T12:01:00.000Z',
  });
  delete right.scope;
  const vault = vaultFixture([left, right]);
  try {
    const ledgerPath = join(vault, '.brain', 'MEMORY_EVENTS.jsonl');
    const before = readFileSync(ledgerPath, 'utf8');
    const dry = planScopedMemoryMigration(vault);

    assert.equal(dry.rescopable_conflicts, 1);
    assert.equal(dry.planned, 2);
    assert.deepEqual(
      new Set(dry.events.map((item) => `${item.scope.type}:${item.scope.id}`)),
      new Set(['work_session:session-a', 'work_session:session-b']),
    );
    assert.equal(readFileSync(ledgerPath, 'utf8'), before, 'dry-run is byte-for-byte read-only');

    const applied = rescopeMemoryEvents(vault, { apply: true });
    assert.equal(applied.status, 'migrated');
    assert.equal(applied.remaining_ambiguous, 0);
    const after = readFileSync(ledgerPath, 'utf8');
    assert.ok(after.startsWith(before), 'legacy ledger bytes remain an exact prefix');
    const reduced = reduceMemoryEvents(after.trim().split('\n').map(JSON.parse));
    assert.equal(reduced.candidates.length, 0);
    assert.deepEqual(
      new Set(Object.keys(reduced.state)),
      new Set([
        'handoff.latest@work_session:session-a',
        'handoff.latest@work_session:session-b',
      ]),
    );
    assert.equal(rescopeMemoryEvents(vault, { apply: true }).status, 'unchanged');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-HANDOFF-1] rescope preserves a real ambiguity inside the same work session', () => {
  const left = event('legacy-work-a-left', 'handoff.latest', 'resume left', {
    work_session_id: 'work-a',
  });
  delete left.scope;
  const right = event('legacy-work-a-right', 'handoff.latest', 'resume right', {
    canonical_session_id: 'session-b',
    activation_id: 'activation-b',
    work_session_id: 'work-a',
  });
  delete right.scope;
  const vault = vaultFixture([left, right]);
  try {
    const dry = planScopedMemoryMigration(vault);
    assert.equal(dry.rescopable_conflicts, 1);
    assert.equal(dry.planned, 2);

    const applied = rescopeMemoryEvents(vault, { apply: true });
    assert.equal(applied.status, 'migrated');
    assert.equal(applied.remaining_ambiguous, 1);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-SCOPE-5] automatic resolution never compares different projects', () => {
  assert.throws(() => reduceMemoryEvents([
    event('project-a-head', 'git.local-head', { commit: 'a' }, {
      scope: { type: 'project', id: 'project-a' },
    }),
    event('project-b-head', 'git.local-head', { commit: 'b' }, {
      project_id: 'project-b', scope: { type: 'project', id: 'project-b' },
    }),
  ]), (error) => error.code === 'MEMORY_PROJECT_MIXED');
});
