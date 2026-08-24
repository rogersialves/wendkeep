import { createHash, randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RECORD_KEYS = [
  'schema_version',
  'sequence',
  'receipt_id',
  'previous_hash',
  'receipt_hash',
  'kind',
  'subject',
  'claims',
  'observations',
  'recorded_at',
];
const DRAFT_KEYS = ['kind', 'subject', 'claims', 'observations', 'recorded_at'];
const CHECKPOINT_KEYS = [
  'schema_version', 'last_sequence', 'last_hash', 'ledger_byte_length',
];
const DEFAULT_LOCK_LEASE_MS = 30_000;
const DEFAULT_LOCK_WAIT_MS = 5_000;
const MAX_LOCK_IDENTITY_CHANGE_RETRIES = 64;
const DIRECTORY_FSYNC_UNSUPPORTED = new Set([
  'EISDIR', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP',
]);
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function ledgerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sanitizedIoError(operation, error) {
  const nativeCode = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : 'UNKNOWN';
  const failure = ledgerError(
    'WENDKEEP_RECEIPT_LEDGER_IO',
    `Falha de I/O durante ${operation} (${nativeCode}).`,
  );
  failure.details = { operation, native_code: nativeCode };
  return failure;
}

function sanitizePublicError(error, operation) {
  if (typeof error?.code === 'string' && error.code.startsWith('WENDKEEP_RECEIPT_LEDGER_')) {
    return error;
  }
  return sanitizedIoError(operation, error);
}

function sleepSync(milliseconds) {
  if (milliseconds > 0) Atomics.wait(SLEEP_CELL, 0, 0, milliseconds);
}

function corrupt(message) {
  return ledgerError('WENDKEEP_RECEIPT_LEDGER_CORRUPT', message);
}

function truncated(message) {
  return ledgerError('WENDKEEP_RECEIPT_LEDGER_TRUNCATED', message);
}

function canonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw corrupt('Receipt contém número não finito.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw corrupt('Receipt contém valor não serializável.');
  if (typeof value.toJSON === 'function') return canonicalValue(value.toJSON(), seen);
  if (seen.has(value)) throw corrupt('Receipt contém referência circular.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalValue(item, seen));
    const normalized = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw corrupt('Receipt contém campo indefinido.');
      normalized[key] = canonicalValue(value[key], seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function legacyBytes(legacyPrefix) {
  if (Buffer.isBuffer(legacyPrefix)) return legacyPrefix;
  if (typeof legacyPrefix === 'string') return Buffer.from(legacyPrefix, 'utf8');
  if (legacyPrefix === undefined || legacyPrefix === null) return Buffer.alloc(0);
  return Buffer.from(canonicalJson(legacyPrefix), 'utf8');
}

export function receiptGenesisHash(legacyPrefix = '') {
  return sha256(legacyBytes(legacyPrefix));
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw corrupt(`${label} deve ser um objeto.`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw corrupt(`${label} contém campos ausentes ou desconhecidos.`);
  }
}

function assertContainer(value, label) {
  if (!value || typeof value !== 'object') throw corrupt(`${label} deve ser objeto ou array JSON.`);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    throw corrupt(`${label} deve usar um objeto JSON simples.`);
  }
  canonicalJson(value);
}

function normalizedDraft(draft) {
  assertExactKeys(draft, DRAFT_KEYS, 'Draft do receipt');
  if (typeof draft.kind !== 'string' || !draft.kind.trim()) throw corrupt('kind deve ser string não vazia.');
  assertContainer(draft.subject, 'subject');
  assertContainer(draft.claims, 'claims');
  assertContainer(draft.observations, 'observations');
  if (typeof draft.recorded_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(draft.recorded_at)
    || !Number.isFinite(Date.parse(draft.recorded_at))) {
    throw corrupt('recorded_at deve ser um timestamp válido.');
  }
  return JSON.parse(canonicalJson(draft));
}

function receiptIdentity(draft) {
  return sha256(canonicalJson({ kind: draft.kind, subject: draft.subject }));
}

function logicalContent(value) {
  return canonicalJson({
    kind: value.kind,
    subject: value.subject,
    claims: value.claims,
    observations: value.observations,
  });
}

function hashableRecord(record) {
  return {
    schema_version: record.schema_version,
    sequence: record.sequence,
    receipt_id: record.receipt_id,
    previous_hash: record.previous_hash,
    kind: record.kind,
    subject: record.subject,
    claims: record.claims,
    observations: record.observations,
    recorded_at: record.recorded_at,
  };
}

export function buildReceiptRecord(draft, { sequence, previousHash }) {
  const logical = normalizedDraft(draft);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw corrupt('sequence deve ser inteiro positivo.');
  if (typeof previousHash !== 'string' || !HASH_PATTERN.test(previousHash)) {
    throw corrupt('previous_hash deve usar sha256:<64hex>.');
  }
  const base = {
    schema_version: 2,
    sequence,
    receipt_id: receiptIdentity(logical),
    previous_hash: previousHash,
    kind: logical.kind,
    subject: logical.subject,
    claims: logical.claims,
    observations: logical.observations,
    recorded_at: logical.recorded_at,
  };
  return {
    schema_version: base.schema_version,
    sequence: base.sequence,
    receipt_id: base.receipt_id,
    previous_hash: base.previous_hash,
    receipt_hash: sha256(canonicalJson(base)),
    kind: base.kind,
    subject: base.subject,
    claims: base.claims,
    observations: base.observations,
    recorded_at: base.recorded_at,
  };
}

function validateCheckpoint(checkpoint) {
  assertExactKeys(checkpoint, CHECKPOINT_KEYS, 'Checkpoint do ledger');
  if (checkpoint.schema_version !== 2) throw corrupt('Checkpoint usa schema_version incompatível.');
  if (!Number.isSafeInteger(checkpoint.last_sequence) || checkpoint.last_sequence < 1) {
    throw corrupt('Checkpoint contém last_sequence inválida.');
  }
  if (!HASH_PATTERN.test(checkpoint.last_hash || '')) throw corrupt('Checkpoint contém last_hash inválido.');
  if (!Number.isSafeInteger(checkpoint.ledger_byte_length) || checkpoint.ledger_byte_length < 1) {
    throw corrupt('Checkpoint contém ledger_byte_length inválido.');
  }
}

export function verifyReceiptChain({ records, checkpoint = null, legacyPrefix = '' }) {
  if (!Array.isArray(records)) throw corrupt('Ledger deve ser uma lista de records.');
  let previousHash = receiptGenesisHash(legacyPrefix);
  const identities = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    assertExactKeys(record, RECORD_KEYS, `Receipt ${index + 1}`);
    if (record.schema_version !== 2) throw corrupt(`Receipt ${index + 1} usa schema_version incompatível.`);
    if (record.sequence !== index + 1) throw corrupt(`Receipt ${index + 1} quebra a sequência monotônica.`);
    if (record.previous_hash !== previousHash) throw corrupt(`Receipt ${index + 1} quebra previous_hash.`);
    const draft = normalizedDraft({
      kind: record.kind,
      subject: record.subject,
      claims: record.claims,
      observations: record.observations,
      recorded_at: record.recorded_at,
    });
    if (record.receipt_id !== receiptIdentity(draft)) throw corrupt(`Receipt ${index + 1} tem receipt_id inválido.`);
    if (identities.has(record.receipt_id)) throw corrupt(`Receipt ${index + 1} repete receipt_id.`);
    identities.add(record.receipt_id);
    const expectedHash = sha256(canonicalJson(hashableRecord(record)));
    if (record.receipt_hash !== expectedHash) throw corrupt(`Receipt ${index + 1} tem receipt_hash inválido.`);
    previousHash = record.receipt_hash;
  }

  let checkpointStatus = 'absent';
  if (checkpoint !== null && checkpoint !== undefined) {
    validateCheckpoint(checkpoint);
    if (checkpoint.last_sequence > records.length) {
      throw truncated('Checkpoint prova que records foram removidos do tail do ledger.');
    }
    const anchored = records[checkpoint.last_sequence - 1];
    if (!anchored || anchored.receipt_hash !== checkpoint.last_hash) {
      throw corrupt('Checkpoint não corresponde ao prefixo do ledger.');
    }
    checkpointStatus = checkpoint.last_sequence === records.length ? 'current' : 'lagging';
  }
  return {
    ok: true,
    checkpoint_status: checkpointStatus,
    last_sequence: records.length,
    last_hash: records.length ? records.at(-1).receipt_hash : receiptGenesisHash(legacyPrefix),
  };
}

function pathInside(rootPath, targetPath) {
  const rel = relative(rootPath, targetPath);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function assertNoSymlinkAncestors(targetPath, fs) {
  const absolute = resolve(targetPath);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw corrupt('Path inseguro usa symlink.');
  }
}

function storePathLabel(store, targetPath) {
  const target = resolve(targetPath);
  if (store?.ledgerPath && target === resolve(store.ledgerPath)) return 'ledger';
  if (store?.checkpointPath && target === resolve(store.checkpointPath)) return 'checkpoint';
  if (store?.legacyPath && target === resolve(store.legacyPath)) return 'legacy ledger';
  if (store?.lockPath && target === resolve(store.lockPath)) return 'lock';
  return 'runtime file';
}

function assertSafeFile(store, targetPath, { allowMissing = true } = {}) {
  const target = resolve(targetPath);
  const label = storePathLabel(store, target);
  if (!pathInside(store.rootPath, target)) throw corrupt(`Path do ${label} escapa do runtime do ledger.`);
  assertNoSymlinkAncestors(dirname(target), store.fs);
  if (!store.fs.existsSync(target)) {
    if (!allowMissing) throw corrupt(`Arquivo obrigatório ausente no ${label}.`);
    return { exists: false, target };
  }
  let stat;
  try {
    stat = store.fs.lstatSync(target);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return { exists: false, target };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw corrupt(`Path do ${label} não é arquivo regular.`);
  if (stat.nlink !== 1) throw corrupt(`Path do ${label} possui hardlinks.`);
  let real;
  try {
    real = resolve(store.fs.realpathSync(target));
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return { exists: false, target };
    throw error;
  }
  if (!pathInside(store.rootPath, real)) throw corrupt(`Path real do ${label} escapa do runtime do ledger.`);
  return { exists: true, target };
}

function secureReadSnapshot(store, targetPath, {
  encoding = 'utf8',
  allowIdentityChange = false,
} = {}) {
  const checked = assertSafeFile(store, targetPath);
  if (!checked.exists) {
    return {
      exists: false,
      content: encoding === null ? Buffer.alloc(0) : '',
      identity: null,
    };
  }
  const flags = store.fs.constants.O_RDONLY | (store.fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = store.fs.openSync(checked.target, flags);
    const opened = store.fs.fstatSync(descriptor);
    const linked = store.fs.lstatSync(checked.target);
    const real = resolve(store.fs.realpathSync(checked.target));
    if (!opened.isFile() || !pathInside(store.rootPath, real)) {
      throw corrupt(`Arquivo do ${storePathLabel(store, checked.target)} foi trocado ou escapou durante a abertura.`);
    }
    if (opened.nlink !== 1) {
      if (allowIdentityChange && opened.nlink === 0) {
        return { exists: true, changed: true, content: '', identity: null };
      }
      throw corrupt(`Arquivo do ${storePathLabel(store, checked.target)} foi trocado ou escapou durante a abertura.`);
    }
    if (!sameFileIdentity(opened, linked)) {
      if (allowIdentityChange) {
        return { exists: true, changed: true, content: '', identity: null };
      }
      throw corrupt(`Arquivo do ${storePathLabel(store, checked.target)} foi trocado ou escapou durante a abertura.`);
    }
    const content = encoding === null
      ? store.fs.readFileSync(descriptor)
      : store.fs.readFileSync(descriptor, encoding);
    const after = store.fs.lstatSync(checked.target);
    if (!sameFileIdentity(opened, after) || after.nlink !== 1) {
      if (allowIdentityChange && after.nlink === 1) {
        return { exists: true, changed: true, content: '', identity: null };
      }
      throw corrupt(`Arquivo do ${storePathLabel(store, checked.target)} foi trocado durante a leitura.`);
    }
    return {
      exists: true,
      content,
      identity: {
        dev: after.dev,
        ino: after.ino,
        mtime_ms: after.mtimeMs,
      },
    };
  } finally {
    if (descriptor !== undefined) store.fs.closeSync(descriptor);
  }
}

function secureRead(store, targetPath, options) {
  return secureReadSnapshot(store, targetPath, options).content;
}

function fsyncDirectory(store) {
  let descriptor;
  try {
    descriptor = store.fs.openSync(store.rootPath, 'r');
    store.fs.fsyncSync(descriptor);
  } catch (error) {
    const unsupported = DIRECTORY_FSYNC_UNSUPPORTED.has(error?.code)
      || (process.platform === 'win32' && error?.code === 'EPERM');
    if (!unsupported) {
      throw sanitizedIoError('sincronização do diretório do ledger', error);
    }
    // Some platforms explicitly do not support opening/fsyncing directories.
    // Only those documented capability errors may fall back to file fsync.
  } finally {
    if (descriptor !== undefined) {
      try { store.fs.closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

function atomicWrite(store, targetPath, content) {
  const target = assertSafeFile(store, targetPath).target;
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  assertSafeFile(store, temporary);
  let descriptor;
  let temporaryExists = false;
  try {
    descriptor = store.fs.openSync(temporary, 'wx');
    temporaryExists = true;
    store.fs.writeFileSync(descriptor, content, 'utf8');
    store.fs.fsyncSync(descriptor);
    store.fs.closeSync(descriptor);
    descriptor = undefined;
    assertSafeFile(store, temporary, { allowMissing: false });
    assertSafeFile(store, target);
    store.fs.renameSync(temporary, target);
    temporaryExists = false;
    fsyncDirectory(store);
    assertSafeFile(store, target, { allowMissing: false });
  } finally {
    if (descriptor !== undefined) {
      try { store.fs.closeSync(descriptor); } catch { /* original error wins */ }
    }
    if (temporaryExists) {
      try {
        assertSafeFile(store, temporary, { allowMissing: false });
        store.fs.unlinkSync(temporary);
      } catch { /* private temporary remains recoverable */ }
    }
  }
}

function lockState(store, { allowIdentityChange = false } = {}) {
  let snapshot;
  try {
    snapshot = secureReadSnapshot(store, store.lockPath, { allowIdentityChange });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { status: 'missing', exists: false, content: '', identity: null };
    }
    throw error;
  }
  if (snapshot.changed) return { status: 'changed', ...snapshot };
  if (!snapshot.exists) return { status: 'missing', ...snapshot };
  const raw = snapshot.content;
  if (!raw) return { status: 'publishing', ...snapshot };
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.schema_version !== 1
      || typeof parsed.owner_token !== 'string'
      || !parsed.owner_token
      || !Number.isSafeInteger(parsed.owner_pid)
      || typeof parsed.lease_expires_at !== 'string'
      || !Number.isFinite(Date.parse(parsed.lease_expires_at))) {
      return { status: 'invalid', owner: parsed, ...snapshot };
    }
    return { status: 'valid', owner: parsed, ...snapshot };
  } catch {
    return { status: 'publishing', ...snapshot };
  }
}

function sameFileIdentity(left, right) {
  if (!left || !right || left.ino !== right.ino) return false;
  if (left.dev === right.dev) return true;
  return process.platform === 'win32' && (left.dev === 0 || right.dev === 0);
}

function sameLockSnapshot(expected, observed) {
  if (!expected?.exists || !observed?.exists) return false;
  if (!sameFileIdentity(expected.identity, observed.identity)) return false;
  if (expected.content !== observed.content) return false;
  if (expected.status === 'valid') {
    return observed.status === 'valid'
      && observed.owner.owner_token === expected.owner.owner_token;
  }
  return observed.status === expected.status;
}

function removeLockIfUnchanged(store, expected) {
  const observed = lockState(store);
  if (!sameLockSnapshot(expected, observed)) return false;
  store.fs.unlinkSync(store.lockPath);
  fsyncDirectory(store);
  return true;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function lockIsStale(state, now) {
  return Date.parse(state.lease_expires_at) <= now && !processIsAlive(state.owner_pid);
}

function busyLock(details = {}) {
  const error = ledgerError(
    'WENDKEEP_RECEIPT_LEDGER_BUSY',
    'Outro produtor mantém o lock exclusivo do ledger.',
  );
  error.details = { lock: 'active', ...details };
  return error;
}

function acquireLock(store) {
  const target = resolve(store.lockPath);
  const token = randomUUID();
  const deadline = store.now() + store.lockWaitMs;
  let identityChangeRetries = 0;
  for (;;) {
    // Validate the parent chain before the atomic create. O_EXCL/O_NOFOLLOW
    // makes a replacement race fail closed instead of following a symlink.
    // Do not preflight the lock file itself: another owner may create or
    // remove it between lstat and open. The atomic create below is the
    // authority; only the ancestor chain needs a preflight here.
    assertNoSymlinkAncestors(dirname(target), store.fs);
    let descriptor;
    try {
      const flags = store.fs.constants.O_WRONLY
        | store.fs.constants.O_CREAT
        | store.fs.constants.O_EXCL
        | (store.fs.constants.O_NOFOLLOW || 0);
      descriptor = store.fs.openSync(target, flags, 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const state = lockState(store, { allowIdentityChange: true });
      const now = store.now();
      if (state.status === 'missing') continue;
      if (state.status === 'changed') {
        identityChangeRetries += 1;
        if (now >= deadline || identityChangeRetries > MAX_LOCK_IDENTITY_CHANGE_RETRIES) {
          throw busyLock({ lock: 'changed' });
        }
        sleepSync(Math.min(5, Math.max(1, deadline - now)));
        continue;
      }
      if (state.status === 'invalid') throw busyLock();
      if (state.status === 'publishing') {
        const safeAfter = state.identity.mtime_ms + store.lockLeaseMs;
        if (now >= safeAfter) {
          try {
            if (removeLockIfUnchanged(store, state)) continue;
          } catch (unlinkError) {
            if (unlinkError?.code !== 'ENOENT') {
              if (unlinkError?.code?.startsWith('WENDKEEP_RECEIPT_LEDGER_')) throw unlinkError;
              throw busyLock({ lock: 'publishing' });
            }
          }
        }
        if (now >= deadline) throw busyLock({ lock: 'publishing' });
        sleepSync(Math.min(25, Math.max(1, Math.min(deadline, safeAfter) - now)));
        continue;
      }
      if (lockIsStale(state.owner, now)) {
        try {
          if (removeLockIfUnchanged(store, state)) continue;
        } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') {
            if (unlinkError?.code?.startsWith('WENDKEEP_RECEIPT_LEDGER_')) throw unlinkError;
            throw busyLock({ lock: 'stale' });
          }
        }
        if (now >= deadline) throw busyLock({ lock: 'stale' });
        sleepSync(Math.min(25, Math.max(1, deadline - now)));
        continue;
      }
      if (now >= deadline) {
        throw busyLock({ lease_expires_at: state.owner.lease_expires_at });
      }
      sleepSync(Math.min(25, Math.max(1, deadline - now)));
      continue;
    }
    const now = store.now();
    const payload = {
      schema_version: 1,
      owner_token: token,
      owner_pid: process.pid,
      acquired_at: new Date(now).toISOString(),
      lease_expires_at: new Date(now + store.lockLeaseMs).toISOString(),
    };
    try {
      store.fs.writeFileSync(descriptor, `${JSON.stringify(payload)}\n`, 'utf8');
      store.fs.fsyncSync(descriptor);
      store.fs.closeSync(descriptor);
      descriptor = undefined;
      fsyncDirectory(store);
      assertSafeFile(store, target, { allowMissing: false });
      return token;
    } catch (error) {
      if (descriptor !== undefined) {
        try { store.fs.closeSync(descriptor); } catch { /* original error wins */ }
      }
      try { store.fs.unlinkSync(target); } catch { /* original error wins */ }
      throw error;
    }
  }
}

function releaseLock(store, token) {
  const state = lockState(store);
  if (state.status !== 'valid' || state.owner.owner_token !== token) {
    throw corrupt('O lock do ledger mudou de proprietário durante o append.');
  }
  if (!removeLockIfUnchanged(store, state)) {
    throw corrupt('O lock do ledger mudou de proprietário durante o append.');
  }
}

function parseLedger(content) {
  if (!content) return { records: [], byteOffsets: [] };
  if (!content.endsWith('\n')) throw truncated('Ledger termina com JSON parcial ou sem newline de commit.');
  const physicalLines = content.match(/[^\n]*\n/g) || [];
  const records = [];
  const byteOffsets = [];
  let bytes = 0;
  for (let index = 0; index < physicalLines.length; index += 1) {
    const physical = physicalLines[index];
    bytes += Buffer.byteLength(physical, 'utf8');
    byteOffsets.push(bytes);
    const json = physical.slice(0, -1).replace(/\r$/, '');
    if (!json) throw corrupt(`Ledger contém linha vazia na posição ${index + 1}.`);
    try {
      records.push(JSON.parse(json));
    } catch (error) {
      throw corrupt(`Ledger contém JSON inválido na linha ${index + 1}.`, error);
    }
  }
  return { records, byteOffsets };
}

function parseCheckpoint(content) {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch (error) {
    throw corrupt('Checkpoint contém JSON inválido.', error);
  }
}

function createFileReceiptStoreInternal({
  ledgerPath,
  checkpointPath = `${ledgerPath}.checkpoint.json`,
  legacyPath = `${ledgerPath}.legacy.jsonl`,
  lockPath = `${ledgerPath}.lock`,
  lockLeaseMs = DEFAULT_LOCK_LEASE_MS,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
  now = () => Date.now(),
  fsAdapter = {},
}) {
  if (!ledgerPath) throw corrupt('ledgerPath é obrigatório.');
  if (!Number.isSafeInteger(lockLeaseMs) || lockLeaseMs < 1) throw corrupt('lockLeaseMs inválido.');
  if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0) throw corrupt('lockWaitMs inválido.');
  if (typeof now !== 'function') throw corrupt('clock do lock inválido.');
  const fs = { ...nodeFs, ...fsAdapter };
  const resolvedLedger = resolve(ledgerPath);
  const rootPath = dirname(resolvedLedger);
  assertNoSymlinkAncestors(rootPath, fs);
  fs.mkdirSync(rootPath, { recursive: true });
  assertNoSymlinkAncestors(rootPath, fs);
  const rootStat = fs.lstatSync(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw corrupt('Runtime do ledger não é diretório seguro.');
  const realRoot = resolve(fs.realpathSync(rootPath));
  if (realRoot.toLowerCase() !== rootPath.toLowerCase()) throw corrupt('Runtime do ledger resolve por alias ou symlink.');
  const store = {
    ledgerPath: resolvedLedger,
    checkpointPath: resolve(checkpointPath),
    legacyPath: resolve(legacyPath),
    lockPath: resolve(lockPath),
    lockLeaseMs,
    lockWaitMs,
    now,
    rootPath,
    fs,
  };
  for (const path of [store.ledgerPath, store.checkpointPath, store.legacyPath, store.lockPath]) {
    if (!pathInside(rootPath, path)) throw corrupt('Path do store escapa do runtime.');
    assertSafeFile(store, path);
  }
  return Object.freeze(store);
}

export function createFileReceiptStore(options) {
  try {
    return createFileReceiptStoreInternal(options);
  } catch (error) {
    throw sanitizePublicError(error, 'inicialização do ledger');
  }
}

function readReceiptLedgerUnlocked({ store }) {
  if (!store?.ledgerPath || !store?.fs) throw corrupt('Store de receipts inválido.');
  const legacyBytesRaw = secureRead(store, store.legacyPath, { encoding: null });
  const raw = secureRead(store, store.ledgerPath);
  const checkpointRaw = secureRead(store, store.checkpointPath);
  if (raw && !checkpointRaw) {
    throw truncated('Ledger não vazio está sem checkpoint obrigatório.');
  }
  const checkpoint = parseCheckpoint(checkpointRaw);
  const { records, byteOffsets } = parseLedger(raw);
  const verified = verifyReceiptChain({ records, checkpoint, legacyPrefix: legacyBytesRaw });
  let checkpointStatus = verified.checkpoint_status;
  if (checkpoint) {
    const totalBytes = Buffer.byteLength(raw, 'utf8');
    if (checkpoint.ledger_byte_length > totalBytes) {
      throw truncated('Checkpoint prova truncamento de bytes no tail do ledger.');
    }
    const expectedBoundary = byteOffsets[checkpoint.last_sequence - 1];
    if (checkpoint.ledger_byte_length !== expectedBoundary) {
      throw corrupt('ledger_byte_length do checkpoint não coincide com a fronteira de um record.');
    }
    if (checkpoint.last_sequence === records.length && checkpoint.ledger_byte_length !== totalBytes) {
      throw corrupt('Checkpoint declara o último record, mas não cobre todos os bytes do ledger.');
    }
    if (checkpoint.last_sequence < records.length && checkpoint.ledger_byte_length >= totalBytes) {
      throw corrupt('Checkpoint atrasado não deixa um tail adicional verificável.');
    }
    checkpointStatus = checkpoint.last_sequence === records.length ? 'current' : 'lagging';
  }
  return {
    records,
    checkpoint,
    checkpoint_status: checkpointStatus,
    legacy_prefix: legacyBytesRaw.toString('utf8'),
    raw,
    last_sequence: verified.last_sequence,
    last_hash: verified.last_hash,
  };
}

function readReceiptLedgerInternal({ store, assumeLocked = false }) {
  if (assumeLocked) return readReceiptLedgerUnlocked({ store });
  const token = acquireLock(store);
  try {
    return readReceiptLedgerUnlocked({ store });
  } finally {
    releaseLock(store, token);
  }
}

export function readReceiptLedger(options) {
  try {
    return readReceiptLedgerInternal(options);
  } catch (error) {
    throw sanitizePublicError(error, 'leitura do ledger');
  }
}

function checkpointFor(raw, record) {
  return {
    schema_version: 2,
    last_sequence: record.sequence,
    last_hash: record.receipt_hash,
    ledger_byte_length: Buffer.byteLength(raw, 'utf8'),
  };
}

function publishCheckpoint(store, raw, record) {
  atomicWrite(store, store.checkpointPath, `${JSON.stringify(checkpointFor(raw, record))}\n`);
}

function appendReceiptInternal({ store, draft }) {
  const logical = normalizedDraft(draft);
  const receiptId = receiptIdentity(logical);
  const token = acquireLock(store);
  try {
    const current = readReceiptLedger({ store, assumeLocked: true });
    const existing = current.records.find((record) => record.receipt_id === receiptId);
    if (existing) {
      if (logicalContent(existing) !== logicalContent(logical)) {
        throw ledgerError(
          'WENDKEEP_RECEIPT_LEDGER_CONFLICT',
          `receipt_id ${receiptId} já existe com claims ou observations diferentes.`,
        );
      }
      if (current.checkpoint_status !== 'current') publishCheckpoint(store, current.raw, current.records.at(-1));
      return { record: existing, idempotent: true, checkpoint_recovered: current.checkpoint_status !== 'current' };
    }
    const record = buildReceiptRecord(logical, {
      sequence: current.records.length + 1,
      previousHash: current.last_hash,
    });
    const raw = `${current.raw}${JSON.stringify(record)}\n`;
    atomicWrite(store, store.ledgerPath, raw);
    publishCheckpoint(store, raw, record);
    return { record, idempotent: false, checkpoint_recovered: current.checkpoint_status === 'lagging' };
  } finally {
    releaseLock(store, token);
  }
}

export function appendReceipt(options) {
  try {
    return appendReceiptInternal(options);
  } catch (error) {
    throw sanitizePublicError(error, 'append do ledger');
  }
}
