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
  const parent = mkdtempSync(join(tmpdir(), 'wk-active-context-change-cli-'));
  const project = join(parent, 'project');
  git(parent, ['init', project]);
  git(project, ['config', 'user.email', 'test@example.invalid']);
  git(project, ['config', 'user.name', 'WendKeep Test']);
  git(project, ['branch', '-M', 'main']);
  git(project, ['remote', 'add', 'origin', 'https://example.com/acme/change-cli.git']);
  git(project, ['commit', '--allow-empty', '-m', 'fixture']);
  const vault = join(parent, 'vault');
  const binding = bindProjectVault({ projectRoot: project, vaultPath: vault });
  ensureWorktreeMetadata({
    repository: discoverWorktreeRepository({ startDir: project }),
    projectId: binding.projectId,
    vaultPath: vault,
  });
  for (const slug of ['change-a', 'change-b']) {
    const dir = join(vault, '08-Mudanças', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'proposta.md'), `# ${slug}\n`, 'utf8');
    writeFileSync(join(dir, 'tarefas.md'), '- [ ] 1.1 scoped task\n', 'utf8');
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

function runCli(f, args) {
  return spawnSync(process.execPath, [
    BIN, ...args, '--project', f.project, '--vault', f.vault,
  ], {
    cwd: f.project,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CODEX_THREAD_ID: '', CLAUDE_SESSION_ID: '' },
  });
}

function runChange(f, args) {
  return runCli(f, ['change', ...args]);
}

test('[req:ACTX-11] change CLI keeps two same-worktree sessions isolated and rejects implicit ambiguity', () => {
  const f = fixture();
  try {
    const first = runChange(f, ['use', 'change-a', '--session', 'session-a']);
    assert.equal(first.status, 0, first.stderr);
    const second = runChange(f, ['use', 'change-b', '--session', 'session-b']);
    assert.equal(second.status, 0, second.stderr);

    const registry = readSessionRegistry(f.vault);
    assert.deepEqual(
      Object.values(registry.active_contexts).map((context) => context.change_slug).sort(),
      ['change-a', 'change-b'],
    );
    assert.equal(readFileSync(join(f.vault, '.brain', 'CURRENT_CHANGE.md'), 'utf8'), 'change:\n');

    const done = runChange(f, ['done', '1.1', '--session', 'session-a']);
    assert.equal(done.status, 0, done.stderr);
    assert.match(readFileSync(join(f.vault, '08-Mudanças', 'change-a', 'tarefas.md'), 'utf8'), /\[x\]/);
    assert.match(readFileSync(join(f.vault, '08-Mudanças', 'change-b', 'tarefas.md'), 'utf8'), /\[ \]/);

    const ambiguous = runChange(f, ['done', '1.1']);
    assert.equal(ambiguous.status, 2);
    assert.match(ambiguous.stderr, /WENDKEEP_ACTIVE_CONTEXT_AMBIGUOUS/);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-11] implicit spec and verify resolve the change from the selected causal session', () => {
  const f = fixture();
  try {
    assert.equal(runChange(f, ['use', 'change-a', '--session', 'session-a']).status, 0);
    assert.equal(runChange(f, ['use', 'change-b', '--session', 'session-b']).status, 0);

    const spec = runCli(f, ['spec', 'effective', '--session', 'session-b']);
    assert.equal(spec.status, 0, spec.stderr);
    assert.match(spec.stdout, /^change: change-b$/m);

    const verify = runCli(f, ['verify', '--session', 'session-a']);
    assert.equal(verify.status, 0, verify.stderr);
    assert.match(verify.stdout, /verify OK \(0 sensor\(s\)\)/);
    assert.equal(readFileSync(join(f.vault, '08-Mudanças', 'change-a', 'evidencia.json'), 'utf8'), '[]\n');
    assert.throws(
      () => readFileSync(join(f.vault, '08-Mudanças', 'change-b', 'evidencia.json'), 'utf8'),
      { code: 'ENOENT' },
    );
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});
