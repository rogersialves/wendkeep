import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertStructuredHandoffForProfile,
  buildStructuredTaskHandoff,
  deriveHandoffContract,
  evaluateHandoffContract,
  normalizeHandoffContract,
} from '../src/task-contracts.mjs';
import { buildSessionMemoryEvents } from '../hooks/memory-handoff.mjs';
import { makeSyntheticHandoff, SYNTHETIC_MEMORY } from './fixtures/synthetic-memory-lifecycle.mjs';

test('[req:TC-8] Handoff Contract v1 is deterministic and stale-aware', () => {
  const input = {
    from: 'session-a',
    to: 'next-session',
    activeContextId: 'context-a',
    taskId: '7.1',
    taskContractId: 'c'.repeat(64),
    artifacts: ['report'],
    evidence: ['envelope-1'],
    decisions: ['keep one authority'],
    nextActions: ['run verify'],
    blockers: [],
    headSha: 'a'.repeat(40),
    tasksSha256: '1'.repeat(64),
    specSha256: '2'.repeat(64),
  };
  const first = deriveHandoffContract(input);
  assert.deepEqual(deriveHandoffContract(input), first);
  assert.equal(first.schema_version, 1);
  assert.match(first.handoff_id, /^[a-f0-9]{64}$/);
  assert.equal(first.authority, 'verified');
  assert.equal(evaluateHandoffContract(first, {
    head_sha: first.head_sha,
    tasks_sha256: first.tasks_sha256,
    spec_sha256: first.spec_sha256,
  }).state, 'verified');
  assert.deepEqual(evaluateHandoffContract(first, {
    head_sha: 'b'.repeat(40),
    tasks_sha256: first.tasks_sha256,
    spec_sha256: first.spec_sha256,
  }), {
    state: 'stale',
    blocking_findings: [{ code: 'HANDOFF_STALE_HEAD', field: 'head_sha' }],
  });
});

test('[req:TC-8] historical summaries remain legacy-reported and ASSURE rejects them', () => {
  const legacy = normalizeHandoffContract('continue from the old summary');
  assert.deepEqual(legacy, {
    schema_version: 0,
    authority: 'legacy-reported',
    summary: 'continue from the old summary',
  });
  assert.throws(
    () => assertStructuredHandoffForProfile('ASSURE', legacy),
    (error) => error?.code === 'HANDOFF_STRUCTURED_REQUIRED',
  );
  assert.equal(assertStructuredHandoffForProfile('GOVERN', legacy), legacy);
});

test('[req:TC-8] structured handoff publishes handoff.latest and keeps other shared projections', () => {
  const contract = deriveHandoffContract({
    from: 'session-a', to: 'next-session', activeContextId: 'context-a', taskId: '7.1',
    taskContractId: 'c'.repeat(64), artifacts: [], evidence: ['envelope-1'], decisions: [],
    nextActions: ['continue safely'], blockers: [], headSha: 'a'.repeat(40),
    tasksSha256: '1'.repeat(64), specSha256: '2'.repeat(64),
  });
  const events = buildSessionMemoryEvents({
    ...makeSyntheticHandoff({ summary: 'legacy fallback' }),
    shared: {
      work_session_id: SYNTHETIC_MEMORY.workSessionId,
      next_actions: ['continue safely'],
      handoff_contract: contract,
    },
  });
  const handoff = events.find((event) => event.memory_key === 'handoff.latest');
  assert.ok(handoff);
  assert.equal(handoff.authority, 'verified');
  assert.deepEqual(handoff.value, contract);
  assert.ok(events.some((event) => event.memory_key === 'next.action'));
});

test('[req:TC-8] SessionStop adapter selects the causal claimed task and ASSURE fails closed', () => {
  const snapshot = {
    binding: {
      active_context_id: 'context-a', head_sha: 'a'.repeat(40),
      tasks_sha256: '1'.repeat(64), effective_spec_sha256: '2'.repeat(64),
    },
    evidence_envelope_id: 'envelope-1',
    artifact_results: [{ name: 'report', satisfied: true }],
    contracts: [
      { task_id: '1.1', contract_id: 'a'.repeat(64) },
      { task_id: '2.1', contract_id: 'b'.repeat(64) },
    ],
  };
  const shared = buildStructuredTaskHandoff({
    profile: 'ASSURE',
    sessionId: 'session-a',
    snapshot,
    evaluations: [
      { task_id: '1.1', can_complete: true, blocking_findings: [] },
      { task_id: '2.1', can_complete: false, blocking_findings: [{ code: 'TASK_ARTIFACT_MISSING' }] },
    ],
    context: {
      task_leases: {
        'typed:2.1': { state: 'active', task_id: '2.1', owner_session_id: 'session-a' },
      },
    },
    shared: { next_actions: ['produce report'] },
  });
  assert.equal(shared.handoff_contract.task_id, '2.1');
  assert.equal(shared.handoff_contract.task_contract_id, 'b'.repeat(64));
  assert.deepEqual(shared.handoff_contract.blockers, ['TASK_ARTIFACT_MISSING']);
  assert.equal(shared.tasks_hash, '1'.repeat(64));
  assert.equal(shared.spec_hash, '2'.repeat(64));

  assert.throws(
    () => buildStructuredTaskHandoff({ profile: 'ASSURE', sessionId: 'session-a' }),
    (error) => error?.code === 'HANDOFF_STRUCTURED_REQUIRED',
  );
});
