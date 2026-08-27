import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  canonicalMemoryJson,
  readMemoryLedger as readActiveMemoryLedger,
} from './memory-store-base.mjs';
import { validateMemoryEvent } from './memory-schema.mjs';
import { assertVaultPathSafe } from './vault-path-safety.mjs';

export const MEMORY_LEDGER_GENERATION_FILE = 'MEMORY_LEDGER_GENERATION.json';
export const MEMORY_LEDGER_GENERATION_SCHEMA_VERSION = 1;
export const MEMORY_LEDGER_BACKUP_DIRECTORY = 'memory-ledger-generations';
export const MEMORY_ROTATION_JOURNAL_FILE = 'MEMORY_ROTATION_JOURNAL.json';
export const MEMORY_ROTATION_JOURNAL_SCHEMA_VERSION = 1;
export const MEMORY_ROTATION_RECEIPTS_FILE = 'MEMORY_ROTATION_RECEIPTS.jsonl';
export const MEMORY_ROTATION_RECEIPT_CHECKPOINT_FILE = 'MEMORY_ROTATION_RECEIPTS.checkpoint.json';
export const MEMORY_ROTATION_RECEIPT_SCHEMA_VERSION = 1;
export const MEMORY_ROTATION_RECEIPT_CHECKPOINT_SCHEMA_VERSION = 1;

const SHA256 = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^memrot-[a-f0-9]{16}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BACKUP_FILE = /^memory-ledger-generations\/ledger-gen-(\d{6})-([a-f0-9]{16})\.jsonl$/;
const RECEIPT_KIND = 'memory-ledger-rotation';
const CHAIN_GENESIS = '0'.repeat(64);

export class MemoryLedgerGenerationCorruption extends Error {
  constructor(errors, message = 'Memory ledger generation is corrupt or incomplete; recover the rotation before continuing.') {
    super(message);
    this.name = 'MemoryLedgerGenerationCorruption';
    this.code = 'MEMORY_LEDGER_GENERATION_CORRUPT';
    this.errors = Array.isArray(errors) ? errors : [String(errors || 'unknown generation error')];
  }
}

export class MemoryRotationReceiptCorruption extends Error {
  constructor(errors, message = 'Memory rotation receipt chain is corrupt or incomplete.') {
    super(message);
    this.name = 'MemoryRotationReceiptCorruption';
    this.code = 'MEMORY_ROTATION_RECEIPT_CORRUPT';
    this.errors = Array.isArray(errors) ? errors : [String(errors || 'unknown receipt error')];
  }
}

function brainDir(vaultBase) { return join(vaultBase, '.brain'); }
export function memoryLedgerPath(vaultBase) { return join(brainDir(vaultBase), 'MEMORY_EVENTS.jsonl'); }
export function memoryLedgerGenerationPath(vaultBase) {
  return join(brainDir(vaultBase), MEMORY_LEDGER_GENERATION_FILE);
}
export function memoryLedgerBackupDirectory(vaultBase) {
  return join(brainDir(vaultBase), MEMORY_LEDGER_BACKUP_DIRECTORY);
}
export function memoryRotationJournalPath(vaultBase) {
  return join(brainDir(vaultBase), MEMORY_ROTATION_JOURNAL_FILE);
}
export function memoryRotationReceiptsPath(vaultBase) {
  return join(brainDir(vaultBase), MEMORY_ROTATION_RECEIPTS_FILE);
}
export function memoryRotationReceiptCheckpointPath(vaultBase) {
  return join(brainDir(vaultBase), MEMORY_ROTATION_RECEIPT_CHECKPOINT_FILE);
}

export function memorySha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalMemoryControlJson(value) {
  const canonicalize = (item) => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item && typeof item === 'object') {
      const out = {};
      for (const key of Object.keys(item).sort()) {
        if (item[key] !== undefined) out[key] = canonicalize(item[key]);
      }
      return out;
    }
    return item;
  };
  return JSON.stringify(canonicalize(value));
}

export function hashMemoryControl(value, excludedKey = '') {
  const copy = { ...(value || {}) };
  if (excludedKey) delete copy[excludedKey];
  return memorySha256(canonicalMemoryControlJson(copy));
}

function checkedFile(vaultBase, path, label, { allowMissing = true } = {}) {
  return assertVaultPathSafe(vaultBase, path, {
    allowMissing,
    expectedType: 'file',
    label,
  });
}

export function readMemoryControlFile(vaultBase, path, label, { allowMissing = true } = {}) {
  let checked = checkedFile(vaultBase, path, label, { allowMissing });
  if (!checked.exists) return null;
  checked = checkedFile(vaultBase, checked.target, label, { allowMissing: false });
  return readFileSync(checked.target, 'utf8');
}

export function projectIdForMemoryLedger(vaultBase) {
  const raw = readMemoryControlFile(
    vaultBase,
    join(brainDir(vaultBase), 'PROJECT.json'),
    'autoridade PROJECT.json da geração do ledger',
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

function ledgerError(line, message, partial = false) {
  return { line, message, partial };
}

export function parseMemoryLedgerContent(rawInput, projectId = '', path = '') {
  const raw = String(rawInput || '').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  const hasPartialTail = raw.length > 0 && !raw.endsWith('\n');
  if (!hasPartialTail) lines.pop();
  const events = [];
  const eventIds = new Set();
  const eventPayloads = new Map();
  const errors = [];

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
      errors.push(ledgerError(
        lineNumber,
        eventPayloads.get(parsed.event_id) === payload
          ? `duplicate event_id: ${parsed.event_id}`
          : `event_id collision: ${parsed.event_id}`,
        partial,
      ));
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
    eventPayloads,
    errors,
  };
}

export function readMemoryLedgerFile(vaultBase, path, label, { allowMissing = true } = {}) {
  const raw = readMemoryControlFile(vaultBase, path, label, { allowMissing });
  if (raw === null) {
    return {
      status: 'ok', path, raw: '', events: [], eventIds: new Set(), eventPayloads: new Map(), errors: [],
    };
  }
  return parseMemoryLedgerContent(raw, projectIdForMemoryLedger(vaultBase), path);
}

function generationErrors(state, projectId) {
  const errors = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) return ['generation state is not an object'];
  if (state.schema_version !== MEMORY_LEDGER_GENERATION_SCHEMA_VERSION) errors.push('generation schema_version mismatch');
  if (state.project_id !== projectId) errors.push('generation project_id mismatch');
  if (!Number.isInteger(state.generation) || state.generation < 1) errors.push('generation number invalid');
  if (!Number.isInteger(state.previous_generation) || state.previous_generation !== state.generation - 1) {
    errors.push('previous_generation mismatch');
  }
  if (!OPERATION_ID.test(String(state.operation_id || ''))) errors.push('operation_id invalid');
  if (!BACKUP_FILE.test(String(state.backup_file || ''))) errors.push('backup_file invalid');
  if (!SHA256.test(String(state.backup_hash || ''))) errors.push('backup_hash invalid');
  if (!SHA256.test(String(state.source_ledger_hash || ''))) errors.push('source_ledger_hash invalid');
  if (!Number.isInteger(state.source_event_count) || state.source_event_count < 1) errors.push('source_event_count invalid');
  if (!EVENT_ID.test(String(state.anchor_event_id || ''))) errors.push('anchor_event_id invalid');
  if (!SHA256.test(String(state.anchor_payload_hash || ''))) errors.push('anchor_payload_hash invalid');
  if (!SHA256.test(String(state.active_ledger_hash || ''))) errors.push('active_ledger_hash invalid');
  if (!SHA256.test(String(state.segment_manifest_hash || ''))) errors.push('segment_manifest_hash invalid');
  if (!SHA256.test(String(state.segment_chain_tip || ''))) errors.push('segment_chain_tip invalid');
  if (!SHA256.test(String(state.snapshot_hash || ''))) errors.push('snapshot_hash invalid');
  if (!SHA256.test(String(state.previous_state_hash || ''))) errors.push('previous_state_hash invalid');
  if (typeof state.rotated_at !== 'string' || Number.isNaN(Date.parse(state.rotated_at))) errors.push('rotated_at invalid');
  if (!SHA256.test(String(state.state_hash || '')) || state.state_hash !== hashMemoryControl(state, 'state_hash')) {
    errors.push('generation state_hash mismatch');
  }
  const backup = BACKUP_FILE.exec(String(state.backup_file || ''));
  if (backup && Number(backup[1]) !== state.generation) errors.push('backup generation mismatch');
  return errors;
}

export function readMemoryLedgerGeneration(vaultBase) {
  const projectId = projectIdForMemoryLedger(vaultBase);
  const raw = readMemoryControlFile(
    vaultBase,
    memoryLedgerGenerationPath(vaultBase),
    'estado da geração do ledger de memória',
    { allowMissing: true },
  );
  if (raw === null) return { status: 'missing', projectId, state: null, raw: null, errors: [] };
  let state;
  try { state = JSON.parse(raw); } catch { return { status: 'invalid', projectId, state: null, raw, errors: ['generation invalid JSON'] }; }
  const errors = generationErrors(state, projectId);
  return errors.length
    ? { status: 'invalid', projectId, state, raw, errors }
    : { status: 'ok', projectId, state, raw, errors: [] };
}

function journalErrors(journal, projectId) {
  const errors = [];
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) return ['rotation journal is not an object'];
  if (journal.schema_version !== MEMORY_ROTATION_JOURNAL_SCHEMA_VERSION) errors.push('journal schema_version mismatch');
  if (journal.project_id !== projectId) errors.push('journal project_id mismatch');
  if (!OPERATION_ID.test(String(journal.operation_id || ''))) errors.push('journal operation_id invalid');
  if (!['prepared', 'switched', 'state-published', 'snapshot-published', 'receipt-published'].includes(journal.stage)) {
    errors.push('journal stage invalid');
  }
  if (!journal.plan || typeof journal.plan !== 'object' || Array.isArray(journal.plan)) errors.push('journal plan missing');
  if (typeof journal.created_at !== 'string' || Number.isNaN(Date.parse(journal.created_at))) errors.push('journal created_at invalid');
  if (typeof journal.updated_at !== 'string' || Number.isNaN(Date.parse(journal.updated_at))) errors.push('journal updated_at invalid');
  if (!SHA256.test(String(journal.journal_hash || '')) || journal.journal_hash !== hashMemoryControl(journal, 'journal_hash')) {
    errors.push('journal_hash mismatch');
  }
  return errors;
}

export function readMemoryRotationJournal(vaultBase) {
  const projectId = projectIdForMemoryLedger(vaultBase);
  const raw = readMemoryControlFile(
    vaultBase,
    memoryRotationJournalPath(vaultBase),
    'journal da rotação do ledger de memória',
    { allowMissing: true },
  );
  if (raw === null) return { status: 'missing', projectId, journal: null, raw: null, errors: [] };
  let journal;
  try { journal = JSON.parse(raw); } catch { return { status: 'invalid', projectId, journal: null, raw, errors: ['journal invalid JSON'] }; }
  const errors = journalErrors(journal, projectId);
  return errors.length
    ? { status: 'invalid', projectId, journal, raw, errors }
    : { status: 'ok', projectId, journal, raw, errors: [] };
}

function receiptHash(receipt) {
  return hashMemoryControl(receipt, 'receipt_hash');
}

function checkpointHash(checkpoint) {
  return hashMemoryControl(checkpoint, 'checkpoint_hash');
}

export function parseMemoryRotationReceipts(rawInput, projectId = '') {
  const raw = String(rawInput || '').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  const partial = raw.length > 0 && !raw.endsWith('\n');
  if (!partial) lines.pop();
  const receipts = [];
  const errors = [];
  let previousHash = CHAIN_GENESIS;
  const operations = new Set();

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (!line.trim()) {
      errors.push(`receipt line ${lineNumber} blank${partial && index === lines.length - 1 ? ' (partial)' : ''}`);
      return;
    }
    let receipt;
    try { receipt = JSON.parse(line); } catch {
      errors.push(`receipt line ${lineNumber} invalid JSON${partial && index === lines.length - 1 ? ' (partial)' : ''}`);
      return;
    }
    if (receipt.schema_version !== MEMORY_ROTATION_RECEIPT_SCHEMA_VERSION
        || receipt.kind !== RECEIPT_KIND
        || receipt.project_id !== projectId
        || receipt.sequence !== lineNumber
        || !OPERATION_ID.test(String(receipt.operation_id || ''))
        || operations.has(receipt.operation_id)
        || receipt.previous_receipt_hash !== previousHash
        || !SHA256.test(String(receipt.receipt_hash || ''))
        || receipt.receipt_hash !== receiptHash(receipt)
        || !Number.isInteger(receipt.generation) || receipt.generation < 1
        || !SHA256.test(String(receipt.generation_state_hash || ''))
        || !SHA256.test(String(receipt.backup_hash || ''))
        || !SHA256.test(String(receipt.source_ledger_hash || ''))
        || !SHA256.test(String(receipt.segment_manifest_hash || ''))
        || !SHA256.test(String(receipt.snapshot_hash || ''))
        || typeof receipt.reason !== 'string' || receipt.reason.trim().length < 3
        || typeof receipt.authorized_by !== 'string' || receipt.authorized_by.trim().length < 2
        || typeof receipt.completed_at !== 'string' || Number.isNaN(Date.parse(receipt.completed_at))) {
      errors.push(`receipt line ${lineNumber} shape/hash mismatch`);
      return;
    }
    operations.add(receipt.operation_id);
    previousHash = receipt.receipt_hash;
    receipts.push(receipt);
  });

  return {
    status: errors.length ? 'corrupt' : 'ok',
    raw,
    receipts,
    errors,
    lastHash: previousHash,
    operations,
    partial,
  };
}

function readReceiptCheckpoint(vaultBase, receiptRaw, parsed) {
  const raw = readMemoryControlFile(
    vaultBase,
    memoryRotationReceiptCheckpointPath(vaultBase),
    'checkpoint dos receipts de rotação',
    { allowMissing: true },
  );
  if (raw === null) {
    return parsed.receipts.length === 0
      ? { status: 'empty', checkpoint: null, raw: null, errors: [] }
      : { status: 'missing', checkpoint: null, raw: null, errors: ['receipt checkpoint missing'] };
  }
  let checkpoint;
  try { checkpoint = JSON.parse(raw); } catch {
    return { status: 'invalid', checkpoint: null, raw, errors: ['receipt checkpoint invalid JSON'] };
  }
  const errors = [];
  if (checkpoint.schema_version !== MEMORY_ROTATION_RECEIPT_CHECKPOINT_SCHEMA_VERSION) errors.push('receipt checkpoint schema mismatch');
  if (checkpoint.project_id !== projectIdForMemoryLedger(vaultBase)) errors.push('receipt checkpoint project mismatch');
  if (checkpoint.count !== parsed.receipts.length) errors.push('receipt checkpoint count mismatch');
  if (checkpoint.last_hash !== parsed.lastHash) errors.push('receipt checkpoint last_hash mismatch');
  if (checkpoint.file_bytes !== Buffer.byteLength(receiptRaw)) errors.push('receipt checkpoint file_bytes mismatch');
  if (!SHA256.test(String(checkpoint.checkpoint_hash || ''))
      || checkpoint.checkpoint_hash !== checkpointHash(checkpoint)) errors.push('receipt checkpoint hash mismatch');
  return errors.length
    ? { status: 'invalid', checkpoint, raw, errors }
    : { status: 'ok', checkpoint, raw, errors: [] };
}

export function readMemoryRotationReceipts(vaultBase) {
  const path = memoryRotationReceiptsPath(vaultBase);
  const raw = readMemoryControlFile(
    vaultBase,
    path,
    'ledger de receipts da rotação de memória',
    { allowMissing: true },
  ) ?? '';
  const parsed = parseMemoryRotationReceipts(raw, projectIdForMemoryLedger(vaultBase));
  const checkpoint = parsed.status === 'ok'
    ? readReceiptCheckpoint(vaultBase, raw, parsed)
    : { status: 'unavailable', checkpoint: null, raw: null, errors: [] };
  return {
    ...parsed,
    path,
    checkpointStatus: checkpoint.status,
    checkpoint: checkpoint.checkpoint,
    checkpointErrors: checkpoint.errors,
  };
}

function backupPath(vaultBase, relativePath) {
  if (!BACKUP_FILE.test(String(relativePath || '')) || String(relativePath).includes('..') || String(relativePath).includes('\\')) {
    throw new MemoryLedgerGenerationCorruption([`unsafe backup path: ${relativePath}`]);
  }
  return join(brainDir(vaultBase), ...String(relativePath).split('/'));
}

function receiptForGeneration(receipts, state) {
  return receipts.receipts.find((receipt) => (
    receipt.operation_id === state.operation_id
    && receipt.generation === state.generation
    && receipt.generation_state_hash === state.state_hash
    && receipt.backup_hash === state.backup_hash
    && receipt.source_ledger_hash === state.source_ledger_hash
    && receipt.segment_manifest_hash === state.segment_manifest_hash
    && receipt.snapshot_hash === state.snapshot_hash
  ));
}

function generationFailure(vaultBase, errors, active = null, generation = null) {
  return {
    status: 'corrupt',
    path: memoryLedgerPath(vaultBase),
    raw: active?.raw || '',
    events: active?.events || [],
    eventIds: active?.eventIds || new Set(),
    errors: errors.map((message, index) => ledgerError(index + 1, message, false)),
    generation,
  };
}

/**
 * Return the canonical logical ledger. Before the first rotation it is the active JSONL.
 * After rotation it is the immutable full-generation backup plus the active anchor/tail.
 * Any unfinished journal blocks reads so a truncated active generation is never mistaken for
 * the complete authority.
 */
export function readMemoryLedger(vaultBase) {
  const journal = readMemoryRotationJournal(vaultBase);
  if (journal.status === 'ok') {
    return generationFailure(vaultBase, [
      `memory rotation recovery required for ${journal.journal.operation_id} at stage ${journal.journal.stage}`,
    ]);
  }
  if (journal.status === 'invalid') return generationFailure(vaultBase, journal.errors);

  const generation = readMemoryLedgerGeneration(vaultBase);
  if (generation.status === 'missing') return readActiveMemoryLedger(vaultBase);
  if (generation.status !== 'ok') return generationFailure(vaultBase, generation.errors, null, generation.state);

  const receipts = readMemoryRotationReceipts(vaultBase);
  if (receipts.status !== 'ok' || !['ok', 'empty'].includes(receipts.checkpointStatus)) {
    return generationFailure(vaultBase, [
      ...receipts.errors,
      ...receipts.checkpointErrors,
    ], null, generation.state);
  }
  if (!receiptForGeneration(receipts, generation.state)) {
    return generationFailure(vaultBase, ['rotation receipt does not authorize current generation'], null, generation.state);
  }

  let backup;
  try {
    const path = backupPath(vaultBase, generation.state.backup_file);
    const raw = readMemoryControlFile(vaultBase, path, 'backup imutável da geração do ledger', {
      allowMissing: false,
    });
    if (memorySha256(raw) !== generation.state.backup_hash
        || memorySha256(raw) !== generation.state.source_ledger_hash) {
      return generationFailure(vaultBase, ['generation backup hash mismatch'], null, generation.state);
    }
    backup = parseMemoryLedgerContent(raw, generation.projectId, path);
  } catch (error) {
    if (error?.code === 'VAULT_PATH_UNSAFE') throw error;
    return generationFailure(vaultBase, ['generation backup unreadable'], null, generation.state);
  }
  if (backup.status !== 'ok' || backup.events.length !== generation.state.source_event_count) {
    return generationFailure(vaultBase, [
      ...backup.errors.map((error) => `backup line ${error.line}: ${error.message}`),
      'generation backup event count mismatch',
    ], null, generation.state);
  }
  const anchor = backup.events.at(-1);
  if (!anchor
      || anchor.event_id !== generation.state.anchor_event_id
      || memorySha256(canonicalMemoryJson(anchor)) !== generation.state.anchor_payload_hash) {
    return generationFailure(vaultBase, ['generation backup anchor mismatch'], null, generation.state);
  }

  const active = readActiveMemoryLedger(vaultBase);
  if (active.status !== 'ok') return generationFailure(vaultBase, active.errors.map((error) => error.message), active, generation.state);
  if (!active.events.length) return generationFailure(vaultBase, ['active generation is missing its anchor event'], active, generation.state);
  const activeAnchor = active.events[0];
  if (canonicalMemoryJson(activeAnchor) !== canonicalMemoryJson(anchor)
      || memorySha256(`${canonicalMemoryJson(activeAnchor)}\n`) !== generation.state.active_ledger_hash) {
    return generationFailure(vaultBase, ['active generation anchor mismatch'], active, generation.state);
  }

  const events = [...backup.events];
  const eventIds = new Set(backup.eventIds);
  const errors = [];
  for (let index = 1; index < active.events.length; index += 1) {
    const event = active.events[index];
    if (eventIds.has(event.event_id)) {
      const previous = backup.eventPayloads.get(event.event_id);
      errors.push(ledgerError(
        generation.state.source_event_count + index,
        previous === canonicalMemoryJson(event)
          ? `duplicate event_id across generation boundary: ${event.event_id}`
          : `event_id collision across generation boundary: ${event.event_id}`,
      ));
      continue;
    }
    eventIds.add(event.event_id);
    events.push(event);
  }
  if (errors.length) return generationFailure(vaultBase, errors.map((error) => error.message), active, generation.state);

  const tail = active.events.slice(1);
  const tailRaw = tail.map((event) => canonicalMemoryJson(event)).join('\n') + (tail.length ? '\n' : '');
  return {
    status: 'ok',
    path: active.path,
    raw: `${backup.raw}${tailRaw}`,
    events,
    eventIds,
    errors: [],
    generation: generation.state,
    backupPath: backup.path,
    activeRaw: active.raw,
    activeEvents: active.events,
    activeTailEvents: tail,
  };
}

export function memoryLedgerGenerationStatus(vaultBase) {
  const generation = readMemoryLedgerGeneration(vaultBase);
  const journal = readMemoryRotationJournal(vaultBase);
  const receipts = readMemoryRotationReceipts(vaultBase);
  const ledger = readMemoryLedger(vaultBase);
  let backupBytes = 0;
  if (generation.status === 'ok') {
    try { backupBytes = Number(statSync(backupPath(vaultBase, generation.state.backup_file)).size || 0); } catch { /* reported by ledger */ }
  }
  return {
    status: ledger.status,
    generation: generation.status === 'ok' ? generation.state.generation : 0,
    operationId: generation.status === 'ok' ? generation.state.operation_id : null,
    sourceEvents: generation.status === 'ok' ? generation.state.source_event_count : 0,
    activeTailEvents: ledger.status === 'ok' ? Number(ledger.activeTailEvents?.length || 0) : 0,
    backupBytes,
    journal: journal.status === 'ok' ? journal.journal.stage : journal.status,
    receipts: receipts.receipts.length,
    receiptCheckpoint: receipts.checkpointStatus,
    errors: ledger.errors.map((error) => error.message),
  };
}
