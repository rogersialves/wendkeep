import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const WORKTREE_REGISTRY_SCHEMA = 1;
export const WORKTREE_REGISTRY_REL = 'wendkeep/worktrees-v1.json';

function worktreeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function gitOutput(startDir, args, spawn = spawnSync) {
  const result = spawn('git', args, {
    cwd: startDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw worktreeError(
      'WENDKEEP_WORKTREE_GIT_FAILED',
      String(result.stderr || result.error?.message || `git ${args[0]} falhou`).trim(),
    );
  }
  return String(result.stdout || '').trim();
}

function absoluteGitPath(repoRoot, value) {
  return resolve(isAbsolute(value) ? value : join(repoRoot, value));
}

function parseWorktreeList(text) {
  const records = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: resolve(line.slice('worktree '.length)) };
      records.push(current);
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (current && line === 'bare') {
      current.bare = true;
    } else if (current && line === 'detached') {
      current.detached = true;
    }
  }
  return records;
}

export function discoverWorktreeRepository({ startDir = process.cwd(), spawn = spawnSync } = {}) {
  const repoRoot = resolve(gitOutput(startDir, ['rev-parse', '--show-toplevel'], spawn));
  const commonDir = absoluteGitPath(
    repoRoot,
    gitOutput(repoRoot, ['rev-parse', '--git-common-dir'], spawn),
  );
  const gitDir = absoluteGitPath(
    repoRoot,
    gitOutput(repoRoot, ['rev-parse', '--git-dir'], spawn),
  );
  const worktrees = parseWorktreeList(gitOutput(repoRoot, ['worktree', 'list', '--porcelain'], spawn));
  const main = worktrees.find((entry) => !entry.bare) || null;
  if (!main) {
    throw worktreeError(
      'WENDKEEP_WORKTREE_MAIN_UNRESOLVED',
      'Não foi possível localizar a worktree principal do repositório.',
    );
  }
  return {
    repoRoot,
    commonDir,
    gitDir,
    mainWorktree: main.path,
    worktrees,
  };
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function withWorktreeRegistryLock(registryPath, operation, {
  timeoutMs = 5_000,
  staleMs = 30_000,
  now = () => Date.now(),
} = {}) {
  const lockPath = `${registryPath}.lock`;
  const startedAt = now();
  mkdirSync(dirname(registryPath), { recursive: true });
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (now() - statSync(lockPath).mtimeMs > staleMs) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (inspectError) {
        if (inspectError?.code !== 'ENOENT') throw inspectError;
        continue;
      }
      if (now() - startedAt >= timeoutMs) {
        throw worktreeError(
          'WENDKEEP_WORKTREE_REGISTRY_BUSY',
          `Registry de worktrees ocupado: ${registryPath}`,
        );
      }
      sleep(20);
    }
  }
  try {
    return operation();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, path);
  return true;
}

function validateRegistry(value, path) {
  if (
    value?.schemaVersion !== WORKTREE_REGISTRY_SCHEMA
    || typeof value.repositoryId !== 'string'
    || !value.repositoryId
    || typeof value.projectId !== 'string'
    || !value.projectId
    || typeof value.vaultPath !== 'string'
    || !value.vaultPath
    || !value.entries
    || typeof value.entries !== 'object'
    || Array.isArray(value.entries)
  ) {
    throw worktreeError(
      'WENDKEEP_WORKTREE_REGISTRY_INVALID',
      `Registry de worktrees incompleto em "${path}".`,
    );
  }
  return value;
}

function parseRegistry(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw worktreeError(
      'WENDKEEP_WORKTREE_REGISTRY_INVALID',
      `Registry de worktrees inválido em "${path}": ${error.message}`,
    );
  }
  return validateRegistry(value, path);
}

export function readWorktreeRegistry(repository) {
  const path = join(repository.commonDir, ...WORKTREE_REGISTRY_REL.split('/'));
  return existsSync(path) ? { path, registry: parseRegistry(path) } : { path, registry: null };
}

export function resolveWorktreeVaultBinding({ startDir = process.cwd(), projectId } = {}) {
  let repository;
  try {
    repository = discoverWorktreeRepository({ startDir });
  } catch (error) {
    if (error?.code === 'WENDKEEP_WORKTREE_GIT_FAILED') return null;
    throw error;
  }
  const { path, registry } = readWorktreeRegistry(repository);
  if (!registry) return null;
  if (registry.projectId !== projectId) {
    throw worktreeError(
      'WENDKEEP_WORKTREE_PROJECT_MISMATCH',
      `Registry "${path}" pertence ao projeto "${registry.projectId}", não "${projectId}".`,
    );
  }
  return {
    base: resolve(registry.vaultPath),
    projectId: registry.projectId,
    repositoryId: registry.repositoryId,
    registryPath: path,
    projectRoot: repository.mainWorktree,
    repository,
  };
}

export function mutateWorktreeRegistry(repository, mutator) {
  if (!repository?.commonDir || typeof mutator !== 'function') {
    throw worktreeError('WENDKEEP_WORKTREE_REPOSITORY_INVALID', 'Repositório Git inválido.');
  }
  const registryPath = join(repository.commonDir, ...WORKTREE_REGISTRY_REL.split('/'));
  return withWorktreeRegistryLock(registryPath, () => {
    if (!existsSync(registryPath)) {
      throw worktreeError(
        'WENDKEEP_WORKTREE_REGISTRY_MISSING',
        `Registry de worktrees ausente em "${registryPath}".`,
      );
    }
    const current = parseRegistry(registryPath);
    const next = validateRegistry(mutator(structuredClone(current)), registryPath);
    atomicJson(registryPath, next);
    return next;
  });
}

export function worktreeIdentity(repositoryId, gitDir) {
  return createHash('sha256')
    .update(`${repositoryId}\n${resolve(gitDir).replaceAll('\\', '/').toLowerCase()}\n`)
    .digest('hex');
}

export function ensureWorktreeMetadata({
  repository,
  projectId,
  vaultPath,
  worktreesRoot = '.worktrees',
} = {}) {
  if (!repository?.commonDir || !repository?.gitDir) {
    throw worktreeError('WENDKEEP_WORKTREE_REPOSITORY_INVALID', 'Repositório Git inválido.');
  }
  const registryPath = join(repository.commonDir, ...WORKTREE_REGISTRY_REL.split('/'));
  const normalizedVault = resolve(String(vaultPath || ''));
  const registry = withWorktreeRegistryLock(registryPath, () => {
    const current = existsSync(registryPath) ? parseRegistry(registryPath) : null;
    if (current && current.projectId !== projectId) {
      throw worktreeError(
        'WENDKEEP_WORKTREE_PROJECT_MISMATCH',
        `Registry pertence a outro projeto: ${current.projectId}.`,
      );
    }
    if (current && resolve(current.vaultPath) !== normalizedVault) {
      throw worktreeError(
        'WENDKEEP_WORKTREE_VAULT_MISMATCH',
        'Registry aponta para outro Vault canônico.',
      );
    }
    const next = current || {
      schemaVersion: WORKTREE_REGISTRY_SCHEMA,
      repositoryId: randomUUID(),
      projectId,
      vaultPath: normalizedVault,
      worktreesRoot,
      entries: {},
    };
    atomicJson(registryPath, next);
    return next;
  });
  return {
    registryPath,
    repositoryId: registry.repositoryId,
    currentWorktreeId: worktreeIdentity(registry.repositoryId, repository.gitDir),
    registry,
  };
}
