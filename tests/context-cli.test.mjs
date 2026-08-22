import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bindProjectVault } from '../src/project-vault.mjs';
import { readSessionRegistry, writeSessionRegistry } from '../hooks/obsidian-common.mjs';
import { captureProjectScope, scopeDecision, scopeForRegistry } from '../hooks/project-scope.mjs';
import { inspectSessionContext, recoverSessionContext, switchSessionContext } from '../src/context.mjs';

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
  return spawnSync(process.execPath, [
    BIN, 'context', ...args, '--project', f.project, '--vault', f.vault, '--json',
  ], {
    cwd: f.project,
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('[req:ACTX-5] status inventories conflicted scopes without exposing local paths', () => {
  const f = fixture();
  try {
    const sessionId = 'session-recovery-status';
    const observed = scopeOf(f, sessionId);
    const reserved = { ...observed, branch: 'wk/reserved-status' };
    seed(f, {
      [sessionId]: {
        status: 'active', provider: 'codex', context_revision: 7,
        project_scope: reserved,
        project_scope_conflict: true,
        project_scope_conflict_fields: ['scope.branch'],
        project_scope_observed: observed,
      },
    });

    const result = runContext(f, ['status', '--session', sessionId]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.session_id, sessionId);
    assert.equal(payload.revision, 7);
    assert.equal(payload.conflict, true);
    assert.deepEqual(payload.conflict_fields, ['scope.branch']);
    assert.deepEqual(payload.candidates.map((candidate) => [candidate.id, candidate.matches_actual]), [
      ['reserved', false],
      ['observed', true],
    ]);
    assert.deepEqual(Object.keys(payload.candidates[0]).sort(), [
      'branch', 'complete', 'head', 'id', 'matches_actual',
    ]);
    assert.doesNotMatch(result.stdout, new RegExp(f.parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-5] status fails closed for missing, inactive, malformed, or adversarial session state', () => {
  const f = fixture();
  try {
    const sessionId = 'session-recovery-invalid-status';
    const actual = scopeOf(f, sessionId);
    const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    const cases = [
      { sessions: {}, match: /WENDKEEP_CONTEXT_SESSION/ },
      { sessions: { [sessionId]: { status: 'done', project_scope: actual } }, match: /WENDKEEP_CONTEXT_SESSION/ },
      {
        sessions: {
          [sessionId]: {
            status: 'active', project_scope: { ...actual, complete: false },
            project_scope_conflict: true, project_scope_observed: actual,
          },
        },
        match: /WENDKEEP_CONTEXT_SCOPE_CONFLICT/,
      },
      {
        sessions: {
          [sessionId]: {
            status: 'active', project_scope: actual, project_scope_conflict: true,
            project_scope_conflict_fields: ['scope.branch', f.parent],
            project_scope_observed: { ...actual, branch: f.parent },
          },
        },
        match: /WENDKEEP_CONTEXT_SCOPE_CONFLICT/,
      },
    ];
    for (const item of cases) {
      seed(f, item.sessions);
      const before = readFileSync(registryPath, 'utf8');
      const result = runContext(f, ['status', '--session', sessionId]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, item.match);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(f.parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      assert.equal(readFileSync(registryPath, 'utf8'), before);
    }
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-6] [req:ACTX-7] recover selects the matching candidate with CAS and an audit receipt', () => {
  for (const selected of ['observed', 'reserved']) {
    const f = fixture();
    try {
      const sessionId = `session-recovery-${selected}`;
      const actual = scopeOf(f, sessionId);
      const alternate = { ...actual, branch: `wk/${selected}-alternate` };
      const reserved = selected === 'reserved' ? actual : alternate;
      const observed = selected === 'observed' ? actual : alternate;
      if (selected === 'observed') delete observed.authorizedActions;
      seed(f, {
        [sessionId]: {
          status: 'active', provider: 'codex', change_slug: 'active-context-conflict-recovery',
          authorized_actions: ['git:push'], context_revision: 11,
          project_scope: reserved,
          project_scope_conflict: true,
          project_scope_conflict_fields: ['scope.branch'],
          project_scope_observed: observed,
        },
      });

      const result = runContext(f, [
        'recover', '--session', sessionId, '--select', selected,
        '--revision', '11', '--reason', `operator selected ${selected}`,
      ]);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.deepEqual(
        [payload.status, payload.session_id, payload.selected, payload.revision],
        ['recovered', sessionId, selected, 12],
      );
      assert.deepEqual(payload.receipt.from, {
        reserved: { branch: reserved.branch, head: reserved.head },
        observed: { branch: observed.branch, head: observed.head },
      });
      assert.deepEqual(payload.receipt.to, { branch: actual.branch, head: actual.head });
      assert.deepEqual(payload.receipt.actor, { provider: 'codex', session_id: sessionId });
      assert.equal(payload.receipt.reason, `operator selected ${selected}`);
      assert.match(payload.receipt.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.doesNotMatch(result.stdout, new RegExp(f.parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

      const entry = readSessionRegistry(f.vault).sessions[sessionId];
      assert.equal(entry.project_scope.branch, actual.branch);
      assert.equal(entry.project_scope.head, actual.head);
      assert.equal(entry.project_scope.authorizedActions[0], 'git:commit');
      assert.equal(entry.change_slug, 'active-context-conflict-recovery');
      assert.deepEqual(entry.authorized_actions, ['git:push']);
      assert.equal(entry.context_revision, 12);
      assert.equal(entry.project_scope_conflict, undefined);
      assert.equal(entry.project_scope_conflict_fields, undefined);
      assert.equal(entry.project_scope_observed, undefined);
      assert.equal(entry.context_recoveries.length, 1);
      assert.deepEqual(entry.context_recoveries[0], payload.receipt);

      assert.equal(scopeDecision({
        command: 'git commit -m recovered',
        expectedScope: entry.project_scope,
        actualScope: scopeOf(f, sessionId),
        host: 'codex',
        currentSessionId: sessionId,
      }), null);
    } finally { rmSync(f.parent, { recursive: true, force: true }); }
  }
});

test('[req:ACTX-6] recover rejects incomplete arguments without touching the registry', () => {
  const f = fixture();
  try {
    const sessionId = 'session-recovery-args';
    const actual = scopeOf(f, sessionId);
    seed(f, {
      [sessionId]: {
        status: 'active', provider: 'codex', context_revision: 3,
        project_scope: actual, project_scope_conflict: true,
        project_scope_conflict_fields: ['scope.branch'],
        project_scope_observed: { ...actual, branch: 'wk/observed' },
      },
    });
    const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    const before = readFileSync(registryPath, 'utf8');
    const cases = [
      ['recover', '--session', sessionId, '--revision', '3', '--reason', 'missing selection'],
      ['recover', '--session', sessionId, '--select', 'reserved', '--reason', 'missing revision'],
      ['recover', '--session', sessionId, '--select', 'reserved', '--revision', '3'],
      ['recover', '--session', sessionId, '--select', 'automatic', '--revision', '3', '--reason', 'invalid'],
    ];
    for (const args of cases) {
      const result = runContext(f, args);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /WENDKEEP_CONTEXT_ARGS/);
      assert.equal(readFileSync(registryPath, 'utf8'), before);
    }
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-6] every stale or divergent causal field keeps quarantine byte-identical', () => {
  const cases = [
    { id: 'revision', select: 'reserved', revision: '7', code: /WENDKEEP_CONTEXT_CAS_MISMATCH/ },
    { id: 'project-id', field: 'projectId', value: 'different-project', code: /WENDKEEP_CONTEXT_IDENTITY_CHANGED/ },
    { id: 'project-root', field: 'projectRoot', value: 'wrong-project-root', path: true, code: /WENDKEEP_CONTEXT_SCOPE_MISMATCH/ },
    { id: 'repo-root', field: 'repoRoot', value: 'wrong-repo-root', path: true, code: /WENDKEEP_CONTEXT_SCOPE_MISMATCH/ },
    { id: 'remote', field: 'remote', value: 'https://example.com/acme/other.git', code: /WENDKEEP_CONTEXT_IDENTITY_CHANGED/ },
    { id: 'worktree', field: 'worktree', value: 'wrong-worktree', path: true, code: /WENDKEEP_CONTEXT_SCOPE_MISMATCH/ },
    { id: 'branch', field: 'branch', value: 'wk/other-branch', code: /WENDKEEP_CONTEXT_SCOPE_MISMATCH/ },
    { id: 'head', field: 'head', value: '0'.repeat(40), code: /WENDKEEP_CONTEXT_SCOPE_MISMATCH/ },
    { id: 'provider', field: 'provider', value: 'claude', code: /WENDKEEP_CONTEXT_IDENTITY_CHANGED/ },
    { id: 'session-id', field: 'sessionId', value: 'other-session', code: /WENDKEEP_CONTEXT_IDENTITY_CHANGED/ },
  ];
  for (const failure of cases) {
    const f = fixture();
    try {
      const sessionId = `session-recovery-${failure.id}`;
      const actual = scopeOf(f, sessionId);
      const observed = failure.field
        ? { ...actual, [failure.field]: failure.path ? join(f.parent, failure.value) : failure.value }
        : actual;
      seed(f, {
        [sessionId]: {
          status: 'active', provider: 'codex', context_revision: 8,
          project_scope: actual, project_scope_conflict: true,
          project_scope_conflict_fields: ['scope.branch'],
          project_scope_observed: observed,
        },
      });
      const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
      const before = readFileSync(registryPath, 'utf8');
      const result = runContext(f, [
        'recover', '--session', sessionId,
        '--select', failure.select || 'observed',
        '--revision', failure.revision || '8',
        '--reason', `reject ${failure.id}`,
      ]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, failure.code);
      assert.equal(readFileSync(registryPath, 'utf8'), before);
      assert.equal(readSessionRegistry(f.vault).sessions[sessionId].project_scope_conflict, true);
    } finally { rmSync(f.parent, { recursive: true, force: true }); }
  }
});

test('[req:ACTX-6] recovery rechecks the inventoried revision inside the registry mutation', () => {
  const f = fixture();
  try {
    const sessionId = 'session-recovery-race';
    const actual = scopeOf(f, sessionId);
    seed(f, {
      [sessionId]: {
        status: 'active', provider: 'codex', context_revision: 13,
        project_scope: actual, project_scope_conflict: true,
        project_scope_conflict_fields: ['scope.branch'],
        project_scope_observed: { ...actual, branch: 'wk/old-observed' },
      },
    });
    const inventory = inspectSessionContext({
      vaultBase: f.vault, projectRoot: f.project, sessionId,
    });
    const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    const before = readFileSync(registryPath, 'utf8');

    assert.throws(() => recoverSessionContext({
      vaultBase: f.vault,
      projectRoot: f.project,
      sessionId,
      select: 'reserved',
      revision: inventory.revision,
      reason: 'race after inventory',
      mutateRegistry(_vault, mutator) {
        const registry = readSessionRegistry(f.vault);
        registry.sessions[sessionId].context_revision += 1;
        return mutator(registry);
      },
    }), (error) => error?.code === 'WENDKEEP_CONTEXT_CAS_MISMATCH');
    assert.equal(readFileSync(registryPath, 'utf8'), before);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-7] recovery sanitizes and bounds the receipt reason', () => {
  const f = fixture();
  try {
    const sessionId = 'session-recovery-sanitized-reason';
    const actual = scopeOf(f, sessionId);
    seed(f, {
      [sessionId]: {
        status: 'active', provider: 'codex', context_revision: 2,
        project_scope: actual, project_scope_conflict: true,
        project_scope_conflict_fields: ['scope.branch'],
        project_scope_observed: { ...actual, branch: 'wk/old-observed' },
      },
    });
    const secret = 'TOKEN=top-secret-value';
    const reason = `confirmed ${secret} at ${join(f.parent, 'transcript.jsonl')}`;
    const result = runContext(f, [
      'recover', '--session', sessionId, '--select', 'reserved', '--revision', '2', '--reason', reason,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.receipt.reason, /\[REDACTED_SECRET\]/);
    assert.match(payload.receipt.reason, /\[REDACTED_LOCAL_PATH\]/);
    assert.doesNotMatch(result.stdout, /top-secret-value/);
    assert.doesNotMatch(result.stdout, new RegExp(f.parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

    seed(f, {
      [sessionId]: {
        status: 'active', provider: 'codex', context_revision: 3,
        project_scope: actual, project_scope_conflict: true,
        project_scope_conflict_fields: ['scope.branch'],
        project_scope_observed: { ...actual, branch: 'wk/old-observed' },
      },
    });
    const before = readFileSync(join(f.vault, '.brain', 'SESSION_REGISTRY.json'), 'utf8');
    const tooLong = runContext(f, [
      'recover', '--session', sessionId, '--select', 'reserved', '--revision', '3', '--reason', 'x'.repeat(241),
    ]);
    assert.equal(tooLong.status, 2);
    assert.match(tooLong.stderr, /WENDKEEP_CONTEXT_ARGS/);
    assert.equal(readFileSync(join(f.vault, '.brain', 'SESSION_REGISTRY.json'), 'utf8'), before);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('[req:ACTX-7] recovery persistence failure keeps quarantine and prior receipts byte-identical', () => {
  const f = fixture();
  try {
    const sessionId = 'session-recovery-persistence';
    const actual = scopeOf(f, sessionId);
    const priorReceipt = { revision: 4, operation: 'recover', selected: 'reserved', reason: 'prior' };
    seed(f, {
      [sessionId]: {
        status: 'active', provider: 'codex', change_slug: 'kept', context_revision: 5,
        project_scope: actual, project_scope_conflict: true,
        project_scope_conflict_fields: ['scope.branch'],
        project_scope_observed: { ...actual, branch: 'wk/old-observed' },
        context_recoveries: [priorReceipt],
      },
    });
    const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    const before = readFileSync(registryPath, 'utf8');

    assert.throws(() => recoverSessionContext({
      vaultBase: f.vault,
      projectRoot: f.project,
      sessionId,
      select: 'reserved',
      revision: 5,
      reason: 'simulated persistence failure',
      mutateRegistry(_vault, mutator) {
        const registry = readSessionRegistry(f.vault);
        const result = mutator(registry);
        assert.equal(result.receipt.revision, 6);
        assert.deepEqual(registry.sessions[sessionId].context_recoveries[0], priorReceipt);
        throw new Error('persistência simulada');
      },
    }), /persistência simulada/);

    assert.equal(readFileSync(registryPath, 'utf8'), before);
    const entry = readSessionRegistry(f.vault).sessions[sessionId];
    assert.equal(entry.project_scope_conflict, true);
    assert.deepEqual(entry.context_recoveries, [priorReceipt]);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

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
