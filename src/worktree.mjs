import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { resolveProjectVault } from './project-vault.mjs';
import { getLocale } from '../packages/vault/src/locale.mjs';
import {
  discoverWorktreeRepository,
  ensureWorktreeMetadata,
  mutateWorktreeRegistry,
  readWorktreeRegistry,
  worktreeIdentity,
} from '../packages/vault/src/worktree-metadata.mjs';

function worktreeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function git(repositoryRoot, args, { ok = true, spawn = spawnSync } = {}) {
  const result = spawn('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (ok && result.status !== 0) {
    throw worktreeError(
      'WENDKEEP_WORKTREE_GIT_FAILED',
      String(result.stderr || result.error?.message || `git ${args[0]} falhou`).trim(),
      { gitArgs: [...args], status: result.status },
    );
  }
  return result;
}

function assertSlug(slug) {
  const value = String(slug || '');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) || value === '.' || value === '..') {
    throw worktreeError(
      'WENDKEEP_WORKTREE_SLUG_INVALID',
      `Slug de worktree inválido: "${value}".`,
    );
  }
  return value;
}

function assertContained(root, target) {
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || resolve(root, rel) !== target) {
    throw worktreeError(
      'WENDKEEP_WORKTREE_PATH_OUTSIDE_ROOT',
      `Path de worktree fora da raiz permitida: "${target}".`,
    );
  }
}

function assertNoSymlinkEscape(root, target) {
  let current = target;
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw worktreeError(
          'WENDKEEP_WORKTREE_PATH_SYMLINK_ESCAPE',
          `Path de worktree atravessa link simbólico ou junction: "${current}".`,
        );
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (current === root) return;
    const parent = dirname(current);
    if (parent === current) {
      throw worktreeError(
        'WENDKEEP_WORKTREE_PATH_OUTSIDE_ROOT',
        `Path de worktree fora da raiz permitida: "${target}".`,
      );
    }
    current = parent;
  }
}

function refExists(repositoryRoot, ref, spawn) {
  return git(repositoryRoot, ['show-ref', '--verify', '--quiet', ref], { ok: false, spawn }).status === 0;
}

function defaultBase(repositoryRoot, spawn) {
  const remoteHead = git(
    repositoryRoot,
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    { ok: false, spawn },
  );
  if (remoteHead.status === 0) return String(remoteHead.stdout).trim().replace(/^[^/]+\//, '');
  for (const candidate of ['main', 'master']) {
    if (refExists(repositoryRoot, `refs/heads/${candidate}`, spawn)) return candidate;
  }
  const configured = git(repositoryRoot, ['config', '--get', 'init.defaultBranch'], { ok: false, spawn });
  if (configured.status === 0 && String(configured.stdout).trim()) return String(configured.stdout).trim();
  const current = git(repositoryRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { ok: false, spawn });
  if (current.status === 0 && String(current.stdout).trim()) return String(current.stdout).trim();
  throw worktreeError(
    'WENDKEEP_WORKTREE_BASE_UNRESOLVED',
    'Não foi possível resolver a branch base do repositório.',
  );
}

function ensurePrivateExclude(repository, value, { directory = true } = {}) {
  const excludePath = join(repository.commonDir, 'info', 'exclude');
  mkdirSync(dirname(excludePath), { recursive: true });
  const bare = String(value).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const normalized = directory ? `${bare}/` : bare;
  const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(normalized)) return false;
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  writeFileSync(excludePath, `${current}${prefix}${normalized}\n`, 'utf8');
  return true;
}

function vscodeWorktreeTasks() {
  return {
    version: '2.0.0',
    tasks: [
      {
        label: 'WendKeep: Create worktree',
        type: 'process',
        command: 'npx',
        args: ['--no-install', 'wendkeep', 'worktree', 'create', '${input:wendkeepWorktreeSlug}', '--open', 'vscode'],
        problemMatcher: [],
      },
      {
        label: 'WendKeep: List worktrees',
        type: 'process',
        command: 'npx',
        args: ['--no-install', 'wendkeep', 'worktree', 'list'],
        problemMatcher: [],
      },
      {
        label: 'WendKeep: Open worktree',
        type: 'process',
        command: 'npx',
        args: ['--no-install', 'wendkeep', 'worktree', 'open', '${input:wendkeepWorktreeSlug}'],
        problemMatcher: [],
      },
    ],
    inputs: [{
      id: 'wendkeepWorktreeSlug',
      type: 'promptString',
      description: 'Managed worktree slug',
    }],
  };
}

export function installVscodeWorktreeTasks({ projectRoot = process.cwd(), spawn = spawnSync } = {}) {
  const repository = discoverWorktreeRepository({ startDir: projectRoot, spawn });
  const tasksPath = join(resolve(projectRoot), '.vscode', 'tasks.json');
  const rendered = `${JSON.stringify(vscodeWorktreeTasks(), null, 2)}\n`;
  const tracked = git(resolve(projectRoot), [
    'ls-files', '--error-unmatch', '--', '.vscode/tasks.json',
  ], { ok: false, spawn });
  if (tracked.status === 0) {
    return { path: tasksPath, state: 'conflict' };
  }
  if (existsSync(tasksPath)) {
    return {
      path: tasksPath,
      state: readFileSync(tasksPath, 'utf8') === rendered ? 'unchanged' : 'conflict',
    };
  }
  mkdirSync(dirname(tasksPath), { recursive: true });
  writeFileSync(tasksPath, rendered, 'utf8');
  ensurePrivateExclude(repository, '.vscode/tasks.json', { directory: false });
  return { path: tasksPath, state: 'created' };
}

function matchingReadyEntry(entry, { path, branch }) {
  return entry?.state === 'ready'
    && resolve(entry.path) === path
    && entry.branch === branch
    && existsSync(path);
}

function resolveWorktreeProjectBinding(repository, startDir) {
  if (comparablePath(repository.repoRoot) === comparablePath(repository.mainWorktree)) {
    return resolveProjectVault({ startDir });
  }
  const mainBinding = resolveProjectVault({ startDir: repository.mainWorktree });
  const linkedBinding = resolveProjectVault({ startDir, validateIdentity: false });
  const equivalent = comparablePath(linkedBinding.projectRoot) === comparablePath(repository.repoRoot)
    && linkedBinding.projectId === mainBinding.projectId
    && linkedBinding.config?.vault === mainBinding.config?.vault;
  if (!equivalent) {
    throw worktreeError(
      'WENDKEEP_WORKTREE_BINDING_INVALID',
      'O binding versionado da linked worktree diverge da worktree principal.',
    );
  }
  try {
    return resolveProjectVault({ startDir });
  } catch (error) {
    if (error?.code !== 'WENDKEEP_VAULT_MARKER_MISSING') throw error;
    return mainBinding;
  }
}

function comparablePath(value) {
  let normalized = resolve(String(value || ''));
  try { normalized = realpathSync.native(normalized); } catch { /* unresolved suffix */ }
  normalized = normalized.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function bindingHealth(startDir, expectedProjectId) {
  try {
    const binding = resolveProjectVault({ startDir });
    return {
      healthy: binding.projectId === expectedProjectId,
      projectId: binding.projectId,
      source: binding.source,
      ...(binding.projectId === expectedProjectId
        ? {}
        : { errorCode: 'WENDKEEP_WORKTREE_PROJECT_MISMATCH' }),
    };
  } catch (error) {
    return {
      healthy: false,
      projectId: expectedProjectId,
      source: 'unresolved',
      errorCode: error?.code || 'WENDKEEP_WORKTREE_BINDING_INVALID',
    };
  }
}

export function listManagedWorktrees({ startDir = process.cwd(), spawn = spawnSync } = {}) {
  const repository = discoverWorktreeRepository({ startDir, spawn });
  const { registry } = readWorktreeRegistry(repository);
  if (!registry) {
    throw worktreeError(
      'WENDKEEP_WORKTREE_REGISTRY_MISSING',
      'Registry de worktrees ainda não foi inicializado neste repositório.',
    );
  }
  const gitByPath = new Map(repository.worktrees.map((entry) => [comparablePath(entry.path), entry]));
  const worktrees = Object.values(registry.entries)
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map((entry) => {
      const gitEntry = gitByPath.get(comparablePath(entry.path)) || null;
      const present = Boolean(gitEntry);
      const state = present ? entry.state : (entry.state === 'failed' ? 'failed' : 'missing');
      return {
        slug: entry.slug,
        worktreeId: entry.worktreeId || '',
        path: entry.path,
        branch: gitEntry?.branch || entry.branch || '',
        head: gitEntry?.head || entry.head || '',
        base: entry.base || '',
        state,
        git: {
          present,
          detached: Boolean(gitEntry?.detached),
        },
        binding: bindingHealth(present ? entry.path : startDir, registry.projectId),
        ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
        ...(entry.recovery ? { recovery: entry.recovery } : {}),
      };
    });
  return {
    schemaVersion: registry.schemaVersion,
    repositoryId: registry.repositoryId,
    projectId: registry.projectId,
    worktrees,
  };
}

export function managedWorktreeStatus({
  startDir = process.cwd(),
  slug,
  spawn = spawnSync,
} = {}) {
  const listed = listManagedWorktrees({ startDir, spawn });
  const safeSlug = slug ? assertSlug(slug) : '';
  const currentRepository = safeSlug ? null : discoverWorktreeRepository({ startDir, spawn });
  const found = safeSlug
    ? listed.worktrees.find((entry) => entry.slug === safeSlug)
    : listed.worktrees.find((entry) => comparablePath(entry.path) === comparablePath(currentRepository.repoRoot));
  if (!found) {
    throw worktreeError(
      'WENDKEEP_WORKTREE_NOT_FOUND',
      `Worktree gerenciada não encontrada: "${safeSlug}".`,
    );
  }
  return found;
}

export function diagnoseManagedWorktrees({ startDir = process.cwd(), spawn = spawnSync } = {}) {
  let listed;
  try {
    listed = listManagedWorktrees({ startDir, spawn });
  } catch (error) {
    if (error?.code === 'WENDKEEP_WORKTREE_REGISTRY_MISSING'
      || error?.code === 'WENDKEEP_WORKTREE_GIT_FAILED') {
      return { initialized: false, issues: [] };
    }
    throw error;
  }
  const issues = listed.worktrees
    .filter((entry) => entry.state !== 'ready' || !entry.binding.healthy)
    .map((entry) => ({
      slug: entry.slug,
      state: entry.state,
      errorCode: entry.errorCode || entry.binding.errorCode || 'WENDKEEP_WORKTREE_UNHEALTHY',
      repair: entry.recovery || `wendkeep worktree status ${entry.slug}`,
    }));
  return { initialized: true, issues };
}

const WORKTREE_VALUE_OPTIONS = new Set(['--base', '--branch', '--open', '--editor', '--project']);
const WORKTREE_FLAG_OPTIONS = new Set(['--json']);

function parseWorktreeArgv(argv) {
  const values = new Map();
  const flags = new Set();
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (WORKTREE_FLAG_OPTIONS.has(arg)) {
      if (flags.has(arg)) throw worktreeError('WENDKEEP_WORKTREE_USAGE', `Flag repetida: ${arg}.`);
      flags.add(arg);
      continue;
    }
    const inline = [...WORKTREE_VALUE_OPTIONS].find((name) => arg.startsWith(`${name}=`));
    if (inline) {
      if (values.has(inline)) throw worktreeError('WENDKEEP_WORKTREE_USAGE', `Opção repetida: ${inline}.`);
      values.set(inline, arg.slice(inline.length + 1));
      continue;
    }
    if (WORKTREE_VALUE_OPTIONS.has(arg)) {
      if (values.has(arg) || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
        throw worktreeError('WENDKEEP_WORKTREE_USAGE', `Opção inválida ou repetida: ${arg}.`);
      }
      values.set(arg, argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw worktreeError('WENDKEEP_WORKTREE_USAGE', `Opção desconhecida: ${arg}.`);
    }
    positional.push(arg);
  }
  return { values, flags, positional };
}

function assertCommandOptions(command, parsed) {
  const allowed = {
    create: new Set(['--base', '--branch', '--open', '--project']),
    list: new Set(['--project']),
    status: new Set(['--project']),
    open: new Set(['--editor', '--project']),
  }[command];
  if (!allowed) return;
  for (const name of parsed.values.keys()) {
    if (!allowed.has(name)) {
      throw worktreeError('WENDKEEP_WORKTREE_USAGE', `${name} não é válido para worktree ${command}.`);
    }
  }
}

const ERROR_TEXT = {
  en: {
    WENDKEEP_WORKTREE_FAILED: 'Worktree command failed.',
    WENDKEEP_WORKTREE_GIT_FAILED: 'Git command failed.',
    WENDKEEP_WORKTREE_BASE_UNRESOLVED: 'The repository base branch could not be resolved.',
    WENDKEEP_WORKTREE_MAIN_UNRESOLVED: 'The main worktree could not be resolved.',
    WENDKEEP_WORKTREE_REPOSITORY_INVALID: 'The Git repository is invalid.',
    WENDKEEP_WORKTREE_REGISTRY_MISSING: 'The worktree registry has not been initialized.',
    WENDKEEP_WORKTREE_REGISTRY_INVALID: 'The worktree registry is invalid.',
    WENDKEEP_WORKTREE_REGISTRY_BUSY: 'The worktree registry is busy.',
    WENDKEEP_WORKTREE_PROJECT_MISMATCH: 'The worktree project identity does not match.',
    WENDKEEP_WORKTREE_VAULT_MISMATCH: 'The worktree Vault binding does not match.',
    WENDKEEP_WORKTREE_BINDING_INVALID: 'The worktree project binding is invalid.',
    WENDKEEP_VAULT_CONFIG_INVALID: 'The WendKeep project binding is invalid.',
    WENDKEEP_VAULT_MARKER_MISSING: 'The bound WendKeep Vault marker was not found.',
    WENDKEEP_VAULT_PROJECT_MISMATCH: 'The bound WendKeep Vault belongs to another project.',
    WENDKEEP_VAULT_UNCONFIGURED: 'No WendKeep Vault is bound to this project.',
    WENDKEEP_WORKTREE_SLUG_INVALID: 'Invalid worktree slug.',
    WENDKEEP_WORKTREE_BRANCH_INVALID: 'Invalid worktree branch.',
    WENDKEEP_WORKTREE_PATH_OUTSIDE_ROOT: 'Worktree path is outside the configured root.',
    WENDKEEP_WORKTREE_PATH_SYMLINK_ESCAPE: 'Worktree path crosses a symbolic link or junction.',
    WENDKEEP_WORKTREE_ROOT_INVALID: 'The configured worktree root is invalid.',
    WENDKEEP_WORKTREE_COLLISION: 'Worktree slug collides with existing state.',
    WENDKEEP_WORKTREE_EDITOR_NOT_FOUND: 'VS Code command `code` was not found.',
    WENDKEEP_WORKTREE_EDITOR_OPEN_FAILED: 'VS Code could not open the worktree.',
    WENDKEEP_WORKTREE_EDITOR_UNSUPPORTED: 'Unsupported worktree editor.',
    WENDKEEP_WORKTREE_NOT_FOUND: 'Managed worktree was not found.',
    WENDKEEP_WORKTREE_NOT_READY: 'Managed worktree is not ready.',
    WENDKEEP_WORKTREE_USAGE: 'Invalid worktree command usage.',
  },
  'pt-BR': {
    WENDKEEP_WORKTREE_FAILED: 'Falha no comando worktree.',
    WENDKEEP_WORKTREE_GIT_FAILED: 'Comando Git falhou.',
    WENDKEEP_WORKTREE_BASE_UNRESOLVED: 'Não foi possível resolver a branch base do repositório.',
    WENDKEEP_WORKTREE_MAIN_UNRESOLVED: 'Não foi possível resolver a worktree principal.',
    WENDKEEP_WORKTREE_REPOSITORY_INVALID: 'O repositório Git é inválido.',
    WENDKEEP_WORKTREE_REGISTRY_MISSING: 'O registry de worktrees ainda não foi inicializado.',
    WENDKEEP_WORKTREE_REGISTRY_INVALID: 'O registry de worktrees é inválido.',
    WENDKEEP_WORKTREE_REGISTRY_BUSY: 'O registry de worktrees está ocupado.',
    WENDKEEP_WORKTREE_PROJECT_MISMATCH: 'A identidade de projeto da worktree não corresponde.',
    WENDKEEP_WORKTREE_VAULT_MISMATCH: 'O vínculo de Vault da worktree não corresponde.',
    WENDKEEP_WORKTREE_BINDING_INVALID: 'O binding de projeto da worktree é inválido.',
    WENDKEEP_VAULT_CONFIG_INVALID: 'O binding de projeto WendKeep é inválido.',
    WENDKEEP_VAULT_MARKER_MISSING: 'O marcador do Vault WendKeep vinculado não foi encontrado.',
    WENDKEEP_VAULT_PROJECT_MISMATCH: 'O Vault WendKeep vinculado pertence a outro projeto.',
    WENDKEEP_VAULT_UNCONFIGURED: 'Nenhum Vault WendKeep está vinculado a este projeto.',
    WENDKEEP_WORKTREE_SLUG_INVALID: 'Slug de worktree inválido.',
    WENDKEEP_WORKTREE_BRANCH_INVALID: 'Branch de worktree inválida.',
    WENDKEEP_WORKTREE_PATH_OUTSIDE_ROOT: 'Path de worktree fora da raiz configurada.',
    WENDKEEP_WORKTREE_PATH_SYMLINK_ESCAPE: 'Path de worktree atravessa link simbólico ou junction.',
    WENDKEEP_WORKTREE_ROOT_INVALID: 'A raiz configurada de worktrees é inválida.',
    WENDKEEP_WORKTREE_COLLISION: 'Slug colide com estado de worktree existente.',
    WENDKEEP_WORKTREE_EDITOR_NOT_FOUND: 'Comando `code` do VS Code não foi encontrado.',
    WENDKEEP_WORKTREE_EDITOR_OPEN_FAILED: 'O VS Code não conseguiu abrir a worktree.',
    WENDKEEP_WORKTREE_EDITOR_UNSUPPORTED: 'Editor de worktree não suportado.',
    WENDKEEP_WORKTREE_NOT_FOUND: 'Worktree gerenciada não encontrada.',
    WENDKEEP_WORKTREE_NOT_READY: 'Worktree gerenciada ainda não está pronta.',
    WENDKEEP_WORKTREE_USAGE: 'Uso inválido do comando worktree.',
  },
};

function commandLocale(startDir) {
  try { return getLocale(resolveProjectVault({ startDir }).base).id; }
  catch { return 'pt-BR'; }
}

function renderWorktreeError(error, locale) {
  const code = error?.code || 'WENDKEEP_WORKTREE_FAILED';
  return `${code}: ${ERROR_TEXT[locale]?.[code] || ERROR_TEXT[locale]?.WENDKEEP_WORKTREE_FAILED}`;
}

function renderWorktreeLine(worktree) {
  const binding = worktree.binding
    ? (worktree.binding.healthy ? 'healthy' : (worktree.binding.errorCode || 'unhealthy'))
    : 'unknown';
  return [
    `slug=${worktree.slug || ''}`,
    `identity=${worktree.worktreeId || ''}`,
    `path=${worktree.path || ''}`,
    `branch=${worktree.branch || ''}`,
    `head=${worktree.head || ''}`,
    `state=${worktree.state || ''}`,
    `binding=${binding}`,
  ].join(' ');
}

function writeWorktreeResult(payload, { json, locale, action }) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...payload })}\n`);
    return;
  }
  const subject = payload.worktree?.slug || `${payload.worktrees?.length || 0}`;
  const messages = locale === 'en'
    ? { create: `worktree created: ${subject}`, list: `managed worktrees: ${subject}`, status: `worktree status: ${subject}`, open: `worktree opened: ${subject}` }
    : { create: `worktree criada: ${subject}`, list: `worktrees gerenciadas: ${subject}`, status: `status da worktree: ${subject}`, open: `worktree aberta: ${subject}` };
  const details = action === 'list'
    ? payload.worktrees.map(renderWorktreeLine)
    : (action === 'status' ? [renderWorktreeLine(payload.worktree)] : []);
  process.stdout.write(`${messages[action]}${details.length ? `\n${details.join('\n')}` : ''}\n`);
}

export function runWorktree(argv = []) {
  let parsed;
  let locale = 'pt-BR';
  try {
    parsed = parseWorktreeArgv(argv);
    const [command, ...positionals] = parsed.positional;
    assertCommandOptions(command, parsed);
    const startDir = parsed.values.get('--project') || process.cwd();
    locale = commandLocale(startDir);
    const json = parsed.flags.has('--json');
    if (command === 'create') {
      if (positionals.length !== 1) throw worktreeError('WENDKEEP_WORKTREE_USAGE', 'create requer <slug>.');
      const worktree = createManagedWorktree({
        startDir,
        slug: positionals[0],
        base: parsed.values.get('--base') || '',
        branch: parsed.values.get('--branch') || '',
        open: parsed.values.get('--open') || 'none',
      });
      writeWorktreeResult({ worktree }, { json, locale, action: 'create' });
      return 0;
    }
    if (command === 'list') {
      if (positionals.length) throw worktreeError('WENDKEEP_WORKTREE_USAGE', 'list não aceita slug.');
      const listed = listManagedWorktrees({ startDir });
      writeWorktreeResult(listed, { json, locale, action: 'list' });
      return 0;
    }
    if (command === 'status') {
      if (positionals.length > 1) throw worktreeError('WENDKEEP_WORKTREE_USAGE', 'status aceita no máximo um slug.');
      const worktree = managedWorktreeStatus({ startDir, slug: positionals[0] || '' });
      writeWorktreeResult({ worktree }, { json, locale, action: 'status' });
      return 0;
    }
    if (command === 'open') {
      if (positionals.length !== 1) throw worktreeError('WENDKEEP_WORKTREE_USAGE', 'open requer <slug>.');
      const worktree = openManagedWorktree({
        startDir,
        slug: positionals[0],
        editor: parsed.values.get('--editor') || 'vscode',
      });
      writeWorktreeResult({ worktree }, { json, locale, action: 'open' });
      return 0;
    }
    throw worktreeError('WENDKEEP_WORKTREE_USAGE', 'Use create, list, status ou open.');
  } catch (error) {
    process.stderr.write(`${renderWorktreeError(error, locale)}\n`);
    return 2;
  }
}

function openWorktreePath(path, editor, spawn) {
  if (editor !== 'vscode') {
    throw worktreeError(
      'WENDKEEP_WORKTREE_EDITOR_UNSUPPORTED',
      `Editor não suportado: "${editor}".`,
    );
  }
  const probe = spawn('code', ['--version'], {
    cwd: path,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (probe.status !== 0) {
    throw worktreeError(
      'WENDKEEP_WORKTREE_EDITOR_NOT_FOUND',
      'VS Code não encontrado no PATH; instale o comando `code` ou use `--open none`.',
    );
  }
  const opened = spawn('code', ['-n', path], {
    cwd: path,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (opened.status !== 0) {
    throw worktreeError(
      'WENDKEEP_WORKTREE_EDITOR_OPEN_FAILED',
      String(opened.stderr || 'Falha ao abrir a worktree no VS Code.').trim(),
    );
  }
  return { opened: true, editor: 'vscode', path };
}

export function openManagedWorktree({
  startDir = process.cwd(),
  slug,
  editor = 'vscode',
  spawn = spawnSync,
} = {}) {
  const status = managedWorktreeStatus({ startDir, slug, spawn });
  if (!status.git.present || status.state !== 'ready') {
    throw worktreeError(
      'WENDKEEP_WORKTREE_NOT_READY',
      `Worktree "${status.slug}" não está pronta para abrir.`,
    );
  }
  return { ...status, ...openWorktreePath(status.path, editor, spawn) };
}

export function createManagedWorktree({
  startDir = process.cwd(),
  slug,
  base = '',
  branch = '',
  open = 'none',
  spawn = spawnSync,
  now = () => new Date().toISOString(),
} = {}) {
  const safeSlug = assertSlug(slug);
  if (!['none', 'vscode'].includes(open)) {
    throw worktreeError('WENDKEEP_WORKTREE_EDITOR_UNSUPPORTED', `Editor não suportado: "${open}".`);
  }
  const repository = discoverWorktreeRepository({ startDir, spawn });
  const binding = resolveWorktreeProjectBinding(repository, startDir);
  const configuredRoot = binding.config?.worktrees?.root;
  const rootSetting = configuredRoot === undefined ? '.worktrees' : configuredRoot;
  if (typeof rootSetting !== 'string' || !rootSetting.trim()) {
    throw worktreeError(
      'WENDKEEP_WORKTREE_ROOT_INVALID',
      'A configuração worktrees.root deve ser um path relativo não vazio.',
    );
  }
  const worktreesRoot = resolve(repository.mainWorktree, rootSetting);
  assertContained(repository.mainWorktree, worktreesRoot);
  const targetPath = resolve(worktreesRoot, safeSlug);
  assertContained(worktreesRoot, targetPath);
  assertNoSymlinkEscape(repository.mainWorktree, targetPath);
  const selectedBranch = branch || `wk/${safeSlug}`;
  const branchCheck = git(repository.mainWorktree, ['check-ref-format', '--branch', selectedBranch], {
    ok: false,
    spawn,
  });
  if (branchCheck.status !== 0) {
    throw worktreeError(
      'WENDKEEP_WORKTREE_BRANCH_INVALID',
      `Branch de worktree inválida: "${selectedBranch}".`,
    );
  }
  const selectedBase = base || defaultBase(repository.mainWorktree, spawn);
  const metadata = ensureWorktreeMetadata({
    repository,
    projectId: binding.projectId,
    vaultPath: binding.base,
    worktreesRoot: rootSetting,
  });
  const existing = readWorktreeRegistry(repository).registry?.entries?.[safeSlug];
  if (matchingReadyEntry(existing, { path: targetPath, branch: selectedBranch })) {
    const opened = open === 'vscode' ? openWorktreePath(existing.path, open, spawn) : { opened: false };
    return { ...existing, ...opened, idempotent: true };
  }
  const existingGitEntry = repository.worktrees.find(
    (entry) => comparablePath(entry.path) === comparablePath(targetPath),
  );
  const matchesReservation = Boolean(existing?.path)
    && comparablePath(existing.path) === comparablePath(targetPath)
    && existing?.branch === selectedBranch
    && existing?.base === selectedBase;
  const retryingFailed = existing?.state === 'failed'
    && matchesReservation
    && (!existsSync(targetPath) || existingGitEntry?.branch === selectedBranch);
  if (existing && !retryingFailed) {
    throw worktreeError(
      'WENDKEEP_WORKTREE_COLLISION',
      `Slug "${safeSlug}" já possui estado divergente no registry.`,
    );
  }

  ensurePrivateExclude(repository, rootSetting);
  mkdirSync(worktreesRoot, { recursive: true });
  const createdAt = existing?.createdAt || now();
  mutateWorktreeRegistry(repository, (registry) => ({
    ...registry,
    entries: {
      ...registry.entries,
      [safeSlug]: {
        slug: safeSlug,
        path: targetPath,
        branch: selectedBranch,
        base: selectedBase,
        state: 'creating',
        createdAt,
        updatedAt: createdAt,
      },
    },
  }));

  let ready;
  try {
    if (!existingGitEntry) {
      const branchExists = refExists(repository.mainWorktree, `refs/heads/${selectedBranch}`, spawn);
      const args = branchExists
        ? ['worktree', 'add', targetPath, selectedBranch]
        : ['worktree', 'add', targetPath, '-b', selectedBranch, selectedBase];
      git(repository.mainWorktree, args, { spawn });
    }
    const targetRepository = discoverWorktreeRepository({ startDir: targetPath, spawn });
    const readyAt = now();
    ready = {
      slug: safeSlug,
      path: targetPath,
      branch: selectedBranch,
      base: selectedBase,
      head: String(git(targetPath, ['rev-parse', 'HEAD'], { spawn }).stdout).trim(),
      state: 'ready',
      worktreeId: worktreeIdentity(metadata.repositoryId, targetRepository.gitDir),
      createdAt,
      updatedAt: readyAt,
    };
    mutateWorktreeRegistry(repository, (registry) => ({
      ...registry,
      entries: { ...registry.entries, [safeSlug]: ready },
    }));
  } catch (error) {
    const failedAt = now();
    mutateWorktreeRegistry(repository, (registry) => ({
      ...registry,
      entries: {
        ...registry.entries,
        [safeSlug]: {
          ...registry.entries[safeSlug],
          state: 'failed',
          errorCode: error?.code || 'WENDKEEP_WORKTREE_GIT_FAILED',
          recovery: `wendkeep worktree create ${safeSlug} --base ${selectedBase} --branch ${selectedBranch} --open none`,
          updatedAt: failedAt,
        },
      },
    }));
    throw error;
  }
  const opened = open === 'vscode' ? openWorktreePath(ready.path, open, spawn) : { opened: false };
  return { ...ready, ...opened, idempotent: false };
}
