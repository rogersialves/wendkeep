import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const parent = mkdtempSync(join(tmpdir(), 'wk-task-verify-'));
  const project = join(parent, 'project');
  git(parent, ['init', project]);
  git(project, ['config', 'user.email', 'test@example.invalid']);
  git(project, ['config', 'user.name', 'WendKeep Test']);
  git(project, ['branch', '-M', 'main']);
  git(project, ['remote', 'add', 'origin', 'https://example.com/acme/task-verify.git']);
  git(project, ['commit', '--allow-empty', '-m', 'fixture']);
  writeFileSync(join(project, 'wendkeep.sensors.json'), JSON.stringify({
    version: 1,
    sensors: [{ id: 'contract-sensor', severity: 'critical', command: 'node -e "process.exit(0)"' }],
  }));

  const vault = join(parent, 'vault');
  const binding = bindProjectVault({ projectRoot: project, vaultPath: vault });
  ensureWorktreeMetadata({
    repository: discoverWorktreeRepository({ startDir: project }),
    projectId: binding.projectId,
    vaultPath: vault,
  });
  const changeDir = join(vault, '08-Mudanças', 'typed');
  mkdirSync(join(changeDir, 'specs', 'task-contracts'), { recursive: true });
  writeFileSync(join(changeDir, 'proposta.md'), '---\nspec_impact: required\nspecs:\n  - task-contracts\n---\n# typed\n');
  writeFileSync(join(changeDir, 'tarefas.md'), [
    '- [x] 1.1 gated output [req:TC-7] [sensor:contract-sensor] [artifact:report]',
    '- [ ] 9.1 run deep review and archive [req:TC-7] [phase:verify]',
    '',
  ].join('\n'));
  writeFileSync(join(changeDir, 'artifacts.json'), JSON.stringify({
    schema_version: 1,
    artifacts: [{ name: 'report', type: 'path', path: 'report.txt', fromFilesystem: true }],
  }));
  writeFileSync(join(changeDir, 'specs', 'task-contracts', 'spec.md'), [
    '# Delta — task-contracts', '', '## ADDED Requirements', '',
    '### Requisito: TC-7 — Verify gate', '', 'Verify MUST respect active contracts.', '',
    '## MODIFIED Requirements', '', '## REMOVED Requirements', '',
  ].join('\n'));
  const scope = scopeForRegistry(captureProjectScope({
    input: { cwd: project }, projectRoot: project, projectId: binding.projectId,
    provider: 'codex', sessionId: 'session-a',
  }));
  writeSessionRegistry(vault, {
    version: 2,
    sessions: {
      'session-a': { status: 'active', provider: 'codex', work_session_id: 'work-a', project_scope: scope },
    },
  });
  return { parent, project, vault, changeDir };
}

function runCli(f, args) {
  return spawnSync(process.execPath, [BIN, ...args, '--project', f.project, '--vault', f.vault], {
    cwd: f.project,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CODEX_THREAD_ID: '', CLAUDE_SESSION_ID: '' },
  });
}

test('[req:TC-4] [req:TC-7] verify captures evidence but blocks E→V until artifacts satisfy the active contract', () => {
  const f = fixture();
  try {
    const selected = runCli(f, ['change', 'use', 'typed', '--session', 'session-a']);
    assert.equal(selected.status, 0, selected.stderr);

    const blocked = runCli(f, ['verify', '--session', 'session-a', '--deep']);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /TASK_ARTIFACT_MISSING/);
    assert.equal(existsSync(join(f.changeDir, 'evidencia.json')), true, 'sensor evidence must survive the gate');
    assert.equal(existsSync(join(f.changeDir, 'verificacao.json')), false, 'deep package must wait for E→V');
    const evaluation = JSON.parse(readFileSync(join(f.changeDir, 'task-evaluation.json'), 'utf8'));
    assert.equal(evaluation.ok, false);
    assert.deepEqual(evaluation.tasks[0].missing_artifacts, ['report']);

    writeFileSync(join(f.project, 'report.txt'), 'done');
    const allowed = runCli(f, ['verify', '--session', 'session-a']);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /verify OK/);
    const allowedEvaluation = JSON.parse(readFileSync(join(f.changeDir, 'task-evaluation.json'), 'utf8'));
    assert.equal(allowedEvaluation.ok, true);
    assert.equal(allowedEvaluation.tasks.find((task) => task.task_id === '9.1').can_complete, false);
    assert.equal(allowedEvaluation.tasks.find((task) => task.task_id === '9.1').phase, 'verify');
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});
