import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { bindProjectVault } from '../src/project-vault.mjs';
import { readSessionRegistry, writeSessionRegistry } from '../hooks/obsidian-common.mjs';
import { captureProjectScope, scopeForRegistry } from '../hooks/project-scope.mjs';
import { discoverWorktreeRepository, ensureWorktreeMetadata } from '../packages/vault/src/worktree-metadata.mjs';

const BIN = join(process.cwd(), 'bin', 'wendkeep.mjs');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'wk-task-cli-'));
  const project = join(parent, 'project');
  git(parent, ['init', project]);
  git(project, ['config', 'user.email', 'test@example.invalid']);
  git(project, ['config', 'user.name', 'WendKeep Test']);
  git(project, ['branch', '-M', 'main']);
  git(project, ['remote', 'add', 'origin', 'https://example.com/acme/task-cli.git']);
  writeFileSync(join(project, 'report.txt'), 'done');
  git(project, ['add', 'report.txt']);
  git(project, ['commit', '-m', 'fixture']);

  const vault = join(parent, 'vault');
  const binding = bindProjectVault({ projectRoot: project, vaultPath: vault });
  ensureWorktreeMetadata({
    repository: discoverWorktreeRepository({ startDir: project }),
    projectId: binding.projectId,
    vaultPath: vault,
  });
  for (const slug of ['change-a', 'change-b']) {
    const dir = join(vault, '08-Mudanças', slug);
    mkdirSync(join(dir, 'specs', 'task-contracts'), { recursive: true });
    writeFileSync(join(dir, 'proposta.md'), `---\nspec_impact: required\nspecs:\n  - task-contracts\n---\n# ${slug}\n`);
    writeFileSync(
      join(dir, 'tarefas.md'),
      `- [x] 1.1 ${slug} output [req:TC-1] [artifact:report]\n`,
    );
    writeFileSync(join(dir, 'specs', 'task-contracts', 'spec.md'), [
      '# Delta — task-contracts',
      '',
      '## ADDED Requirements',
      '',
      '### Requisito: TC-1 — Contract identity',
      '',
      'The contract MUST have stable identity.',
      '',
      '## MODIFIED Requirements',
      '',
      '## REMOVED Requirements',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'artifacts.json'), `${JSON.stringify({
      schema_version: 1,
      artifacts: [{ name: 'report', type: 'path', path: 'report.txt', fromFilesystem: true }],
    }, null, 2)}\n`);
  }
  const scope = (sessionId) => scopeForRegistry(captureProjectScope({
    input: { cwd: project }, projectRoot: project, projectId: binding.projectId,
    provider: 'codex', sessionId,
  }));
  writeSessionRegistry(vault, {
    version: 2,
    sessions: {
      'session-a': { status: 'active', provider: 'codex', work_session_id: 'work-a', project_scope: scope('session-a') },
      'session-b': { status: 'active', provider: 'codex', work_session_id: 'work-b', project_scope: scope('session-b') },
    },
  });
  return { parent, project, vault };
}

function addSiblingWorktree(f) {
  const worktree = join(f.parent, 'sibling-worktree');
  git(f.project, ['worktree', 'add', '-b', 'wk/sibling', worktree]);
  const binding = bindProjectVault({ projectRoot: worktree, vaultPath: f.vault });
  ensureWorktreeMetadata({
    repository: discoverWorktreeRepository({ startDir: worktree }),
    projectId: binding.projectId,
    vaultPath: f.vault,
  });
  const registry = readSessionRegistry(f.vault);
  registry.sessions['session-b'].project_scope = scopeForRegistry(captureProjectScope({
    input: { cwd: worktree }, projectRoot: worktree, projectId: binding.projectId,
    provider: 'codex', sessionId: 'session-b',
  }));
  writeSessionRegistry(f.vault, registry);
  return worktree;
}

function runCli(f, args, projectRoot = f.project) {
  return spawnSync(process.execPath, [
    BIN, ...args, '--project', projectRoot, '--vault', f.vault,
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CODEX_THREAD_ID: '', CLAUDE_SESSION_ID: '' },
  });
}

function runTask(f, args, projectRoot = f.project) {
  return runCli(f, ['task', ...args], projectRoot);
}

test('[req:TC-5] task list/show/evaluate stay scoped to the selected causal session', () => {
  const f = fixture();
  try {
    assert.equal(runCli(f, ['change', 'use', 'change-a', '--session', 'session-a']).status, 0);
    assert.equal(runCli(f, ['change', 'use', 'change-b', '--session', 'session-b']).status, 0);
    const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    const registryBeforeReads = readFileSync(registryPath);

    const list = runTask(f, ['list', '--session', 'session-a', '--json']);
    assert.equal(list.status, 0, list.stderr);
    const listed = JSON.parse(list.stdout);
    assert.equal(listed.change_slug, 'change-a');
    assert.deepEqual(listed.tasks.map(({ task_id, title }) => ({ task_id, title })), [
      { task_id: '1.1', title: 'change-a output' },
    ]);

    const show = runTask(f, ['show', '1.1', '--session', 'session-b', '--json']);
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).title, 'change-b output');
    const textShow = runTask(f, ['show', '1.1', '--session', 'session-b']);
    assert.equal(textShow.status, 0, textShow.stderr);
    assert.match(textShow.stdout, /^1\.1 \[pending-evaluation\] change-b output/m);

    const evaluate = runTask(f, ['evaluate', '1.1', '--session', 'session-a', '--json']);
    assert.equal(evaluate.status, 0, evaluate.stderr);
    assert.equal(JSON.parse(evaluate.stdout).can_complete, true);

    const ambiguous = runTask(f, ['list']);
    assert.equal(ambiguous.status, 2);
    assert.match(ambiguous.stderr, /WENDKEEP_ACTIVE_CONTEXT_AMBIGUOUS/);
    const ambiguousJson = runTask(f, ['list', '--json']);
    assert.equal(ambiguousJson.status, 2);
    const failure = JSON.parse(ambiguousJson.stderr);
    assert.equal(failure.code, 'WENDKEEP_ACTIVE_CONTEXT_AMBIGUOUS');
    assert.match(failure.recovery, /active context|task contract/i);
    assert.deepEqual(readFileSync(registryPath), registryBeforeReads);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:TC-6] task claim is exclusive, owner-scoped and recoverable after expiry', () => {
  const f = fixture();
  try {
    assert.equal(runCli(f, ['change', 'use', 'change-a', '--session', 'session-a']).status, 0);
    assert.equal(runCli(f, ['change', 'use', 'change-a', '--session', 'session-b']).status, 0);

    const first = runTask(f, ['claim', '1.1', '--session', 'session-a', '--lease-seconds', '60', '--json']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).owner_session_id, 'session-a');
    const claimedContract = JSON.parse(runTask(f, ['show', '1.1', '--session', 'session-a', '--json']).stdout);
    assert.equal(claimedContract.owner, 'session-a');
    assert.equal(claimedContract.work_session_id, 'work-a');

    const conflict = runTask(f, ['claim', '1.1', '--session', 'session-b', '--lease-seconds', '60', '--json']);
    assert.equal(conflict.status, 2);
    assert.match(conflict.stderr, /TASK_LEASE_CONFLICT/);

    const wrongRelease = runTask(f, ['release', '1.1', '--session', 'session-b', '--json']);
    assert.equal(wrongRelease.status, 2);
    assert.match(wrongRelease.stderr, /TASK_LEASE_NOT_OWNER/);

    const registry = readSessionRegistry(f.vault);
    const ownerContext = Object.values(registry.active_contexts).find((context) => context.work_session_id === 'work-a');
    ownerContext.task_leases['change-a:1.1'].expires_at = '2000-01-01T00:00:00.000Z';
    writeSessionRegistry(f.vault, registry);

    const recovered = runTask(f, ['claim', '1.1', '--session', 'session-b', '--lease-seconds', '60', '--json']);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).owner_session_id, 'session-b');

    const released = runTask(f, ['release', '1.1', '--session', 'session-b', '--json']);
    assert.equal(released.status, 0, released.stderr);
    assert.equal(JSON.parse(released.stdout).state, 'released');
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:TC-6] task claim stays exclusive across two real Git worktrees', () => {
  const f = fixture();
  try {
    const worktree = addSiblingWorktree(f);
    assert.equal(runCli(f, ['change', 'use', 'change-a', '--session', 'session-a']).status, 0);
    assert.equal(runCli(f, ['change', 'use', 'change-a', '--session', 'session-b'], worktree).status, 0);

    const first = runTask(f, ['claim', '1.1', '--session', 'session-a', '--lease-seconds', '60', '--json']);
    assert.equal(first.status, 0, first.stderr);

    const conflict = runTask(
      f,
      ['claim', '1.1', '--session', 'session-b', '--lease-seconds', '60', '--json'],
      worktree,
    );
    assert.equal(conflict.status, 2);
    assert.match(conflict.stderr, /TASK_LEASE_CONFLICT/);

    const registry = readSessionRegistry(f.vault);
    const contexts = Object.values(registry.active_contexts);
    assert.equal(new Set(contexts.map((context) => context.worktree_id)).size, 2);

    assert.equal(runTask(f, ['release', '1.1', '--session', 'session-a', '--json']).status, 0);
    const second = runTask(f, ['claim', '1.1', '--session', 'session-b', '--json'], worktree);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).owner_work_session_id, 'work-b');
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});
