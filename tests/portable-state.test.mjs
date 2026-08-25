import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildPortableState,
  classifyPortableArtifact,
  diffPortableState,
  exportPortableState,
  importPortableState,
  inspectPortableState,
} from '../src/portable.mjs';

function fixture(name, { seed = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), `wk-portable-${name}-`));
  const project = join(root, 'project');
  const vault = join(root, 'vault');
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(vault, '.brain', 'runtime'), { recursive: true });
  writeFileSync(join(vault, '.brain', 'PROJECT.json'), `${JSON.stringify({ projectId: 'project-a' })}\n`);
  writeFileSync(join(vault, '.brain', 'CORE.md'), '# Core\n\nPublic invariant.\n');
  if (seed) {
    mkdirSync(join(vault, '07-Specs'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', 'portable'), { recursive: true });
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    writeFileSync(join(vault, '07-Specs', 'portable.md'), '# Portable\n');
    writeFileSync(join(vault, '04-Decisões', 'ADR-0001-portable.md'), '# Decision\n');
    writeFileSync(join(vault, '08-Mudanças', 'portable', 'proposta.md'), '# Proposal\n');
    writeFileSync(join(vault, '08-Mudanças', 'portable', 'tarefas.md'), '- [x] 1.1 done\n- [ ] 1.2 next\n');
    writeFileSync(join(vault, '08-Mudanças', 'portable', 'evidencia.json'), '{"private":"generated"}\n');
  }
  return { root, project, vault };
}

function context(overrides = {}) {
  return {
    project_id: 'project-a', repository_id: 'repository-a', worktree_id: 'private-worktree',
    work_session_id: 'private-session', change_slug: 'portable', branch: 'wk/portable',
    head_sha: 'b'.repeat(40), state: 'active', revision: 4, ...overrides,
  };
}

test('[req:PORT-1] inventory separates authored state from derived, runtime, and secret data', () => {
  assert.equal(classifyPortableArtifact('.brain/CORE.md'), 'authored');
  assert.equal(classifyPortableArtifact('07-Specs/auth.md'), 'derived');
  assert.equal(classifyPortableArtifact('08-Mudanças/x/specs/auth/spec.md'), 'authored');
  assert.equal(classifyPortableArtifact('08-Mudanças/x/evidencia.json'), 'derived');
  assert.equal(classifyPortableArtifact('.brain/runtime/SESSION_REGISTRY.json'), 'runtime');
  assert.equal(classifyPortableArtifact('02-Sessões/private.md'), 'secret');
});

test('[req:PORT-2] export is deterministic, compact, and contains no private context identifiers', () => {
  const f = fixture('deterministic');
  try {
    const options = {
      vaultBase: f.vault, projectRoot: f.project, repositoryId: 'repository-a',
      activeContexts: [context()], headSha: 'c'.repeat(40), baseSha: 'a'.repeat(40),
      now: '2026-08-25T12:00:00.000Z',
    };
    const first = buildPortableState(options);
    const second = buildPortableState(options);
    assert.deepEqual(first, second);
    assert.equal(first.active_work[0].revision, 4);
    assert.equal(first.active_work[0].task_id, '1.2');
    assert.deepEqual(first.active_work[0].completed, ['1.1']);
    assert.equal(JSON.stringify(first).includes('private-session'), false);
    assert.equal(JSON.stringify(first).includes('private-worktree'), false);
    assert.equal(first.artifacts.some((item) => item.path.endsWith('evidencia.json')), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PORT-3] export redacts Windows/POSIX absolute paths and common secret values', () => {
  const f = fixture('redaction');
  try {
    writeFileSync(join(f.vault, '08-Mudanças', 'portable', 'design.md'), [
      'Windows C:\\Users\\roger\\secret.txt',
      'POSIX /home/roger/private.txt',
      'token=ghp_abcdefghijklmnopqrstuvwxyz123456',
      'Authorization: Bearer abc.def.ghi',
    ].join('\n'));
    const state = buildPortableState({
      vaultBase: f.vault, projectRoot: f.project, repositoryId: 'repository-a',
      activeContexts: [context()], now: '2026-08-25T12:00:00.000Z',
    });
    const bytes = JSON.stringify(state);
    assert.doesNotMatch(bytes, /C:\\\\Users|\/home\/roger|ghp_|abc\.def\.ghi/);
    assert.match(bytes, /\[REDACTED_(?:PATH|SECRET)\]/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PORT-4] import rejects traversal and tampered content before writing', () => {
  const f = fixture('traversal');
  try {
    const state = buildPortableState({
      vaultBase: f.vault, projectRoot: f.project, repositoryId: 'repository-a',
      activeContexts: [context()], now: '2026-08-25T12:00:00.000Z',
    });
    state.artifacts[0].path = '../outside.md';
    assert.throws(
      () => importPortableState({ vaultBase: f.vault, projectRoot: f.project, state }),
      (error) => error?.code === 'WENDKEEP_PORTABLE_PATH_UNSAFE',
    );
    assert.equal(existsSync(join(f.root, 'outside.md')), false);
    const privateContext = buildPortableState({
      vaultBase: f.vault, projectRoot: f.project, repositoryId: 'repository-a',
      activeContexts: [context()], now: '2026-08-25T12:00:00.000Z',
    });
    privateContext.active_work[0].work_session_id = 'must-not-cross';
    assert.throws(
      () => importPortableState({ vaultBase: f.vault, projectRoot: f.project, state: privateContext }),
      (error) => error?.code === 'WENDKEEP_PORTABLE_SCHEMA',
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PORT-2] two active contexts produce independent portable snapshots', () => {
  const f = fixture('two-contexts');
  try {
    const state = buildPortableState({
      vaultBase: f.vault, projectRoot: f.project, repositoryId: 'repository-a',
      activeContexts: [
        context(),
        context({ worktree_id: 'private-two', work_session_id: 'session-two', branch: 'wk/other', change_slug: 'other', revision: 2 }),
      ],
      now: '2026-08-25T12:00:00.000Z',
    });
    assert.equal(state.active_work.length, 2);
    assert.equal(new Set(state.active_work.map((item) => item.active_work_id)).size, 2);
    assert.doesNotMatch(JSON.stringify(state), /private-two|session-two/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PORT-5] clean-clone import round-trips authored files and stores only portable resume state', () => {
  const source = fixture('roundtrip-source');
  const target = fixture('roundtrip-target', { seed: false });
  try {
    const state = buildPortableState({
      vaultBase: source.vault, projectRoot: source.project, repositoryId: 'repository-a',
      activeContexts: [context()], now: '2026-08-25T12:00:00.000Z',
    });
    const imported = importPortableState({ vaultBase: target.vault, projectRoot: target.project, state });
    assert.equal(imported.imported > 0, true);
    assert.equal(readFileSync(join(target.vault, '07-Specs', 'portable.md'), 'utf8'), '# Portable\n');
    assert.equal(existsSync(join(target.vault, '08-Mudanças', 'portable', 'evidencia.json')), false);
    const resume = JSON.parse(readFileSync(join(target.vault, '.brain', 'runtime', 'PORTABLE_ACTIVE_WORK.json'), 'utf8'));
    assert.equal(resume.active_work[0].change_slug, 'portable');
    assert.equal(JSON.stringify(resume).includes('private-session'), false);
    const rebuilt = buildPortableState({
      vaultBase: target.vault, projectRoot: target.project, repositoryId: 'repository-a',
      activeContexts: [], now: '2026-08-25T12:00:00.000Z',
    });
    assert.equal(rebuilt.active_work[0].change_slug, 'portable');
    assert.equal(rebuilt.active_work[0].tasks_sha256, state.active_work[0].tasks_sha256);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('[req:PORT-6] stale revision or same-revision hash conflict never overwrites local state', () => {
  const f = fixture('revision');
  try {
    const newer = buildPortableState({
      vaultBase: f.vault, projectRoot: f.project, repositoryId: 'repository-a',
      activeContexts: [context({ revision: 8 })], now: '2026-08-25T12:00:00.000Z',
    });
    importPortableState({ vaultBase: f.vault, projectRoot: f.project, state: newer });
    const stale = structuredClone(newer);
    stale.active_work[0].revision = 7;
    assert.throws(
      () => importPortableState({ vaultBase: f.vault, projectRoot: f.project, state: stale }),
      (error) => error?.code === 'WENDKEEP_PORTABLE_STALE',
    );
    const conflict = structuredClone(newer);
    conflict.active_work[0].next_actions = ['different'];
    assert.throws(
      () => importPortableState({ vaultBase: f.vault, projectRoot: f.project, state: conflict }),
      (error) => error?.code === 'WENDKEEP_PORTABLE_CONFLICT',
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PORT-7] export provenance records hashes only and diff diagnoses authored divergence', () => {
  const f = fixture('provenance');
  try {
    const output = join(f.project, '.wendkeep', 'portable', 'state.json');
    const result = exportPortableState({
      vaultBase: f.vault, projectRoot: f.project, repositoryId: 'repository-a', output,
      activeContexts: [context()], now: '2026-08-25T12:00:00.000Z',
    });
    assert.equal(result.changed, true);
    assert.equal(diffPortableState({ vaultBase: f.vault, projectRoot: f.project, input: output }).equal, true);
    writeFileSync(join(f.vault, '07-Specs', 'portable.md'), '# Changed\n');
    const diff = diffPortableState({ vaultBase: f.vault, projectRoot: f.project, input: output });
    assert.equal(diff.equal, false);
    assert.deepEqual(diff.changed, ['07-Specs/portable.md']);
    const health = inspectPortableState({ vaultBase: f.vault, projectRoot: f.project, input: output });
    assert.equal(health.status, 'diverged');
    const ledger = readFileSync(join(f.vault, '.brain', 'runtime', 'PORTABLE_PROVENANCE.jsonl'), 'utf8');
    assert.match(ledger, /"operation":"export"/);
    assert.doesNotMatch(ledger, /# Core|# Proposal|private-session/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PORT-8] CLI help, public schemas, and PT/EN guides expose the portable contract', () => {
  const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const help = spawnSync(process.execPath, ['bin/wendkeep.mjs', 'portable', '--help'], {
    cwd, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(help.status, 0, help.stderr);
  for (const command of ['status', 'export', 'import', 'diff']) assert.match(help.stdout, new RegExp(command));
  for (const path of [
    'schema/portable-state-v1.schema.json', 'schema/portable-active-work-v1.schema.json',
    'docs/pt-BR/commands/portable.md', 'docs/en/commands/portable.md',
  ]) assert.equal(existsSync(join(cwd, ...path.split('/'))), true, path);
  const pt = readFileSync(join(cwd, 'docs', 'pt-BR', 'commands', 'portable.md'), 'utf8');
  const en = readFileSync(join(cwd, 'docs', 'en', 'commands', 'portable.md'), 'utf8');
  for (const token of ['active-work', 'WENDKEEP_PORTABLE_STALE', 'PORTABLE_PROVENANCE.jsonl']) {
    assert.match(pt, new RegExp(token));
    assert.match(en, new RegExp(token));
  }
});
