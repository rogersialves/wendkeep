// Keep Core physical write boundary for Vault-owned state.
//
// Node's recursive mkdir/write helpers follow junctions and symbolic links. Every mutator
// below therefore re-derives the canonical Vault root, checks logical containment, and walks
// each existing component with lstat immediately before touching the filesystem.
import { randomUUID } from 'node:crypto';
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const VAULT_LOCK_BUSY = Symbol('wendkeep:vault-lock-busy');
export const VAULT_LOCK_OWNER_FILE = '.owner.json';
const VAULT_PATH_FAILURE = Symbol('wendkeep:vault-path-failure');
const VAULT_PATH_CREATED = Symbol('wendkeep:vault-path-created');
const VAULT_LOCK_RETRY_DEADLINE = Symbol('wendkeep:vault-lock-retry-deadline');
const VAULT_LOCK_TOPOLOGY_RETRIES = 3;
const VAULT_LOCK_TOPOLOGY_RETRY_MS = 10;
const VAULT_LOCK_RELEASE_RETRY_WINDOW_MS = 50;

function pathKey(value) {
  const normalized = resolve(value).replaceAll('\\', '/').replace(/^\\\\\?\//, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function containedBy(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function unsafe(message, code = 'VAULT_PATH_UNSAFE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function lstatMaybe(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function canonicalVaultRoot(vaultBase, { code = 'VAULT_PATH_UNSAFE' } = {}) {
  const rawRoot = String(vaultBase || '').trim();
  if (!rawRoot) throw unsafe('raiz do Vault vazia', code);
  const logicalRoot = resolve(rawRoot);
  const rootStat = lstatMaybe(logicalRoot);
  if (!rootStat) throw unsafe(`raiz do Vault inexistente: ${logicalRoot}`, code);
  if (rootStat.isSymbolicLink()) {
    throw unsafe(`raiz do Vault atravessa link simbólico/junction/reparse: ${logicalRoot}`, code);
  }
  if (!rootStat.isDirectory()) throw unsafe(`raiz do Vault não é diretório: ${logicalRoot}`, code);
  let physicalRoot;
  try {
    physicalRoot = realpathSync.native(logicalRoot);
  } catch (cause) {
    const error = unsafe(`raiz física do Vault não pode ser resolvida: ${logicalRoot}`, code);
    error.cause = cause;
    throw error;
  }
  return { logicalRoot, physicalRoot };
}

/**
 * Validate one path under an existing Vault root.
 *
 * Missing suffixes are allowed by default so callers can create them. A dangling link is not
 * a missing suffix: lstat sees the link itself and it is rejected. Existing file targets with
 * more than one hardlink are always rejected, including read-before-idempotent-write paths.
 */
export function assertVaultPathSafe(vaultBase, targetPath, {
  allowMissing = true,
  expectedType = 'any',
  mustNotExist = false,
  label = 'path do Vault',
  code = 'VAULT_PATH_UNSAFE',
} = {}) {
  const { logicalRoot, physicalRoot } = canonicalVaultRoot(vaultBase, { code });
  const rawTarget = String(targetPath || '').trim();
  if (!rawTarget) throw unsafe(`${label} vazio`, code);
  const target = resolve(rawTarget);
  if (!containedBy(logicalRoot, target)) {
    throw unsafe(`${label} escapa logicamente do Vault: ${target}`, code);
  }

  const rel = relative(logicalRoot, target);
  const segments = rel ? rel.split(sep).filter(Boolean) : [];
  let logicalCursor = logicalRoot;
  let exists = true;
  let targetStat = lstatMaybe(logicalRoot);

  for (let index = 0; index < segments.length; index += 1) {
    logicalCursor = join(logicalCursor, segments[index]);
    const stat = lstatMaybe(logicalCursor);
    if (!stat) {
      exists = false;
      targetStat = null;
      break;
    }
    targetStat = stat;
    if (stat.isSymbolicLink()) {
      throw unsafe(`${label} atravessa link simbólico/junction/reparse: ${logicalCursor}`, code);
    }

    let actualPhysical;
    try {
      actualPhysical = realpathSync.native(logicalCursor);
    } catch (cause) {
      const error = unsafe(`${label} possui componente dangling ou irresolvível: ${logicalCursor}`, code);
      error.cause = cause;
      error[VAULT_PATH_FAILURE] = {
        kind: 'component-realpath',
        component: logicalCursor,
      };
      throw error;
    }
    const expectedPhysical = join(physicalRoot, ...segments.slice(0, index + 1));
    if (!containedBy(physicalRoot, actualPhysical)
      || pathKey(actualPhysical) !== pathKey(expectedPhysical)) {
      throw unsafe(`${label} é redirecionado por junction/reparse fora do path canônico: ${logicalCursor}`, code);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw unsafe(`${label} possui ancestral que não é diretório: ${logicalCursor}`, code);
    }
  }

  if (!exists && !allowMissing) {
    const error = unsafe(`${label} inexistente: ${target}`, code);
    error[VAULT_PATH_FAILURE] = {
      kind: 'component-missing',
      component: target,
      causeCode: 'ENOENT',
    };
    throw error;
  }
  if (exists && mustNotExist) {
    const error = unsafe(`${label} preexistente: ${target}`, code);
    error[VAULT_PATH_FAILURE] = {
      kind: 'target-preexisting',
      component: target,
    };
    throw error;
  }
  if (exists) {
    if (targetStat?.isFile() && targetStat.nlink > 1) {
      throw unsafe(`${label} preexistente possui hardlink (nlink=${targetStat.nlink}): ${target}`, code);
    }
    if (!targetStat?.isFile() && !targetStat?.isDirectory()) {
      throw unsafe(`${label} possui tipo de filesystem não suportado: ${target}`, code);
    }
    if (expectedType === 'file' && !targetStat?.isFile()) {
      throw unsafe(`${label} preexistente não é arquivo: ${target}`, code);
    }
    if (expectedType === 'directory' && !targetStat?.isDirectory()) {
      throw unsafe(`${label} preexistente não é diretório: ${target}`, code);
    }
  }

  return {
    exists,
    logicalRoot,
    physicalRoot,
    relative: rel,
    target,
  };
}

export function assertVaultPathsSafe(vaultBase, targets, common = {}) {
  return targets.map((entry) => {
    if (typeof entry === 'string') return assertVaultPathSafe(vaultBase, entry, common);
    return assertVaultPathSafe(vaultBase, entry.path, { ...common, ...entry });
  });
}

export function mkdirVaultPath(vaultBase, targetPath, {
  recursive = true,
  exclusive = false,
  label = 'diretório do Vault',
  code = 'VAULT_PATH_UNSAFE',
} = {}) {
  let checked = assertVaultPathSafe(vaultBase, targetPath, {
    expectedType: 'directory', label, code,
  });
  let created = false;
  try {
    if (exclusive || !checked.exists) {
      // Deliberately adjacent to mkdir: this is the last userspace check before mutation.
      checked = assertVaultPathSafe(vaultBase, targetPath, {
        expectedType: 'directory', label, code,
      });
      mkdirSync(checked.target, { recursive: exclusive ? false : recursive });
      created = true;
    }
    return assertVaultPathSafe(vaultBase, targetPath, {
      allowMissing: false, expectedType: 'directory', label, code,
    }).target;
  } catch (error) {
    // Callers may safely clean only a directory whose mkdir syscall actually succeeded.
    // In particular, EEXIST must never authorize cleanup of a pre-existing path.
    if (created) error[VAULT_PATH_CREATED] = checked.target;
    throw error;
  }
}

export function writeVaultFileSync(vaultBase, targetPath, content, encoding = 'utf8', {
  label = 'arquivo do Vault',
  code = 'VAULT_PATH_UNSAFE',
} = {}) {
  const checked = assertVaultPathSafe(vaultBase, targetPath, {
    expectedType: 'file', label, code,
  });
  // Deliberately adjacent to write: no policy/read work can happen between validation and I/O.
  assertVaultPathSafe(vaultBase, checked.target, { expectedType: 'file', label, code });
  writeFileSync(checked.target, content, encoding);
  assertVaultPathSafe(vaultBase, checked.target, {
    allowMissing: false, expectedType: 'file', label, code,
  });
  return checked.target;
}

export function writeVaultFileAtomic(vaultBase, targetPath, content, encoding = 'utf8', {
  label = 'arquivo atômico do Vault',
  code = 'VAULT_PATH_UNSAFE',
} = {}) {
  const checked = assertVaultPathSafe(vaultBase, targetPath, {
    expectedType: 'file', label, code,
  });
  assertVaultPathSafe(vaultBase, dirname(checked.target), {
    allowMissing: false, expectedType: 'directory', label: `ancestral de ${label}`, code,
  });
  const tmp = `${checked.target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  assertVaultPathSafe(vaultBase, tmp, {
    expectedType: 'file', mustNotExist: true, label: `temporário de ${label}`, code,
  });
  let tmpCreated = false;
  try {
    // wx prevents a pre-created alias from being opened after the last lstat.
    writeFileSync(tmp, content, { encoding, flag: 'wx' });
    tmpCreated = true;
    assertVaultPathSafe(vaultBase, tmp, {
      allowMissing: false, expectedType: 'file', label: `temporário de ${label}`, code,
    });
    assertVaultPathSafe(vaultBase, checked.target, { expectedType: 'file', label, code });
    renameSync(tmp, checked.target);
    tmpCreated = false;
    assertVaultPathSafe(vaultBase, checked.target, {
      allowMissing: false, expectedType: 'file', label, code,
    });
    return checked.target;
  } finally {
    if (tmpCreated) {
      try {
        assertVaultPathSafe(vaultBase, tmp, {
          allowMissing: false, expectedType: 'file', label: `temporário de ${label}`, code,
        });
        unlinkSync(tmp);
      } catch { /* fail closed at the operation site; a leftover private tmp is recoverable */ }
    }
  }
}

export function renameVaultPath(vaultBase, sourcePath, destinationPath, {
  sourceType = 'any',
  label = 'rename do Vault',
  code = 'VAULT_PATH_UNSAFE',
} = {}) {
  const source = assertVaultPathSafe(vaultBase, sourcePath, {
    allowMissing: false, expectedType: sourceType, label: `origem de ${label}`, code,
  });
  const destination = assertVaultPathSafe(vaultBase, destinationPath, {
    mustNotExist: true, label: `destino de ${label}`, code,
  });
  assertVaultPathSafe(vaultBase, dirname(destination.target), {
    allowMissing: false, expectedType: 'directory', label: `ancestral de ${label}`, code,
  });
  assertVaultPathSafe(vaultBase, source.target, {
    allowMissing: false, expectedType: sourceType, label: `origem de ${label}`, code,
  });
  assertVaultPathSafe(vaultBase, destination.target, {
    mustNotExist: true, label: `destino de ${label}`, code,
  });
  renameSync(source.target, destination.target);
  return destination.target;
}

export function unlinkVaultFile(vaultBase, targetPath, {
  missingOk = true,
  label = 'arquivo removido do Vault',
  code = 'VAULT_PATH_UNSAFE',
} = {}) {
  let checked;
  try {
    checked = assertVaultPathSafe(vaultBase, targetPath, {
      allowMissing: missingOk, expectedType: 'file', label, code,
    });
  } catch (error) {
    if (missingOk && error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!checked.exists) return false;
  assertVaultPathSafe(vaultBase, checked.target, {
    allowMissing: false, expectedType: 'file', label, code,
  });
  unlinkSync(checked.target);
  return true;
}

export function removeVaultLockDirectory(vaultBase, targetPath, {
  missingOk = true,
  label = 'lock do Vault',
  code = 'VAULT_PATH_UNSAFE',
} = {}) {
  const checked = assertVaultPathSafe(vaultBase, targetPath, {
    allowMissing: missingOk, expectedType: 'directory', label, code,
  });
  if (!checked.exists) return false;
  assertVaultPathSafe(vaultBase, checked.target, {
    allowMissing: false, expectedType: 'directory', label, code,
  });
  try {
    rmdirSync(checked.target);
    return true;
  } catch (error) {
    if (missingOk && error?.code === 'ENOENT') return false;
    throw error;
  }
}

function waitBriefly(ms) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

// A public lock may legitimately disappear while another owner releases it. Only ENOENT
// observed by an operation explicitly scoped to that canonical lock receives bounded
// backoff; private .pending paths and every unsafe topology fail closed.
function retryablePublicLockError(lock, error, code, { allowRaw = true } = {}) {
  const failure = error?.[VAULT_PATH_FAILURE];
  if (!failure) return allowRaw && error?.code === 'ENOENT' && !error?.cause;
  const causeCode = error?.cause?.code || failure.causeCode;
  return causeCode === 'ENOENT'
    && (error?.code === code || error?.code === 'VAULT_PATH_UNSAFE')
    && ['component-realpath', 'component-missing'].includes(failure.kind)
    && containedBy(resolve(lock), resolve(failure.component));
}

function vaultLockRenameCollision(error, pending, lock) {
  const acceptedCodes = process.platform === 'win32'
    ? ['EEXIST', 'ENOTEMPTY', 'EPERM']
    : ['EEXIST', 'ENOTEMPTY'];
  return acceptedCodes.includes(error?.code)
    && error?.syscall === 'rename'
    && typeof error?.path === 'string'
    && typeof error?.dest === 'string'
    && pathKey(error.path) === pathKey(pending)
    && pathKey(error.dest) === pathKey(lock);
}

function preexistingPublicLockError(lock, error, code) {
  const failure = error?.[VAULT_PATH_FAILURE];
  return failure?.kind === 'target-preexisting'
    && (error?.code === code || error?.code === 'VAULT_PATH_UNSAFE')
    && typeof failure.component === 'string'
    && pathKey(failure.component) === pathKey(lock);
}

function vaultLockRetryDeadlineError() {
  const error = new Error('deadline de retry do lock do Vault esgotado');
  error[VAULT_LOCK_RETRY_DEADLINE] = true;
  return error;
}

function withPublicLockRetry(lock, code, retryState, operation, initialError = null) {
  let error = initialError;
  while (true) {
    if (error) {
      if (!retryablePublicLockError(lock, error, code)
        || retryState.remaining <= 0) throw error;
      const remainingMs = retryState.deadline - Date.now();
      if (remainingMs <= 0) throw vaultLockRetryDeadlineError();
      retryState.remaining -= 1;
      waitBriefly(Math.min(VAULT_LOCK_TOPOLOGY_RETRY_MS, remainingMs));
      if (Date.now() >= retryState.deadline) throw vaultLockRetryDeadlineError();
    }
    try {
      return operation();
    } catch (nextError) {
      error = nextError;
    }
  }
}

function inspectVaultLock(vaultBase, lock, code, retryState, initialError = null) {
  return withPublicLockRetry(lock, code, retryState, () => assertVaultPathSafe(vaultBase, lock, {
    expectedType: 'directory', label: 'lock de escrita do Vault', code,
  }), initialError);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function vaultLockOwner(vaultBase, lock, code, retryState = null) {
  const inspect = () => {
    const checkedLock = assertVaultPathSafe(vaultBase, lock, {
      expectedType: 'directory', label: 'lock de escrita do Vault', code,
    });
    const path = join(lock, VAULT_LOCK_OWNER_FILE);
    if (!checkedLock.exists) {
      return {
        lockExists: false, ownerExists: false, owner: null, path, raw: '',
      };
    }
    const checked = assertVaultPathSafe(vaultBase, path, {
      expectedType: 'file', label: 'owner do lock de escrita do Vault', code,
    });
    if (!checked.exists) {
      return {
        lockExists: true, ownerExists: false, owner: null, path: checked.target, raw: '',
      };
    }
    const raw = readFileSync(checked.target, 'utf8');
    try {
      const owner = JSON.parse(raw);
      const valid = owner?.v === 1
        && Number.isSafeInteger(owner.pid) && owner.pid > 0
        && typeof owner.token === 'string' && owner.token.length > 0
        && typeof owner.created_at === 'string' && owner.created_at.length > 0;
      return {
        lockExists: true, ownerExists: true, owner: valid ? owner : null, path: checked.target, raw,
      };
    } catch {
      return {
        lockExists: true, ownerExists: true, owner: null, path: checked.target, raw,
      };
    }
  };
  return retryState
    ? withPublicLockRetry(lock, code, retryState, inspect)
    : inspect();
}

function vaultLockLease(lock, token) {
  return join(lock, `.lease-${token}`);
}

function removePreparedVaultLock(vaultBase, lock, token, code) {
  const checked = assertVaultPathSafe(vaultBase, lock, {
    expectedType: 'directory', label: 'lock privado em preparação', code,
  });
  if (!checked.exists) return true;
  const owner = vaultLockOwner(vaultBase, lock, code);
  if (owner.owner
    && (owner.owner.pid !== process.pid || owner.owner.token !== token)) return false;
  const leasePath = vaultLockLease(lock, token);
  const allowed = new Set([VAULT_LOCK_OWNER_FILE, `.lease-${token}`]);
  const entries = readdirSync(checked.target);
  if (entries.some((name) => !allowed.has(name))) return false;
  unlinkVaultFile(vaultBase, leasePath, {
    label: 'lease do lock de escrita do Vault', code,
  });
  if (owner.raw) {
    const current = vaultLockOwner(vaultBase, lock, code).owner;
    if (current?.pid !== process.pid || current?.token !== token) return false;
    if (!unlinkVaultFile(vaultBase, owner.path, {
      label: 'owner do lock de escrita do Vault', code,
    })) return false;
  }
  return removeVaultLockDirectory(vaultBase, lock, {
    missingOk: false, label: 'lock de escrita do Vault', code,
  });
}

function releaseOwnedVaultLock(vaultBase, lock, {
  pid, token, code, retryState,
}) {
  const observedState = vaultLockOwner(vaultBase, lock, code, retryState);
  if (!observedState.lockExists) return true;
  const observed = observedState.owner;
  if (observed?.pid !== pid || observed?.token !== token) return false;
  // The token-specific lease is the filesystem CAS. An old finally/reaper can only
  // remove the directory after successfully unlinking the lease it originally saw;
  // a replacement lock never contains that unguessable path.
  const leaseRemoved = withPublicLockRetry(lock, code, retryState, () => unlinkVaultFile(
    vaultBase, vaultLockLease(lock, token), {
      label: 'lease do lock de escrita do Vault', code,
    },
  ));
  if (!leaseRemoved) return false;
  const currentState = vaultLockOwner(vaultBase, lock, code, retryState);
  if (!currentState.lockExists) return true;
  const current = currentState.owner;
  if (current?.pid !== pid || current?.token !== token) return false;
  const ownerPath = join(lock, VAULT_LOCK_OWNER_FILE);
  if (!withPublicLockRetry(lock, code, retryState, () => unlinkVaultFile(
    vaultBase, ownerPath, {
      label: 'owner do lock de escrita do Vault', code,
    },
  ))) return false;
  return withPublicLockRetry(lock, code, retryState, () => removeVaultLockDirectory(
    vaultBase, lock, {
      missingOk: false, label: 'lock de escrita do Vault', code,
    },
  ));
}

function reapDeadVaultLock(vaultBase, lock, staleMs, code, retryState) {
  const initial = withPublicLockRetry(lock, code, retryState, () => {
    const checked = assertVaultPathSafe(vaultBase, lock, {
      expectedType: 'directory', label: 'lock de escrita do Vault', code,
    });
    if (!checked.exists) return null;
    return { checked, before: statSync(checked.target) };
  });
  if (!initial) return true;
  const { checked, before } = initial;
  if (Date.now() - before.mtimeMs <= staleMs) return false;
  const observed = vaultLockOwner(vaultBase, checked.target, code, retryState);
  if (!observed.lockExists) return true;
  if (observed.owner) {
    if (processIsAlive(observed.owner.pid)) return false;
    const lease = withPublicLockRetry(lock, code, retryState, () => {
      const current = assertVaultPathSafe(vaultBase, lock, {
        expectedType: 'directory', label: 'lock de escrita do Vault', code,
      });
      if (!current.exists) return null;
      return assertVaultPathSafe(vaultBase, vaultLockLease(current.target, observed.owner.token), {
        expectedType: 'file', label: 'lease do lock de escrita do Vault', code,
      });
    });
    if (!lease) return true;
    if (lease.exists) {
      return releaseOwnedVaultLock(vaultBase, checked.target, {
        pid: observed.owner.pid, token: observed.owner.token, code, retryState,
      });
    }
    // Compatibility with owner-aware locks from 0.58.x, which predate token leases.
    // A dead PID plus byte-identical owner and directory identity is sufficient here;
    // a live legacy owner was returned above and is never reaped by age.
    const legacy = withPublicLockRetry(lock, code, retryState, () => {
      const current = assertVaultPathSafe(vaultBase, lock, {
        expectedType: 'directory', label: 'lock legado de escrita do Vault', code,
      });
      if (!current.exists) return null;
      return {
        entries: readdirSync(current.target),
        currentStat: statSync(current.target),
        currentOwner: vaultLockOwner(vaultBase, current.target, code),
      };
    });
    if (!legacy) return true;
    const { entries, currentStat, currentOwner } = legacy;
    if (entries.some((name) => name !== VAULT_LOCK_OWNER_FILE)) return false;
    if (currentStat.birthtimeMs !== before.birthtimeMs
      || currentStat.mtimeMs !== before.mtimeMs
      || currentOwner.raw !== observed.raw) return false;
    if (!withPublicLockRetry(lock, code, retryState, () => unlinkVaultFile(
      vaultBase, currentOwner.path, {
        label: 'owner legado morto do lock de escrita do Vault', code,
      },
    ))) return false;
    return withPublicLockRetry(lock, code, retryState, () => removeVaultLockDirectory(
      vaultBase, checked.target, {
        missingOk: false, label: 'lock legado de escrita do Vault', code,
      },
    ));
  }

  // Locks are published by atomic directory rename only after owner + lease exist.
  // Thus an old empty/partial directory is legacy or crash residue, never an in-flight
  // live acquisition. Unknown children remain fail-closed.
  const partial = withPublicLockRetry(lock, code, retryState, () => {
    const current = assertVaultPathSafe(vaultBase, lock, {
      expectedType: 'directory', label: 'lock de escrita do Vault', code,
    });
    if (!current.exists) return null;
    const entries = readdirSync(current.target);
    for (const name of entries) {
      assertVaultPathSafe(vaultBase, join(current.target, name), {
        allowMissing: false, expectedType: 'file', label: `resíduo do lock do Vault ${name}`, code,
      });
    }
    return {
      entries,
      currentStat: statSync(current.target),
      currentOwner: vaultLockOwner(vaultBase, current.target, code),
    };
  });
  if (!partial) return true;
  const { entries, currentStat, currentOwner } = partial;
  if (entries.some((name) => name !== VAULT_LOCK_OWNER_FILE)) return false;
  if (currentStat.birthtimeMs !== before.birthtimeMs
    || currentStat.mtimeMs !== before.mtimeMs
    || currentOwner.raw !== observed.raw) return false;
  if (entries.includes(VAULT_LOCK_OWNER_FILE)
    && !withPublicLockRetry(lock, code, retryState, () => unlinkVaultFile(
      vaultBase, currentOwner.path, {
        label: 'owner parcial do lock de escrita do Vault', code,
      },
    ))) return false;
  return withPublicLockRetry(lock, code, retryState, () => removeVaultLockDirectory(
    vaultBase, checked.target, {
      missingOk: false, label: 'lock de escrita do Vault', code,
    },
  ));
}

export function withVaultPathLock(vaultBase, path, fn, {
  timeoutMs = 2000,
  staleMs = 10_000,
  code = 'VAULT_PATH_UNSAFE',
} = {}) {
  const lock = `${path}.lock`;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const retryState = { deadline, remaining: VAULT_LOCK_TOPOLOGY_RETRIES };
  let firstAttempt = true;
  try {
    while (true) {
      if (!firstAttempt && Date.now() >= deadline) return VAULT_LOCK_BUSY;
      firstAttempt = false;
      const current = inspectVaultLock(vaultBase, lock, code, retryState);
      if (current.exists) {
        const reaped = reapDeadVaultLock(vaultBase, lock, staleMs, code, retryState);
        if (reaped) continue;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return VAULT_LOCK_BUSY;
        waitBriefly(Math.min(10, remainingMs));
        continue;
      }

      const pending = `${lock}.${process.pid}.${token}.pending`;
      let pendingCreated = false;
      try {
        try {
          mkdirVaultPath(vaultBase, pending, {
            recursive: false, exclusive: true, label: 'lock de escrita do Vault', code,
          });
          pendingCreated = true;
        } catch (error) {
          pendingCreated = typeof error?.[VAULT_PATH_CREATED] === 'string'
            && pathKey(error[VAULT_PATH_CREATED]) === pathKey(pending);
          throw error;
        }
        writeVaultFileAtomic(vaultBase, join(pending, VAULT_LOCK_OWNER_FILE), `${JSON.stringify({
          v: 1,
          pid: process.pid,
          token,
          created_at: new Date().toISOString(),
        })}\n`, 'utf8', { label: 'owner do lock de escrita do Vault', code });
        writeVaultFileAtomic(vaultBase, vaultLockLease(pending, token), `${token}\n`, 'utf8', {
          label: 'lease do lock de escrita do Vault', code,
        });
        const raced = inspectVaultLock(vaultBase, lock, code, retryState);
        if (raced.exists) {
          removePreparedVaultLock(vaultBase, pending, token, code);
        } else {
          try {
            renameVaultPath(vaultBase, pending, lock, {
              sourceType: 'directory', label: 'publicação do lock de escrita do Vault', code,
            });
            break;
          } catch (error) {
            const retryableRenameRace = retryablePublicLockError(lock, error, code, {
              allowRaw: false,
            });
            const nativeRenameCollision = vaultLockRenameCollision(error, pending, lock);
            const preflightRenameCollision = preexistingPublicLockError(lock, error, code);
            if (!retryableRenameRace && !nativeRenameCollision && !preflightRenameCollision) {
              throw error;
            }
            const racedAfterRename = inspectVaultLock(
              vaultBase, lock, code, retryState, retryableRenameRace ? error : null,
            );
            if (!racedAfterRename.exists) {
              // EPERM is ambiguous on Windows; without an extant destination it remains fatal.
              if (error?.code === 'EPERM') throw error;
              removePreparedVaultLock(vaultBase, pending, token, code);
              continue;
            }
            removePreparedVaultLock(vaultBase, pending, token, code);
          }
        }
      } catch (error) {
        if (pendingCreated) {
          try { removePreparedVaultLock(vaultBase, pending, token, code); }
          catch { /* residue private remains recoverable; never clean through an alias */ }
        }
        throw error;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return VAULT_LOCK_BUSY;
      waitBriefly(Math.min(10, remainingMs));
    }
  } catch (error) {
    if (error?.[VAULT_LOCK_RETRY_DEADLINE]) return VAULT_LOCK_BUSY;
    throw error;
  }

  try {
    return fn();
  } finally {
    try {
      releaseOwnedVaultLock(vaultBase, lock, {
        pid: process.pid,
        token,
        code,
        retryState: {
          deadline: Date.now() + VAULT_LOCK_RELEASE_RETRY_WINDOW_MS,
          remaining: VAULT_LOCK_TOPOLOGY_RETRIES,
        },
      });
    }
    catch { /* a failed safe release leaves the lock in place; never remove through an alias */ }
  }
}
