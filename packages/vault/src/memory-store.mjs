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
  renderSharedMemory,
  sanitizeMemoryText,
  validateMemoryEvent,
} from './memory-schema.mjs';
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

function assertOpenedMemoryFile(vaultBase, path, fd, label) {
  const checked = checkedMemoryFile(vaultBase, path, label, { allowMissing: false });
  const descriptor = fstatSync(fd);
  const target = statSync(checked.target);
  if (!descriptor.isFile() || descriptor.nlink > 1 || target.nlink > 1
      || descriptor.dev !== target.dev || descriptor.ino !== target.ino) {
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

function comparable(left, right) {
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
  return `${event.memory_key}\u0000${event.base_revision}\u0000${event.base_value_hash}`;
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
    event_ids: eventIds,
    values: eventIds.map((id) => byId.get(id).value),
    base_revision: ordered[0]?.base_revision ?? currentEvent?.revision ?? 0,
    base_value_hash: ordered[0]?.base_value_hash ?? (currentEvent ? hashMemoryValue(currentEvent.value) : null),
    events: eventIds.map((id) => byId.get(id)),
  };
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function currentEventFromRecord(record) {
  if (!record) return null;
  return { ...record.source, value: record.value, revision: record.revision };
}

function isCausallyOlder(event, current) {
  if (!current) return false;
  if (sameCausalActivation(event, current)) {
    return Number(event.turn_sequence) < Number(current.turn_sequence);
  }
  if (Number.isInteger(event.activation_epoch) && Number.isInteger(current.activation_epoch)
      && event.activation_epoch !== current.activation_epoch) {
    return event.activation_epoch < current.activation_epoch;
  }
  const eventEffective = Date.parse(event.effective_at || '');
  const currentEffective = Date.parse(current.effective_at || '');
  return Number.isFinite(eventEffective) && Number.isFinite(currentEffective)
    && eventEffective < currentEffective;
}

/**
 * Pure deterministic reducer. It pre-detects incomparable scalar siblings so replay order
 * never turns one concurrent writer into an accidental winner.
 */
export function reduceMemoryEvents(inputEvents = [], { coreInvariants = new Map() } = {}) {
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
  const events = [...unique.values()].sort(eventOrder);
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

    const current = records.get(item.memory_key);
    const currentSource = current?.source;
    if (isCausallyOlder(item, currentSource)) {
      superseded.push({ event_id: item.event_id, by_event_id: currentSource.event_id });
      continue;
    }

    if (item.operation === 'assert') {
      if (current && hashMemoryValue(current.value) !== hashMemoryValue(item.value)) {
        if (sameCausalActivation(item, currentSource)
            && Number(item.turn_sequence) > Number(currentSource.turn_sequence)) {
          records.set(item.memory_key, { value: item.value, revision: current.revision + 1, source: item });
          tombstones.delete(item.memory_key);
          superseded.push({ event_id: currentSource.event_id, by_event_id: item.event_id });
          revision += 1;
          appliedEventIds.push(item.event_id);
          continue;
        }
        candidates.push(conflictCandidate(item.memory_key, [currentEventFromRecord(current), item]));
        continue;
      }
      if (!current) {
        records.set(item.memory_key, { value: item.value, revision: 1, source: item });
        tombstones.delete(item.memory_key);
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
      records.set(item.memory_key, { value, revision: (current?.revision || 0) + 1, source: item });
      tombstones.delete(item.memory_key);
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
        records.set(item.memory_key, { value, revision: current.revision + 1, source: item });
        tombstones.set(`${item.memory_key}:${removalHash}`, {
          event_id: item.event_id, removed_event_id: current.source.event_id, value_hash: removalHash,
        });
      } else {
        records.delete(item.memory_key);
        tombstones.set(item.memory_key, {
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
    records.set(item.memory_key, { value: item.value, revision: current.revision + 1, source: item });
    tombstones.delete(item.memory_key);
    revision += 1;
    appliedEventIds.push(item.event_id);
  }

  const stateEntries = [...records].map(([key, record]) => [key, record.value]);
  const recordEntries = [...records].map(([key, record]) => [key, record]);
  const tombstoneEntries = [...tombstones];
  const state = sortedObject(stateEntries);
  const recordObject = sortedObject(recordEntries);
  const tombstoneObject = sortedObject(tombstoneEntries);
  const unresolvedCandidates = candidates
    .filter((item) => !candidateDecisions.has(item.candidate_id));
  unresolvedCandidates.sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));
  superseded.sort((left, right) => left.event_id.localeCompare(right.event_id));
  const activeEvents = Object.entries(recordObject).map(([memoryKey, record]) => ({
    ...record.source,
    memory_key: memoryKey,
    operation: 'assert',
    value: record.value,
  }));
  const eventCursor = events.at(-1)?.event_id || 'none';
  const stateHash = hashMemoryValue({ state, tombstones: tombstoneObject });

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
export function deriveMemoryProjection(vaultBase, inputEvents = []) {
  const reduced = reduceMemoryEvents(inputEvents, { coreInvariants: readCoreInvariants(vaultBase) });
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

  for (const entry of outbox) {
    unlinkVaultFile(vaultBase, entry.path, {
      missingOk: false, label: 'evento consumido do outbox de memória',
    });
  }
  return {
    status: 'projected',
    appended: newEvents.length,
    consumed: outbox.length,
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
