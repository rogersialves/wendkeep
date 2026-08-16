import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionMemoryEvents, collectLifecycleEvidence } from '../hooks/memory-handoff.mjs';
import {
  SYNTHETIC_MEMORY,
  SYNTHETIC_SUMMARY,
  makeSyntheticHandoff,
  seedSyntheticLifecycleEvidence,
  seedSyntheticMemoryVault,
  syntheticWindowsHomePath,
} from './fixtures/synthetic-memory-lifecycle.mjs';

test('[req:MEM-STOP-7] synthetic handoff redacts an artificial local path', () => {
  const handoff = makeSyntheticHandoff({ summary: syntheticWindowsHomePath() });
  const events = buildSessionMemoryEvents(handoff);

  assert.equal(events.length, 1);
  assert.equal(events[0].memory_key, 'handoff.latest');
  assert.equal(events[0].authority, 'reported');
  assert.equal(events[0].canonical_session_id, SYNTHETIC_MEMORY.conversationId);
  assert.equal(events[0].activation_id, SYNTHETIC_MEMORY.activationOne);
  assert.equal(events[0].turn_sequence, 1);
  assert.deepEqual(events[0].evidence, [SYNTHETIC_MEMORY.noteRel]);
  assert.match(events[0].value, /\[REDACTED_LOCAL_PATH\]/);
  assert.doesNotMatch(JSON.stringify(events[0]), /[A-Za-z]:\\Users\\/i);
});

test('[req:MEM-HYB-10] structured handoff emits portable events for every shared category', () => {
  const workSessionId = 'wk-fixture-example-work-session';
  const localPath = syntheticWindowsHomePath();
  const shared = {
    work_session_id: workSessionId,
    objective: `[wk-fixture] Objetivo artificial ${localPath}`,
    delivered: `[wk-fixture] Estado entregue artificial ${localPath}`,
    constraints: `[wk-fixture] Restrição artificial ${localPath}`,
    decisions: `[wk-fixture] Decisão artificial ${localPath}`,
    next_actions: `[wk-fixture] Próxima ação artificial ${localPath}`,
    blockers: `[wk-fixture] Bloqueio artificial ${localPath}`,
    risks: `[wk-fixture] Risco artificial ${localPath}`,
  };
  const events = buildSessionMemoryEvents({
    ...makeSyntheticHandoff({ summary: '[wk-fixture] resumo livre que não deve substituir o handoff estruturado' }),
    shared,
  });
  const expectedKeys = [
    'objective.current',
    'state.delivered',
    'constraint.active',
    'decision.active',
    'next.action',
    'blocker.active',
    'risk.known',
  ];
  const byKey = new Map(events.map((event) => [event.memory_key, event]));

  assert.equal(events.length, expectedKeys.length);
  assert.deepEqual([...byKey.keys()].sort(), [...expectedKeys].sort());
  for (const key of expectedKeys) {
    const event = byKey.get(key);
    assert.equal(event.canonical_session_id, SYNTHETIC_MEMORY.conversationId);
    assert.equal(event.work_session_id, workSessionId);
    assert.equal(event.authority, 'reported');
    assert.deepEqual(event.evidence, [SYNTHETIC_MEMORY.noteRel]);
    assert.match(JSON.stringify(event.value), /\[REDACTED_LOCAL_PATH\]/);
    assert.doesNotMatch(JSON.stringify(event), /[A-Za-z]:\\Users\\/i);
  }
});

test('[req:MEM-STOP-7] synthetic lifecycle evidence creates causal memory events', () => {
  const evidence = {
    change: {
      slug: SYNTHETIC_MEMORY.changeSlug,
      status: 'archived',
      adr: 'ADR-0001',
      path: `04-Decisões/ADR-0001-${SYNTHETIC_MEMORY.changeSlug}.md`,
    },
    verdict: {
      ok: true,
      covered: 3,
      total: 3,
      path: `08-Mudanças/_arquivo/${SYNTHETIC_MEMORY.changeSlug}/verdict.json`,
    },
    sensors: [
      'wk-fixture-example-sensor-alpha',
      'wk-fixture-example-sensor-beta',
      'wk-fixture-example-sensor-gamma',
    ],
    git: {
      commit: SYNTHETIC_MEMORY.artificialCommit,
      pushed: false,
      verified: false,
      path: SYNTHETIC_MEMORY.noteRel,
    },
    nextAction: {
      id: SYNTHETIC_MEMORY.nextActionId,
      summary: SYNTHETIC_MEMORY.nextActionId,
    },
  };
  const events = buildSessionMemoryEvents(makeSyntheticHandoff({ evidence }));
  const byKey = new Map(events.map((event) => [event.memory_key, event]));

  assert.equal(byKey.get(`change.${SYNTHETIC_MEMORY.changeSlug}.status`).value.status, 'archived');
  assert.equal(byKey.get(`change.${SYNTHETIC_MEMORY.changeSlug}.status`).authority, 'verified');
  assert.deepEqual(byKey.get('quality.latest-verdict').value, { ok: true, covered: 3, total: 3 });
  assert.equal(byKey.get('git.local-head').value.pushed, false);
  assert.equal(byKey.get(`next.${SYNTHETIC_MEMORY.nextActionId}`).value, SYNTHETIC_MEMORY.nextActionId);
  assert.ok(events
    .filter((event) => event.authority === 'verified')
    .every((event) => event.evidence.length > 0));
});

test('[req:MEM-STOP-7] synthetic archived artifacts are collected as lifecycle evidence', () => {
  const vault = seedSyntheticMemoryVault();
  seedSyntheticLifecycleEvidence(vault);

  const evidence = collectLifecycleEvidence(vault, {
    changeSlug: SYNTHETIC_MEMORY.changeSlug,
    summary: SYNTHETIC_SUMMARY,
    noteRel: SYNTHETIC_MEMORY.noteRel,
  });

  assert.deepEqual(evidence.change, {
    slug: SYNTHETIC_MEMORY.changeSlug,
    status: 'archived',
    adr: 'ADR-0001',
    path: `04-Decisões/ADR-0001-${SYNTHETIC_MEMORY.changeSlug}.md`,
  });
  assert.equal(evidence.verdict.ok, true);
  assert.equal(evidence.verdict.covered, 3);
  assert.equal(evidence.verdict.total, 3);
  assert.deepEqual(evidence.sensors, [
    'wk-fixture-example-sensor-alpha',
    'wk-fixture-example-sensor-beta',
    'wk-fixture-example-sensor-gamma',
  ]);
  assert.equal(evidence.git.commit, SYNTHETIC_MEMORY.artificialCommit);
  assert.equal(evidence.git.pushed, false);
  assert.equal(evidence.nextAction.summary, SYNTHETIC_MEMORY.nextActionId);
});
