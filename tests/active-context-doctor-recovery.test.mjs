import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  diagnoseActiveContexts,
  repairActiveContext,
} from '../src/active-context-health.mjs';
import {
  projectLegacyActiveChange,
  projectLegacyActiveDelivery,
} from '../hooks/active-context-store.mjs';
import { readSessionRegistry, writeSessionRegistry } from '../hooks/obsidian-common.mjs';
import {
  discoverWorktreeRepository,
  ensureWorktreeMetadata,
} from '../packages/vault/src/worktree-metadata.mjs';

const CLI = join(process.cwd(), 'bin', 'wendkeep.mjs');

const PROJECT = 'project-doctor';
const REPOSITORY = 'repository-doctor';
const TREE = 'worktree-doctor';
const WORK = 'work-session-doctor';
const KEY = `${REPOSITORY}:${TREE}:${WORK}`;

function activeContext(overrides = {}) {
  return {
    project_id: PROJECT,
    repository_id: REPOSITORY,
    worktree_id: TREE,
    work_session_id: WORK,
    branch: 'wk/doctor',
    head_sha: 'a'.repeat(40),
    change_slug: 'doctor-change',
    delivery_id: 'doctor-delivery',
    state: 'active',
    revision: 4,
    updated_at: '2026-08-22T12:00:00.000Z',
    ...overrides,
  };
}

function activeSession(overrides = {}) {
  return {
    status: 'active',
    work_session_id: WORK,
    last_stop_turn_sequence: 2,
    project_scope: { complete: true, projectId: PROJECT },
    ...overrides,
  };
}

function registry({ context = activeContext(), sessions = { owner: activeSession() } } = {}) {
  return {
    version: 1,
    active_contexts_schema: 1,
    active_contexts_revision: 9,
    active_contexts: { [KEY]: context },
    sessions,
  };
}

function topology(overrides = {}) {
  return {
    proven: true,
    projectId: PROJECT,
    repositoryId: REPOSITORY,
    worktreeIds: [TREE],
    ...overrides,
  };
}

function codes(result) {
  return result.issues.map((issue) => issue.code).sort();
}

test('[req:ACTX-26] healthy active context has an active owner and a proven live worktree', () => {
  const result = diagnoseActiveContexts({ registry: registry(), topology: topology() });
  assert.equal(result.initialized, true);
  assert.equal(result.contexts, 1);
  assert.deepEqual(result.issues, []);
});

test('[req:ACTX-26] doctor classifies orphan owner and removed worktree independently', () => {
  const result = diagnoseActiveContexts({
    registry: registry({ sessions: {} }),
    topology: topology({ worktreeIds: [] }),
  });
  assert.deepEqual(codes(result), [
    'WENDKEEP_ACTIVE_CONTEXT_SESSION_ORPHAN',
    'WENDKEEP_ACTIVE_CONTEXT_WORKTREE_REMOVED',
  ]);
  for (const issue of result.issues) {
    assert.equal(issue.key, KEY);
    assert.equal(issue.revision, 4);
    assert.equal(issue.repairable, true);
  }
});

test('[req:ACTX-26] unproven topology never becomes a removed-worktree diagnosis', () => {
  const result = diagnoseActiveContexts({
    registry: registry(),
    topology: { proven: false, errorCode: 'WENDKEEP_WORKTREE_GIT_FAILED' },
  });
  assert.deepEqual(codes(result), ['WENDKEEP_ACTIVE_CONTEXT_TOPOLOGY_UNPROVEN']);
  assert.equal(result.issues[0].repairable, false);
});

test('[req:ACTX-27] request-stop lease expires only after its owner turn stopped', () => {
  const lease = {
    lease_id: 'lease-a',
    state: 'active',
    profile: 'GOVERN',
    session_id: 'owner',
    request_turn_id: 'turn-7',
    request_turn_sequence: 7,
    expires_on: 'request-stop',
  };
  const stopped = diagnoseActiveContexts({
    registry: registry({
      context: activeContext({ operating_profile_task: lease }),
      sessions: { owner: activeSession({ last_stop_turn_id: 'turn-7', last_stop_turn_sequence: 7 }) },
    }),
    topology: topology(),
  });
  assert.deepEqual(codes(stopped), ['WENDKEEP_ACTIVE_CONTEXT_LEASE_EXPIRED']);

  const pending = diagnoseActiveContexts({
    registry: registry({
      context: activeContext({ operating_profile_task: lease }),
      sessions: { owner: activeSession({ last_stop_turn_id: 'turn-6', last_stop_turn_sequence: 6 }) },
    }),
    topology: topology(),
  });
  assert.deepEqual(pending.issues, []);
});

test('[req:ACTX-27] active request-stop lease owned by an inactive session is expired', () => {
  const result = diagnoseActiveContexts({
    registry: registry({
      context: activeContext({
        operating_profile_task: {
          lease_id: 'lease-inactive', state: 'active', session_id: 'owner',
          request_turn_sequence: 8, expires_on: 'request-stop',
        },
      }),
      sessions: { owner: activeSession({ status: 'done', last_stop_turn_sequence: 3 }) },
    }),
    topology: topology(),
  });
  assert.deepEqual(codes(result), [
    'WENDKEEP_ACTIVE_CONTEXT_LEASE_EXPIRED',
    'WENDKEEP_ACTIVE_CONTEXT_SESSION_ORPHAN',
  ]);
});

function fixture(value) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-active-context-doctor-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  writeSessionRegistry(vault, value);
  return { vault, cleanup: () => rmSync(vault, { recursive: true, force: true }) };
}

test('[req:ACTX-28] explicit repair expires a stale lease without closing a healthy context', () => {
  const lease = {
    lease_id: 'lease-stopped', state: 'active', session_id: 'owner',
    request_turn_id: 'turn-7', request_turn_sequence: 7, expires_on: 'request-stop',
  };
  const f = fixture(registry({
    context: activeContext({ operating_profile_task: lease }),
    sessions: {
      owner: activeSession({ last_stop_turn_id: 'turn-7', last_stop_turn_sequence: 7 }),
      actor: activeSession({ work_session_id: 'actor-work' }),
    },
  }));
  try {
    const result = repairActiveContext({
      vaultBase: f.vault,
      projectRoot: f.vault,
      key: KEY,
      revision: 4,
      reason: 'Stop já reconheceu o turno',
      actorSessionId: 'actor',
      topologyProvider: () => topology(),
      now: () => new Date('2026-08-22T12:30:00.000Z'),
    });
    assert.equal(result.effect, 'lease-expired');
    const updated = readSessionRegistry(f.vault);
    assert.equal(updated.active_contexts[KEY].state, 'active');
    assert.equal(updated.active_contexts[KEY].operating_profile_task.state, 'expired');
    assert.equal(updated.active_contexts[KEY].operating_profile_task.expired_at, '2026-08-22T12:30:00.000Z');
    assert.equal(updated.active_context_repairs.at(-1).actor.session_id, 'actor');
  } finally { f.cleanup(); }
});

test('[req:ACTX-28] [req:ACTX-29] repair closes a removed context, preserves history, appends receipt, and reprojects after commit', () => {
  const previousReceipt = {
    operation: 'repair',
    key: 'older:key:receipt',
    from_revision: 1,
    to_revision: 2,
    reason: 'historical receipt',
  };
  const historicalContext = activeContext({
    notes: ['nota histórica'],
    handoff: { event_id: 'handoff-historical', summary: 'preservar' },
    identity_history: [{ branch: 'main', head_sha: 'b'.repeat(40) }],
  });
  const f = fixture(registry({
    context: historicalContext,
    sessions: { actor: activeSession({ work_session_id: 'actor-work', provider: 'codex' }) },
  }));
  const ledger = join(f.vault, '.brain', 'MEMORY_EVENTS.jsonl');
  const evidence = join(f.vault, '.brain', 'EVIDENCE_INDEX.jsonl');
  const currentChange = join(f.vault, '.brain', 'CURRENT_CHANGE.md');
  const currentDelivery = join(f.vault, '.brain', 'runtime', 'CURRENT_DELIVERY');
  const seeded = readSessionRegistry(f.vault);
  seeded.active_context_repairs = [previousReceipt];
  writeSessionRegistry(f.vault, seeded);
  writeFileSync(ledger, '{"historical":true}\n');
  writeFileSync(evidence, '{"chunk":"historical"}\n');
  mkdirSync(join(f.vault, '.brain', 'runtime'), { recursive: true });
  writeFileSync(currentChange, 'change: stale-change\n');
  writeFileSync(currentDelivery, 'stale-delivery\n');
  try {
    const beforeLedger = readFileSync(ledger, 'utf8');
    const beforeEvidence = readFileSync(evidence, 'utf8');
    const projectionOrder = [];
    const result = repairActiveContext({
      vaultBase: f.vault,
      projectRoot: f.vault,
      key: KEY,
      revision: 4,
      reason: '  worktree removida\n após merge  ',
      actorSessionId: 'actor',
      topologyProvider: () => topology({ worktreeIds: [] }),
      projectChange: (vaultBase) => {
        const persisted = readSessionRegistry(vaultBase);
        assert.equal(persisted.active_contexts[KEY].state, 'closed');
        assert.equal(persisted.active_context_repairs.length, 2);
        projectionOrder.push('change-after-commit');
        return projectLegacyActiveChange(vaultBase, persisted);
      },
      projectDelivery: (vaultBase) => {
        const persisted = readSessionRegistry(vaultBase);
        assert.equal(persisted.active_contexts[KEY].state, 'closed');
        assert.equal(persisted.active_context_repairs.length, 2);
        projectionOrder.push('delivery-after-commit');
        return projectLegacyActiveDelivery(vaultBase, persisted);
      },
      now: () => new Date('2026-08-22T12:31:00.000Z'),
    });
    assert.equal(result.effect, 'context-closed');
    const updated = readSessionRegistry(f.vault);
    const repaired = updated.active_contexts[KEY];
    assert.equal(updated.active_contexts_revision, 10);
    assert.equal(repaired.revision, 5);
    assert.equal(repaired.state, 'closed');
    assert.equal(repaired.closed_at, '2026-08-22T12:31:00.000Z');
    for (const field of [
      'project_id', 'repository_id', 'worktree_id', 'work_session_id',
      'branch', 'head_sha', 'change_slug', 'delivery_id',
    ]) assert.equal(repaired[field], historicalContext[field], field);
    assert.deepEqual(repaired.notes, historicalContext.notes);
    assert.deepEqual(repaired.handoff, historicalContext.handoff);
    assert.deepEqual(repaired.identity_history, historicalContext.identity_history);
    assert.equal(updated.active_context_repairs.length, 2);
    assert.deepEqual(updated.active_context_repairs[0], previousReceipt);
    assert.deepEqual(updated.active_context_repairs[1], {
      operation: 'repair',
      key: KEY,
      from_revision: 4,
      to_revision: 5,
      diagnostics: [
        'WENDKEEP_ACTIVE_CONTEXT_SESSION_ORPHAN',
        'WENDKEEP_ACTIVE_CONTEXT_WORKTREE_REMOVED',
      ],
      effect: 'context-closed',
      actor: { session_id: 'actor', provider: 'codex' },
      reason: 'worktree removida após merge',
      at: '2026-08-22T12:31:00.000Z',
    });
    assert.deepEqual(projectionOrder, ['change-after-commit', 'delivery-after-commit']);
    assert.equal(readFileSync(currentChange, 'utf8'), 'change:\n');
    assert.equal(readFileSync(currentDelivery, 'utf8'), '');
    assert.equal(readFileSync(ledger, 'utf8'), beforeLedger);
    assert.equal(readFileSync(evidence, 'utf8'), beforeEvidence);
  } finally { f.cleanup(); }
});

test('[req:ACTX-28] stale CAS and healthy target fail without changing registry bytes', () => {
  const f = fixture(registry({
    sessions: {
      owner: activeSession(),
      actor: activeSession({ work_session_id: 'actor-work' }),
    },
  }));
  const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
  const currentChange = join(f.vault, '.brain', 'CURRENT_CHANGE.md');
  const currentDelivery = join(f.vault, '.brain', 'runtime', 'CURRENT_DELIVERY');
  mkdirSync(join(f.vault, '.brain', 'runtime'), { recursive: true });
  writeFileSync(currentChange, 'change: preserved\n');
  writeFileSync(currentDelivery, 'delivery-preserved\n');
  try {
    const paths = [registryPath, currentChange, currentDelivery];
    const before = paths.map((path) => readFileSync(path));
    let projectionCalls = 0;
    const noProjection = {
      projectChange: () => { projectionCalls += 1; },
      projectDelivery: () => { projectionCalls += 1; },
    };
    assert.throws(() => repairActiveContext({
      vaultBase: f.vault, projectRoot: f.vault, key: KEY, revision: 3,
      reason: 'stale', actorSessionId: 'actor', topologyProvider: () => topology(),
      ...noProjection,
    }), (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CAS_MISMATCH');
    assert.equal(projectionCalls, 0);
    paths.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));

    assert.throws(() => repairActiveContext({
      vaultBase: f.vault, projectRoot: f.vault, key: KEY, revision: 4,
      reason: 'healthy', actorSessionId: 'actor', topologyProvider: () => topology(),
      ...noProjection,
    }), (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_HEALTHY');
    assert.equal(projectionCalls, 0);
    paths.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
  } finally { f.cleanup(); }
});

test('[req:ACTX-28] actor from another project cannot repair the target', () => {
  const f = fixture(registry({
    sessions: {
      actor: activeSession({
        work_session_id: 'actor-work',
        project_scope: { complete: true, projectId: 'foreign-project' },
      }),
    },
  }));
  const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
  const currentChange = join(f.vault, '.brain', 'CURRENT_CHANGE.md');
  const currentDelivery = join(f.vault, '.brain', 'runtime', 'CURRENT_DELIVERY');
  mkdirSync(join(f.vault, '.brain', 'runtime'), { recursive: true });
  writeFileSync(currentChange, 'change: preserved\n');
  writeFileSync(currentDelivery, 'delivery-preserved\n');
  try {
    const paths = [registryPath, currentChange, currentDelivery];
    const before = paths.map((path) => readFileSync(path));
    let projectionCalls = 0;
    assert.throws(() => repairActiveContext({
      vaultBase: f.vault, projectRoot: f.vault, key: KEY, revision: 4,
      reason: 'foreign actor', actorSessionId: 'actor',
      topologyProvider: () => topology({ worktreeIds: [] }),
      projectChange: () => { projectionCalls += 1; },
      projectDelivery: () => { projectionCalls += 1; },
    }), (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_ACTOR_MISMATCH');
    assert.equal(projectionCalls, 0);
    paths.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
  } finally { f.cleanup(); }
});

test('[req:ACTX-28] unproven topology rejects repair with registry and projections byte-identical', () => {
  const f = fixture(registry({
    sessions: { actor: activeSession({ work_session_id: 'actor-work' }) },
  }));
  const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
  const currentChange = join(f.vault, '.brain', 'CURRENT_CHANGE.md');
  const currentDelivery = join(f.vault, '.brain', 'runtime', 'CURRENT_DELIVERY');
  mkdirSync(join(f.vault, '.brain', 'runtime'), { recursive: true });
  writeFileSync(currentChange, 'change: preserved\n');
  writeFileSync(currentDelivery, 'delivery-preserved\n');
  try {
    const before = [registryPath, currentChange, currentDelivery]
      .map((path) => readFileSync(path));
    let projectionCalls = 0;
    assert.throws(() => repairActiveContext({
      vaultBase: f.vault,
      projectRoot: f.vault,
      key: KEY,
      revision: 4,
      reason: 'não inventar topologia',
      actorSessionId: 'actor',
      topologyProvider: () => ({ proven: false, errorCode: 'WENDKEEP_WORKTREE_GIT_FAILED' }),
      projectChange: () => { projectionCalls += 1; },
      projectDelivery: () => { projectionCalls += 1; },
    }), (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_TOPOLOGY_UNPROVEN');
    assert.equal(projectionCalls, 0);
    [registryPath, currentChange, currentDelivery].forEach((path, index) => {
      assert.deepEqual(readFileSync(path), before[index]);
    });
  } finally { f.cleanup(); }
});

test('[req:ACTX-28] repair requires exact key, revision, reason, and an active actor without writing', () => {
  const f = fixture(registry({
    sessions: {
      actor: activeSession({ work_session_id: 'actor-work' }),
    },
  }));
  const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
  try {
    const before = readFileSync(registryPath);
    const base = {
      vaultBase: f.vault,
      projectRoot: f.vault,
      key: KEY,
      revision: 4,
      reason: 'reparo explícito',
      actorSessionId: 'actor',
      topologyProvider: () => topology({ worktreeIds: [] }),
    };
    const cases = [
      [{ ...base, key: '' }, 'WENDKEEP_CONTEXT_ARGS'],
      [{ ...base, key: `${REPOSITORY}:${TREE}:wrong-work-session` }, 'WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND'],
      [{ ...base, revision: undefined }, 'WENDKEEP_CONTEXT_ARGS'],
      [{ ...base, reason: ' \n\t ' }, 'WENDKEEP_CONTEXT_ARGS'],
      [{ ...base, actorSessionId: '' }, 'WENDKEEP_CONTEXT_SESSION'],
    ];
    for (const [options, code] of cases) {
      assert.throws(() => repairActiveContext(options), (error) => error?.code === code, code);
      assert.deepEqual(readFileSync(registryPath), before, code);
    }
    const inactive = readSessionRegistry(f.vault);
    inactive.sessions.actor.status = 'stopped';
    writeSessionRegistry(f.vault, inactive);
    const beforeInactiveActor = readFileSync(registryPath);
    assert.throws(
      () => repairActiveContext(base),
      (error) => error?.code === 'WENDKEEP_CONTEXT_SESSION',
    );
    assert.deepEqual(readFileSync(registryPath), beforeInactiveActor);
  } finally { f.cleanup(); }
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

function cliFixture() {
  const parent = mkdtempSync(join(tmpdir(), 'wk-active-context-doctor-cli-'));
  const project = join(parent, 'project');
  const vault = join(project, '.fixture-vault');
  mkdirSync(project, { recursive: true });
  mkdirSync(vault, { recursive: true });
  git(project, ['init']);
  git(project, ['config', 'user.email', 'doctor@example.invalid']);
  git(project, ['config', 'user.name', 'Active Context Doctor']);
  git(project, ['remote', 'add', 'origin', 'https://example.com/acme/doctor.git']);
  writeFileSync(join(project, 'seed.txt'), 'seed\n');
  git(project, ['add', 'seed.txt']);
  git(project, ['commit', '-m', 'seed']);
  git(project, ['branch', '-M', 'main']);
  const projectId = 'project-doctor-cli';
  writeFileSync(join(project, '.wendkeep.json'), `${JSON.stringify({
    schemaVersion: 1, projectId, vault: '.fixture-vault',
  }, null, 2)}\n`);
  const repository = discoverWorktreeRepository({ startDir: project });
  const metadata = ensureWorktreeMetadata({ repository, projectId, vaultPath: vault });
  const context = activeContext({
    project_id: projectId,
    repository_id: metadata.repositoryId,
    worktree_id: 'removed-worktree-id',
    work_session_id: 'removed-work-session',
    revision: 2,
  });
  const key = `${context.repository_id}:${context.worktree_id}:${context.work_session_id}`;
  writeSessionRegistry(vault, {
    version: 2,
    active_contexts_schema: 1,
    active_contexts_revision: 3,
    active_contexts: { [key]: context },
    sessions: { actor: activeSession({
      work_session_id: 'actor-cli',
      provider: 'codex',
      project_scope: { complete: true, projectId },
    }) },
  });
  return { parent, project, vault, key, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

function runContextRepair(f, revision) {
  return spawnSync(process.execPath, [CLI, 'context', 'repair',
    '--key', f.key,
    '--revision', String(revision),
    '--reason', 'worktree removida depois do merge',
    '--session', 'actor',
    '--project', f.project,
    '--vault', f.vault,
    '--json',
  ], { cwd: f.project, encoding: 'utf8', windowsHide: true });
}

test('[req:ACTX-28] [req:ACTX-29] executable context repair closes removed context with receipt', () => {
  const f = cliFixture();
  try {
    const result = runContextRepair(f, 2);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'repaired');
    assert.equal(payload.effect, 'context-closed');
    const updated = readSessionRegistry(f.vault);
    assert.equal(updated.active_contexts[f.key].state, 'closed');
    assert.equal(updated.active_context_repairs.at(-1).key, f.key);
  } finally { f.cleanup(); }
});

test('[req:ACTX-28] executable context repair rejects stale revision byte-identically', () => {
  const f = cliFixture();
  const path = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
  try {
    const before = readFileSync(path, 'utf8');
    const result = runContextRepair(f, 1);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /WENDKEEP_ACTIVE_CONTEXT_CAS_MISMATCH/);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally { f.cleanup(); }
});

test('[req:ACTX-26] executable doctor reports active-context debt without mutating registry', () => {
  const f = cliFixture();
  const paths = [
    join(f.vault, '.brain', 'SESSION_REGISTRY.json'),
    join(f.vault, '.brain', 'MEMORY_EVENTS.jsonl'),
    join(f.vault, '.brain', 'EVIDENCE_INDEX.jsonl'),
    join(f.vault, '.brain', 'CURRENT_CHANGE.md'),
    join(f.vault, '.brain', 'runtime', 'CURRENT_DELIVERY'),
  ];
  mkdirSync(join(f.vault, '.brain', 'runtime'), { recursive: true });
  writeFileSync(paths[1], '{"historical":true}\n');
  writeFileSync(paths[2], '{"evidence":true}\n');
  writeFileSync(paths[3], 'change: historical\n');
  writeFileSync(paths[4], 'delivery-historical\n');
  try {
    const before = paths.map((path) => readFileSync(path));
    const result = spawnSync(process.execPath, [CLI, 'doctor',
      '--scope', 'runtime', '--project', f.project, '--vault', f.vault,
    ], { cwd: f.project, encoding: 'utf8', windowsHide: true });
    assert.match(result.stdout, /\[active-contexts\]/);
    assert.match(result.stdout, /WENDKEEP_ACTIVE_CONTEXT_SESSION_ORPHAN/);
    assert.match(result.stdout, /WENDKEEP_ACTIVE_CONTEXT_WORKTREE_REMOVED/);
    assert.match(result.stdout, /context repair --key/);
    paths.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
  } finally { f.cleanup(); }
});
