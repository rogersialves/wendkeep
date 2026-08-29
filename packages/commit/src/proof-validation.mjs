import { createHash } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';

import { parseTasks } from '../../../hooks/change-core.mjs';
import { evaluateVerdict, tasksHashOf } from '../../../hooks/spec-core.mjs';
import { deriveTaskContracts, evaluateTaskContracts } from '../../../src/task-contracts.mjs';
import { evaluateTddAttestation } from '../../../src/tdd-attestation.mjs';
import { sensorConfigSha256 } from '../../../src/evidence-envelope.mjs';
import { classifyReceipt } from '../../../src/provenance-gate.mjs';
import { verifyReceiptChain } from '../../../src/receipt-ledger.mjs';
import { requiredSensors, runSensors } from '../../harness/src/sensors-core.mjs';
import {
  canonicalSha256,
  evaluateEvidenceBinding,
  evidenceSensors,
} from '../../vault/src/evidence-envelope.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const SIGNED_REF = /^(.*)@sha256:([a-f0-9]{64})$/;
const SENSOR_HASH = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/;
const ENVELOPE_REQUIRED = [
  'schema_version', 'project_id', 'repository_id', 'worktree_id', 'work_session_id',
  'change_slug', 'branch', 'base_sha', 'head_sha', 'index_tree_sha', 'worktree_digest',
  'dirty', 'tasks_sha256', 'effective_spec_sha256', 'sensor_config_sha256',
  'wendkeep_version', 'platform', 'started_at', 'finished_at', 'sensors', 'envelope_id',
];
const ENVELOPE_ALLOWED = new Set([...ENVELOPE_REQUIRED, 'host_coverage', 'tdd_attestations']);
const PROOF_BINDING_KEYS = [
  'project_id', 'repository_id', 'worktree_id', 'work_session_id', 'change_slug',
  'branch', 'base_sha', 'head_sha', 'index_tree_sha', 'worktree_digest', 'dirty',
  'tasks_sha256', 'effective_spec_sha256', 'sensor_config_sha256',
];
const EXPECTED_CONTEXT_FIELDS = [
  'projectId', 'repositoryId', 'worktreeId', 'workSessionId', 'changeSlug',
  'branch', 'baseSha', 'headSha', 'indexTreeSha', 'worktreeDigest', 'dirty',
  'tasksSha256', 'effectiveSpecSha256', 'sensorConfigSha256',
];
const SENSOR_PROOF = Symbol('wendkeep.commit.sensor-proof');
const REMOTE_EVIDENCE_KINDS = new Set(['adr', 'design', 'spec', 'task']);
const SENSOR_RESULT_BINDING_FIELDS = [
  'id', 'status', 'severity', 'command', 'command_sha256', 'exit_code',
  'output_sha256', 'output_tail',
];

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function contentSha256(content) {
  return createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

export function signedEvidenceRef(path, content) {
  return `${path}@sha256:${contentSha256(content)}`;
}

export function parseSignedEvidenceRef(value) {
  const match = String(value || '').match(SIGNED_REF);
  if (!match) fail('WENDKEEP_COMMIT_EVIDENCE_DIGEST_MISSING', 'evidence reference must carry a SHA-256 content digest');
  const path = match[1].replaceAll('\\', '/');
  if (!path || isAbsolute(path) || path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    fail('WENDKEEP_COMMIT_REFERENCE_INVALID', 'signed evidence must use a canonical repository-relative path');
  }
  return { path, sha256: match[2] };
}

export function commitTaskSensorIds(entries = []) {
  const taskEntries = entries.filter((entry) => entry.kind === 'task');
  if (taskEntries.length !== 1) return [];
  return requiredSensors(parseTasks(taskEntries[0].content));
}

export function commitTaskRequirementIds(entries = []) {
  const taskEntries = entries.filter((entry) => entry.kind === 'task');
  if (taskEntries.length !== 1) return [];
  return [...new Set(parseTasks(taskEntries[0].content).flatMap((task) => task.reqs || []))];
}

export function collectCommitSensorProof({ sensors = [], ids = [], cwd, env } = {}) {
  const selected = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
  const definitions = new Map(sensors.map((sensor) => [String(sensor?.id || ''), sensor]));
  const missing = selected.filter((id) => !definitions.has(id));
  if (missing.length) {
    fail('WENDKEEP_COMMIT_SENSOR_CONFIG_MISSING', `required commit sensor is not configured: ${missing.join(', ')}`);
  }
  const results = runSensors(sensors, selected, { cwd, env });
  return Object.freeze({
    [SENSOR_PROOF]: true,
    ids: selected,
    definitions: selected.map((id) => definitions.get(id)),
    results,
    configSha256: sensorConfigSha256(sensors, selected),
  });
}

function json(content, path) {
  try { return JSON.parse(content); }
  catch { fail('WENDKEEP_COMMIT_EVIDENCE_INVALID', `structured evidence is invalid JSON: ${path}`); }
}

function validateSensor(sensor, path) {
  const required = [
    'id', 'status', 'severity', 'command', 'command_sha256', 'started_at', 'finished_at',
    'duration_ms', 'exit_code', 'output_sha256', 'output_tail',
  ];
  if (!sensor || required.some((field) => sensor[field] === undefined)) {
    fail('WENDKEEP_COMMIT_EVIDENCE_UNVERIFIED', `sensor provenance is incomplete: ${path}`);
  }
  if (!sensor.id || sensor.status !== 'green' || !['critical', 'warning'].includes(sensor.severity) || sensor.exit_code !== 0
    || !sensor.command || sensor.command_sha256 !== `sha256:${contentSha256(sensor.command)}`
    || !SENSOR_HASH.test(sensor.output_sha256)
    || !Number.isFinite(sensor.duration_ms) || sensor.duration_ms < 0
    || typeof sensor.output_tail !== 'string' || sensor.output_tail.length > 2_000
    || Number.isNaN(Date.parse(sensor.started_at)) || Number.isNaN(Date.parse(sensor.finished_at))) {
    fail('WENDKEEP_COMMIT_EVIDENCE_UNVERIFIED', `sensor result is not a complete green observation: ${path}`);
  }
}

function executionSensors(task, proof) {
  const ids = requiredSensors(task.tasks);
  if (!ids.length) return [];
  if (!proof?.[SENSOR_PROOF]) {
    fail('WENDKEEP_COMMIT_TESTS_UNPROVEN', 'required sensors were not executed by the canonical collector');
  }
  if (JSON.stringify([...proof.ids].sort()) !== JSON.stringify([...ids].sort())) {
    fail('WENDKEEP_COMMIT_SENSOR_BINDING_MISMATCH', 'executed sensors do not match canonical task requirements');
  }
  const definitions = new Map(proof.definitions.map((sensor) => [String(sensor?.id || ''), sensor]));
  for (const result of proof.results) {
    validateSensor(result, `sensor:${result.id}`);
    const definition = definitions.get(result.id);
    if (!definition || result.command !== definition.command
      || result.severity !== (definition.severity || 'critical')) {
      fail('WENDKEEP_COMMIT_SENSOR_BINDING_MISMATCH', `sensor result does not match configured command: ${result.id}`);
    }
  }
  if (proof.results.length !== ids.length) {
    fail('WENDKEEP_COMMIT_SENSOR_BINDING_MISMATCH', 'canonical sensor result set is incomplete');
  }
  return proof.results;
}

function assertEnvelopeSensorsMatchExecution(envelopeSensors, collectedSensors) {
  if (!envelopeSensors.length) return;
  if (!collectedSensors.length) {
    fail('WENDKEEP_COMMIT_SENSOR_PROOF_UNAUTHENTICATED', 'Envelope sensors require canonical reexecution');
  }
  const envelopeIds = envelopeSensors.map((sensor) => sensor.id);
  const executionIds = collectedSensors.map((sensor) => sensor.id);
  if (new Set(envelopeIds).size !== envelopeIds.length
    || JSON.stringify([...envelopeIds].sort()) !== JSON.stringify([...executionIds].sort())) {
    fail('WENDKEEP_COMMIT_SENSOR_BINDING_MISMATCH', 'Envelope sensors do not exactly match reexecuted task sensors');
  }
  const observed = new Map(collectedSensors.map((sensor) => [sensor.id, sensor]));
  for (const sensor of envelopeSensors) {
    const actual = observed.get(sensor.id);
    if (!actual || SENSOR_RESULT_BINDING_FIELDS.some((field) => sensor[field] !== actual[field])) {
      fail('WENDKEEP_COMMIT_SENSOR_BINDING_MISMATCH', `Envelope sensor does not match canonical reexecution: ${sensor.id}`);
    }
  }
}

function validateAttestation(attestation, path) {
  const identity = Object.fromEntries([
    'project_id', 'repository_id', 'worktree_id', 'work_session_id', 'change_slug',
  ].map((field) => [field, String(attestation?.[field] || '').trim()]));
  const causalSeal = {
    ...identity,
    task_id: String(attestation?.task_id || '').trim(),
    requirement_id: String(attestation?.requirement_id || '').trim(),
  };
  if (attestation?.schema_version !== 1 || !SHA256.test(String(attestation.attestation_id || ''))
    || Object.values(causalSeal).some((value) => !value)
    || attestation.attestation_id !== canonicalSha256(causalSeal).replace(/^sha256:/, '')
    || !['red-observed', 'green-observed', 'invalid', 'waived'].includes(attestation.state)
    || !Array.isArray(attestation.test_paths)
    || attestation.test_paths.some((testPath) => typeof testPath !== 'string' || !testPath.trim())) {
    fail('WENDKEEP_COMMIT_EVIDENCE_UNVERIFIED', `TDD attestation is invalid: ${path}`);
  }
}

function validateEnvelopeShape(payload, path) {
  const missing = ENVELOPE_REQUIRED.filter((field) => payload?.[field] === undefined);
  const unknown = Object.keys(payload || {}).filter((field) => !ENVELOPE_ALLOWED.has(field));
  const invalidText = [
    'project_id', 'repository_id', 'worktree_id', 'work_session_id', 'change_slug',
    'branch', 'wendkeep_version', 'platform',
  ].some((field) => typeof payload?.[field] !== 'string' || !payload[field]);
  const invalidGit = ['base_sha', 'head_sha', 'index_tree_sha']
    .some((field) => !GIT_OBJECT.test(String(payload?.[field] || '')));
  const invalidHash = ['worktree_digest', 'tasks_sha256', 'effective_spec_sha256', 'sensor_config_sha256', 'envelope_id']
    .some((field) => !SENSOR_HASH.test(String(payload?.[field] || '')));
  const invalidDates = ['started_at', 'finished_at']
    .some((field) => typeof payload?.[field] !== 'string' || Number.isNaN(Date.parse(payload[field])));
  if (missing.length || unknown.length || invalidText || invalidGit || invalidHash || invalidDates
    || typeof payload?.dirty !== 'boolean' || !Array.isArray(payload?.sensors)
    || (payload.tdd_attestations !== undefined && !Array.isArray(payload.tdd_attestations))) {
    fail('WENDKEEP_COMMIT_EVIDENCE_UNVERIFIED', `Evidence Envelope schema/binding is incomplete: ${path}`);
  }
}

function validateEnvelope(payload, entry, context) {
  if (payload?.schema_version !== 2) {
    fail('WENDKEEP_COMMIT_EVIDENCE_UNVERIFIED', `Evidence Envelope v2 is required: ${entry.path}`);
  }
  const sensors = evidenceSensors(payload);
  if (!sensors.length) fail('WENDKEEP_COMMIT_EVIDENCE_UNVERIFIED', `Evidence Envelope has no sensors: ${entry.path}`);
  validateEnvelopeShape(payload, entry.path);
  const missingExpected = EXPECTED_CONTEXT_FIELDS.filter((field) => (
    context[field] === undefined || context[field] === null || context[field] === ''
  ));
  if (missingExpected.length) {
    fail(
      'WENDKEEP_COMMIT_BINDING_INCOMPLETE',
      `canonical expected binding is incomplete (${missingExpected.join(', ')}): ${entry.path}`,
    );
  }
  const expected = {
    change_slug: context.changeSlug,
    identity: {
      project_id: context.projectId,
      repository_id: context.repositoryId,
      worktree_id: context.worktreeId,
      work_session_id: context.workSessionId,
    },
    snapshot: {
      branch: context.branch,
      base_sha: context.baseSha,
      head_sha: context.headSha,
      index_tree_sha: context.indexTreeSha,
      worktree_digest: context.worktreeDigest,
      dirty: context.dirty,
    },
    tasks_sha256: context.tasksSha256,
    effective_spec_sha256: context.effectiveSpecSha256,
    sensor_config_sha256: context.sensorConfigSha256,
  };
  const assessment = evaluateEvidenceBinding(payload, expected);
  if (assessment.state !== 'bound') {
    fail('WENDKEEP_COMMIT_EVIDENCE_STALE', `Evidence Envelope is not internally bound: ${entry.path}`);
  }
  for (const sensor of sensors) validateSensor(sensor, entry.path);
  const attestations = (payload.tdd_attestations || []).map((attestation) => {
    validateAttestation(attestation, entry.path);
    return evaluateTddAttestation(attestation, {
      branch: payload.branch,
      head_sha: payload.head_sha,
      index_tree_sha: payload.index_tree_sha,
      worktree_digest: payload.worktree_digest,
    }, { mutationSurvivors: sensors.flatMap((sensor) => sensor.survivors || []) });
  });
  if (attestations.some((attestation) => !['green-observed', 'waived'].includes(attestation.state))) {
    fail('WENDKEEP_COMMIT_EVIDENCE_UNVERIFIED', `TDD attestation is stale or invalid: ${entry.path}`);
  }
  return { payload, sensors, attestations };
}

function validateAuthority(entry, authority) {
  const normalized = entry.content.replace(/\r\n?/g, '\n');
  if (entry.kind === 'adr') {
    const id = authority?.adr || '';
    if (authority?.kind !== 'adr' || entry.path !== authority.ref
      || !basename(entry.path).toUpperCase().includes(id)
      || !new RegExp(`^(?:#{1,6}\\s+|id:\\s*["']?)${id}\\b`, 'mi').test(normalized)
      || (authority.issue && !new RegExp(`(^|\\s)${authority.issue.replace('#', '#\\s*')}\\b`, 'm').test(normalized))) {
      fail('WENDKEEP_COMMIT_AUTHORITY_MISMATCH', 'ADR artifact does not match its causal ID, path and issue');
    }
  }
  if (entry.kind === 'design') {
    const issue = authority?.issue || '';
    const issueNumber = issue.replace('#', '');
    if (authority?.kind !== 'native' || entry.path !== authority.design
      || !new RegExp(`^#{1,6}\\s+(?:.*\\s)?#${issueNumber}(?:\\s|\\b|—|-)`, 'mi').test(normalized)) {
      fail('WENDKEEP_COMMIT_AUTHORITY_MISMATCH', 'design artifact does not own the declared issue at the canonical path');
    }
  }
}

function requirePublicAuthority(entries, authority) {
  const kind = authority?.kind === 'adr' ? 'adr' : 'design';
  const matches = entries.filter((entry) => entry.kind === kind);
  if (matches.length !== 1) {
    fail('WENDKEEP_COMMIT_REMOTE_AUTHORITY_MISSING', `exactly one versioned ${kind} authority artifact is required`);
  }
}

function taskFacts(entries, context, envelope, collectedSensors = []) {
  const taskEntries = entries.filter((entry) => entry.kind === 'task');
  if (taskEntries.length !== 1) fail('WENDKEEP_COMMIT_EVIDENCE_INCOMPLETE', 'exactly one canonical task artifact is required');
  const source = taskEntries[0].content;
  const tasks = parseTasks(source);
  if (!tasks.length) fail('WENDKEEP_COMMIT_TASKS_INVALID', 'canonical task artifact has no typed checklist tasks');
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    fail('WENDKEEP_COMMIT_TASKS_INVALID', 'canonical task IDs must be unique');
  }
  const contracts = deriveTaskContracts({
    projectId: envelope?.payload.project_id || context.projectId || 'commit-project',
    changeSlug: envelope?.payload.change_slug || context.changeSlug || 'commit-authority',
    tasks,
    profile: context.profile || 'OFF',
    activeContextId: context.activeContextId || envelope?.payload.work_session_id || context.stagedHash,
    headSha: envelope?.payload.head_sha || context.headSha || context.stagedHash,
    tasksSha256: tasksHashOf(source),
    effectiveSpecSha256: envelope?.payload.effective_spec_sha256 || context.effectiveSpecSha256 || canonicalSha256([]),
    artifactManifestSha256: canonicalSha256([]),
    evidenceEnvelopeId: envelope?.payload.envelope_id || null,
    tddAttestations: envelope?.attestations || [],
  });
  const evaluations = evaluateTaskContracts({
    contracts,
    binding: contracts[0]?.binding || {},
    requirement_ids: [...new Set(tasks.flatMap((task) => task.reqs || []))],
    sensor_results: [...(envelope?.sensors || []), ...collectedSensors],
    artifact_results: [],
  });
  if (!evaluations.length || evaluations.some((result) => !result.can_complete)) {
    fail('WENDKEEP_COMMIT_TASKS_INCOMPLETE', 'canonical Task Contracts are not completed');
  }
  const renderedTasks = tasks.map((task) => `${task.id}: ${task.text}`);
  return { source, tasks, renderedTasks, tasksHash: tasksHashOf(source) };
}

function publicSpecFacts(entries, tasks) {
  const specs = entries.filter((entry) => entry.kind === 'spec');
  const requirements = [...new Set(tasks.flatMap((task) => task.reqs || []))];
  if (requirements.length && !specs.length) {
    fail('WENDKEEP_COMMIT_REMOTE_SPEC_MISSING', 'requirements require a versioned sanitized public spec');
  }
  for (const requirement of requirements) {
    const escaped = requirement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const heading = new RegExp(`^#{1,6}\\s+(?:Requisito|Requirement):\\s*${escaped}(?:\\s|—|-|$)`, 'mi');
    const jsonId = new RegExp(`"(?:id|requirement_id)"\\s*:\\s*"${escaped}"`);
    if (!specs.some((entry) => heading.test(entry.content) || jsonId.test(entry.content))) {
      fail('WENDKEEP_COMMIT_REMOTE_SPEC_INCOMPLETE', `public spec does not define requirement ${requirement}`);
    }
  }
  return specs;
}

function validateVerdict(payload, entry, task, envelope) {
  if (!envelope) fail('WENDKEEP_COMMIT_EVIDENCE_INCOMPLETE', 'verdict requires its Evidence Envelope v2');
  if (!payload?.author_session_id || !payload?.verifier_session_id
    || payload.author_session_id === payload.verifier_session_id) {
    fail('WENDKEEP_COMMIT_VERDICT_NOT_INDEPENDENT', `verdict lacks independent author/verifier identities: ${entry.path}`);
  }
  const reqIds = [...new Set(task.tasks.flatMap((item) => item.reqs || []))];
  const expectedBinding = Object.fromEntries(PROOF_BINDING_KEYS.map((key) => [key, envelope.payload[key]]));
  if (payload.tasksHash !== task.tasksHash
    || payload.effectiveSpecHash !== envelope.payload.effective_spec_sha256.replace(/^sha256:/, '')
    || payload.evidenceEnvelopeId !== envelope.payload.envelope_id
    || !payload.evidenceBinding
    || PROOF_BINDING_KEYS.some((key) => payload.evidenceBinding[key] !== expectedBinding[key])
    || !Array.isArray(payload.coverage)
    || payload.coverage.some((item) => !item || typeof item.req !== 'string'
      || item.covered !== true || typeof item.evidence !== 'string' || !item.evidence.trim())) {
    fail('WENDKEEP_COMMIT_EVIDENCE_UNVERIFIED', `verdict lacks complete canonical seals or coverage: ${entry.path}`);
  }
  const verdict = evaluateVerdict(payload, reqIds, {
    tasksHash: task.tasksHash,
    effectiveSpecHash: envelope.payload.effective_spec_sha256?.replace(/^sha256:/, ''),
    evidenceEnvelopeId: envelope.payload.envelope_id,
    evidenceBinding: expectedBinding,
  });
  if (!verdict.ok || verdict.stale || verdict.missing?.length) {
    fail('WENDKEEP_COMMIT_EVIDENCE_UNVERIFIED', `verdict is stale or has incomplete coverage: ${entry.path}`);
  }
}

function validateReceipt(payload, entry, stagedHash) {
  if (!Array.isArray(payload?.records) || !payload.records.length) {
    fail('WENDKEEP_COMMIT_RECEIPT_INVALID', `receipt bundle has no signed chain: ${entry.path}`);
  }
  verifyReceiptChain({ records: payload.records, checkpoint: payload.checkpoint ?? null });
  const receipt = payload.records.at(-1);
  const subject = payload.subject || receipt.subject || {};
  if (subject.staged_diff_sha256 !== stagedHash) {
    fail('WENDKEEP_COMMIT_EVIDENCE_STALE', `receipt is not bound to the staged diff: ${entry.path}`);
  }
  const result = classifyReceipt({ receipt: { ...receipt, ...receipt.subject }, observation: payload.observation, subject });
  if (result.state !== 'verified') {
    fail('WENDKEEP_COMMIT_RECEIPT_INVALID', `receipt schema, chain, observation or status is not verified: ${entry.path}`);
  }
}

export function validateCommitProofSet({ entries, authority, stagedHash, context = {} } = {}) {
  if (!SHA256.test(String(stagedHash || ''))) fail('WENDKEEP_COMMIT_STALE_INPUT', 'staged diff hash is invalid');
  requirePublicAuthority(entries || [], authority);
  for (const entry of entries || []) {
    if (contentSha256(entry.content) !== entry.sha256) {
      fail('WENDKEEP_COMMIT_EVIDENCE_STALE', `evidence digest mismatch: ${entry.path}`);
    }
    if (!entry.content.trim()) fail('WENDKEEP_COMMIT_EVIDENCE_EMPTY', `evidence is empty: ${entry.path}`);
    if (['adr', 'design'].includes(entry.kind)) validateAuthority(entry, authority);
  }
  const structured = (entries || []).map((entry) => (
    ['evidence', 'receipt', 'verdict'].includes(entry.kind) ? { entry, payload: json(entry.content, entry.path) } : null
  )).filter(Boolean);
  const taskEntry = (entries || []).find((entry) => entry.kind === 'task');
  const preliminaryTasks = taskEntry ? parseTasks(taskEntry.content) : [];
  const expectedContext = taskEntry
    ? { ...context, tasksSha256: tasksHashOf(taskEntry.content) }
    : context;
  const hasVerdict = structured.some(({ entry }) => entry.kind === 'verdict');
  const envelopes = structured.filter(({ entry }) => entry.kind === 'evidence')
    .map(({ entry, payload }) => validateEnvelope(payload, entry, expectedContext));
  if (envelopes.length > 1) fail('WENDKEEP_COMMIT_EVIDENCE_AMBIGUOUS', 'only one Evidence Envelope is allowed');
  const sensors = envelopes[0]?.sensors || [];
  const authenticatedAttestation = envelopes[0]?.attestations
    ?.some((attestation) => attestation.state === 'green-observed') || false;
  if (envelopes[0] && !hasVerdict && !authenticatedAttestation) {
    fail(
      'WENDKEEP_COMMIT_SENSOR_PROOF_UNAUTHENTICATED',
      'Evidence Envelope sensor record requires an independently bound verdict or attestation',
    );
  }
  const collectedSensors = executionSensors({ tasks: preliminaryTasks }, context.executionProof);
  assertEnvelopeSensorsMatchExecution(sensors, collectedSensors);
  const task = taskFacts(entries || [], { ...expectedContext, stagedHash }, envelopes[0], collectedSensors);
  publicSpecFacts(entries || [], task.tasks);
  if (envelopes[0] && envelopes[0].payload.tasks_sha256 !== task.tasksHash) {
    fail('WENDKEEP_COMMIT_EVIDENCE_STALE', 'Evidence Envelope tasks_sha256 does not match the canonical task artifact');
  }
  for (const { entry, payload } of structured) {
    if (entry.kind === 'verdict') validateVerdict(payload, entry, task, envelopes[0]);
    if (entry.kind === 'receipt') validateReceipt(payload, entry, stagedHash);
  }
  const tests = [
    ...collectedSensors.map((sensor) => `sensor:${sensor.id} (${sensor.command})`),
  ];
  if (!tests.length) {
    fail('WENDKEEP_COMMIT_TESTS_UNPROVEN', 'no authenticated execution proof supplies tests');
  }
  return {
    evidence: (entries || []).filter((entry) => REMOTE_EVIDENCE_KINDS.has(entry.kind)).map((entry) => ({
      kind: entry.kind,
      ref: signedEvidenceRef(entry.path, entry.content),
      status: 'verified',
    })),
    tasks: task.renderedTasks,
    tests: [...new Set(tests)].sort((left, right) => left.localeCompare(right, 'en')),
  };
}
