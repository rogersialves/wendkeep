// Durable FLOW runtime state. This belongs to the Vault persistence surface and has
// deliberately no dependency on change/sensor/profile policy modules.
import {
  readFileSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { getLocale } from './locale.mjs';
import {
  assertVaultPathSafe, mkdirVaultPath, VAULT_LOCK_BUSY, withVaultPathLock,
  writeVaultFileAtomic,
} from './vault-path-safety.mjs';

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const MISSING = Symbol('FLOW_STORE_MISSING');

function safeId(value, name) {
  const id = String(value || '').trim();
  if (!ID_RE.test(id)
    || id.startsWith('.')
    || id.endsWith('.')
    || WINDOWS_RESERVED_RE.test(id)) {
    throw new TypeError(`${name} inválido: ${id || '(vazio)'}`);
  }
  return id;
}

function runtimeRoot(vaultBase) {
  const root = join(vaultBase, '.brain', 'runtime', 'flows');
  return assertVaultPathSafe(vaultBase, root, {
    expectedType: 'directory', label: 'raiz runtime de FLOW',
  }).target;
}

function sessionRoot(vaultBase, sessionId) {
  const root = join(runtimeRoot(vaultBase), safeId(sessionId, 'session_id'));
  return assertVaultPathSafe(vaultBase, root, {
    expectedType: 'directory', label: 'raiz runtime da sessão FLOW',
  }).target;
}

export function flowDir(vaultBase, sessionId, flowId) {
  const dir = join(sessionRoot(vaultBase, sessionId), safeId(flowId, 'flow_id'));
  return assertVaultPathSafe(vaultBase, dir, {
    expectedType: 'directory', label: 'raiz runtime do FLOW',
  }).target;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalText(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function readJson(vaultBase, path, label) {
  const checked = assertVaultPathSafe(vaultBase, path, { expectedType: 'file', label });
  if (!checked.exists) return MISSING;
  try {
    return JSON.parse(readFileSync(checked.target, 'utf8'));
  } catch (cause) {
    const error = new Error(`${label} corrompido: ${path}`);
    error.code = 'FLOW_STORE_CORRUPT';
    error.cause = cause;
    throw error;
  }
}

function immutableJson(vaultBase, path, value) {
  const current = readJson(vaultBase, path, 'artefato FLOW');
  const content = canonicalText(value);
  if (current !== MISSING) {
    if (canonicalText(current) === content) return { created: false, path };
    const error = new Error(`artefato FLOW imutável já existe: ${path}`);
    error.code = 'FLOW_IMMUTABLE_CONFLICT';
    throw error;
  }
  writeVaultFileAtomic(vaultBase, path, content, 'utf8', { label: 'artefato FLOW imutável' });
  return { created: true, path };
}

function underSessionLock(vaultBase, sessionId, fn) {
  const root = sessionRoot(vaultBase, sessionId);
  mkdirVaultPath(vaultBase, root, { label: 'raiz runtime da sessão FLOW' });
  const outcome = withVaultPathLock(vaultBase, join(root, '.state'), fn, { timeoutMs: 5000 });
  if (typeof outcome === 'symbol') {
    const error = new Error(`store FLOW ocupado para sessão ${sessionId}`);
    error.code = 'FLOW_STORE_BUSY';
    throw error;
  }
  return outcome;
}

// Lock hierarchy for the durable promotion saga is always:
// change slug (this lock) -> FLOW session store / SESSION_REGISTRY. Session-note projection
// happens only after the terminal write and lock release. No store mutator acquires the slug
// lock, so a session lock is never held while waiting for it. Unlike the generic short write
// lock, a live owner is never reaped by age.
export function withFlowPromotionLock(vaultBase, changeSlug, fn, {
  timeoutMs = 15_000,
  ownerGraceMs = 1_000,
} = {}) {
  const slug = safeId(changeSlug, 'change_slug');
  const root = join(vaultBase, '.brain', 'runtime', 'flow-promotion-locks');
  mkdirVaultPath(vaultBase, root, { label: 'raiz de locks de promoção FLOW' });
  const outcome = withVaultPathLock(vaultBase, join(root, slug), fn, {
    timeoutMs,
    staleMs: ownerGraceMs,
  });
  if (outcome === VAULT_LOCK_BUSY) {
    const busy = new Error(`promoção FLOW ocupada para a change ${slug}`);
    busy.code = 'FLOW_PROMOTION_BUSY';
    throw busy;
  }
  return outcome;
}

function isCanonicalFlowPath(value, { allowTree = false, allowProjectRoot = false } = {}) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return false;
  if (allowProjectRoot && value === '.') return true;
  if (value.includes('\\')
    || value.startsWith('/')
    || /^[A-Za-z]:/.test(value)
    || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const segments = value.split('/');
  if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return false;
  }
  const tree = segments.at(-1) === '**';
  if (tree && (!allowTree || segments.length < 2)) return false;
  const literalSegments = tree ? segments.slice(0, -1) : segments;
  return literalSegments.every((segment) => !segment.includes(':')
    && !/[*?\[\]{}!]/.test(segment)
    && segment.toLowerCase() !== '.git');
}

function canonicalFlowPathArray(value, options = {}) {
  return Array.isArray(value) && value.every((path) => isCanonicalFlowPath(path, options));
}

function assertContract(contract, expected = {}) {
  if (!contract || contract.schema_version !== 1 || contract.profile !== 'FLOW') {
    throw new TypeError('microcontrato FLOW schema_version 1 inválido');
  }
  safeId(contract.flow_id, 'flow_id');
  safeId(contract.session_id, 'session_id');
  const requiredStrings = ['session_file', 'slug', 'started_at', 'reason', 'sensor_definition_hash', 'project_rel'];
  const malformed = requiredStrings.some((key) => typeof contract[key] !== 'string' || !contract[key].trim())
    || contract.spec_impact !== 'none'
    || !Array.isArray(contract.allowed_paths) || contract.allowed_paths.length === 0
    || !canonicalFlowPathArray(contract.allowed_paths, { allowTree: true })
    || !canonicalFlowPathArray(contract.protected_roots, { allowTree: true })
    || !Array.isArray(contract.sensor_ids) || contract.sensor_ids.length === 0
    || contract.sensor_ids.some((id) => typeof id !== 'string' || !id)
    || contract.baseline?.schema_version !== 1
    || typeof contract.baseline?.root !== 'string' || !contract.baseline.root
    || typeof contract.baseline?.head !== 'string' || !contract.baseline.head
    || !contract.baseline?.fingerprints || typeof contract.baseline.fingerprints !== 'object'
    || Array.isArray(contract.baseline?.fingerprints)
    || !/^[a-f0-9]{64}$/i.test(contract.baseline?.git_metadata_fingerprint || '')
    || !Array.isArray(contract.baseline?.hidden_index_paths)
    || !Array.isArray(contract.baseline?.unsafe_git_metadata_paths)
    || !Array.isArray(contract.baseline?.unsafe_worktree_paths)
    || [...(contract.baseline?.hidden_index_paths || []),
      ...(contract.baseline?.unsafe_git_metadata_paths || []),
      ...(contract.baseline?.unsafe_worktree_paths || [])]
      .some((path) => typeof path !== 'string' || !path)
    || !isCanonicalFlowPath(contract.session_file)
    || !isCanonicalFlowPath(contract.project_rel, { allowProjectRoot: true });
  if (malformed) throw new TypeError('microcontrato FLOW incompleto ou inválido');
  if ((expected.flowId && contract.flow_id !== expected.flowId)
    || (expected.sessionId && contract.session_id !== expected.sessionId)) {
    const error = new Error('microcontrato FLOW inconsistente com seu path no store');
    error.code = 'FLOW_STORE_CORRUPT';
    throw error;
  }
}

function assertTerminalArtifact(artifact, { flowId, status, label }) {
  if (artifact === MISSING) return;
  const baseMalformed = !isPlainObject(artifact)
    || artifact.schema_version !== 1
    || artifact.flow_id !== flowId
    || artifact.status !== status;
  const payloadMalformed = !baseMalformed && (status === 'finished'
    ? !validReceipt(artifact)
    : !validPromotion(artifact));
  if (baseMalformed || payloadMalformed) throw corruptArtifact(label, flowId);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function stringArray(value, { nonEmpty = false } = {}) {
  return Array.isArray(value)
    && (!nonEmpty || value.length > 0)
    && value.every(nonEmptyString);
}

function validEvidence(value, { timestamp = false } = {}) {
  return Array.isArray(value) && value.every((entry) => isPlainObject(entry)
    && nonEmptyString(entry.id)
    && ['green', 'red'].includes(entry.status)
    && nonEmptyString(entry.severity)
    && (!timestamp || nonEmptyString(entry.ts)));
}

function validReceipt(receipt) {
  return nonEmptyString(receipt.finished_at)
    && nonEmptyString(receipt.reason)
    && stringArray(receipt.allowed_paths, { nonEmpty: true })
    && canonicalFlowPathArray(receipt.allowed_paths, { allowTree: true })
    && stringArray(receipt.sensor_ids, { nonEmpty: true })
    && stringArray(receipt.changed_paths, { nonEmpty: true })
    && canonicalFlowPathArray(receipt.changed_paths)
    && validEvidence(receipt.evidence, { timestamp: true })
    && nonEmptyString(receipt.baseline_head)
    && nonEmptyString(receipt.final_head);
}

function normalizedFlowPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathAllowedByContract(path, allowlist) {
  if (!isCanonicalFlowPath(path)
    || !canonicalFlowPathArray(allowlist, { allowTree: true })) return false;
  const candidate = normalizedFlowPath(path);
  return allowlist.some((raw) => {
    const allowed = normalizedFlowPath(raw);
    if (allowed.endsWith('/**')) {
      const prefix = allowed.slice(0, -3);
      return candidate === prefix || candidate.startsWith(`${prefix}/`);
    }
    return candidate === allowed;
  });
}

function assertReceiptMatchesContract(receipt, contract, flowId) {
  if (receipt === MISSING) return;
  const evidenceIds = receipt.evidence.map((entry) => entry.id);
  const matches = receipt.reason === contract.reason
    && canonicalText(receipt.allowed_paths) === canonicalText(contract.allowed_paths)
    && canonicalText(receipt.sensor_ids) === canonicalText(contract.sensor_ids)
    && canonicalText(evidenceIds) === canonicalText(contract.sensor_ids)
    && receipt.evidence.every((entry) => entry.status === 'green')
    && receipt.changed_paths.every((path) => pathAllowedByContract(path, contract.allowed_paths))
    && receipt.baseline_head === contract.baseline.head;
  if (!matches) throw corruptArtifact('recibo incompatível com o contrato', flowId);
}

function validPromotion(promotion) {
  return nonEmptyString(promotion.promoted_at)
    && nonEmptyString(promotion.change_slug)
    && nonEmptyString(promotion.change_rel)
    && isCanonicalFlowPath(promotion.change_rel)
    && nonEmptyString(promotion.origin_file)
    && isCanonicalFlowPath(promotion.origin_file)
    && stringArray(promotion.changed_paths)
    && canonicalFlowPathArray(promotion.changed_paths)
    && nonEmptyString(promotion.baseline_head)
    && nonEmptyString(promotion.current_head);
}

function expectedChangeRel(vaultBase, slug) {
  return `${String(getLocale(vaultBase).folders.changes).replaceAll('\\', '/')}/${slug}`;
}

function validPromotionReservation(vaultBase, reservation, flowId) {
  const origin = reservation?.origin;
  let slug = '';
  try {
    assertContract(origin?.contract, { flowId });
    slug = safeId(reservation?.change_slug, 'change_slug');
  } catch {
    return false;
  }
  return isPlainObject(reservation)
    && reservation.schema_version === 1
    && reservation.flow_id === flowId
    && reservation.status === 'promoting'
    && nonEmptyString(reservation.reserved_at)
    && reservation.change_slug === slug
    && reservation.change_rel === expectedChangeRel(vaultBase, slug)
    && isPlainObject(origin)
    && origin.schema_version === 1
    && origin.flow_id === flowId
    && origin.promoted_at === reservation.reserved_at
    && Array.isArray(origin.attempts)
    && isPlainObject(origin.observed_git)
    && nonEmptyString(origin.observed_git.baseline_head)
    && nonEmptyString(origin.observed_git.current_head)
    && typeof origin.observed_git.head_changed === 'boolean'
    && stringArray(origin.observed_git.changed_paths)
    && canonicalFlowPathArray(origin.observed_git.changed_paths);
}

function assertPromotionReservation(vaultBase, reservation, flowId) {
  if (reservation === MISSING) return;
  if (!validPromotionReservation(vaultBase, reservation, flowId)) {
    throw corruptArtifact('reserva de promoção', flowId);
  }
}

function assertReservationMatchesFlow(vaultBase, reservation, contract, attempts, flowId) {
  if (reservation === MISSING) return;
  assertPromotionReservation(vaultBase, reservation, flowId);
  const sameContract = canonicalText(reservation.origin.contract) === canonicalText(contract);
  const sameAttempts = attempts === undefined
    || canonicalText(reservation.origin.attempts) === canonicalText(attempts);
  const observed = reservation.origin.observed_git;
  const sameGitOrigin = observed.baseline_head === contract.baseline.head
    && observed.head_changed === (observed.current_head !== observed.baseline_head);
  if (!sameContract || !sameAttempts || !sameGitOrigin) {
    throw corruptArtifact('reserva de promoção incompatível com contrato/tentativas/Git observado', flowId);
  }
}

function assertPromotionMatchesReservation(promotion, reservation, flowId) {
  if (promotion === MISSING) return;
  if (reservation === MISSING) throw corruptArtifact('promoção sem reserva durável', flowId);
  const origin = reservation.origin;
  const matches = promotion.promoted_at === reservation.reserved_at
    && promotion.change_slug === reservation.change_slug
    && promotion.change_rel === reservation.change_rel
    && promotion.origin_file === `${reservation.change_rel.replaceAll('\\', '/')}/flow-origin.json`
    && canonicalText(promotion.changed_paths) === canonicalText(origin.observed_git.changed_paths)
    && promotion.baseline_head === origin.observed_git.baseline_head
    && promotion.current_head === origin.observed_git.current_head;
  if (!matches) throw corruptArtifact('promoção incompatível com sua reserva', flowId);
}

function corruptArtifact(label, flowId) {
  const error = new Error(`${label} FLOW inválido para ${flowId}`);
  error.code = 'FLOW_STORE_CORRUPT';
  return error;
}

function assertAttempt(attempt, { flowId, attemptId }) {
  let validId = false;
  try {
    validId = safeId(attempt?.attempt_id, 'attempt_id') === attemptId;
  } catch {
    validId = false;
  }
  if (!isPlainObject(attempt)
    || attempt.schema_version !== 1
    || !validId
    || attempt.status !== 'red'
    || !nonEmptyString(attempt.recorded_at)
    || !stringArray(attempt.failures, { nonEmpty: true })
    || !stringArray(attempt.changed_paths)
    || !canonicalFlowPathArray(attempt.changed_paths)
    || !validEvidence(attempt.evidence)) {
    throw corruptArtifact('tentativa', flowId);
  }
}

export function createFlowContract(vaultBase, contract) {
  assertContract(contract);
  return underSessionLock(vaultBase, contract.session_id, () => {
    const dir = flowDir(vaultBase, contract.session_id, contract.flow_id);
    mkdirVaultPath(vaultBase, dir, { label: 'raiz runtime do FLOW' });
    const existing = readJson(vaultBase, join(dir, 'contract.json'), 'contrato FLOW');
    if (existing !== MISSING) return immutableJson(vaultBase, join(dir, 'contract.json'), contract);
    const active = findActiveFlow(vaultBase, contract.session_id);
    if (active) {
      const error = new Error(`FLOW ativo já existe para sessão ${contract.session_id}: ${active.contract.flow_id}`);
      error.code = 'FLOW_ALREADY_ACTIVE';
      throw error;
    }
    return immutableJson(vaultBase, join(dir, 'contract.json'), contract);
  });
}

export function readFlow(vaultBase, { sessionId, flowId }) {
  const dir = flowDir(vaultBase, sessionId, flowId);
  const contract = readJson(vaultBase, join(dir, 'contract.json'), 'contrato FLOW');
  if (contract === MISSING) return null;
  assertContract(contract, { sessionId, flowId });
  const receiptArtifact = readJson(vaultBase, join(dir, 'receipt.json'), 'recibo FLOW');
  const promotionArtifact = readJson(vaultBase, join(dir, 'promotion.json'), 'promoção FLOW');
  const reservationArtifact = readJson(vaultBase, join(dir, 'promotion-reservation.json'), 'reserva de promoção FLOW');
  assertTerminalArtifact(receiptArtifact, { flowId, status: 'finished', label: 'recibo' });
  assertTerminalArtifact(promotionArtifact, { flowId, status: 'promoted', label: 'promoção' });
  assertPromotionReservation(vaultBase, reservationArtifact, flowId);
  assertReceiptMatchesContract(receiptArtifact, contract, flowId);
  const hasReceipt = receiptArtifact !== MISSING;
  const hasPromotion = promotionArtifact !== MISSING;
  const hasReservation = reservationArtifact !== MISSING;
  if (hasReservation) {
    assertReservationMatchesFlow(vaultBase, reservationArtifact, contract, undefined, flowId);
  }
  if (hasReceipt && hasPromotion) {
    const error = new Error(`FLOW corrompido: recibo e promoção coexistem em ${flowId}`);
    error.code = 'FLOW_STORE_CORRUPT';
    throw error;
  }
  if (hasReceipt && hasReservation) {
    const error = new Error(`FLOW corrompido: recibo e reserva de promoção coexistem em ${flowId}`);
    error.code = 'FLOW_STORE_CORRUPT';
    throw error;
  }
  if (hasPromotion && !hasReservation) {
    throw corruptArtifact('promoção sem reserva durável', flowId);
  }
  const attemptsDir = join(dir, 'attempts');
  const checkedAttempts = assertVaultPathSafe(vaultBase, attemptsDir, {
    expectedType: 'directory', label: 'raiz de tentativas FLOW',
  });
  const attempts = checkedAttempts.exists
    ? readdirSync(attemptsDir).filter((name) => name.endsWith('.json')).sort()
      .map((name) => {
        const attempt = readJson(vaultBase, join(attemptsDir, name), 'tentativa FLOW');
        assertAttempt(attempt, { flowId, attemptId: name.slice(0, -'.json'.length) });
        return attempt;
      })
    : [];
  if (hasReservation) {
    assertReservationMatchesFlow(vaultBase, reservationArtifact, contract, attempts, flowId);
  }
  if (hasPromotion) {
    assertPromotionMatchesReservation(promotionArtifact, reservationArtifact, flowId);
  }
  return {
    state: hasReceipt ? 'finished' : hasPromotion ? 'promoted' : hasReservation ? 'promoting' : 'active',
    contract,
    attempts,
    receipt: hasReceipt ? receiptArtifact : null,
    promotion: hasPromotion ? promotionArtifact : null,
    reservation: hasReservation ? reservationArtifact : null,
  };
}

export function listFlows(vaultBase, { sessionId = '' } = {}) {
  const root = runtimeRoot(vaultBase);
  const checkedRoot = assertVaultPathSafe(vaultBase, root, {
    expectedType: 'directory', label: 'raiz runtime de FLOW',
  });
  if (!checkedRoot.exists) return [];
  const sessions = sessionId ? [safeId(sessionId, 'session_id')] : readdirSync(root).sort();
  const result = [];
  for (const sid of sessions) {
    const dir = sessionRoot(vaultBase, sid);
    const checkedSession = assertVaultPathSafe(vaultBase, dir, {
      expectedType: 'directory', label: 'raiz runtime da sessão FLOW',
    });
    if (!checkedSession.exists) continue;
    for (const flowId of readdirSync(dir).sort()) {
      if (flowId.startsWith('.')) continue;
      const flow = readFlow(vaultBase, { sessionId: sid, flowId });
      if (flow) result.push(flow);
    }
  }
  return result;
}

export function findFlow(vaultBase, flowId, { sessionId = '' } = {}) {
  const matches = listFlows(vaultBase, { sessionId }).filter((flow) => flow.contract.flow_id === flowId);
  if (matches.length > 1) throw new Error(`flow_id ambíguo: ${flowId}`);
  return matches[0] || null;
}

export function findActiveFlow(vaultBase, sessionId) {
  const active = listFlows(vaultBase, { sessionId })
    .filter((flow) => flow.state === 'active' || flow.state === 'promoting');
  if (active.length > 1) {
    const error = new Error(`mais de um FLOW ativo para sessão ${sessionId}`);
    error.code = 'FLOW_STORE_CORRUPT';
    throw error;
  }
  return active[0] || null;
}

export function reserveFlowPromotion(vaultBase, sessionId, flowId, reservation) {
  assertPromotionReservation(vaultBase, reservation, flowId);
  return underSessionLock(vaultBase, sessionId, () => {
    const state = readFlow(vaultBase, { sessionId, flowId });
    if (!state) throw new Error(`FLOW não encontrado: ${flowId}`);
    if (state.state === 'finished') throw new Error(`FLOW já finalizado: ${flowId}`);
    if (state.state === 'promoted') throw new Error(`FLOW já promovido: ${flowId}`);
    try {
      assertReservationMatchesFlow(
        vaultBase,
        reservation,
        state.contract,
        undefined,
        flowId,
      );
    } catch (error) {
      if (error?.code === 'FLOW_STORE_CORRUPT') throw error;
      throw corruptArtifact('reserva incompatível com o contrato', flowId);
    }
    if (state.state === 'active'
      && canonicalText(reservation.origin.attempts) !== canonicalText(state.attempts)) {
      const error = new Error(`tentativas FLOW mudaram antes da reserva: ${flowId}`);
      error.code = 'FLOW_PROMOTION_STALE';
      throw error;
    }
    return immutableJson(
      vaultBase,
      join(flowDir(vaultBase, sessionId, flowId), 'promotion-reservation.json'),
      reservation,
    );
  });
}

export function appendFlowAttempt(vaultBase, sessionId, flowId, attempt) {
  const attemptId = safeId(attempt?.attempt_id, 'attempt_id');
  assertAttempt(attempt, { flowId, attemptId });
  return underSessionLock(vaultBase, sessionId, () => {
    const state = readFlow(vaultBase, { sessionId, flowId });
    if (!state) throw new Error(`FLOW não encontrado: ${flowId}`);
    if (state.state !== 'active') throw new Error(`FLOW já finalizado: ${flowId}`);
    const dir = join(flowDir(vaultBase, sessionId, flowId), 'attempts');
    mkdirVaultPath(vaultBase, dir, { label: 'raiz de tentativas FLOW' });
    return immutableJson(vaultBase, join(dir, `${attemptId}.json`), attempt);
  });
}

export function writeFlowReceipt(vaultBase, sessionId, flowId, receipt) {
  return underSessionLock(vaultBase, sessionId, () => {
    const state = readFlow(vaultBase, { sessionId, flowId });
    if (!state) throw new Error(`FLOW não encontrado: ${flowId}`);
    if (state.promotion) throw new Error(`FLOW já promovido: ${flowId}`);
    if (state.reservation) {
      const error = new Error(`FLOW em promoção: ${flowId}`);
      error.code = 'FLOW_TERMINAL';
      throw error;
    }
    assertTerminalArtifact(receipt, { flowId, status: 'finished', label: 'recibo' });
    assertReceiptMatchesContract(receipt, state.contract, flowId);
    return immutableJson(vaultBase, join(flowDir(vaultBase, sessionId, flowId), 'receipt.json'), receipt);
  });
}

export function writeFlowPromotion(vaultBase, sessionId, flowId, promotion) {
  return underSessionLock(vaultBase, sessionId, () => {
    const state = readFlow(vaultBase, { sessionId, flowId });
    if (!state) throw new Error(`FLOW não encontrado: ${flowId}`);
    if (state.receipt) throw new Error(`FLOW já finalizado: ${flowId}`);
    assertTerminalArtifact(promotion, { flowId, status: 'promoted', label: 'promoção' });
    if (!state.reservation) throw corruptArtifact('promoção sem reserva durável', flowId);
    assertPromotionMatchesReservation(promotion, state.reservation, flowId);
    return immutableJson(vaultBase, join(flowDir(vaultBase, sessionId, flowId), 'promotion.json'), promotion);
  });
}
