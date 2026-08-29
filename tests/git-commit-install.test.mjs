import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { inspectGitCommitHooks, installGitCommitHooks } from '../src/git-commit-hooks.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'bin', 'wendkeep.mjs');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'wk-commit-install-'));
  git(root, 'init', '-q');
  return root;
}

test('[req:COMMIT-12] instalação opt-in é idempotente e configura core.hooksPath local', () => {
  const root = repo();
  try {
    const first = installGitCommitHooks({ projectRoot: root });
    assert.equal(first.status, 'installed');
    assert.equal(git(root, 'config', '--local', '--get', 'core.hooksPath'), '.githooks');
    for (const name of ['prepare-commit-msg', 'commit-msg']) {
      assert.equal(existsSync(join(root, '.githooks', name)), true);
      assert.match(readFileSync(join(root, '.githooks', name), 'utf8'), /WENDKEEP_COMMIT_CLI/);
    }
    assert.equal(inspectGitCommitHooks({ projectRoot: root }).status, 'healthy');
    assert.equal(installGitCommitHooks({ projectRoot: root }).status, 'unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:COMMIT-13] instalação preserva hook customizado e exige --force explícito para reparar', () => {
  const root = repo();
  try {
    mkdirSync(join(root, '.githooks'));
    const custom = join(root, '.githooks', 'commit-msg');
    writeFileSync(custom, '#!/bin/sh\necho custom\n');

    const blocked = installGitCommitHooks({ projectRoot: root });
    assert.equal(blocked.status, 'conflict');
    assert.deepEqual(blocked.conflicts, ['commit-msg']);
    assert.equal(readFileSync(custom, 'utf8'), '#!/bin/sh\necho custom\n');
    assert.equal(spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root }).status, 1);

    const repaired = installGitCommitHooks({ projectRoot: root, force: true });
    assert.equal(repaired.status, 'installed');
    assert.equal(existsSync(`${custom}.bak`), true);
    assert.match(readFileSync(custom, 'utf8'), /wendkeep.*commit validate/is);
    assert.equal(inspectGitCommitHooks({ projectRoot: root }).status, 'healthy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:COMMIT-32] core.hooksPath customizado nunca é substituído sem --force', () => {
  const root = repo();
  try {
    mkdirSync(join(root, '.custom-hooks'));
    writeFileSync(join(root, '.custom-hooks', 'commit-msg'), '#!/bin/sh\necho custom\n');
    git(root, 'config', '--local', 'core.hooksPath', '.custom-hooks');

    const blocked = installGitCommitHooks({ projectRoot: root });
    assert.equal(blocked.status, 'conflict');
    assert.deepEqual(blocked.conflicts, ['core.hooksPath']);
    assert.equal(git(root, 'config', '--local', '--get', 'core.hooksPath'), '.custom-hooks');
    assert.equal(existsSync(join(root, '.githooks', 'commit-msg')), false);

    const forced = installGitCommitHooks({ projectRoot: root, force: true });
    assert.equal(forced.status, 'installed');
    assert.equal(git(root, 'config', '--local', '--get', 'core.hooksPath'), '.githooks');
    assert.equal(readFileSync(join(root, '.custom-hooks', 'commit-msg'), 'utf8'), '#!/bin/sh\necho custom\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:COMMIT-14] diagnóstico é read-only e aponta reparo quando configuração deriva', () => {
  const root = repo();
  try {
    installGitCommitHooks({ projectRoot: root });
    writeFileSync(join(root, '.githooks', 'prepare-commit-msg'), '#!/bin/sh\nexit 0\n');
    const before = readFileSync(join(root, '.githooks', 'prepare-commit-msg'), 'utf8');
    const report = inspectGitCommitHooks({ projectRoot: root });
    assert.equal(report.status, 'drift');
    assert.deepEqual(report.issues, ['prepare-commit-msg: content differs from the installed WendKeep version']);
    assert.match(report.repair, /wendkeep init --git-commit-hooks --force/);
    assert.equal(readFileSync(join(root, '.githooks', 'prepare-commit-msg'), 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:COMMIT-26] init encaminha a instalação somente com opt-in explícito', () => {
  const root = repo();
  const vault = mkdtempSync(join(tmpdir(), 'wk-commit-vault-'));
  try {
    const baseline = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
      cwd: root, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(baseline.status, 1, 'opt-in ausente não configura hooks');
    const result = spawnSync(process.execPath, [
      CLI, 'init', '--project', root, '--vault', vault, '--yes', '--no-mcp', '--no-companions',
      '--no-colors', '--git-commit-hooks',
    ], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(root, 'config', '--local', '--get', 'core.hooksPath'), '.githooks');
    assert.match(result.stdout, /Git commit hooks: installed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});
