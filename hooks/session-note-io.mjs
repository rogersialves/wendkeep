// Gravação da nota de sessão: atômica e serializada.
//
// O hook `subagent-stop` dispara uma vez por subagent, então vários processos fazem
// read-modify-write na MESMA nota ao mesmo tempo. Com `writeFileSync` cru, um leitor pode
// pegar o arquivo já truncado por outro escritor; quem lê um topo sem `---` acabava
// prependando um frontmatter novo, empilhando blocos na nota (visto em produção: 4 blocos).
//
// `obsidian-common.mjs` já resolvia isso para o SESSION_REGISTRY.json; aqui o mesmo par
// (tmp + rename, lock por mkdir) fica disponível para a nota de sessão.
import { randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  assertVaultPathSafe, VAULT_LOCK_BUSY, withVaultPathLock, writeVaultFileAtomic,
} from './vault-path-safety.mjs';

export const LOCK_BUSY = Symbol('wendkeep:lock-busy');
export const LOCK_OWNER_FILE = '.owner.json';

function lockOwnerPath(lock) {
  return `${lock}/${LOCK_OWNER_FILE}`;
}

function readLockOwner(lock) {
  try {
    const owner = JSON.parse(readFileSync(lockOwnerPath(lock), 'utf8'));
    if (owner?.v !== 1 || !Number.isInteger(owner.pid) || owner.pid <= 0
        || typeof owner.token !== 'string' || !owner.token) return null;
    return owner;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this user cannot signal it.
    return error?.code === 'EPERM';
  }
}

function releaseUnownedLockDir(lock) {
  try { unlinkSync(lockOwnerPath(lock)); }
  catch (error) { if (error?.code !== 'ENOENT') return false; }
  return releaseLockDir(lock);
}

// ATENÇÃO: no Windows (Node 24), `rmSync(dir, { recursive: true, force: true })` é um NO-OP
// SILENCIOSO quando o caminho contém caractere não-ASCII — não remove e não lança. Medido:
// 20/20 falhas em `02-Sessões`, `ação`, `Mudanças`; 0/20 em caminho ASCII. Como TODA nota de
// sessão vive sob `02-Sessões/`, usar rmSync aqui deixaria o lock preso para sempre e o
// segundo escritor desistiria de gravar — perdendo turnos em silêncio.
// Locks owner-aware contêm apenas `.owner.json`; locks legados continuam vazios.
// Quando `expectedToken` é informado, um finally antigo jamais remove um lock que já
// foi substituído por outro dono (proteção contra ABA).
export function releaseLockDir(lock, expectedToken = '') {
  try {
    const ownerPath = lockOwnerPath(lock);
    if (expectedToken) {
      const owner = readLockOwner(lock);
      if (owner?.token !== expectedToken) return false;
      unlinkSync(ownerPath);
    } else if (existsSync(ownerPath)) {
      return false;
    }
    rmdirSync(lock);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
}

const FRONTMATTER = /^---\n[\s\S]*?\n---/;

function inferVaultBase(path) {
  if (!path) return '';
  let cursor = resolve(dirname(path));
  while (true) {
    try {
      const brain = lstatSync(join(cursor, '.brain'));
      if (brain.isDirectory() || brain.isSymbolicLink()) return cursor;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return '';
    cursor = parent;
  }
}

export function hasSessionFrontmatter(content) {
  return typeof content === 'string' && FRONTMATTER.test(content);
}

export function writeFileAtomic(path, content, encoding = 'utf-8', { vaultBase = '' } = {}) {
  if (vaultBase) {
    return writeVaultFileAtomic(vaultBase, path, content, encoding, {
      label: 'nota de sessão atômica',
    });
  }
  // rename é atômico no mesmo volume: ou o leitor vê o arquivo antigo inteiro, ou o novo.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, encoding);
  renameSync(tmp, path);
}

function waitBriefly(ms) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

// Roda `fn` com o lock do arquivo tomado. Devolve LOCK_BUSY quando o lock não veio dentro
// do timeout — o chamador desiste da gravação em vez de gravar sem lock.
export function withPathLock(path, fn, {
  timeoutMs = 2000,
  staleMs = 10_000,
  vaultBase = '',
} = {}) {
  if (vaultBase) {
    const outcome = withVaultPathLock(vaultBase, path, fn, { timeoutMs, staleMs });
    return outcome === VAULT_LOCK_BUSY ? LOCK_BUSY : outcome;
  }
  const lock = `${path}.lock`;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();

  while (true) {
    try {
      mkdirSync(lock);
      try {
        writeFileSync(lockOwnerPath(lock), `${JSON.stringify({
          v: 1,
          pid: process.pid,
          token,
          created_at: new Date().toISOString(),
        })}\n`, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        // No owner was published, so this is still a legacy-empty directory owned by us.
        releaseUnownedLockDir(lock);
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          const owner = readLockOwner(lock);
          // An old mtime is not proof of death: synchronous critical sections cannot
          // heartbeat. Reap only a legacy-empty lock or a verified dead PID.
          if (owner) {
            if (!processIsAlive(owner.pid)) releaseLockDir(lock, owner.token);
          } else releaseUnownedLockDir(lock);
        }
      } catch { /* outro processo pode ter liberado o lock no meio da checagem */ }
      // O deadline é checado SEMPRE, inclusive depois de tentar remover um lock morto:
      // `releaseLockDir` engole a falha, então um `continue` direto giraria para sempre.
      if (Date.now() >= deadline) return LOCK_BUSY;
      waitBriefly(10);
    }
  }

  try {
    return fn();
  } finally {
    releaseLockDir(lock, token);
  }
}

// Lock -> read -> mutator -> escrita atômica.
// O mutator devolve o conteúdo novo, ou `null` para abortar sem gravar (o caminho
// fail-closed de quem leu uma nota corrompida).
export function mutateSessionNote(path, mutator, options = {}) {
  const vaultBase = options.vaultBase || inferVaultBase(path);
  let target = path;
  if (vaultBase) {
    const checked = assertVaultPathSafe(vaultBase, path, {
      expectedType: 'file', label: 'nota de sessão',
    });
    if (!checked.exists) return { written: false, reason: 'missing', content: null };
    target = checked.target;
  } else if (!path || !existsSync(path)) {
    return { written: false, reason: 'missing', content: null };
  }

  const outcome = withPathLock(target, () => {
    if (vaultBase) {
      assertVaultPathSafe(vaultBase, target, {
        allowMissing: false, expectedType: 'file', label: 'nota de sessão',
      });
    }
    const original = readFileSync(target, 'utf-8');
    const next = mutator(original);
    if (next === null || next === undefined) return { written: false, reason: 'aborted', content: original };
    if (next === original) return { written: false, reason: 'unchanged', content: original };
    writeFileAtomic(target, next, 'utf-8', { vaultBase });
    return { written: true, reason: 'ok', content: next };
  }, { ...options, vaultBase });

  if (outcome === LOCK_BUSY) return { written: false, reason: 'busy', content: null };
  return outcome;
}
