import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  completeGreenAttestation,
  createRedAttestation,
  evaluateTddAttestation,
  waiveTddAttestation,
} from '../src/tdd-attestation.mjs';
import { buildEvidenceEnvelope } from '../src/evidence-envelope.mjs';
import { deriveHandoffContract } from '../src/task-contracts.mjs';

const identity = {
  project_id: 'project-1',
  repository_id: 'repository-1',
  worktree_id: 'worktree-1',
  work_session_id: 'work-session-1',
  change_slug: 'tdd-attestation',
};

function snapshot(overrides = {}) {
  return {
    branch: 'wk/tdd-attestation',
    head_sha: 'a'.repeat(40),
    index_tree_sha: '1'.repeat(40),
    worktree_digest: 'sha256:' + '2'.repeat(64),
    change_manifest: {
      'tests/auth.test.mjs': 'sha256:' + '3'.repeat(64),
    },
    ...overrides,
  };
}

function validRed(overrides = {}) {
  return createRedAttestation({
    identity,
    profile: 'GOVERN',
    taskId: '1.2',
    requirementId: 'AUTH-4',
    testPaths: ['tests/auth.test.mjs'],
    snapshot: snapshot(),
    command: 'node --test tests/auth.test.mjs',
    result: { status: 1, stdout: '', stderr: 'AssertionError: expected true to equal false' },
    observedAt: '2026-08-24T20:00:00.000Z',
    ...overrides,
  });
}

test('[req:TDD-1] [req:TDD-2] RED records a bounded sanitized failure instead of full output', () => {
  const red = validRed({
    result: {
      status: 1,
      stdout: `${'x'.repeat(3_000)} ghp_abcdefghijklmnop`,
      stderr: "location: 'C:\\\\Users\\\\RUNNER~1\\\\AppData\\\\Local\\\\Temp\\\\project\\\\tests\\\\auth.test.mjs:4:1'",
    },
  });

  assert.equal(red.state, 'red-observed');
  assert.match(red.attestation_id, /^[a-f0-9]{64}$/);
  assert.match(red.red.failure_digest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(red.red.output_tail.length <= 2_000);
  assert.doesNotMatch(red.red.output_tail, /ghp_abcdefghijklmnop/);
  assert.doesNotMatch(red.red.output_tail, /C:/i);
  assert.equal(red.red.exit_code, 1);
  assert.deepEqual(red.test_paths, ['tests/auth.test.mjs']);
});

test('[req:TDD-2] an already-green test and infrastructure failures are invalid RED proof', () => {
  const alreadyGreen = validRed({ result: { status: 0, stdout: 'ok', stderr: '' } });
  assert.equal(alreadyGreen.state, 'invalid');
  assert.equal(alreadyGreen.invalid_reason, 'TDD_RED_ALREADY_GREEN');

  const missingModule = validRed({
    result: { status: 1, stdout: '', stderr: "Error: Cannot find module 'missing-package'" },
  });
  assert.equal(missingModule.state, 'invalid');
  assert.equal(missingModule.invalid_reason, 'TDD_RED_INFRASTRUCTURE_FAILURE');
});

test('[req:TDD-3] [req:TDD-4] GREEN must share causal identity and contain implementation after RED', () => {
  const red = validRed();
  const noImplementation = completeGreenAttestation(red, {
    identity,
    taskId: '1.2',
    requirementId: 'AUTH-4',
    testPaths: ['tests/auth.test.mjs'],
    snapshot: snapshot({ worktree_digest: 'sha256:' + '4'.repeat(64) }),
    command: 'node --test tests/auth.test.mjs',
    result: { status: 0, stdout: 'pass', stderr: '' },
    observedAt: '2026-08-24T20:05:00.000Z',
    isAncestor: true,
  });
  assert.equal(noImplementation.state, 'invalid');
  assert.equal(noImplementation.invalid_reason, 'TDD_IMPLEMENTATION_NOT_AFTER_RED');

  const wrongWorktree = completeGreenAttestation(red, {
    identity: { ...identity, worktree_id: 'worktree-2' },
    taskId: '1.2', requirementId: 'AUTH-4', testPaths: ['tests/auth.test.mjs'],
    snapshot: snapshot({ change_manifest: { 'src/auth.mjs': 'sha256:' + '5'.repeat(64) } }),
    command: 'node --test tests/auth.test.mjs',
    result: { status: 0, stdout: 'pass', stderr: '' },
    observedAt: '2026-08-24T20:05:00.000Z', isAncestor: true,
  });
  assert.equal(wrongWorktree.state, 'invalid');
  assert.equal(wrongWorktree.invalid_reason, 'TDD_CAUSAL_IDENTITY_MISMATCH');
});

test('[req:TDD-3] [req:TDD-5] GREEN records production diff and a reviewable test-path change', () => {
  const green = completeGreenAttestation(validRed(), {
    identity,
    taskId: '1.2',
    requirementId: 'AUTH-4',
    testPaths: ['tests/auth-renamed.test.mjs'],
    snapshot: snapshot({
      index_tree_sha: '6'.repeat(40),
      worktree_digest: 'sha256:' + '7'.repeat(64),
      change_manifest: {
        'tests/auth-renamed.test.mjs': 'sha256:' + '8'.repeat(64),
        'src/auth.mjs': 'sha256:' + '9'.repeat(64),
      },
    }),
    command: 'node --test tests/auth-renamed.test.mjs',
    result: { status: 0, stdout: 'pass', stderr: '' },
    observedAt: '2026-08-24T20:05:00.000Z',
    isAncestor: true,
  });

  assert.equal(green.state, 'green-observed');
  assert.deepEqual(green.green.production_paths, ['src/auth.mjs']);
  assert.deepEqual(green.review_flags, ['TDD_TEST_PATHS_CHANGED']);
  assert.match(green.green.result_digest, /^sha256:[a-f0-9]{64}$/);
});

test('[req:TDD-5] post-GREEN refactor is stale until revalidated without erasing history', () => {
  const green = completeGreenAttestation(validRed(), {
    identity, taskId: '1.2', requirementId: 'AUTH-4', testPaths: ['tests/auth.test.mjs'],
    snapshot: snapshot({
      worktree_digest: 'sha256:' + 'a'.repeat(64),
      change_manifest: {
        'tests/auth.test.mjs': 'sha256:' + '3'.repeat(64),
        'src/auth.mjs': 'sha256:' + 'b'.repeat(64),
      },
    }),
    command: 'node --test tests/auth.test.mjs',
    result: { status: 0, stdout: 'pass', stderr: '' },
    observedAt: '2026-08-24T20:05:00.000Z', isAncestor: true,
  });
  const stale = evaluateTddAttestation(green, snapshot({ worktree_digest: 'sha256:' + 'c'.repeat(64) }));
  assert.equal(stale.state, 'invalid');
  assert.equal(stale.invalid_reason, 'TDD_GREEN_STALE_AFTER_REFACTOR');
  assert.equal(green.state, 'green-observed', 'historical attestation remains immutable');

  const revalidated = completeGreenAttestation(green, {
    identity, taskId: '1.2', requirementId: 'AUTH-4', testPaths: ['tests/auth.test.mjs'],
    snapshot: snapshot({
      worktree_digest: 'sha256:' + 'c'.repeat(64),
      change_manifest: {
        'tests/auth.test.mjs': 'sha256:' + '3'.repeat(64),
        'src/auth.mjs': 'sha256:' + 'd'.repeat(64),
      },
    }),
    command: 'node --test tests/auth.test.mjs',
    result: { status: 0, stdout: 'pass again', stderr: '' },
    observedAt: '2026-08-24T20:10:00.000Z', isAncestor: true,
  });
  assert.equal(revalidated.state, 'green-observed');
  assert.equal(revalidated.green_history.length, 1);
  assert.equal(revalidated.green_history[0].observed_at, '2026-08-24T20:05:00.000Z');
});

test('[req:TDD-6] waiver requires explicit human authority and reason', () => {
  assert.throws(
    () => waiveTddAttestation({ identity, taskId: '1.2', requirementId: 'AUTH-4' }),
    (error) => error?.code === 'TDD_WAIVER_AUTHORITY_REQUIRED',
  );
  const waived = waiveTddAttestation({
    identity, taskId: '1.2', requirementId: 'AUTH-4',
    authority: 'maintainer:roger', reason: 'generated configuration has no discriminating test',
    observedAt: '2026-08-24T20:00:00.000Z',
  });
  assert.equal(waived.state, 'waived');
  assert.equal(waived.waiver.authority, 'maintainer:roger');
  assert.match(waived.attestation_id, /^[a-f0-9]{64}$/);
});

test('[req:TDD-1] published JSON Schema exposes every attestation state', () => {
  const schema = JSON.parse(readFileSync(join(process.cwd(), 'schema', 'tdd-attestation-v1.schema.json'), 'utf8'));
  assert.equal(schema.properties.schema_version.const, 1);
  assert.deepEqual(schema.properties.state.enum, ['red-observed', 'green-observed', 'invalid', 'waived']);
  assert.ok(schema.required.includes('attestation_id'));
  assert.ok(schema.required.includes('green_history'));
});

test('[req:TDD-7] evidence envelope and handoff expose the causal attestation id', () => {
  const red = validRed();
  const greenSnapshot = snapshot({
    worktree_digest: 'sha256:' + 'a'.repeat(64),
    change_manifest: {
      'tests/auth.test.mjs': 'sha256:' + '3'.repeat(64),
      'src/auth.mjs': 'sha256:' + 'b'.repeat(64),
    },
  });
  const green = completeGreenAttestation(red, {
    identity, taskId: '1.2', requirementId: 'AUTH-4',
    snapshot: greenSnapshot, command: 'node --test tests/auth.test.mjs',
    result: { status: 0, stdout: 'pass', stderr: '' }, isAncestor: true,
  });
  const envelope = buildEvidenceEnvelope({
    identity, changeSlug: identity.change_slug,
    snapshot: { ...greenSnapshot, base_sha: 'a'.repeat(40), dirty: true },
    tasksSha256: 'sha256:' + '1'.repeat(64),
    effectiveSpecSha256: 'sha256:' + '2'.repeat(64),
    sensorConfigSha256: 'sha256:' + '3'.repeat(64), sensors: [],
    startedAt: '2026-08-24T20:00:00.000Z', finishedAt: '2026-08-24T20:01:00.000Z',
    tddAttestations: [green],
  });
  assert.equal(envelope.tdd_attestations[0].attestation_id, green.attestation_id);
  assert.equal(envelope.tdd_attestations[0].state, 'green-observed');

  const handoff = deriveHandoffContract({
    from: 'session-a', to: 'next-session', activeContextId: 'context-a', taskId: '1.2',
    taskContractId: 'c'.repeat(64), evidence: [envelope.envelope_id],
    tddAttestationIds: [green.attestation_id], headSha: 'a'.repeat(40),
    tasksSha256: '1'.repeat(64), specSha256: '2'.repeat(64),
  });
  assert.deepEqual(handoff.tdd_attestation_ids, [green.attestation_id]);
});

test('[req:TDD-8] a mutation survivor invalidates an otherwise current GREEN attestation', () => {
  const greenSnapshot = snapshot({
    worktree_digest: 'sha256:' + 'a'.repeat(64),
    change_manifest: {
      'tests/auth.test.mjs': 'sha256:' + '3'.repeat(64),
      'src/auth.mjs': 'sha256:' + 'b'.repeat(64),
    },
  });
  const green = completeGreenAttestation(validRed(), {
    identity, taskId: '1.2', requirementId: 'AUTH-4', snapshot: greenSnapshot,
    command: 'node --test tests/auth.test.mjs', result: { status: 0 }, isAncestor: true,
  });
  const evaluated = evaluateTddAttestation(green, greenSnapshot, {
    mutationSurvivors: [{ file: 'src/auth.mjs', line: 12 }],
  });
  assert.equal(evaluated.state, 'invalid');
  assert.equal(evaluated.invalid_reason, 'TDD_MUTATION_SURVIVOR');
});
