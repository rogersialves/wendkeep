import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  VAULT_LOCK_BUSY,
  assertVaultPathSafe,
  mkdirVaultPath,
  withVaultPathLock,
  writeVaultFileAtomic,
} from './vault-path-safety.mjs';
import { sanitizeObservabilityDiagnostics } from './session-observability-state.mjs';

const STORE_SCHEMA_VERSION = 1;
const STORE_DIR_PARTS = ['.brain', 'runtime', 'session-observability'];
const STORE_PATH_CODE = 'OBSERVABILITY_STORE_PATH_UNSAFE';
const DEFAULT_SIGNAL_LIMIT = 4_096;
const SIGNAL_KINDS = new Set(['started', 'interacted', 'interrupted']);

function storeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nonEmptyString(value, code = 'OBSERVABILITY_STORE_INVALID') {
  if (typeof value !== 'string' || !value.trim()) {
    throw storeError(code, 'identificador de observabilidade inválido');
  }
  return value.trim();
}

function sequence(value, fallback = null) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function timeValue(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function jsonClone(value) {
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)); }
  catch { throw storeError('OBSERVABILITY_STORE_INVALID', 'estado de observabilidade inválido'); }
}

function defaultState(sessionId, {
  reconstructed = false,
  dirty = false,
  diagnostics = [],
} = {}) {
  return {
    schema_version: STORE_SCHEMA_VERSION,
    session_id: sessionId,
    observability_signal_sequence: 0,
    observability_checkpoint_sequence: 0,
    observability_dirty: dirty,
    signals: [],
    lease: null,
    checkpoint_frontier: null,
    source_manifest: null,
    graph_cache: null,
    diagnostics: sanitizeObservabilityDiagnostics(diagnostics),
    reconstructed,
  };
}

function normalizeSignal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw storeError('OBSERVABILITY_SIGNAL_INVALID', 'sinal de observabilidade inválido');
  }
  const rolloutId = nonEmptyString(
    input.rollout_id ?? input.rolloutId ?? input.agent_thread_id ?? input.agentThreadId,
    'OBSERVABILITY_SIGNAL_INVALID',
  );
  const signal = { rollout_id: rolloutId };
  const transcriptPath = input.transcript_path ?? input.transcriptPath;
  if (typeof transcriptPath === 'string' && transcriptPath.trim()) {
    signal.transcript_path = transcriptPath.trim();
  }
  const parentThreadId = input.parent_thread_id
    ?? input.parentThreadId
    ?? input.parent_rollout_id
    ?? input.parentRolloutId;
  if (typeof parentThreadId === 'string' && parentThreadId.trim()) {
    signal.parent_thread_id = parentThreadId.trim();
  }
  const rawKind = input.kind ?? input.event_kind ?? input.eventKind ?? 'started';
  if (typeof rawKind !== 'string' || !SIGNAL_KINDS.has(rawKind.trim().toLowerCase())) {
    throw storeError('OBSERVABILITY_SIGNAL_INVALID', 'sinal de observabilidade inválido');
  }
  signal.kind = rawKind.trim().toLowerCase();
  const timestamp = input.timestamp ?? input.started_at ?? input.startedAt;
  if (typeof timestamp === 'string' && timestamp.trim()) {
    signal.timestamp = timestamp.trim();
  }
  const agentPath = input.agent_path ?? input.agentPath;
  if (typeof agentPath === 'string' && agentPath.trim()) {
    signal.agent_path = agentPath.trim();
  }
  const activationId = input.activation_id ?? input.activationId;
  if (typeof activationId === 'string' && activationId.trim()) {
    signal.activation_id = activationId.trim();
  }
  for (const [target, source] of [
    ['activation_epoch', input.activation_epoch ?? input.activationEpoch],
    ['turn_sequence', input.turn_sequence ?? input.turnSequence],
    ['signal_sequence', input.signal_sequence ?? input.signalSequence],
  ]) {
    if (source !== undefined) {
      const normalized = sequence(source);
      if (normalized === null) {
        throw storeError('OBSERVABILITY_SIGNAL_INVALID', 'sinal de observabilidade inválido');
      }
      signal[target] = normalized;
    }
  }
  if (typeof input.observed_at === 'string' && input.observed_at.trim()) {
    signal.observed_at = input.observed_at.trim();
  }
  return signal;
}

function normalizeLease(input) {
  if (input == null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw storeError('OBSERVABILITY_STORE_CORRUPT', 'lease de observabilidade corrompida');
  }
  const signalSequence = sequence(input.signal_sequence);
  const expiresAt = timeValue(input.expires_at, null);
  if (signalSequence === null || expiresAt === null) {
    throw storeError('OBSERVABILITY_STORE_CORRUPT', 'lease de observabilidade corrompida');
  }
  return {
    owner_token: nonEmptyString(input.owner_token, 'OBSERVABILITY_STORE_CORRUPT'),
    signal_sequence: signalSequence,
    acquired_at: timeValue(input.acquired_at, expiresAt),
    expires_at: expiresAt,
  };
}

function normalizeStoreState(input, sessionId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || input.schema_version !== STORE_SCHEMA_VERSION
    || input.session_id !== sessionId) {
    throw storeError('OBSERVABILITY_STORE_CORRUPT', 'store de observabilidade corrompido');
  }
  const signalSequence = sequence(input.observability_signal_sequence);
  const checkpointSequence = sequence(input.observability_checkpoint_sequence);
  if (signalSequence === null || checkpointSequence === null
    || checkpointSequence > signalSequence
    || typeof input.observability_dirty !== 'boolean'
    || !Array.isArray(input.signals)) {
    throw storeError('OBSERVABILITY_STORE_CORRUPT', 'store de observabilidade corrompido');
  }
  const seen = new Set();
  const signals = input.signals.map(normalizeSignal);
  let previousSignalSequence = 0;
  for (const signal of signals) {
    if (seen.has(signal.rollout_id)
      || !Number.isSafeInteger(signal.signal_sequence)
      || signal.signal_sequence <= previousSignalSequence
      || signal.signal_sequence > signalSequence) {
      throw storeError('OBSERVABILITY_STORE_CORRUPT', 'store de observabilidade corrompido');
    }
    seen.add(signal.rollout_id);
    previousSignalSequence = signal.signal_sequence;
  }
  return {
    schema_version: STORE_SCHEMA_VERSION,
    session_id: sessionId,
    observability_signal_sequence: signalSequence,
    observability_checkpoint_sequence: checkpointSequence,
    observability_dirty: input.observability_dirty,
    signals,
    lease: normalizeLease(input.lease),
    checkpoint_frontier: jsonClone(input.checkpoint_frontier),
    source_manifest: jsonClone(input.source_manifest),
    graph_cache: jsonClone(input.graph_cache),
    diagnostics: sanitizeObservabilityDiagnostics(input.diagnostics ?? []),
    reconstructed: Boolean(input.reconstructed),
  };
}

function serializableState(input) {
  return {
    schema_version: input.schema_version,
    session_id: input.session_id,
    observability_signal_sequence: input.observability_signal_sequence,
    observability_checkpoint_sequence: input.observability_checkpoint_sequence,
    observability_dirty: input.observability_dirty,
    signals: input.signals,
    lease: input.lease,
    checkpoint_frontier: input.checkpoint_frontier,
    source_manifest: input.source_manifest,
    graph_cache: input.graph_cache,
    diagnostics: input.diagnostics,
  };
}

function serialized(input) {
  return `${JSON.stringify(serializableState(input), null, 2)}\n`;
}

function storeDirectory(vaultBase) {
  return join(vaultBase, ...STORE_DIR_PARTS);
}

function ensureStoreDirectory(vaultBase) {
  return mkdirVaultPath(vaultBase, storeDirectory(vaultBase), {
    recursive: true,
    label: 'runtime de observabilidade de sessão',
    code: STORE_PATH_CODE,
  });
}

export function observabilityStorePath(vaultBase, sessionId) {
  const id = nonEmptyString(sessionId);
  const digest = createHash('sha256').update(id).digest('hex');
  return join(vaultBase, ...STORE_DIR_PARTS, `${digest}.json`);
}

function readStorePath(vaultBase, sessionId, path) {
  const checked = assertVaultPathSafe(vaultBase, path, {
    expectedType: 'file',
    label: 'store de observabilidade de sessão',
    code: STORE_PATH_CODE,
  });
  if (!checked.exists) return defaultState(sessionId);
  try {
    const raw = readFileSync(checked.target, 'utf8');
    assertVaultPathSafe(vaultBase, checked.target, {
      allowMissing: false,
      expectedType: 'file',
      label: 'store de observabilidade de sessão',
      code: STORE_PATH_CODE,
    });
    return normalizeStoreState(JSON.parse(raw), sessionId);
  } catch (error) {
    if (error?.code === STORE_PATH_CODE) throw error;
    return defaultState(sessionId, {
      reconstructed: true,
      dirty: true,
      diagnostics: [{ code: 'CACHE_INVALID', count: 1 }],
    });
  }
}

export function readObservabilityStore(vaultBase, sessionId) {
  const id = nonEmptyString(sessionId);
  return readStorePath(vaultBase, id, observabilityStorePath(vaultBase, id));
}

/**
 * Serialize a small store transition under the hardened Vault path lock.
 * The mutator may return `{ state, value }`; its `value` is returned without persistence.
 */
export function mutateObservabilityStore(vaultBase, sessionId, mutator, {
  lockTimeoutMs = 2_000,
  lockStaleMs = 10_000,
} = {}) {
  const id = nonEmptyString(sessionId);
  if (typeof mutator !== 'function') {
    throw storeError('OBSERVABILITY_STORE_INVALID', 'mutator de observabilidade inválido');
  }
  ensureStoreDirectory(vaultBase);
  const path = observabilityStorePath(vaultBase, id);
  const outcome = withVaultPathLock(vaultBase, path, () => {
    const current = readStorePath(vaultBase, id, path);
    const transition = mutator(jsonClone(current));
    if (transition == null) {
      return { state: current, changed: false, value: null, reconstructed: current.reconstructed };
    }
    const nextInput = Object.hasOwn(transition, 'state') ? transition.state : transition;
    const value = Object.hasOwn(transition, 'state') ? transition.value : null;
    const next = normalizeStoreState({
      ...nextInput,
      schema_version: STORE_SCHEMA_VERSION,
      session_id: id,
    }, id);
    next.reconstructed = false;
    const before = serialized(current);
    const after = serialized(next);
    if (before !== after || current.reconstructed) {
      writeVaultFileAtomic(vaultBase, path, after, 'utf8', {
        label: 'store de observabilidade de sessão',
        code: STORE_PATH_CODE,
      });
    }
    return {
      state: next,
      changed: before !== after || current.reconstructed,
      value,
      reconstructed: current.reconstructed,
    };
  }, {
    timeoutMs: lockTimeoutMs,
    staleMs: lockStaleMs,
    code: STORE_PATH_CODE,
  });
  if (outcome === VAULT_LOCK_BUSY) {
    return { state: null, changed: false, value: null, busy: true, reconstructed: false };
  }
  return { ...outcome, busy: false };
}

export function recordObservabilitySignal(vaultBase, sessionId, signalInput, {
  maxSignals = DEFAULT_SIGNAL_LIMIT,
  ...storeOptions
} = {}) {
  const signal = normalizeSignal(signalInput);
  if (!Number.isSafeInteger(maxSignals) || maxSignals <= 0) {
    throw storeError('OBSERVABILITY_STORE_INVALID', 'limite de sinais inválido');
  }
  const outcome = mutateObservabilityStore(vaultBase, sessionId, (state) => {
    const duplicate = state.signals.some((entry) => entry.rollout_id === signal.rollout_id);
    if (duplicate) return { state, value: { duplicate: true } };
    const nextSequence = state.observability_signal_sequence + 1;
    state.observability_signal_sequence = nextSequence;
    state.observability_dirty = true;
    state.signals = [...state.signals, { ...signal, signal_sequence: nextSequence }]
      .slice(-maxSignals);
    return { state, value: { duplicate: false } };
  }, storeOptions);
  if (outcome.busy) {
    return { recorded: false, duplicate: false, sequence: null, state: null, reason: 'store-busy' };
  }
  return {
    recorded: !outcome.value.duplicate,
    duplicate: outcome.value.duplicate,
    sequence: outcome.state.observability_signal_sequence,
    state: outcome.state,
    reason: outcome.value.duplicate ? 'duplicate' : 'recorded',
  };
}

export function tryAcquireObservabilityLease(vaultBase, sessionId, {
  signalSequence,
  ownerToken = randomUUID(),
  now = Date.now(),
  ttlMs = 20_000,
  ...storeOptions
} = {}) {
  const requestedSequence = sequence(signalSequence);
  const token = nonEmptyString(ownerToken, 'OBSERVABILITY_LEASE_INVALID');
  const nowMs = timeValue(now, null);
  if (requestedSequence === null || nowMs === null || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw storeError('OBSERVABILITY_LEASE_INVALID', 'lease de observabilidade inválida');
  }
  const outcome = mutateObservabilityStore(vaultBase, sessionId, (state) => {
    const latest = state.observability_signal_sequence;
    if (requestedSequence < latest) {
      return { state, value: { acquired: false, reason: 'stale-signal' } };
    }
    if (requestedSequence > latest) {
      return { state, value: { acquired: false, reason: 'future-signal' } };
    }
    const lease = state.lease;
    if (lease && lease.expires_at > nowMs
      && lease.signal_sequence === requestedSequence
      && lease.owner_token !== token) {
      return { state, value: { acquired: false, reason: 'lease-busy' } };
    }
    if (lease && lease.expires_at > nowMs
      && lease.signal_sequence === requestedSequence
      && lease.owner_token === token) {
      return { state, value: { acquired: true, reason: 'already-owned' } };
    }
    state.lease = {
      owner_token: token,
      signal_sequence: requestedSequence,
      acquired_at: nowMs,
      expires_at: nowMs + ttlMs,
    };
    return { state, value: { acquired: true, reason: lease ? 'superseded' : 'acquired' } };
  }, storeOptions);
  if (outcome.busy) {
    return { acquired: false, reason: 'store-busy', state: null, ownerToken: token };
  }
  return { ...outcome.value, state: outcome.state, ownerToken: token };
}

export function releaseObservabilityLease(vaultBase, sessionId, {
  ownerToken,
  signalSequence,
  ...storeOptions
} = {}) {
  const token = nonEmptyString(ownerToken, 'OBSERVABILITY_LEASE_INVALID');
  const expectedSequence = signalSequence === undefined ? null : sequence(signalSequence);
  if (signalSequence !== undefined && expectedSequence === null) {
    throw storeError('OBSERVABILITY_LEASE_INVALID', 'lease de observabilidade inválida');
  }
  const outcome = mutateObservabilityStore(vaultBase, sessionId, (state) => {
    const owned = state.lease?.owner_token === token
      && (expectedSequence === null || state.lease.signal_sequence === expectedSequence);
    if (!owned) return { state, value: { released: false, reason: 'not-owner' } };
    state.lease = null;
    return { state, value: { released: true, reason: 'released' } };
  }, storeOptions);
  if (outcome.busy) return { released: false, reason: 'store-busy', state: null };
  return { ...outcome.value, state: outcome.state };
}

export function markObservabilityCheckpoint(vaultBase, sessionId, {
  checkpointSequence,
  frontier = null,
  sourceManifest,
  graphCache,
  diagnostics,
  ...storeOptions
} = {}) {
  const nextCheckpoint = sequence(checkpointSequence);
  if (nextCheckpoint === null) {
    throw storeError('OBSERVABILITY_CHECKPOINT_INVALID', 'checkpoint de observabilidade inválido');
  }
  const outcome = mutateObservabilityStore(vaultBase, sessionId, (state) => {
    if (nextCheckpoint > state.observability_signal_sequence) {
      throw storeError('OBSERVABILITY_CHECKPOINT_INVALID', 'checkpoint de observabilidade inválido');
    }
    if (nextCheckpoint < state.observability_checkpoint_sequence) {
      return { state, value: { accepted: false, reason: 'stale-checkpoint' } };
    }
    state.observability_checkpoint_sequence = nextCheckpoint;
    state.observability_dirty = nextCheckpoint < state.observability_signal_sequence;
    state.checkpoint_frontier = jsonClone(frontier);
    if (sourceManifest !== undefined) state.source_manifest = jsonClone(sourceManifest);
    if (graphCache !== undefined) state.graph_cache = jsonClone(graphCache);
    if (diagnostics !== undefined) {
      state.diagnostics = sanitizeObservabilityDiagnostics(diagnostics);
    }
    if (state.lease && state.lease.signal_sequence <= nextCheckpoint) state.lease = null;
    return { state, value: { accepted: true, reason: 'checkpointed' } };
  }, storeOptions);
  if (outcome.busy) return null;
  return outcome.state;
}
