import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  discoverWorktreeRepository,
  ensureWorktreeMetadata,
  readWorktreeRegistry,
} from '../packages/vault/src/worktree-metadata.mjs';
import {
  bindProjectVault,
  resolveProjectVault,
} from '../packages/vault/src/project-vault.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd, args, { ok = true } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (ok) {
    assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  }
  return result;
}

function repositoryFixture({ withProjectVault = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wk worktree metadata '));
  const main = join(root, 'main repository');
  const linked = join(root, 'linked worktree');
  mkdirSync(main, { recursive: true });
  git(main, ['init', '-b', 'main']);
  git(main, ['config', 'user.email', 'tests@wendkeep.invalid']);
  git(main, ['config', 'user.name', 'WendKeep Tests']);
  writeFileSync(join(main, 'tracked.txt'), 'initial\n', 'utf8');
  git(main, ['add', 'tracked.txt']);
  git(main, ['commit', '-m', 'initial']);
  let vault = '';
  if (withProjectVault) {
    vault = join(main, '.WendKeep-vault');
    mkdirSync(join(vault, '.brain'), { recursive: true });
    writeFileSync(join(vault, '.brain', 'PROJECT.json'), `${JSON.stringify({
      schemaVersion: 1,
      projectId: 'wk-fixture-worktree-shared-vault',
      projectName: 'fixture',
    }, null, 2)}\n`, 'utf8');
    bindProjectVault({ projectRoot: main, vaultPath: vault });
    git(main, ['add', '.wendkeep.json']);
    git(main, ['commit', '-m', 'bind project vault']);
  }
  git(main, ['worktree', 'add', linked, '-b', 'wk/linked']);
  return { root, main, linked, vault };
}

test('[req:WT-1] [req:WT-3] [req:WT-10] main e linked compartilham common-dir, main-worktree e identidades privadas estáveis', () => {
  const fixture = repositoryFixture();
  try {
    const fromMain = discoverWorktreeRepository({ startDir: fixture.main });
    const fromLinked = discoverWorktreeRepository({ startDir: fixture.linked });

    assert.equal(fromMain.commonDir, fromLinked.commonDir);
    assert.equal(fromMain.mainWorktree, realpathSync.native(fixture.main));
    assert.equal(fromLinked.mainWorktree, realpathSync.native(fixture.main));
    assert.notEqual(fromMain.gitDir, fromLinked.gitDir);

    const first = ensureWorktreeMetadata({
      repository: fromMain,
      projectId: 'wk-fixture-worktree-test',
      vaultPath: join(fixture.root, 'canonical vault'),
      worktreesRoot: '.worktrees',
    });
    const second = ensureWorktreeMetadata({
      repository: fromLinked,
      projectId: 'wk-fixture-worktree-test',
      vaultPath: join(fixture.root, 'canonical vault'),
      worktreesRoot: '.worktrees',
    });

    assert.equal(first.repositoryId, second.repositoryId);
    assert.notEqual(first.currentWorktreeId, second.currentWorktreeId);
    assert.equal(first.registry.projectId, 'wk-fixture-worktree-test');
    assert.equal(first.registry.vaultPath, resolve(fixture.root, 'canonical vault'));
    assert.equal(first.registry.worktreesRoot, '.worktrees');
    assert.equal(first.registry.schemaVersion, 1);

    const persisted = JSON.parse(readFileSync(first.registryPath, 'utf8'));
    assert.equal(persisted.repositoryId, first.repositoryId);
    assert.equal(persisted.projectId, 'wk-fixture-worktree-test');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:WT-3] linked worktree resolve o Vault canônico pelo common-dir sem alterar o binding versionado', () => {
  const fixture = repositoryFixture({ withProjectVault: true });
  try {
    const bindingBefore = readFileSync(join(fixture.linked, '.wendkeep.json'), 'utf8');
    const repository = discoverWorktreeRepository({ startDir: fixture.main });
    ensureWorktreeMetadata({
      repository,
      projectId: 'wk-fixture-worktree-shared-vault',
      vaultPath: fixture.vault,
    });

    const fromMain = resolveProjectVault({ startDir: fixture.main });
    const fromLinked = resolveProjectVault({ startDir: fixture.linked });

    assert.equal(fromLinked.source, 'worktree-registry');
    assert.equal(fromLinked.projectId, fromMain.projectId);
    assert.equal(fromLinked.base, fromMain.base);
    assert.equal(readFileSync(join(fixture.linked, '.wendkeep.json'), 'utf8'), bindingBefore);
    assert.equal(git(fixture.linked, ['status', '--short']).stdout, '');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function registryProbe(repo, slug) {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(process.execPath, [
      join(ROOT, 'tests', 'fixtures', 'worktree-registry-race-probe.mjs'),
      repo,
      slug,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolveProbe();
      else reject(new Error(`probe ${slug} saiu ${code}: ${stderr}`));
    });
  });
}

test('[req:WT-6] duas mutações multiprocesso preservam ambas as entradas do registry', async () => {
  const fixture = repositoryFixture();
  try {
    const repository = discoverWorktreeRepository({ startDir: fixture.main });
    ensureWorktreeMetadata({
      repository,
      projectId: 'wk-fixture-worktree-race',
      vaultPath: join(fixture.root, 'canonical vault'),
    });

    await Promise.all([
      registryProbe(fixture.main, 'auth'),
      registryProbe(fixture.main, 'billing'),
    ]);

    const { registry } = readWorktreeRegistry(repository);
    assert.deepEqual(Object.keys(registry.entries).sort(), ['auth', 'billing']);
    assert.equal(registry.entries.auth.state, 'creating');
    assert.equal(registry.entries.billing.state, 'creating');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
