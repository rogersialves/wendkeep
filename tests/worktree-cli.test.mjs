import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindProjectVault } from '../packages/vault/src/project-vault.mjs';
import {
  createManagedWorktree,
  diagnoseManagedWorktrees,
  installVscodeWorktreeTasks,
  listManagedWorktrees,
  managedWorktreeStatus,
  openManagedWorktree,
} from '../src/worktree.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return String(result.stdout || '').trim();
}

function managedRepositoryFixture({ vaultInsideMain = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wk managed worktree '));
  const main = join(root, 'main repo');
  const vault = vaultInsideMain ? join(main, '.WendKeep-vault') : join(root, 'canonical vault');
  mkdirSync(main, { recursive: true });
  mkdirSync(join(vault, '.brain'), { recursive: true });
  writeFileSync(join(vault, '.brain', 'PROJECT.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectId: 'wk-fixture-managed-worktree',
    projectName: 'fixture',
  }, null, 2)}\n`, 'utf8');
  git(main, ['init', '-b', 'main']);
  git(main, ['config', 'user.email', 'tests@wendkeep.invalid']);
  git(main, ['config', 'user.name', 'WendKeep Tests']);
  writeFileSync(join(main, 'tracked.txt'), 'initial\n', 'utf8');
  git(main, ['add', 'tracked.txt']);
  git(main, ['commit', '-m', 'initial']);
  bindProjectVault({ projectRoot: main, vaultPath: vault });
  git(main, ['add', '.wendkeep.json']);
  git(main, ['commit', '-m', 'bind project vault']);
  return { root, main, vault };
}

test('[req:WT-1] [req:WT-2] [req:WT-3] [req:WT-7] create usa defaults, preserva checkout limpo e é idempotente', () => {
  const fixture = managedRepositoryFixture();
  try {
    const bindingBefore = readFileSync(join(fixture.main, '.wendkeep.json'), 'utf8');
    const first = createManagedWorktree({
      startDir: fixture.main,
      slug: 'auth',
      open: 'none',
    });

    assert.equal(first.slug, 'auth');
    assert.equal(first.branch, 'wk/auth');
    assert.equal(first.path, resolve(realpathSync.native(fixture.main), '.worktrees', 'auth'));
    assert.equal(first.state, 'ready');
    assert.equal(first.idempotent, false);
    assert.equal(git(first.path, ['branch', '--show-current']), 'wk/auth');
    assert.deepEqual(
      JSON.parse(readFileSync(join(first.path, '.wendkeep.json'), 'utf8')),
      JSON.parse(bindingBefore),
    );
    assert.equal(git(fixture.main, ['status', '--short']), '');
    assert.equal(git(first.path, ['status', '--short']), '');

    const second = createManagedWorktree({
      startDir: fixture.main,
      slug: 'auth',
      open: 'none',
    });
    assert.equal(second.idempotent, true);
    assert.equal(second.worktreeId, first.worktreeId);
    assert.equal(
      git(fixture.main, ['worktree', 'list', '--porcelain'])
        .split(/\r?\n/)
        .filter((line) => line.startsWith('worktree '))
        .length,
      2,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:WT-5] open localiza VS Code e executa code -n por argumentos injetáveis', () => {
  const fixture = managedRepositoryFixture();
  try {
    const created = createManagedWorktree({ startDir: fixture.main, slug: 'editor' });
    const calls = [];
    const injectedSpawn = (command, args, options) => {
      if (command === 'code') {
        calls.push({ command, args: [...args] });
        return { status: 0, stdout: '', stderr: '' };
      }
      return spawnSync(command, args, options);
    };

    const opened = openManagedWorktree({
      startDir: fixture.main,
      slug: 'editor',
      editor: 'vscode',
      spawn: injectedSpawn,
    });

    assert.equal(opened.opened, true);
    assert.deepEqual(calls, [
      { command: 'code', args: ['--version'] },
      { command: 'code', args: ['-n', created.path] },
    ]);

    calls.length = 0;
    const createdAndOpened = createManagedWorktree({
      startDir: fixture.main,
      slug: 'editor-on-create',
      open: 'vscode',
      spawn: injectedSpawn,
    });
    assert.equal(createdAndOpened.opened, true);
    assert.deepEqual(calls, [
      { command: 'code', args: ['--version'] },
      { command: 'code', args: ['-n', createdAndOpened.path] },
    ]);

    assert.throws(
      () => openManagedWorktree({
        startDir: fixture.main,
        slug: 'editor',
        editor: 'vscode',
        spawn: (command, args, options) => command === 'code'
          ? { status: null, stdout: '', stderr: '', error: { code: 'ENOENT' } }
          : spawnSync(command, args, options),
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_EDITOR_NOT_FOUND',
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:WT-4] list e status reconciliam Git/registry sem expor path ou conteúdo do Vault', () => {
  const fixture = managedRepositoryFixture();
  try {
    const created = createManagedWorktree({ startDir: fixture.main, slug: 'catalog' });
    writeFileSync(join(fixture.vault, 'private-note.md'), 'segredo local\n', 'utf8');

    const listed = listManagedWorktrees({ startDir: fixture.main });
    const status = managedWorktreeStatus({ startDir: fixture.main, slug: 'catalog' });

    assert.equal(listed.repositoryId.length > 0, true);
    assert.equal(listed.worktrees.length, 1);
    assert.equal(listed.worktrees[0].slug, 'catalog');
    assert.equal(listed.worktrees[0].state, 'ready');
    assert.equal(listed.worktrees[0].git.present, true);
    assert.equal(listed.worktrees[0].binding.healthy, true);
    assert.equal(status.worktreeId, created.worktreeId);
    assert.equal(status.head, git(created.path, ['rev-parse', 'HEAD']));
    const serialized = JSON.stringify({ listed, status });
    assert.doesNotMatch(serialized, /canonical vault|private-note|segredo local/i);
    assert.equal(Object.hasOwn(status.binding, 'vaultPath'), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:WT-1] root por junction para fora do repositório falha antes de criar a worktree', () => {
  const fixture = managedRepositoryFixture();
  try {
    const outside = join(fixture.root, 'outside worktrees');
    const junction = join(fixture.main, 'linked-root');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, junction, 'junction');
    const configPath = join(fixture.main, '.wendkeep.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.worktrees = { root: 'linked-root' };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    git(fixture.main, ['add', '.wendkeep.json']);
    git(fixture.main, ['commit', '-m', 'configure linked worktree root']);

    assert.throws(
      () => createManagedWorktree({ startDir: fixture.main, slug: 'escape', open: 'none' }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_PATH_SYMLINK_ESCAPE',
    );
    assert.equal(existsSync(join(outside, 'escape')), false);
    assert.equal(git(fixture.main, ['status', '--short']), '');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:WT-1] branch e schema de root inválidos falham antes de qualquer mutação', () => {
  const fixture = managedRepositoryFixture();
  try {
    const registryPath = join(fixture.main, '.git', 'wendkeep', 'worktrees-v1.json');
    assert.throws(
      () => createManagedWorktree({
        startDir: fixture.main,
        slug: 'invalid-branch',
        branch: 'branch with spaces',
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_BRANCH_INVALID',
    );
    assert.equal(existsSync(registryPath), false);
    assert.equal(existsSync(join(fixture.main, '.worktrees')), false);

    const configPath = join(fixture.main, '.wendkeep.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.worktrees = { root: 42 };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    assert.throws(
      () => createManagedWorktree({ startDir: fixture.main, slug: 'invalid-root' }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_ROOT_INVALID',
    );
    assert.equal(existsSync(registryPath), false);
    assert.equal(existsSync(join(fixture.main, '.worktrees')), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:WT-2] [req:WT-10] detached HEAD reutiliza branch existente livre', () => {
  const fixture = managedRepositoryFixture();
  try {
    git(fixture.main, ['branch', 'feature/existing', 'main']);
    git(fixture.main, ['checkout', '--detach']);
    const created = createManagedWorktree({
      startDir: fixture.main,
      slug: 'existing',
      branch: 'feature/existing',
    });
    assert.equal(created.branch, 'feature/existing');
    assert.equal(git(created.path, ['branch', '--show-current']), 'feature/existing');
    assert.equal(git(fixture.main, ['status', '--short']), '');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:WT-2] primeira criação iniciada em linked worktree recupera binding da main', () => {
  const fixture = managedRepositoryFixture({ vaultInsideMain: true });
  try {
    const linked = join(fixture.main, '.worktrees', 'manual');
    git(fixture.main, ['worktree', 'add', '--detach', linked, 'HEAD']);
    const result = spawnSync(process.execPath, [
      join(ROOT, 'bin', 'wendkeep.mjs'),
      'worktree', 'create', 'from-linked', '--open', 'none', '--json',
    ], { cwd: linked, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).worktree.slug, 'from-linked');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:WT-3] binding corrompido na linked worktree falha fechado sem fallback para main', () => {
  const fixture = managedRepositoryFixture({ vaultInsideMain: true });
  try {
    const linked = join(fixture.main, '.worktrees', 'corrupt-binding');
    git(fixture.main, ['worktree', 'add', '--detach', linked, 'HEAD']);
    writeFileSync(join(linked, '.wendkeep.json'), '{invalid json\n', 'utf8');
    assert.throws(
      () => createManagedWorktree({ startDir: linked, slug: 'must-not-fallback' }),
      (error) => error?.code === 'WENDKEEP_VAULT_CONFIG_INVALID',
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:WT-3] binding linked válido porém divergente não usa o fallback canônico', () => {
  const fixture = managedRepositoryFixture({ vaultInsideMain: true });
  try {
    const linked = join(fixture.main, '.worktrees', 'divergent-binding');
    git(fixture.main, ['worktree', 'add', '--detach', linked, 'HEAD']);
    const configPath = join(linked, '.wendkeep.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.vault = '.different-vault';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    assert.throws(
      () => createManagedWorktree({ startDir: linked, slug: 'must-not-diverge' }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_BINDING_INVALID',
    );
    assert.equal(existsSync(join(fixture.main, '.git', 'wendkeep', 'worktrees-v1.json')), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:WT-6] falha depois da reserva persiste estado failed e recovery objetivo', () => {
  const fixture = managedRepositoryFixture();
  try {
    const failingSpawn = (command, args, options) => {
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        return { status: 73, stdout: '', stderr: 'synthetic worktree failure' };
      }
      return spawnSync(command, args, options);
    };
    assert.throws(
      () => createManagedWorktree({
        startDir: fixture.main,
        slug: 'partial',
        base: 'main',
        branch: 'feature/partial',
        spawn: failingSpawn,
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_GIT_FAILED',
    );
    const status = managedWorktreeStatus({ startDir: fixture.main, slug: 'partial' });
    assert.equal(status.state, 'failed');
    assert.equal(status.git.present, false);
    assert.equal(status.errorCode, 'WENDKEEP_WORKTREE_GIT_FAILED');
    assert.match(status.recovery, /^wendkeep worktree create partial /);
    const diagnosis = diagnoseManagedWorktrees({ startDir: fixture.main });
    assert.equal(diagnosis.initialized, true);
    assert.deepEqual(diagnosis.issues.map((issue) => issue.slug), ['partial']);
    assert.match(diagnosis.issues[0].repair, /worktree create partial/);
    const doctor = spawnSync(process.execPath, [
      join(ROOT, 'bin', 'wendkeep.mjs'),
      'doctor',
      '--scope', 'runtime',
      '--project', fixture.main,
      '--vault', fixture.vault,
    ], { cwd: fixture.main, encoding: 'utf8' });
    assert.match(doctor.stdout, /\[worktrees\] 1 problema\(s\)/);
    assert.match(doctor.stdout, /partial: WENDKEEP_WORKTREE_GIT_FAILED/);

    const registryPath = join(fixture.main, '.git', 'wendkeep', 'worktrees-v1.json');
    const reserved = readFileSync(registryPath, 'utf8');
    assert.throws(
      () => createManagedWorktree({ startDir: fixture.main, slug: 'partial' }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_COLLISION',
    );
    assert.equal(readFileSync(registryPath, 'utf8'), reserved);

    const retried = createManagedWorktree({
      startDir: fixture.main,
      slug: 'partial',
      base: 'main',
      branch: 'feature/partial',
    });
    assert.equal(retried.state, 'ready');
    assert.equal(retried.idempotent, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:WT-6] retry reconcilia worktree criada quando a promoção a ready falha', () => {
  const fixture = managedRepositoryFixture();
  try {
    const target = join(fixture.main, '.worktrees', 'recover-created');
    let failDiscoveryOnce = true;
    const failingAfterGitAdd = (command, args, options) => {
      if (command === 'git'
        && failDiscoveryOnce
        && resolve(options.cwd) !== resolve(fixture.main)
        && args[0] === 'rev-parse'
        && args[1] === '--show-toplevel') {
        failDiscoveryOnce = false;
        return { status: 74, stdout: '', stderr: 'synthetic discovery failure' };
      }
      return spawnSync(command, args, options);
    };
    assert.throws(
      () => createManagedWorktree({
        startDir: fixture.main,
        slug: 'recover-created',
        spawn: failingAfterGitAdd,
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_GIT_FAILED',
    );
    assert.equal(existsSync(target), true);
    assert.equal(managedWorktreeStatus({ startDir: fixture.main, slug: 'recover-created' }).state, 'failed');

    const recovered = createManagedWorktree({ startDir: fixture.main, slug: 'recover-created' });
    assert.equal(recovered.state, 'ready');
    assert.equal(recovered.idempotent, false);
    assert.equal(git(target, ['branch', '--show-current']), 'wk/recover-created');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:WT-8] tarefas opcionais do VS Code são locais, idempotentes e não sobrescrevem', () => {
  const fixture = managedRepositoryFixture();
  try {
    const first = installVscodeWorktreeTasks({ projectRoot: fixture.main });
    const tasksPath = join(fixture.main, '.vscode', 'tasks.json');
    assert.equal(first.state, 'created');
    assert.equal(existsSync(tasksPath), true);
    assert.match(readFileSync(tasksPath, 'utf8'), /WendKeep: Create worktree/);
    assert.equal(git(fixture.main, ['check-ignore', '.vscode/tasks.json']), '.vscode/tasks.json');

    const before = readFileSync(tasksPath, 'utf8');
    assert.equal(installVscodeWorktreeTasks({ projectRoot: fixture.main }).state, 'unchanged');
    assert.equal(readFileSync(tasksPath, 'utf8'), before);

    rmSync(tasksPath);
    writeFileSync(tasksPath, '{"user":"owned"}\n', 'utf8');
    assert.equal(installVscodeWorktreeTasks({ projectRoot: fixture.main }).state, 'conflict');
    assert.equal(readFileSync(tasksPath, 'utf8'), '{"user":"owned"}\n');

    git(fixture.main, ['add', '-f', '.vscode/tasks.json']);
    git(fixture.main, ['commit', '-m', 'track user tasks']);
    rmSync(tasksPath);
    assert.equal(installVscodeWorktreeTasks({ projectRoot: fixture.main }).state, 'conflict');
    assert.equal(existsSync(tasksPath), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:WT-8] init encaminha a instalação opcional das tarefas locais', () => {
  const fixture = managedRepositoryFixture();
  try {
    const result = spawnSync(process.execPath, [
      join(ROOT, 'bin', 'wendkeep.mjs'),
      'init',
      '--project', fixture.main,
      '--vault', fixture.vault,
      '--yes',
      '--no-mcp',
      '--no-companions',
      '--no-colors',
      '--vscode-worktree-tasks',
    ], { cwd: fixture.main, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(fixture.main, '.vscode', 'tasks.json')), true);
    assert.match(result.stdout, /VS Code worktree tasks: created/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:WT-8] sync repassa a instalação opcional das tarefas locais', () => {
  const fixture = managedRepositoryFixture();
  try {
    const result = spawnSync(process.execPath, [
      join(ROOT, 'bin', 'wendkeep.mjs'),
      'sync',
      '--project', fixture.main,
      '--vault', fixture.vault,
      '--yes',
      '--vscode-worktree-tasks',
    ], { cwd: fixture.main, encoding: 'utf8' });
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    assert.equal(existsSync(join(fixture.main, '.vscode', 'tasks.json')), true);
    assert.match(result.stdout, /VS Code worktree tasks: created/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createProbe(repo, slug) {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(process.execPath, [
      join(ROOT, 'tests', 'fixtures', 'worktree-create-race-probe.mjs'),
      repo,
      slug,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolveProbe()
      : reject(new Error(`create probe ${slug} saiu ${code}: ${stderr}`)));
  });
}

test('[req:WT-6] [req:WT-10] duas criações multiprocesso preservam registry e worktrees', async () => {
  const fixture = managedRepositoryFixture();
  try {
    await Promise.all([
      createProbe(fixture.main, 'parallel-a'),
      createProbe(fixture.main, 'parallel-b'),
    ]);
    const listed = listManagedWorktrees({ startDir: fixture.main });
    assert.deepEqual(listed.worktrees.map((entry) => entry.slug), ['parallel-a', 'parallel-b']);
    assert.deepEqual(listed.worktrees.map((entry) => entry.state), ['ready', 'ready']);
    assert.equal(git(fixture.main, ['status', '--short']), '');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function runCli(fixture, args) {
  return spawnSync(process.execPath, [
    join(ROOT, 'bin', 'wendkeep.mjs'),
    'worktree',
    ...args,
    '--project',
    fixture.main,
  ], { cwd: fixture.main, encoding: 'utf8' });
}

test('[req:WT-1] [req:WT-4] [req:WT-9] CLI expõe create/list/status JSON e erros EN estáveis', () => {
  const fixture = managedRepositoryFixture();
  try {
    const created = runCli(fixture, ['create', 'cli-auth', '--open', 'none', '--json']);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout).worktree.slug, 'cli-auth');

    const listed = runCli(fixture, ['list', '--json']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(
      JSON.parse(listed.stdout).worktrees.map((entry) => entry.slug),
      ['cli-auth'],
    );

    const status = runCli(fixture, ['status', 'cli-auth', '--json']);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).worktree.state, 'ready');

    const humanList = runCli(fixture, ['list']);
    assert.equal(humanList.status, 0, humanList.stderr);
    for (const value of ['cli-auth', 'wk/cli-auth', 'ready', 'binding=healthy', 'head=', 'identity=', 'path=']) {
      assert.match(humanList.stdout, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    const humanStatus = runCli(fixture, ['status', 'cli-auth']);
    assert.match(humanStatus.stdout, /slug=cli-auth/);
    assert.match(humanStatus.stdout, /branch=wk\/cli-auth/);

    mkdirSync(join(fixture.vault, '.brain'), { recursive: true });
    writeFileSync(join(fixture.vault, '.brain', 'config.json'), '{"locale":"en"}\n', 'utf8');
    const invalid = runCli(fixture, ['create', '../escape']);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /WENDKEEP_WORKTREE_SLUG_INVALID/);
    assert.match(invalid.stderr, /Invalid worktree slug/);
    assert.doesNotMatch(invalid.stderr, /Slug de worktree inválido/);

    const irrelevant = runCli(fixture, ['list', '--base', 'main']);
    assert.equal(irrelevant.status, 2);
    assert.match(irrelevant.stderr, /WENDKEEP_WORKTREE_USAGE/);

    const gitFailure = runCli(fixture, ['create', 'bad-base', '--base', 'refs/heads/does-not-exist']);
    assert.equal(gitFailure.status, 2);
    assert.match(gitFailure.stderr, /WENDKEEP_WORKTREE_GIT_FAILED: Git command failed\./);
    assert.doesNotMatch(gitFailure.stderr, /falhou|Não foi possível/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
