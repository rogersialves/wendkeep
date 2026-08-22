import { createHash } from 'node:crypto';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function canonicalSha256(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : JSON.stringify(stableValue(value));
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function evidenceSensors(evidence) {
  if (Array.isArray(evidence)) return evidence;
  return Array.isArray(evidence?.sensors) ? evidence.sensors : [];
}

const CHECKOUT_BINDING_KEYS = [
  'project_id', 'repository_id', 'worktree_id', 'head_sha', 'index_tree_sha', 'worktree_digest',
];

export function evidenceCheckoutBinding(evidence = {}) {
  return Object.fromEntries(CHECKOUT_BINDING_KEYS.map((key) => [key, evidence[key]]));
}

export function evidenceCheckoutBindingMatches(actual, expected) {
  return Boolean(actual && expected) && CHECKOUT_BINDING_KEYS.every(
    (key) => actual[key] === expected[key] && expected[key] != null,
  );
}

export function evaluateEvidenceBinding(evidence, expected = {}) {
  if (!evidence) return { state: 'unproven', reasons: ['evidence missing'] };
  if (Array.isArray(evidence) || evidence.schema_version !== 2) {
    return { state: 'legacy-unbound', reasons: ['evidence schema v1 has no checkout binding'] };
  }

  const contextReasons = [];
  if (expected.change_slug != null && evidence.change_slug !== expected.change_slug) {
    contextReasons.push('change_slug mismatch');
  }
  for (const key of ['project_id', 'repository_id', 'worktree_id', 'work_session_id']) {
    if (expected.identity?.[key] != null && evidence[key] !== expected.identity[key]) {
      contextReasons.push(`${key} mismatch`);
    }
  }
  if (contextReasons.length) return { state: 'context-mismatch', reasons: contextReasons };

  const staleReasons = [];
  const unsigned = { ...evidence };
  delete unsigned.envelope_id;
  if (!evidence.envelope_id || canonicalSha256(unsigned) !== evidence.envelope_id) {
    staleReasons.push('envelope_id invalid');
  }
  for (const key of ['branch', 'base_sha', 'head_sha', 'index_tree_sha', 'worktree_digest', 'dirty']) {
    if (expected.snapshot?.[key] != null && evidence[key] !== expected.snapshot[key]) {
      staleReasons.push(`${key} changed`);
    }
  }
  for (const key of ['tasks_sha256', 'effective_spec_sha256', 'sensor_config_sha256']) {
    if (expected[key] != null && evidence[key] !== expected[key]) staleReasons.push(`${key} changed`);
  }
  return staleReasons.length
    ? { state: 'stale', reasons: staleReasons }
    : { state: 'bound', reasons: [] };
}
