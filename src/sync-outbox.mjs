import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertVaultPathSafe,
  mkdirVaultPath,
  VAULT_LOCK_BUSY,
  withVaultPathLock,
  writeVaultFileAtomic,
} from '../packages/vault/src/vault-path-safety.mjs';
import { canonicalSyncJson, createSyncState, validateSyncEvent } from './sync-protocol.mjs';

const RUNTIME = ['.brain', 'runtime', 'sync'];
const OUTBOX = 'OUTBOX.jsonl';
const ACKS = 'ACKS.jsonl';
const LOCAL_STATE = 'LOCAL_STATE.json';
const CURSOR = 'CURSOR.json';

function outboxError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function syncRuntimePaths(vaultBase) {
  const directory = join(vaultBase, ...RUNTIME);
  return {
    directory, outbox: join(directory, OUTBOX), acks: join(directory, ACKS),
    state: join(directory, LOCAL_STATE), cursor: join(directory, CURSOR),
  };
}

function parseLines(bytes, label) {
  const rows = [];
  for (const [index, line] of String(bytes || '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch { throw outboxError('WENDKEEP_SYNC_OUTBOX_CORRUPT', `${label} line ${index + 1} is invalid JSON`); }
  }
  return rows;
}

function safeRead(vaultBase, path, label) {
  if (!existsSync(path)) return '';
  let checked;
  try { checked = assertVaultPathSafe(vaultBase, path, { expectedType: 'file', label }); }
  catch (error) { throw outboxError('WENDKEEP_SYNC_OUTBOX_UNSAFE', error.message); }
  return checked.exists ? readFileSync(checked.target, 'utf8') : '';
}

function appendUnique(vaultBase, path, record, idField) {
  const { directory } = syncRuntimePaths(vaultBase);
  mkdirVaultPath(vaultBase, directory, { label: 'sync runtime directory' });
  const outcome = withVaultPathLock(vaultBase, path, () => {
    const previous = safeRead(vaultBase, path, 'sync append-only ledger');
    const rows = parseLines(previous, 'sync ledger');
    if (rows.some((item) => item?.[idField] === record[idField])) return { created: false, record };
    writeVaultFileAtomic(vaultBase, path, `${previous}${canonicalSyncJson(record)}\n`, 'utf8', {
      label: 'sync append-only ledger',
    });
    return { created: true, record };
  }, { code: 'WENDKEEP_SYNC_OUTBOX_BUSY' });
  if (outcome === VAULT_LOCK_BUSY) throw outboxError('WENDKEEP_SYNC_OUTBOX_BUSY', 'sync ledger is busy');
  return outcome;
}

export function enqueueSyncEvent(vaultBase, event) {
  validateSyncEvent(event);
  return appendUnique(vaultBase, syncRuntimePaths(vaultBase).outbox, event, 'event_id');
}

export function ackSyncEvent(vaultBase, eventId, {
  observedAt = new Date().toISOString(), backend = '',
} = {}) {
  const id = String(eventId || '').trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw outboxError('WENDKEEP_SYNC_ACK_INVALID', 'event id is invalid');
  const record = {
    schema_version: 1,
    event_id: id,
    acknowledged_at: new Date(observedAt).toISOString(),
    backend: String(backend || '').slice(0, 120),
  };
  return appendUnique(vaultBase, syncRuntimePaths(vaultBase).acks, record, 'event_id');
}

export function readSyncOutbox(vaultBase) {
  const paths = syncRuntimePaths(vaultBase);
  const events = parseLines(safeRead(vaultBase, paths.outbox, 'sync outbox'), 'OUTBOX.jsonl');
  for (const event of events) validateSyncEvent(event);
  const acks = parseLines(safeRead(vaultBase, paths.acks, 'sync acknowledgements'), 'ACKS.jsonl');
  const acknowledged = new Set(acks.map((item) => item.event_id));
  return { events, acks, pending: events.filter((event) => !acknowledged.has(event.event_id)) };
}

export function readPendingSyncEvents(vaultBase) {
  return readSyncOutbox(vaultBase).pending;
}

export function inspectSyncOutbox(vaultBase) {
  const paths = syncRuntimePaths(vaultBase);
  if (!existsSync(paths.directory)) return { status: 'disabled', events: 0, pending: 0, acknowledged: 0 };
  try {
    if (lstatSync(paths.directory).isSymbolicLink()) throw outboxError('WENDKEEP_SYNC_OUTBOX_UNSAFE', 'sync runtime is a symlink');
    const state = readSyncOutbox(vaultBase);
    return {
      status: state.pending.length ? 'pending' : 'healthy',
      events: state.events.length,
      pending: state.pending.length,
      acknowledged: state.acks.length,
    };
  } catch (error) {
    return { status: 'corrupt', events: 0, pending: 0, acknowledged: 0, code: error.code || 'WENDKEEP_SYNC_OUTBOX_CORRUPT' };
  }
}

export function readLocalSyncState(vaultBase, projectId) {
  const path = syncRuntimePaths(vaultBase).state;
  if (!existsSync(path)) return createSyncState(projectId);
  try {
    const state = JSON.parse(safeRead(vaultBase, path, 'local sync state'));
    if (state?.schema_version !== 1 || state?.project_id !== projectId) throw new Error('identity mismatch');
    return state;
  } catch (error) {
    throw outboxError('WENDKEEP_SYNC_STATE_CORRUPT', `local sync state is corrupt: ${error.message}`);
  }
}

function writeRuntimeJson(vaultBase, path, value, label) {
  const { directory } = syncRuntimePaths(vaultBase);
  mkdirVaultPath(vaultBase, directory, { label: 'sync runtime directory' });
  const outcome = withVaultPathLock(vaultBase, path, () => {
    writeVaultFileAtomic(vaultBase, path, `${JSON.stringify(value, null, 2)}\n`, 'utf8', { label });
    return value;
  }, { code: 'WENDKEEP_SYNC_OUTBOX_BUSY' });
  if (outcome === VAULT_LOCK_BUSY) throw outboxError('WENDKEEP_SYNC_OUTBOX_BUSY', 'sync runtime is busy');
  return outcome;
}

export function writeLocalSyncState(vaultBase, state) {
  return writeRuntimeJson(vaultBase, syncRuntimePaths(vaultBase).state, state, 'local sync state');
}

export function readSyncCursor(vaultBase) {
  const path = syncRuntimePaths(vaultBase).cursor;
  if (!existsSync(path)) return 0;
  try {
    const value = JSON.parse(safeRead(vaultBase, path, 'sync cursor'));
    return Number.isSafeInteger(value?.cursor) && value.cursor >= 0 ? value.cursor : 0;
  } catch { throw outboxError('WENDKEEP_SYNC_CURSOR_CORRUPT', 'local sync cursor is corrupt'); }
}

export function writeSyncCursor(vaultBase, cursor) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw outboxError('WENDKEEP_SYNC_CURSOR_INVALID', 'cursor is invalid');
  return writeRuntimeJson(vaultBase, syncRuntimePaths(vaultBase).cursor, {
    schema_version: 1, cursor,
  }, 'sync cursor');
}
