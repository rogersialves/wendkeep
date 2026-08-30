import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { bindProjectVault } from '../packages/vault/src/project-vault.mjs';
import {
  discoverWorktreeRepository,
  mutateWorktreeRegistry,
} from '../packages/vault/src/worktree-metadata.mjs';
import { createManagedWorktree } from '../src/worktree.mjs';
import {
  cleanupMergedWorktrees,
  cleanupReceiptPath,
  configureWorktreeCleanupComposition,
  diagnoseManagedWorktreeCleanups,
  finishManagedWorktree,
  inspectWorktreeCleanup,
  removeManagedWorktree,
  verifyMergedPullRequest,
} from '../src/worktree-cleanup.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return String(result.stdout || '').trim();
}

function fixture(slug = 'branch-probe') {
  const root = mkdtempSync(join(tmpdir(), 'wk-cleanup-branches-'));
  const main = join(root, 'main');
  const vault = join(root, 'vault');
  mkdirSync(main, { recursive: true });
  mkdirSync(join(vault, '.brain'), { recursive: true });
  writeFileSync(join(vault, '.brain', 'PROJECT.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectId: 'wk-fixture-cleanup-branches',
    projectName: 'fixture',
  })}\n`);
  git(main, ['init', '-b', 'main']);
  git(main, ['config', 'user.email', 'cleanup-branches@wendkeep.invalid']);
  git(main, ['config', 'user.name', 'WendKeep Cleanup Branches']);
  writeFileSync(join(main, 'tracked.txt'), 'initial\n');
  git(main, ['add', 'tracked.txt']);
  git(main, ['commit', '-m', 'initial']);
  bindProjectVault({ projectRoot: main, vaultPath: vault });
  git(main, ['add', '.wendkeep.json']);
  git(main, ['commit', '-m', 'bind']);
  const worktree = createManagedWorktree({ startDir: main, slug });
  return { root, main, vault, worktree, slug };
}

test('[req:WT-15] composition and pull-request proof fail closed before cleanup mutation', async () => {
  assert.throws(
    () => configureWorktreeCleanupComposition({}),
    (error) => error?.code === 'WENDKEEP_WORKTREE_COMPOSITION_MISSING',
  );
  await assert.rejects(
    verifyMergedPullRequest({ entry: {}, pullRequest: '72' }),
    (error) => error?.code === 'WENDKEEP_WORKTREE_PR_MISMATCH',
  );
});

test('[req:WT-15] focused recovery probes classify absent, failed, stale and truncated cleanup state', async () => {
  const uninitialized = mkdtempSync(join(tmpdir(), 'wk-cleanup-uninitialized-'));
  const f = fixture();
  try {
    assert.deepEqual(diagnoseManagedWorktreeCleanups({ startDir: uninitialized }), {
      initialized: false,
      issues: [],
    });

    assert.throws(
      () => inspectWorktreeCleanup({ startDir: f.main, slug: 'missing' }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_NOT_FOUND',
    );

    const unassociated = await cleanupMergedWorktrees({ startDir: f.main });
    assert.deepEqual(unassociated.actions, [{
      slug: f.slug,
      outcome: 'blocked',
      blockers: ['WENDKEEP_WORKTREE_PR_UNASSOCIATED'],
    }]);

    const repository = discoverWorktreeRepository({ startDir: f.main });
    mutateWorktreeRegistry(repository, (registry) => {
      registry.entries[f.slug].pullRequest = { number: 72 };
      return registry;
    });
    const unavailable = await cleanupMergedWorktrees({
      startDir: f.main,
      github: async () => { throw Object.assign(new Error('unavailable'), { code: 'PROBE_UNAVAILABLE' }); },
    });
    assert.deepEqual(unavailable.actions[0].blockers, ['PROBE_UNAVAILABLE']);

    mutateWorktreeRegistry(repository, (registry) => {
      registry.entries[f.slug] = {
        ...registry.entries[f.slug],
        state: 'cleaning',
        cleanup: {
          schemaVersion: 1,
          operationId: 'probe-operation',
          state: 'failed',
          mode: 'finish',
          authority: 'https://github.com/acme/repo/pull/72',
          error: { code: 'PROBE_FAILED' },
        },
      };
      return registry;
    });
    const failed = diagnoseManagedWorktreeCleanups({ startDir: f.main });
    assert.equal(failed.issues[0].errorCode, 'PROBE_FAILED');
    assert.match(failed.issues[0].repair, /worktree finish branch-probe --pr 72/);
    await assert.rejects(
      finishManagedWorktree({ startDir: f.main, slug: f.slug }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_PR_UNAVAILABLE',
    );

    mutateWorktreeRegistry(repository, (registry) => {
      registry.entries[f.slug].pullRequest = {
        number: 72,
        url: 'not-a-github-authority',
        state: 'MERGED',
        mergedAt: '2026-08-30T00:00:00.000Z',
        headRefName: f.worktree.branch,
        headRefOid: f.worktree.head,
        mergeCommitOid: f.worktree.head,
        baseRefName: 'main',
      };
      return registry;
    });
    await assert.rejects(
      finishManagedWorktree({ startDir: f.main, slug: f.slug }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_PR_MISMATCH',
    );

    mutateWorktreeRegistry(repository, (registry) => {
      registry.entries[f.slug].pullRequest = {
        ...registry.entries[f.slug].pullRequest,
        url: 'https://github.com/acme/repo/pull/72',
        headRefName: 'wk/not-the-managed-branch',
      };
      return registry;
    });
    await assert.rejects(
      finishManagedWorktree({ startDir: f.main, slug: f.slug }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_PR_MISMATCH',
    );

    mutateWorktreeRegistry(repository, (registry) => {
      registry.entries[f.slug].cleanup = {
        ...registry.entries[f.slug].cleanup,
        mode: 'remove',
        authority: 'reason:reserved-for-another-reason',
      };
      return registry;
    });
    await assert.rejects(
      removeManagedWorktree({ startDir: f.main, slug: f.slug, reason: 'different reason' }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_CLEANUP_BUSY',
    );

    const receiptPath = cleanupReceiptPath(repository);
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, '');
    const truncated = diagnoseManagedWorktreeCleanups({ startDir: f.main });
    assert.equal(truncated.issues[0].errorCode, 'WENDKEEP_RECEIPT_LEDGER_TRUNCATED');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(uninitialized, { recursive: true, force: true });
  }
});

test('[req:WT-15] branch movement immediately before removal releases the causal reservation', async () => {
  const f = fixture('branch-drift');
  try {
    writeFileSync(join(f.main, 'advance.txt'), 'advance\n');
    git(f.main, ['add', 'advance.txt']);
    git(f.main, ['commit', '-m', 'advance main']);
    const movedHead = git(f.main, ['rev-parse', 'HEAD']);

    await assert.rejects(
      removeManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        reason: 'cleanup branch drift probe',
        actorContext: { id: 'actor-probe' },
        faultInjection: {
          beforePathRemoval: () => {
            git(f.worktree.path, ['reset', '--hard', movedHead]);
          },
        },
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_PR_HEAD_MISMATCH',
    );

    assert.equal(existsSync(f.worktree.path), true);
    assert.equal(existsSync(cleanupReceiptPath(
      discoverWorktreeRepository({ startDir: f.main }),
    )), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
