// Durable, local-only store for shared-memory events.
//
// Producers only create immutable outbox files. The projector is the sole ledger writer:
// it takes MEMORY.lock, durably appends events, deterministically replays the complete
// ledger, then atomically publishes SHARED_MEMORY.md and MEMORY_CANDIDATES.jsonl.
import { createHash } from 'node:crypto';
import {
  closeSync, constants as fsConstants, copyFileSync, fstatSync, fsyncSync, openSync,
  readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  parseSharedMemory,
  renderSharedMemory,
  sanitizeMemoryText,
  validateMemoryEvent,
} from './memory-schema.mjs';
import {
  effectiveMemoryScope,
  isRegisterMemoryKey,
  memoryRecordKey,
  sameMemoryScope,
} from './memory-scope.mjs';
import {
  assertVaultPathSafe, assertVaultPathsSafe, mkdirVaultPath, unlinkVaultFile,
  VAULT_LOCK_BUSY, withVaultPathLock, writeVaultFileAtomic,
} from './vault-path-safety.mjs';

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class MemoryEventCollision extends Error {
  constructor(eventId, message = `Memory event ID collision: ${eventId}`) {
    super(message);
    this.name = 'MemoryEventCollision';
    this.code = 'MEMORY_EVENT_COLLISION';
    this.eventId = eventId;
  }
}

export class MemoryLedgerCorruption extends Error {
  constructor(errors, message = 'Memory ledger is corrupt; run `wendkeep memory repair`.') {
    super(message);
    this.name = 'MemoryLedgerCorruption';
    this.code = 'MEMORY_LEDGER_CORRUPT';
    this.errors = Array.isArray(errors) ? errors : [];
  }
}

export class MemoryOutboxCorruption extends Error {
  constructor(path, cause) {
    super(`Memory outbox file is corrupt: ${path}`);
    this.name = 'MemoryOutboxCorruption';
    this.code = 'MEMORY_OUTBOX_CORRUPT';
    this.path = path;
    this.cause = cause;
  }
}

function brainDir(vaultBase) {
  return join(vaultBase, '.brain');
}

function outboxDir(vaultBase) {
  return join(brainDir(vaultBase), 'memory-outbox');
}

function ledgerPath(vaultBase) {
  return join(brainDir(vaultBase), 'MEMORY_EVENTS.jsonl');
}

function sharedPath(vaultBase) {
  return join(brainDir(vaultBase), 'SHARED_MEMORY.md');
}

function corePath(vaultBase) {
  return join(brainDir(vaultBase), 'CORE.md');
}

function candidatesPath(vaultBase) {
  return join(brainDir(vaultBase), 'MEMORY_CANDIDATES.jsonl');
}

function lockTarget(vaultBase) {
  return join(brainDir(vaultBase), 'MEMORY');
}

function unsafeMemoryPath(message) {
  const error = new Error(message);
  error.code = 'VAULT_PATH_UNSAFE';
  return error;
}

function checkedMemoryFile(vaultBase, path, label, {
  allowMissing = true,
  mustNotExist = false,
} = {}) {
  return assertVaultPathSafe(vaultBase, path, {
    allowMissing,
    expectedType: 'file',
    mustNotExist,
    label,
  });
}

function checkedMemoryDirectory(vaultBase, path, label, { allowMissing = true } = {}) {
  return assertVaultPathSafe(vaultBase, path, {
    allowMissing,
    expectedType: 'directory',
    label,
  });
}

function readCheckedMemoryFile(vaultBase, path, encoding, label, { allowMissing = false } = {}) {
  let checked = checkedMemoryFile(vaultBase, path, label, { allowMissing });
  if (!checked.exists) return null;
  // Deliberately adjacent to readFileSync: aliases created since the first policy check
  // are rejected before Node opens the artifact.
  checked = checkedMemoryFile(vaultBase, checked.target, label, { allowMissing: false });
  return readFileSync(checked.target, encoding);
}

export function memoryFileIdentityMatches(descriptor, target, {
  platform = process.platform,
} = {}) {
  if (descriptor.ino !== target.ino) return false;
  // libuv before 1.51 can report an inconsistent Windows volume serial number
  // between stat(path) and fstat(fd). The inode is still the file index; path
  // containment/reparse checks and nlink validation remain independent guards.
  return platform === 'win32' || descriptor.dev === target.dev;
}

function assertOpenedMemoryFile(vaultBase, path, fd, label) {
  const checked = checkedMemoryFile(vaultBase, path, label, { allowMissing: false });
  // Windows file identities can exceed Number's safe integer range. Node 22.13 may
  // round stat(path) and fstat(fd) differently for the same file, so compare the
  // exact bigint values and keep nlink as the independent hardlink guard.
  const descriptor = fstatSync(fd, { bigint: true });
  const target = statSync(checked.target, { bigint: true });
  if (!descriptor.isFile() || descriptor.nlink > 1n || target.nlink > 1n
      || !memoryFileIdentityMatches(descriptor, target)) {
    throw unsafeMemoryPath(`${label} mudou de inode ou possui hardlink antes da mutação: ${checked.target}`);
  }
  return checked.target;
}

function preflightProjectionTargets(vaultBase) {
  return assertVaultPathsSafe(vaultBase, [
    { path: sharedPath(vaultBase), expectedType: 'file', label: 'projeção SHARED_MEMORY.md' },
    { path: candidatesPath(vaultBase), expectedType: 'file', label: 'projeção MEMORY_CANDIDATES.jsonl' },
  ]);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

export function canonicalMemoryJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function hashMemoryValue(value) {
  return sha256(canonicalMemoryJson(value));
}

function sanitizeValue(value) {
  if (typeof value === 'string') return sanitizeMemoryText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item)]));
  }
  return value;
}

function sanitizeEvent(event) {
  return sanitizeValue(structuredClone(event));
}

function projectIdForVault(vaultBase) {
  const path = join(brainDir(vaultBase), 'PROJECT.json');
  const raw = readCheckedMemoryFile(vaultBase, path, 'utf8', 'autoridade PROJECT.json', {
    allowMissing: true,
  });
  if (raw === null) return undefined;
  try {
    const project = JSON.parse(raw);
    return typeof project.projectId === 'string' && project.projectId ? project.projectId : undefined;
  } catch {
    return undefined;
  }
}

function assertValidEvent(event, vaultBase) {
  const sanitized = sanitizeEvent(event);
  const projectId = vaultBase ? projectIdForVault(vaultBase) : undefined;
  const result = validateMemoryEvent(sanitized, projectId ? { projectId } : {});
  if (!result.ok) {
    const error = new TypeError(`Invalid memory event: ${result.errors.join(' ')}`);
    error.code = 'MEMORY_EVENT_INVALID';
    error.errors = result.errors;
    throw error;
  }
  if (!EVENT_ID.test(sanitized.event_id)) {
    const error = new TypeError('Invalid memory event: event_id is not filename-safe.');
    error.code = 'MEMORY_EVENT_INVALID';
    throw error;
  }
  return sanitized;
}

function eventHash(event) {
  return sha256(canonicalMemoryJson(event));
}

const OUTBOX_PUBLICATION_WAIT_MS = 500;
const OUTBOX_PUBLICATION_POLL_MS = 5;
const OUTBOX_PUBLICATION_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function readConcurrentOutboxEvent(vaultBase, path, eventId) {
  const deadline = Date.now() + OUTBOX_PUBLICATION_WAIT_MS;
  while (true) {
    let raw;
    try {
      raw = readCheckedMemoryFile(
        vaultBase, path, 'utf8', 'evento imutável preexistente do outbox',
      );
    } catch (cause) {
      if (cause?.code === 'VAULT_PATH_UNSAFE') throw cause;
      throw new MemoryEventCollision(eventId, `Existing outbox event is unreadable: ${eventId}`);
    }

    try {
      return JSON.parse(raw);
    } catch (cause) {
      if (!(cause instanceof SyntaxError) || Date.now() >= deadline) {
        throw new MemoryEventCollision(eventId, `Existing outbox event is unreadable: ${eventId}`);
      }
      Atomics.wait(OUTBOX_PUBLICATION_SIGNAL, 0, 0, OUTBOX_PUBLICATION_POLL_MS);
    }
  }
}

/**
 * Persist one immutable producer event using exclusive creation. A retry with the same
 * canonical payload is a no-op; reusing the ID for different bytes is an observable error.
 */
export function enqueueMemoryEvent(vaultBase, event) {
  const checked = assertValidEvent(event, vaultBase);
  const dir = outboxDir(vaultBase);
  mkdirVaultPath(vaultBase, dir, { label: 'outbox de memória' });
  const path = join(dir, `${checked.event_id}.json`);
  const payload = `${canonicalMemoryJson(checked)}\n`;
  const hash = eventHash(checked);

  let fd;
  try {
    checkedMemoryFile(vaultBase, path, 'evento imutável do outbox');
    // The final lstat is deliberately adjacent to the exclusive open. A pre-created
    // symlink/hardlink loses the wx race and is revalidated in the EEXIST branch.
    checkedMemoryFile(vaultBase, path, 'evento imutável do outbox');
    fd = openSync(path, 'wx');
    assertOpenedMemoryFile(vaultBase, path, fd, 'evento imutável do outbox');
    writeFileSync(fd, payload, 'utf8');
    fsyncSync(fd);
    assertOpenedMemoryFile(vaultBase, path, fd, 'evento imutável do outbox');
    return { status: 'enqueued', path, eventId: checked.event_id, hash };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readConcurrentOutboxEvent(vaultBase, path, checked.event_id);
    if (eventHash(existing) !== hash || canonicalMemoryJson(existing) !== canonicalMemoryJson(checked)) {
      throw new MemoryEventCollision(checked.event_id);
    }
    return { status: 'duplicate', path, eventId: checked.event_id, hash };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ledgerError(line, message, partial = false) {
  return { line, message, partial };
}

/** Read a ledger without hiding a valid prefix when its tail is corrupt or partial. */
export function readMemoryLedger(vaultBase) {
  const path = ledgerPath(vaultBase);
  const checked = checkedMemoryFile(vaultBase, path, 'ledger MEMORY_EVENTS.jsonl');
  if (!checked.exists) {
    return { status: 'ok', path, raw: '', events: [], eventIds: new Set(), errors: [] };
  }
  const raw = readCheckedMemoryFile(
    vaultBase, checked.target, 'utf8', 'ledger MEMORY_EVENTS.jsonl',
  ).replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  const hasPartialTail = raw.length > 0 && !raw.endsWith('\n');
  if (!hasPartialTail) lines.pop();
  const events = [];
  const eventIds = new Set();
  const eventPayloads = new Map();
  const errors = [];
  const projectId = projectIdForVault(vaultBase);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const partial = hasPartialTail && index === lines.length - 1;
    if (!line.trim()) {
      errors.push(ledgerError(lineNumber, 'blank ledger line', partial));
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      errors.push(ledgerError(lineNumber, `invalid JSON: ${error.message}`, partial));
      return;
    }
    const validation = validateMemoryEvent(parsed, projectId ? { projectId } : {});
    if (!validation.ok) {
      errors.push(ledgerError(lineNumber, validation.errors.join(' '), partial));
      return;
    }
    const payload = canonicalMemoryJson(parsed);
    if (eventIds.has(parsed.event_id)) {
      if (eventPayloads.get(parsed.event_id) !== payload) {
        errors.push(ledgerError(lineNumber, `event_id collision: ${parsed.event_id}`, partial));
      } else {
        errors.push(ledgerError(lineNumber, `duplicate event_id: ${parsed.event_id}`, partial));
      }
      return;
    }
    eventIds.add(parsed.event_id);
    eventPayloads.set(parsed.event_id, payload);
    events.push(parsed);
  });

  return {
    status: errors.length ? 'corrupt' : 'ok',
    path,
    raw,
    events,
    eventIds,
    errors,
  };
}

function eventOrder(left, right) {
  return (Number(left.base_revision ?? 0) - Number(right.base_revision ?? 0))
    || String(left.effective_at || left.observed_at).localeCompare(String(right.effective_at || right.observed_at))
    || Number(left.turn_sequence ?? 0) - Number(right.turn_sequence ?? 0)
    || String(left.event_id).localeCompare(String(right.event_id));
}

function sameCausalActivation(left, right) {
  return Boolean(left?.canonical_session_id)
    && left.canonical_session_id === right?.canonical_session_id
    && left.activation_id === right?.activation_id;
}

function hasCompleteCausalIdentity(event) {
  return Boolean(event?.canonical_session_id)
    && Boolean(event?.activation_id)
    && Boolean(event?.source_turn_id)
    && Number.isInteger(event?.activation_epoch)
    && Number.isInteger(event?.turn_sequence);
}

function sameCompleteCausalLineage(left, right) {
  return hasCompleteCausalIdentity(left)
    && hasCompleteCausalIdentity(right)
    && left.canonical_session_id === right.canonical_session_id
    && left.activation_id === right.activation_id
    && left.activation_epoch === right.activation_epoch;
}

function comparable(left, right) {
  if (left?.project_id !== right?.project_id || !sameMemoryScope(left, right)) return false;
  if (sameCausalActivation(left, right)) return true;
  const leftSupersedes = left.supersedes_event_id || left.supersedes;
  const rightSupersedes = right.supersedes_event_id || right.supersedes;
  return leftSupersedes === right.event_id || rightSupersedes === left.event_id
    || (Array.isArray(leftSupersedes) && leftSupersedes.includes(right.event_id))
    || (Array.isArray(rightSupersedes) && rightSupersedes.includes(left.event_id));
}

function conflictGroupKey(event) {
  if (event.operation !== 'replace') return null;
  if (!Number.isInteger(event.base_revision) || typeof event.base_value_hash !== 'string') return null;
  return `${memoryRecordKey(event)}\u0000${event.base_revision}\u0000${event.base_value_hash}`;
}

function candidateId(reason, memoryKey, eventIds) {
  return `memcand-${sha256(`${reason}\u0000${memoryKey}\u0000${eventIds.join('\u0000')}`).slice(0, 16)}`;
}

// CORE is prose, not an operational data store. Only an explicit, single-line marker
// participates in precedence so the projector never guesses meaning from human text:
//   <!-- wk-memory: release.push="manual-only" -->
function readCoreInvariants(vaultBase) {
  const core = readCheckedMemoryFile(
    vaultBase, corePath(vaultBase), 'utf8', 'autoridade CORE.md', { allowMissing: true },
  );
  if (core === null) return new Map();
  const invariants = new Map();
  const marker = /^<!--\s*wk-memory:\s*([A-Za-z0-9][A-Za-z0-9._-]*)=(.+)\s*-->$/;
  for (const line of core.split('\n')) {
    const match = line.trim().match(marker);
    if (!match) continue;
    try {
      invariants.set(match[1], JSON.parse(match[2].trim()));
    } catch { /* malformed prose markers do not become implicit authority */ }
  }
  return invariants;
}

function blockedByCoreCandidate(event, coreValue) {
  return {
    v: 1,
    candidate_id: candidateId('blocked_by_core', event.memory_key, [event.event_id]),
    reason: 'blocked_by_core',
    status: 'blocked_by_core',
    memory_key: event.memory_key,
    ...(event.scope ? { scope: effectiveMemoryScope(event), record_key: memoryRecordKey(event) } : {}),
    event_ids: [event.event_id],
    proposed_value: event.value,
    core_value: coreValue,
    provenance: {
      authority: 'core',
      source: '.brain/CORE.md',
      core_value_hash: hashMemoryValue(coreValue),
    },
    events: [event],
  };
}

function conflictCandidate(memoryKey, events, currentEvent = null) {
  const ordered = [...events].sort(eventOrder);
  const eventIds = ordered.map((item) => item.event_id).sort();
  const byId = new Map(ordered.map((item) => [item.event_id, item]));
  return {
    v: 1,
    candidate_id: candidateId('conflict', memoryKey, eventIds),
    reason: 'conflict',
    memory_key: memoryKey,
    ...((ordered[0] || currentEvent)?.scope ? {
      scope: effectiveMemoryScope(ordered[0] || currentEvent || {}),
      record_key: memoryRecordKey(ordered[0] || currentEvent || { memory_key: memoryKey }),
    } : {}),
    event_ids: eventIds,
    values: eventIds.map((id) => byId.get(id).value),
    base_revision: ordered[0]?.base_revision ?? currentEvent?.revision ?? 0,
    base_value_hash: ordered[0]?.base_value_hash ?? (currentEvent ? hashMemoryValue(currentEvent.value) : null),
    events: eventIds.map((id) => byId.get(id)),
  };
}

function conflictReviewEvent(candidate, candidateCount = 1) {
  const source = candidate.events?.[0] || {};
  const memoryKey = sanitizeMemoryText(candidate.memory_key || 'unknown');
  const eventCount = Array.isArray(candidate.event_ids) ? candidate.event_ids.length : 0;
  return {
    v: 1,
    event_id: `mem-review-${candidate.candidate_id}`,
    project_id: source.project_id || '',
    memory_key: candidate.memory_key,
    scope: candidate.scope,
    operation: 'assert',
    value: `[revisão pendente: ${memoryKey}; candidates: ${candidateCount}; events: ${eventCount}]`,
    authority: 'candidate',
    canonical_session_id: source.canonical_session_id || 'memory-reducer',
    activation_id: source.activation_id || 'memory-reducer',
    activation_epoch: Number.isInteger(source.activation_epoch) ? source.activation_epoch : 0,
    turn_sequence: 0,
    source_turn_id: 'memory-review',
    observed_at: source.observed_at || new Date(0).toISOString(),
    evidence: ['MEMORY_CANDIDATES.jsonl'],
    review_pending: true,
  };
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function currentEventFromRecord(record) {
  if (!record) return null;
  return { ...record.source, value: record.value, revision: record.revision };
}

function supersededTransitively(superseded, sourceEventId, finalEventId) {
  if (!sourceEventId || !finalEventId || sourceEventId === finalEventId) return false;
  const edges = new Map();
  for (const item of superseded) {
    if (!edges.has(item.event_id)) edges.set(item.event_id, []);
    edges.get(item.event_id).push(item.by_event_id);
  }
  const pending = [sourceEventId];
  const visited = new Set();
  while (pending.length) {
    const current = pending.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of edges.get(current) || []) {
      if (next === finalEventId) return true;
      if (!visited.has(next)) pending.push(next);
    }
  }
  return false;
}

function isCausallyOlder(event, current) {
  if (!current) return false;
  if (sameCausalActivation(event, current)) {
    return Number(event.turn_sequence) < Number(current.turn_sequence);
  }
  if (event.canonical_session_id && event.canonical_session_id === current.canonical_session_id
      && sameMemoryScope(event, current)
      && Number.isInteger(event.activation_epoch) && Number.isInteger(current.activation_epoch)
      && event.activation_epoch !== current.activation_epoch) {
    return event.activation_epoch < current.activation_epoch;
  }
  const eventEffective = Date.parse(event.effective_at || '');
  const currentEffective = Date.parse(current.effective_at || '');
  return Number.isFinite(eventEffective) && Number.isFinite(currentEffective)
    && eventEffective < currentEffective;
}

const AUTHORITY_RANK = Object.freeze({ candidate: 0, reported: 1, verified: 2 });

function sameRegisterLineage(left, right) {
  return Boolean(left?.canonical_session_id)
    && left.canonical_session_id === right?.canonical_session_id
    && left.project_id === right?.project_id
    && sameMemoryScope(left, right);
}

/** Positive means `incoming` is a safe successor; null means human comparison is required. */
function registerPrecedence(incoming, current) {
  if (!incoming?.scope || !current?.scope
      || !isRegisterMemoryKey(incoming?.memory_key) || !sameRegisterLineage(incoming, current)) return null;
  const epoch = Number(incoming.activation_epoch ?? -1) - Number(current.activation_epoch ?? -1);
  if (epoch) return epoch;
  const turn = Number(incoming.turn_sequence ?? -1) - Number(current.turn_sequence ?? -1);
  if (turn) return turn;
  const authority = (AUTHORITY_RANK[incoming.authority] ?? -1) - (AUTHORITY_RANK[current.authority] ?? -1);
  if (authority) return authority;
  const observed = String(incoming.observed_at || '').localeCompare(String(current.observed_at || ''));
  if (observed) return observed;
  return String(incoming.event_id || '').localeCompare(String(current.event_id || ''));
}

/**
 * Pure deterministic reducer. It pre-detects incomparable scalar siblings so replay order
 * never turns one concurrent writer into an accidental winner.
 */
export function reduceMemoryEvents(inputEvents = [], {
  coreInvariants = new Map(), resolveDeferredAsserts = true,
} = {}) {
  const protectedValues = coreInvariants instanceof Map
    ? coreInvariants
    : new Map(Object.entries(coreInvariants || {}));
  const unique = new Map();
  for (const raw of inputEvents) {
    const event = assertValidEvent(raw);
    const existing = unique.get(event.event_id);
    if (existing && canonicalMemoryJson(existing) !== canonicalMemoryJson(event)) {
      throw new MemoryEventCollision(event.event_id, `Ledger contains divergent payloads for ${event.event_id}`);
    }
    if (!existing) unique.set(event.event_id, event);
  }
  const rescopeTargets = new Set(
    [...unique.values()].flatMap((item) => [
      item.rescopes_event_id,
      ...(Array.isArray(item.rescopes_event_ids) ? item.rescopes_event_ids : []),
    ]).filter(Boolean),
  );
  const projectIds = new Set([...unique.values()].map((item) => item.project_id).filter(Boolean));
  if (projectIds.size > 1) {
    const error = new TypeError('Memory reducer cannot compare events from different projects.');
    error.code = 'MEMORY_PROJECT_MIXED';
    throw error;
  }
  const events = [...unique.values()]
    .filter((item) => !rescopeTargets.has(item.event_id))
    .sort(eventOrder);
  const candidateDecisions = new Map();
  for (const item of events) {
    const decision = item.candidate_decision;
    if (!decision) continue;
    const existing = candidateDecisions.get(decision.candidate_id);
    if (existing && canonicalMemoryJson(existing.decision) !== canonicalMemoryJson(decision)) {
      throw new MemoryEventCollision(
        decision.candidate_id,
        `Ledger contains incompatible decisions for candidate ${decision.candidate_id}`,
      );
    }
    if (!existing) candidateDecisions.set(decision.candidate_id, { decision, event: item });
  }

  const peerGroups = new Map();
  for (const item of events) {
    const key = conflictGroupKey(item);
    if (!key) continue;
    if (!peerGroups.has(key)) peerGroups.set(key, []);
    peerGroups.get(key).push(item);
  }
  const conflictingIds = new Set();
  const groupedCandidates = new Map();
  for (const [key, group] of peerGroups) {
    const incomparable = group.filter((item, index) => group.some((other, otherIndex) => index !== otherIndex && !comparable(item, other)));
    if (incomparable.length < 2) continue;
    const ordered = [...incomparable].sort(eventOrder);
    ordered.forEach((item) => conflictingIds.add(item.event_id));
    groupedCandidates.set(key, ordered);
  }

  const records = new Map();
  const tombstones = new Map();
  const candidates = [];
  const pendingAssertConflicts = [];
  const resolvedCandidateIds = new Set();
  const emittedGroups = new Set();
  const appliedEventIds = [];
  const superseded = [];
  let revision = 0;

  for (const item of events) {
    if (item.candidate_decision && item.candidate_decision.action === 'reject') {
      appliedEventIds.push(item.event_id);
      continue;
    }

    if (protectedValues.has(item.memory_key)) {
      const coreValue = protectedValues.get(item.memory_key);
      const agreesWithCore = item.operation === 'assert'
        && hashMemoryValue(item.value) === hashMemoryValue(coreValue);
      if (!agreesWithCore) {
        candidates.push(blockedByCoreCandidate(item, coreValue));
        continue;
      }
    }

    const groupKey = conflictGroupKey(item);
    if (conflictingIds.has(item.event_id)) {
      if (!emittedGroups.has(groupKey)) {
        candidates.push(conflictCandidate(item.memory_key, groupedCandidates.get(groupKey)));
        emittedGroups.add(groupKey);
      }
      continue;
    }

    const recordKey = memoryRecordKey(item);
    const current = records.get(recordKey);
    const currentSource = current?.source;
    if (isCausallyOlder(item, currentSource)) {
      superseded.push({ event_id: item.event_id, by_event_id: currentSource.event_id });
      continue;
    }

    if (item.operation === 'assert') {
      if (current && hashMemoryValue(current.value) !== hashMemoryValue(item.value)) {
        const precedence = registerPrecedence(item, currentSource);
        if ((sameCausalActivation(item, currentSource)
              && Number(item.turn_sequence) > Number(currentSource.turn_sequence))
            || precedence > 0) {
          records.set(recordKey, { value: item.value, revision: current.revision + 1, source: item });
          tombstones.delete(recordKey);
          superseded.push({ event_id: currentSource.event_id, by_event_id: item.event_id });
          revision += 1;
          appliedEventIds.push(item.event_id);
          continue;
        }
        const candidate = conflictCandidate(item.memory_key, [currentEventFromRecord(current), item]);
        candidates.push(candidate);
        pendingAssertConflicts.push({ candidate, event: item });
        continue;
      }
      if (!current) {
        records.set(recordKey, { value: item.value, revision: 1, source: item });
        tombstones.delete(recordKey);
        revision += 1;
      }
      appliedEventIds.push(item.event_id);
      continue;
    }

    if (item.operation === 'add') {
      const oldValues = Array.isArray(current?.value) ? current.value : (current ? [current.value] : []);
      const additions = Array.isArray(item.value) ? item.value : [item.value];
      const byHash = new Map(oldValues.map((value) => [hashMemoryValue(value), value]));
      additions.forEach((value) => byHash.set(hashMemoryValue(value), value));
      const value = [...byHash.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, entry]) => entry);
      records.set(recordKey, { value, revision: (current?.revision || 0) + 1, source: item });
      tombstones.delete(recordKey);
      revision += 1;
      appliedEventIds.push(item.event_id);
      continue;
    }

    if (item.operation === 'remove') {
      if (!current) {
        appliedEventIds.push(item.event_id);
        continue;
      }
      const baseMatches = item.base_revision === undefined
        || (item.base_revision === current.revision
          && (!item.base_value_hash || item.base_value_hash === hashMemoryValue(current.value)));
      if (!baseMatches) {
        candidates.push(conflictCandidate(item.memory_key, [currentEventFromRecord(current), item]));
        continue;
      }
      if (item.value !== null && item.value !== undefined && Array.isArray(current.value)) {
        const removalHash = hashMemoryValue(item.value);
        const value = current.value.filter((entry) => hashMemoryValue(entry) !== removalHash);
        records.set(recordKey, { value, revision: current.revision + 1, source: item });
        tombstones.set(`${recordKey}:${removalHash}`, {
          event_id: item.event_id, removed_event_id: current.source.event_id, value_hash: removalHash,
        });
      } else {
        records.delete(recordKey);
        tombstones.set(recordKey, {
          event_id: item.event_id,
          removed_event_id: current.source.event_id,
          value_hash: hashMemoryValue(current.value),
        });
      }
      revision += 1;
      appliedEventIds.push(item.event_id);
      continue;
    }

    // replace
    const explicitlySupersedes = item.supersedes_event_id === currentSource?.event_id
      || (Array.isArray(item.supersedes) && item.supersedes.includes(currentSource?.event_id));
    const baseMatches = current
      && item.base_revision === current.revision
      && item.base_value_hash === hashMemoryValue(current.value);
    if (!current || (!baseMatches && !explicitlySupersedes)) {
      candidates.push(conflictCandidate(item.memory_key, current ? [currentEventFromRecord(current), item] : [item]));
      continue;
    }
    records.set(recordKey, { value: item.value, revision: current.revision + 1, source: item });
    tombstones.delete(recordKey);
    const explicitlySupersededIds = new Set(
      Array.isArray(item.supersedes)
        ? item.supersedes
        : (item.supersedes_event_id ? [item.supersedes_event_id] : []),
    );
    if (item.candidate_decision?.action === 'promote' && explicitlySupersededIds.size) {
      for (const candidate of candidates) {
        if (candidate.reason !== 'conflict' || !candidate.event_ids?.length) continue;
        if (candidate.event_ids.every((eventId) => explicitlySupersededIds.has(eventId))) {
          resolvedCandidateIds.add(candidate.candidate_id);
        }
      }
      for (const pending of pendingAssertConflicts) {
        if (explicitlySupersededIds.has(pending.event.event_id)) {
          resolvedCandidateIds.add(pending.candidate.candidate_id);
        }
      }
    }
    revision += 1;
    appliedEventIds.push(item.event_id);
  }

  if (resolveDeferredAsserts) {
    // A physically late assert can sort before a corrective promotion because effective time
    // precedes CLI decision time. Revisit only scalar assert conflicts left without an explicit
    // decision, against the final complete causal source; the ledger and global ordering stay put.
    const deferredAsserts = pendingAssertConflicts
      .filter((pending) => !candidateDecisions.has(pending.candidate.candidate_id))
      .sort((left, right) => String(left.event.memory_key).localeCompare(String(right.event.memory_key))
        || String(left.event.canonical_session_id || '').localeCompare(String(right.event.canonical_session_id || ''))
        || String(left.event.activation_id || '').localeCompare(String(right.event.activation_id || ''))
        || Number(left.event.activation_epoch ?? -1) - Number(right.event.activation_epoch ?? -1)
        || Number(left.event.turn_sequence ?? -1) - Number(right.event.turn_sequence ?? -1)
        || eventOrder(left.event, right.event));
    let advanced = true;
    while (advanced) {
      advanced = false;
      for (const pending of deferredAsserts) {
        if (resolvedCandidateIds.has(pending.candidate.candidate_id)) continue;
        const current = records.get(memoryRecordKey(pending.event));
        const currentSource = current?.source;
        if (!sameCompleteCausalLineage(pending.event, currentSource)) continue;
        if (pending.event.turn_sequence > currentSource.turn_sequence) {
          records.set(memoryRecordKey(pending.event), {
            value: pending.event.value,
            revision: current.revision + 1,
            source: pending.event,
          });
          tombstones.delete(memoryRecordKey(pending.event));
          superseded.push({ event_id: currentSource.event_id, by_event_id: pending.event.event_id });
          revision += 1;
          appliedEventIds.push(pending.event.event_id);
          resolvedCandidateIds.add(pending.candidate.candidate_id);
          advanced = true;
        } else if (pending.event.turn_sequence < currentSource.turn_sequence) {
          superseded.push({ event_id: pending.event.event_id, by_event_id: currentSource.event_id });
          resolvedCandidateIds.add(pending.candidate.candidate_id);
        }
      }
    }
  }

  const pendingByCandidateId = new Map(
    pendingAssertConflicts.map((pending) => [pending.candidate.candidate_id, pending]),
  );
  const reanchoredCandidates = candidates
    .map((candidate) => {
      const pending = pendingByCandidateId.get(candidate.candidate_id);
      if (!pending) return candidate;
      const finalSource = currentEventFromRecord(records.get(candidate.record_key || candidate.memory_key));
      const previousSource = candidate.events?.find(
        (event) => event.event_id !== pending.event.event_id,
      );
      if (!finalSource || !previousSource || finalSource.event_id === previousSource.event_id) {
        return candidate;
      }
      if (!sameCompleteCausalLineage(previousSource, finalSource)
          || !supersededTransitively(superseded, previousSource.event_id, finalSource.event_id)) {
        return candidate;
      }
      if (hashMemoryValue(finalSource.value) === hashMemoryValue(pending.event.value)) return null;
      return conflictCandidate(candidate.memory_key, [finalSource, pending.event], finalSource);
    })
    .filter(Boolean);

  const stateEntries = [...records].map(([key, record]) => [key, record.value]);
  const recordEntries = [...records].map(([key, record]) => [key, record]);
  const tombstoneEntries = [...tombstones];
  const state = sortedObject(stateEntries);
  const recordObject = sortedObject(recordEntries);
  const tombstoneObject = sortedObject(tombstoneEntries);
  const unresolvedCandidates = reanchoredCandidates
    .filter((item) => !candidateDecisions.has(item.candidate_id)
      && !resolvedCandidateIds.has(item.candidate_id));
  unresolvedCandidates.sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));
  superseded.sort((left, right) => left.event_id.localeCompare(right.event_id));
  const eventCursor = events.at(-1)?.event_id || 'none';
  const stateHash = hashMemoryValue({ state, tombstones: tombstoneObject });
  const ambiguousRecordKeys = new Set(
    unresolvedCandidates.map((candidate) => candidate.record_key || candidate.memory_key),
  );
  const activeEvents = [
    ...Object.entries(recordObject)
      .filter(([recordKey]) => !ambiguousRecordKeys.has(recordKey))
      .map(([recordKey, record]) => ({
      ...record.source,
      memory_key: record.source.memory_key,
      projection_key: recordKey,
      operation: 'assert',
      value: record.value,
    })),
    ...unresolvedCandidates.map((candidate) => (
      conflictReviewEvent(candidate, unresolvedCandidates.length)
    )),
  ];

  return {
    state,
    records: recordObject,
    candidates: unresolvedCandidates,
    tombstones: tombstoneObject,
    superseded,
    appliedEventIds,
    eventIds: events.map((item) => item.event_id),
    activeEvents,
    revision,
    eventCursor,
    stateHash,
  };
}

/**
 * Re-derive one ledger projection using the explicit invariants declared by CORE.
 * `eventCursor` is the reducer's deterministic causal cursor; `ledgerCursor` is the
 * physical prefix boundary used by durable checkpoints.
 */
export function deriveMemoryProjection(vaultBase, inputEvents = [], {
  resolveDeferredAsserts = true,
} = {}) {
  const reduced = reduceMemoryEvents(inputEvents, {
    coreInvariants: readCoreInvariants(vaultBase), resolveDeferredAsserts,
  });
  const ledgerCursor = inputEvents.at(-1)?.event_id || 'none';
  const checkpoint = {
    revision: reduced.revision,
    event_cursor: ledgerCursor,
    state_hash: reduced.stateHash,
  };
  if (reduced.eventCursor !== ledgerCursor) {
    checkpoint.causal_event_cursor = reduced.eventCursor;
  }
  return {
    ...reduced,
    ledgerCursor,
    checkpoint,
  };
}

function readOutbox(vaultBase) {
  const dir = outboxDir(vaultBase);
  let checkedDir = checkedMemoryDirectory(vaultBase, dir, 'outbox de memória');
  if (!checkedDir.exists) return [];
  checkedDir = checkedMemoryDirectory(vaultBase, checkedDir.target, 'outbox de memória', {
    allowMissing: false,
  });
  const entries = readdirSync(checkedDir.target, { withFileTypes: true });
  for (const entry of entries) {
    assertVaultPathSafe(vaultBase, join(checkedDir.target, entry.name), {
      allowMissing: false,
      label: `entrada ${entry.name} do outbox de memória`,
    });
  }
  return entries
    .filter((entry) => entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const path = join(checkedDir.target, entry.name);
      try {
        const event = assertValidEvent(JSON.parse(readCheckedMemoryFile(
          vaultBase, path, 'utf8', `evento ${entry.name} do outbox de memória`,
        )), vaultBase);
        if (`${event.event_id}.json` !== entry.name) throw new Error('filename does not match event_id');
        return { event, path };
      } catch (error) {
        if (error?.code === 'VAULT_PATH_UNSAFE') throw error;
        throw new MemoryOutboxCorruption(path, error);
      }
    });
}

function countPendingOutbox(vaultBase) {
  const dir = outboxDir(vaultBase);
  let checked = checkedMemoryDirectory(vaultBase, dir, 'outbox de memória');
  if (!checked.exists) return 0;
  checked = checkedMemoryDirectory(vaultBase, checked.target, 'outbox de memória', {
    allowMissing: false,
  });
  return readdirSync(checked.target, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.json'))
    .map((entry) => {
      assertVaultPathSafe(vaultBase, join(checked.target, entry.name), {
        allowMissing: false,
        label: `entrada ${entry.name} do outbox de memória`,
      });
      return entry;
    }).length;
}

function appendLedgerDurably(vaultBase, path, events) {
  if (!events.length) return;
  let fd;
  try {
    let checked = checkedMemoryFile(vaultBase, path, 'ledger MEMORY_EVENTS.jsonl');
    checked = checkedMemoryFile(vaultBase, checked.target, 'ledger MEMORY_EVENTS.jsonl');
    fd = openSync(checked.target, 'a');
    assertOpenedMemoryFile(vaultBase, checked.target, fd, 'ledger MEMORY_EVENTS.jsonl');
    const payload = events.map((item) => canonicalMemoryJson(item)).join('\n') + '\n';
    writeFileSync(fd, payload, 'utf8');
    fsyncSync(fd);
    assertOpenedMemoryFile(vaultBase, checked.target, fd, 'ledger MEMORY_EVENTS.jsonl');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeAtomicIfChanged(vaultBase, path, content, label) {
  const checked = checkedMemoryFile(vaultBase, path, label);
  if (checked.exists) {
    try {
      if (readCheckedMemoryFile(vaultBase, checked.target, 'utf8', label) === content) return false;
    } catch (error) {
      if (error?.code === 'VAULT_PATH_UNSAFE') throw error;
      // A contained but unreadable projection may be atomically replaced.
    }
  }
  writeVaultFileAtomic(vaultBase, checked.target, content, 'utf8', { label });
  return true;
}

function injectFault(faultAt, boundary) {
  if (faultAt === boundary) throw new Error(`Injected memory-store fault: ${boundary}`);
}

/** Build every derived byte from an immutable authority snapshot without publishing it. */
export function prepareMemoryProjection(vaultBase, allEvents) {
  const reduced = deriveMemoryProjection(vaultBase, allEvents);
  const updatedAt = allEvents
    .map((item) => item.observed_at)
    .filter(Boolean)
    .sort()
    .at(-1);
  const shared = renderSharedMemory({
    revision: reduced.revision,
    eventCursor: reduced.ledgerCursor,
    events: reduced.activeEvents,
    stateHash: reduced.stateHash,
    updatedAt,
  });
  const sharedMetadata = parseSharedMemory(shared).metadata;
  const candidates = reduced.candidates.map((item) => canonicalMemoryJson(item)).join('\n')
    + (reduced.candidates.length ? '\n' : '');
  return {
    sharedContent: shared,
    candidatesContent: candidates,
    revision: reduced.revision,
    eventCursor: reduced.eventCursor,
    ledgerCursor: reduced.ledgerCursor,
    stateHash: reduced.stateHash,
    checkpoint: reduced.checkpoint,
    candidates: reduced.candidates.length,
    projectedEvents: sharedMetadata.projected_events ?? reduced.activeEvents.length,
    omittedEvents: sharedMetadata.omitted_events ?? 0,
  };
}

/** Publish a projection prepared from the same locked authority snapshot. */
export function publishMemoryProjection(vaultBase, prepared) {
  const {
    sharedContent, candidatesContent, ...projection
  } = prepared;
  // Validate the complete publication set before the first rename: a bad candidates
  // alias cannot leave SHARED partially advanced (and vice versa).
  preflightProjectionTargets(vaultBase);
  const sharedWritten = writeAtomicIfChanged(
    vaultBase, sharedPath(vaultBase), sharedContent, 'projeção SHARED_MEMORY.md',
  );
  const candidatesWritten = writeAtomicIfChanged(
    vaultBase, candidatesPath(vaultBase), candidatesContent, 'projeção MEMORY_CANDIDATES.jsonl',
  );
  return { ...projection, projectionsWritten: sharedWritten || candidatesWritten };
}

function publishDerivedProjection(vaultBase, allEvents) {
  return publishMemoryProjection(vaultBase, prepareMemoryProjection(vaultBase, allEvents));
}

// Reconciliation needs to validate proof, perform registry CAS, and publish the exact
// prepared bytes inside one MEMORY critical section. This primitive deliberately does
// not create `.brain`: callers must complete their read-only Vault preflight first.
export const MEMORY_LOCK_BUSY = VAULT_LOCK_BUSY;
export function withMemoryLock(vaultBase, fn, options = {}) {
  return withVaultPathLock(vaultBase, lockTarget(vaultBase), fn, options);
}

function projectLocked(vaultBase, { faultAt } = {}) {
  const ledger = readMemoryLedger(vaultBase);
  if (ledger.status !== 'ok') throw new MemoryLedgerCorruption(ledger.errors);
  const outbox = readOutbox(vaultBase);
  const ledgerById = new Map(ledger.events.map((item) => [item.event_id, item]));
  const newEvents = [];

  for (const { event: item } of outbox) {
    const existing = ledgerById.get(item.event_id);
    if (existing) {
      if (canonicalMemoryJson(existing) !== canonicalMemoryJson(item)) throw new MemoryEventCollision(item.event_id);
      continue;
    }
    ledgerById.set(item.event_id, item);
    newEvents.push(item);
  }

  const allEvents = [...ledger.events, ...newEvents];
  const prepared = prepareMemoryProjection(vaultBase, allEvents);
  // CORE and both sidecars are checked before the append, so an unsafe derived target
  // cannot partially advance the authoritative ledger.
  preflightProjectionTargets(vaultBase);
  appendLedgerDurably(vaultBase, ledger.path, newEvents);
  injectFault(faultAt, 'after-ledger');

  const projection = publishMemoryProjection(vaultBase, prepared);
  injectFault(faultAt, 'after-projection');

  const consumedEventIds = [];
  for (const entry of outbox) {
    unlinkVaultFile(vaultBase, entry.path, {
      missingOk: false, label: 'evento consumido do outbox de memória',
    });
    consumedEventIds.push(entry.event.event_id);
  }
  return {
    status: 'projected',
    appended: newEvents.length,
    consumed: outbox.length,
    consumedEventIds,
    pending: 0,
    ...projection,
  };
}

/** Serialize ledger append + full deterministic replay under .brain/MEMORY.lock. */
export function projectMemoryOutbox(vaultBase, options = {}) {
  mkdirVaultPath(vaultBase, brainDir(vaultBase), { label: 'raiz .brain da memória' });
  const pending = countPendingOutbox(vaultBase);
  const result = withVaultPathLock(
    vaultBase,
    lockTarget(vaultBase),
    () => projectLocked(vaultBase, options),
    options.lock || {},
  );
  if (result === VAULT_LOCK_BUSY) return { status: 'busy', pending };
  return result;
}

/**
 * Rebuild generated projections from the existing ledger only. This path never
 * enumerates, reads, acknowledges, or consumes producer outbox files.
 */
export function reprojectMemoryLedger(vaultBase, options = {}) {
  mkdirVaultPath(vaultBase, brainDir(vaultBase), { label: 'raiz .brain da memória' });
  const result = withVaultPathLock(vaultBase, lockTarget(vaultBase), () => {
    const ledger = readMemoryLedger(vaultBase);
    if (ledger.status !== 'ok') throw new MemoryLedgerCorruption(ledger.errors);
    return {
      status: 'reprojected',
      ...publishDerivedProjection(vaultBase, ledger.events),
    };
  }, options.lock || {});
  if (result === VAULT_LOCK_BUSY) return { status: 'busy' };
  return result;
}

/** Explicit repair: preserve exact corrupt bytes, then retain every independently valid line. */
export function repairMemoryLedger(vaultBase, options = {}) {
  mkdirVaultPath(vaultBase, brainDir(vaultBase), { label: 'raiz .brain da memória' });
  const result = withVaultPathLock(vaultBase, lockTarget(vaultBase), () => {
    const ledger = readMemoryLedger(vaultBase);
    if (ledger.status === 'ok') return { status: 'unchanged', repairedLines: 0, backupPath: null };
    const backupPath = `${ledger.path}.corrupt-${Date.now()}.bak`;
    // copyFileSync preserves the exact evidence before any canonical rewrite.
    checkedMemoryFile(vaultBase, ledger.path, 'ledger corrompido', { allowMissing: false });
    checkedMemoryFile(vaultBase, backupPath, 'backup do ledger corrompido', { mustNotExist: true });
    // Revalidate immediately before the exclusive copy, then verify the created inode.
    checkedMemoryFile(vaultBase, ledger.path, 'ledger corrompido', { allowMissing: false });
    checkedMemoryFile(vaultBase, backupPath, 'backup do ledger corrompido', { mustNotExist: true });
    copyFileSync(ledger.path, backupPath, fsConstants.COPYFILE_EXCL);
    checkedMemoryFile(vaultBase, backupPath, 'backup do ledger corrompido', { allowMissing: false });
    const repaired = ledger.events.map((item) => canonicalMemoryJson(item)).join('\n')
      + (ledger.events.length ? '\n' : '');
    writeVaultFileAtomic(vaultBase, ledger.path, repaired, 'utf8', { label: 'ledger reparado' });
    return {
      status: 'repaired',
      repairedLines: ledger.errors.length,
      retainedEvents: ledger.events.length,
      backupPath,
    };
  }, options.lock || {});
  if (result === VAULT_LOCK_BUSY) return { status: 'busy', repairedLines: 0, backupPath: null };
  return result;
}
