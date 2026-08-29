import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GIT_COMMIT_HOOKS = ['prepare-commit-msg', 'commit-msg'];
export const GIT_COMMIT_HOOKS_PATH = '.githooks';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagedHooks = join(packageRoot, '.githooks');

function git(projectRoot, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    const error = new Error((result.stderr || `git ${args.join(' ')} failed`).trim());
    error.code = 'WENDKEEP_COMMIT_GIT_FAILED';
    throw error;
  }
  return result;
}

function hookState(projectRoot, name) {
  const source = join(packagedHooks, name);
  const target = join(projectRoot, GIT_COMMIT_HOOKS_PATH, name);
  if (!existsSync(target)) return { name, source, target, state: 'missing' };
  return {
    name,
    source,
    target,
    state: readFileSync(target).equals(readFileSync(source)) ? 'current' : 'drift',
  };
}

export function inspectGitCommitHooks({ projectRoot = process.cwd() } = {}) {
  const root = resolve(projectRoot);
  const repository = git(root, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (repository.status !== 0) {
    return { status: 'unavailable', configured: false, issues: ['not a Git repository'], repair: '' };
  }
  const configured = git(root, ['config', '--local', '--get', 'core.hooksPath'], { allowFailure: true });
  const configuredPath = configured.status === 0 ? configured.stdout.trim().replaceAll('\\', '/') : '';
  if (!configuredPath) {
    return { status: 'disabled', configured: false, issues: [], repair: 'wendkeep init --git-commit-hooks --yes' };
  }
  if (!['.githooks', './.githooks'].includes(configuredPath)) {
    return {
      status: 'drift',
      configured: true,
      configuredPath,
      issues: [`core.hooksPath points to ${configuredPath}, not .githooks`],
      repair: 'wendkeep init --git-commit-hooks --force --yes',
    };
  }
  const states = GIT_COMMIT_HOOKS.map((name) => hookState(root, name));
  const issues = states.filter((item) => item.state !== 'current').map((item) => (
    item.state === 'missing'
      ? `${item.name}: missing`
      : `${item.name}: content differs from the installed WendKeep version`
  ));
  return {
    status: issues.length ? (states.some((item) => item.state === 'missing') ? 'missing' : 'drift') : 'healthy',
    configured: true,
    configuredPath,
    issues,
    repair: issues.length ? 'wendkeep init --git-commit-hooks --force --yes' : '',
  };
}

export function installGitCommitHooks({ projectRoot = process.cwd(), force = false } = {}) {
  const root = resolve(projectRoot);
  git(root, ['rev-parse', '--show-toplevel']);
  const configured = git(root, ['config', '--local', '--get', 'core.hooksPath'], { allowFailure: true });
  const configuredPath = configured.status === 0 ? configured.stdout.trim().replaceAll('\\', '/') : '';
  if (configuredPath && !['.githooks', './.githooks'].includes(configuredPath) && !force) {
    return {
      status: 'conflict',
      conflicts: ['core.hooksPath'],
      configuredPath,
      repair: 'wendkeep init --git-commit-hooks --force --yes',
    };
  }
  const states = GIT_COMMIT_HOOKS.map((name) => hookState(root, name));
  const conflicts = states.filter((item) => item.state === 'drift').map((item) => item.name);
  if (conflicts.length && !force) {
    return { status: 'conflict', conflicts, repair: 'wendkeep init --git-commit-hooks --force --yes' };
  }
  mkdirSync(join(root, GIT_COMMIT_HOOKS_PATH), { recursive: true });
  let changed = false;
  for (const item of states) {
    if (item.state === 'current') continue;
    if (item.state === 'drift' && force && !existsSync(`${item.target}.bak`)) {
      copyFileSync(item.target, `${item.target}.bak`);
    }
    copyFileSync(item.source, item.target);
    try { chmodSync(item.target, 0o755); } catch { /* Git for Windows uses its executable shim. */ }
    changed = true;
  }
  if (configured.status !== 0 || configured.stdout.trim().replaceAll('\\', '/') !== GIT_COMMIT_HOOKS_PATH) {
    git(root, ['config', '--local', 'core.hooksPath', GIT_COMMIT_HOOKS_PATH]);
    changed = true;
  }
  return {
    status: changed ? 'installed' : 'unchanged',
    conflicts: [],
    hooks: GIT_COMMIT_HOOKS,
    path: join(root, GIT_COMMIT_HOOKS_PATH),
  };
}
