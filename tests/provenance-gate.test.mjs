import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVENANCE_STATES,
  classifyEvidenceEnvelope,
  classifyReceipt,
  evaluateProvenanceGate,
  evaluateReleaseChain,
  repairForAssessment,
} from '../src/provenance-gate.mjs';
import { canonicalSha256 } from '../src/evidence-envelope.mjs';
import { buildReceiptRecord, receiptGenesisHash } from '../src/receipt-ledger.mjs';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

function context(overrides = {}) {
  return {
    project_id: 'project-1',
    repository_id: 'repository-1',
    worktree_id: 'worktree-1',
    work_session_id: 'session-1',
    change_slug: 'provenance-gates',
    branch: 'wk/provenance-gates',
    head_sha: HEAD,
    base_sha: '0'.repeat(40),
    index_tree_sha: '1'.repeat(40),
    worktree_digest: `sha256:${'2'.repeat(64)}`,
    tasks_sha256: `sha256:${'3'.repeat(64)}`,
    effective_spec_sha256: `sha256:${'4'.repeat(64)}`,
    sensor_config_sha256: `sha256:${'5'.repeat(64)}`,
    ...overrides,
  };
}

function envelope(overrides = {}) {
  const value = {
    schema_version: 2,
    ...context(),
    dirty: false,
    package_name: 'wendkeep',
    package_version: '0.79.0',
    sensors: [],
    ...overrides,
  };
  const unsigned = { ...value };
  delete unsigned.envelope_id;
  return { ...value, envelope_id: canonicalSha256(unsigned) };
}

function receipt(overrides = {}) {
  return {
    schema_version: 2,
    sequence: 1,
    receipt_id: 'receipt-1',
    previous_hash: `sha256:${'7'.repeat(64)}`,
    receipt_hash: `sha256:${'8'.repeat(64)}`,
    kind: 'verify',
    subject: context(),
    claims: { outcome: 'completed' },
    observations: {},
    recorded_at: '2026-08-23T12:00:00.000Z',
    ...overrides,
  };
}

function releaseChain(overrides = {}) {
  return {
    commit: { sha: HEAD },
    tag: { name: 'v0.79.0', commit: HEAD },
    package: { name: 'wendkeep', version: '0.79.0', commit: HEAD },
    artifact: { integrity: 'sha512-artifact', commit: HEAD },
    npm: {
      name: 'wendkeep', version: '0.79.0', integrity: 'sha512-artifact',
      repository: 'rogersialves/wendkeep', commit: HEAD,
    },
    ci: { status: 'success', commit: HEAD, repository: 'rogersialves/wendkeep' },
    release: {
      tag: 'v0.79.0', version: '0.79.0', commit: HEAD,
      repository: 'rogersialves/wendkeep', status: 'published',
    },
    ...overrides,
  };
}

test('[req:PROV-1] v2 envelope is verified only for the current causal subject', () => {
  const result = classifyEvidenceEnvelope({ evidence: envelope(), expected: context() });
  assert.equal(result.state, 'verified');
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.ok, true);

  const stale = classifyEvidenceEnvelope({
    evidence: envelope(),
    expected: context({ worktree_digest: `sha256:${'9'.repeat(64)}` }),
  });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.ok, false);
  assert.ok(stale.reasonCodes.includes('WENDKEEP_PROVENANCE_STALE'));
});

test('[req:PROV-2] missing and v1 evidence stay unproven or legacy-unbound', () => {
  assert.equal(classifyEvidenceEnvelope({ evidence: null, expected: context() }).state, 'unproven');
  assert.equal(
    classifyEvidenceEnvelope({ evidence: [{ id: 'tests', status: 'green' }], expected: context() }).state,
    'legacy-unbound',
  );
  assert.deepEqual(PROVENANCE_STATES, [
    'verified', 'reported', 'legacy-unbound', 'stale', 'conflict', 'unproven',
  ]);
});

test('[req:PROV-1] envelope binding detects foreign context and package/verdict divergence', () => {
  const foreign = classifyEvidenceEnvelope({
    evidence: envelope(),
    expected: context({ worktree_id: 'worktree-foreign' }),
  });
  assert.equal(foreign.state, 'conflict');
  assert.ok(foreign.reasonCodes.includes('WENDKEEP_PROVENANCE_CONTEXT_MISMATCH'));

  const divergentPackage = classifyEvidenceEnvelope({
    evidence: envelope(),
    expected: context(),
    verification: { package_name: 'other-package', package_version: '0.79.0', head_sha: HEAD },
  });
  assert.equal(divergentPackage.state, 'conflict');
  assert.ok(divergentPackage.reasonCodes.includes('WENDKEEP_PROVENANCE_BINDING_CONFLICT'));

  const divergentVerdict = classifyEvidenceEnvelope({
    evidence: envelope(),
    expected: context(),
    verdict: { head_sha: OTHER_HEAD, change_slug: context().change_slug },
  });
  assert.equal(divergentVerdict.state, 'conflict');
});

test('[req:PROV-2] receipt claim is reported until an observation verifies its subject', () => {
  const claimed = classifyReceipt({ receipt: receipt(), subject: context() });
  assert.equal(claimed.state, 'reported');
  assert.equal(claimed.ok, false);

  const verified = classifyReceipt({
    receipt: receipt(),
    observation: { status: 'verified', receipt_id: 'receipt-1', ...context() },
    subject: context(),
  });
  assert.equal(verified.state, 'verified');
  assert.equal(verified.ok, true);

  const conflict = classifyReceipt({
    receipt: receipt(),
    observation: { status: 'verified', receipt_id: 'receipt-1', head_sha: OTHER_HEAD },
    subject: context(),
  });
  assert.equal(conflict.state, 'conflict');
});

test('[req:PROV-2] a real hash-chained v2 receipt uses kind and binds through subject', () => {
  const subject = context();
  const realReceipt = buildReceiptRecord({
    kind: 'verify',
    subject,
    claims: { outcome: 'completed' },
    observations: { verdict: 'verified' },
    recorded_at: '2026-08-23T12:00:00.000Z',
  }, { sequence: 1, previousHash: receiptGenesisHash('') });
  const result = classifyReceipt({
    receipt: realReceipt,
    observation: { status: 'verified', receipt_id: realReceipt.receipt_id, ...subject },
    subject,
  });

  assert.equal(result.state, 'verified');
  assert.equal(result.kind, 'verify');
});

test('[req:PROV-2] incomplete or self-asserted observations never verify a receipt', () => {
  const selfAsserted = classifyReceipt({
    receipt: receipt(),
    observation: { ok: true },
    subject: context(),
  });
  const partial = classifyReceipt({
    receipt: receipt(),
    observation: { status: 'verified', receipt_id: 'receipt-1', head_sha: HEAD },
    subject: context(),
  });

  assert.equal(selfAsserted.state, 'reported');
  assert.equal(selfAsserted.ok, false);
  assert.equal(partial.state, 'reported');
  assert.equal(partial.ok, false);
  assert.ok(partial.reasonCodes.includes('PROV_RECEIPT_OBSERVATION_MISSING'));
});

test('[req:PROV-5] offline or missing external observation never promotes a receipt', () => {
  const offline = classifyReceipt({
    receipt: receipt({ claim: { source: 'npm', status: 'published' } }),
    observation: { status: 'offline', source: 'npm' },
    subject: context(),
  });
  assert.equal(offline.state, 'reported');
  assert.equal(offline.ok, false);

  const absent = classifyReceipt({ receipt: receipt(), subject: context() });
  assert.equal(absent.state, 'reported');
  assert.ok(absent.reasonCodes.includes('PROV_RECEIPT_OBSERVATION_MISSING'));
});

test('[req:PROV-6] release chain verifies commit, tag, package, artifact, CI, NPM and release', () => {
  const result = evaluateReleaseChain({
    chain: releaseChain(),
    context: {
      repository: 'rogersialves/wendkeep',
      target_commit: HEAD,
      package_name: 'wendkeep',
      package_version: '0.79.0',
      tag: 'v0.79.0',
    },
  });
  assert.equal(result.state, 'verified');
  assert.equal(result.ok, true);

  const mismatch = evaluateReleaseChain({
    chain: releaseChain({ tag: { name: 'v0.79.0', commit: OTHER_HEAD } }),
    context: {
      repository: 'rogersialves/wendkeep', target_commit: HEAD,
      package_name: 'wendkeep', package_version: '0.79.0', tag: 'v0.79.0',
    },
  });
  assert.equal(mismatch.state, 'conflict');
  assert.ok(mismatch.reasonCodes.includes('PROV_RELEASE_CHAIN_CONFLICT'));
});

test('[req:PROV-6] release chain cannot derive its authority from self-asserted parts', () => {
  const result = evaluateReleaseChain({ chain: releaseChain() });

  assert.equal(result.state, 'unproven');
  assert.equal(result.ok, false);
  assert.ok(result.reasonCodes.includes('PROV_RELEASE_CHAIN_UNPROVEN'));
});

test('[req:PROV-6] release chain requires authoritative commit and repository bindings', () => {
  const expected = {
    repository: 'rogersialves/wendkeep',
    target_commit: HEAD,
    package_name: 'wendkeep',
    package_version: '0.79.0',
    tag: 'v0.79.0',
  };
  const missingNpmCommit = evaluateReleaseChain({
    chain: releaseChain({
      npm: { name: 'wendkeep', version: '0.79.0', integrity: 'sha512-artifact', repository: 'rogersialves/wendkeep' },
    }),
    context: expected,
  });
  const missingReleaseAuthority = evaluateReleaseChain({
    chain: releaseChain({
      release: { tag: 'v0.79.0', version: '0.79.0' },
    }),
    context: expected,
  });

  assert.equal(missingNpmCommit.state, 'unproven');
  assert.equal(missingReleaseAuthority.state, 'unproven');
});

test('[req:PROV-6] completed is not a successful CI conclusion', () => {
  const result = evaluateReleaseChain({
    chain: releaseChain({
      ci: { status: 'completed', commit: HEAD, repository: 'rogersialves/wendkeep' },
    }),
    context: {
      repository: 'rogersialves/wendkeep',
      target_commit: HEAD,
      package_name: 'wendkeep',
      package_version: '0.79.0',
      tag: 'v0.79.0',
    },
  });

  assert.equal(result.state, 'conflict');
  assert.equal(result.ok, false);
});

test('[req:PROV-2] aggregate gate uses deterministic precedence and only verified satisfies required kinds', () => {
  const result = evaluateProvenanceGate({
    purpose: 'archive',
    assessments: {
      envelope: { kind: 'envelope', state: 'verified', reasonCodes: [] },
      package: { kind: 'package', state: 'stale', reasonCodes: ['PACKAGE_STALE'] },
      verdict: { kind: 'verdict', state: 'conflict', reasonCodes: ['VERDICT_FOREIGN'] },
      optional: { kind: 'optional', state: 'reported', reasonCodes: ['OFFLINE'] },
    },
    requiredKinds: ['envelope', 'package', 'verdict'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'conflict');
  assert.deepEqual(result.reasonCodes, ['VERDICT_FOREIGN', 'PACKAGE_STALE']);
  assert.equal(result.diagnostics[0].kind, 'verdict');
  assert.match(result.repair.command, /wendkeep verify --deep/);

  const missing = evaluateProvenanceGate({
    purpose: 'archive', assessments: { envelope: { state: 'verified' } },
    requiredKinds: ['envelope', 'verdict'],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.state, 'unproven');
  assert.ok(missing.reasonCodes.includes('PROV_REQUIRED_ASSESSMENT_MISSING'));
});

test('[req:PROV-2] unknown assessment states normalize to fail-closed unproven', () => {
  const result = evaluateProvenanceGate({
    purpose: 'archive',
    assessments: [{ kind: 'verdict', state: 'banana', reasonCodes: [] }],
    requiredKinds: ['verdict'],
  });

  assert.equal(result.state, 'unproven');
  assert.equal(result.ok, false);
  assert.ok(result.reasonCodes.includes('PROV_ASSESSMENT_STATE_INVALID'));
});

test('[req:PROV-8] recovery is deterministic, serializable and carries no private evidence', () => {
  const assessment = {
    kind: 'envelope',
    state: 'stale',
    reasonCodes: ['WENDKEEP_PROVENANCE_STALE'],
    diagnostics: { expected: 'sha256:expected', observed: 'sha256:observed' },
  };
  const first = repairForAssessment({ assessment, context: { purpose: 'archive', change: 'provenance-gates' } });
  const second = repairForAssessment({ assessment, context: { purpose: 'archive', change: 'provenance-gates' } });
  assert.deepEqual(first, second);
  assert.equal(first.command, 'wendkeep verify --deep');
  assert.match(first.explanation, /fresh|fresca/i);
  assert.doesNotMatch(JSON.stringify(first), /C:\\|\/Users\/|token|secret/i);
});

test('[req:PROV-8] aggregate diagnostics redact secrets and local paths from values', () => {
  const assessment = classifyReceipt({
    receipt: null,
    subject: {
      note: 'Authorization: Bearer secret-token token=another-secret',
      cwd: 'C:\\private\\vault\\receipt.json',
      unix_location: '/Users/roger/private/receipt.json',
    },
  });
  const result = evaluateProvenanceGate({
    purpose: 'archive', assessments: [assessment], requiredKinds: ['receipt'],
  });
  const serialized = JSON.stringify(result.diagnostics);

  assert.doesNotMatch(serialized, /secret-token|another-secret|C:\\\\private|\/Users\/roger/i);
  assert.match(serialized, /\[redacted/);
});
