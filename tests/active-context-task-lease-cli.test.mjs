import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { bindProjectVault } from '../src/project-vault.mjs';
import { resolveRuntimeActiveContext } from '../src/active-context-runtime.mjs';
import { readSessionRegistry, writeSessionRegistry } from '../hooks/obsidian-common.mjs';
import { captureProjectScope, scopeForRegistry } from '../hooks/project-scope.mjs';
import {
  activeContextKey,
  mutateActiveContext,
  setActiveContextChange,
} from '../hooks/active-context-store.mjs';
import { setSessionTaskOperatingProfile } from '../hooks/operating-profile-task-store.mjs';
import { discoverWorktreeRepository, ensureWorktreeMetadata } from '../packages/vault/src/worktree-metadata.mjs';

const BIN = join(process.cwd(), 'bin', 'wendkeep.mjs');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

function fixture({ initializeContexts = true } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'wk-active-context-task-lease-cli-'));
  const project = join(parent, 'project');
  git(parent, ['init', project]);
  git(project, ['config', 'user.email', 'task-lease@example.invalid']);
  git(project, ['config', 'user.name', 'Task Lease CLI Test']);
  git(project, ['branch', '-M', 'main']);
  git(project, ['remote', 'add', 'origin', 'https://example.com/acme/task-lease-cli.git']);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  git(project, ['add', 'package.json']);
  git(project, ['commit', '-m', 'fixture']);

  const vault = join(parent, 'vault');
  const binding = bindProjectVault({
    projectRoot: project,
    vaultPath: vault,
    configPatch: { harness: { profile: 'OFF' } },
  });
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
      'session-a': {
        status: 'active', provider: 'claude', work_session_id: 'work-a', project_scope: scope('session-a'),
        last_prompt_turn_id: 'turn-a', last_turn_sequence: 1, turn_sequences: { 'turn-a': 1 },
      },
      'session-b': {
        status: 'active', provider: 'claude', work_session_id: 'work-b', project_scope: scope('session-b'),
        last_prompt_turn_id: 'turn-b', last_turn_sequence: 1, turn_sequences: { 'turn-b': 1 },
      },
    },
  });
  const a = resolveRuntimeActiveContext({ vaultBase: vault, projectRoot: project, sessionId: 'session-a' });
  const b = resolveRuntimeActiveContext({ vaultBase: vault, projectRoot: project, sessionId: 'session-b' });
  if (initializeContexts) {
    mutateActiveContext(vault, a, (context) => context);
    mutateActiveContext(vault, b, (context) => context);
  }
  return { parent, project, vault, a, b };
}

function runProfile(f, args) {
  return spawnSync(process.execPath, [
    BIN, 'profile', ...args, '--project', f.project, '--vault', f.vault,
  ], {
    cwd: f.project,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CODEX_THREAD_ID: '', CLAUDE_SESSION_ID: '' },
  });
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

test('[req:ACTX-19] [req:ACTX-20] profile CLI and executable hooks isolate and consume task leases by causal context', () => {
  const f = fixture();
  try {
    const routeA = runProfile(f, [
      'route', 'FLOW', '--session', 'session-a', '--reason', 'bounded A', '--json',
    ]);
    assert.equal(routeA.status, 0, routeA.stderr);
    const routeB = runProfile(f, [
      'route', 'GOVERN', '--session', 'session-b', '--reason', 'governed B', '--json',
    ]);
    assert.equal(routeB.status, 0, routeB.stderr);

    const statusA = runProfile(f, ['status', '--session', 'session-a', '--json']);
    const statusB = runProfile(f, ['status', '--session', 'session-b', '--json']);
    assert.equal(statusA.status, 0, statusA.stderr);
    assert.equal(statusB.status, 0, statusB.stderr);
    assert.equal(JSON.parse(statusA.stdout).profile, 'FLOW');
    assert.equal(JSON.parse(statusB.stdout).profile, 'GOVERN');

    const warnA = runHook(f, 'change-warn', {
      session_id: 'session-a', turn_id: 'turn-a', turn_sequence: 1,
      tool_input: { file_path: 'src/a.mjs' },
    });
    const warnB = runHook(f, 'change-warn', {
      session_id: 'session-b', turn_id: 'turn-b', turn_sequence: 1,
      tool_input: { file_path: 'src/b.mjs' },
    });
    assert.equal(warnA.status, 0, warnA.stderr);
    assert.equal(warnB.status, 0, warnB.stderr);
    assert.equal(JSON.parse(warnA.stdout).hookSpecificOutput?.additionalContext ?? '', '');
    assert.match(JSON.parse(warnB.stdout).hookSpecificOutput.additionalContext, /<change_warn>/);

    const changeDir = join(f.vault, '08-Mudanças', 'task-stop-open');
    mkdirSync(changeDir, { recursive: true });
    writeFileSync(join(changeDir, 'proposta.md'), '# proposta\n');
    writeFileSync(join(changeDir, 'design.md'), '# design\n');
    writeFileSync(join(changeDir, 'tarefas.md'), '- [ ] 1.1 tarefa contextual\n');
    setActiveContextChange(f.vault, f.a, 'task-stop-open', { projectLegacy: false });

    let registry = readSessionRegistry(f.vault);
    const keyA = activeContextKey(f.a);
    const keyB = activeContextKey(f.b);
    const siblingBefore = JSON.stringify(registry.active_contexts[keyB]);
    const blockedA = runHook(f, 'change-nag', {
      session_id: 'session-a', turn_id: 'turn-a', turn_sequence: 1,
    });
    assert.equal(blockedA.status, 0, blockedA.stderr);
    assert.equal(JSON.parse(blockedA.stdout).decision, 'block');
    registry = readSessionRegistry(f.vault);
    assert.equal(registry.active_contexts[keyA].operating_profile_task.state, 'active');
    assert.equal(JSON.stringify(registry.active_contexts[keyB]), siblingBefore);

    const retryA = runHook(f, 'change-nag', {
      session_id: 'session-a', turn_id: 'turn-a', turn_sequence: 1,
      stop_hook_active: true,
    });
    assert.equal(retryA.status, 0, retryA.stderr);
    assert.deepEqual(JSON.parse(retryA.stdout), {});
    registry = readSessionRegistry(f.vault);
    assert.equal(registry.active_contexts[keyA].operating_profile_task.state, 'consumed');
    assert.equal(registry.active_contexts[keyB].operating_profile_task.state, 'active');
    assert.equal(JSON.stringify(registry.active_contexts[keyB]), siblingBefore);
    assert.equal(registry.sessions['session-a'].operating_profile_task, undefined);
    assert.equal(registry.sessions['session-b'].operating_profile_task, undefined);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-21] profile status preserves the session lease before contextual registry initialization', () => {
  const f = fixture({ initializeContexts: false });
  try {
    setSessionTaskOperatingProfile(f.vault, 'session-a', 'FLOW', {
      reason: 'legacy pre-migration lease', leaseId: 'legacy-cli-lease',
      now: '2026-08-22T08:00:00.000Z',
    });

    const status = runProfile(f, ['status', '--session', 'session-a', '--json']);
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.profile, 'FLOW');
    assert.equal(payload.task_lease.state, 'active');
    assert.equal(payload.task_lease.lease_id, 'legacy-cli-lease');

    const stop = runHook(f, 'change-nag', {
      session_id: 'session-a', turn_id: 'turn-a', turn_sequence: 1,
    });
    assert.equal(stop.status, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {});
    const registry = readSessionRegistry(f.vault);
    assert.equal(registry.sessions['session-a'].operating_profile_task.state, 'consumed');
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});
