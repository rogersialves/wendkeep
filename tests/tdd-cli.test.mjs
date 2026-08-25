import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const parent = mkdtempSync(join(tmpdir(), 'wk-tdd-cli-'));
  const project = join(parent, 'project');
  git(parent, ['init', project]);
  git(project, ['config', 'user.email', 'test@example.invalid']);
  git(project, ['config', 'user.name', 'WendKeep Test']);
  git(project, ['branch', '-M', 'main']);
  git(project, ['remote', 'add', 'origin', 'https://example.com/acme/tdd-cli.git']);
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'tests'), { recursive: true });
  writeFileSync(join(project, 'src', 'value.mjs'), 'export const value = false;\n');
  git(project, ['add', '.']);
  git(project, ['commit', '-m', 'fixture']);

  const vault = join(parent, 'vault');
  const binding = bindProjectVault({ projectRoot: project, vaultPath: vault });
  ensureWorktreeMetadata({
    repository: discoverWorktreeRepository({ startDir: project }),
    projectId: binding.projectId,
    vaultPath: vault,
  });
  const changeDir = join(vault, '08-Mudanças', 'tdd-attestation');
  mkdirSync(join(changeDir, 'specs', 'tdd-attestation'), { recursive: true });
  writeFileSync(join(changeDir, 'proposta.md'), [
    '---', 'spec_impact: required', 'specs:', '  - tdd-attestation', '---', '# tdd-attestation', '',
  ].join('\n'));
  writeFileSync(
    join(changeDir, 'tarefas.md'),
    '- [x] 1.1 implement behavior [req:TDD-1] [tdd]\n',
  );
  writeFileSync(join(changeDir, 'specs', 'tdd-attestation', 'spec.md'), [
    '# Delta — tdd-attestation', '', '## ADDED Requirements', '',
    '### Requisito: TDD-1 — Causal cycle', '',
    'A task MUST prove a causal RED to GREEN cycle.', '',
    '## MODIFIED Requirements', '', '## REMOVED Requirements', '',
  ].join('\n'));
  const projectScope = scopeForRegistry(captureProjectScope({
    input: { cwd: project }, projectRoot: project, projectId: binding.projectId,
    provider: 'codex', sessionId: 'session-tdd',
  }));
  writeSessionRegistry(vault, {
    version: 2,
    sessions: {
      'session-tdd': {
        status: 'active', provider: 'codex', work_session_id: 'work-tdd', project_scope: projectScope,
      },
    },
  });
  return { parent, project, vault, changeDir };
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

test('[req:TDD-1] [req:TDD-2] [req:TDD-3] CLI persists a causal RED/GREEN cycle and unlocks the task contract', () => {
  const f = fixture();
  try {
    assert.equal(runCli(f, ['change', 'use', 'tdd-attestation', '--session', 'session-tdd']).status, 0);
    writeFileSync(join(f.project, 'tests', 'behavior.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { value } from '../src/value.mjs';",
      "test('value is true', () => assert.equal(value, true));",
      '',
    ].join('\n'));
    const command = `"${process.execPath}" --test tests/behavior.test.mjs`;

    const red = runCli(f, [
      'tdd', 'red', '1.1', '--requirement', 'TDD-1', '--test', 'tests/behavior.test.mjs',
      '--command', command, '--session', 'session-tdd', '--json',
    ]);
    assert.equal(red.status, 0, red.stderr || red.stdout);
    assert.equal(JSON.parse(red.stdout).state, 'red-observed');

    const beforeGreen = runCli(f, ['task', 'evaluate', '1.1', '--session', 'session-tdd', '--json']);
    assert.equal(beforeGreen.status, 1);
    assert.match(beforeGreen.stderr || beforeGreen.stdout, /TASK_TDD_ATTESTATION_MISSING_OR_INVALID/);

    writeFileSync(join(f.project, 'src', 'value.mjs'), 'export const value = true;\n');
    const green = runCli(f, [
      'tdd', 'green', '1.1', '--command', command, '--session', 'session-tdd', '--json',
    ]);
    assert.equal(green.status, 0, green.stderr);
    const attestation = JSON.parse(green.stdout);
    assert.equal(attestation.state, 'green-observed');
    assert.deepEqual(attestation.green.production_paths, ['src/value.mjs']);

    const status = runCli(f, ['tdd', 'status', '1.1', '--session', 'session-tdd', '--json']);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).state, 'green-observed');

    const contract = JSON.parse(runCli(f, ['task', 'show', '1.1', '--session', 'session-tdd', '--json']).stdout);
    assert.equal(contract.tdd_required, true);
    assert.equal(contract.tdd_attestation_id, attestation.attestation_id);
    const evaluated = runCli(f, ['task', 'evaluate', '1.1', '--session', 'session-tdd', '--json']);
    assert.equal(evaluated.status, 0, evaluated.stderr);

    const stored = JSON.parse(readFileSync(join(f.changeDir, 'tdd-attestations.json'), 'utf8'));
    assert.equal(stored.schema_version, 1);
    assert.equal(stored.attestations.length, 1);
    assert.doesNotMatch(JSON.stringify(stored), /C:\\\\|\/Users\//i);
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test('[req:TDD-6] CLI waiver requires authority and remains visible in status', () => {
  const f = fixture();
  try {
    assert.equal(runCli(f, ['change', 'use', 'tdd-attestation', '--session', 'session-tdd']).status, 0);
    const missing = runCli(f, [
      'tdd', 'waive', '1.1', '--requirement', 'TDD-1', '--reason', 'not testable',
      '--session', 'session-tdd', '--json',
    ]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /TDD_WAIVER_AUTHORITY_REQUIRED/);

    const waived = runCli(f, [
      'tdd', 'waive', '1.1', '--requirement', 'TDD-1', '--reason', 'generated configuration',
      '--authority', 'maintainer:test', '--session', 'session-tdd', '--json',
    ]);
    assert.equal(waived.status, 0, waived.stderr);
    assert.equal(JSON.parse(waived.stdout).state, 'waived');
    assert.equal(JSON.parse(runCli(f, [
      'tdd', 'status', '1.1', '--session', 'session-tdd', '--json',
    ]).stdout).waiver.authority, 'maintainer:test');
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});
