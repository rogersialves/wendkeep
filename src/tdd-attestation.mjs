import { createHash } from 'node:crypto';

import { sanitizeMemoryText } from '../packages/vault/src/memory-schema.mjs';

const OUTPUT_TAIL_LIMIT = 2_000;
const COMMAND_LIMIT = 1_000;
const IDENTITY_FIELDS = [
  'project_id', 'repository_id', 'worktree_id', 'work_session_id', 'change_slug',
];
const INFRASTRUCTURE_FAILURES = [
  /cannot find module/i,
  /module not found/i,
  /cannot find package/i,
  /syntaxerror/i,
  /enoent/i,
  /command not found/i,
  /is not recognized as an internal or external command/i,
  /failed to load (?:config|configuration)/i,
  /configuration (?:error|invalid|missing)/i,
  /unknown (?:option|argument)/i,
];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

function canonicalId(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value)), 'utf8').digest('hex');
}

function uniqueStrings(values) {
  const input = Array.isArray(values) ? values : [values];
  return [...new Set(input.map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizedPath(value) {
  const path = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').trim();
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.split('/').includes('..')) {
    throw Object.assign(new Error(`invalid test path: ${value}`), { code: 'TDD_TEST_PATH_INVALID' });
  }
  return path;
}

function testPathsOf(values) {
  return uniqueStrings(values).map(normalizedPath).sort();
}

function sanitizeDiagnostic(value) {
  return sanitizeMemoryText(String(value || ''))
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/file:\/\/\/[A-Za-z]:\/[^\s)]+/gi, '[LOCAL_FILE]')
    .replace(/"[A-Za-z]:\\[^"\r\n]+"/g, '"[LOCAL_EXECUTABLE]"')
    .replace(/'[A-Za-z]:\\+[^'\r\n]+'/g, "'[LOCAL_FILE]'")
    .replace(/\b[A-Za-z]:\\+[^\s)"'\r\n]+/g, '[LOCAL_FILE]')
    .replace(/\/[Uu]sers\/[^/\s]+\/[^\s)]+/g, '[LOCAL_FILE]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, '[REDACTED_SECRET]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, '[REDACTED_SECRET]')
    .replace(/:\/\/([^:\s/@]+):([^@\s/]+)@/g, '://[REDACTED_SECRET]@')
    .replace(/\r/g, '')
    .trim();
}

function boundedTail(value) {
  const sanitized = sanitizeDiagnostic(value);
  return sanitized.length <= OUTPUT_TAIL_LIMIT
    ? sanitized
    : `…${sanitized.slice(-(OUTPUT_TAIL_LIMIT - 1))}`;
}

function commandObservation(command, result, observedAt) {
  const rawOutput = [result?.stdout, result?.stderr, result?.error?.message].filter(Boolean).join('\n');
  return {
    command: sanitizeDiagnostic(command).slice(0, COMMAND_LIMIT),
    command_digest: sha256(command),
    exit_code: Number.isInteger(result?.status) ? result.status : null,
    output_digest: sha256(rawOutput),
    output_tail: boundedTail(rawOutput),
    observed_at: String(observedAt || new Date().toISOString()),
  };
}

function snapshotObservation(snapshot = {}) {
  return {
    branch: String(snapshot.branch || ''),
    head_sha: String(snapshot.head_sha || ''),
    index_tree_sha: String(snapshot.index_tree_sha || ''),
    worktree_digest: String(snapshot.worktree_digest || ''),
    change_manifest: stableValue(snapshot.change_manifest || {}),
  };
}

function attestationIdentity({ identity = {}, taskId, requirementId }) {
  const normalizedIdentity = Object.fromEntries(
    IDENTITY_FIELDS.map((field) => [field, String(identity[field] || '').trim()]),
  );
  if (Object.values(normalizedIdentity).some((value) => !value)
    || !String(taskId || '').trim() || !String(requirementId || '').trim()) {
    throw Object.assign(new Error('causal identity, task and requirement are required'), {
      code: 'TDD_IDENTITY_REQUIRED',
    });
  }
  return {
    ...normalizedIdentity,
    task_id: String(taskId).trim(),
    requirement_id: String(requirementId).trim(),
  };
}

function baseAttestation(input) {
  const causal = attestationIdentity(input);
  return {
    schema_version: 1,
    attestation_id: canonicalId(causal),
    ...causal,
    profile: String(input.profile || 'OFF').toUpperCase(),
    state: 'invalid',
    test_paths: testPathsOf(input.testPaths),
    red: null,
    green: null,
    green_history: [],
    waiver: null,
    review_flags: [],
    invalid_reason: null,
  };
}

function invalid(attestation, reason) {
  return { ...attestation, state: 'invalid', invalid_reason: reason };
}

export function classifyTddRedResult(result = {}) {
  if ((result.status ?? 1) === 0) return { valid: false, reason: 'TDD_RED_ALREADY_GREEN' };
  const diagnostic = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n');
  if (INFRASTRUCTURE_FAILURES.some((pattern) => pattern.test(diagnostic))) {
    return { valid: false, reason: 'TDD_RED_INFRASTRUCTURE_FAILURE' };
  }
  return { valid: true, reason: null };
}

export function createRedAttestation(input = {}) {
  const base = baseAttestation(input);
  const execution = commandObservation(input.command, input.result, input.observedAt);
  const red = {
    ...snapshotObservation(input.snapshot),
    ...execution,
    failure_digest: execution.output_digest,
  };
  delete red.output_digest;
  const observed = { ...base, red };
  const classification = classifyTddRedResult(input.result);
  return classification.valid
    ? { ...observed, state: 'red-observed', invalid_reason: null }
    : invalid(observed, classification.reason);
}

function sameIdentity(attestation, input) {
  return IDENTITY_FIELDS.every((field) => (
    String(attestation?.[field] || '') === String(input.identity?.[field] || '')
  ))
    && String(attestation?.task_id || '') === String(input.taskId || '')
    && String(attestation?.requirement_id || '') === String(input.requirementId || '');
}

function changedManifestPaths(left = {}, right = {}) {
  const paths = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  return [...paths].filter((path) => String(left?.[path] || '') !== String(right?.[path] || '')).sort();
}

function isDeclaredTestPath(path, declared) {
  const normalized = normalizedPath(path);
  return declared.some((testPath) => normalized === testPath || normalized.startsWith(`${testPath}/`));
}

export function completeGreenAttestation(attestation, input = {}) {
  const current = { ...attestation, green_history: [...(attestation?.green_history || [])] };
  if (!sameIdentity(current, input)
    || String(current.red?.branch || '') !== String(input.snapshot?.branch || '')) {
    return invalid(current, 'TDD_CAUSAL_IDENTITY_MISMATCH');
  }
  if (!current.red || !['red-observed', 'green-observed'].includes(String(current.state || ''))) {
    return invalid(current, 'TDD_RED_REQUIRED');
  }
  if ((input.result?.status ?? 1) !== 0) return invalid(current, 'TDD_GREEN_FAILED');
  if (input.isAncestor !== true) return invalid(current, 'TDD_GREEN_NOT_CAUSAL_SUCCESSOR');

  const nextTestPaths = testPathsOf(input.testPaths?.length ? input.testPaths : current.test_paths);
  const allTestPaths = uniqueStrings([...current.test_paths, ...nextTestPaths]).map(normalizedPath);
  const changedPaths = uniqueStrings([
    ...changedManifestPaths(current.red.change_manifest, input.snapshot?.change_manifest),
    ...(input.committedPaths || []),
  ]).map(normalizedPath).sort();
  const productionPaths = changedPaths.filter((path) => !isDeclaredTestPath(path, allTestPaths));
  if (!productionPaths.length) return invalid(current, 'TDD_IMPLEMENTATION_NOT_AFTER_RED');

  const execution = commandObservation(input.command, input.result, input.observedAt);
  const green = {
    ...snapshotObservation(input.snapshot),
    ...execution,
    result_digest: execution.output_digest,
    production_paths: productionPaths,
  };
  delete green.output_digest;
  if (current.green) current.green_history.push(current.green);
  const testPathsChanged = JSON.stringify(current.test_paths) !== JSON.stringify(nextTestPaths);
  return {
    ...current,
    state: 'green-observed',
    invalid_reason: null,
    test_paths: nextTestPaths,
    green,
    green_history: current.green_history,
    review_flags: testPathsChanged ? ['TDD_TEST_PATHS_CHANGED'] : [],
  };
}

export function evaluateTddAttestation(attestation, snapshot = {}, options = {}) {
  if (!attestation || !['green-observed', 'waived'].includes(attestation.state)) {
    return attestation || { state: 'invalid', invalid_reason: 'TDD_ATTESTATION_MISSING' };
  }
  if (attestation.state === 'waived') return attestation;
  if (Array.isArray(options.mutationSurvivors) && options.mutationSurvivors.length) {
    return invalid(attestation, 'TDD_MUTATION_SURVIVOR');
  }
  const green = attestation.green || {};
  const stale = ['head_sha', 'index_tree_sha', 'worktree_digest']
    .some((field) => String(green[field] || '') !== String(snapshot[field] || ''));
  return stale ? invalid(attestation, 'TDD_GREEN_STALE_AFTER_REFACTOR') : attestation;
}

export function waiveTddAttestation(input = {}) {
  const authority = sanitizeDiagnostic(input.authority);
  const reason = sanitizeDiagnostic(input.reason);
  if (!authority || !reason) {
    throw Object.assign(new Error('waiver requires explicit human authority and reason'), {
      code: 'TDD_WAIVER_AUTHORITY_REQUIRED',
    });
  }
  return {
    ...baseAttestation(input),
    state: 'waived',
    invalid_reason: null,
    waiver: {
      authority: authority.slice(0, 200),
      reason: reason.slice(0, 1_000),
      observed_at: String(input.observedAt || new Date().toISOString()),
    },
  };
}
