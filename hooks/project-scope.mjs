import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOL_CWD_FIELDS = ['cwd', 'workdir', 'work_dir', 'working_directory', 'directory'];
const SAFE_GIT_COMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'reflog', 'describe', 'ls-files', 'ls-tree', 'cat-file',
  'rev-parse', 'symbolic-ref', 'for-each-ref', 'for-each-repo', 'shortlog', 'whatchanged',
]);
const MUTABLE_TOOL_NAMES = new Set([
  'apply_patch', 'ApplyPatch', 'write_file', 'Write', 'Edit', 'MultiEdit', 'delete_file',
  'remove_file', 'move_file', 'rename_file',
]);

function canonicalPath(value) {
  const candidate = resolve(String(value || process.cwd()));
  let physical = candidate;
  try { physical = realpathSync.native(candidate); } catch { /* target may not exist yet */ }
  const normalized = physical.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function displayPath(value) {
  return String(value || '').replaceAll('\\', '/');
}

function runGit(cwd, args, spawn = spawnSync) {
  const result = spawn('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || 'falhou').trim();
    const error = new Error(`git ${args.join(' ')}: ${detail}`);
    error.code = 'WENDKEEP_SCOPE_GIT_ERROR';
    throw error;
  }
  return String(result.stdout || '').trim();
}

function optionalGit(cwd, args, spawn = spawnSync) {
  try { return runGit(cwd, args, spawn); } catch { return ''; }
}

export function normalizeRemote(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    raw = url.toString().replace(/\/$/, '');
    return raw;
  } catch { /* scp-like remotes and local paths */ }
  raw = raw.replace(/^[^/\\]+@(?=[^/:]+[:/])/, '');
  return raw.replaceAll('\\', '/').replace(/\/$/, '');
}

export function extractToolCommand(input = {}) {
  const value = input?.tool_input ?? input?.toolInput ?? input;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => String(part)).join(' ');
  if (!value || typeof value !== 'object') return '';
  if (typeof value.command === 'string') return value.command;
  if (Array.isArray(value.command)) return value.command.map((part) => String(part)).join(' ');
  if (Array.isArray(value.argv)) return value.argv.map((part) => String(part)).join(' ');
  if (Array.isArray(value.args)) return value.args.map((part) => String(part)).join(' ');
  return '';
}

export function requestedToolCwd(input = {}) {
  const tool = input?.tool_input ?? input?.toolInput;
  if (tool && typeof tool === 'object' && !Array.isArray(tool)) {
    for (const field of TOOL_CWD_FIELDS) {
      if (typeof tool[field] === 'string' && tool[field].trim()) return tool[field].trim();
    }
  }
  for (const field of ['cwd', 'project_dir', 'projectDir', 'workspace']) {
    const value = field === 'workspace' ? input?.workspace?.cwd : input?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function shellSegments(command) {
  const tokens = String(command || '').match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|&&|\|\||[;|\n]|&|[^\s;&|]+/g) || [];
  const segments = [];
  let current = [];
  const flush = () => { if (current.length) segments.push(current); current = []; };
  for (const token of tokens) {
    if (['&&', '||', ';', '|', '\n'].includes(token) || (token === '&' && current.length)) {
      flush();
      continue;
    }
    current.push(token);
  }
  flush();
  return segments;
}

function unquote(token) {
  const value = String(token || '');
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"')
    || (value[0] === "'" && value.at(-1) === "'"))) return value.slice(1, -1);
  return value;
}

function executableName(token) {
  return unquote(token).replaceAll('\\', '/').split('/').at(-1).toLowerCase();
}

function invocationOf(segment) {
  let index = 0;
  while (segment[index] === '&' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index] || '')) index += 1;
  const executable = executableName(segment[index]);
  if (executable === 'git' || executable === 'git.exe' || executable === 'git.cmd') {
    return { kind: 'git', args: segment.slice(index + 1).map(unquote) };
  }
  const args = segment.slice(index + 1).map(unquote);
  if (isWendKeepContextSwitch(executable, args)) {
    return { kind: 'context-switch', args };
  }
  if (['rm', 'rm.exe', 'del', 'erase', 'remove-item', 'move-item', 'set-content', 'out-file', 'copy-item', 'new-item'].includes(executable)) {
    return { kind: 'filesystem', args };
  }
  if (isPublicationInvocation(executable, args)) {
    return { kind: 'publication', args };
  }
  return null;
}

function firstNonOption(args) {
  return args.find((arg) => !String(arg).startsWith('-'))?.toLowerCase() || '';
}

function isWendKeepPublication(args) {
  const command = firstNonOption(args);
  return command === 'publish' || command === 'release';
}

function isWendKeepContextSwitch(executable, args) {
  let commandArgs = args;
  if (['node', 'node.exe'].includes(executable)) {
    const entrypoint = args.findIndex((arg) => executableName(arg) === 'wendkeep.mjs');
    if (entrypoint < 0) return false;
    commandArgs = args.slice(entrypoint + 1);
  } else if (['npx', 'npx.cmd'].includes(executable)) {
    const packageIndex = args.findIndex((arg) => ['wendkeep', 'wk'].includes(executableName(arg)));
    if (packageIndex < 0) return false;
    commandArgs = args.slice(packageIndex + 1);
  } else if (!['wendkeep', 'wendkeep.cmd', 'wk', 'wk.cmd'].includes(executable)) {
    return false;
  }
  const command = firstNonOption(commandArgs);
  const commandIndex = commandArgs.findIndex((arg) => String(arg).toLowerCase() === command);
  return command === 'context' && String(commandArgs[commandIndex + 1] || '').toLowerCase() === 'switch';
}

function isPublicationInvocation(executable, args) {
  if (['npm', 'npm.cmd', 'pnpm', 'pnpm.cmd', 'yarn', 'yarn.cmd', 'bun', 'bun.exe'].includes(executable)) {
    const command = firstNonOption(args);
    if (command === 'publish') return true;
    const commandIndex = args.findIndex((arg) => String(arg).toLowerCase() === command);
    return command === 'run' && String(args[commandIndex + 1] || '').toLowerCase() === 'release';
  }
  if (executable === 'gh' || executable === 'gh.exe') {
    const command = firstNonOption(args);
    const commandIndex = args.findIndex((arg) => String(arg).toLowerCase() === command);
    const operation = String(args[commandIndex + 1] || '').toLowerCase();
    return command === 'release' && ['create', 'edit', 'upload', 'delete'].includes(operation);
  }
  if (executable === 'wendkeep' || executable === 'wendkeep.cmd' || executable === 'wk' || executable === 'wk.cmd') {
    return isWendKeepPublication(args);
  }
  if (executable === 'npx' || executable === 'npx.cmd') {
    const packageIndex = args.findIndex((arg) => ['wendkeep', 'wk'].includes(String(arg).toLowerCase()));
    return packageIndex >= 0 && isWendKeepPublication(args.slice(packageIndex + 1));
  }
  if (executable === 'corepack' || executable === 'corepack.cmd') {
    const packageIndex = args.findIndex((arg) => ['npm', 'pnpm', 'yarn'].includes(String(arg).toLowerCase()));
    return packageIndex >= 0 && isPublicationInvocation(
      String(args[packageIndex]).toLowerCase(),
      args.slice(packageIndex + 1),
    );
  }
  return false;
}

function commandInvocations(command) {
  return shellSegments(command).map(invocationOf).filter(Boolean);
}

function firstGitSubcommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '');
    if (arg === '--') return '';
    if (arg === '-C' || arg === '--git-dir' || arg === '--work-tree' || arg === '--exec-path') {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg.toLowerCase();
  }
  return '';
}

function gitAction(args) {
  const subcommand = firstGitSubcommand(args);
  if (!subcommand || SAFE_GIT_COMMANDS.has(subcommand)) return null;
  if (subcommand === 'config') {
    return args.some((arg) => ['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin'].includes(arg))
      ? null : 'git:destructive';
  }
  if (subcommand === 'remote') {
    return args.some((arg) => ['-v', '--verbose', 'get-url', 'show'].includes(arg)) ? null : 'git:destructive';
  }
  if (subcommand === 'branch') {
    return args.some((arg) => ['--show-current', '--list', '-a', '-r', '-vv'].includes(arg))
      ? null : 'git:destructive';
  }
  if (subcommand === 'tag') return args.includes('-l') || args.includes('--list') ? null : 'git:destructive';
  if (subcommand === 'worktree') return args[1] === 'list' ? null : 'git:destructive';
  if (['add', 'commit', 'push', 'pull', 'fetch', 'merge', 'rebase', 'cherry-pick', 'stash'].includes(subcommand)) {
    return `git:${subcommand}`;
  }
  if (['checkout', 'switch', 'reset', 'restore', 'revert', 'clean', 'rm', 'mv', 'update-index', 'init', 'clone'].includes(subcommand)) {
    return 'git:destructive';
  }
  return 'git:destructive';
}

export function scopeActionForCommand(command) {
  return scopeActionsForCommand(command)[0] || null;
}

export function scopeActionsForCommand(command) {
  const actions = [];
  for (const invocation of commandInvocations(command)) {
    if (invocation.kind === 'git') actions.push(gitAction(invocation.args));
    if (invocation.kind === 'context-switch') actions.push('git:destructive');
    if (invocation.kind === 'filesystem') actions.push('filesystem:mutation');
    if (invocation.kind === 'publication') actions.push('publish');
  }
  return [...new Set(actions.filter(Boolean))];
}

export function commandChangesGitBranch(command) {
  return commandInvocations(command).some((invocation) => {
    if (invocation.kind !== 'git') return false;
    const subcommand = firstGitSubcommand(invocation.args);
    if (subcommand === 'switch') return true;
    if (subcommand !== 'checkout') return false;
    const subcommandIndex = invocation.args.findIndex((arg) => String(arg).toLowerCase() === 'checkout');
    const checkoutArgs = invocation.args.slice(subcommandIndex + 1);
    if (!checkoutArgs.length || checkoutArgs.includes('--')) return false;
    if (checkoutArgs.includes('-p') || checkoutArgs.includes('--patch') || checkoutArgs.includes('--help')) return false;
    return true;
  });
}

export function commandChangesDirectory(command) {
  return shellSegments(command).some((segment) => {
    const executable = executableName(segment[0]);
    return ['cd', 'chdir', 'pushd', 'set-location', 'sl', 'set-location.exe'].includes(executable);
  });
}

export function commandHasUnprovenTarget(command) {
  if (commandChangesDirectory(command)) return true;
  return commandInvocations(command).some((invocation) => invocation.kind === 'git'
    && invocation.args.some((arg) => ['-C', '--git-dir', '--work-tree'].includes(arg)));
}

export function captureProjectScope({
  input = {},
  projectRoot = '',
  projectId = '',
  provider = '',
  sessionId = '',
  targetCwd = '',
  spawn = spawnSync,
} = {}) {
  const envelopeCwd = input?.cwd || input?.project_dir || input?.projectDir || input?.workspace?.cwd || process.cwd();
  const requested = targetCwd || requestedToolCwd(input) || envelopeCwd;
  const target = isAbsolute(requested) ? requested : resolve(envelopeCwd, requested);
  const repoRootRaw = optionalGit(target, ['rev-parse', '--show-toplevel'], spawn);
  if (!repoRootRaw) {
    return {
      schemaVersion: 1,
      complete: false,
      errorCode: 'WENDKEEP_SCOPE_REPO_UNRESOLVED',
      projectId: String(projectId || ''),
      projectRoot: canonicalPath(projectRoot || target),
      repoRoot: '',
      remote: '',
      branch: '',
      worktree: '',
      head: '',
      provider: String(provider || ''),
      sessionId: String(sessionId || ''),
    };
  }
  const repoRoot = canonicalPath(repoRootRaw);
  const head = optionalGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], spawn);
  const symbolicBranch = optionalGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], spawn);
  const branch = symbolicBranch || (head ? `detached:${head}` : '');
  const gitDirRaw = optionalGit(repoRoot, ['rev-parse', '--git-dir'], spawn);
  const worktree = gitDirRaw ? canonicalPath(isAbsolute(gitDirRaw) ? gitDirRaw : resolve(repoRoot, gitDirRaw)) : '';
  const remote = normalizeRemote(optionalGit(repoRoot, ['config', '--get', 'remote.origin.url'], spawn));
  const scope = {
    schemaVersion: 1,
    complete: Boolean(projectId && projectRoot && repoRoot && remote && branch && worktree && provider && sessionId),
    projectId: String(projectId || ''),
    projectRoot: canonicalPath(projectRoot || target),
    repoRoot,
    remote,
    branch,
    worktree,
    head,
    provider: String(provider || ''),
    sessionId: String(sessionId || ''),
  };
  return scope;
}

const SCOPE_FIELDS = ['projectId', 'projectRoot', 'repoRoot', 'remote', 'branch', 'worktree', 'provider', 'sessionId'];

export function compareProjectScopes(expected, actual) {
  if (!expected || typeof expected !== 'object') return { ok: false, mismatches: ['scope.missing'] };
  if (!actual || typeof actual !== 'object') return { ok: false, mismatches: ['scope.actual_missing'] };
  const mismatches = [];
  for (const field of SCOPE_FIELDS) {
    const left = field.endsWith('Root') || field === 'worktree'
      ? canonicalPath(expected[field]) : String(expected[field] || '');
    const right = field.endsWith('Root') || field === 'worktree'
      ? canonicalPath(actual[field]) : String(actual[field] || '');
    if (!left || !right || left !== right) mismatches.push(`scope.${field}`);
  }
  if (expected.complete !== true || actual.complete !== true) mismatches.push('scope.incomplete');
  return { ok: mismatches.length === 0, mismatches: [...new Set(mismatches)] };
}

function decision(host, reason) {
  return {
    permissionDecision: host === 'claude' ? 'ask' : 'deny',
    permissionDecisionReason: reason,
  };
}

function comparableScopeValue(scope, field) {
  const value = scope?.[field];
  if (!value) return '';
  return field === 'repoRoot' || field === 'projectRoot' || field === 'worktree'
    ? canonicalPath(value)
    : String(value);
}

// The registry is the lease ledger, not just a display index. An active entry without a
// project snapshot cannot prove that it is unrelated to the current mutation, so it is a
// conservative blocker. Distinct worktrees are the one mechanically provable exception.
export function concurrentScopeConflicts(expectedScope, activeSessions = [], currentSessionId = '') {
  if (!expectedScope || typeof expectedScope !== 'object') return [];
  const rows = Array.isArray(activeSessions)
    ? activeSessions.map((entry, index) => Array.isArray(entry) && entry.length === 2
      ? [entry[0], entry[1]]
      : [entry?.sessionId || entry?.session_id || String(index), entry])
    : Object.entries(activeSessions || {});
  const current = currentSessionId || expectedScope.sessionId || '';
  const conflicts = [];
  for (const [sessionId, entry] of rows) {
    if (!entry || String(sessionId) === String(current) || String(entry.sessionId || '') === String(current)) continue;
    if (entry.status && entry.status !== 'active') continue;
    const other = entry.project_scope || entry.projectScope || (entry.complete !== undefined ? entry : null);
    if (!other) {
      conflicts.push({ sessionId: String(sessionId), reason: 'scope-unavailable' });
      continue;
    }
    const leftWorktree = comparableScopeValue(expectedScope, 'worktree');
    const rightWorktree = comparableScopeValue(other, 'worktree');
    if (leftWorktree && rightWorktree && leftWorktree !== rightWorktree) continue;
    if (other.complete !== true) {
      conflicts.push({ sessionId: String(sessionId), reason: 'scope-unavailable' });
      continue;
    }
    const sameRepositoryBranch = ['repoRoot', 'remote', 'branch'].every((field) => {
      const left = comparableScopeValue(expectedScope, field);
      const right = comparableScopeValue(other, field);
      return Boolean(left && right && left === right);
    });
    if (!sameRepositoryBranch) continue;
    if (!leftWorktree || !rightWorktree || leftWorktree === rightWorktree) {
      conflicts.push({ sessionId: String(sessionId), reason: 'same-repository-branch' });
    }
  }
  return conflicts;
}

function toolIsMutable(input) {
  const name = input?.tool_name || input?.toolName || '';
  if (/^mcp__/i.test(name)) return true;
  return MUTABLE_TOOL_NAMES.has(name) || /^mcp__.*(?:write|edit|delete|move|rename|apply)/i.test(name);
}

export function scopeDecision({
  command = '',
  input = {},
  expectedScope = null,
  actualScope = null,
  host = 'codex',
  commandTargetKnown = true,
  activeSessions = [],
  currentSessionId = '',
} = {}) {
  const actions = scopeActionsForCommand(command);
  const action = actions[0] || (toolIsMutable(input) ? 'tool:mutation' : null);
  if (!action) return null;
  if (commandChangesDirectory(command) && !commandTargetKnown) {
    return decision(host, 'WENDKEEP_SCOPE_DIRECTORY_UNKNOWN: a mutação tentou alterar o diretório sem prova da raiz final.');
  }
  if (!expectedScope || !actualScope) {
    return decision(host, `WENDKEEP_SCOPE_MISSING: escopo ausente para ${actions.join(', ') || action}; selecione explicitamente o projeto antes da mutação.`);
  }
  if (expectedScope.conflict === true || expectedScope.project_scope_conflict === true) {
    return decision(host, `WENDKEEP_SCOPE_CONFLICT: a sessão observou mais de um escopo de projeto; selecione explicitamente o projeto antes da mutação.`);
  }
  const comparison = compareProjectScopes(expectedScope, actualScope);
  if (!comparison.ok) {
    return decision(host, `WENDKEEP_SCOPE_MISMATCH: alvo fora do escopo reservado (${comparison.mismatches.join(', ')}).`);
  }
  const concurrent = concurrentScopeConflicts(expectedScope, activeSessions, currentSessionId);
  if (concurrent.length) {
    return decision(host, `WENDKEEP_SCOPE_CONFLICT: há ${concurrent.length} sessão(ões) ativa(s) com a mesma raiz Git/branch ou escopo não comprovado; use um worktree distinto ou selecione explicitamente o projeto para criar uma nova lease.`);
  }
  if (commandChangesGitBranch(command)) {
    return decision(host, 'WENDKEEP_CONTEXT_SWITCH_REQUIRED: troca de branch Git crua deixaria a sessão fora da scope reservada; use `wendkeep context switch <branch> [--create] [--session <id>]`.');
  }
  const authorized = Array.isArray(expectedScope.authorizedActions)
    ? expectedScope.authorizedActions
    : null;
  const unauthorized = authorized
    ? (actions.length ? actions : [action]).filter((candidate) => (
      !authorized.includes(candidate) && !authorized.includes('git:write')
    ))
    : [];
  if (unauthorized.length) {
    return decision(host, `WENDKEEP_SCOPE_AUTH_REQUIRED: as capacidades ${unauthorized.join(', ')} não estão autorizadas nesta lease.`);
  }
  return null;
}

export function scopeForRegistry(scope, { authorizedActions } = {}) {
  if (!scope || typeof scope !== 'object') return null;
  return {
    schemaVersion: 1,
    projectId: scope.projectId || '',
    projectRoot: displayPath(scope.projectRoot),
    repoRoot: displayPath(scope.repoRoot),
    remote: scope.remote || '',
    branch: scope.branch || '',
    worktree: displayPath(scope.worktree),
    head: scope.head || '',
    provider: scope.provider || '',
    sessionId: scope.sessionId || '',
    complete: scope.complete === true,
    ...(Array.isArray(authorizedActions) ? { authorizedActions: [...new Set(authorizedActions)] } : {}),
  };
}

export function projectScopePatch(existingScope, currentScope) {
  if (!currentScope || typeof currentScope !== 'object') return {};
  if (!existingScope || typeof existingScope !== 'object') {
    return { project_scope: scopeForRegistry(currentScope) };
  }
  const comparison = compareProjectScopes(existingScope, currentScope);
  if (comparison.ok) return {};
  return {
    project_scope_conflict: true,
    project_scope_conflict_fields: comparison.mismatches,
    project_scope_observed: scopeForRegistry(currentScope),
  };
}
