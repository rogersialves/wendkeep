import { createHash } from 'node:crypto';
import {
  closeSync, fstatSync, fsyncSync, openSync, readFileSync, readSync, readdirSync,
  statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  MEMORY_LOCK_BUSY,
  MemoryEventCollision,
  MemoryLedgerCorruption,
  MemoryOutboxCorruption,
  canonicalMemoryJson,
  deriveMemoryProjection,
  hashMemoryValue,
  memoryFileIdentityMatches,
  publishMemoryProjection,
  readMemoryLedger,
  withMemoryLock,
} from './memory-store.mjs';
import {
  parseSharedMemory,
  renderSharedMemory,
  validateMemoryEvent,
} from './memory-schema.mjs';
import {
  isRegisterMemoryKey,
  memoryRecordKey,
  sameMemoryScope,
} from './memory-scope.mjs';
import {
  assertVaultPathSafe,
  assertVaultPathsSafe,
  mkdirVaultPath,
  unlinkVaultFile,
  writeVaultFileAtomic,
} from './vault-path-safety.mjs';

export const MEMORY_SNAPSHOT_FILE = 'MEMORY_SNAPSHOT.json';
export const MEMORY_SNAPSHOT_SCHEMA_VERSION = 1;
export const MEMORY_SNAPSHOT_REDUCER_VERSION = 1;

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SNAPSHOT_BLOOM_BYTES = 512 * 1024;
const SNAPSHOT_BLOOM_HASHES = 7;
const SNAPSHOT_ADVANCE_EVENTS = 128;
const SNAPSHOT_ADVANCE_BYTES = 1024 * 1024;
const SNAPSHOT_MAX_TAIL_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const CHAIN_GENESIS = '0'.repeat(64);

function brainDir(vaultBase) { return join(vaultBase, '.brain'); }
function outboxDir(vaultBase) { return join(brainDir(vaultBase), 'memory-outbox'); }
function ledgerPath(vaultBase) { return join(brainDir(vaultBase), 'MEMORY_EVENTS.jsonl'); }
function sharedPath(vaultBase) { return join(brainDir(vaultBase), 'SHARED_MEMORY.md'); }
function candidatesPath(vaultBase) { return join(brainDir(vaultBase), 'MEMORY_CANDIDATES.jsonl'); }
function snapshotPath(vaultBase) { return join(brainDir(vaultBase), MEMORY_SNAPSHOT_FILE); }
function corePath(vaultBase) { return join(brainDir(vaultBase), 'CORE.md'); }
function projectPath(vaultBase) { return join(brainDir(vaultBase), 'PROJECT.json'); }

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

function canonicalSnapshotJson(value) {
  return JSON.stringify(canonicalize(value));
}

function snapshotHash(snapshot) {
  const { snapshot_hash: _ignored, ...unsigned } = snapshot || {};
  return sha256(canonicalSnapshotJson(unsigned));
}

function checkedFile(vaultBase, path, label, { allowMissing = true } = {}) {
  return assertVaultPathSafe(vaultBase, path, {
    allowMissing,
    expectedType: 'file',
    label,
  });
}

function checkedDirectory(vaultBase, path, label, { allowMissing = true } = {}) {
  return assertVaultPathSafe(vaultBase, path, {
    allowMissing,
    expectedType: 'directory',
    label,
  });
}

function readCheckedFile(vaultBase, path, encoding, label, { allowMissing = false } = {}) {
  let checked = checkedFile(vaultBase, path, label, { allowMissing });
  if (!checked.exists) return null;
  checked = checkedFile(vaultBase, checked.target, label, { allowMissing: false });
  return readFileSync(checked.target, encoding);
}

function projectIdForVault(vaultBase) {
  const raw = readCheckedFile(
    vaultBase, projectPath(vaultBase), 'utf8', 'autoridade PROJECT.json do snapshot de memória',
    { allowMissing: true },
  );
  if (raw === null) return '';
  try {
    const project = JSON.parse(raw);
    return typeof project.projectId === 'string' ? project.projectId : '';
  } catch {
    return '';
  }
}

function projectIdForEvents(events, fallback = '') {
  const values = new Set(events.map((event) => event?.project_id).filter(Boolean));
  return values.size === 1 ? [...values][0] : fallback;
}

function readCoreAuthority(vaultBase) {
  const raw = readCheckedFile(
    vaultBase, corePath(vaultBase), 'utf8', 'autoridade CORE.md do snapshot de memória',
    { allowMissing: true },
  ) ?? '';
  const invariants = new Map();
  const marker = /^<!--\s*wk-memory:\s*([A-Za-z0-9][A-Za-z0-9._-]*)=(.+)\s*-->$/;
  for (const line of raw.split('\n')) {
    const match = line.trim().match(marker);
    if (!match) continue;
    try { invariants.set(match[1], JSON.parse(match[2].trim())); } catch { /* prose only */ }
  }
  return { raw, hash: sha256(raw), invariants };
}

function assertOpenedFile(vaultBase, path, fd, label) {
  const checked = checkedFile(vaultBase, path, label, { allowMissing: false });
  const descriptor = fstatSync(fd, { bigint: true });
  const target = statSync(checked.target, { bigint: true });
  if (!descriptor.isFile() || descriptor.nlink > 1n || target.nlink > 1n
      || !memoryFileIdentityMatches(descriptor, target)) {
    const error = new Error(`${label} mudou de inode ou possui hardlink antes da leitura/mutação.`);
    error.code = 'VAULT_PATH_UNSAFE';
    throw error;
  }
  return checked.target;
}

function readRange(fd, offset, length) {
  const buffer = Buffer.alloc(length);
  let cursor = 0;
  while (cursor < length) {
    const count = readSync(fd, buffer, cursor, length - cursor, offset + cursor);
    if (count === 0) break;
    cursor += count;
  }
  return cursor === length ? buffer : buffer.subarray(0, cursor);
}

function eventOrderTuple(event = {}) {
  return {
    base_revision: Number(event.base_revision ?? 0),
    effective_at: String(event.effective_at || event.observed_at || ''),
    turn_sequence: Number(event.turn_sequence ?? 0),
    event_id: String(event.event_id || ''),
  };
}

function compareOrderTuple(left, right) {
  return Number(left.base_revision ?? 0) - Number(right.base_revision ?? 0)
    || String(left.effective_at || '').localeCompare(String(right.effective_at || ''))
    || Number(left.turn_sequence ?? 0) - Number(right.turn_sequence ?? 0)
    || String(left.event_id || '').localeCompare(String(right.event_id || ''));
}

function maximumOrder(events) {
  if (!events.length) return eventOrderTuple();
  return events.map(eventOrderTuple).sort(compareOrderTuple).at(-1);
}

function chainStep(previous, event) {
  return sha256(`${previous}\u0000${canonicalMemoryJson(event)}`);
}

function chainForEvents(events, initial = CHAIN_GENESIS) {
  return events.reduce((chain, event) => chainStep(chain, event), initial);
}

function bloomIndexes(eventId, byteLength = SNAPSHOT_BLOOM_BYTES) {
  const digest = createHash('sha256').update(String(eventId)).digest();
  const bits = BigInt(byteLength * 8);
  const first = digest.readBigUInt64BE(0);
  const second = digest.readBigUInt64BE(8) | 1n;
  return Array.from({ length: SNAPSHOT_BLOOM_HASHES }, (_, index) => (
    Number((first + BigInt(index) * second + BigInt(index * index)) % bits)
  ));
}

function bloomAdd(buffer, eventId) {
  for (const index of bloomIndexes(eventId, buffer.length)) {
    buffer[Math.floor(index / 8)] |= 1 << (index % 8);
  }
}

function bloomMayContain(buffer, eventId) {
  return bloomIndexes(eventId, buffer.length).every((index) => (
    (buffer[Math.floor(index / 8)] & (1 << (index % 8))) !== 0
  ));
}

function bloomForEvents(events) {
  const bloom = Buffer.alloc(SNAPSHOT_BLOOM_BYTES);
  for (const event of events) bloomAdd(bloom, event.event_id);
  return bloom;
}

function validPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function stateFromRecords(records) {
  return sortedObject(Object.entries(records).map(([key, record]) => [key, record.value]));
}

function stateHashFor(records, tombstones) {
  return hashMemoryValue({
    state: stateFromRecords(records),
    tombstones: sortedObject(Object.entries(tombstones)),
  });
}

function validSnapshotRecord(record, key, projectId) {
  if (!validPlainObject(record) || !Number.isInteger(record.revision) || record.revision < 1
      || !Object.hasOwn(record, 'value') || !validPlainObject(record.source)) return false;
  const validation = validateMemoryEvent(record.source, projectId ? { projectId } : {});
  return validation.ok && memoryRecordKey(record.source) === key;
}

function decodeBloom(snapshot) {
  if (!validPlainObject(snapshot.bloom)
      || snapshot.bloom.bytes !== SNAPSHOT_BLOOM_BYTES
      || snapshot.bloom.hashes !== SNAPSHOT_BLOOM_HASHES
      || typeof snapshot.bloom.data !== 'string') return null;
  try {
    const buffer = Buffer.from(snapshot.bloom.data, 'base64');
    return buffer.length === SNAPSHOT_BLOOM_BYTES ? buffer : null;
  } catch {
    return null;
  }
}

function validateSnapshot(snapshot, { projectId, coreHash } = {}) {
  if (!validPlainObject(snapshot)
      || snapshot.schema_version !== MEMORY_SNAPSHOT_SCHEMA_VERSION
      || snapshot.reducer_version !== MEMORY_SNAPSHOT_REDUCER_VERSION
      || typeof snapshot.project_id !== 'string'
      || (projectId && snapshot.project_id !== projectId)
      || snapshot.core_hash !== coreHash
      || !Number.isInteger(snapshot.event_count) || snapshot.event_count < 0
      || !Number.isInteger(snapshot.ledger_bytes) || snapshot.ledger_bytes < 0
      || !Number.isInteger(snapshot.through_line_start) || snapshot.through_line_start < 0
      || !Number.isInteger(snapshot.through_line_length) || snapshot.through_line_length < 0
      || typeof snapshot.through_event_id !== 'string'
      || !SHA256.test(String(snapshot.through_line_hash || ''))
      || !SHA256.test(String(snapshot.chain_hash || ''))
      || !SHA256.test(String(snapshot.snapshot_hash || ''))
      || snapshot.snapshot_hash !== snapshotHash(snapshot)
      || !validPlainObject(snapshot.order_cursor)
      || !validPlainObject(snapshot.projection)
      || !validPlainObject(snapshot.projection.records)
      || !validPlainObject(snapshot.projection.tombstones)
      || !Number.isInteger(snapshot.projection.revision) || snapshot.projection.revision < 0
      || !SHA256.test(String(snapshot.projection.state_hash || ''))
      || typeof snapshot.projection.event_cursor !== 'string'
      || typeof snapshot.projection.updated_at !== 'string') {
    return { ok: false, reason: 'snapshot-schema' };
  }
  if (snapshot.event_count === 0) {
    if (snapshot.ledger_bytes !== 0 || snapshot.through_event_id !== 'none'
        || snapshot.through_line_start !== 0 || snapshot.through_line_length !== 0) {
      return { ok: false, reason: 'snapshot-empty-boundary' };
    }
  } else if (!EVENT_ID.test(snapshot.through_event_id) || snapshot.through_line_length === 0) {
    return { ok: false, reason: 'snapshot-boundary' };
  }
  for (const [key, record] of Object.entries(snapshot.projection.records)) {
    if (!validSnapshotRecord(record, key, snapshot.project_id || projectId)) {
      return { ok: false, reason: 'snapshot-record' };
    }
  }
  if (stateHashFor(snapshot.projection.records, snapshot.projection.tombstones)
      !== snapshot.projection.state_hash) {
    return { ok: false, reason: 'snapshot-state-hash' };
  }
  const bloom = decodeBloom(snapshot);
  return bloom ? { ok: true, bloom } : { ok: false, reason: 'snapshot-bloom' };
}

function readSnapshotDocument(vaultBase, coreHash, projectId) {
  let raw;
  try {
    raw = readCheckedFile(
      vaultBase, snapshotPath(vaultBase), 'utf8', 'snapshot incremental de memória',
      { allowMissing: true },
    );
  } catch (error) {
    if (error?.code === 'VAULT_PATH_UNSAFE') throw error;
    return { status: 'invalid', reason: 'snapshot-unreadable' };
  }
  if (raw === null) return { status: 'missing', reason: 'snapshot-missing' };
  let snapshot;
  try { snapshot = JSON.parse(raw); } catch { return { status: 'invalid', reason: 'snapshot-json' }; }
  const validation = validateSnapshot(snapshot, { projectId, coreHash });
  return validation.ok
    ? { status: 'ok', snapshot, bloom: validation.bloom }
    : { status: 'invalid', reason: validation.reason };
}

function parseLedgerEvent(line, projectId) {
  const parsed = JSON.parse(line);
  const validation = validateMemoryEvent(parsed, projectId ? { projectId } : {});
  if (!validation.ok || !EVENT_ID.test(String(parsed.event_id || ''))) {
    const error = new Error(validation.errors?.join(' ') || 'event_id inválido');
    error.code = 'MEMORY_EVENT_INVALID';
    throw error;
  }
  return parsed;
}

function readSnapshotTail(vaultBase, snapshot, projectId) {
  const path = ledgerPath(vaultBase);
  let checked = checkedFile(vaultBase, path, 'ledger MEMORY_EVENTS.jsonl do snapshot', {
    allowMissing: snapshot.ledger_bytes === 0,
  });
  if (!checked.exists) {
    return snapshot.ledger_bytes === 0
      ? { status: 'ok', path, events: [], bytes: 0, size: 0 }
      : { status: 'invalid', reason: 'ledger-missing' };
  }
  checked = checkedFile(vaultBase, checked.target, 'ledger MEMORY_EVENTS.jsonl do snapshot', {
    allowMissing: false,
  });
  let fd;
  try {
    fd = openSync(checked.target, 'r');
    assertOpenedFile(vaultBase, checked.target, fd, 'ledger MEMORY_EVENTS.jsonl do snapshot');
    const stat = fstatSync(fd);
    if (stat.size < snapshot.ledger_bytes) return { status: 'invalid', reason: 'ledger-truncated' };
    if (snapshot.event_count > 0) {
      if (snapshot.through_line_start + snapshot.through_line_length + 1 !== snapshot.ledger_bytes) {
        return { status: 'invalid', reason: 'snapshot-offset' };
      }
      const boundary = readRange(fd, snapshot.through_line_start, snapshot.through_line_length + 1);
      if (boundary.length !== snapshot.through_line_length + 1
          || boundary.at(-1) !== 0x0a
          || sha256(boundary.subarray(0, -1)) !== snapshot.through_line_hash) {
        return { status: 'invalid', reason: 'ledger-boundary-hash' };
      }
      try {
        const event = parseLedgerEvent(
          boundary.subarray(0, -1).toString('utf8'), projectId || snapshot.project_id,
        );
        if (event.event_id !== snapshot.through_event_id) {
          return { status: 'invalid', reason: 'ledger-boundary-event' };
        }
      } catch {
        return { status: 'invalid', reason: 'ledger-boundary-event' };
      }
    }
    const tailBytes = stat.size - snapshot.ledger_bytes;
    if (tailBytes > SNAPSHOT_MAX_TAIL_BYTES) return { status: 'invalid', reason: 'tail-too-large' };
    if (tailBytes === 0) {
      return { status: 'ok', path: checked.target, events: [], bytes: 0, size: stat.size };
    }
    const tail = readRange(fd, snapshot.ledger_bytes, tailBytes);
    if (tail.length !== tailBytes || tail.at(-1) !== 0x0a) {
      return { status: 'corrupt', reason: 'tail-partial' };
    }
    const lines = tail.toString('utf8').split('\n');
    lines.pop();
    const events = [];
    const ids = new Set();
    try {
      for (const line of lines) {
        if (!line.trim()) return { status: 'corrupt', reason: 'tail-blank-line' };
        const event = parseLedgerEvent(line, projectId || snapshot.project_id);
        if (ids.has(event.event_id)) return { status: 'corrupt', reason: 'tail-duplicate' };
        ids.add(event.event_id);
        events.push(event);
      }
    } catch {
      return { status: 'corrupt', reason: 'tail-invalid-event' };
    }
    return { status: 'ok', path: checked.target, events, bytes: tailBytes, size: stat.size };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readOutbox(vaultBase, projectId) {
  const dir = outboxDir(vaultBase);
  let checked = checkedDirectory(vaultBase, dir, 'outbox de memória do runtime incremental');
  if (!checked.exists) return [];
  checked = checkedDirectory(vaultBase, checked.target, 'outbox de memória do runtime incremental', {
    allowMissing: false,
  });
  const entries = readdirSync(checked.target, { withFileTypes: true });
  for (const entry of entries) {
    assertVaultPathSafe(vaultBase, join(checked.target, entry.name), {
      allowMissing: false,
      label: `entrada ${entry.name} do outbox de memória`,
    });
  }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const path = join(checked.target, entry.name);
      try {
        const event = parseLedgerEvent(readCheckedFile(
          vaultBase, path, 'utf8', `evento ${entry.name} do outbox de memória`,
        ), projectId);
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
  let checked = checkedDirectory(vaultBase, dir, 'outbox de memória do runtime incremental');
  if (!checked.exists) return 0;
  checked = checkedDirectory(vaultBase, checked.target, 'outbox de memória do runtime incremental', {
    allowMissing: false,
  });
  return readdirSync(checked.target, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
}

function appendLedgerDurably(vaultBase, events) {
  if (!events.length) return { bytes: 0 };
  const path = ledgerPath(vaultBase);
  let fd;
  const payload = `${events.map((event) => canonicalMemoryJson(event)).join('\n')}\n`;
  try {
    let checked = checkedFile(vaultBase, path, 'ledger MEMORY_EVENTS.jsonl incremental');
    checked = checkedFile(vaultBase, checked.target, 'ledger MEMORY_EVENTS.jsonl incremental');
    fd = openSync(checked.target, 'a');
    assertOpenedFile(vaultBase, checked.target, fd, 'ledger MEMORY_EVENTS.jsonl incremental');
    writeFileSync(fd, payload, 'utf8');
    fsyncSync(fd);
    assertOpenedFile(vaultBase, checked.target, fd, 'ledger MEMORY_EVENTS.jsonl incremental');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { bytes: Buffer.byteLength(payload) };
}

function preflightDerivedTargets(vaultBase, { snapshot = false } = {}) {
  const targets = [
    { path: sharedPath(vaultBase), expectedType: 'file', label: 'projeção SHARED_MEMORY.md' },
    { path: candidatesPath(vaultBase), expectedType: 'file', label: 'projeção MEMORY_CANDIDATES.jsonl' },
  ];
  if (snapshot) {
    targets.push({
      path: snapshotPath(vaultBase),
      expectedType: 'file',
      label: 'snapshot incremental de memória',
    });
  }
  return assertVaultPathsSafe(vaultBase, targets);
}

function sameCausalActivation(left, right) {
  return Boolean(left?.canonical_session_id)
    && left.canonical_session_id === right?.canonical_session_id
    && left.activation_id === right?.activation_id;
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

function registerPrecedence(incoming, current) {
  if (!incoming?.scope || !current?.scope
      || !isRegisterMemoryKey(incoming?.memory_key) || !sameRegisterLineage(incoming, current)) return null;
  const epoch = Number(incoming.activation_epoch ?? -1) - Number(current.activation_epoch ?? -1);
  if (epoch) return epoch;
  const turn = Number(incoming.turn_sequence ?? -1) - Number(current.turn_sequence ?? -1);
  if (turn) return turn;
  const authority = (AUTHORITY_RANK[incoming.authority] ?? -1)
    - (AUTHORITY_RANK[current.authority] ?? -1);
  if (authority) return authority;
  const observed = String(incoming.observed_at || '').localeCompare(String(current.observed_at || ''));
  if (observed) return observed;
  return String(incoming.event_id || '').localeCompare(String(current.event_id || ''));
}

function hasComplexTailSemantics(event) {
  return Boolean(event.candidate_decision)
    || Boolean(event.rescopes_event_id)
    || (Array.isArray(event.rescopes_event_ids) && event.rescopes_event_ids.length > 0);
}

function fastApplySnapshot(snapshot, bloom, events, coreInvariants) {
  const records = new Map(Object.entries(structuredClone(snapshot.projection.records)));
  const tombstones = new Map(Object.entries(structuredClone(snapshot.projection.tombstones)));
  let revision = snapshot.projection.revision;
  let stateHash = snapshot.projection.state_hash;
  let eventCursor = snapshot.projection.event_cursor;
  let orderCursor = structuredClone(snapshot.order_cursor);
  let chainHash = snapshot.chain_hash;
  let eventCount = snapshot.event_count;
  let updatedAt = snapshot.projection.updated_at;

  for (const event of events) {
    const tuple = eventOrderTuple(event);
    if (compareOrderTuple(tuple, orderCursor) < 0) {
      return { status: 'fallback', reason: 'non-monotonic-event-order' };
    }
    if (hasComplexTailSemantics(event)) return { status: 'fallback', reason: 'complex-tail-event' };
    if (coreInvariants.has(event.memory_key)) {
      const coreValue = coreInvariants.get(event.memory_key);
      if (event.operation !== 'assert' || hashMemoryValue(event.value) !== hashMemoryValue(coreValue)) {
        return { status: 'fallback', reason: 'core-conflict' };
      }
    }

    const key = memoryRecordKey(event);
    const current = records.get(key);
    const currentSource = current?.source;
    let applied = false;

    if (isCausallyOlder(event, currentSource)) {
      // The state stays unchanged, but the physical tail and rolling chain still advance.
    } else if (event.operation === 'assert') {
      if (current && hashMemoryValue(current.value) !== hashMemoryValue(event.value)) {
        const precedence = registerPrecedence(event, currentSource);
        if ((sameCausalActivation(event, currentSource)
              && Number(event.turn_sequence) > Number(currentSource.turn_sequence))
            || precedence > 0) {
          records.set(key, { value: event.value, revision: current.revision + 1, source: event });
          tombstones.delete(key);
          revision += 1;
          applied = true;
        } else {
          return { status: 'fallback', reason: 'assert-conflict' };
        }
      } else if (!current) {
        records.set(key, { value: event.value, revision: 1, source: event });
        tombstones.delete(key);
        revision += 1;
        applied = true;
      }
    } else if (event.operation === 'add') {
      const oldValues = Array.isArray(current?.value) ? current.value : (current ? [current.value] : []);
      const additions = Array.isArray(event.value) ? event.value : [event.value];
      const byHash = new Map(oldValues.map((value) => [hashMemoryValue(value), value]));
      additions.forEach((value) => byHash.set(hashMemoryValue(value), value));
      const value = [...byHash.entries()]
        .sort(([left], [right]) => left.localeCompare(right)).map(([, item]) => item);
      records.set(key, { value, revision: (current?.revision || 0) + 1, source: event });
      tombstones.delete(key);
      revision += 1;
      applied = true;
    } else if (event.operation === 'remove') {
      if (current) {
        const baseMatches = event.base_revision === undefined
          || (event.base_revision === current.revision
            && (!event.base_value_hash || event.base_value_hash === hashMemoryValue(current.value)));
        if (!baseMatches) return { status: 'fallback', reason: 'remove-base-mismatch' };
        if (event.value !== null && event.value !== undefined && Array.isArray(current.value)) {
          const removalHash = hashMemoryValue(event.value);
          const value = current.value.filter((entry) => hashMemoryValue(entry) !== removalHash);
          records.set(key, { value, revision: current.revision + 1, source: event });
          tombstones.set(`${key}:${removalHash}`, {
            event_id: event.event_id,
            removed_event_id: current.source.event_id,
            value_hash: removalHash,
          });
        } else {
          records.delete(key);
          tombstones.set(key, {
            event_id: event.event_id,
            removed_event_id: current.source.event_id,
            value_hash: hashMemoryValue(current.value),
          });
        }
        revision += 1;
        applied = true;
      }
    } else if (event.operation === 'replace') {
      if (!current) return { status: 'fallback', reason: 'replace-without-current' };
      const supersedes = Array.isArray(event.supersedes)
        ? event.supersedes
        : (event.supersedes_event_id ? [event.supersedes_event_id] : []);
      if (supersedes.some((eventId) => eventId !== currentSource?.event_id)) {
        return { status: 'fallback', reason: 'replace-historical-supersedes' };
      }
      const explicitlySupersedes = supersedes.includes(currentSource?.event_id);
      const baseMatches = event.base_revision === current.revision
        && event.base_value_hash === hashMemoryValue(current.value);
      if (!baseMatches && !explicitlySupersedes) {
        return { status: 'fallback', reason: 'replace-base-mismatch' };
      }
      records.set(key, { value: event.value, revision: current.revision + 1, source: event });
      tombstones.delete(key);
      revision += 1;
      applied = true;
    }

    if (applied) stateHash = stateHashFor(sortedObject(records), sortedObject(tombstones));
    orderCursor = tuple;
    eventCursor = event.event_id;
    chainHash = chainStep(chainHash, event);
    bloomAdd(bloom, event.event_id);
    eventCount += 1;
    if (String(event.observed_at || '') > updatedAt) updatedAt = String(event.observed_at || '');
  }

  const recordObject = sortedObject(records);
  const tombstoneObject = sortedObject(tombstones);
  stateHash = stateHashFor(recordObject, tombstoneObject);
  const activeEvents = Object.entries(recordObject).map(([projectionKey, record]) => ({
    ...record.source,
    memory_key: record.source.memory_key,
    projection_key: projectionKey,
    operation: 'assert',
    value: record.value,
  }));
  return {
    status: 'ok',
    records: recordObject,
    tombstones: tombstoneObject,
    revision,
    stateHash,
    eventCursor,
    orderCursor,
    chainHash,
    eventCount,
    updatedAt,
    activeEvents,
    bloom,
  };
}

function prepareProjection({
  revision, ledgerCursor, eventCursor, stateHash, activeEvents, candidates = [], updatedAt,
}) {
  const sharedContent = renderSharedMemory({
    revision,
    eventCursor: ledgerCursor,
    events: activeEvents,
    stateHash,
    updatedAt,
  });
  const metadata = parseSharedMemory(sharedContent).metadata;
  const candidatesContent = candidates.map((item) => canonicalMemoryJson(item)).join('\n')
    + (candidates.length ? '\n' : '');
  const checkpoint = {
    revision,
    event_cursor: ledgerCursor,
    state_hash: stateHash,
  };
  if (eventCursor !== ledgerCursor) checkpoint.causal_event_cursor = eventCursor;
  return {
    sharedContent,
    candidatesContent,
    revision,
    eventCursor,
    ledgerCursor,
    stateHash,
    checkpoint,
    candidates: candidates.length,
    projectedEvents: metadata.projected_events ?? activeEvents.length,
    omittedEvents: metadata.omitted_events ?? 0,
  };
}

function fullProjection(vaultBase, events) {
  const reduced = deriveMemoryProjection(vaultBase, events);
  const updatedAt = events.map((event) => String(event.observed_at || '')).sort().at(-1)
    || new Date(0).toISOString();
  const prepared = prepareProjection({
    revision: reduced.revision,
    ledgerCursor: reduced.ledgerCursor,
    eventCursor: reduced.eventCursor,
    stateHash: reduced.stateHash,
    activeEvents: reduced.activeEvents,
    candidates: reduced.candidates,
    updatedAt,
  });
  return {
    mode: 'full',
    eventCount: events.length,
    prepared,
    snapshotState: reduced.candidates.length === 0 ? {
      records: reduced.records,
      tombstones: reduced.tombstones,
      revision: reduced.revision,
      stateHash: reduced.stateHash,
      eventCursor: reduced.eventCursor,
      orderCursor: maximumOrder(events),
      chainHash: chainForEvents(events),
      bloom: bloomForEvents(events),
      eventCount: events.length,
      updatedAt,
    } : null,
  };
}

function incrementalProjection(snapshot, bloom, tailEvents, newEvents, coreInvariants) {
  const combined = [...tailEvents, ...newEvents];
  const applied = fastApplySnapshot(snapshot, Buffer.from(bloom), combined, coreInvariants);
  if (applied.status !== 'ok') return applied;
  const ledgerCursor = combined.at(-1)?.event_id || snapshot.through_event_id;
  return {
    status: 'ok',
    mode: 'snapshot-tail',
    eventCount: applied.eventCount,
    prepared: prepareProjection({
      revision: applied.revision,
      ledgerCursor,
      eventCursor: applied.eventCursor,
      stateHash: applied.stateHash,
      activeEvents: applied.activeEvents,
      updatedAt: applied.updatedAt,
    }),
    snapshotState: applied,
  };
}

function snapshotBoundary(vaultBase) {
  const path = ledgerPath(vaultBase);
  let checked = checkedFile(vaultBase, path, 'ledger MEMORY_EVENTS.jsonl para snapshot', {
    allowMissing: true,
  });
  if (!checked.exists) {
    return {
      ledgerBytes: 0,
      throughLineStart: 0,
      throughLineLength: 0,
      throughLineHash: sha256(Buffer.alloc(0)),
      throughEventId: 'none',
    };
  }
  checked = checkedFile(vaultBase, checked.target, 'ledger MEMORY_EVENTS.jsonl para snapshot', {
    allowMissing: false,
  });
  let fd;
  try {
    fd = openSync(checked.target, 'r');
    assertOpenedFile(vaultBase, checked.target, fd, 'ledger MEMORY_EVENTS.jsonl para snapshot');
    const size = fstatSync(fd).size;
    if (size === 0) {
      return {
        ledgerBytes: 0,
        throughLineStart: 0,
        throughLineLength: 0,
        throughLineHash: sha256(Buffer.alloc(0)),
        throughEventId: 'none',
      };
    }
    const finalByte = readRange(fd, size - 1, 1);
    if (finalByte.length !== 1 || finalByte[0] !== 0x0a) return null;
    let cursor = size - 1;
    let lineStart = 0;
    while (cursor > 0) {
      const chunkStart = Math.max(0, cursor - 64 * 1024);
      const chunk = readRange(fd, chunkStart, cursor - chunkStart);
      const newline = chunk.lastIndexOf(0x0a);
      if (newline >= 0) {
        lineStart = chunkStart + newline + 1;
        break;
      }
      cursor = chunkStart;
      if (size - cursor > SNAPSHOT_MAX_LINE_BYTES) return null;
    }
    const lineLength = size - 1 - lineStart;
    if (lineLength > SNAPSHOT_MAX_LINE_BYTES) return null;
    const line = readRange(fd, lineStart, lineLength);
    let throughEventId;
    try { throughEventId = JSON.parse(line.toString('utf8')).event_id; } catch { return null; }
    if (!EVENT_ID.test(String(throughEventId || ''))) return null;
    return {
      ledgerBytes: size,
      throughLineStart: lineStart,
      throughLineLength: lineLength,
      throughLineHash: sha256(line),
      throughEventId,
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeSnapshot(vaultBase, state, { projectId, coreHash } = {}) {
  if (!state || !state.bloom || state.bloom.length !== SNAPSHOT_BLOOM_BYTES) {
    return { status: 'skipped', reason: 'snapshot-state-unavailable' };
  }
  const boundary = snapshotBoundary(vaultBase);
  if (!boundary) return { status: 'skipped', reason: 'snapshot-boundary-unavailable' };
  const snapshot = {
    schema_version: MEMORY_SNAPSHOT_SCHEMA_VERSION,
    reducer_version: MEMORY_SNAPSHOT_REDUCER_VERSION,
    project_id: projectId || '',
    core_hash: coreHash,
    event_count: state.eventCount,
    ledger_bytes: boundary.ledgerBytes,
    through_event_id: boundary.throughEventId,
    through_line_start: boundary.throughLineStart,
    through_line_length: boundary.throughLineLength,
    through_line_hash: boundary.throughLineHash,
    chain_hash: state.chainHash,
    order_cursor: state.orderCursor,
    bloom: {
      bytes: SNAPSHOT_BLOOM_BYTES,
      hashes: SNAPSHOT_BLOOM_HASHES,
      data: state.bloom.toString('base64'),
    },
    projection: {
      records: state.records,
      tombstones: state.tombstones,
      revision: state.revision,
      state_hash: state.stateHash,
      event_cursor: state.eventCursor,
      updated_at: state.updatedAt,
    },
  };
  snapshot.snapshot_hash = snapshotHash(snapshot);
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  const path = snapshotPath(vaultBase);
  const current = readCheckedFile(
    vaultBase, path, 'utf8', 'snapshot incremental de memória', { allowMissing: true },
  );
  if (current === content) return { status: 'unchanged', snapshot };
  writeVaultFileAtomic(vaultBase, path, content, 'utf8', {
    label: 'snapshot incremental de memória',
  });
  return { status: 'written', snapshot };
}

export function readMemoryProjectionSnapshot(vaultBase) {
  const core = readCoreAuthority(vaultBase);
  const projectId = projectIdForVault(vaultBase);
  const loaded = readSnapshotDocument(vaultBase, core.hash, projectId);
  if (loaded.status !== 'ok') return loaded;
  const tail = readSnapshotTail(vaultBase, loaded.snapshot, projectId || loaded.snapshot.project_id);
  return { ...loaded, tail };
}

function fullLedgerForOutbox(vaultBase, outbox) {
  const ledger = readMemoryLedger(vaultBase);
  if (ledger.status !== 'ok') throw new MemoryLedgerCorruption(ledger.errors);
  const byId = new Map(ledger.events.map((event) => [event.event_id, event]));
  const newEvents = [];
  for (const entry of outbox) {
    const existing = byId.get(entry.event.event_id);
    if (existing) {
      if (canonicalMemoryJson(existing) !== canonicalMemoryJson(entry.event)) {
        throw new MemoryEventCollision(entry.event.event_id);
      }
      continue;
    }
    byId.set(entry.event.event_id, entry.event);
    newEvents.push(entry.event);
  }
  return { ledger, newEvents, allEvents: [...ledger.events, ...newEvents] };
}

function trySnapshotForOutbox(vaultBase, outbox, core, projectId) {
  const loaded = readSnapshotDocument(vaultBase, core.hash, projectId);
  if (loaded.status !== 'ok') return { status: 'fallback', reason: loaded.reason };
  const tail = readSnapshotTail(vaultBase, loaded.snapshot, projectId || loaded.snapshot.project_id);
  if (tail.status !== 'ok') return { status: 'fallback', reason: tail.reason };
  const tailById = new Map(tail.events.map((event) => [event.event_id, event]));
  const newEvents = [];
  for (const entry of outbox) {
    const existing = tailById.get(entry.event.event_id);
    if (existing) {
      if (canonicalMemoryJson(existing) !== canonicalMemoryJson(entry.event)) {
        throw new MemoryEventCollision(entry.event.event_id);
      }
      continue;
    }
    if (bloomMayContain(loaded.bloom, entry.event.event_id)) {
      return { status: 'fallback', reason: 'snapshot-bloom-hit' };
    }
    newEvents.push(entry.event);
  }
  const projection = incrementalProjection(
    loaded.snapshot, loaded.bloom, tail.events, newEvents, core.invariants,
  );
  if (projection.status !== 'ok') return projection;
  return {
    status: 'ok',
    loaded,
    tail,
    newEvents,
    projection,
  };
}

function shouldAdvanceSnapshot({
  mode, tailBytes = 0, tailEvents = 0, appendedBytes = 0, appended = 0,
}, options) {
  return mode === 'full'
    || options?.snapshot?.force === true
    || tailEvents + appended >= SNAPSHOT_ADVANCE_EVENTS
    || tailBytes + appendedBytes >= SNAPSHOT_ADVANCE_BYTES;
}

function injectFault(faultAt, boundary) {
  if (faultAt === boundary) throw new Error(`Injected memory-store fault: ${boundary}`);
}

function projectLocked(vaultBase, options = {}) {
  const core = readCoreAuthority(vaultBase);
  const vaultProjectId = projectIdForVault(vaultBase);
  const outbox = readOutbox(vaultBase, vaultProjectId);
  const attempt = trySnapshotForOutbox(vaultBase, outbox, core, vaultProjectId);
  let projection;
  let newEvents;
  let projectId = vaultProjectId;
  let tailBytes = 0;
  let tailEvents = 0;
  let fallbackReason = '';

  if (attempt.status === 'ok') {
    projection = attempt.projection;
    newEvents = attempt.newEvents;
    projectId ||= attempt.loaded.snapshot.project_id;
    tailBytes = attempt.tail.bytes;
    tailEvents = attempt.tail.events.length;
  } else {
    fallbackReason = attempt.reason || 'snapshot-unavailable';
    const full = fullLedgerForOutbox(vaultBase, outbox);
    newEvents = full.newEvents;
    projectId ||= projectIdForEvents(full.allEvents);
    projection = fullProjection(vaultBase, full.allEvents);
  }

  const appendedBytes = newEvents.reduce(
    (total, event) => total + Buffer.byteLength(`${canonicalMemoryJson(event)}\n`), 0,
  );
  const willSnapshot = Boolean(projection.snapshotState)
    && shouldAdvanceSnapshot({
      mode: projection.mode,
      tailBytes,
      tailEvents,
      appended: newEvents.length,
      appendedBytes,
    }, options);
  preflightDerivedTargets(vaultBase, { snapshot: willSnapshot });
  const append = appendLedgerDurably(vaultBase, newEvents);
  injectFault(options.faultAt, 'after-ledger');
  const published = publishMemoryProjection(vaultBase, projection.prepared);
  injectFault(options.faultAt, 'after-projection');

  let snapshotResult = { status: projection.snapshotState ? 'deferred' : 'candidate-conflict' };
  if (willSnapshot) {
    snapshotResult = writeSnapshot(vaultBase, projection.snapshotState, {
      projectId,
      coreHash: core.hash,
    });
  }
  injectFault(options.faultAt, 'after-snapshot');

  const consumedEventIds = [];
  for (const entry of outbox) {
    unlinkVaultFile(vaultBase, entry.path, {
      missingOk: false,
      label: 'evento consumido do outbox de memória',
    });
    consumedEventIds.push(entry.event.event_id);
  }
  return {
    status: 'projected',
    appended: newEvents.length,
    consumed: outbox.length,
    consumedEventIds,
    pending: 0,
    ...published,
    replayMode: projection.mode,
    replayedEvents: projection.mode === 'snapshot-tail'
      ? tailEvents + newEvents.length
      : projection.eventCount,
    snapshotStatus: snapshotResult.status,
    snapshotFallback: fallbackReason || null,
    snapshotEventCount: projection.eventCount,
    appendedBytes: append.bytes,
  };
}

export function projectMemoryOutbox(vaultBase, options = {}) {
  mkdirVaultPath(vaultBase, brainDir(vaultBase), { label: 'raiz .brain da memória' });
  const pending = countPendingOutbox(vaultBase);
  const result = withMemoryLock(
    vaultBase, () => projectLocked(vaultBase, options), options.lock || {},
  );
  if (result === MEMORY_LOCK_BUSY) return { status: 'busy', pending };
  return result;
}

function reprojectLocked(vaultBase, options = {}) {
  const core = readCoreAuthority(vaultBase);
  const projectId = projectIdForVault(vaultBase);
  const loaded = readSnapshotDocument(vaultBase, core.hash, projectId);
  let projection;
  let tailBytes = 0;
  let tailEvents = 0;
  let fallbackReason = '';

  if (loaded.status === 'ok') {
    const tail = readSnapshotTail(vaultBase, loaded.snapshot, projectId || loaded.snapshot.project_id);
    if (tail.status === 'ok') {
      const incremental = incrementalProjection(
        loaded.snapshot, loaded.bloom, tail.events, [], core.invariants,
      );
      if (incremental.status === 'ok') {
        projection = incremental;
        tailBytes = tail.bytes;
        tailEvents = tail.events.length;
      } else {
        fallbackReason = incremental.reason;
      }
    } else {
      fallbackReason = tail.reason;
    }
  } else {
    fallbackReason = loaded.reason;
  }

  if (!projection) {
    const ledger = readMemoryLedger(vaultBase);
    if (ledger.status !== 'ok') throw new MemoryLedgerCorruption(ledger.errors);
    projection = fullProjection(vaultBase, ledger.events);
  }

  const willSnapshot = Boolean(projection.snapshotState)
    && shouldAdvanceSnapshot({ mode: projection.mode, tailBytes, tailEvents }, options);
  preflightDerivedTargets(vaultBase, { snapshot: willSnapshot });
  const published = publishMemoryProjection(vaultBase, projection.prepared);
  let snapshotResult = { status: projection.snapshotState ? 'deferred' : 'candidate-conflict' };
  if (willSnapshot) {
    snapshotResult = writeSnapshot(vaultBase, projection.snapshotState, {
      projectId: projectId || loaded.snapshot?.project_id || '',
      coreHash: core.hash,
    });
  }
  return {
    status: 'reprojected',
    ...published,
    replayMode: projection.mode,
    replayedEvents: projection.mode === 'snapshot-tail' ? tailEvents : projection.eventCount,
    snapshotStatus: snapshotResult.status,
    snapshotFallback: fallbackReason || null,
    snapshotEventCount: projection.eventCount,
  };
}

export function reprojectMemoryLedger(vaultBase, options = {}) {
  mkdirVaultPath(vaultBase, brainDir(vaultBase), { label: 'raiz .brain da memória' });
  const result = withMemoryLock(
    vaultBase, () => reprojectLocked(vaultBase, options), options.lock || {},
  );
  if (result === MEMORY_LOCK_BUSY) return { status: 'busy' };
  return result;
}
