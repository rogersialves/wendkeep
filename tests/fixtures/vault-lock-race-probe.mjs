import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scenario = process.argv[2];
const moduleUrl = pathToFileURL(join(
  process.cwd(), 'packages', 'vault', 'src', 'vault-path-safety.mjs',
)).href;

function fixture(prefix) {
  const vault = fs.mkdtempSync(join(tmpdir(), prefix));
  const target = join(vault, '.brain', 'runtime', 'state');
  const lock = `${target}.lock`;
  fs.mkdirSync(join(vault, '.brain', 'runtime'), { recursive: true });
  return { vault, target, lock, owner: join(lock, '.owner.json') };
}

function deadOwner(fx, { lease = false } = {}) {
  fs.mkdirSync(fx.lock, { recursive: true });
  fs.writeFileSync(fx.owner, `${JSON.stringify({
    v: 1,
    pid: 2147483647,
    token: 'dead',
    created_at: '2020-01-01T00:00:00.000Z',
  })}\n`);
  if (lease) fs.writeFileSync(join(fx.lock, '.lease-dead'), 'dead\n');
}

async function load(suffix) {
  return import(`${moduleUrl}?vault-lock-race=${suffix}-${Date.now()}`);
}

async function ownerRead(code) {
  const fx = fixture(`wk-vault-owner-${code.toLowerCase()}-`);
  deadOwner(fx);
  const originalRead = fs.readFileSync;
  const originalWait = Atomics.wait;
  let injected = 0;
  let waits = 0;
  let entered = false;
  fs.readFileSync = function ownerReadRace(path, ...args) {
    if (resolve(String(path)) === resolve(fx.owner) && injected === 0) {
      injected += 1;
      if (code === 'ENOENT') fs.rmSync(fx.lock, { recursive: true, force: true });
      const error = new Error(`owner read ${code}`);
      error.code = code;
      throw error;
    }
    return originalRead.call(this, path, ...args);
  };
  Atomics.wait = () => {
    waits += 1;
    return 'timed-out';
  };
  syncBuiltinESMExports();
  try {
    const { withVaultPathLock } = await load(`owner-${code}`);
    let value = null;
    let errorCode = null;
    try {
      value = withVaultPathLock(fx.vault, fx.target, () => {
        entered = true;
        return 'acquired';
      }, { timeoutMs: 250, staleMs: 0 });
    } catch (error) {
      errorCode = error?.code || null;
    }
    return {
      value, errorCode, entered, injected, waits, lockExists: fs.existsSync(fx.lock),
    };
  } finally {
    fs.readFileSync = originalRead;
    Atomics.wait = originalWait;
    syncBuiltinESMExports();
    fs.rmSync(fx.vault, { recursive: true, force: true });
  }
}

async function retryBudget() {
  const fx = fixture('wk-vault-lock-budget-');
  deadOwner(fx, { lease: true });
  const originalRealpath = fs.realpathSync.native;
  const originalWait = Atomics.wait;
  let injected = 0;
  let waits = 0;
  fs.realpathSync.native = function persistentOwnerRealpath(path, ...args) {
    if (resolve(path) === resolve(fx.owner)) {
      injected += 1;
      const error = new Error('owner persistentemente irresolvível');
      error.code = 'ENOENT';
      throw error;
    }
    return originalRealpath.call(this, path, ...args);
  };
  Atomics.wait = () => {
    waits += 1;
    return 'timed-out';
  };
  syncBuiltinESMExports();
  const started = Date.now();
  try {
    const { withVaultPathLock } = await load('budget');
    let errorCode = null;
    let causeCode = null;
    try {
      withVaultPathLock(fx.vault, fx.target, () => 'não deve entrar', {
        timeoutMs: 1000, staleMs: 0,
      });
    } catch (error) {
      errorCode = error?.code || null;
      causeCode = error?.cause?.code || null;
    }
    return {
      injected, waits, errorCode, causeCode, elapsedMs: Date.now() - started,
    };
  } finally {
    fs.realpathSync.native = originalRealpath;
    Atomics.wait = originalWait;
    syncBuiltinESMExports();
    fs.rmSync(fx.vault, { recursive: true, force: true });
  }
}

async function releaseRace() {
  const fx = fixture('wk-vault-lock-release-');
  const originalRealpath = fs.realpathSync.native;
  const originalWait = Atomics.wait;
  let phase = 'acquire';
  let injected = 0;
  let waits = 0;
  fs.realpathSync.native = function transientReleaseRealpath(path, ...args) {
    if (phase === 'release' && resolve(path) === resolve(fx.lock) && injected === 0) {
      injected += 1;
      const error = new Error('release ENOENT transitório');
      error.code = 'ENOENT';
      throw error;
    }
    return originalRealpath.call(this, path, ...args);
  };
  Atomics.wait = () => {
    waits += 1;
    return 'timed-out';
  };
  syncBuiltinESMExports();
  try {
    const { withVaultPathLock } = await load('release');
    const value = withVaultPathLock(fx.vault, fx.target, () => {
      phase = 'release';
      return 'done';
    }, { timeoutMs: 250, staleMs: 50 });
    return { value, injected, waits, lockExists: fs.existsSync(fx.lock) };
  } finally {
    fs.realpathSync.native = originalRealpath;
    Atomics.wait = originalWait;
    syncBuiltinESMExports();
    fs.rmSync(fx.vault, { recursive: true, force: true });
  }
}

async function renameRace(mode) {
  const fx = fixture(`wk-vault-lock-rename-${mode.toLowerCase()}-`);
  const originalRename = fs.renameSync;
  const originalWait = Atomics.wait;
  let injected = 0;
  let waits = 0;
  let entered = false;
  let collisionCode = null;
  fs.renameSync = function concurrentRename(source, destination, ...args) {
    if (resolve(String(destination)) === resolve(fx.lock)
      && String(source).endsWith('.pending') && injected === 0) {
      injected += 1;
      deadOwner(fx, { lease: true });
      if (mode !== 'NATIVE') {
        const error = new Error(`rename ${mode} concorrente simulado`);
        error.code = mode.startsWith('EPERM') ? 'EPERM'
          : mode.startsWith('EEXIST') ? 'EEXIST' : 'EACCES';
        error.syscall = mode === 'EEXIST_BAD_SYSCALL' ? 'open' : 'rename';
        error.path = mode === 'EEXIST_BAD_PATH' ? `${source}.other` : source;
        error.dest = mode === 'EPERM_BAD_DEST' ? `${destination}.other` : destination;
        throw error;
      }
      try {
        return originalRename.call(this, source, destination, ...args);
      } catch (error) {
        collisionCode = error?.code || null;
        throw error;
      }
    }
    return originalRename.call(this, source, destination, ...args);
  };
  Atomics.wait = () => {
    waits += 1;
    return 'timed-out';
  };
  syncBuiltinESMExports();
  try {
    const { withVaultPathLock } = await load(`rename-${mode}`);
    let value = null;
    let errorCode = null;
    try {
      value = withVaultPathLock(fx.vault, fx.target, () => {
        entered = true;
        return 'acquired';
      }, { timeoutMs: 2000, staleMs: 0 });
    } catch (error) {
      errorCode = error?.code || null;
    }
    const pending = fs.readdirSync(join(fx.vault, '.brain', 'runtime'))
      .filter((name) => name.endsWith('.pending'));
    return {
      value, errorCode, entered, injected, waits, collisionCode,
      lockExists: fs.existsSync(fx.lock), pending,
    };
  } finally {
    fs.renameSync = originalRename;
    Atomics.wait = originalWait;
    syncBuiltinESMExports();
    fs.rmSync(fx.vault, { recursive: true, force: true });
  }
}

async function pendingPostMkdirRace() {
  const fx = fixture('wk-vault-lock-pending-post-mkdir-');
  const originalRealpath = fs.realpathSync.native;
  const originalWait = Atomics.wait;
  let injected = 0;
  let waits = 0;
  let entered = false;
  fs.realpathSync.native = function pendingPostMkdirRealpath(path, ...args) {
    if (String(path).endsWith('.pending') && fs.existsSync(path) && injected === 0) {
      injected += 1;
      const error = new Error('pending ENOENT pós-mkdir simulado');
      error.code = 'ENOENT';
      throw error;
    }
    return originalRealpath.call(this, path, ...args);
  };
  Atomics.wait = () => {
    waits += 1;
    return 'timed-out';
  };
  syncBuiltinESMExports();
  try {
    const { withVaultPathLock } = await load('pending-post-mkdir');
    let errorCode = null;
    let causeCode = null;
    try {
      withVaultPathLock(fx.vault, fx.target, () => {
        entered = true;
        return 'não deve entrar';
      }, { timeoutMs: 250, staleMs: 50 });
    } catch (error) {
      errorCode = error?.code || null;
      causeCode = error?.cause?.code || null;
    }
    const pending = fs.readdirSync(join(fx.vault, '.brain', 'runtime'))
      .filter((name) => name.endsWith('.pending'));
    return { errorCode, causeCode, entered, injected, waits, pending };
  } finally {
    fs.realpathSync.native = originalRealpath;
    Atomics.wait = originalWait;
    syncBuiltinESMExports();
    fs.rmSync(fx.vault, { recursive: true, force: true });
  }
}

async function pendingPreexistingRace() {
  const fx = fixture('wk-vault-lock-pending-preexisting-');
  const originalMkdir = fs.mkdirSync;
  const originalWait = Atomics.wait;
  let injected = 0;
  let waits = 0;
  let entered = false;
  fs.mkdirSync = function concurrentPendingMkdir(path, options) {
    if (String(path).endsWith('.pending') && injected === 0) {
      injected += 1;
      originalMkdir.call(this, path, options);
      return originalMkdir.call(this, path, options);
    }
    return originalMkdir.call(this, path, options);
  };
  Atomics.wait = () => {
    waits += 1;
    return 'timed-out';
  };
  syncBuiltinESMExports();
  try {
    const { withVaultPathLock } = await load('pending-preexisting');
    let errorCode = null;
    try {
      withVaultPathLock(fx.vault, fx.target, () => {
        entered = true;
        return 'não deve entrar';
      }, { timeoutMs: 250, staleMs: 50 });
    } catch (error) {
      errorCode = error?.code || null;
    }
    const pending = fs.readdirSync(join(fx.vault, '.brain', 'runtime'))
      .filter((name) => name.endsWith('.pending'));
    return {
      errorCode, entered, injected, waits,
      pendingCount: pending.length,
      pendingSuffixValid: pending.every((name) => name.endsWith('.pending')),
      lockExists: fs.existsSync(fx.lock),
    };
  } finally {
    fs.mkdirSync = originalMkdir;
    Atomics.wait = originalWait;
    syncBuiltinESMExports();
    fs.rmSync(fx.vault, { recursive: true, force: true });
  }
}

async function renamePreflightRace() {
  const fx = fixture('wk-vault-lock-rename-preflight-');
  const originalLstat = fs.lstatSync;
  const originalRename = fs.renameSync;
  const originalWait = Atomics.wait;
  let lockChecksAfterPending = 0;
  let injected = 0;
  let renameCalls = 0;
  let waits = 0;
  let entered = false;
  fs.lstatSync = function concurrentPreflightLstat(path, ...args) {
    if (resolve(String(path)) === resolve(fx.lock)) {
      const runtime = join(fx.vault, '.brain', 'runtime');
      const pendingName = fs.readdirSync(runtime).find((name) => name.endsWith('.pending'));
      const pendingPath = pendingName ? join(runtime, pendingName) : null;
      const pendingReady = pendingPath && fs.existsSync(join(pendingPath, '.owner.json'))
        && fs.readdirSync(pendingPath).some((name) => name.startsWith('.lease-'));
      if (pendingReady) {
        lockChecksAfterPending += 1;
        if (lockChecksAfterPending === 2 && injected === 0) {
          injected += 1;
          let missing;
          try {
            originalLstat.call(this, path, ...args);
          } catch (error) {
            missing = error;
          }
          if (missing?.code !== 'ENOENT') throw missing;
          fs.mkdirSync(fx.lock, { recursive: true });
          fs.writeFileSync(fx.owner, `${JSON.stringify({
            v: 1,
            pid: process.pid,
            token: 'rival-live',
            created_at: new Date().toISOString(),
          })}\n`);
          fs.writeFileSync(join(fx.lock, '.lease-rival-live'), 'rival-live\n');
          throw missing;
        }
      }
    }
    return originalLstat.call(this, path, ...args);
  };
  fs.renameSync = function countedRename(source, destination, ...args) {
    if (resolve(String(destination)) === resolve(fx.lock)) renameCalls += 1;
    return originalRename.call(this, source, destination, ...args);
  };
  Atomics.wait = (...args) => {
    waits += 1;
    return originalWait(...args);
  };
  syncBuiltinESMExports();
  try {
    const { VAULT_LOCK_BUSY, withVaultPathLock } = await load('rename-preflight');
    let busy = false;
    let errorCode = null;
    try {
      const value = withVaultPathLock(fx.vault, fx.target, () => {
        entered = true;
        return 'não deve entrar';
      }, { timeoutMs: 40, staleMs: 0 });
      busy = value === VAULT_LOCK_BUSY;
    } catch (error) {
      errorCode = error?.code || null;
    }
    const pending = fs.readdirSync(join(fx.vault, '.brain', 'runtime'))
      .filter((name) => name.endsWith('.pending'));
    return {
      busy, errorCode, entered, injected, renameCalls, waits, lockChecksAfterPending,
      lockExists: fs.existsSync(fx.lock), pending,
    };
  } finally {
    fs.lstatSync = originalLstat;
    fs.renameSync = originalRename;
    Atomics.wait = originalWait;
    syncBuiltinESMExports();
    fs.rmSync(fx.vault, { recursive: true, force: true });
  }
}

async function sharedRetryBudget() {
  const fx = fixture('wk-vault-lock-shared-budget-');
  deadOwner(fx, { lease: true });
  const originalRealpath = fs.realpathSync.native;
  const originalWait = Atomics.wait;
  let publicInjected = 0;
  let ownerInjected = 0;
  let waits = 0;
  let entered = false;
  fs.realpathSync.native = function sharedBudgetRealpath(path, ...args) {
    if (resolve(String(path)) === resolve(fx.lock) && publicInjected < 2) {
      publicInjected += 1;
      const error = new Error('lock público ENOENT transitório');
      error.code = 'ENOENT';
      throw error;
    }
    if (resolve(String(path)) === resolve(fx.owner) && ownerInjected < 2) {
      ownerInjected += 1;
      const error = new Error('owner ENOENT transitório');
      error.code = 'ENOENT';
      throw error;
    }
    return originalRealpath.call(this, path, ...args);
  };
  Atomics.wait = () => {
    waits += 1;
    return 'timed-out';
  };
  syncBuiltinESMExports();
  try {
    const { withVaultPathLock } = await load('shared-budget');
    let errorCode = null;
    let causeCode = null;
    try {
      withVaultPathLock(fx.vault, fx.target, () => {
        entered = true;
        return 'não deve entrar';
      }, { timeoutMs: 1000, staleMs: -1 });
    } catch (error) {
      errorCode = error?.code || null;
      causeCode = error?.cause?.code || null;
    }
    return { publicInjected, ownerInjected, waits, entered, errorCode, causeCode };
  } finally {
    fs.realpathSync.native = originalRealpath;
    Atomics.wait = originalWait;
    syncBuiltinESMExports();
    fs.rmSync(fx.vault, { recursive: true, force: true });
  }
}

async function retryDeadline() {
  const fx = fixture('wk-vault-lock-retry-deadline-');
  deadOwner(fx, { lease: true });
  const originalRealpath = fs.realpathSync.native;
  const originalWait = Atomics.wait;
  const originalNow = Date.now;
  let now = 1_000_000;
  let publicRealpaths = 0;
  let waits = 0;
  let entered = false;
  Date.now = () => now;
  fs.realpathSync.native = function deadlineRealpath(path, ...args) {
    if (resolve(String(path)) === resolve(fx.lock)) {
      publicRealpaths += 1;
      if (publicRealpaths === 1) {
        const error = new Error('lock público ENOENT antes do deadline');
        error.code = 'ENOENT';
        throw error;
      }
    }
    return originalRealpath.call(this, path, ...args);
  };
  Atomics.wait = () => {
    waits += 1;
    now += 11;
    return 'timed-out';
  };
  syncBuiltinESMExports();
  try {
    const { VAULT_LOCK_BUSY, withVaultPathLock } = await load('retry-deadline');
    const value = withVaultPathLock(fx.vault, fx.target, () => {
      entered = true;
      return 'não deve entrar';
    }, { timeoutMs: 10, staleMs: 0 });
    return {
      busy: value === VAULT_LOCK_BUSY, entered, publicRealpaths, waits,
    };
  } finally {
    Date.now = originalNow;
    fs.realpathSync.native = originalRealpath;
    Atomics.wait = originalWait;
    syncBuiltinESMExports();
    fs.rmSync(fx.vault, { recursive: true, force: true });
  }
}

try {
  let result;
  if (scenario === 'owner-enoent') result = await ownerRead('ENOENT');
  else if (scenario === 'owner-eacces') result = await ownerRead('EACCES');
  else if (scenario === 'retry-budget') result = await retryBudget();
  else if (scenario === 'release-enoent') result = await releaseRace();
  else if (scenario === 'rename-collision') result = await renameRace('NATIVE');
  else if (scenario === 'rename-eacces') result = await renameRace('EACCES');
  else if (scenario === 'rename-eperm-bad-dest') result = await renameRace('EPERM_BAD_DEST');
  else if (scenario === 'rename-eexist-bad-path') result = await renameRace('EEXIST_BAD_PATH');
  else if (scenario === 'rename-eexist-bad-syscall') result = await renameRace('EEXIST_BAD_SYSCALL');
  else if (scenario === 'pending-post-mkdir') result = await pendingPostMkdirRace();
  else if (scenario === 'pending-preexisting') result = await pendingPreexistingRace();
  else if (scenario === 'rename-preflight') result = await renamePreflightRace();
  else if (scenario === 'shared-retry-budget') result = await sharedRetryBudget();
  else if (scenario === 'retry-deadline') result = await retryDeadline();
  else throw new Error(`cenário desconhecido: ${scenario}`);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error?.stack || String(error));
  process.exitCode = 1;
}
