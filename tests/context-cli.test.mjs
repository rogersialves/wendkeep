import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bindProjectVault } from '../src/project-vault.mjs';
import { readSessionRegistry, writeSessionRegistry } from '../hooks/obsidian-common.mjs';
import { captureProjectScope, scopeDecision, scopeForRegistry } from '../hooks/project-scope.mjs';
import { switchSessionContext } from '../src/context.mjs';

const BIN = join(process.cwd(), 'bin', 'wendkeep.mjs');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.error?.message || ''}`);
  return String(result.stdout || '').trim();
}

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'wk-context-'));
  const project = join(parent, 'project');
  git(parent, ['init', project]);
  git(project, ['config', 'user.email', 'test@example.invalid']);
  git(project, ['config', 'user.name', 'WendKeep Test']);
  git(project, ['branch', '-M', 'main']);
  git(project, ['remote', 'add', 'origin', 'https://example.com/acme/context.git']);
  git(project, ['commit', '--allow-empty', '-m', 'fixture']);
  const vault = join(parent, 'vault');
  const binding = bindProjectVault({ projectRoot: project, vaultPath: vault });
  return { parent, project, vault, projectId: binding.projectId };
}

function scopeOf(f, sessionId, branch = '') {
  const captured = captureProjectScope({
    input: { cwd: f.project },
    projectRoot: f.project,
    projectId: f.projectId,
    provider: 'codex',
    sessionId,
  });
  return scopeForRegistry(branch ? { ...captured, branch } : captured, {
    authorizedActions: ['git:commit'],
  });
}

function seed(f, sessions) {
  writeSessionRegistry(f.vault, { version: 2, sessions });
}

function runContext(f, args) {
  return spawnSync(process.execPath, [BIN, 'context', ...args, '--project', f.project, '--json'], {
    cwd: f.project,
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('[req:ACTX-1] [req:ACTX-2] cria branch e move a scope causal com revisão e evidência', () => {
  const f = fixture();
  try {
    const sessionId = 'session-a';
    seed(f, {
      [sessionId]: {
        status: 'active', provider: 'codex', change_slug: 'active-context-branch-switch',
        project_scope: scopeOf(f, sessionId), context_revision: 4,
      },
    });

    const result = runContext(f, ['switch', 'wk/nova', '--create', '--session', sessionId]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'switched');
    assert.equal(payload.branch, 'wk/nova');
    assert.equal(payload.revision, 5);
    assert.equal(git(f.project, ['branch', '--show-current']), 'wk/nova');

    const entry = readSessionRegistry(f.vault).sessions[sessionId];
    assert.equal(entry.project_scope.branch, 'wk/nova');
    assert.equal(entry.project_scope.authorizedActions[0], 'git:commit');
    assert.equal(entry.change_slug, 'active-context-branch-switch');
    assert.equal(entry.context_revision, 5);
    assert.deepEqual(entry.context_transitions.map((event) => [event.revision, event.from.branch, event.to.branch]), [
      [5, 'main', 'wk/nova'],
    ]);

    const actual = scopeOf(f, sessionId);
    assert.equal(scopeDecision({
      command: 'git commit -m seguinte',
      expectedScope: entry.project_scope,
      actualScope: actual,
      host: 'codex',
      currentSessionId: sessionId,
    }), null, 'a mutação seguinte continua dentro da scope');
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-3] sem --session aceita somente uma candidata causal', () => {
  const f = fixture();
  try {
    seed(f, {
      'session-a': { status: 'active', provider: 'codex', project_scope: scopeOf(f, 'session-a') },
    });
    const unique = runContext(f, ['switch', 'wk/unica', '--create']);
    assert.equal(unique.status, 0, unique.stderr);
    assert.equal(JSON.parse(unique.stdout).session_id, 'session-a');

    git(f.project, ['switch', 'main']);
    git(f.project, ['branch', '-D', 'wk/unica']);
    seed(f, {
      'session-a': { status: 'active', provider: 'codex', project_scope: scopeOf(f, 'session-a') },
      'session-b': { status: 'active', provider: 'codex', project_scope: scopeOf(f, 'session-b') },
    });
    const ambiguous = runContext(f, ['switch', 'wk/ambigua', '--create']);
    assert.equal(ambiguous.status, 2, ambiguous.stderr);
    assert.match(ambiguous.stderr, /WENDKEEP_CONTEXT_AMBIGUOUS|--session/);
    assert.equal(git(f.project, ['branch', '--show-current']), 'main');
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-3] scope divergente e contexto concorrente falham sem publicar destino', () => {
  const f = fixture();
  try {
    seed(f, {
      'session-a': { status: 'active', provider: 'codex', project_scope: scopeOf(f, 'session-a', 'outra') },
    });
    const mismatch = runContext(f, ['switch', 'wk/bloqueada', '--create', '--session', 'session-a']);
    assert.equal(mismatch.status, 2, mismatch.stderr);
    assert.match(mismatch.stderr, /WENDKEEP_CONTEXT_SCOPE_MISMATCH/);
    assert.equal(git(f.project, ['branch', '--show-current']), 'main');

    git(f.project, ['branch', 'wk/ocupada']);
    seed(f, {
      'session-a': { status: 'active', provider: 'codex', project_scope: scopeOf(f, 'session-a') },
      'session-b': { status: 'active', provider: 'codex', project_scope: scopeOf(f, 'session-b', 'wk/ocupada') },
    });
    const conflict = runContext(f, ['switch', 'wk/ocupada', '--session', 'session-a']);
    assert.equal(conflict.status, 2, conflict.stderr);
    assert.match(conflict.stderr, /WENDKEEP_CONTEXT_CONFLICT/);
    assert.equal(git(f.project, ['branch', '--show-current']), 'main');
    assert.equal(readSessionRegistry(f.vault).sessions['session-a'].project_scope.branch, 'main');
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-2] falha de persistência restaura branch e mantém registry intacto', () => {
  const f = fixture();
  try {
    const sessionId = 'session-a';
    seed(f, {
      [sessionId]: { status: 'active', provider: 'codex', project_scope: scopeOf(f, sessionId) },
    });
    const before = readFileSync(join(f.vault, '.brain', 'SESSION_REGISTRY.json'), 'utf8');

    assert.throws(() => switchSessionContext({
      vaultBase: f.vault,
      projectRoot: f.project,
      branch: 'wk/falha',
      create: true,
      sessionId,
      mutateRegistry(_vault, mutator) {
        const registry = readSessionRegistry(f.vault);
        mutator(registry);
        throw new Error('persistência simulada');
      },
    }), /persistência simulada/);

    assert.equal(git(f.project, ['branch', '--show-current']), 'main');
    assert.equal(git(f.project, ['branch', '--list', 'wk/falha']), '');
    assert.equal(readFileSync(join(f.vault, '.brain', 'SESSION_REGISTRY.json'), 'utf8'), before);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-2] revisão concorrente falha por CAS antes do switch', () => {
  const f = fixture();
  try {
    const sessionId = 'session-a';
    seed(f, {
      [sessionId]: {
        status: 'active', provider: 'codex', project_scope: scopeOf(f, sessionId), context_revision: 2,
      },
    });

    assert.throws(() => switchSessionContext({
      vaultBase: f.vault,
      projectRoot: f.project,
      branch: 'wk/cas',
      create: true,
      sessionId,
      mutateRegistry(_vault, mutator) {
        const registry = readSessionRegistry(f.vault);
        registry.sessions[sessionId].context_revision = 3;
        return mutator(registry);
      },
    }), (error) => error?.code === 'WENDKEEP_CONTEXT_CAS_MISMATCH');
    assert.equal(git(f.project, ['branch', '--show-current']), 'main');
    assert.equal(git(f.project, ['branch', '--list', 'wk/cas']), '');
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});
