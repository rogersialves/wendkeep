import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function archiveLockError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function samePhysicalFile(left, right) {
  if (!left?.isFile() || !right?.isFile() || left.ino !== right.ino) return false;
  if (left.dev === right.dev) return true;
  return process.platform === 'win32' && (left.dev === 0 || right.dev === 0);
}

function ownerProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !['ESRCH', 'EINVAL'].includes(error?.code); }
}

function assertLockDirectory(target) {
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE');
  }
  return stat;
}

function readOwnerMarker(markerPath) {
  const stat = lstatSync(markerPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE');
  }
  let record;
  try { record = JSON.parse(readFileSync(markerPath, 'utf8')); }
  catch { throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE'); }
  if (record?.schema_version !== 1
    || typeof record.owner_token !== 'string' || !record.owner_token
    || !Number.isSafeInteger(record.owner_pid) || record.owner_pid <= 0
    || typeof record.acquired_at !== 'string' || !Number.isFinite(Date.parse(record.acquired_at))) {
    throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE');
  }
  return { stat, record };
}

function inspectExistingLock(target) {
  try { assertLockDirectory(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE');
  }
  const entries = readdirSync(target);
  if (entries.length === 0) {
    try { rmdirSync(target); } catch { /* re-observe on the next bounded attempt */ }
    return;
  }
  if (entries.length !== 1 || !/^owner\.[0-9a-f-]+\.json$/i.test(entries[0])) {
    throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE');
  }
  const markerPath = join(target, entries[0]);
  const observed = readOwnerMarker(markerPath);
  if (basename(markerPath) !== `owner.${observed.record.owner_token}.json`) {
    throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE');
  }
  if (ownerProcessAlive(observed.record.owner_pid)) {
    throw archiveLockError('WENDKEEP_ARCHIVE_BUSY', { owner_state: 'live' });
  }
  const confirmed = readOwnerMarker(markerPath);
  if (!samePhysicalFile(observed.stat, confirmed.stat)
    || confirmed.record.owner_token !== observed.record.owner_token
    || confirmed.record.owner_pid !== observed.record.owner_pid) {
    throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE');
  }
  try { unlinkSync(markerPath); }
  catch { throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE'); }
  try { rmdirSync(target); } catch { /* replacement/nonempty directory remains authoritative */ }
}

export function acquireArchiveOperationLock({
  lockPath,
  now = () => Date.now(),
  maxAcquireAttempts = 3,
  faultInjection = {},
}) {
  if (!lockPath || !Number.isSafeInteger(maxAcquireAttempts) || maxAcquireAttempts < 1) {
    throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_INVALID');
  }
  const runtime = resolve(dirname(lockPath));
  const target = resolve(lockPath);
  mkdirSync(runtime, { recursive: true });
  const runtimeStat = lstatSync(runtime);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()
    || resolve(realpathSync(runtime)).toLowerCase() !== runtime.toLowerCase()) {
    throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE');
  }

  const token = randomUUID();
  const markerName = `owner.${token}.json`;
  const pending = `${target}.pending.${process.pid}.${token}`;
  const pendingMarker = join(pending, markerName);
  let descriptor;
  let descriptorIdentity;
  let pendingExists = false;
  let published = false;
  try {
    mkdirSync(pending);
    pendingExists = true;
    descriptor = openSync(
      pendingMarker,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify({
      schema_version: 1,
      owner_token: token,
      owner_pid: process.pid,
      acquired_at: new Date(now()).toISOString(),
    })}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    for (let attempt = 1; attempt <= maxAcquireAttempts; attempt += 1) {
      try {
        if (typeof faultInjection?.beforePublishRename === 'function') {
          faultInjection.beforePublishRename({ attempt, pending, lockPath: target });
        }
        // The pending directory is already nonempty and durable. Rename publishes metadata and
        // exclusivity together; the canonical namespace never observes a partial marker/hardlink.
        renameSync(pending, target);
        pendingExists = false;
        published = true;
        if (typeof faultInjection?.afterPublishRename === 'function') {
          faultInjection.afterPublishRename({ attempt, lockPath: target });
        }
        break;
      } catch (error) {
        if (published) throw error;
        if (existsSync(target)) inspectExistingLock(target);
        if (attempt === maxAcquireAttempts) {
          throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE');
        }
      }
    }

    const markerPath = join(target, markerName);
    descriptor = openSync(
      markerPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    const identity = readOwnerMarker(markerPath);
    descriptorIdentity = fstatSync(descriptor);
    if (!samePhysicalFile(descriptorIdentity, identity.stat)
      || identity.record.owner_token !== token) {
      throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST');
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* original code remains authoritative */ }
      descriptor = undefined;
    }
    if (pendingExists) {
      try { unlinkSync(pendingMarker); } catch { /* marker may be absent */ }
      try { rmdirSync(pending); } catch { /* private pending state is recoverable */ }
    }
    if (error?.code?.startsWith('WENDKEEP_ARCHIVE_')) throw error;
    throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE');
  }

  const markerPath = join(target, markerName);
  let terminal = false;
  let assertionCount = 0;
  const closeHandle = () => {
    if (descriptor === undefined) return;
    try { closeSync(descriptor); } finally { descriptor = undefined; }
  };
  const assertOwned = () => {
    if (terminal || descriptor === undefined) {
      throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST');
    }
    try { assertLockDirectory(target); }
    catch { throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST'); }
    let identity;
    try { identity = readOwnerMarker(markerPath); }
    catch { throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST'); }
    const currentDescriptorIdentity = fstatSync(descriptor);
    if (!samePhysicalFile(currentDescriptorIdentity, identity.stat)
      || identity.record.owner_token !== token) {
      throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST');
    }
    descriptorIdentity = currentDescriptorIdentity;
    assertionCount += 1;
    if (typeof faultInjection?.afterAssertOwned === 'function') {
      faultInjection.afterAssertOwned({ count: assertionCount, lockPath: target, markerPath });
    }
    return true;
  };

  return Object.freeze({
    token,
    assertOwned,
    release() {
      if (terminal) return;
      try {
        assertOwned();
        if (typeof faultInjection?.beforeReleaseCommit === 'function') {
          faultInjection.beforeReleaseCommit({ lockPath: target, markerPath });
        }
        closeHandle();
        const finalIdentity = readOwnerMarker(markerPath);
        if (!samePhysicalFile(descriptorIdentity, finalIdentity.stat)
          || finalIdentity.record.owner_token !== token) {
          throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST');
        }
        unlinkSync(markerPath);
        rmdirSync(target);
      } catch {
        terminal = true;
        closeHandle();
        throw archiveLockError('WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST');
      }
      terminal = true;
      closeHandle();
    },
    get active() {
      if (terminal) return false;
      try { return assertOwned(); } catch { return false; }
    },
  });
}
