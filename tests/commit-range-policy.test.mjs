import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'validate-commit-range.mjs');

function spawn(cwd, command, args) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
}

function git(cwd, ...args) {
  const result = spawn(cwd, 'git', args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'wk-commit-range-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Range Test');
  git(root, 'config', 'user.email', 'range@example.invalid');
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'plans'), { recursive: true });
  writeFileSync(join(root, '.wendkeep.json'), `${JSON.stringify({ vault: '.private-store', harness: { profile: 'OFF' } })}\n`);
  writeFileSync(join(root, 'docs', 'ADR-1234.md'), '# ADR-1234\n\nIssue #123\n');
  writeFileSync(join(root, 'wendkeep.sensors.json'), `${JSON.stringify({
    sensors: [{ id: 'commit-fixture', severity: 'critical', command: 'node -e "process.exit(0)"' }],
  })}\n`);
  writeFileSync(join(root, 'plans', 'tasks.md'), '# Tasks\n\n- [x] COMMIT-T1 Validar range remoto [phase:verify] [sensor:commit-fixture]\n');
  git(root, 'add', '.wendkeep.json', 'wendkeep.sensors.json', 'docs/ADR-1234.md', 'plans/tasks.md');
  git(root, 'commit', '-q', '-m', 'chore: baseline');
  return root;
}

function governedMessage(root) {
  const diff = spawn(root, 'git', ['diff', '--cached', '--binary', '--no-ext-diff', '--no-color']);
  assert.equal(diff.status, 0, diff.stderr);
  const hash = createHash('sha256').update(Buffer.from(diff.stdout, 'utf8')).digest('hex');
  const files = git(root, 'diff', '--cached', '--name-only', '--no-renames').split(/\r?\n/).filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const signed = (path) => `${path}@sha256:${createHash('sha256').update(readFileSync(join(root, ...path.split('/')), 'utf8')).digest('hex')}`;
  const sensorCommand = JSON.parse(readFileSync(join(root, 'wendkeep.sensors.json'), 'utf8')).sensors[0].command;
  const specPath = 'docs/specs/commit.md';
  const publicSpec = existsSync(join(root, ...specPath.split('/')))
    ? [`- [verified] spec: ${signed(specPath)}`]
    : [];
  return [
    'feat(commit): valida range remoto (ADR-1234)', '', 'Capability:', '- Validação remota.', '',
    'Evidence:', `- [verified] adr: ${signed('docs/ADR-1234.md')}`, ...publicSpec,
    `- [verified] task: ${signed('plans/tasks.md')}`, '',
    'Tasks:', '- COMMIT-T1: Validar range remoto', '', 'Tests:', `- sensor:commit-fixture (${sensorCommand})`, '',
    'Scope:', ...files.map((file) => `- ${file}`), `- staged-diff-sha256: ${hash}`, '',
    'WendKeep-Commit: v1',
    'Remote-Proof-Scope: git,authority,tasks,spec,sensors',
    'Local-Causal-Proof: unpublished',
    'ADR: ADR-1234', 'Refs: #123', '',
  ].join('\n');
}

test('[req:COMMIT-9] gate remoto detecta feat criado com bypass local', () => {
  const root = repo();
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'feature.txt'), 'bypass\n');
    git(root, 'add', 'feature.txt');
    git(root, 'commit', '-q', '--no-verify', '-m', 'feat: bypass local');

    const result = spawn(root, process.execPath, [SCRIPT, '--base', base, '--head', 'HEAD']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /WENDKEEP_COMMIT_RANGE_INVALID/);
    assert.match(result.stderr, /feat: bypass local/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:COMMIT-53] range reexecuta sensor no checkout do SHA de cada commit', () => {
  const root = repo();
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    for (const expected of ['one', 'two']) {
      const command = `node -e "const fs=require('node:fs');process.exit(fs.readFileSync('state.txt','utf8').trim()==='${expected}'?0:1)"`;
      writeFileSync(join(root, 'wendkeep.sensors.json'), `${JSON.stringify({
        sensors: [{ id: 'commit-fixture', severity: 'critical', command }],
      })}\n`);
      writeFileSync(join(root, 'state.txt'), `${expected}\n`);
      git(root, 'add', 'wendkeep.sensors.json', 'state.txt');
      git(root, 'commit', '-q', '--no-verify', '-m', governedMessage(root));
    }
    const result = spawn(root, process.execPath, [SCRIPT, '--base', base, '--head', 'HEAD']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 commit\(s\).*valid/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:COMMIT-59] range aceita GOVERN com requisito coberto por spec pública versionada', () => {
  const root = repo();
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'specs', 'commit.md'), '## Requirements\n\n### Requirement: COMMIT-PUBLIC-1 — range\nObservable.\n');
    writeFileSync(join(root, 'plans', 'tasks.md'), '# Tasks\n\n- [x] COMMIT-T1 Validar range remoto [req:COMMIT-PUBLIC-1] [sensor:commit-fixture]\n');
    writeFileSync(join(root, 'feature.txt'), 'governed\n');
    git(root, 'add', 'docs/specs/commit.md', 'plans/tasks.md', 'feature.txt');
    git(root, 'commit', '-q', '--no-verify', '-m', governedMessage(root));
    const result = spawn(root, process.execPath, [SCRIPT, '--base', base, '--head', 'HEAD']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 commit\(s\).*valid/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('[req:COMMIT-60] range rejeita requisito sem spec pública e overclaim de proof local', () => {
  for (const mode of ['missing-spec', 'local-overclaim']) {
    const root = repo();
    try {
      const base = git(root, 'rev-parse', 'HEAD');
      writeFileSync(join(root, 'feature.txt'), `${mode}\n`);
      if (mode === 'missing-spec') {
        writeFileSync(join(root, 'plans', 'tasks.md'), '# Tasks\n\n- [x] COMMIT-T1 Validar range remoto [req:COMMIT-PUBLIC-1] [sensor:commit-fixture]\n');
        git(root, 'add', 'feature.txt', 'plans/tasks.md');
      } else {
        git(root, 'add', 'feature.txt');
      }
      let message = governedMessage(root);
      if (mode === 'local-overclaim') {
        message = message.replace('[verified] task:', '[fresh] verdict:');
      }
      git(root, 'commit', '-q', '--no-verify', '-m', message);
      const result = spawn(root, process.execPath, [SCRIPT, '--base', base, '--head', 'HEAD']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, mode === 'missing-spec'
        ? /WENDKEEP_COMMIT_REMOTE_SPEC_MISSING/
        : /WENDKEEP_COMMIT_REMOTE_PROOF_UNAVAILABLE/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('[req:COMMIT-10] gate aceita commits comuns e mensagem governada autocontida', () => {
  const root = repo();
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'docs', 'guide.md'), 'docs\n');
    git(root, 'add', 'docs/guide.md');
    git(root, 'commit', '-q', '--no-verify', '-m', 'docs: orienta instalação');

    writeFileSync(join(root, 'feature.txt'), 'valid\n');
    writeFileSync(join(root, 'README.md'), '# Range válido\n');
    git(root, 'add', 'feature.txt', 'README.md');
    const message = governedMessage(root);
    git(root, 'commit', '-q', '--no-verify', '-m', message);

    const result = spawn(root, process.execPath, [SCRIPT, '--base', base, '--head', 'HEAD']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 commit\(s\).*valid/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:COMMIT-11] merge herdado é validado junto com cada commit não-merge', () => {
  const root = repo();
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', '-b', 'topic');
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests', 'topic.test.mjs'), 'topic\n');
    git(root, 'add', 'tests/topic.test.mjs');
    git(root, 'commit', '-q', '-m', 'test: cobre merge');
    git(root, 'checkout', '-q', '-b', 'integration', base);
    writeFileSync(join(root, 'docs', 'integration.md'), 'integration\n');
    git(root, 'add', 'docs/integration.md');
    git(root, 'commit', '-q', '-m', 'chore: prepara integração');
    git(root, 'merge', '--no-ff', '-q', 'topic', '-m', 'Merge branch topic');

    const result = spawn(root, process.execPath, [SCRIPT, '--base', base, '--head', 'HEAD']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3 commit\(s\).*valid/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:COMMIT-38] resolução de merge inédita não passa como merge trivial', () => {
  const root = repo();
  try {
    writeFileSync(join(root, 'docs', 'conflict.md'), 'base\n');
    git(root, 'add', 'docs/conflict.md');
    git(root, 'commit', '-q', '-m', 'docs: adiciona base do conflito');
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', '-b', 'topic');
    writeFileSync(join(root, 'docs', 'conflict.md'), 'topic\n');
    git(root, 'add', 'docs/conflict.md');
    git(root, 'commit', '-q', '-m', 'docs: altera tópico');
    git(root, 'checkout', '-q', '-b', 'integration', base);
    writeFileSync(join(root, 'docs', 'conflict.md'), 'integration\n');
    git(root, 'add', 'docs/conflict.md');
    git(root, 'commit', '-q', '-m', 'docs: altera integração');
    const conflicted = spawn(root, 'git', ['merge', '--no-ff', 'topic', '-m', 'Merge branch topic']);
    assert.notEqual(conflicted.status, 0);
    writeFileSync(join(root, 'docs', 'conflict.md'), 'resolução inédita\n');
    git(root, 'add', 'docs/conflict.md');
    git(root, 'commit', '-q', '-m', 'Merge branch topic');
    const result = spawn(root, process.execPath, [SCRIPT, '--base', base, '--head', 'HEAD']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /WENDKEEP_COMMIT_MERGE_RESOLUTION_UNGOVERNED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('[req:COMMIT-34] chore/docs/test não podem mascarar alteração de produto', () => {
  for (const subject of ['chore: bypass', 'docs: bypass', 'test: bypass']) {
    const root = repo();
    try {
      const base = git(root, 'rev-parse', 'HEAD');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'runtime.mjs'), 'export const bypass = true;\n');
      git(root, 'add', 'src/runtime.mjs');
      git(root, 'commit', '-q', '--no-verify', '-m', subject);
      const result = spawn(root, process.execPath, [SCRIPT, '--base', base, '--head', 'HEAD']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /WENDKEEP_COMMIT_PRODUCT_CHANGE_UNGOVERNED/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('[req:COMMIT-35] gate remoto rejeita SHA textual arbitrário mesmo com corpo completo', () => {
  const root = repo();
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'feature.txt'), 'hash\n');
    git(root, 'add', 'feature.txt');
    const message = governedMessage(root).replace(/staged-diff-sha256: [a-f0-9]{64}/, `staged-diff-sha256: ${'f'.repeat(64)}`);
    git(root, 'commit', '-q', '--no-verify', '-m', message);
    const result = spawn(root, process.execPath, [SCRIPT, '--base', base, '--head', 'HEAD']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /WENDKEEP_COMMIT_SCOPE_MISMATCH/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('[req:COMMIT-39] gate remoto rejeita referência ao vault configurado', () => {
  const root = repo();
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'docs', 'private.md'), 'docs\n');
    git(root, 'add', 'docs/private.md');
    git(root, 'commit', '-q', '--no-verify', '-m', 'docs: consulte .private-store');
    const result = spawn(root, process.execPath, [SCRIPT, '--base', base, '--head', 'HEAD']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /WENDKEEP_COMMIT_PRIVATE_PATH/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('[req:COMMIT-40] gate remoto rederiva semântica de proof estruturado', () => {
  const root = repo();
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'feature.txt'), 'proof semântico\n');
    git(root, 'add', 'feature.txt');
    const diff = spawn(root, 'git', ['diff', '--cached', '--binary', '--no-ext-diff', '--no-color']);
    assert.equal(diff.status, 0, diff.stderr);
    const binding = createHash('sha256').update(Buffer.from(diff.stdout, 'utf8')).digest('hex');
    git(root, 'reset', '-q', 'HEAD', '--', 'feature.txt');
    rmSync(join(root, 'feature.txt'));

    mkdirSync(join(root, 'tests', 'fixtures'), { recursive: true });
    writeFileSync(join(root, 'tests', 'fixtures', 'verdict.json'), `${JSON.stringify({ ok: false, staged_diff_sha256: binding })}\n`);
    git(root, 'add', 'tests/fixtures/verdict.json');
    git(root, 'commit', '-q', '--no-verify', '-m', 'test: registra proof de fixture');

    writeFileSync(join(root, 'feature.txt'), 'proof semântico\n');
    git(root, 'add', 'feature.txt');
    const taskDigest = createHash('sha256').update(readFileSync(join(root, 'plans', 'tasks.md'), 'utf8')).digest('hex');
    const taskLine = `- [verified] task: plans/tasks.md@sha256:${taskDigest}`;
    const message = governedMessage(root).replace(
      taskLine,
      `${taskLine}\n- [fresh] verdict: tests/fixtures/verdict.json@sha256:${createHash('sha256').update(readFileSync(join(root, 'tests', 'fixtures', 'verdict.json'), 'utf8')).digest('hex')}`,
    );
    git(root, 'commit', '-q', '--no-verify', '-m', message);
    const result = spawn(root, process.execPath, [SCRIPT, '--base', base, '--head', 'HEAD']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /WENDKEEP_COMMIT_REMOTE_PROOF_UNAVAILABLE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('[req:COMMIT-24] gate remoto rejeita autoridade nativa cujo design não existe no commit', () => {
  const root = repo();
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'feature.txt'), 'native\n');
    git(root, 'add', 'feature.txt');
    const message = [
      'feat(commit): usa autoridade nativa (#40)', '',
      'Capability:', '- Autoridade nativa verificável.', '',
      'Evidence:', '- [verified] design: docs/superpowers/specs/design-inexistente.md',
      '- [verified] task: plans/tasks.md', '',
      'Tasks:', '- Entregar issue #40.', '',
      'Tests:', '- node --test tests/commit-range-policy.test.mjs', '',
      'Scope:', '- feature.txt', `- staged-diff-sha256: ${'a'.repeat(64)}`, '',
      'WendKeep-Commit: v1',
      'Remote-Proof-Scope: git,authority,tasks,spec,sensors',
      'Local-Causal-Proof: unpublished',
      'Authority: native-no-causal-change', 'Issue: #40',
      'Design: docs/superpowers/specs/design-inexistente.md', '',
    ].join('\n');
    git(root, 'commit', '-q', '--no-verify', '-m', message);
    const result = spawn(root, process.execPath, [SCRIPT, '--base', base, '--head', 'HEAD']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /WENDKEEP_COMMIT_DESIGN_UNVERSIONED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
