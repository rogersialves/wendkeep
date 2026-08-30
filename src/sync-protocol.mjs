import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OPERATIONS = new Set(['put', 'tombstone', 'resolve']);
const ID_PATTERN = /^[A-Za-z0-9._:@/-]{1,512}$/;

function syncError(code, message) {
  return Object.assign(new Error(message), { code });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function canonicalSyncJson(value) {
  return JSON.stringify(stable(value));
}

export function syncSha256(value) {
  return `sha256:${createHash('sha256').update(
    typeof value === 'string' ? value : canonicalSyncJson(value), 'utf8',
  ).digest('hex')}`;
}

function requiredText(value, field, maximum = 512) {
  const text = String(value || '').trim();
  if (!text || text.length > maximum || /[\0\r\n]/.test(text)) {
    throw syncError('WENDKEEP_SYNC_SCHEMA_INVALID', `${field} is invalid`);
  }
  return text;
}

function encode(value) {
  return encodeURIComponent(requiredText(value, 'record key component', 512));
}

export function canonicalRecordKey({
  projectId, repositoryId, namespace, key, branch = '', worktreeId = '', scope = 'worktree',
} = {}) {
  const project = encode(projectId);
  const repository = encode(repositoryId);
  const category = encode(namespace);
  const name = encode(key);
  if (!['project', 'branch', 'worktree'].includes(scope)) {
    throw syncError('WENDKEEP_SYNC_SCOPE_INVALID', `unknown record scope: ${scope}`);
  }
  const branchPart = scope === 'project' ? '-' : encode(branch || '-');
  const worktreePart = scope === 'worktree' ? encode(worktreeId || '-') : '-';
  return `v1|p=${project}|r=${repository}|s=${scope}|b=${branchPart}|w=${worktreePart}|n=${category}|k=${name}`;
}

export function createSyncState(projectId) {
  return {
    schema_version: 1,
    project_id: requiredText(projectId, 'project_id', 160),
    records: {},
    conflicts: {},
    pending: {},
    leases: {},
    decisions: [],
    applied_event_ids: [],
  };
}

function validatePrivatePayload(payload) {
  if (!payload || payload.schema_version !== 1 || payload.algorithm !== 'AES-256-GCM'
    || !payload.key_id || !payload.iv || !payload.ciphertext || !payload.auth_tag) {
    throw syncError('WENDKEEP_SYNC_PRIVATE_PLAINTEXT', 'private records require an E2E envelope');
  }
}

function normalizePolicyRef(value) {
  if (value == null) return null;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'hash,policy_id,version'
    || !HASH_PATTERN.test(String(value.hash || ''))
    || !Number.isSafeInteger(Number(value.version)) || Number(value.version) < 1) {
    throw syncError('WENDKEEP_SYNC_POLICY_REF_INVALID', 'policy_ref must contain only policy_id, version and sha256 hash');
  }
  return {
    policy_id: requiredText(value.policy_id, 'policy_ref.policy_id', 160),
    version: Number(value.version),
    hash: String(value.hash),
  };
}

export function createSyncEvent({
  projectId, recordKey, revision, baseRevision, payload = null, causalParentIds = [],
  actorId, deviceId, leaseId = '', observedAt, operation = 'put', privacy = 'shared',
  policyRef = null,
} = {}) {
  const project_id = requiredText(projectId, 'project_id', 160);
  const record_key = requiredText(recordKey, 'record_key', 2048);
  const actor_id = requiredText(actorId, 'actor_id', 160);
  const device_id = requiredText(deviceId, 'device_id', 160);
  const revisionNumber = Number(revision);
  const baseNumber = Number(baseRevision);
  if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1
    || !Number.isSafeInteger(baseNumber) || baseNumber < 0
    || revisionNumber !== baseNumber + 1) {
    throw syncError('WENDKEEP_SYNC_REVISION_INVALID', 'revision must equal base_revision + 1');
  }
  if (!OPERATIONS.has(operation)) throw syncError('WENDKEEP_SYNC_OPERATION_INVALID', `invalid operation: ${operation}`);
  if (!['shared', 'private'].includes(privacy)) throw syncError('WENDKEEP_SYNC_PRIVACY_INVALID', 'invalid privacy policy');
  if (privacy === 'private') validatePrivatePayload(payload);
  const timestamp = new Date(observedAt);
  if (Number.isNaN(timestamp.getTime())) throw syncError('WENDKEEP_SYNC_TIME_INVALID', 'observed_at is invalid');
  const parents = [...new Set(causalParentIds.map((item) => requiredText(item, 'causal_parent_id', 128)))].sort();
  const draft = {
    schema_version: 1,
    project_id,
    record_key,
    revision: revisionNumber,
    base_revision: baseNumber,
    content_hash: syncSha256(operation === 'tombstone' ? null : payload),
    causal_parent_ids: parents,
    actor_id,
    device_id,
    lease_id: String(leaseId || ''),
    observed_at: timestamp.toISOString(),
    operation,
    privacy,
    ...(policyRef ? { policy_ref: normalizePolicyRef(policyRef) } : {}),
    payload: operation === 'tombstone' ? null : structuredClone(payload),
  };
  return { ...draft, event_id: syncSha256(draft).slice(7) };
}

export function validateSyncEvent(event, { projectId = '' } = {}) {
  if (!event || event.schema_version !== 1 || typeof event !== 'object'
    || !ID_PATTERN.test(String(event.event_id || '')) || !HASH_PATTERN.test(String(event.content_hash || ''))
    || event.event_id !== syncSha256(Object.fromEntries(
      Object.entries(event).filter(([key]) => key !== 'event_id'),
    )).slice(7)) {
    throw syncError('WENDKEEP_SYNC_EVENT_INVALID', 'event integrity validation failed');
  }
  if (projectId && event.project_id !== projectId) {
    throw syncError('WENDKEEP_SYNC_PROJECT_MISMATCH', 'event belongs to another project');
  }
  createSyncEvent({
    projectId: event.project_id,
    recordKey: event.record_key,
    revision: event.revision,
    baseRevision: event.base_revision,
    payload: event.payload,
    causalParentIds: event.causal_parent_ids,
    actorId: event.actor_id,
    deviceId: event.device_id,
    leaseId: event.lease_id,
    observedAt: event.observed_at,
    operation: event.operation,
    privacy: event.privacy,
    policyRef: event.policy_ref || null,
  });
  return event;
}

function eventCandidate(event) {
  return {
    event_id: event.event_id,
    revision: event.revision,
    base_revision: event.base_revision,
    content_hash: event.content_hash,
    causal_parent_ids: [...event.causal_parent_ids],
    actor_id: event.actor_id,
    device_id: event.device_id,
    observed_at: event.observed_at,
    operation: event.operation,
    privacy: event.privacy,
    ...(event.policy_ref ? { policy_ref: structuredClone(event.policy_ref) } : {}),
    payload: structuredClone(event.payload),
  };
}

function recordFromEvent(event, { conflicted = false } = {}) {
  return {
    revision: event.revision,
    content_hash: event.content_hash,
    event_id: event.event_id,
    causal_parent_ids: [...event.causal_parent_ids],
    actor_id: event.actor_id,
    device_id: event.device_id,
    observed_at: event.observed_at,
    operation: event.operation,
    privacy: event.privacy,
    ...(event.policy_ref ? { policy_ref: structuredClone(event.policy_ref) } : {}),
    payload: structuredClone(event.payload),
    tombstone: event.operation === 'tombstone',
    conflicted,
    event: eventCandidate(event),
  };
}

function rememberApplied(state, eventId) {
  if (!state.applied_event_ids.includes(eventId)) state.applied_event_ids.push(eventId);
  state.applied_event_ids.sort();
}

function addPending(state, event) {
  const rows = state.pending[event.record_key] || [];
  if (!rows.some((item) => item.event_id === event.event_id)) rows.push(structuredClone(event));
  rows.sort((left, right) => left.revision - right.revision || left.event_id.localeCompare(right.event_id));
  state.pending[event.record_key] = rows;
}

function conflict(state, current, incoming) {
  const key = incoming.record_key;
  const prior = state.conflicts[key]?.candidates || [];
  const candidates = new Map(prior.map((item) => [item.event_id, item]));
  if (current?.event) candidates.set(current.event.event_id, structuredClone(current.event));
  candidates.set(incoming.event_id, eventCandidate(incoming));
  state.conflicts[key] = {
    schema_version: 1,
    record_key: key,
    status: 'open',
    candidates: [...candidates.values()].sort((left, right) => left.event_id.localeCompare(right.event_id)),
  };
  if (current) current.conflicted = true;
  rememberApplied(state, incoming.event_id);
  return { status: 'conflict', event_id: incoming.event_id, record_key: key };
}

function replayPending(state, recordKey) {
  const replayed = [];
  let progress = true;
  while (progress) {
    progress = false;
    const rows = state.pending[recordKey] || [];
    const currentRevision = state.records[recordKey]?.revision || 0;
    const ready = rows.filter((event) => event.base_revision <= currentRevision);
    if (!ready.length) break;
    for (const event of ready) {
      state.pending[recordKey] = (state.pending[recordKey] || []).filter((item) => item.event_id !== event.event_id);
      const outcome = applySyncEvent(state, event, { replay: true });
      if (outcome.status === 'applied') replayed.push(event.event_id);
      progress = true;
    }
  }
  if (!(state.pending[recordKey] || []).length) delete state.pending[recordKey];
  return replayed;
}

export function applySyncEvent(state, event, { replay = false } = {}) {
  validateSyncEvent(event, { projectId: state?.project_id });
  if (state.applied_event_ids.includes(event.event_id)) {
    return { status: 'duplicate', event_id: event.event_id, record_key: event.record_key };
  }
  if ((state.pending[event.record_key] || []).some((item) => item.event_id === event.event_id) && !replay) {
    return { status: 'pending', event_id: event.event_id, record_key: event.record_key };
  }
  const current = state.records[event.record_key] || null;
  const currentRevision = current?.revision || 0;
  if (state.conflicts[event.record_key]?.status === 'open') return conflict(state, current, event);
  if (event.base_revision > currentRevision) {
    addPending(state, event);
    return { status: 'pending', event_id: event.event_id, record_key: event.record_key };
  }
  if (event.base_revision < currentRevision) return conflict(state, current, event);
  if (event.causal_parent_ids.length && current && !event.causal_parent_ids.includes(current.event_id)) {
    return conflict(state, current, event);
  }
  state.records[event.record_key] = recordFromEvent(event);
  rememberApplied(state, event.event_id);
  const replayed = replayPending(state, event.record_key);
  return { status: 'applied', event_id: event.event_id, record_key: event.record_key, replayed };
}

export function resolveSyncConflict(state, {
  recordKey, selectedEventId, actorId, deviceId, reason, observedAt = new Date().toISOString(),
} = {}) {
  const key = requiredText(recordKey, 'record_key', 2048);
  const set = state.conflicts[key];
  if (!set || set.status !== 'open') throw syncError('WENDKEEP_SYNC_CONFLICT_NOT_FOUND', 'open conflict not found');
  const selected = set.candidates.find((item) => item.event_id === selectedEventId);
  if (!selected) throw syncError('WENDKEEP_SYNC_CONFLICT_SELECTION_INVALID', 'candidate is not in the conflict set');
  const decisionReason = requiredText(reason, 'reason', 500);
  const revision = Math.max(...set.candidates.map((item) => item.revision)) + 1;
  const resolution = createSyncEvent({
    projectId: state.project_id,
    recordKey: key,
    revision,
    baseRevision: revision - 1,
    payload: selected.payload,
    causalParentIds: set.candidates.map((item) => item.event_id),
    actorId,
    deviceId,
    observedAt,
    operation: selected.operation === 'tombstone' ? 'tombstone' : 'resolve',
    privacy: selected.privacy,
  });
  state.records[key] = recordFromEvent(resolution);
  rememberApplied(state, resolution.event_id);
  set.status = 'resolved';
  set.resolution_event_id = resolution.event_id;
  set.selected_event_id = selectedEventId;
  const decision = {
    schema_version: 1, record_key: key, selected_event_id: selectedEventId,
    resolution_event_id: resolution.event_id, actor_id: requiredText(actorId, 'actor_id', 160),
    device_id: requiredText(deviceId, 'device_id', 160), reason: decisionReason,
    observed_at: new Date(observedAt).toISOString(),
  };
  state.decisions.push(decision);
  return { status: 'resolved', event: resolution, decision };
}

export function acquireSyncLease(state, {
  recordKey, leaseId, actorId, deviceId, acquiredAt, expiresAt, now = new Date().toISOString(),
} = {}) {
  const key = requiredText(recordKey, 'record_key', 2048);
  const acquiredTime = new Date(acquiredAt);
  const expiresTime = new Date(expiresAt);
  const serverTime = new Date(now);
  if ([acquiredTime, expiresTime, serverTime].some((value) => Number.isNaN(value.getTime()))
    || expiresTime.getTime() <= acquiredTime.getTime()) {
    throw syncError('WENDKEEP_SYNC_LEASE_INVALID', 'lease timestamps are invalid');
  }
  const lease = {
    lease_id: requiredText(leaseId, 'lease_id', 160),
    actor_id: requiredText(actorId, 'actor_id', 160),
    device_id: requiredText(deviceId, 'device_id', 160),
    acquired_at: acquiredTime.toISOString(),
    expires_at: expiresTime.toISOString(),
  };
  const existing = state.leases[key];
  if (existing?.active && Date.parse(existing.active.expires_at) > serverTime.getTime()) {
    if (existing.active.lease_id === lease.lease_id) return { status: 'existing', lease: existing.active };
    throw syncError('WENDKEEP_SYNC_LEASE_HELD', 'record has an unexpired lease');
  }
  const history = [...(existing?.history || [])];
  if (existing?.active) history.push({ ...existing.active, ended_as: 'expired' });
  state.leases[key] = { schema_version: 1, active: lease, history };
  return { status: existing?.active ? 'taken_over' : 'acquired', lease };
}

function keyBytes(value) {
  let bytes;
  try { bytes = Buffer.from(requiredText(value, 'encryption key', 256), 'base64'); }
  catch { throw syncError('WENDKEEP_SYNC_KEY_INVALID', 'key must be base64'); }
  if (bytes.length !== 32) throw syncError('WENDKEEP_SYNC_KEY_INVALID', 'key must decode to 32 bytes');
  return bytes;
}

export function encryptPrivatePayload(payload, {
  key, keyId, aad = '', iv = randomBytes(12),
} = {}) {
  const keyBuffer = keyBytes(key);
  const ivBuffer = Buffer.from(iv);
  if (ivBuffer.length !== 12) throw syncError('WENDKEEP_SYNC_KEY_INVALID', 'AES-GCM IV must be 12 bytes');
  const cipher = createCipheriv('aes-256-gcm', keyBuffer, ivBuffer);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const encrypted = Buffer.concat([cipher.update(canonicalSyncJson(payload), 'utf8'), cipher.final()]);
  return {
    schema_version: 1,
    algorithm: 'AES-256-GCM',
    key_id: requiredText(keyId, 'key_id', 160),
    iv: ivBuffer.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    auth_tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptPrivatePayload(envelope, { key, aad = '' } = {}) {
  try {
    validatePrivatePayload(envelope);
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.auth_tag, 'base64'));
    const bytes = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error?.code === 'WENDKEEP_SYNC_KEY_INVALID') throw error;
    throw syncError('WENDKEEP_SYNC_DECRYPT_FAILED', 'private payload authentication failed');
  }
}

export function rotatePrivatePayloadKey(envelope, {
  oldKey, newKey, newKeyId, aad = '', iv = randomBytes(12),
} = {}) {
  const payload = decryptPrivatePayload(envelope, { key: oldKey, aad });
  return encryptPrivatePayload(payload, { key: newKey, keyId: newKeyId, aad, iv });
}
