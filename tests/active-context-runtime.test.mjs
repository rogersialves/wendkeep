import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { bindProjectVault } from '../src/project-vault.mjs';
import { writeSessionRegistry } from '../hooks/obsidian-common.mjs';
import { setActiveContextChange } from '../hooks/active-context-store.mjs';
import { captureProjectScope, scopeForRegistry } from '../hooks/project-scope.mjs';
import {
  discoverWorktreeRepository,
  ensureWorktreeMetadata,
  worktreeIdentity,
} from '../packages/vault/src/worktree-metadata.mjs';
import { resolveRuntimeActiveContext } from '../src/active-context-runtime.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return String(result.stdout || '').trim();
}

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'wk-active-context-runtime-'));
  const project = join(parent, 'project');
  git(parent, ['init', project]);
  git(project, ['config', 'user.email', 'test@example.invalid']);
  git(project, ['config', 'user.name', 'WendKeep Test']);
  git(project, ['branch', '-M', 'main']);
  git(project, ['remote', 'add', 'origin', 'https://example.com/acme/runtime.git']);
  git(project, ['commit', '--allow-empty', '-m', 'fixture']);
  const vault = join(parent, 'vault');
  const binding = bindProjectVault({ projectRoot: project, vaultPath: vault });
  const repository = discoverWorktreeRepository({ startDir: project });
  const metadata = ensureWorktreeMetadata({
    repository,
    projectId: binding.projectId,
    vaultPath: vault,
  });
  return { parent, project, vault, binding, repository, metadata };
}

function session(f, sessionId, workSessionId) {
  return {
    status: 'active', provider: 'codex', work_session_id: workSessionId,
    project_scope: scopeForRegistry(captureProjectScope({
      input: { cwd: f.project },
      projectRoot: f.project,
      projectId: f.binding.projectId,
      provider: 'codex',
      sessionId,
    })),
  };
}

test('[req:ACTX-10] runtime identity uses the worktree registry and explicit causal session', () => {
  const f = fixture();
  try {
    writeSessionRegistry(f.vault, {
      version: 2,
      sessions: { 'session-a': session(f, 'session-a', 'work-a') },
    });
    const resolved = resolveRuntimeActiveContext({
      vaultBase: f.vault,
      projectRoot: f.project,
      sessionId: 'session-a',
    });
    assert.deepEqual(resolved, {
      projectId: f.binding.projectId,
      repositoryId: f.metadata.repositoryId,
      worktreeId: worktreeIdentity(f.metadata.repositoryId, f.repository.gitDir),
      workSessionId: 'work-a',
      branch: 'main',
      headSha: git(f.project, ['rev-parse', 'HEAD']),
      sessionId: 'session-a',
    });
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-10] runtime identity without session fails when two sessions match the worktree', () => {
  const f = fixture();
  try {
    writeSessionRegistry(f.vault, {
      version: 2,
      sessions: {
        'session-a': session(f, 'session-a', 'work-a'),
        'session-b': session(f, 'session-b', 'work-b'),
      },
    });
    assert.throws(
      () => resolveRuntimeActiveContext({ vaultBase: f.vault, projectRoot: f.project }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_AMBIGUOUS',
    );
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-10] one active context safely narrows multiple matching sessions', () => {
  const f = fixture();
  try {
    writeSessionRegistry(f.vault, {
      version: 2,
      sessions: {
        'session-a': session(f, 'session-a', 'work-a'),
        'session-b': session(f, 'session-b', 'work-b'),
      },
    });
    const expected = {
      projectId: f.binding.projectId,
      repositoryId: f.metadata.repositoryId,
      worktreeId: worktreeIdentity(f.metadata.repositoryId, f.repository.gitDir),
      workSessionId: 'work-a',
      branch: 'main',
      headSha: git(f.project, ['rev-parse', 'HEAD']),
      sessionId: 'session-a',
    };
    setActiveContextChange(f.vault, expected, 'change-a');

    assert.deepEqual(resolveRuntimeActiveContext({
      vaultBase: f.vault,
      projectRoot: f.project,
    }), expected);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-10] explicit causal session fails closed when its registered identity diverges', () => {
  const f = fixture();
  try {
    const divergent = session(f, 'session-a', 'work-a');
    divergent.project_scope.branch = 'wk/another-context';
    writeSessionRegistry(f.vault, {
      version: 2,
      sessions: { 'session-a': divergent },
    });
    assert.throws(
      () => resolveRuntimeActiveContext({
        vaultBase: f.vault,
        projectRoot: f.project,
        sessionId: 'session-a',
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND'
        && /não corresponde/.test(error.message),
    );
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});
