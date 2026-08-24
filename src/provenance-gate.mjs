import { evaluateEvidenceBinding } from '../packages/vault/src/evidence-envelope.mjs';

export const PROVENANCE_STATES = Object.freeze([
  'verified',
  'reported',
  'legacy-unbound',
  'stale',
  'conflict',
  'unproven',
]);

const STATE_PRECEDENCE = Object.freeze({
  verified: 0,
  reported: 1,
  'unproven': 2,
  'legacy-unbound': 3,
  stale: 4,
  conflict: 5,
});

const BINDING_KEYS = [
  'project_id', 'repository_id', 'worktree_id', 'work_session_id', 'change_slug',
  'branch', 'head_sha', 'base_sha', 'index_tree_sha', 'worktree_digest',
  'dirty', 'tasks_sha256', 'effective_spec_sha256', 'sensor_config_sha256',
  'package_name', 'package_version', 'target_commit', 'target_ref', 'tag',
];

const REASON_CODES = Object.freeze({
  missingEvidence: 'PROV_EVIDENCE_MISSING',
  legacyEvidence: 'PROV_EVIDENCE_LEGACY',
  invalidEvidence: 'PROV_EVIDENCE_INVALID',
  stale: 'WENDKEEP_PROVENANCE_STALE',
  context: 'WENDKEEP_PROVENANCE_CONTEXT_MISMATCH',
  binding: 'WENDKEEP_PROVENANCE_BINDING_CONFLICT',
  missingObservation: 'PROV_RECEIPT_OBSERVATION_MISSING',
  invalidReceipt: 'PROV_RECEIPT_INVALID',
  legacyReceipt: 'PROV_RECEIPT_LEGACY',
  receiptConflict: 'PROV_RECEIPT_CONFLICT',
  receiptUnbound: 'PROV_RECEIPT_UNBOUND',
  releaseConflict: 'PROV_RELEASE_CHAIN_CONFLICT',
  releaseMissing: 'PROV_RELEASE_CHAIN_UNPROVEN',
  releaseReported: 'PROV_RELEASE_SOURCE_REPORTED',
  requiredMissing: 'PROV_REQUIRED_ASSESSMENT_MISSING',
  invalidAssessmentState: 'PROV_ASSESSMENT_STATE_INVALID',
});

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function unique(values) {
  return [...new Set(asArray(values).filter((value) => value != null && String(value) !== ''))];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function plain(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(plain);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
}

function normalizeContext(value = {}) {
  const context = value && typeof value === 'object' ? value : {};
  return {
    ...(context.context && typeof context.context === 'object' ? context.context : {}),
    ...context,
    ...(context.identity && typeof context.identity === 'object' ? context.identity : {}),
    ...(context.snapshot && typeof context.snapshot === 'object' ? context.snapshot : {}),
    ...(context.subject && typeof context.subject === 'object' ? context.subject : {}),
  };
}

function extractBinding(value = {}) {
  const source = normalizeContext(value);
  const nested = normalizeContext(source.context);
  const result = {};
  for (const key of BINDING_KEYS) {
    const candidate = firstDefined(source[key], nested[key]);
    if (candidate !== undefined && candidate !== null) result[key] = candidate;
  }
  return result;
}

function bindingMismatches(actual, expected) {
  const left = extractBinding(actual);
  const right = extractBinding(expected);
  const mismatches = [];
  for (const key of BINDING_KEYS) {
    if (right[key] !== undefined && left[key] !== undefined && left[key] !== right[key]) {
      mismatches.push(`${key} mismatch`);
    }
  }
  return mismatches;
}

function assessment({
  kind,
  state,
  reasonCodes = [],
  diagnostics = [],
  repair,
  receipts = [],
  ...extra
} = {}) {
  const result = {
    ...plain(extra),
    ...(kind ? { kind } : {}),
    ok: state === 'verified',
    state: PROVENANCE_STATES.includes(state) ? state : 'unproven',
    reasonCodes: unique(reasonCodes),
    diagnostics: plain(diagnostics),
    repair: repair || null,
    receipts: plain(receipts),
  };
  return result;
}

function diagnosticsFor(kind, state, expected, observed, reasons) {
  return [{
    kind,
    state,
    blocker: reasons[0] || null,
    expected: sanitize(expected),
    observed: sanitize(observed),
  }];
}

function sanitize(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    const redacted = value
      .replace(/\b(authorization\s*:\s*bearer)\s+[^\s,;]+/gi, '$1 [redacted]')
      .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
      .replace(/[A-Za-z]:[\\/][^\s"'`,;)}\]]+/g, '[redacted-path]')
      .replace(/(^|[\s("'=])\/(?:[^/\s]+\/)+[^\s"'`,;)}\]]*/g, '$1[redacted-path]');
    return redacted.length > 200 ? `${redacted.slice(0, 197)}...` : redacted;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitize);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|authorization|private|content|output|path/i.test(key)) continue;
    output[key] = sanitize(item);
  }
  return output;
}

function fromBindingResult(kind, binding, expected, evidence) {
  const reasons = binding?.reasons || [];
  if (binding?.state === 'bound') {
    return assessment({ kind, state: 'verified', diagnostics: diagnosticsFor(kind, 'verified', expected, evidence, []) });
  }
  if (binding?.state === 'context-mismatch') {
    return assessment({
      kind, state: 'conflict', reasonCodes: [REASON_CODES.context],
      diagnostics: diagnosticsFor(kind, 'conflict', expected, evidence, reasons),
    });
  }
  if (binding?.state === 'stale') {
    return assessment({
      kind, state: 'stale', reasonCodes: [REASON_CODES.stale],
      diagnostics: diagnosticsFor(kind, 'stale', expected, evidence, reasons),
    });
  }
  if (binding?.state === 'legacy-unbound') {
    return assessment({
      kind, state: 'legacy-unbound', reasonCodes: [REASON_CODES.legacyEvidence],
      diagnostics: diagnosticsFor(kind, 'legacy-unbound', expected, evidence, reasons),
    });
  }
  return assessment({
    kind, state: 'unproven', reasonCodes: [REASON_CODES.missingEvidence],
    diagnostics: diagnosticsFor(kind, 'unproven', expected, evidence, reasons),
  });
}

function compareProof(kind, proof, expected, code = REASON_CODES.binding) {
  if (!proof) return [];
  const mismatches = bindingMismatches(proof, expected);
  return mismatches.length ? [code, ...mismatches] : [];
}

/**
 * Classify a v2 evidence envelope against the subject resolved for this operation.
 * This function is deliberately pure: `verification` and `verdict` are already captured
 * observations, never callbacks or paths to read.
 */
export function classifyEvidenceEnvelope({ evidence, expected = {}, verification, verdict } = {}) {
  const kind = 'envelope';
  if (!evidence) {
    return assessment({
      kind, state: 'unproven', reasonCodes: [REASON_CODES.missingEvidence],
      diagnostics: diagnosticsFor(kind, 'unproven', expected, null, ['evidence missing']),
    });
  }
  const normalizedExpected = normalizeContext(expected);
  const binding = evaluateEvidenceBinding(evidence, {
    ...normalizedExpected,
    identity: expected.identity || normalizedExpected,
    snapshot: expected.snapshot || normalizedExpected,
  });
  const result = fromBindingResult(kind, binding, expected, evidence);
  const proofMismatches = [
    ...compareProof(kind, verification, { ...normalizedExpected, ...extractBinding(evidence) }),
    ...compareProof(kind, verdict, { ...normalizedExpected, ...extractBinding(evidence) }),
  ];
  if (proofMismatches.length) {
    return assessment({
      ...result,
      state: 'conflict',
      reasonCodes: unique([...result.reasonCodes, REASON_CODES.binding]),
      diagnostics: [
        ...(result.diagnostics || []),
        ...diagnosticsFor(kind, 'conflict', expected, { verification, verdict }, proofMismatches),
      ],
    });
  }
  return result;
}

function observationStatus(observation) {
  if (!observation) return 'missing';
  if (observation.status === 'offline' || observation.state === 'offline' || observation.available === false) return 'reported';
  if (observation.status === 'conflict' || observation.state === 'conflict') return 'conflict';
  if (observation.status === 'stale' || observation.state === 'stale') return 'stale';
  if (observation.status === 'verified' || observation.state === 'verified') return 'verified';
  return 'reported';
}

/** Classify an operational receipt against an observed subject. */
export function classifyReceipt({ receipt, observation, subject = {} } = {}) {
  const kind = receipt?.kind || receipt?.operation || 'receipt';
  if (!receipt) {
    return assessment({
      kind, state: 'unproven', reasonCodes: [REASON_CODES.invalidReceipt],
      diagnostics: diagnosticsFor(kind, 'unproven', subject, null, ['receipt missing']),
    });
  }
  if (receipt.schema_version !== 2) {
    return assessment({
      kind, state: 'legacy-unbound', reasonCodes: [REASON_CODES.legacyReceipt],
      diagnostics: diagnosticsFor(kind, 'legacy-unbound', subject, receipt, ['receipt schema is not v2']),
      receipts: [receipt],
    });
  }
  if (!receipt.receipt_id || !receipt.kind) {
    return assessment({
      kind, state: 'unproven', reasonCodes: [REASON_CODES.invalidReceipt],
      diagnostics: diagnosticsFor(kind, 'unproven', subject, receipt, ['receipt_id or kind missing']),
      receipts: [receipt],
    });
  }
  const receiptMismatches = bindingMismatches(receipt, subject);
  if (receiptMismatches.length) {
    return assessment({
      kind, state: 'conflict', reasonCodes: [REASON_CODES.receiptConflict],
      diagnostics: diagnosticsFor(kind, 'conflict', subject, receipt, receiptMismatches),
      receipts: [receipt],
    });
  }
  const subjectBinding = extractBinding(subject);
  const receiptBinding = extractBinding(receipt);
  const unbound = Object.keys(subjectBinding).filter((key) => receiptBinding[key] === undefined);
  if (unbound.length) {
    return assessment({
      kind, state: 'reported', reasonCodes: [REASON_CODES.receiptUnbound],
      diagnostics: diagnosticsFor(kind, 'reported', subject, receipt, [`receipt binding missing: ${unbound.join(', ')}`]),
      receipts: [receipt],
    });
  }
  const status = observationStatus(observation);
  if (status === 'conflict') {
    return assessment({
      kind, state: 'conflict', reasonCodes: [REASON_CODES.receiptConflict],
      diagnostics: diagnosticsFor(kind, 'conflict', subject, observation, ['receipt observation conflicts']),
      receipts: [receipt],
    });
  }
  if (status === 'stale') {
    return assessment({
      kind, state: 'stale', reasonCodes: [REASON_CODES.stale],
      diagnostics: diagnosticsFor(kind, 'stale', subject, observation, ['receipt observation is stale']),
      receipts: [receipt],
    });
  }
  if (status === 'missing') {
    return assessment({
      kind, state: 'reported', reasonCodes: [REASON_CODES.missingObservation],
      diagnostics: diagnosticsFor(kind, 'reported', subject, receipt, ['receipt claim has no observation']),
      receipts: [receipt],
    });
  }
  if (status === 'reported') {
    return assessment({
      kind, state: 'reported', reasonCodes: ['PROV_RECEIPT_REPORTED'],
      diagnostics: diagnosticsFor(kind, 'reported', subject, observation, ['observation did not verify binding']),
      receipts: [receipt],
    });
  }
  const observationBinding = extractBinding(observation);
  const observationMismatches = bindingMismatches(observation, subject);
  if (observation.receipt_id && observation.receipt_id !== receipt.receipt_id) observationMismatches.push('receipt_id mismatch');
  if (observationMismatches.length) {
    return assessment({
      kind, state: 'conflict', reasonCodes: [REASON_CODES.receiptConflict],
      diagnostics: diagnosticsFor(kind, 'conflict', subject, observation, observationMismatches),
      receipts: [receipt],
    });
  }
  const missingObservationBinding = Object.keys(subjectBinding)
    .filter((key) => observationBinding[key] === undefined);
  if (!observation.receipt_id || missingObservationBinding.length) {
    return assessment({
      kind, state: 'reported', reasonCodes: [REASON_CODES.missingObservation],
      diagnostics: diagnosticsFor(kind, 'reported', subject, observation, [
        !observation.receipt_id
          ? 'receipt observation missing receipt_id'
          : `receipt observation binding missing: ${missingObservationBinding.join(', ')}`,
      ]),
      receipts: [receipt],
    });
  }
  return assessment({
    kind, state: 'verified', diagnostics: diagnosticsFor(kind, 'verified', subject, observation, []),
    receipts: [receipt],
  });
}

function chainPart(chain, ...keys) {
  for (const key of keys) {
    if (chain?.[key] !== undefined && chain?.[key] !== null) return chain[key];
  }
  return undefined;
}

function chainValue(part, ...keys) {
  if (part == null) return undefined;
  if (typeof part !== 'object') return part;
  return firstDefined(...keys.map((key) => part[key]));
}

/** Evaluate the complete commit/tag/package/artifact/CI/NPM/Release chain. */
export function evaluateReleaseChain(input = {}) {
  const chain = input.chain || input;
  const expected = normalizeContext(input.context || input.expected || {});
  const commit = chainPart(chain, 'commit', 'target', 'target_commit', 'commit_sha', 'head_sha');
  const tag = chainPart(chain, 'tag') || (chain.tag_name ? {
    name: chain.tag_name,
    commit: firstDefined(chain.tag_commit, chain.commit_sha, chain.head_sha),
  } : undefined);
  const pkg = chainPart(chain, 'package', 'pkg') || (chain.package_name || chain.package_version || chain.version ? {
    name: chain.package_name,
    version: firstDefined(chain.package_version, chain.version),
    commit: firstDefined(chain.package_commit, chain.commit_sha, chain.head_sha),
  } : undefined);
  const artifact = chainPart(chain, 'artifact', 'tarball') || (chain.artifact_integrity ? {
    integrity: chain.artifact_integrity,
    commit: firstDefined(chain.artifact_commit, chain.commit_sha, chain.head_sha),
  } : undefined);
  const npm = chainPart(chain, 'npm', 'registry') || (chain.npm_integrity ? {
    name: chain.npm_name || chain.package_name,
    version: chain.npm_version || firstDefined(chain.package_version, chain.version),
    integrity: chain.npm_integrity,
    repository: chain.npm_repository,
  } : undefined);
  const ci = chainPart(chain, 'ci', 'workflow') || (chain.ci_commit || chain.ci_status ? {
    commit: firstDefined(chain.ci_commit, chain.commit_sha, chain.head_sha),
    status: chain.ci_status,
    repository: chain.ci_repository,
  } : undefined);
  const release = chainPart(chain, 'release', 'github_release') || (chain.release_tag || chain.release_version ? {
    tag: chain.release_tag || chain.tag_name,
    version: chain.release_version || firstDefined(chain.package_version, chain.version),
    repository: chain.release_repository,
  } : undefined);
  const targetCommit = firstDefined(expected.target_commit, expected.head_sha);
  const packageName = expected.package_name;
  const packageVersion = firstDefined(expected.package_version, expected.version);
  const tagName = expected.tag;
  const expectedRepository = firstDefined(expected.repository, expected.repository_full_name);
  const expectedMissing = [
    ['expected target commit', targetCommit],
    ['expected package name', packageName],
    ['expected package version', packageVersion],
    ['expected tag', tagName],
    ['expected repository', expectedRepository],
  ].filter(([, value]) => value == null || value === '').map(([label]) => label);
  if (expectedMissing.length) {
    return assessment({
      kind: 'release-chain', state: 'unproven', reasonCodes: [REASON_CODES.releaseMissing],
      diagnostics: diagnosticsFor('release-chain', 'unproven', expected, chain, [`missing ${expectedMissing.join(', ')}`]),
    });
  }
  const sourceReported = [npm, ci, release, artifact].some((part) => {
    const status = String(chainValue(part, 'status', 'state', 'availability') || '').toLowerCase();
    return chainValue(part, 'available') === false
      || ['offline', 'unavailable', 'timeout', 'unknown'].includes(status);
  });
  if (sourceReported) {
    return assessment({
      kind: 'release-chain', state: 'reported', reasonCodes: [REASON_CODES.releaseReported],
      diagnostics: diagnosticsFor('release-chain', 'reported', expected, chain, ['external source unavailable']),
    });
  }
  const missing = [];
  for (const [label, value] of [
    ['commit', commit], ['tag', tag], ['package', pkg], ['artifact', artifact], ['npm', npm], ['ci', ci], ['release', release],
  ]) if (value == null) missing.push(label);
  for (const [label, value] of [
    ['commit sha', chainValue(commit, 'sha', 'commit', 'target_commit', 'head_sha')],
    ['tag name', chainValue(tag, 'name', 'tag')],
    ['tag commit', chainValue(tag, 'commit', 'target_commit', 'sha')],
    ['package name', chainValue(pkg, 'name')],
    ['package version', chainValue(pkg, 'version')],
    ['package commit', chainValue(pkg, 'commit', 'target_commit', 'head_sha')],
    ['artifact integrity', chainValue(artifact, 'integrity', 'sha512', 'hash')],
    ['artifact commit', chainValue(artifact, 'commit', 'target_commit', 'head_sha')],
    ['NPM integrity', chainValue(npm, 'integrity', 'dist_integrity')],
    ['NPM package name', chainValue(npm, 'name')],
    ['NPM package version', chainValue(npm, 'version')],
    ['NPM commit', chainValue(npm, 'commit', 'target_commit', 'head_sha')],
    ['NPM repository', chainValue(npm, 'repository', 'repo', 'full_name')],
    ['CI status', chainValue(ci, 'status', 'conclusion')],
    ['CI commit', chainValue(ci, 'commit', 'target_commit', 'head_sha', 'sha')],
    ['CI repository', chainValue(ci, 'repository', 'repo', 'full_name')],
    ['Release tag', chainValue(release, 'tag', 'tag_name')],
    ['Release version', chainValue(release, 'version')],
    ['Release commit', chainValue(release, 'commit', 'target_commit', 'head_sha', 'sha')],
    ['Release repository', chainValue(release, 'repository', 'repo', 'full_name')],
    ['Release status', chainValue(release, 'status', 'state')],
  ]) if (value == null || value === '') missing.push(label);
  if (missing.length) {
    return assessment({
      kind: 'release-chain', state: 'unproven', reasonCodes: [REASON_CODES.releaseMissing],
      diagnostics: diagnosticsFor('release-chain', 'unproven', expected, chain, [`missing ${missing.join(', ')}`]),
    });
  }
  const mismatches = [];
  const commitSha = chainValue(commit, 'sha', 'commit', 'target_commit', 'head_sha') || commit;
  if (targetCommit && commitSha !== targetCommit) mismatches.push('target commit mismatch');
  for (const [label, part, keys] of [
    ['tag', tag, ['commit', 'target_commit', 'sha']],
    ['package', pkg, ['commit', 'target_commit', 'head_sha']],
    ['artifact', artifact, ['commit', 'target_commit', 'head_sha']],
    ['npm', npm, ['commit', 'target_commit', 'head_sha']],
    ['ci', ci, ['commit', 'target_commit', 'head_sha', 'sha']],
    ['release', release, ['commit', 'target_commit', 'head_sha', 'sha']],
  ]) {
    const observedCommit = chainValue(part, ...keys);
    if (observedCommit && targetCommit && observedCommit !== targetCommit) mismatches.push(`${label} commit mismatch`);
  }
  const observedTag = chainValue(tag, 'name', 'tag');
  if (observedTag && tagName && observedTag !== tagName) mismatches.push('tag mismatch');
  const observedVersion = chainValue(pkg, 'version');
  if (packageVersion && observedVersion && observedVersion !== packageVersion) mismatches.push('package version mismatch');
  if (packageName && chainValue(pkg, 'name') && chainValue(pkg, 'name') !== packageName) mismatches.push('package name mismatch');
  const integrity = firstDefined(chainValue(artifact, 'integrity'), chainValue(artifact, 'sha512'), chainValue(artifact, 'hash'));
  const npmIntegrity = chainValue(npm, 'integrity', 'dist_integrity');
  if (!integrity || !npmIntegrity) mismatches.push('artifact integrity missing');
  else if (integrity !== npmIntegrity) mismatches.push('artifact integrity mismatch');
  if (chainValue(npm, 'name') && packageName && chainValue(npm, 'name') !== packageName) mismatches.push('NPM package mismatch');
  if (chainValue(npm, 'version') && packageVersion && chainValue(npm, 'version') !== packageVersion) mismatches.push('NPM version mismatch');
  if (expectedRepository) {
    for (const [label, part] of [['NPM', npm], ['CI', ci], ['Release', release]]) {
      const repository = chainValue(part, 'repository', 'repo', 'full_name');
      if (repository && repository !== expectedRepository) mismatches.push(`${label} repository mismatch`);
    }
  }
  const ciStatus = chainValue(ci, 'status', 'conclusion');
  if (ciStatus && String(ciStatus).toLowerCase() !== 'success') mismatches.push('CI not successful');
  const releaseStatus = chainValue(release, 'status', 'state');
  if (releaseStatus && !['published', 'verified'].includes(String(releaseStatus).toLowerCase())) mismatches.push('Release not published');
  if (chainValue(release, 'tag', 'tag_name') && tagName && chainValue(release, 'tag', 'tag_name') !== tagName) mismatches.push('Release tag mismatch');
  if (chainValue(release, 'version') && packageVersion && chainValue(release, 'version') !== packageVersion) mismatches.push('Release version mismatch');
  if (mismatches.length) {
    return assessment({
      kind: 'release-chain', state: 'conflict', reasonCodes: [REASON_CODES.releaseConflict],
      diagnostics: diagnosticsFor('release-chain', 'conflict', expected, chain, mismatches),
    });
  }
  return assessment({
    kind: 'release-chain', state: 'verified',
    diagnostics: diagnosticsFor('release-chain', 'verified', expected, chain, []),
  });
}

function normalizeAssessments(assessments) {
  const entries = Array.isArray(assessments)
    ? assessments.map((item, index) => [String(index), item])
    : Object.entries(assessments || {});
  return entries.map(([fallbackKind, value]) => {
    const item = value && typeof value === 'object' ? value : {};
    if (PROVENANCE_STATES.includes(item.state)) return { ...item, kind: item.kind || fallbackKind };
    return {
      ...item,
      kind: item.kind || fallbackKind,
      state: 'unproven',
      reasonCodes: unique([...asArray(item.reasonCodes), REASON_CODES.invalidAssessmentState]),
      diagnostics: [
        ...asArray(item.diagnostics),
        { kind: item.kind || fallbackKind, state: 'unproven', blocker: REASON_CODES.invalidAssessmentState },
      ],
    };
  });
}

function aggregateState(items) {
  if (!items.length) return 'unproven';
  return items.reduce((selected, item) => (
    (STATE_PRECEDENCE[item.state] ?? STATE_PRECEDENCE.unproven) > (STATE_PRECEDENCE[selected] ?? STATE_PRECEDENCE.unproven)
      ? item.state : selected
  ), 'verified');
}

/** Compose assessments into a fail-closed operation gate. */
export function evaluateProvenanceGate({ purpose = 'operation', assessments = [], requiredKinds = [] } = {}) {
  const items = normalizeAssessments(assessments);
  const byKind = new Map(items.map((item) => [item.kind, item]));
  const required = unique(requiredKinds);
  const missing = required
    .filter((kind) => !byKind.has(kind))
    .map((kind) => assessment({
      kind, state: 'unproven', reasonCodes: [REASON_CODES.requiredMissing],
      diagnostics: diagnosticsFor(kind, 'unproven', { purpose, kind }, null, ['required assessment missing']),
    }));
  const considered = required.length
    ? [...required.map((kind) => byKind.get(kind)).filter(Boolean), ...missing]
    : [...items];
  const state = aggregateState(considered);
  const blockers = considered
    .filter((item) => item.state !== 'verified')
    .sort((left, right) => (STATE_PRECEDENCE[right.state] ?? 2) - (STATE_PRECEDENCE[left.state] ?? 2));
  const reasonCodes = unique(blockers.flatMap((item) => item.reasonCodes || []));
  const diagnostics = blockers.flatMap((item) => {
    const current = asArray(item.diagnostics);
    return current.length ? current : [{
      kind: item.kind,
      state: item.state,
      blocker: item.reasonCodes?.[0] || null,
    }];
  });
  const receipts = considered.flatMap((item) => asArray(item.receipts));
  const first = blockers[0];
  return {
    ok: considered.length > 0 && considered.every((item) => item.state === 'verified'),
    state,
    reasonCodes,
    diagnostics: sanitize(diagnostics),
    repair: first ? repairForAssessment({ assessment: first, context: { purpose } }) : null,
    receipts: sanitize(receipts),
  };
}

/** Return stable operator-facing recovery guidance for an assessment. */
export function repairForAssessment({ assessment: current = {}, context = {} } = {}) {
  const state = current.state || 'unproven';
  const purpose = String(context.purpose || context.operation || 'operação')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .replace(/(?:token|secret|password|authorization|private)/gi, '[redacted]')
    .slice(0, 80) || 'operação';
  if (state === 'verified') return { command: null, explanation: 'Prova fresca já verificada; nenhuma recuperação necessária.' };
  if (state === 'conflict') {
    return {
      command: 'wendkeep context status && wendkeep verify --deep',
      explanation: `Resolva o contexto conflitante de ${purpose}, recapture a prova no checkout atual e execute verify --deep.`,
    };
  }
  return {
    command: 'wendkeep verify --deep',
    explanation: `Produza uma prova fresca e vinculada para ${purpose}; a recuperação não promove o artefato atual automaticamente.`,
  };
}
