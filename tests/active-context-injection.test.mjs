import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { bindProjectVault } from '../src/project-vault.mjs';
import {
  buildActiveChangeInjection,
  changeCtxState,
  readSentinel,
} from '../hooks/change-core.mjs';
import { buildInjection } from '../hooks/brain-inject.mjs';
import {
  mutateActiveContext,
  setActiveContextChange,
} from '../hooks/active-context-store.mjs';
import { readSessionRegistry, writeSessionRegistry } from '../hooks/obsidian-common.mjs';
import { captureProjectScope, scopeForRegistry } from '../hooks/project-scope.mjs';
import {
  resolveCommandActiveContext,
  resolveRuntimeActiveContext,
} from '../src/active-context-runtime.mjs';
import {
  discoverWorktreeRepository,
  ensureWorktreeMetadata,
} from '../packages/vault/src/worktree-metadata.mjs';
import { profileSentinelId } from '../hooks/operating-profile-runtime.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

function seedChange(vault, slug, task) {
  const dir = join(vault, '08-Mudanças', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'proposta.md'), `# ${slug}\n`);
  writeFileSync(join(dir, 'tarefas.md'), `# tarefas\n\n- [ ] 1.1 ${task}\n`);
}

function seedBudgetPressure(vault, { currentTasks, nonCurrentTasks }) {
  const lessons = join(vault, '.brain', 'lessons');
  mkdirSync(lessons, { recursive: true });
  for (let i = 0; i < 12; i += 1) {
    writeFileSync(
      join(lessons, `2026-08-${String(i + 1).padStart(2, '0')}-context.md`),
      `---\ntype: lesson\n---\nLESSON_CONTEXT_PRESSURE_${i} ${'l'.repeat(360)}\n`,
    );
  }
  for (const [slug, count, marker] of [
    ['change-a', currentTasks, 'CAUSAL_A'],
    ['change-b', nonCurrentTasks, 'SIBLING_B'],
  ]) {
    const lines = Array.from({ length: count }, (_, i) => (
      `- [ ] 2.${i} ${marker}_${i} ${'x'.repeat(220)}${i === count - 1 ? ` ${marker}_TAIL` : ''}`
    ));
    writeFileSync(join(vault, '08-Mudanças', slug, 'tarefas.md'), `${lines.join('\n')}\n`);
  }
}

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'wk-active-context-injection-'));
  const project = join(parent, 'project');
  git(parent, ['init', project]);
  git(project, ['config', 'user.email', 'injection@example.invalid']);
  git(project, ['config', 'user.name', 'Active Context Injection']);
  git(project, ['branch', '-M', 'main']);
  git(project, ['remote', 'add', 'origin', 'https://example.com/acme/injection.git']);
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
      'session-a': {
        status: 'active', provider: 'claude', work_session_id: 'work-a',
        project_scope: scope('session-a'),
      },
      'session-b': {
        status: 'active', provider: 'claude', work_session_id: 'work-b',
        project_scope: scope('session-b'),
      },
    },
  });
  const a = resolveRuntimeActiveContext({ vaultBase: vault, projectRoot: project, sessionId: 'session-a' });
  const b = resolveRuntimeActiveContext({ vaultBase: vault, projectRoot: project, sessionId: 'session-b' });
  mutateActiveContext(vault, a, (current) => current, { projectLegacy: false });
  mutateActiveContext(vault, b, (current) => current, { projectLegacy: false });
  setActiveContextChange(vault, a, 'change-a', { projectLegacy: false });
  setActiveContextChange(vault, b, 'change-b', { projectLegacy: false });
  seedChange(vault, 'change-a', 'tarefa causal A');
  seedChange(vault, 'change-b', 'tarefa causal B');
  writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: change-b\n');
  return { parent, project, vault, a, b };
}

function runHook(f, name, sessionId) {
  return spawnSync(process.execPath, [join(process.cwd(), 'hooks', `${name}.mjs`)], {
    cwd: f.project,
    input: JSON.stringify({
      hook_event_name: name === 'brain-inject' ? 'SessionStart' : 'UserPromptSubmit',
      session_id: sessionId,
      prompt: 'continuar implementação',
      cwd: f.project,
      obsidian_vault_path: f.vault,
    }),
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

function additionalContext(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout || '{}').hookSpecificOutput?.additionalContext || '';
}

function changeSentinels(vault) {
  return readdirSync(join(vault, '.brain')).filter((name) => name.startsWith('.change-'));
}

function assertHooksFailClosed(f, sessionId, label) {
  const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
  const pointerPath = join(f.vault, '.brain', 'CURRENT_CHANGE.md');
  const beforeRegistry = readFileSync(registryPath);
  const beforePointer = readFileSync(pointerPath);
  const beforeSentinels = changeSentinels(f.vault);
  for (const hook of ['brain-inject', 'change-context']) {
    const output = additionalContext(runHook(f, hook, sessionId));
    assert.doesNotMatch(output, /ATUAL — change-b|Change atual.*change-b/, `${label}/${hook}`);
    assert.deepEqual(readFileSync(registryPath), beforeRegistry, `${label}/${hook}: registry bytes`);
    assert.deepEqual(readFileSync(pointerPath), beforePointer, `${label}/${hook}: pointer bytes`);
    assert.deepEqual(changeSentinels(f.vault), beforeSentinels, `${label}/${hook}: sentinels`);
  }
}

test('[req:ACTX-30] [req:ACTX-31] change state keeps a global backlog but derives current and hash from the causal context', () => {
  const f = fixture();
  try {
    const stateA = changeCtxState(f.vault, { context: f.a });
    const stateB = changeCtxState(f.vault, { context: f.b });
    assert.equal(stateA.current, 'change-a');
    assert.equal(stateB.current, 'change-b');
    assert.notEqual(stateA.hash, stateB.hash);
    assert.deepEqual(stateA.openTasks.map((task) => task.text), ['tarefa causal A']);
    assert.deepEqual(stateB.openTasks.map((task) => task.text), ['tarefa causal B']);
    assert.deepEqual(stateA.changes.map((item) => item.slug).sort(), ['change-a', 'change-b']);
    assert.deepEqual(stateB.changes.map((item) => item.slug).sort(), ['change-a', 'change-b']);
    const injectionA = buildActiveChangeInjection(f.vault, { context: f.a });
    const injectionB = buildActiveChangeInjection(f.vault, { context: f.b });
    assert.match(injectionA, /ATUAL — change-a/);
    assert.match(injectionA, /ABERTA — change-b/);
    assert.match(injectionB, /ATUAL — change-b/);
    assert.match(injectionB, /ABERTA — change-a/);

    renameSync(
      join(f.vault, '08-Mudanças', 'change-b', 'tarefas.md'),
      join(f.vault, '08-Mudanças', 'change-b', 'tarefas.md.missing'),
    );
    const missingA = changeCtxState(f.vault, { context: f.a });
    const missingB = changeCtxState(f.vault, { context: f.b });
    assert.equal(missingA.changes.find((item) => item.current)?.warning, '');
    assert.equal(missingB.changes.find((item) => item.current)?.warning, 'tarefas.md ausente ou ilegível');
    assert.deepEqual(missingA.openTasks.map((task) => task.text), ['tarefa causal A']);
    assert.deepEqual(missingB.openTasks, []);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-30] every brain-inject budget path preserves the causal current change', () => {
  const f = fixture();
  try {
    const normalA = buildInjection(f.vault, { session_id: 'session-a' }, { context: f.a });
    const normalB = buildInjection(f.vault, { session_id: 'session-b' }, { context: f.b });
    assert.match(normalA, /ATUAL — change-a/);
    assert.doesNotMatch(normalA, /ATUAL — change-b/);
    assert.match(normalB, /ATUAL — change-b/);
    assert.doesNotMatch(normalB, /ATUAL — change-a/);

    seedBudgetPressure(f.vault, { currentTasks: 30, nonCurrentTasks: 90 });
    const currentOnlyA = buildInjection(f.vault, { session_id: 'session-a' }, { context: f.a });
    assert.match(currentOnlyA, /priority="1" layer="lessons"/);
    assert.match(currentOnlyA, /priority="2" layer="non-current-changes"/);
    assert.doesNotMatch(currentOnlyA, /priority="3" layer="current-change"/);
    assert.match(currentOnlyA, /ATUAL — change-a/);
    assert.doesNotMatch(currentOnlyA, /ATUAL — change-b|SIBLING_B_/);
    assert.match(currentOnlyA, /CAUSAL_A_TAIL/);

    seedBudgetPressure(f.vault, { currentTasks: 100, nonCurrentTasks: 90 });
    const summarizedA = buildInjection(f.vault, { session_id: 'session-a' }, { context: f.a });
    assert.match(summarizedA, /priority="3" layer="current-change"/);
    assert.match(summarizedA, /ATUAL — change-a/);
    assert.doesNotMatch(summarizedA, /ATUAL — change-b|SIBLING_B_|CAUSAL_A_TAIL/);
    assert.match(summarizedA, /conteúdo restante omitido pelo budget de injeção/i);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-30] [req:ACTX-31] executable SessionStart and UserPromptSubmit inject each session own current change', () => {
  const f = fixture();
  const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
  const pointerPath = join(f.vault, '.brain', 'CURRENT_CHANGE.md');
  try {
    const beforeRegistry = readFileSync(registryPath);
    const beforePointer = readFileSync(pointerPath);
    for (const [sessionId, own, sibling] of [
      ['session-a', 'change-a', 'change-b'],
      ['session-b', 'change-b', 'change-a'],
    ]) {
      const prompt = additionalContext(runHook(f, 'change-context', sessionId));
      assert.match(prompt, new RegExp(`ATUAL — ${own}`));
      assert.doesNotMatch(prompt, new RegExp(`ATUAL — ${sibling}`));
      assert.equal(
        readSentinel(f.vault, 'ctx', profileSentinelId(sessionId, 'GOVERN')),
        changeCtxState(f.vault, { context: sessionId === 'session-a' ? f.a : f.b }).hash,
        'UserPromptSubmit writes the causal hash before SessionStart can overwrite it',
      );
      const start = additionalContext(runHook(f, 'brain-inject', sessionId));
      assert.match(start, new RegExp(`ATUAL — ${own}`));
      assert.doesNotMatch(start, new RegExp(`ATUAL — ${sibling}`));
    }
    assert.deepEqual(readFileSync(registryPath), beforeRegistry);
    assert.deepEqual(readFileSync(pointerPath), beforePointer);
    assert.equal(
      readSentinel(f.vault, 'ctx', profileSentinelId('session-a', 'GOVERN')),
      changeCtxState(f.vault, { context: f.a }).hash,
    );
    assert.equal(
      readSentinel(f.vault, 'ctx', profileSentinelId('session-b', 'GOVERN')),
      changeCtxState(f.vault, { context: f.b }).hash,
    );
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-31] change-context ignores an adversarial legacy session focus', () => {
  const f = fixture();
  try {
    const registry = readSessionRegistry(f.vault);
    registry.sessions['session-a'].change_slug = 'change-b';
    writeSessionRegistry(f.vault, registry);
    const output = additionalContext(runHook(f, 'change-context', 'session-a'));
    assert.match(output, /ATUAL — change-a/);
    assert.match(output, /<session_change>Change vinculada a esta sessão: change-a\.<\/session_change>/);
    assert.doesNotMatch(output, /<session_change>[^<]*change-b/);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-32] an initialized empty store with one legacy candidate never migrates or writes hook sentinels', () => {
  const f = fixture();
  const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
  const pointerPath = join(f.vault, '.brain', 'CURRENT_CHANGE.md');
  try {
    const contextual = readSessionRegistry(f.vault);
    delete contextual.sessions['session-b'];
    contextual.active_contexts_schema = 1;
    contextual.active_contexts_revision = 0;
    contextual.active_contexts = {};
    writeSessionRegistry(f.vault, contextual);
    const beforeRegistry = readFileSync(registryPath);
    const beforePointer = readFileSync(pointerPath);
    const beforeSentinels = changeSentinels(f.vault);

    for (const hook of ['brain-inject', 'change-context']) {
      const output = additionalContext(runHook(f, hook, 'session-a'));
      assert.doesNotMatch(output, /ATUAL — change-b|Change atual.*change-b/);
      assert.deepEqual(readFileSync(registryPath), beforeRegistry, `${hook} must not migrate the legacy pointer`);
      assert.deepEqual(readFileSync(pointerPath), beforePointer, `${hook} must preserve the legacy pointer bytes`);
      assert.deepEqual(
        changeSentinels(f.vault),
        beforeSentinels,
        `${hook} must not create a context or gate sentinel`,
      );
    }
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-32] revision-only initialization fails closed with one legacy candidate', () => {
  const f = fixture();
  try {
    const registry = readSessionRegistry(f.vault);
    delete registry.sessions['session-b'];
    delete registry.active_contexts;
    delete registry.active_contexts_schema;
    registry.active_contexts_revision = 0;
    writeSessionRegistry(f.vault, registry);
    assertHooksFailClosed(f, 'session-a', 'revision-only');
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-32] invalid, ambiguous and mismatched hook identities preserve contextual state', () => {
  for (const scenario of ['invalid', 'ambiguous', 'mismatch']) {
    const f = fixture();
    try {
      let sessionId = 'session-a';
      if (scenario === 'invalid') sessionId = 'missing-session';
      if (scenario === 'ambiguous') sessionId = '';
      if (scenario === 'mismatch') {
        const registry = readSessionRegistry(f.vault);
        registry.sessions['session-a'].project_scope.branch = 'wk/mismatched-context';
        writeSessionRegistry(f.vault, registry);
      }
      assertHooksFailClosed(f, sessionId, scenario);
    } finally { rmSync(f.parent, { recursive: true, force: true }); }
  }
});

test('[req:ACTX-32] executable hooks retain the pre-context single-session legacy fallback', () => {
  for (const hook of ['brain-inject', 'change-context']) {
    const f = fixture();
    try {
      const registry = readSessionRegistry(f.vault);
      delete registry.sessions['session-b'];
      delete registry.active_contexts;
      delete registry.active_contexts_schema;
      delete registry.active_contexts_revision;
      writeSessionRegistry(f.vault, registry);
      const output = additionalContext(runHook(f, hook, 'session-a'));
      assert.match(output, /ATUAL — change-b/, `${hook} keeps the pre-context fallback`);
      const migrated = readSessionRegistry(f.vault);
      assert.equal(Object.values(migrated.active_contexts || {}).length, 1);
      assert.equal(Object.values(migrated.active_contexts || {})[0]?.change_slug, 'change-b');
    } finally { rmSync(f.parent, { recursive: true, force: true }); }
  }
});

test('[req:ACTX-32] initialized empty store fails closed while a pre-context registry keeps legacy fallback', () => {
  const f = fixture();
  const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
  const pointerPath = join(f.vault, '.brain', 'CURRENT_CHANGE.md');
  try {
    const contextual = readSessionRegistry(f.vault);
    contextual.active_contexts_schema = 1;
    contextual.active_contexts_revision = 0;
    contextual.active_contexts = {};
    writeSessionRegistry(f.vault, contextual);
    const beforeRegistry = readFileSync(registryPath);
    const beforePointer = readFileSync(pointerPath);
    assert.throws(
      () => resolveCommandActiveContext({
        vaultBase: f.vault, projectRoot: f.project, sessionId: 'session-a',
        requireExisting: true,
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND',
    );
    for (const hook of ['brain-inject', 'change-context']) {
      const output = additionalContext(runHook(f, hook, 'session-a'));
      assert.doesNotMatch(output, /ATUAL — change-b|Change atual.*change-b/);
    }
    assert.deepEqual(readFileSync(registryPath), beforeRegistry);
    assert.deepEqual(readFileSync(pointerPath), beforePointer);

    const legacy = readSessionRegistry(f.vault);
    delete legacy.active_contexts;
    delete legacy.active_contexts_schema;
    delete legacy.active_contexts_revision;
    writeSessionRegistry(f.vault, legacy);
    assert.equal(resolveCommandActiveContext({
      vaultBase: f.vault, projectRoot: f.project, sessionId: 'session-a',
      requireExisting: true,
    }), null);
    assert.match(buildActiveChangeInjection(f.vault), /ATUAL — change-b/);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});
