import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  appendReceipt,
  buildReceiptRecord,
  createFileReceiptStore,
  readReceiptLedger,
  receiptGenesisHash,
  verifyReceiptChain,
} from '../src/receipt-ledger.mjs';

function fixture({ legacy = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wk-receipt-ledger-'));
  const runtime = join(root, 'runtime');
  mkdirSync(runtime, { recursive: true });
  const ledgerPath = join(runtime, 'receipts.v2.jsonl');
  const checkpointPath = join(runtime, 'receipts.v2.checkpoint.json');
  const legacyPath = join(runtime, 'receipts.jsonl');
  const lockPath = join(runtime, 'receipts.v2.lock');
  if (legacy) writeFileSync(legacyPath, legacy, 'utf8');
  const store = createFileReceiptStore({ ledgerPath, checkpointPath, legacyPath, lockPath });
  return { root, runtime, ledgerPath, checkpointPath, legacyPath, lockPath, store };
}

function cleanup(f) {
  rmSync(f.root, { recursive: true, force: true });
}

function statWithDeviceId(stat, dev) {
  return new Proxy(stat, {
    get(target, property) {
      if (property === 'dev') return dev;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function statWithInode(stat, ino) {
  return new Proxy(stat, {
    get(target, property) {
      if (property === 'ino') return ino;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function line(record) {
  return `${JSON.stringify(record)}\n`;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_MODULE = pathToFileURL(join(ROOT, 'src', 'receipt-ledger.mjs')).href;
const OPEN_FILE_REPLACEMENT_UNSUPPORTED = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

function childAppend(f, id, options = {}) {
  const code = `
    import { appendReceipt, createFileReceiptStore } from ${JSON.stringify(LEDGER_MODULE)};
    const store = createFileReceiptStore({
      ledgerPath: process.env.WK_LEDGER,
      checkpointPath: process.env.WK_CHECKPOINT,
      legacyPath: process.env.WK_LEGACY,
      lockPath: process.env.WK_LOCK,
      lockWaitMs: Number(process.env.WK_LOCK_WAIT),
      lockLeaseMs: Number(process.env.WK_LOCK_LEASE),
    });
    appendReceipt({ store, draft: JSON.parse(process.env.WK_DRAFT) });
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        WK_LEDGER: f.ledgerPath,
        WK_CHECKPOINT: f.checkpointPath,
        WK_LEGACY: f.legacyPath,
        WK_LOCK: f.lockPath,
        WK_DRAFT: JSON.stringify(draft(id)),
        WK_LOCK_WAIT: String(options.lockWaitMs ?? 5000),
        WK_LOCK_LEASE: String(options.lockLeaseMs ?? 30000),
      },
    });
    let stderr = '';
    let timedOut = false;
    const timer = options.killAfterMs ? setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.killAfterMs) : null;
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (status, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ status, signal, stderr, timedOut });
    });
  });
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function draft(id, overrides = {}) {
  return {
    kind: 'delivery',
    subject: { operation_id: id, outcome: 'completed' },
    claims: { target_commit: 'a'.repeat(40) },
    observations: { ci: 'verified' },
    recorded_at: '2026-08-23T12:00:00.000Z',
    ...overrides,
  };
}

test('[req:PROV-7] canonical records have deterministic logical IDs and a verifiable hash chain', () => {
  const logical = draft('delivery-42');
  const genesis = receiptGenesisHash('');
  const first = buildReceiptRecord(logical, { sequence: 1, previousHash: genesis });
  const reordered = buildReceiptRecord({
    recorded_at: logical.recorded_at,
    observations: { ci: 'verified' },
    claims: { target_commit: 'a'.repeat(40) },
    subject: { outcome: 'completed', operation_id: 'delivery-42' },
    kind: 'delivery',
  }, {
    sequence: 1, previousHash: genesis,
  });
  const second = buildReceiptRecord(draft('delivery-43'), {
    sequence: 2, previousHash: first.receipt_hash,
  });

  assert.equal(first.schema_version, 2);
  assert.equal(first.receipt_id, reordered.receipt_id);
  assert.equal(first.receipt_hash, reordered.receipt_hash);
  assert.equal(second.previous_hash, first.receipt_hash);
  assert.deepEqual(verifyReceiptChain({ records: [first, second], legacyPrefix: '' }), {
    ok: true,
    checkpoint_status: 'absent',
    last_sequence: 2,
    last_hash: second.receipt_hash,
  });
});

test('[req:PROV-7] canonical JSON preserves an own __proto__ field instead of collapsing distinct content', () => {
  const claims = {};
  Object.defineProperty(claims, '__proto__', {
    value: { authority: 'foreign' }, enumerable: true, configurable: true,
  });
  const withProto = buildReceiptRecord(draft('proto', { claims }), {
    sequence: 1, previousHash: receiptGenesisHash(''),
  });
  const withoutProto = buildReceiptRecord(draft('proto', { claims: {} }), {
    sequence: 1, previousHash: receiptGenesisHash(''),
  });

  assert.equal(Object.hasOwn(withProto.claims, '__proto__'), true);
  assert.deepEqual(withProto.claims.__proto__, { authority: 'foreign' });
  assert.notEqual(withProto.receipt_hash, withoutProto.receipt_hash);
});

test('[req:PROV-7] append persists ledger and checkpoint atomically and replays equal content idempotently', () => {
  const f = fixture();
  try {
    const logical = draft('delivery-42');
    const first = appendReceipt({ store: f.store, draft: logical });
    const ledgerBefore = readFileSync(f.ledgerPath, 'utf8');
    const checkpointBefore = readFileSync(f.checkpointPath, 'utf8');
    const replay = appendReceipt({ store: f.store, draft: {
      ...logical,
      recorded_at: '2026-08-23T12:01:00.000Z',
      subject: { outcome: 'completed', operation_id: 'delivery-42' },
    } });

    assert.equal(first.idempotent, false);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.record.receipt_hash, first.record.receipt_hash);
    assert.equal(readFileSync(f.ledgerPath, 'utf8'), ledgerBefore);
    assert.equal(readFileSync(f.checkpointPath, 'utf8'), checkpointBefore);
    const checkpoint = JSON.parse(checkpointBefore);
    assert.equal(checkpoint.last_sequence, 1);
    assert.equal(checkpoint.last_hash, first.record.receipt_hash);
    assert.equal(checkpoint.ledger_byte_length, Buffer.byteLength(ledgerBefore));
  } finally { cleanup(f); }
});

test('[req:PROV-7] append rejects a semantic ID reused with different logical content', () => {
  const f = fixture();
  try {
    appendReceipt({ store: f.store, draft: draft('delivery-42') });
    assert.throws(
      () => appendReceipt({ store: f.store, draft: draft('delivery-42', { observations: { ci: 'failed' } }) }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CONFLICT',
    );
    assert.equal(readReceiptLedger({ store: f.store }).records.length, 1);
  } finally { cleanup(f); }
});

test('[req:PROV-7] an exclusive live lock fails busy without touching persisted bytes', () => {
  const f = fixture();
  try {
    appendReceipt({ store: f.store, draft: draft('first') });
    const before = readFileSync(f.ledgerPath);
    writeFileSync(f.lockPath, '{"owner":"other"}\n', { flag: 'wx' });
    assert.throws(
      () => appendReceipt({ store: f.store, draft: draft('second') }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_BUSY',
    );
    assert.deepEqual(readFileSync(f.ledgerPath), before);
    assert.equal(existsSync(f.lockPath), true);
  } finally { cleanup(f); }
});

test('[req:PROV-7] a delayed checkpoint publish is recovered only from a fully valid ledger tail', () => {
  const f = fixture();
  try {
    const first = appendReceipt({ store: f.store, draft: draft('first') });
    let checkpointRenameFailed = false;
    const faultAdapter = {
      renameSync(source, target) {
        if (target === f.checkpointPath && !checkpointRenameFailed) {
          checkpointRenameFailed = true;
          const error = new Error(`synthetic checkpoint publish crash at ${f.checkpointPath}`);
          error.code = 'EIO';
          throw error;
        }
        return f.store.fs.renameSync(source, target);
      },
    };
    const faultStore = createFileReceiptStore({
      ledgerPath: f.ledgerPath,
      checkpointPath: f.checkpointPath,
      legacyPath: f.legacyPath,
      lockPath: f.lockPath,
      fsAdapter: faultAdapter,
    });

    assert.throws(
      () => appendReceipt({ store: faultStore, draft: draft('second') }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_IO'
        && !String(error.message).includes(f.root)
        && error.cause === undefined,
    );
    const recovered = readReceiptLedger({ store: f.store });
    assert.equal(recovered.records.length, 2);
    assert.equal(recovered.checkpoint_status, 'lagging');
    assert.equal(recovered.checkpoint.last_hash, first.record.receipt_hash);

    const replay = appendReceipt({ store: f.store, draft: draft('second') });
    assert.equal(replay.idempotent, true);
    assert.equal(readReceiptLedger({ store: f.store }).checkpoint_status, 'current');
  } finally { cleanup(f); }
});

test('[req:PROV-7] checkpoint detects complete-line tail truncation', () => {
  const f = fixture();
  try {
    appendReceipt({ store: f.store, draft: draft('first') });
    appendReceipt({ store: f.store, draft: draft('second') });
    const [firstLine] = readFileSync(f.ledgerPath, 'utf8').trimEnd().split('\n');
    writeFileSync(f.ledgerPath, `${firstLine}\n`, 'utf8');

    assert.throws(
      () => readReceiptLedger({ store: f.store }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_TRUNCATED',
    );
  } finally { cleanup(f); }
});

test('[req:PROV-7] a non-empty ledger without its checkpoint is truncation, never bootstrap', () => {
  const f = fixture();
  try {
    appendReceipt({ store: f.store, draft: draft('first') });
    appendReceipt({ store: f.store, draft: draft('second') });
    const firstLine = `${readFileSync(f.ledgerPath, 'utf8').split('\n')[0]}\n`;
    rmSync(f.checkpointPath);
    writeFileSync(f.ledgerPath, firstLine, 'utf8');

    assert.throws(
      () => readReceiptLedger({ store: f.store }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_TRUNCATED',
    );
  } finally { cleanup(f); }
});

test('[req:PROV-7] partial JSON tails fail as truncation while malformed middle records fail as corruption', () => {
  const tail = fixture();
  const middle = fixture();
  try {
    appendReceipt({ store: tail.store, draft: draft('first') });
    writeFileSync(tail.ledgerPath, `${readFileSync(tail.ledgerPath, 'utf8')}{"schema_version":2`, 'utf8');
    assert.throws(
      () => readReceiptLedger({ store: tail.store }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_TRUNCATED',
    );

    appendReceipt({ store: middle.store, draft: draft('first') });
    writeFileSync(middle.ledgerPath, `${readFileSync(middle.ledgerPath, 'utf8')}not-json\n`, 'utf8');
    assert.throws(
      () => readReceiptLedger({ store: middle.store }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CORRUPT',
    );
  } finally {
    cleanup(tail);
    cleanup(middle);
  }
});

test('[req:PROV-7] tampering in the middle and incompatible checkpoints fail closed', () => {
  const tamper = fixture();
  const checkpoint = fixture();
  try {
    appendReceipt({ store: tamper.store, draft: draft('first') });
    appendReceipt({ store: tamper.store, draft: draft('second') });
    const records = readFileSync(tamper.ledgerPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
    records[0].claims.target_commit = 'b'.repeat(40);
    writeFileSync(tamper.ledgerPath, records.map(JSON.stringify).join('\n') + '\n', 'utf8');
    assert.throws(
      () => readReceiptLedger({ store: tamper.store }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CORRUPT',
    );

    appendReceipt({ store: checkpoint.store, draft: draft('first') });
    const value = JSON.parse(readFileSync(checkpoint.checkpointPath, 'utf8'));
    value.last_hash = `sha256:${'0'.repeat(64)}`;
    writeFileSync(checkpoint.checkpointPath, `${JSON.stringify(value)}\n`, 'utf8');
    assert.throws(
      () => readReceiptLedger({ store: checkpoint.store }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CORRUPT',
    );
  } finally {
    cleanup(tamper);
    cleanup(checkpoint);
  }
});

test('[req:PROV-7] legacy v1 bytes remain read-only and anchor the first v2 receipt', () => {
  const legacy = `${JSON.stringify({ schema_version: 1, id: 'historical', outcome: 'completed' })}\n`;
  const f = fixture({ legacy });
  try {
    const result = appendReceipt({ store: f.store, draft: draft('current') });
    assert.equal(readFileSync(f.legacyPath, 'utf8'), legacy);
    assert.notEqual(result.record.previous_hash, '0'.repeat(64));
    assert.equal(readReceiptLedger({ store: f.store }).legacy_prefix, legacy);

    writeFileSync(f.legacyPath, legacy.replace('completed', 'abandoned'), 'utf8');
    assert.throws(
      () => readReceiptLedger({ store: f.store }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CORRUPT',
    );
  } finally { cleanup(f); }
});

test('[req:PROV-7] ledger, checkpoint and lock paths cannot escape their runtime through aliases', (t) => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-receipt-outside-'));
  try {
    const external = join(outside, 'external.jsonl');
    writeFileSync(external, 'outside sentinel\n', 'utf8');
    try {
      symlinkSync(external, f.ledgerPath, 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`symlink indisponível: ${error.code}`);
        return;
      }
      throw error;
    }
    const before = readFileSync(external);
    assert.throws(
      () => appendReceipt({ store: f.store, draft: draft('escape') }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CORRUPT',
    );
    assert.deepEqual(readFileSync(external), before);
  } finally {
    cleanup(f);
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:PROV-7] every mutable store path must remain below the ledger runtime', () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-receipt-path-escape-'));
  try {
    assert.throws(
      () => createFileReceiptStore({
        ledgerPath: f.ledgerPath,
        checkpointPath: join(outside, 'checkpoint.json'),
        legacyPath: f.legacyPath,
        lockPath: f.lockPath,
      }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CORRUPT',
    );
    assert.equal(existsSync(join(outside, 'checkpoint.json')), false);
  } finally {
    cleanup(f);
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:PROV-7] Windows accepts an unavailable device id when the inode still identifies the opened file', {
  skip: process.platform !== 'win32',
}, () => {
  const f = fixture();
  try {
    const originalLstat = f.store.fs.lstatSync;
    const store = createFileReceiptStore({
      ledgerPath: f.ledgerPath,
      checkpointPath: f.checkpointPath,
      legacyPath: f.legacyPath,
      lockPath: f.lockPath,
      fsAdapter: {
        lstatSync(path) {
          const stat = originalLstat(path);
          return statWithDeviceId(stat, 0);
        },
      },
    });

    const receipt = appendReceipt({ store, draft: draft('windows-zero-device') });
    assert.equal(receipt.record.sequence, 1);
    assert.equal(readReceiptLedger({ store }).records.length, 1);
  } finally { cleanup(f); }
});

test('[req:PROV-7] Windows still rejects a conflicting nonzero device id', {
  skip: process.platform !== 'win32',
}, () => {
  const f = fixture();
  try {
    const originalLstat = f.store.fs.lstatSync;
    const store = createFileReceiptStore({
      ledgerPath: f.ledgerPath,
      checkpointPath: f.checkpointPath,
      legacyPath: f.legacyPath,
      lockPath: f.lockPath,
      fsAdapter: {
        lstatSync(path) {
          const stat = originalLstat(path);
          return statWithDeviceId(stat, stat.dev + 1);
        },
      },
    });

    assert.throws(
      () => appendReceipt({ store, draft: draft('windows-conflicting-device') }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CORRUPT',
    );
  } finally { cleanup(f); }
});

test('[req:PROV-7] symlink-like ledger entries are rejected by the path policy on every platform', () => {
  const f = fixture();
  try {
    writeFileSync(f.ledgerPath, 'sentinel\n', 'utf8');
    const originalLstat = f.store.fs.lstatSync;
    assert.throws(
      () => createFileReceiptStore({
        ledgerPath: f.ledgerPath,
        checkpointPath: f.checkpointPath,
        legacyPath: f.legacyPath,
        lockPath: f.lockPath,
        fsAdapter: {
          lstatSync(path) {
            const stat = originalLstat(path);
            if (path === f.ledgerPath) return { ...stat, isSymbolicLink: () => true };
            return stat;
          },
        },
      }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CORRUPT' && /symlink|regular/i.test(error.message),
    );
    assert.equal(readFileSync(f.ledgerPath, 'utf8'), 'sentinel\n');
  } finally { cleanup(f); }
});

test('[req:PROV-7] hardlinked ledgers are rejected before external bytes can be replaced', (t) => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-receipt-hardlink-'));
  try {
    const external = join(outside, 'external.jsonl');
    writeFileSync(external, 'outside sentinel\n', 'utf8');
    try {
      linkSync(external, f.ledgerPath);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlink indisponível: ${error.code}`);
        return;
      }
      throw error;
    }
    const before = readFileSync(external);
    assert.throws(
      () => appendReceipt({ store: f.store, draft: draft('escape') }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CORRUPT',
    );
    assert.deepEqual(readFileSync(external), before);
  } finally {
    cleanup(f);
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:PROV-7] reader holds a consistent snapshot while a real writer waits', async () => {
  const f = fixture();
  let writerPromise;
  let triggered = false;
  const originalOpen = f.store.fs.openSync;
  const raceStore = createFileReceiptStore({
    ledgerPath: f.ledgerPath,
    checkpointPath: f.checkpointPath,
    legacyPath: f.legacyPath,
    lockPath: f.lockPath,
    lockWaitMs: 5000,
    fsAdapter: {
      openSync(path, flags, mode) {
        if (path === f.ledgerPath && !triggered) {
          triggered = true;
          writerPromise = childAppend(f, 'reader-race');
          sleepSync(1500);
        }
        return originalOpen(path, flags, mode);
      },
    },
  });
  try {
    appendReceipt({ store: f.store, draft: draft('before-reader') });
    const snapshot = readReceiptLedger({ store: raceStore });
    const writer = await writerPromise;
    assert.equal(writer.status, 0, writer.stderr);
    assert.equal(snapshot.records.length, 1, 'reader must return one coherent pre-writer snapshot');
    assert.equal(readReceiptLedger({ store: f.store }).records.length, 2);
  } finally { cleanup(f); }
});

test('[req:PROV-7] concurrent writers converge through the leased lock into one valid sequence', async () => {
  const f = fixture();
  try {
    const writers = await Promise.all([
      childAppend(f, 'writer-a'),
      childAppend(f, 'writer-b'),
      childAppend(f, 'writer-c'),
      childAppend(f, 'writer-d'),
    ]);
    for (const writer of writers) assert.equal(writer.status, 0, writer.stderr);
    const ledger = readReceiptLedger({ store: f.store });
    assert.equal(ledger.records.length, 4);
    assert.deepEqual(ledger.records.map((record) => record.sequence), [1, 2, 3, 4]);
  } finally { cleanup(f); }
});

test('[req:PROV-7] Windows lock release revalidates before retrying a transient sharing violation', {
  skip: process.platform !== 'win32',
}, () => {
  const f = fixture();
  try {
    const originalUnlink = f.store.fs.unlinkSync;
    let lockUnlinks = 0;
    const store = createFileReceiptStore({
      ledgerPath: f.ledgerPath,
      checkpointPath: f.checkpointPath,
      legacyPath: f.legacyPath,
      lockPath: f.lockPath,
      fsAdapter: {
        unlinkSync(path) {
          if (path === f.lockPath) {
            lockUnlinks += 1;
            if (lockUnlinks <= 2) {
              const error = new Error('simulated Windows sharing violation');
              error.code = 'EPERM';
              throw error;
            }
          }
          return originalUnlink(path);
        },
      },
    });

    const receipt = appendReceipt({ store, draft: draft('sharing-violation-retry') });
    assert.equal(receipt.record.sequence, 1);
    assert.equal(lockUnlinks, 3);
    assert.equal(existsSync(f.lockPath), false);
  } finally { cleanup(f); }
});

test('[req:PROV-7] Windows treats an exclusive-open sharing violation as contention only when the lock exists', {
  skip: process.platform !== 'win32',
}, () => {
  const f = fixture();
  try {
    writeFileSync(f.lockPath, `${JSON.stringify({
      schema_version: 1,
      owner_token: 'expired-owner',
      owner_pid: 999_999_999,
      acquired_at: '2020-01-01T00:00:00.000Z',
      lease_expires_at: '2020-01-01T00:00:01.000Z',
    })}\n`, 'utf8');
    const originalOpen = f.store.fs.openSync;
    let sharingViolations = 0;
    const store = createFileReceiptStore({
      ledgerPath: f.ledgerPath,
      checkpointPath: f.checkpointPath,
      legacyPath: f.legacyPath,
      lockPath: f.lockPath,
      fsAdapter: {
        openSync(path, flags, mode) {
          if (path === f.lockPath && existsSync(path) && (flags & f.store.fs.constants.O_EXCL)) {
            sharingViolations += 1;
            const error = new Error('simulated exclusive-open sharing violation');
            error.code = 'EPERM';
            throw error;
          }
          return originalOpen(path, flags, mode);
        },
      },
    });

    const receipt = appendReceipt({ store, draft: draft('exclusive-open-contention') });
    assert.equal(receipt.record.sequence, 1);
    assert.equal(sharingViolations, 1);
  } finally { cleanup(f); }
});

test('[req:PROV-7] Windows retries a sharing violation when the competing lock disappeared before observation', {
  skip: process.platform !== 'win32',
}, () => {
  const f = fixture();
  try {
    const originalOpen = f.store.fs.openSync;
    let sharingViolations = 0;
    const store = createFileReceiptStore({
      ledgerPath: f.ledgerPath,
      checkpointPath: f.checkpointPath,
      legacyPath: f.legacyPath,
      lockPath: f.lockPath,
      fsAdapter: {
        openSync(path, flags, mode) {
          if (path === f.lockPath
            && (flags & f.store.fs.constants.O_EXCL)
            && sharingViolations < 2) {
            sharingViolations += 1;
            const error = new Error('simulated vanished-lock sharing violation');
            error.code = 'EPERM';
            throw error;
          }
          return originalOpen(path, flags, mode);
        },
      },
    });

    const receipt = appendReceipt({ store, draft: draft('vanished-lock-contention') });
    assert.equal(receipt.record.sequence, 1);
    assert.equal(sharingViolations, 2);
  } finally { cleanup(f); }
});

test('[req:PROV-7] Windows retries a sharing violation while observing an existing lock', {
  skip: process.platform !== 'win32',
}, () => {
  const f = fixture();
  try {
    writeFileSync(f.lockPath, `${JSON.stringify({
      schema_version: 1,
      owner_token: 'expired-owner',
      owner_pid: 999_999_999,
      acquired_at: '2020-01-01T00:00:00.000Z',
      lease_expires_at: '2020-01-01T00:00:01.000Z',
    })}\n`, 'utf8');
    const originalLstat = f.store.fs.lstatSync;
    let armed = false;
    let sharingViolations = 0;
    const store = createFileReceiptStore({
      ledgerPath: f.ledgerPath,
      checkpointPath: f.checkpointPath,
      legacyPath: f.legacyPath,
      lockPath: f.lockPath,
      fsAdapter: {
        lstatSync(path) {
          if (armed && path === f.lockPath && sharingViolations < 2) {
            sharingViolations += 1;
            const error = new Error('simulated observation sharing violation');
            error.code = 'EPERM';
            throw error;
          }
          return originalLstat(path);
        },
      },
    });
    armed = true;

    const receipt = appendReceipt({ store, draft: draft('observation-contention') });
    assert.equal(receipt.record.sequence, 1);
    assert.equal(sharingViolations, 2);
  } finally { cleanup(f); }
});

test('[req:PROV-7] lock acquisition retries a replacement observed between open and lstat', (t) => {
  const f = fixture();
  try {
    writeFileSync(f.lockPath, `${JSON.stringify({
      schema_version: 1,
      owner_token: 'first-owner',
      owner_pid: process.pid,
      acquired_at: new Date().toISOString(),
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    })}\n`, 'utf8');
    const originalLstat = f.store.fs.lstatSync;
    let armed = false;
    let replaced = false;
    let replacementUnsupported = false;
    let lockLstats = 0;
    const store = createFileReceiptStore({
      ledgerPath: f.ledgerPath,
      checkpointPath: f.checkpointPath,
      legacyPath: f.legacyPath,
      lockPath: f.lockPath,
      lockWaitMs: 5000,
      fsAdapter: {
        lstatSync(path) {
          const stat = originalLstat(path);
          if (armed && path === f.lockPath) lockLstats += 1;
          if (armed && path === f.lockPath && lockLstats === 2 && !replaced) {
            replaced = true;
            try {
              rmSync(path);
              writeFileSync(path, `${JSON.stringify({
                schema_version: 1,
                owner_token: 'expired-replacement',
                owner_pid: 999_999_999,
                acquired_at: '2020-01-01T00:00:00.000Z',
                lease_expires_at: '2020-01-01T00:00:01.000Z',
              })}\n`, 'utf8');
              const replacement = originalLstat(path);
              return statWithInode(replacement, replacement.ino + 1024);
            } catch (error) {
              if (!OPEN_FILE_REPLACEMENT_UNSUPPORTED.has(error?.code)) throw error;
              replacementUnsupported = true;
              throw error;
            }
          }
          return stat;
        },
      },
    });
    armed = true;

    let receipt;
    try {
      receipt = appendReceipt({ store, draft: draft('replacement-retry') });
    } catch (error) {
      if (!replacementUnsupported) throw error;
      t.skip('runtime Windows não permite substituir lock enquanto o descritor está aberto');
      return;
    }
    assert.equal(replaced, true);
    assert.equal(receipt.record.sequence, 1);
  } finally { cleanup(f); }
});

test('[req:PROV-7] lock acquisition retries an opened lock unlinked before fstat', (t) => {
  const f = fixture();
  try {
    writeFileSync(f.lockPath, `${JSON.stringify({
      schema_version: 1,
      owner_token: 'first-owner',
      owner_pid: process.pid,
      acquired_at: new Date().toISOString(),
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    })}\n`, 'utf8');
    const originalFstat = f.store.fs.fstatSync;
    let armed = false;
    let replaced = false;
    let replacementUnsupported = false;
    const store = createFileReceiptStore({
      ledgerPath: f.ledgerPath,
      checkpointPath: f.checkpointPath,
      legacyPath: f.legacyPath,
      lockPath: f.lockPath,
      lockWaitMs: 5000,
      fsAdapter: {
        fstatSync(descriptor) {
          if (armed && !replaced) {
            replaced = true;
            try {
              rmSync(f.lockPath);
              writeFileSync(f.lockPath, `${JSON.stringify({
                schema_version: 1,
                owner_token: 'expired-replacement',
                owner_pid: 999_999_999,
                acquired_at: '2020-01-01T00:00:00.000Z',
                lease_expires_at: '2020-01-01T00:00:01.000Z',
              })}\n`, 'utf8');
            } catch (error) {
              if (!OPEN_FILE_REPLACEMENT_UNSUPPORTED.has(error?.code)) throw error;
              replacementUnsupported = true;
              throw error;
            }
          }
          return originalFstat(descriptor);
        },
      },
    });
    armed = true;

    let receipt;
    try {
      receipt = appendReceipt({ store, draft: draft('unlinked-descriptor-retry') });
    } catch (error) {
      if (!replacementUnsupported) throw error;
      t.skip('runtime Windows não permite substituir lock enquanto o descritor está aberto');
      return;
    }
    assert.equal(replaced, true);
    assert.equal(receipt.record.sequence, 1);
  } finally { cleanup(f); }
});

test('[req:PROV-7] expired lock with a dead owner is recovered without exposing its path', () => {
  const f = fixture();
  try {
    writeFileSync(f.lockPath, `${JSON.stringify({
      schema_version: 1,
      owner_token: 'orphan-token',
      owner_pid: Number.MAX_SAFE_INTEGER,
      acquired_at: '2026-08-23T11:00:00.000Z',
      lease_expires_at: '2026-08-23T11:00:01.000Z',
    })}\n`, 'utf8');
    const result = appendReceipt({ store: f.store, draft: draft('orphan-recovery') });
    assert.equal(result.idempotent, false);
    assert.equal(existsSync(f.lockPath), false);
  } finally { cleanup(f); }
});

test('[req:PROV-7] stale-lock reclamation cannot unlink a replacement owner', () => {
  const f = fixture();
  try {
    writeFileSync(f.lockPath, `${JSON.stringify({
      schema_version: 1,
      owner_token: 'stale-owner',
      owner_pid: Number.MAX_SAFE_INTEGER,
      acquired_at: '2026-08-23T11:00:00.000Z',
      lease_expires_at: '2026-08-23T11:00:01.000Z',
    })}\n`, 'utf8');
    const originalLstat = f.store.fs.lstatSync;
    let armed = false;
    let lockLstats = 0;
    let swapped = false;
    const raceStore = createFileReceiptStore({
      ledgerPath: f.ledgerPath,
      checkpointPath: f.checkpointPath,
      legacyPath: f.legacyPath,
      lockPath: f.lockPath,
      lockWaitMs: 1,
      fsAdapter: {
        lstatSync(path) {
          if (armed && path === f.lockPath) {
            lockLstats += 1;
            if (lockLstats === 4) {
              swapped = true;
              writeFileSync(path, `${JSON.stringify({
                schema_version: 1,
                owner_token: 'replacement-owner',
                owner_pid: process.pid,
                acquired_at: new Date().toISOString(),
                lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
              })}\n`, 'utf8');
            }
          }
          return originalLstat(path);
        },
      },
    });
    armed = true;

    assert.throws(
      () => appendReceipt({ store: raceStore, draft: draft('must-not-steal') }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_BUSY',
    );
    assert.equal(swapped, true);
    assert.match(readFileSync(f.lockPath, 'utf8'), /replacement-owner/);
    assert.equal(existsSync(f.ledgerPath), false);
  } finally { cleanup(f); }
});

test('[req:PROV-7] lock release cannot unlink a replacement owner', () => {
  const f = fixture();
  try {
    const originalLstat = f.store.fs.lstatSync;
    const originalRename = f.store.fs.renameSync;
    let armed = false;
    let lockLstats = 0;
    let swapped = false;
    const raceStore = createFileReceiptStore({
      ledgerPath: f.ledgerPath,
      checkpointPath: f.checkpointPath,
      legacyPath: f.legacyPath,
      lockPath: f.lockPath,
      fsAdapter: {
        lstatSync(path) {
          if (armed && path === f.lockPath) {
            lockLstats += 1;
            if (lockLstats === 4) {
              swapped = true;
              writeFileSync(path, `${JSON.stringify({
                schema_version: 1,
                owner_token: 'replacement-owner',
                owner_pid: process.pid,
                acquired_at: new Date().toISOString(),
                lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
              })}\n`, 'utf8');
            }
          }
          return originalLstat(path);
        },
        renameSync(source, target) {
          const result = originalRename(source, target);
          if (target === f.checkpointPath) armed = true;
          return result;
        },
      },
    });

    assert.throws(
      () => appendReceipt({ store: raceStore, draft: draft('release-race') }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CORRUPT',
    );
    assert.equal(swapped, true);
    assert.match(readFileSync(f.lockPath, 'utf8'), /replacement-owner/);
  } finally { cleanup(f); }
});

test('[req:PROV-7] empty or partial lock publication waits a safe lease then recovers without spinning forever', async () => {
  for (const [id, content] of [['empty-lock', ''], ['partial-lock', '{"schema_version":1']]) {
    const f = fixture();
    try {
      writeFileSync(f.lockPath, content, 'utf8');
      const result = await childAppend(f, id, {
        lockLeaseMs: 25, lockWaitMs: 500, killAfterMs: 2_000,
      });
      assert.equal(result.timedOut, false, `${id}: child must honor lease/deadline`);
      assert.equal(result.status, 0, `${id}: ${result.stderr}`);
      assert.equal(readReceiptLedger({ store: f.store }).records.length, 1);
    } finally { cleanup(f); }
  }

  const deadline = fixture();
  try {
    writeFileSync(deadline.lockPath, '', 'utf8');
    const result = await childAppend(deadline, 'deadline-lock', {
      lockLeaseMs: 60_000, lockWaitMs: 25, killAfterMs: 2_000,
    });
    assert.equal(result.timedOut, false, 'partial publication must stop at the wait deadline');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WENDKEEP_RECEIPT_LEDGER_BUSY/);
    assert.equal(existsSync(deadline.lockPath), true);
    assert.equal(existsSync(deadline.ledgerPath), false);
  } finally { cleanup(deadline); }
});

test('[req:PROV-7] claims and observations must remain structured and path errors are sanitized', () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-receipt-private-path-'));
  try {
    assert.throws(
      () => appendReceipt({ store: f.store, draft: draft('raw-claims', { claims: 'private raw claim' }) }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CORRUPT',
    );
    assert.throws(
      () => createFileReceiptStore({
        ledgerPath: f.ledgerPath,
        checkpointPath: join(outside, 'escape.checkpoint.json'),
        legacyPath: f.legacyPath,
        lockPath: f.lockPath,
      }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CORRUPT'
        && !String(error.message).includes(outside),
    );
  } finally {
    cleanup(f);
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:PROV-7] arbitrary payload keys and native lock errors never escape through diagnostics', () => {
  const f = fixture();
  const privateKey = 'C:\\private\\vault\\secret-token';
  try {
    const claims = {};
    claims[privateKey] = undefined;
    assert.throws(
      () => appendReceipt({ store: f.store, draft: draft('private-key', { claims }) }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CORRUPT'
        && !String(error.message).includes(privateKey),
    );
    writeFileSync(f.lockPath, `${JSON.stringify({
      schema_version: 1,
      owner_token: 'live-owner',
      owner_pid: process.pid,
      acquired_at: new Date().toISOString(),
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    })}\n`, 'utf8');
    const busyStore = createFileReceiptStore({
      ledgerPath: f.ledgerPath,
      checkpointPath: f.checkpointPath,
      legacyPath: f.legacyPath,
      lockPath: f.lockPath,
      lockWaitMs: 0,
    });
    assert.throws(
      () => appendReceipt({ store: busyStore, draft: draft('busy-private-path') }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_BUSY'
        && error.cause === undefined
        && !String(error.stack || error.message).includes(f.root),
    );
  } finally { cleanup(f); }
});

test('[req:PROV-7] atomic publications fsync the runtime directory when supported', () => {
  const f = fixture();
  let directoryOpens = 0;
  const originalOpen = f.store.fs.openSync;
  const durableStore = createFileReceiptStore({
    ledgerPath: f.ledgerPath,
    checkpointPath: f.checkpointPath,
    legacyPath: f.legacyPath,
    lockPath: f.lockPath,
    fsAdapter: {
      openSync(path, flags, mode) {
        if (path === f.runtime && flags === 'r') directoryOpens += 1;
        return originalOpen(path, flags, mode);
      },
    },
  });
  try {
    appendReceipt({ store: durableStore, draft: draft('directory-fsync') });
    assert.ok(directoryOpens >= 2, `expected ledger and checkpoint directory flushes, got ${directoryOpens}`);
  } finally { cleanup(f); }
});

test('[req:PROV-7] directory durability EIO and ENOSPC propagate as sanitized ledger errors', () => {
  for (const code of ['EIO', 'ENOSPC']) {
    const f = fixture();
    const directoryDescriptors = new Set();
    const originalOpen = f.store.fs.openSync;
    const originalFsync = f.store.fs.fsyncSync;
    const faultStore = createFileReceiptStore({
      ledgerPath: f.ledgerPath,
      checkpointPath: f.checkpointPath,
      legacyPath: f.legacyPath,
      lockPath: f.lockPath,
      fsAdapter: {
        openSync(path, flags, mode) {
          const descriptor = originalOpen(path, flags, mode);
          if (path === f.runtime && flags === 'r') directoryDescriptors.add(descriptor);
          return descriptor;
        },
        fsyncSync(descriptor) {
          if (directoryDescriptors.has(descriptor)) {
            const error = new Error(`${code} at ${f.root}\\private-vault`);
            error.code = code;
            throw error;
          }
          return originalFsync(descriptor);
        },
      },
    });
    try {
      assert.throws(
        () => appendReceipt({ store: faultStore, draft: draft(`directory-${code}`) }),
        (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_IO'
          && !String(error.message).includes(f.root)
          && error.cause === undefined,
      );
    } finally { cleanup(f); }
  }
});

test('[req:PROV-7] legacy genesis hashes the original bytes without UTF-8 replacement', () => {
  const f = fixture();
  try {
    const rawLegacy = Buffer.from([0x80, 0xff, 0x00, 0x0a]);
    writeFileSync(f.legacyPath, rawLegacy);
    const result = appendReceipt({ store: f.store, draft: draft('raw-legacy') });
    assert.equal(result.record.previous_hash, receiptGenesisHash(rawLegacy));
  } finally { cleanup(f); }
});

test('[req:PROV-7] a fault before ledger publication preserves the prior ledger and checkpoint', () => {
  const f = fixture();
  try {
    appendReceipt({ store: f.store, draft: draft('before-fault') });
    const ledgerBefore = readFileSync(f.ledgerPath);
    const checkpointBefore = readFileSync(f.checkpointPath);
    const originalRename = f.store.fs.renameSync;
    const faultStore = createFileReceiptStore({
      ledgerPath: f.ledgerPath,
      checkpointPath: f.checkpointPath,
      legacyPath: f.legacyPath,
      lockPath: f.lockPath,
      fsAdapter: {
        renameSync(source, target) {
          if (target === f.ledgerPath) {
            const error = new Error(`synthetic ledger publication fault at ${f.ledgerPath}`);
            error.code = 'EIO';
            throw error;
          }
          return originalRename(source, target);
        },
      },
    });
    assert.throws(
      () => appendReceipt({ store: faultStore, draft: draft('after-fault') }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_IO'
        && !String(error.message).includes(f.root)
        && error.cause === undefined,
    );
    assert.deepEqual(readFileSync(f.ledgerPath), ledgerBefore);
    assert.deepEqual(readFileSync(f.checkpointPath), checkpointBefore);
    assert.equal(readReceiptLedger({ store: f.store }).records.length, 1);
  } finally { cleanup(f); }
});

test('[req:PROV-7] lock creation uses exclusive no-follow flags where the platform exposes them', () => {
  const f = fixture();
  const lockFlags = [];
  const originalOpen = f.store.fs.openSync;
  const secureStore = createFileReceiptStore({
    ledgerPath: f.ledgerPath,
    checkpointPath: f.checkpointPath,
    legacyPath: f.legacyPath,
    lockPath: f.lockPath,
    fsAdapter: {
      openSync(path, flags, mode) {
        if (path === f.lockPath) lockFlags.push(flags);
        return originalOpen(path, flags, mode);
      },
    },
  });
  try {
    appendReceipt({ store: secureStore, draft: draft('exclusive-lock') });
    const exclusive = secureStore.fs.constants.O_EXCL;
    assert.ok(lockFlags.some((flags) => (flags & exclusive) === exclusive));
    if (secureStore.fs.constants.O_NOFOLLOW) {
      assert.ok(lockFlags.some((flags) => (flags & secureStore.fs.constants.O_NOFOLLOW)
        === secureStore.fs.constants.O_NOFOLLOW));
    }
  } finally { cleanup(f); }
});
