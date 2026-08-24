import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readSessionRegistry,
  upsertSessionRegistry,
  writeSessionRegistry,
} from '../hooks/obsidian-common.mjs';
import {
  activeContextKey,
  clearActiveContextChange,
  markActiveContextCleanupTerminal,
  migrateLegacyActiveContext,
  mutateActiveContext,
  projectLegacyActiveChange,
  releaseActiveContextCleanup,
  reserveActiveContextCleanup,
  resolveActiveContext,
  setActiveContextChange,
} from '../hooks/active-context-store.mjs';
import {
  activeChange,
  clearActiveChange,
  setActiveChange,
} from '../hooks/change-core.mjs';

function fixture() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-active-context-store-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  writeSessionRegistry(vault, { version: 2, sessions: {} });
  return { vault, registryPath: join(vault, '.brain', 'SESSION_REGISTRY.json') };
}

function identity(worktreeId, workSessionId, overrides = {}) {
  return {
    projectId: 'project-1',
    repositoryId: 'repository-1',
    worktreeId,
    workSessionId,
    branch: `wk/${worktreeId}`,
    headSha: 'a'.repeat(40),
    ...overrides,
  };
}

test('[req:ACTX-9] two worktrees retain independent active changes under one atomic registry', () => {
  const f = fixture();
  try {
    const first = setActiveContextChange(f.vault, identity('worktree-a', 'work-a'), 'auth-refactor', {
      now: '2026-08-22T04:00:00.000Z',
    });
    const second = setActiveContextChange(f.vault, identity('worktree-b', 'work-b'), 'observer-security', {
      now: '2026-08-22T04:01:00.000Z',
    });

    assert.equal(first.context.revision, 1);
    assert.equal(second.context.revision, 1);
    assert.equal(resolveActiveContext(f.vault, identity('worktree-a', 'work-a')).change_slug, 'auth-refactor');
    assert.equal(resolveActiveContext(f.vault, identity('worktree-b', 'work-b')).change_slug, 'observer-security');

    const registry = readSessionRegistry(f.vault);
    assert.equal(registry.active_contexts_schema, 1);
    assert.equal(registry.active_contexts_revision, 2);
    assert.deepEqual(Object.keys(registry.active_contexts).sort(), [
      activeContextKey(identity('worktree-a', 'work-a')),
      activeContextKey(identity('worktree-b', 'work-b')),
    ].sort());
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:PROV-4] a cleanup reservation blocks foreign context creation under the registry lock', () => {
  const f = fixture();
  try {
    const target = identity('worktree-a', 'work-a');
    reserveActiveContextCleanup(f.vault, {
      operationId: 'cleanup-operation-1',
      projectId: target.projectId,
      repositoryId: target.repositoryId,
      worktreeId: target.worktreeId,
      workSessionId: target.workSessionId,
      changeSlug: 'change-a',
    });
    assert.throws(
      () => setActiveContextChange(f.vault, identity('worktree-a', 'work-late'), 'late-change'),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_RESERVED',
    );
    assert.equal(readSessionRegistry(f.vault).active_contexts, undefined);
    mutateActiveContext(f.vault, target, (current) => ({
      ...current, change_slug: 'change-a', state: 'active',
    }), { cleanupOperationId: 'cleanup-operation-1', projectLegacy: false });
    setActiveContextChange(f.vault, identity('worktree-b', 'work-b'), 'sibling-change');
    releaseActiveContextCleanup(f.vault, 'cleanup-operation-1');
    setActiveContextChange(f.vault, identity('worktree-a', 'work-late'), 'late-change');
    assert.equal(resolveActiveContext(f.vault, identity('worktree-a', 'work-late')).change_slug, 'late-change');
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:PROV-4] a cleanup reservation blocks active session activation for its worktree', () => {
  const f = fixture();
  try {
    const target = identity('worktree-a', 'work-a');
    const worktreePath = join(f.vault, 'worktree-a');
    reserveActiveContextCleanup(f.vault, {
      operationId: 'cleanup-operation-session',
      projectId: target.projectId,
      repositoryId: target.repositoryId,
      worktreeId: target.worktreeId,
      workSessionId: target.workSessionId,
      changeSlug: 'change-a',
      worktreePath,
    });

    assert.throws(
      () => upsertSessionRegistry(f.vault, 'session-late', {
        status: 'active',
        work_session_id: 'work-late',
        project_scope: { complete: true, repoRoot: worktreePath },
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_RESERVED',
    );
    assert.throws(
      () => writeSessionRegistry(f.vault, {
        ...readSessionRegistry(f.vault),
        sessions: {
          ...readSessionRegistry(f.vault).sessions,
          'session-raw-late': {
            status: 'active',
            work_session_id: 'work-raw-late',
            project_scope: { complete: true, repoRoot: worktreePath },
          },
        },
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_RESERVED',
    );
    assert.equal(readSessionRegistry(f.vault).sessions['session-late'], undefined);

    releaseActiveContextCleanup(f.vault, 'cleanup-operation-session');
    upsertSessionRegistry(f.vault, 'session-late', {
      status: 'active',
      work_session_id: 'work-late',
      project_scope: { complete: true, repoRoot: worktreePath },
    });
    assert.equal(readSessionRegistry(f.vault).sessions['session-late'].status, 'active');
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:PROV-4] cleanup reservation rejects a same-worktree context from another repository', () => {
  const f = fixture();
  try {
    const target = identity('worktree-collision', 'work-a');
    reserveActiveContextCleanup(f.vault, {
      operationId: 'cleanup-cross-repo',
      projectId: target.projectId,
      repositoryId: target.repositoryId,
      worktreeId: target.worktreeId,
      workSessionId: target.workSessionId,
      changeSlug: 'change-a',
    });
    assert.throws(
      () => setActiveContextChange(f.vault, identity(target.worktreeId, 'foreign-session', {
        repositoryId: 'repository-foreign',
      }), 'foreign-change'),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_RESERVED',
    );
    assert.equal(Object.keys(readSessionRegistry(f.vault).active_contexts || {}).length, 0);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:PROV-4] same-operation concurrent attempts use an attempt token and CAS release', () => {
  const f = fixture();
  try {
    const target = identity('worktree-attempt', 'work-a');
    const base = {
      projectId: target.projectId,
      repositoryId: target.repositoryId,
      worktreeId: target.worktreeId,
      workSessionId: target.workSessionId,
      changeSlug: 'change-a',
      ownerPid: process.pid,
      mode: 'finish',
      authority: 'acme/repo#72',
      slug: target.worktreeId,
    };
    reserveActiveContextCleanup(f.vault, {
      ...base, operationId: 'cleanup-attempt', attemptToken: 'attempt-a',
    });
    assert.throws(
      () => reserveActiveContextCleanup(f.vault, {
        ...base, operationId: 'cleanup-attempt', attemptToken: 'attempt-b',
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_BUSY',
    );
    assert.equal(
      readSessionRegistry(f.vault).cleanup_reservations?.['repository-1:worktree-attempt']?.attempt_token,
      'attempt-a',
    );
    assert.equal(
      releaseActiveContextCleanup(f.vault, 'cleanup-attempt', {
        repositoryId: target.repositoryId,
        worktreeId: target.worktreeId,
        attemptToken: 'attempt-b',
      }),
      false,
    );
    assert.ok(readSessionRegistry(f.vault).cleanup_reservations?.['repository-1:worktree-attempt']);
    assert.equal(
      releaseActiveContextCleanup(f.vault, 'cleanup-attempt', {
        repositoryId: target.repositoryId,
        worktreeId: target.worktreeId,
        attemptToken: 'attempt-a',
      }),
      true,
    );
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:PROV-4] release removes only the matching repository/worktree reservation', () => {
  const f = fixture();
  try {
    reserveActiveContextCleanup(f.vault, {
      operationId: 'shared-operation', projectId: 'project-1', repositoryId: 'repository-a',
      worktreeId: 'worktree-a', mode: 'remove', authority: 'reason:abc',
    });
    reserveActiveContextCleanup(f.vault, {
      operationId: 'shared-operation', projectId: 'project-1', repositoryId: 'repository-b',
      worktreeId: 'worktree-b', mode: 'remove', authority: 'reason:abc',
    });
    assert.equal(
      releaseActiveContextCleanup(f.vault, 'shared-operation', {
      repositoryId: 'repository-a', worktreeId: 'worktree-a',
      }),
      true,
    );
    assert.ok(readSessionRegistry(f.vault).cleanup_reservations?.['repository-b:worktree-b']);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:PROV-4] a same-operation reservation cannot collide across repositories by worktree id', () => {
  const f = fixture();
  try {
    reserveActiveContextCleanup(f.vault, {
      operationId: 'cross-repository-operation', projectId: 'project-1',
      repositoryId: 'repository-a', worktreeId: 'shared-worktree',
    });
    assert.throws(
      () => reserveActiveContextCleanup(f.vault, {
        operationId: 'cross-repository-operation', projectId: 'project-1',
        repositoryId: 'repository-b', worktreeId: 'shared-worktree',
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_RESERVED',
    );
    assert.ok(readSessionRegistry(f.vault).cleanup_reservations?.['repository-a:shared-worktree']);
    assert.equal(readSessionRegistry(f.vault).cleanup_reservations?.['repository-b:shared-worktree'], undefined);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:PROV-4] terminal tombstone requires the reservation owner attempt token', () => {
  const f = fixture();
  try {
    const target = identity('worktree-terminal-owner', 'work-a');
    reserveActiveContextCleanup(f.vault, {
      operationId: 'terminal-owner-operation',
      projectId: target.projectId,
      repositoryId: target.repositoryId,
      worktreeId: target.worktreeId,
      workSessionId: target.workSessionId,
      attemptToken: 'owner-a',
      ownerPid: process.pid,
    });
    assert.throws(
      () => markActiveContextCleanupTerminal(f.vault, {
        operationId: 'terminal-owner-operation',
        projectId: target.projectId,
        repositoryId: target.repositoryId,
        worktreeId: target.worktreeId,
        workSessionId: target.workSessionId,
        subjectHash: 'subject-a',
        attemptToken: 'owner-b',
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_BUSY',
    );
    assert.equal(readSessionRegistry(f.vault).cleanup_tombstones, undefined);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:PROV-4] terminal tombstone rejects full-subject drift even with the same owner token', () => {
  const f = fixture();
  try {
    const target = identity('worktree-terminal-subject', 'work-a');
    const path = join(f.vault, 'worktree-terminal-subject');
    reserveActiveContextCleanup(f.vault, {
      operationId: 'terminal-subject-operation',
      projectId: target.projectId,
      repositoryId: target.repositoryId,
      worktreeId: target.worktreeId,
      workSessionId: target.workSessionId,
      changeSlug: 'original-change',
      targetContextIds: ['original-context'],
      targetChangeSlugs: ['original-change'],
      targetContextSnapshot: [{ key: 'original-context', state: 'active' }],
      actorContextId: 'original-actor',
      worktreePath: path,
      mode: 'finish',
      authority: 'acme/repo#72',
      head: 'original-head',
      slug: 'terminal-subject',
      allowClosedContexts: true,
      attemptToken: 'owner-a',
      ownerPid: process.pid,
    });
    assert.throws(
      () => markActiveContextCleanupTerminal(f.vault, {
        operationId: 'terminal-subject-operation',
        projectId: target.projectId,
        repositoryId: target.repositoryId,
        worktreeId: target.worktreeId,
        workSessionId: target.workSessionId,
        worktreePath: path,
        subjectHash: 'subject-a',
        actorContextId: 'tampered-actor',
        attemptToken: 'owner-a',
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_CAS_CONFLICT',
    );
    assert.equal(readSessionRegistry(f.vault).cleanup_tombstones, undefined);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:PROV-4] stale whole-registry writes cannot erase a terminal tombstone', () => {
  const f = fixture();
  try {
    const target = identity('worktree-stale-writer', 'work-a');
    reserveActiveContextCleanup(f.vault, {
      operationId: 'stale-writer-operation',
      projectId: target.projectId,
      repositoryId: target.repositoryId,
      worktreeId: target.worktreeId,
      workSessionId: target.workSessionId,
      worktreePath: join(f.vault, 'worktree-stale-writer'),
      attemptToken: 'owner-a',
      ownerPid: process.pid,
    });
    const stale = readSessionRegistry(f.vault);
    markActiveContextCleanupTerminal(f.vault, {
      operationId: 'stale-writer-operation',
      projectId: target.projectId,
      repositoryId: target.repositoryId,
      worktreeId: target.worktreeId,
      workSessionId: target.workSessionId,
      worktreePath: join(f.vault, 'worktree-stale-writer'),
      subjectHash: 'stale-subject',
      attemptToken: 'owner-a',
    });
    assert.throws(
      () => writeSessionRegistry(f.vault, stale),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_TERMINAL',
    );
    assert.equal(
      readSessionRegistry(f.vault).cleanup_tombstones?.['repository-1:worktree-stale-writer']?.subject_hash,
      'stale-subject',
    );
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:ACTX-10] resolution without a causal work session fails closed when a worktree is ambiguous', () => {
  const f = fixture();
  try {
    setActiveContextChange(f.vault, identity('worktree-a', 'work-a'), 'change-a');
    setActiveContextChange(f.vault, identity('worktree-a', 'work-b'), 'change-b');

    assert.throws(
      () => resolveActiveContext(f.vault, {
        projectId: 'project-1', repositoryId: 'repository-1', worktreeId: 'worktree-a',
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_AMBIGUOUS',
    );
    assert.throws(
      () => resolveActiveContext(f.vault, {
        projectId: 'project-1', repositoryId: 'repository-1', worktreeId: 'worktree-missing',
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND',
    );
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:ACTX-9] stale CAS leaves registry byte-identical', () => {
  const f = fixture();
  try {
    const current = setActiveContextChange(f.vault, identity('worktree-a', 'work-a'), 'change-a');
    const before = readFileSync(f.registryPath);
    assert.equal(current.context.revision, 1);
    assert.throws(
      () => setActiveContextChange(f.vault, identity('worktree-a', 'work-a'), 'change-b', {
        expectedRevision: 0,
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_STALE',
    );
    assert.deepEqual(readFileSync(f.registryPath), before);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:ACTX-9] persistence failure publishes neither registry nor legacy projection', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.vault, '.brain', 'CURRENT_CHANGE.md'), 'change: previous\n', 'utf8');
    const beforeRegistry = readFileSync(f.registryPath);
    const beforePointer = readFileSync(join(f.vault, '.brain', 'CURRENT_CHANGE.md'));
    let staged = false;

    assert.throws(
      () => setActiveContextChange(f.vault, identity('worktree-a', 'work-a'), 'change-a', {
        mutateRegistry: (vaultBase, mutator) => {
          const candidate = readSessionRegistry(vaultBase);
          mutator(candidate);
          staged = true;
          throw Object.assign(new Error('simulated persistence failure'), { code: 'EIO' });
        },
      }),
      /simulated persistence failure/,
    );
    assert.equal(staged, true);
    assert.deepEqual(readFileSync(f.registryPath), beforeRegistry);
    assert.deepEqual(readFileSync(join(f.vault, '.brain', 'CURRENT_CHANGE.md')), beforePointer);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:ACTX-11] clearing one context preserves the sibling change', () => {
  const f = fixture();
  try {
    const a = identity('worktree-a', 'work-a');
    const b = identity('worktree-b', 'work-b');
    setActiveContextChange(f.vault, a, 'change-a');
    setActiveContextChange(f.vault, b, 'change-b');
    clearActiveContextChange(f.vault, a);
    assert.equal(resolveActiveContext(f.vault, a).change_slug, '');
    assert.equal(resolveActiveContext(f.vault, b).change_slug, 'change-b');
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:ACTX-12] CURRENT_CHANGE is populated only for one unequivocal active context', () => {
  const f = fixture();
  try {
    const pointer = join(f.vault, '.brain', 'CURRENT_CHANGE.md');
    setActiveContextChange(f.vault, identity('worktree-a', 'work-a'), 'change-a');
    assert.equal(readFileSync(pointer, 'utf8'), 'change: change-a\n');

    setActiveContextChange(f.vault, identity('worktree-b', 'work-b'), 'change-b');
    assert.equal(readFileSync(pointer, 'utf8'), 'change:\n');
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:ACTX-12] zero active contexts erase a stale legacy pointer', () => {
  const f = fixture();
  try {
    const pointer = join(f.vault, '.brain', 'CURRENT_CHANGE.md');
    writeFileSync(pointer, 'change: stale-legacy\n', 'utf8');
    assert.equal(projectLegacyActiveChange(f.vault), '');
    assert.equal(readFileSync(pointer, 'utf8'), 'change:\n');
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:ACTX-13] legacy migration requires exactly one provable active session', () => {
  for (const ambiguous of [false, true]) {
    const f = fixture();
    try {
      writeFileSync(join(f.vault, '.brain', 'CURRENT_CHANGE.md'), 'change: legacy-change\n', 'utf8');
      const sessions = {
        'session-a': {
          status: 'active', work_session_id: 'work-a',
          project_scope: { complete: true, projectId: 'project-1' },
        },
        ...(ambiguous ? {
          'session-b': {
            status: 'active', work_session_id: 'work-b',
            project_scope: { complete: true, projectId: 'project-1' },
          },
        } : {}),
      };
      writeSessionRegistry(f.vault, { version: 2, sessions });
      const before = readFileSync(f.registryPath);
      const migrated = migrateLegacyActiveContext(f.vault, {
        identityForSession: (_sessionId, entry) => identity(
          entry.work_session_id === 'work-a' ? 'worktree-a' : 'worktree-b',
          entry.work_session_id,
        ),
        now: '2026-08-22T04:02:00.000Z',
      });

      assert.equal(migrated.migrated, !ambiguous);
      if (ambiguous) {
        assert.equal(migrated.reason, 'ambiguous');
        assert.deepEqual(readFileSync(f.registryPath), before);
      } else {
        assert.equal(resolveActiveContext(f.vault, identity('worktree-a', 'work-a')).change_slug, 'legacy-change');
      }
    } finally { rmSync(f.vault, { recursive: true, force: true }); }
  }
});

test('[req:ACTX-13] legacy migration refuses zero sessions and incomplete project scope', () => {
  for (const sessions of [
    {},
    {
      'session-incomplete': {
        status: 'active', work_session_id: 'work-a',
        project_scope: { complete: false, projectId: 'project-1' },
      },
    },
    {
      'session-without-work-identity': {
        status: 'active',
        project_scope: { complete: true, projectId: 'project-1' },
      },
    },
  ]) {
    const f = fixture();
    try {
      writeFileSync(join(f.vault, '.brain', 'CURRENT_CHANGE.md'), 'change: legacy-change\n', 'utf8');
      writeSessionRegistry(f.vault, { version: 2, sessions });
      const before = readFileSync(f.registryPath);
      let identityCalls = 0;
      const migrated = migrateLegacyActiveContext(f.vault, {
        identityForSession: () => {
          identityCalls += 1;
          return identity('worktree-a', 'work-a');
        },
      });

      assert.deepEqual(migrated, { migrated: false, reason: 'identity-unavailable' });
      assert.equal(identityCalls, 0);
      assert.deepEqual(readFileSync(f.registryPath), before);
      assert.equal(readFileSync(join(f.vault, '.brain', 'CURRENT_CHANGE.md'), 'utf8'), 'change: legacy-change\n');
    } finally { rmSync(f.vault, { recursive: true, force: true }); }
  }
});

test('[req:ACTX-11] change-core reads, writes, and clears only the selected causal context', () => {
  const f = fixture();
  try {
    const a = identity('worktree-a', 'work-a');
    const b = identity('worktree-b', 'work-b');
    setActiveChange(f.vault, 'change-a', { context: a });
    setActiveChange(f.vault, 'change-b', { context: b });

    assert.equal(activeChange(f.vault, { context: a }), 'change-a');
    assert.equal(activeChange(f.vault, { context: b }), 'change-b');
    assert.equal(readFileSync(join(f.vault, '.brain', 'CURRENT_CHANGE.md'), 'utf8'), 'change:\n');

    clearActiveChange(f.vault, { context: a });
    assert.equal(activeChange(f.vault, { context: a }), '');
    assert.equal(activeChange(f.vault, { context: b }), 'change-b');
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});
