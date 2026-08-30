import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tasksHashOf } from '../hooks/spec-core.mjs';
import { canonicalSha256 } from '../packages/vault/src/evidence-envelope.mjs';
import { buildReceiptRecord, receiptGenesisHash } from '../src/receipt-ledger.mjs';
import {
  collectCommitSensorProof,
  contentSha256,
  validateCommitProofSet,
} from '../packages/commit/src/proof-validation.mjs';

const STAGED = 'a'.repeat(64);
const TASK_SOURCE = '# Tasks\n\n- [x] COMMIT-T1 Validar contrato [phase:verify]\n';
const SENSOR_TASK_SOURCE = '# Tasks\n\n- [x] COMMIT-T1 Validar contrato [phase:verify] [sensor:commit-focused]\n';
const REQUIREMENT_TASK_SOURCE = '# Tasks\n\n- [x] COMMIT-T1 Validar contrato [req:COMMIT-PUBLIC-1] [sensor:commit-focused]\n';
const SENSOR_DEFINITION = {
  id: 'commit-focused', severity: 'critical', command: 'node -e "process.exit(0)"',
};
const EXECUTION_PROOF = collectCommitSensorProof({
  sensors: [SENSOR_DEFINITION], ids: [SENSOR_DEFINITION.id], cwd: process.cwd(),
});
const entry = (kind, path, content) => ({ kind, path, content, sha256: contentSha256(content) });
const task = (source = TASK_SOURCE) => entry('task', 'plans/tasks.md', source);
const adr = (content = '# ADR-1234\n\nIssue #123\n') => entry('adr', 'docs/ADR-1234.md', content);
const spec = (content = '## Requirements\n\n### Requirement: COMMIT-PUBLIC-1 — public proof\nObservable behavior.\n') => (
  entry('spec', 'docs/specs/commit.md', content)
);
const context = { projectId: 'fixture', changeSlug: 'adr-1234', headSha: 'b'.repeat(40), profile: 'OFF' };

function greenSensor() {
  return { ...EXECUTION_PROOF.results[0] };
}

function canonicalEnvelope(overrides = {}) {
  const unsigned = {
    schema_version: 2,
    project_id: 'fixture',
    repository_id: 'repository-fixture',
    worktree_id: 'worktree-fixture',
    work_session_id: 'session-author',
    change_slug: 'adr-1234',
    branch: 'wk/fixture',
    base_sha: '1'.repeat(40),
    head_sha: context.headSha,
    index_tree_sha: '2'.repeat(40),
    worktree_digest: `sha256:${'3'.repeat(64)}`,
    dirty: true,
    tasks_sha256: tasksHashOf(SENSOR_TASK_SOURCE),
    effective_spec_sha256: `sha256:${'5'.repeat(64)}`,
    sensor_config_sha256: EXECUTION_PROOF.configSha256,
    wendkeep_version: '0.85.0',
    platform: 'win32-x64',
    started_at: '2026-08-29T12:00:00.000Z',
    finished_at: '2026-08-29T12:00:01.000Z',
    sensors: [greenSensor()],
    ...overrides,
  };
  return { ...unsigned, envelope_id: canonicalSha256(unsigned) };
}

function boundContext(envelope) {
  return {
    ...context,
    repositoryId: envelope.repository_id,
    worktreeId: envelope.worktree_id,
    workSessionId: envelope.work_session_id,
    branch: envelope.branch,
    baseSha: envelope.base_sha,
    indexTreeSha: envelope.index_tree_sha,
    worktreeDigest: envelope.worktree_digest,
    dirty: envelope.dirty,
    tasksSha256: envelope.tasks_sha256,
    effectiveSpecSha256: envelope.effective_spec_sha256,
    sensorConfigSha256: envelope.sensor_config_sha256,
    executionProof: EXECUTION_PROOF,
  };
}

function boundVerdict(envelope) {
  return {
    ok: true,
    coverage: [],
    notes: [],
    author_session_id: 'session-author',
    verifier_session_id: 'session-reviewer',
    tasksHash: envelope.tasks_sha256,
    effectiveSpecHash: envelope.effective_spec_sha256.replace(/^sha256:/, ''),
    evidenceEnvelopeId: envelope.envelope_id,
    evidenceBinding: {
      project_id: envelope.project_id,
      repository_id: envelope.repository_id,
      worktree_id: envelope.worktree_id,
      work_session_id: envelope.work_session_id,
      change_slug: envelope.change_slug,
      branch: envelope.branch,
      base_sha: envelope.base_sha,
      head_sha: envelope.head_sha,
      index_tree_sha: envelope.index_tree_sha,
      worktree_digest: envelope.worktree_digest,
      dirty: envelope.dirty,
      tasks_sha256: envelope.tasks_sha256,
      effective_spec_sha256: envelope.effective_spec_sha256,
      sensor_config_sha256: envelope.sensor_config_sha256,
    },
  };
}

test('[req:COMMIT-43] ADR e design existentes mas semanticamente inválidos não viram autoridade', () => {
  assert.throws(() => validateCommitProofSet({
    entries: [adr('# Nota que apenas menciona ADR-1234 e Issue #123\n'), task()],
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    stagedHash: STAGED,
    context,
  }), /ADR artifact does not match/);

  assert.throws(() => validateCommitProofSet({
    entries: [entry('design', 'docs/superpowers/specs/design.md', 'Texto solto sobre Issue #40.\n'), task()],
    authority: { kind: 'native', issue: '#40', design: 'docs/superpowers/specs/design.md' },
    stagedHash: STAGED,
    context,
  }), /design artifact does not own/);
});

test('[req:COMMIT-44] Evidence Envelope com sensors vazio não prova testes', () => {
  const unsigned = { schema_version: 2, staged_diff_sha256: STAGED, sensors: [] };
  const envelope = { ...unsigned, envelope_id: canonicalSha256(unsigned) };
  assert.throws(() => validateCommitProofSet({
    entries: [adr(), task(SENSOR_TASK_SOURCE), entry('evidence', 'tests/fixtures/evidence.json', JSON.stringify(envelope))],
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    stagedHash: STAGED,
    context,
  }), /has no sensors/);
});

test('[req:COMMIT-45] receipt com status textual mas sem chain/hash/observation válidos falha', () => {
  const fake = {
    records: [{ schema_version: 2, status: 'completed', staged_diff_sha256: STAGED }],
    subject: { staged_diff_sha256: STAGED },
    observation: { state: 'verified' },
  };
  assert.throws(() => validateCommitProofSet({
    entries: [adr(), task(), entry('receipt', 'tests/fixtures/receipt.json', JSON.stringify(fake))],
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    stagedHash: STAGED,
    context,
  }), /Receipt 1|campos ausentes|receipt/i);
});

test('[req:COMMIT-46] Evidence Envelope canônico vincula o staged tree sem campo caller textual', () => {
  const envelope = canonicalEnvelope();
  const resolved = validateCommitProofSet({
    entries: [
      adr(), task(SENSOR_TASK_SOURCE),
      entry('evidence', 'tests/fixtures/evidence.json', JSON.stringify(envelope)),
      entry('verdict', 'tests/fixtures/verdict.json', JSON.stringify(boundVerdict(envelope))),
    ],
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    stagedHash: STAGED,
    context: boundContext(envelope),
  });
  assert.deepEqual(resolved.tests, [
    'sensor:commit-focused (node -e "process.exit(0)")',
  ]);
});

test('[req:COMMIT-47] Evidence Envelope com identidade incompleta falha mesmo com hash interno válido', () => {
  const complete = canonicalEnvelope();
  const { envelope_id: ignored, project_id: missing, ...unsigned } = complete;
  assert.equal(missing, 'fixture');
  const incomplete = { ...unsigned, envelope_id: canonicalSha256(unsigned) };
  assert.throws(() => validateCommitProofSet({
    entries: [adr(), task(SENSOR_TASK_SOURCE), entry('evidence', 'tests/fixtures/evidence.json', JSON.stringify(incomplete))],
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    stagedHash: STAGED,
    context: { ...context, indexTreeSha: incomplete.index_tree_sha },
  }), /schema\/binding is incomplete/);
});

test('[req:COMMIT-48] verdict independente sem seals canônicos completos não prova cobertura', () => {
  const envelope = canonicalEnvelope();
  const verdict = {
    ok: true,
    coverage: [],
    author_session_id: 'session-author',
    verifier_session_id: 'session-reviewer',
    evidenceEnvelopeId: envelope.envelope_id,
    evidenceBinding: Object.fromEntries([
      'project_id', 'repository_id', 'worktree_id', 'head_sha', 'index_tree_sha', 'worktree_digest',
    ].map((key) => [key, envelope[key]])),
  };
  assert.throws(() => validateCommitProofSet({
    entries: [
      adr(), task(SENSOR_TASK_SOURCE),
      entry('evidence', 'tests/fixtures/evidence.json', JSON.stringify(envelope)),
      entry('verdict', 'tests/fixtures/verdict.json', JSON.stringify(verdict)),
    ],
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    stagedHash: STAGED,
    context: boundContext(envelope),
  }), /lacks complete canonical seals or coverage/);
});

test('[req:COMMIT-49] checklist phase verify não é resultado de execução', () => {
  assert.throws(() => validateCommitProofSet({
    entries: [adr(), task()],
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    stagedHash: STAGED,
    context,
  }), /no authenticated execution proof supplies tests/);
});

test('[req:COMMIT-50] sensor green fabricado em Envelope sem proof independente não autentica testes', () => {
  const envelope = canonicalEnvelope();
  assert.throws(() => validateCommitProofSet({
    entries: [adr(), task(SENSOR_TASK_SOURCE), entry('evidence', 'tests/fixtures/evidence.json', JSON.stringify(envelope))],
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    stagedHash: STAGED,
    context: boundContext(envelope),
  }), /requires an independently bound verdict or attestation/);
});

test('[req:COMMIT-51] expected canônico ausente não vira skip no binding governado', () => {
  const envelope = canonicalEnvelope();
  assert.throws(() => validateCommitProofSet({
    entries: [
      adr(), task(SENSOR_TASK_SOURCE),
      entry('evidence', 'tests/fixtures/evidence.json', JSON.stringify(envelope)),
      entry('verdict', 'tests/fixtures/verdict.json', JSON.stringify(boundVerdict(envelope))),
    ],
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    stagedHash: STAGED,
    context: { projectId: 'fixture', changeSlug: 'adr-1234', indexTreeSha: envelope.index_tree_sha },
  }), /canonical expected binding is incomplete/);
});

test('[req:COMMIT-52] Envelope cross-repo, cross-worktree ou cross-session falha fechado', () => {
  const envelope = canonicalEnvelope();
  for (const [field, value] of [
    ['repositoryId', 'repository-foreign'],
    ['worktreeId', 'worktree-foreign'],
    ['workSessionId', 'session-foreign'],
  ]) {
    assert.throws(() => validateCommitProofSet({
      entries: [
        adr(), task(SENSOR_TASK_SOURCE),
        entry('evidence', 'tests/fixtures/evidence.json', JSON.stringify(envelope)),
        entry('verdict', 'tests/fixtures/verdict.json', JSON.stringify(boundVerdict(envelope))),
      ],
      authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
      stagedHash: STAGED,
      context: { ...boundContext(envelope), [field]: value },
    }), /not internally bound/);
  }
});

test('[req:COMMIT-54] sensor nunca executado não vira Test por Verdict autoconsistente', () => {
  const canonical = canonicalEnvelope();
  const forgedSensor = {
    ...canonical.sensors[0],
    output_sha256: `sha256:${'f'.repeat(64)}`,
    output_tail: 'never ran',
  };
  const { envelope_id: ignored, ...unsigned } = canonical;
  const forged = { ...unsigned, sensors: [forgedSensor] };
  forged.envelope_id = canonicalSha256(forged);
  assert.throws(() => validateCommitProofSet({
    entries: [
      adr(), task(SENSOR_TASK_SOURCE),
      entry('evidence', 'tests/fixtures/evidence.json', JSON.stringify(forged)),
      entry('verdict', 'tests/fixtures/verdict.json', JSON.stringify(boundVerdict(forged))),
    ],
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    stagedHash: STAGED,
    context: boundContext(forged),
  }), /does not match canonical reexecution/);
});

test('[req:COMMIT-55] Envelope rejeita sensor extra, ausente, duplicado ou configuração divergente', () => {
  const canonical = canonicalEnvelope();
  const variants = [
    [],
    [canonical.sensors[0], canonical.sensors[0]],
    [canonical.sensors[0], { ...canonical.sensors[0], id: 'extra' }],
    [{ ...canonical.sensors[0], command: 'node -e "process.exit(1)"' }],
    [{ ...canonical.sensors[0], severity: 'warning' }],
  ];
  for (const sensors of variants) {
    const { envelope_id: ignored, ...unsigned } = canonical;
    const forged = { ...unsigned, sensors };
    forged.envelope_id = canonicalSha256(forged);
    assert.throws(() => validateCommitProofSet({
      entries: [
        adr(), task(SENSOR_TASK_SOURCE),
        entry('evidence', 'tests/fixtures/evidence.json', JSON.stringify(forged)),
        entry('verdict', 'tests/fixtures/verdict.json', JSON.stringify(boundVerdict(forged))),
      ],
      authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
      stagedHash: STAGED,
      context: boundContext(forged),
    }), /has no sensors|do not exactly match|does not match canonical reexecution|not a complete green observation/);
  }
});

test('[req:COMMIT-56] Envelope e Verdict FOREIGN autoconsistentes não definem expected histórico', () => {
  const identity = {
    project_id: 'fixture', repository_id: 'repository-foreign', worktree_id: 'worktree-foreign',
    work_session_id: 'session-foreign', change_slug: 'adr-1234',
  };
  const causal = { ...identity, task_id: 'COMMIT-T1', requirement_id: 'COMMIT-56' };
  const base = canonicalEnvelope({
    ...identity,
    tdd_attestations: [{
      schema_version: 1,
      attestation_id: canonicalSha256(causal).replace(/^sha256:/, ''),
      ...causal,
      profile: 'GOVERN',
      state: 'green-observed',
      test_paths: ['tests/commit-proof-validation.test.mjs'],
      red: {},
      green: {
        branch: 'wk/foreign', head_sha: context.headSha, index_tree_sha: '2'.repeat(40),
        worktree_digest: `sha256:${'3'.repeat(64)}`,
      },
      green_history: [], waiver: null, review_flags: [], invalid_reason: null,
    }],
    branch: 'wk/foreign',
  });
  const entries = [
    adr(), task(SENSOR_TASK_SOURCE),
    entry('evidence', 'tests/fixtures/evidence.json', JSON.stringify(base)),
    entry('verdict', 'tests/fixtures/verdict.json', JSON.stringify(boundVerdict(base))),
  ];
  assert.throws(() => validateCommitProofSet({
    entries,
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    stagedHash: STAGED,
    context: {
      projectId: 'fixture',
      repositoryId: 'repository-derived-from-origin',
      changeSlug: 'adr-1234',
      baseSha: base.base_sha,
      headSha: base.head_sha,
      indexTreeSha: base.index_tree_sha,
      worktreeDigest: base.worktree_digest,
      dirty: base.dirty,
      tasksSha256: base.tasks_sha256,
      sensorConfigSha256: base.sensor_config_sha256,
      executionProof: EXECUTION_PROOF,
    },
  }), /canonical expected binding is incomplete/);
});

test('[req:COMMIT-57] receipt autocontido não inventa branch, worktree, sessão ou spec históricos', () => {
  const envelope = canonicalEnvelope();
  const subject = {
    staged_diff_sha256: STAGED,
    ...boundVerdict(envelope).evidenceBinding,
  };
  const receipt = buildReceiptRecord({
    kind: 'verify', subject, claims: { outcome: 'completed' },
    observations: { verdict: 'verified' }, recorded_at: '2026-08-29T12:00:00.000Z',
  }, { sequence: 1, previousHash: receiptGenesisHash('') });
  const receiptBundle = {
    records: [receipt],
    subject,
    observation: { status: 'verified', receipt_id: receipt.receipt_id, ...subject },
  };
  const entries = [
    adr(), task(SENSOR_TASK_SOURCE),
    entry('evidence', 'tests/fixtures/evidence.json', JSON.stringify(envelope)),
    entry('verdict', 'tests/fixtures/verdict.json', JSON.stringify(boundVerdict(envelope))),
    entry('receipt', 'tests/fixtures/receipt.json', JSON.stringify(receiptBundle)),
  ];
  assert.doesNotThrow(() => validateCommitProofSet({
    entries,
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    stagedHash: STAGED,
    context: boundContext(envelope),
  }));
  assert.throws(() => validateCommitProofSet({
    entries,
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    stagedHash: STAGED,
    context: {
      projectId: envelope.project_id,
      repositoryId: envelope.repository_id,
      changeSlug: envelope.change_slug,
      baseSha: envelope.base_sha,
      headSha: envelope.head_sha,
      indexTreeSha: envelope.index_tree_sha,
      worktreeDigest: envelope.worktree_digest,
      dirty: envelope.dirty,
      tasksSha256: envelope.tasks_sha256,
      sensorConfigSha256: envelope.sensor_config_sha256,
      executionProof: EXECUTION_PROOF,
    },
  }), /canonical expected binding is incomplete/);
});

test('[req:COMMIT-58] spec pública cobre requisitos e prova local é omitida da Evidence remota', () => {
  const envelope = canonicalEnvelope({ tasks_sha256: tasksHashOf(REQUIREMENT_TASK_SOURCE) });
  const verdict = boundVerdict(envelope);
  verdict.coverage = [{ req: 'COMMIT-PUBLIC-1', covered: true, evidence: 'docs/specs/commit.md' }];
  const localEntries = [
    adr(), task(REQUIREMENT_TASK_SOURCE), spec(),
    entry('evidence', 'tests/fixtures/evidence.json', JSON.stringify(envelope)),
    entry('verdict', 'tests/fixtures/verdict.json', JSON.stringify(verdict)),
  ];
  const resolved = validateCommitProofSet({
    entries: localEntries,
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    stagedHash: STAGED,
    context: boundContext(envelope),
  });
  assert.deepEqual(resolved.evidence.map((item) => item.kind), ['adr', 'task', 'spec']);
  assert.ok(resolved.evidence.every((item) => item.status === 'verified'));
  for (const badSpecs of [[], [spec('### Requirement: OTHER-1 — wrong\n')]]) {
    assert.throws(() => validateCommitProofSet({
      entries: [adr(), task(REQUIREMENT_TASK_SOURCE), ...badSpecs],
      authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
      stagedHash: STAGED,
      context: { ...context, executionProof: EXECUTION_PROOF },
    }), /versioned sanitized public spec|does not define requirement/);
  }
});

test('[req:COMMIT-61] authority remota exige exatamente um ADR/design público versionado', () => {
  for (const entries of [
    [task()],
    [adr(), adr(), task()],
  ]) {
    assert.throws(() => validateCommitProofSet({
      entries,
      authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
      stagedHash: STAGED,
      context,
    }), /exactly one versioned adr authority artifact/);
  }
});

test('[req:COMMIT-62] tasks rederivadas usam a mesma ordem canônica da mensagem', () => {
  const source = [
    '# Tasks', '',
    '- [x] 84.1 Primeiro passo [sensor:commit-focused]',
    '- [x] 84.2 Segundo passo [sensor:commit-focused]',
    '- [x] 84.10 Décimo passo [sensor:commit-focused]',
    '- [x] 84.11 Décimo primeiro passo [sensor:commit-focused]',
    '',
  ].join('\n');
  const resolved = validateCommitProofSet({
    entries: [adr(), task(source)],
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    stagedHash: STAGED,
    context: { ...context, executionProof: EXECUTION_PROOF },
  });
  assert.deepEqual(resolved.tasks, [
    '84.1: Primeiro passo',
    '84.10: Décimo passo',
    '84.11: Décimo primeiro passo',
    '84.2: Segundo passo',
  ]);
});
