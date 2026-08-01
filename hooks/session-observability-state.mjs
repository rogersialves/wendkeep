import { createHash } from 'node:crypto';

export const OBSERVABILITY_SCHEMA = 2;

export const OBSERVABILITY_DIAGNOSTIC_CODES = Object.freeze([
  'CACHE_INVALID',
  'CHILD_META_INVALID',
  'CHILD_MISSING',
  'DUPLICATE_ROLLOUT_ID',
  'FALLBACK_LIMIT_EXCEEDED',
  'GRAPH_LIMIT_EXCEEDED',
  'LEGACY_CHAIN_UNPROVEN',
  'LIVE_BYTE_BUDGET_EXCEEDED',
  'LIVE_DEADLINE_EXCEEDED',
  'MAIN_TRANSCRIPT_UNRESOLVED',
  'PARENT_META_INVALID',
  'ROOT_MISMATCH',
  'SOURCE_CHANGED_DURING_SCAN',
  'STALE_FRONTIER',
]);

const DIAGNOSTIC_CODE_SET = new Set(OBSERVABILITY_DIAGNOSTIC_CODES);
const OBSERVABILITY_STATES = new Set(['complete', 'none', 'degraded']);
const FRONTIER_STRING_FIELDS = [
  'canonical_session_id',
  'activation_id',
  'roots_stat_hash',
  'graph_cursor',
  'source_manifest_hash',
];
const FRONTIER_SEQUENCE_FIELDS = [
  'activation_epoch',
  'turn_sequence',
  'signal_sequence',
];
const FRONTMATTER_TO_FRONTIER = Object.freeze({
  canonical_session_id: 'observability_session_id',
  activation_id: 'observability_activation_id',
  activation_epoch: 'observability_activation_epoch',
  turn_sequence: 'observability_turn_sequence',
  signal_sequence: 'observability_signal_sequence',
  roots_stat_hash: 'observability_roots_stat_hash',
  graph_cursor: 'observability_graph_cursor',
  source_manifest_hash: 'observability_source_manifest_hash',
});

function diagnosticError() {
  const error = new TypeError('diagnostic de observabilidade inválido');
  error.code = 'OBSERVABILITY_DIAGNOSTIC_INVALID';
  return error;
}

function frontierError() {
  const error = new TypeError('frontier de observabilidade inválido');
  error.code = 'OBSERVABILITY_FRONTIER_INVALID';
  return error;
}

function checkpointError() {
  const error = new TypeError('checkpoint de observabilidade inválido');
  error.code = 'OBSERVABILITY_CHECKPOINT_INVALID';
  return error;
}

function safeNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeSequence(value) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Reduce diagnostics to the only shape that may cross the local runtime boundary.
 * Values are never interpolated in thrown errors so rejected private data is not echoed.
 */
export function sanitizeObservabilityDiagnostics(diagnostics = []) {
  if (!Array.isArray(diagnostics)) throw diagnosticError();
  const counts = new Map();
  for (const diagnostic of diagnostics) {
    if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
      throw diagnosticError();
    }
    const keys = Object.keys(diagnostic).sort();
    if (keys.length !== 2 || keys[0] !== 'code' || keys[1] !== 'count') {
      throw diagnosticError();
    }
    if (!DIAGNOSTIC_CODE_SET.has(diagnostic.code)
      || !Number.isSafeInteger(diagnostic.count)
      || diagnostic.count <= 0) {
      throw diagnosticError();
    }
    counts.set(diagnostic.code, (counts.get(diagnostic.code) || 0) + diagnostic.count);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count }));
}

export function normalizeObservabilityFrontier(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw frontierError();
  const frontier = {};
  for (const field of FRONTIER_STRING_FIELDS) {
    const value = safeNonEmptyString(input[field]);
    if (value === null) throw frontierError();
    frontier[field] = value;
  }
  for (const field of FRONTIER_SEQUENCE_FIELDS) {
    const value = safeSequence(input[field]);
    if (value === null) throw frontierError();
    frontier[field] = value;
  }
  return {
    canonical_session_id: frontier.canonical_session_id,
    activation_id: frontier.activation_id,
    activation_epoch: frontier.activation_epoch,
    turn_sequence: frontier.turn_sequence,
    signal_sequence: frontier.signal_sequence,
    roots_stat_hash: frontier.roots_stat_hash,
    graph_cursor: frontier.graph_cursor,
    source_manifest_hash: frontier.source_manifest_hash,
  };
}

export const buildObservabilityFrontier = normalizeObservabilityFrontier;

export function hashObservabilityFrontier(input) {
  const frontier = normalizeObservabilityFrontier(input);
  return createHash('sha256').update(JSON.stringify(frontier)).digest('hex');
}

/**
 * Compare a candidate frontier with the checkpoint already materialized.
 * The argument order is deliberately (current, candidate), matching a CAS writer.
 */
export function compareObservabilityFrontiers(currentInput, candidateInput) {
  if (!currentInput) {
    normalizeObservabilityFrontier(candidateInput);
    return 'newer';
  }
  const current = normalizeObservabilityFrontier(currentInput);
  const candidate = normalizeObservabilityFrontier(candidateInput);
  if (current.canonical_session_id !== candidate.canonical_session_id) return 'conflict';

  for (const field of FRONTIER_SEQUENCE_FIELDS) {
    if (candidate[field] < current[field]) return 'stale';
    if (candidate[field] > current[field]) return 'newer';
    if (field === 'activation_epoch' && candidate.activation_id !== current.activation_id) {
      return 'conflict';
    }
  }

  for (const field of ['roots_stat_hash', 'graph_cursor', 'source_manifest_hash']) {
    if (candidate[field] !== current[field]) return 'conflict';
  }
  return 'same';
}

export const compareObservabilityFrontier = compareObservabilityFrontiers;

function unquoteFrontmatterValue(raw) {
  const value = String(raw ?? '').trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  return value;
}

function checkpointFields(input) {
  if (typeof input !== 'string') return input;
  const normalized = input.replaceAll('\r\n', '\n');
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1] ?? normalized;
  const fields = {};
  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (match) fields[match[1]] = unquoteFrontmatterValue(match[2]);
  }
  return fields;
}

export function renderObservabilityCheckpoint(frontierInput, {
  state,
  diagnostics = [],
} = {}) {
  const frontier = normalizeObservabilityFrontier(frontierInput);
  if (!OBSERVABILITY_STATES.has(state)) throw checkpointError();
  const safeDiagnostics = sanitizeObservabilityDiagnostics(diagnostics);
  return {
    observability_schema: OBSERVABILITY_SCHEMA,
    subagents_observability_state: state,
    observability_session_id: frontier.canonical_session_id,
    observability_activation_id: frontier.activation_id,
    observability_activation_epoch: frontier.activation_epoch,
    observability_turn_sequence: frontier.turn_sequence,
    observability_signal_sequence: frontier.signal_sequence,
    observability_roots_stat_hash: frontier.roots_stat_hash,
    observability_graph_cursor: frontier.graph_cursor,
    observability_source_manifest_hash: frontier.source_manifest_hash,
    subagents_diagnostics_json: JSON.stringify(safeDiagnostics),
  };
}

function quoteFrontmatter(value) {
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function renderObservabilityCheckpointLines(frontierInput, options = {}) {
  const fields = renderObservabilityCheckpoint(frontierInput, options);
  return Object.entries(fields).map(([key, value]) => `${key}: ${quoteFrontmatter(value)}`).join('\n');
}

export function parseObservabilityCheckpoint(input) {
  const fields = checkpointFields(input);
  if (!fields || typeof fields !== 'object') return null;
  if (safeSequence(fields.observability_schema) !== OBSERVABILITY_SCHEMA) return null;
  if (!OBSERVABILITY_STATES.has(fields.subagents_observability_state)) return null;
  try {
    const source = {};
    for (const [field, frontmatterKey] of Object.entries(FRONTMATTER_TO_FRONTIER)) {
      source[field] = unquoteFrontmatterValue(fields[frontmatterKey]);
    }
    const frontier = normalizeObservabilityFrontier(source);
    const diagnosticsRaw = unquoteFrontmatterValue(fields.subagents_diagnostics_json ?? '[]');
    const diagnostics = sanitizeObservabilityDiagnostics(JSON.parse(diagnosticsRaw));
    return {
      schema: OBSERVABILITY_SCHEMA,
      state: fields.subagents_observability_state,
      frontier,
      diagnostics,
    };
  } catch {
    return null;
  }
}

export const readObservabilityCheckpoint = parseObservabilityCheckpoint;
