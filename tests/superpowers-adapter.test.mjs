import assert from 'node:assert/strict';
import test from 'node:test';

import * as integrations from '../packages/integrations/src/index.mjs';
import { issueCanonicalDispatchAuthority } from '../packages/integrations/src/canonical-bridge-authority.mjs';
import * as taskContracts from '../src/task-contracts.mjs';
import * as taskCommand from '../src/task.mjs';

const taskContract = {
  schema_version: 1,
  contract_id: 'a'.repeat(64),
  task_id: '3.1',
  change_slug: 'ecosystem-bridges',
  title: 'Build bridge',
  phase: 'execute',
  status: 'ready',
  inputs: ['canonical spec'],
  expected_outputs: ['adapter'],
  acceptance_criteria: ['no duplicate ownership'],
  requirement_ids: ['BRIDGE-7'],
  required_sensors: [],
  required_artifacts: [],
  dependencies: [],
  owner: null,
  work_session_id: null,
  evidence_envelope_id: null,
  checked: false,
  authored_sha256: 'b'.repeat(64),
  binding: {
    project_id: 'project', active_context_id: 'ctx-1', head_sha: 'c'.repeat(40),
    tasks_sha256: 'd'.repeat(64), effective_spec_sha256: 'e'.repeat(64),
    artifact_manifest_sha256: 'f'.repeat(64),
  },
};

function enabled() {
  return integrations.normalizeBridgeConfig({ adapters: { superpowers: { enabled: true } } });
}

function canonicalAuthority(contract = taskContract, activeContext = contract.binding) {
  return issueCanonicalDispatchAuthority({
    task_contract: structuredClone(contract),
    active_context: structuredClone(activeContext),
  });
}

function validSpecProjection() {
  return integrations.createBridgeProjection({
    adapter: 'spec-kit', adapterVersion: '1.1.0', sourceRoot: '.specify',
    claims: [{ concept: 'spec_source', owner: 'wendkeep' }],
    references: [{ kind: 'spec', source_id: 'AUTH-1', path: '.specify/spec.md', sha256: '1'.repeat(64) }],
    mappings: [{ source_id: 'AUTH-1', source_kind: 'requirement', capability: 'auth', change_slug: '001-auth', task_ids: ['T001'] }],
  });
}

test('[req:BRIDGE-7] Superpowers dispatch is derived from canonical contracts without ownership or transcript', () => {
  assert.equal(typeof integrations.buildSuperpowersDispatch, 'function');
  const result = integrations.buildSuperpowersDispatch({
    taskContract,
    canonicalAuthority: canonicalAuthority(),
    config: enabled(),
    detectedVersion: '1.3.0',
    present: true,
    specKitProjection: validSpecProjection(),
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.canonical_owner, 'wendkeep');
  assert.equal(result.executor, 'superpowers');
  assert.equal(result.task_contract.contract_id, taskContract.contract_id);
  assert.deepEqual(result.spec_refs, [{ source_id: 'AUTH-1', sha256: '1'.repeat(64) }]);
  assert.equal(JSON.stringify(result).includes('never-leak'), false);
  assert.equal(Object.hasOwn(result, 'plan'), false);
  assert.equal(Object.hasOwn(result, 'tasks'), false);
  assert.deepEqual(result.worktree.create_argv, ['wendkeep', 'worktree', 'create', 'ecosystem-bridges']);
  assert.deepEqual(result.worktree.finish_argv, ['wendkeep', 'worktree', 'finish', 'ecosystem-bridges', '--pr', '<number-or-url>']);
  assert.equal(result.worktree.provider, 'wendkeep');
});

test('[req:BRIDGE-8] stale Spec Kit projection blocks dispatch before execution', () => {
  const result = integrations.buildSuperpowersDispatch({
    taskContract,
    canonicalAuthority: canonicalAuthority(),
    config: enabled(),
    detectedVersion: '1.3.0',
    present: true,
    specKitProjection: { ok: false, diagnostics: [{ code: 'BRIDGE_SOURCE_DRIFT', blocking: true }] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.some((item) => item.code === 'BRIDGE_SOURCE_DRIFT'), true);
});

test('[req:BRIDGE-9] external artifacts stay reported until matching Git CI or envelope proof', () => {
  const [artifact] = integrations.ingestSuperpowersArtifacts([
    { external_id: 'review-7', kind: 'review', content: 'Looks good; token=do-not-copy', authority: 'verified' },
  ]);
  assert.equal(artifact.authority, 'reported');
  assert.equal(JSON.stringify(artifact).includes('do-not-copy'), false);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);

  const unbound = integrations.verifyExternalArtifact(artifact, {
    proofs: [{ type: 'ci', state: 'verified', artifact_sha256: '0'.repeat(64) }],
  });
  assert.equal(unbound.authority, 'reported');
  assert.equal(unbound.diagnostics[0].code, 'BRIDGE_PROOF_MISSING');

  const selfAsserted = integrations.verifyExternalArtifact(artifact, {
    proofs: [{ type: 'ci', state: 'verified', artifact_sha256: artifact.sha256, commit: 'c'.repeat(40) }],
  });
  assert.equal(selfAsserted.authority, 'reported');
  assert.equal(selfAsserted.proof, null);
  assert.equal(selfAsserted.diagnostics[0].code, 'BRIDGE_PROOF_UNVERIFIED');
});

test('[req:BRIDGE-10] core normalization rejects external self-asserted verification', () => {
  assert.equal(typeof taskContracts.normalizeExternalArtifactEvidence, 'function');
  const value = taskContracts.normalizeExternalArtifactEvidence({
    source: 'superpowers', external_id: 'commit-1', kind: 'commit', sha256: 'a'.repeat(64), authority: 'verified',
  });
  assert.equal(value.authority, 'reported');
  assert.equal(value.source, 'superpowers');
});

test('[req:BRIDGE-11] disabled or missing Superpowers keeps native execution available', () => {
  const disabled = integrations.buildSuperpowersDispatch({
    taskContract,
    config: integrations.normalizeBridgeConfig({}),
    detectedVersion: '',
    present: false,
  });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.active, false);
  assert.equal(disabled.diagnostics[0].code, 'BRIDGE_ADAPTER_DISABLED');

  const missing = integrations.buildSuperpowersDispatch({ taskContract, config: enabled(), present: false });
  assert.equal(missing.ok, false);
  assert.equal(missing.diagnostics[0].code, 'BRIDGE_ADAPTER_MISSING');
});

test('[req:BRIDGE-18] submitted binding cannot stand in for canonical task and active-context authority', () => {
  const selfValidated = integrations.buildSuperpowersDispatch({
    taskContract,
    activeContext: taskContract.binding,
    config: enabled(), detectedVersion: '1.3.0', present: true,
  });
  assert.equal(selfValidated.ok, false);
  assert.equal(selfValidated.diagnostics.some((item) => item.code === 'BRIDGE_CANONICAL_AUTHORITY_REQUIRED'), true);

  const selfDeclared = integrations.buildSuperpowersDispatch({
    taskContract,
    canonicalAuthority: {
      authority: 'wendkeep-canonical',
      task_contract: structuredClone(taskContract), active_context: structuredClone(taskContract.binding),
    },
    config: enabled(), detectedVersion: '1.3.0', present: true,
  });
  assert.equal(selfDeclared.ok, false);
  assert.equal(selfDeclared.diagnostics.some((item) => item.code === 'BRIDGE_CANONICAL_AUTHORITY_REQUIRED'), true);

  const tampered = structuredClone(taskContract);
  tampered.binding.head_sha = '9'.repeat(40);
  const compared = integrations.buildSuperpowersDispatch({
    taskContract: tampered,
    canonicalAuthority: canonicalAuthority(),
    config: enabled(), detectedVersion: '1.3.0', present: true,
  });
  assert.equal(compared.ok, false);
  assert.equal(compared.diagnostics.some((item) => item.code === 'BRIDGE_CONTRACT_STALE'), true);

  const divergentContext = integrations.buildSuperpowersDispatch({
    taskContract,
    canonicalAuthority: canonicalAuthority(taskContract, { ...taskContract.binding, head_sha: '8'.repeat(40) }),
    config: enabled(), detectedVersion: '1.3.0', present: true,
  });
  assert.equal(divergentContext.ok, false);
  assert.equal(divergentContext.diagnostics.some((item) => item.code === 'BRIDGE_CONTRACT_INVALID'), true);
});

test('[req:BRIDGE-20] fabricated projection and external ownership claims block dispatch', () => {
  const fabricated = validSpecProjection();
  fabricated.references[0].sha256 = '2'.repeat(64);
  const invalidProjection = integrations.buildSuperpowersDispatch({
    taskContract, canonicalAuthority: canonicalAuthority(), specKitProjection: fabricated,
    config: enabled(), detectedVersion: '1.3.0', present: true,
  });
  assert.equal(invalidProjection.ok, false);
  assert.equal(invalidProjection.diagnostics.some((item) => item.code === 'BRIDGE_PROJECTION_INVALID'), true);

  const blocked = integrations.sealBridgeProjection({
    ...validSpecProjection(), ok: false,
    diagnostics: [{ schema_version: 1, code: 'BRIDGE_SOURCE_DRIFT', adapter: 'spec-kit', blocking: true, message: 'stale' }],
  });
  const decisionTampered = { ...blocked, ok: true, diagnostics: [] };
  const invalidDecision = integrations.buildSuperpowersDispatch({
    taskContract, canonicalAuthority: canonicalAuthority(), specKitProjection: decisionTampered,
    config: enabled(), detectedVersion: '1.3.0', present: true,
  });
  assert.equal(invalidDecision.ok, false);
  assert.equal(invalidDecision.diagnostics.some((item) => item.code === 'BRIDGE_PROJECTION_INVALID'), true);

  const ownershipConfig = integrations.normalizeBridgeConfig({
    adapters: { superpowers: { enabled: true, ownership_claims: [{ concept: 'task', owner: 'superpowers' }] } },
  });
  const ownership = integrations.buildSuperpowersDispatch({
    taskContract, canonicalAuthority: canonicalAuthority(),
    config: ownershipConfig, detectedVersion: '1.3.0', present: true,
  });
  assert.equal(ownership.ok, false);
  assert.equal(ownership.diagnostics.some((item) => item.code === 'BRIDGE_OWNERSHIP_CONFLICT'), true);
});

test('[req:BRIDGE-21] Superpowers dispatch never treats incompatible or foreign projection refs as Spec Kit refs', () => {
  const valid = validSpecProjection();
  const blockingDiagnostic = {
    schema_version: 1, code: 'BRIDGE_SOURCE_DRIFT', adapter: 'spec-kit', blocking: true, message: 'stale source',
  };
  const invalidProjections = [
    integrations.sealBridgeProjection({ ...valid, ok: false, diagnostics: [] }),
    integrations.sealBridgeProjection({ ...valid, ok: true, diagnostics: [blockingDiagnostic] }),
    integrations.sealBridgeProjection({
      ...valid, adapter: 'superpowers', origin: { ...valid.origin, tool: 'superpowers' },
    }),
    integrations.sealBridgeProjection({
      ...valid, adapter_version: '9.0.0', origin: { ...valid.origin, version: '9.0.0' },
      compatibility: { ...valid.compatibility, detected_version: '9.0.0', supported: true },
    }),
    integrations.sealBridgeProjection({
      ...valid, references: [{ ...valid.references[0], kind: 'opaque-command' }],
    }),
  ];
  for (const specKitProjection of invalidProjections) {
    const result = integrations.buildSuperpowersDispatch({
      taskContract, canonicalAuthority: canonicalAuthority(), specKitProjection,
      config: enabled(), detectedVersion: '1.3.0', present: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === 'BRIDGE_PROJECTION_INVALID'), true);
    assert.equal(Object.hasOwn(result, 'spec_refs'), false);
  }
});

test('[req:BRIDGE-14] task facade delegates dispatch without granting external ownership', () => {
  assert.equal(typeof taskCommand.buildExternalTaskDispatch, 'function');
  const result = taskCommand.buildExternalTaskDispatch({
    adapter: 'superpowers', taskContract, canonicalAuthority: canonicalAuthority(),
    config: enabled(), detectedVersion: '1.3.0', present: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.canonical_owner, 'wendkeep');
  assert.equal(Object.hasOwn(result, 'external_owner'), false);
});

test('[req:BRIDGE-20] governed composition root requires canonical Spec Kit baseline and projection', () => {
  const config = integrations.normalizeBridgeConfig({
    adapters: {
      'spec-kit': { enabled: true, version: '1.1.0' },
      superpowers: { enabled: true, version: '1.3.0' },
    },
  });
  const result = taskCommand.buildCanonicalExternalTaskDispatch({
    adapter: 'superpowers', config, projectRoot: process.cwd(), taskId: '3.1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.some((item) => item.code === 'BRIDGE_BASELINE_MISSING'), true);
});
