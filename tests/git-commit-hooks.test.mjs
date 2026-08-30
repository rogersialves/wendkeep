import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'bin', 'wendkeep.mjs');
const HOOKS = join(ROOT, '.githooks');

function run(cwd, command, args, options = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, WENDKEEP_COMMIT_CLI: CLI, ...options.env },
    ...options,
  });
}

function git(cwd, ...args) {
  const result = run(cwd, 'git', args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'wk-commit-hooks-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Commit Test');
  git(repo, 'config', 'user.email', 'commit@example.invalid');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  mkdirSync(join(repo, 'plans'), { recursive: true });
  writeFileSync(join(repo, '.wendkeep.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectId: 'fixture-project',
    vault: '.Fixture-vault',
    harness: { profile: 'OFF' },
  })}\n`);
  writeFileSync(join(repo, 'docs', 'ADR-1234.md'), '# ADR-1234\n\nIssue #123\n');
  writeFileSync(join(repo, 'wendkeep.sensors.json'), `${JSON.stringify({
    sensors: [{ id: 'commit-fixture', severity: 'critical', command: 'node -e "process.exit(0)"' }],
  })}\n`);
  writeFileSync(join(repo, 'plans', 'tasks.md'), '# Tasks\n\n- [x] COMMIT-T1 Validar política universal [phase:verify] [sensor:commit-fixture]\n');
  git(repo, 'add', '.wendkeep.json', 'wendkeep.sensors.json', 'docs/ADR-1234.md', 'plans/tasks.md');
  git(repo, 'commit', '-q', '-m', 'test: prepara fixture de autoridade');
  git(repo, 'config', 'core.hooksPath', HOOKS);
  return repo;
}

function writeDraft(repo, overrides = {}) {
  const path = join(repo, 'commit-input.json');
  writeFileSync(path, `${JSON.stringify({
    schema_version: 1,
    subject: { type: 'feat', scope: 'commit', summary: 'estrutura mensagem pelo hook' },
    capability: 'Commit reproduzível entre harnesses.',
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    evidence: [
      { kind: 'adr', ref: 'docs/ADR-1234.md' },
      { kind: 'task', ref: 'plans/tasks.md' },
    ],
    limits: ['Sem leitura do Vault.'],
    identity: { agent: 'Codex' },
    ...overrides,
  }, null, 2)}\n`);
  return path;
}

test('[req:COMMIT-6] hooks reais estruturam, validam e consomem contexto sem duplicar amend', () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, 'feature.txt'), 'one\n');
    git(repo, 'add', 'feature.txt');
    const input = writeDraft(repo);
    const context = run(repo, process.execPath, [CLI, 'commit', 'context', '--input', input, '--json']);
    assert.equal(context.status, 0, context.stderr);
    const contextPath = JSON.parse(context.stdout).path;
    assert.equal(existsSync(contextPath), true);
    assert.ok(contextPath.includes('.git'), 'contexto fica no runtime Git, não no working tree');

    const committed = run(repo, 'git', ['commit', '-q', '-m', 'feat(commit): rascunho']);
    assert.equal(committed.status, 0, committed.stderr);
    assert.equal(existsSync(contextPath), false, 'commit-msg consome o contexto depois da validação');

    const message = git(repo, 'log', '-1', '--format=%B');
    assert.match(message, /^feat\(commit\): estrutura mensagem pelo hook \(ADR-1234\)$/m);
    assert.match(message, /^WendKeep-Commit: v1$/m);
    assert.match(message, /^Scope:\n- feature\.txt\n- staged-diff-sha256: [a-f0-9]{64}$/m);
    assert.doesNotMatch(message, /\.WendKeep-vault|\.brain|SESSION_REGISTRY/);

    const before = message;
    const amended = run(repo, 'git', ['commit', '--amend', '--no-edit', '-q']);
    assert.equal(amended.status, 0, amended.stderr);
    assert.equal(git(repo, 'log', '-1', '--format=%B'), before);
    assert.equal((before.match(/^WendKeep-Commit:/gm) || []).length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('[req:COMMIT-7] commits comuns passam intactos e implementação sem contexto falha fechada', () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, 'docs', 'ordinary.md'), 'docs\n');
    git(repo, 'add', 'docs/ordinary.md');
    const ordinary = run(repo, 'git', ['commit', '-q', '-m', 'docs: registra orientação local']);
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.equal(git(repo, 'log', '-1', '--format=%B'), 'docs: registra orientação local');

    writeFileSync(join(repo, 'feature.txt'), 'feature\n');
    git(repo, 'add', 'feature.txt');
    const governed = run(repo, 'git', ['commit', '-m', 'feat: tenta ignorar evidências']);
    assert.notEqual(governed.status, 0);
    assert.match(governed.stderr, /WENDKEEP_COMMIT_MESSAGE_INVALID|Capability|ADR/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('[req:COMMIT-8] contexto rejeita prova privada antes de persistir no diretório Git', () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, 'feature.txt'), 'feature\n');
    git(repo, 'add', 'feature.txt');
    const input = writeDraft(repo, {
      evidence: [{ kind: 'task', ref: '.WendKeep-vault/.brain/verdict.json' }],
    });
    const result = run(repo, process.execPath, [CLI, 'commit', 'context', '--input', input]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WENDKEEP_COMMIT_PRIVATE_PATH/);
    const gitDir = git(repo, 'rev-parse', '--git-dir');
    assert.equal(existsSync(join(repo, gitDir, 'wendkeep-commit-input.json')), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('[req:COMMIT-21] contexto fica stale quando o index staged muda depois da captura', () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, 'feature.txt'), 'one\n');
    git(repo, 'add', 'feature.txt');
    const context = run(repo, process.execPath, [CLI, 'commit', 'context', '--input', writeDraft(repo)]);
    assert.equal(context.status, 0, context.stderr);

    writeFileSync(join(repo, 'later.txt'), 'later\n');
    git(repo, 'add', 'later.txt');
    const commit = run(repo, 'git', ['commit', '-m', 'feat(commit): contexto antigo']);
    assert.notEqual(commit.status, 0);
    assert.match(commit.stderr, /WENDKEEP_COMMIT_STALE_INPUT/);

    const cleared = run(repo, process.execPath, [CLI, 'commit', 'context', '--clear']);
    assert.equal(cleared.status, 0, cleared.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('[req:COMMIT-23] autoridade nativa exige design realmente versionado no index', () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, 'feature.txt'), 'native\n');
    git(repo, 'add', 'feature.txt');
    const design = 'docs/superpowers/specs/native-design.md';
    const input = writeDraft(repo, {
      authority: {
        kind: 'native',
        issue: '#40',
        design,
      },
      evidence: [{ kind: 'design', ref: design }, { kind: 'task', ref: 'plans/tasks.md' }],
    });

    const missing = run(repo, process.execPath, [CLI, 'commit', 'context', '--input', input]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /WENDKEEP_COMMIT_DESIGN_UNVERSIONED/);

    mkdirSync(join(repo, 'docs', 'superpowers', 'specs'), { recursive: true });
    writeFileSync(join(repo, design), '# Design aprovado para Issue #40\n');
    git(repo, 'add', design);
    const tracked = run(repo, process.execPath, [CLI, 'commit', 'context', '--input', input, '--json']);
    assert.equal(tracked.status, 0, tracked.stderr);
    const contextPath = JSON.parse(tracked.stdout).path;
    assert.equal(JSON.parse(readFileSync(contextPath, 'utf8')).authority.design, design);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('[req:COMMIT-36] runtime rederiva binding e profile em vez de confiar no draft', () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, 'feature.txt'), 'runtime\n');
    writeFileSync(join(repo, 'verdict.json'), `${JSON.stringify({
      ok: true, commit_binding: { staged_diff_sha256: '0'.repeat(64) },
    })}\n`);
    git(repo, 'add', 'feature.txt', 'verdict.json');
    const stale = writeDraft(repo, {
      evidence: [
        { kind: 'adr', ref: 'docs/ADR-1234.md' },
        { kind: 'task', ref: 'plans/tasks.md' },
        { kind: 'verdict', ref: 'verdict.json' },
      ],
    });
    const staleResult = run(repo, process.execPath, [CLI, 'commit', 'context', '--input', stale]);
    assert.notEqual(staleResult.status, 0);
    assert.match(staleResult.stderr, /WENDKEEP_COMMIT_EVIDENCE_INCOMPLETE/);

    const design = 'docs/superpowers/specs/native.md';
    mkdirSync(join(repo, 'docs', 'superpowers', 'specs'), { recursive: true });
    writeFileSync(join(repo, design), '# Design Issue #40\n');
    writeFileSync(join(repo, '.wendkeep.json'), `${JSON.stringify({ harness: { profile: 'GOVERN' } })}\n`);
    git(repo, 'add', design, '.wendkeep.json');
    const native = writeDraft(repo, {
      authority: { kind: 'native', issue: '#40', design },
      evidence: [{ kind: 'design', ref: design }, { kind: 'task', ref: 'plans/tasks.md' }],
    });
    const governed = run(repo, process.execPath, [CLI, 'commit', 'context', '--input', native]);
    assert.notEqual(governed.status, 0);
    assert.match(governed.stderr, /WENDKEEP_COMMIT_NATIVE_PROFILE_REQUIRED/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('[req:COMMIT-37] fallback OFF rejeita change causal observada no Keep Core', () => {
  const repo = initRepo();
  try {
    const design = 'docs/superpowers/specs/native.md';
    mkdirSync(join(repo, 'docs', 'superpowers', 'specs'), { recursive: true });
    mkdirSync(join(repo, '.Fixture-vault', '.brain'), { recursive: true });
    writeFileSync(join(repo, design), '# Design Issue #40\n');
    writeFileSync(join(repo, '.Fixture-vault', '.brain', 'PROJECT.json'), `${JSON.stringify({ projectId: 'fixture-project' })}\n`);
    writeFileSync(join(repo, '.Fixture-vault', '.brain', 'SESSION_REGISTRY.json'), `${JSON.stringify({
      active_contexts: {
        causal: { state: 'active', branch: git(repo, 'branch', '--show-current'), change_slug: 'causal-change' },
      },
    })}\n`);
    writeFileSync(join(repo, 'feature.txt'), 'causal\n');
    git(repo, 'add', design, 'feature.txt');
    const input = writeDraft(repo, {
      authority: { kind: 'native', issue: '#40', design },
      evidence: [{ kind: 'design', ref: design }, { kind: 'task', ref: 'plans/tasks.md' }],
    });
    const result = run(repo, process.execPath, [CLI, 'commit', 'context', '--input', input]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WENDKEEP_COMMIT_CAUSAL_AUTHORITY_EXISTS/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('[req:COMMIT-42] task file existente mas sem checklist concluído não vira prova verified', () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, 'plans', 'tasks.md'), '# Tasks\n\n- [ ] COMMIT-T1 Validar política universal [phase:verify] [sensor:commit-fixture]\n');
    writeFileSync(join(repo, 'feature.txt'), 'pending task\n');
    git(repo, 'add', 'feature.txt', 'plans/tasks.md');
    const result = run(repo, process.execPath, [CLI, 'commit', 'context', '--input', writeDraft(repo)]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WENDKEEP_COMMIT_TASKS_(?:INVALID|INCOMPLETE)/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('[req:COMMIT-27] caller não declara frescor, coautoria nem ausência causal', () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, 'feature.txt'), 'trust\n');
    git(repo, 'add', 'feature.txt');
    for (const overrides of [
      { evidence: [{ kind: 'task', ref: 'plans/tasks.md', status: 'fresh' }] },
      { identity: { agent: 'Codex', co_authors: [{ name: 'X', email: 'x@example.com', factual: true }] } },
      { authority: { kind: 'native', issue: '#40', design: 'docs/superpowers/specs/native.md', causal_change: false } },
    ]) {
      const result = run(repo, process.execPath, [CLI, 'commit', 'context', '--input', writeDraft(repo, overrides)]);
      assert.notEqual(result.status, 0);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('[req:COMMIT-28] commit-msg liga mensagem ao contexto real e preserva contexto após fraude', () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, 'feature.txt'), 'bound\n');
    git(repo, 'add', 'feature.txt');
    const created = run(repo, process.execPath, [CLI, 'commit', 'context', '--input', writeDraft(repo), '--json']);
    assert.equal(created.status, 0, created.stderr);
    const contextPath = JSON.parse(created.stdout).path;
    const messageFile = 'FAKE_MSG';
    writeFileSync(join(repo, messageFile), [
      'feat(commit): mensagem forjada (ADR-1234)', '', 'Capability:', '- X', '',
      'Evidence:', '- [verified] adr: docs/ADR-1234.md', '- [verified] task: plans/tasks.md', '',
      'Tasks:', '- X', '', 'Tests:', '- X', '', 'Scope:', '- feature.txt',
      `- staged-diff-sha256: ${'f'.repeat(64)}`, '', 'WendKeep-Commit: v1',
      'Remote-Proof-Scope: git,authority,tasks,spec,sensors',
      'Local-Causal-Proof: unpublished', 'ADR: ADR-1234', 'Refs: #123', '',
    ].join('\n'));
    const forged = run(repo, process.execPath, [CLI, 'commit', 'validate', '--message-file', messageFile, '--consume-context']);
    assert.notEqual(forged.status, 0);
    assert.match(forged.stderr, /WENDKEEP_COMMIT_CONTEXT_MISMATCH/);
    assert.equal(existsSync(contextPath), true, 'fraude não consome contexto');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('[req:COMMIT-29] message-file fora do repo/git-dir é rejeitado', () => {
  const repo = initRepo();
  const outside = join(tmpdir(), `wk-outside-${Date.now()}.txt`);
  try {
    writeFileSync(outside, 'feat: outside\n');
    for (const path of [outside, join(repo, '..', '..', basename(outside))]) {
      const result = run(repo, process.execPath, [CLI, 'commit', 'validate', '--message-file', path]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /WENDKEEP_COMMIT_MESSAGE_PATH_OUTSIDE_REPOSITORY/);
    }
  } finally {
    rmSync(outside, { force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('[req:COMMIT-30] merge e squash limpam contexto para não contaminar commit seguinte', () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, 'feature.txt'), 'pending\n');
    git(repo, 'add', 'feature.txt');
    const context = JSON.parse(run(repo, process.execPath, [CLI, 'commit', 'context', '--input', writeDraft(repo), '--json']).stdout);
    const message = 'MERGE_MSG';
    writeFileSync(join(repo, message), 'Merge branch topic\n');
    for (const source of ['merge', 'squash']) {
      if (!existsSync(context.path)) run(repo, process.execPath, [CLI, 'commit', 'context', '--input', writeDraft(repo)]);
      const prepared = run(repo, process.execPath, [CLI, 'commit', 'prepare', '--message-file', message, '--source', source]);
      assert.equal(prepared.status, 0, prepared.stderr);
      assert.equal(existsSync(context.path), false);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('[req:COMMIT-31] privacidade cobre vault configurável e absoluto embutido', () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, 'feature.txt'), 'private\n');
    git(repo, 'add', 'feature.txt');
    for (const task of ['ler .Fixture-vault/data.json', 'ler C:\\Users\\Pessoa\\secret.txt']) {
      const result = run(repo, process.execPath, [CLI, 'commit', 'context', '--input', writeDraft(repo, { tasks: [task] })]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /WENDKEEP_COMMIT_PRIVATE_PATH/);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('[req:COMMIT-62] task resolvida não persiste marker privado no contexto Git', () => {
  const repo = initRepo();
  try {
    const config = JSON.parse(readFileSync(join(repo, '.wendkeep.json'), 'utf8'));
    config.vault = 'custom-sensitive-store';
    writeFileSync(join(repo, '.wendkeep.json'), `${JSON.stringify(config)}\n`);
    writeFileSync(
      join(repo, 'plans', 'tasks.md'),
      '# Tasks\n\n- [x] COMMIT-T1 Ler custom-sensitive-store/private.md [sensor:commit-fixture]\n',
    );
    writeFileSync(join(repo, 'feature.txt'), 'private marker from task\n');
    git(repo, 'add', '.wendkeep.json', 'plans/tasks.md', 'feature.txt');
    const contextPath = git(repo, 'rev-parse', '--git-path', 'wendkeep-commit-input.json');
    assert.equal(existsSync(contextPath), false);

    const result = run(repo, process.execPath, [CLI, 'commit', 'context', '--input', writeDraft(repo)]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WENDKEEP_COMMIT_PRIVATE_PATH/);
    assert.equal(existsSync(contextPath), false, 'input resolvido privado não pode chegar ao contexto Git');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
