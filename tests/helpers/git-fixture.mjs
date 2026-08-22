import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const templates = new Map();

export function git(cwd, ...args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

export function initGitRepository(projectRoot) {
  mkdirSync(projectRoot, { recursive: true });
  if (existsSync(join(projectRoot, '.git'))) return projectRoot;
  git(projectRoot, 'init', '-q');
  git(projectRoot, 'config', 'user.email', 'verify@example.test');
  git(projectRoot, 'config', 'user.name', 'Verify Test');
  git(projectRoot, 'checkout', '-q', '-b', 'main');
  git(projectRoot, 'commit', '--allow-empty', '-q', '-m', 'baseline');
  return projectRoot;
}

function createTemplate(key, setup) {
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  const root = mkdtempSync(join(tmpdir(), `wk-git-template-${safeKey}-`));
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'flow@example.invalid');
    git(root, 'config', 'user.name', 'FLOW Test');
    setup(root);
    templates.set(key, root);
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function copyGitFixture(key, setup, { prefix = 'wk-git-fixture' } = {}) {
  const template = templates.get(key) ?? createTemplate(key, setup);
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  rmSync(root, { recursive: true, force: true });
  cpSync(template, root, { recursive: true });
  return root;
}

after(() => {
  for (const root of templates.values()) rmSync(root, { recursive: true, force: true });
  templates.clear();
});
