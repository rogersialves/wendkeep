import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { bindProjectVault } from '../src/project-vault.mjs';
import { writeSessionRegistry } from '../hooks/obsidian-common.mjs';
import { captureProjectScope, scopeForRegistry } from '../hooks/project-scope.mjs';
import { discoverWorktreeRepository, ensureWorktreeMetadata } from '../packages/vault/src/worktree-metadata.mjs';

const BIN = join(process.cwd(), 'bin', 'wendkeep.mjs');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'wk-active-context-delivery-cli-'));
  const project = join(parent, 'project');
  git(parent, ['init', project]);
  git(project, ['config', 'user.email', 'delivery@example.invalid']);
  git(project, ['config', 'user.name', 'Delivery CLI Test']);
  git(project, ['branch', '-M', 'main']);
  git(project, ['remote', 'add', 'origin', 'https://example.com/acme/delivery-cli.git']);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  git(project, ['add', 'package.json']);
  git(project, ['commit', '-m', 'fixture']);

  const vault = join(parent, 'vault');
  const binding = bindProjectVault({ projectRoot: project, vaultPath: vault });
  ensureWorktreeMetadata({
    repository: discoverWorktreeRepository({ startDir: project }),
    projectId: binding.projectId,
    vaultPath: vault,
  });
  git(project, ['add', '-A']);
  git(project, ['commit', '--allow-empty', '-m', 'bind vault']);
  const scope = (sessionId) => scopeForRegistry(captureProjectScope({
    input: { cwd: project }, projectRoot: project, projectId: binding.projectId,
    provider: 'claude', sessionId,
  }));
  writeSessionRegistry(vault, {
    version: 2,
    sessions: {
      'session-a': { status: 'active', provider: 'claude', work_session_id: 'work-a', project_scope: scope('session-a') },
      'session-b': { status: 'active', provider: 'claude', work_session_id: 'work-b', project_scope: scope('session-b') },
    },
  });
  return { parent, project, vault };
}

function runHook(f, name, input) {
  return spawnSync(process.execPath, [join(process.cwd(), 'hooks', `${name}.mjs`)], {
    cwd: f.project,
    input: JSON.stringify({ ...input, cwd: f.project, obsidian_vault_path: f.vault }),
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDECODE: '1',
      CODEX_THREAD_ID: '',
      CLAUDE_SESSION_ID: '',
    },
  });
}

function run(f, args) {
  return spawnSync(process.execPath, [
    BIN, 'delivery', ...args, '--project', f.project, '--vault', f.vault,
  ], {
    cwd: f.project,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CODEX_THREAD_ID: '', CLAUDE_SESSION_ID: '' },
  });
}

test('[req:ACTX-14] [req:ACTX-17] delivery CLI isolates implicit status and explicit lifecycle by session', () => {
  const f = fixture();
  try {
    const startA = run(f, ['start', 'delivery-a', '--allow', 'git:push', '--session', 'session-a']);
    assert.equal(startA.status, 0, startA.stderr);
    const startB = run(f, ['start', 'delivery-b', '--allow', 'git:push', '--session', 'session-b']);
    assert.equal(startB.status, 0, startB.stderr);

    const statusA = run(f, ['status', '--session', 'session-a', '--json']);
    assert.equal(statusA.status, 0, statusA.stderr);
    assert.equal(JSON.parse(statusA.stdout).id, 'delivery-a');

    const crossContext = run(f, ['status', 'delivery-a', '--session', 'session-b']);
    assert.equal(crossContext.status, 2);
    assert.match(crossContext.stderr, /WENDKEEP_DELIVERY_CONTEXT_MISMATCH/);

    const abandonA = run(f, ['abandon', 'delivery-a', '--reason', 'done elsewhere', '--session', 'session-a']);
    assert.equal(abandonA.status, 0, abandonA.stderr);
    const statusB = run(f, ['status', '--session', 'session-b', '--json']);
    assert.equal(statusB.status, 0, statusB.stderr);
    assert.equal(JSON.parse(statusB.stdout).id, 'delivery-b');
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-16] executable hooks resolve and propagate the causal delivery context', () => {
  const f = fixture();
  try {
    const startB = run(f, ['start', 'delivery-b', '--allow', 'git:push', '--session', 'session-b']);
    assert.equal(startB.status, 0, startB.stderr);

    const contextA = runHook(f, 'change-context', { session_id: 'session-a', prompt: 'oi' });
    assert.equal(contextA.status, 0, contextA.stderr);
    assert.equal(JSON.parse(contextA.stdout).hookSpecificOutput?.additionalContext ?? '', '');

    const contextB = runHook(f, 'change-context', { session_id: 'session-b', prompt: 'oi' });
    assert.equal(contextB.status, 0, contextB.stderr);
    assert.match(
      JSON.parse(contextB.stdout).hookSpecificOutput.additionalContext,
      /<active_delivery>Delivery delivery-b ativa/,
    );

    const warnA = runHook(f, 'change-warn', {
      session_id: 'session-a', tool_input: { file_path: 'src/a.mjs' },
    });
    assert.equal(warnA.status, 0, warnA.stderr);
    assert.match(JSON.parse(warnA.stdout).hookSpecificOutput.additionalContext, /<change_warn>/);

    const warnB = runHook(f, 'change-warn', {
      session_id: 'session-b', tool_input: { file_path: 'src/b.mjs' },
    });
    assert.equal(warnB.status, 0, warnB.stderr);
    assert.equal(JSON.parse(warnB.stdout).hookSpecificOutput?.additionalContext ?? '', '');
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});
