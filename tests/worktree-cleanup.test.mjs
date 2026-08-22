import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { bindProjectVault } from '../packages/vault/src/project-vault.mjs';
import {
  discoverWorktreeRepository,
  mutateWorktreeRegistry,
  readWorktreeRegistry,
} from '../packages/vault/src/worktree-metadata.mjs';
import { readSessionRegistry, writeSessionRegistry } from '../hooks/obsidian-common.mjs';
import { activeContextKey } from '../hooks/active-context-store.mjs';
import { createManagedWorktree, diagnoseManagedWorktrees } from '../src/worktree.mjs';
import {
  cleanupMergedWorktrees,
  cleanupReceiptPath,
  diagnoseManagedWorktreeCleanups,
  finishManagedWorktree,
  inspectWorktreeCleanup,
  pruneManagedWorktrees,
  removeManagedWorktree,
  verifyMergedPullRequest,
} from '../src/worktree-cleanup.mjs';

function git(cwd, args, { ok = true } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (ok) assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return String(result.stdout || '').trim();
}

function fixture(slug = 'cleanup') {
  const root = mkdtempSync(join(tmpdir(), 'wk cleanup '));
  const main = join(root, 'main repo');
  const vault = join(root, 'canonical vault');
  mkdirSync(main, { recursive: true });
  mkdirSync(join(vault, '.brain'), { recursive: true });
  writeFileSync(join(vault, '.brain', 'PROJECT.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectId: 'wk-fixture-cleanup',
    projectName: 'fixture',
  }, null, 2)}\n`);
  git(main, ['init', '-b', 'main']);
  git(main, ['config', 'user.email', 'cleanup@wendkeep.invalid']);
  git(main, ['config', 'user.name', 'WendKeep Cleanup']);
  writeFileSync(join(main, 'tracked.txt'), 'initial\n');
  git(main, ['add', 'tracked.txt']);
  git(main, ['commit', '-m', 'initial']);
  bindProjectVault({ projectRoot: main, vaultPath: vault });
  git(main, ['add', '.wendkeep.json']);
  git(main, ['commit', '-m', 'bind']);
  const worktree = createManagedWorktree({ startDir: main, slug });
  return { root, main, vault, worktree, slug };
}

function mergedFeature(f) {
  writeFileSync(join(f.worktree.path, `${f.slug}.txt`), `${f.slug}\n`);
  git(f.worktree.path, ['add', `${f.slug}.txt`]);
  git(f.worktree.path, ['commit', '-m', `${f.slug} feature`]);
  const head = git(f.worktree.path, ['rev-parse', 'HEAD']);
  git(f.main, ['merge', '--no-ff', f.worktree.branch, '-m', `merge ${f.slug}`]);
  return { head, mergeCommit: git(f.main, ['rev-parse', 'HEAD']) };
}

function mergedPr(f, mergeCommit, overrides = {}) {
  return async () => ({
    number: 72,
    url: 'https://github.com/acme/repo/pull/72',
    state: 'MERGED',
    mergedAt: '2026-08-22T12:00:00.000Z',
    headRefName: f.worktree.branch,
    baseRefName: 'main',
    mergeCommitOid: mergeCommit,
    isCrossRepository: false,
    ...overrides,
  });
}

test('[req:WT-11] merge proof trusts the merged PR result but requires branch and reachable merge commit', async () => {
  const f = fixture('proof');
  try {
    const { mergeCommit } = mergedFeature(f);
    const entry = readWorktreeRegistry(
      discoverWorktreeRepository({ startDir: f.main }),
    ).registry.entries.proof;
    for (const mergeMode of ['merge', 'squash', 'rebase']) {
      const proof = await verifyMergedPullRequest({
        startDir: f.main,
        entry,
        pullRequest: '72',
        github: mergedPr(f, mergeCommit, { mergeMode }),
      });
      assert.equal(proof.mergeMode, mergeMode);
      assert.equal(proof.mergeCommitOid, mergeCommit);
    }
    await assert.rejects(
      verifyMergedPullRequest({
        startDir: f.main,
        entry,
        pullRequest: '72',
        github: mergedPr(f, mergeCommit, { state: 'CLOSED', mergedAt: null }),
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_PR_NOT_MERGED',
    );
    await assert.rejects(
      verifyMergedPullRequest({
        startDir: f.main,
        entry,
        pullRequest: '72',
        github: mergedPr(f, git(f.main, ['rev-parse', 'HEAD^']), { headRefName: 'wk/sibling' }),
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_PR_MISMATCH',
    );
    git(f.main, ['remote', 'add', 'origin', 'https://github.com/acme/repo.git']);
    await assert.rejects(
      verifyMergedPullRequest({
        startDir: f.main, entry, pullRequest: 'https://github.com/other/repo/pull/72',
        github: mergedPr(f, mergeCommit),
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_PR_MISMATCH',
    );
    await assert.rejects(
      verifyMergedPullRequest({
        startDir: f.main, entry, pullRequest: '72',
        github: mergedPr(f, mergeCommit, { url: 'https://github.com/other/repo/pull/72' }),
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_PR_MISMATCH',
    );
    for (const overrides of [
      { url: '' },
      { url: 'not-a-pull-request-url' },
      { number: 73, url: 'https://github.com/acme/repo/pull/73' },
    ]) {
      await assert.rejects(
        verifyMergedPullRequest({
          startDir: f.main, entry, pullRequest: '72',
          github: mergedPr(f, mergeCommit, overrides),
        }),
        (error) => error?.code === 'WENDKEEP_WORKTREE_PR_MISMATCH',
      );
    }
    writeFileSync(join(f.worktree.path, 'after-merge.txt'), 'later\n');
    git(f.worktree.path, ['add', 'after-merge.txt']);
    git(f.worktree.path, ['commit', '-m', 'after merge head']);
    const unreachable = git(f.worktree.path, ['rev-parse', 'HEAD']);
    await assert.rejects(
      verifyMergedPullRequest({
        startDir: f.main, entry, pullRequest: '72', github: mergedPr(f, unreachable),
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_PR_MERGE_UNREACHABLE',
    );
    await assert.rejects(
      verifyMergedPullRequest({
        startDir: f.main, entry, pullRequest: '72', github: async () => { throw new Error('offline'); },
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_PR_UNAVAILABLE',
    );
    await assert.rejects(
      verifyMergedPullRequest({
        startDir: f.main, entry, pullRequest: '72',
        github: mergedPr(f, mergeCommit, { state: 'OPEN', mergedAt: null, mergeCommitOid: '' }),
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_PR_NOT_MERGED',
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:WT-11] merge proof accepts discriminating real squash and rebase graphs', async () => {
  const squash = fixture('proof-squash');
  try {
    writeFileSync(join(squash.worktree.path, 'squashed.txt'), 'squashed\n');
    git(squash.worktree.path, ['add', 'squashed.txt']);
    git(squash.worktree.path, ['commit', '-m', 'feature to squash']);
    const originalHead = git(squash.worktree.path, ['rev-parse', 'HEAD']);
    git(squash.main, ['merge', '--squash', squash.worktree.branch]);
    git(squash.main, ['commit', '-m', 'squash feature']);
    const mergeCommit = git(squash.main, ['rev-parse', 'HEAD']);
    assert.notEqual(spawnSync('git', [
      'merge-base', '--is-ancestor', originalHead, 'main',
    ], { cwd: squash.main }).status, 0);
    const entry = readWorktreeRegistry(
      discoverWorktreeRepository({ startDir: squash.main }),
    ).registry.entries['proof-squash'];
    const proof = await verifyMergedPullRequest({
      startDir: squash.main, entry, pullRequest: '72',
      github: mergedPr(squash, mergeCommit, { headRefOid: originalHead, mergeMode: 'squash' }),
    });
    assert.equal(proof.mergeMode, 'squash');
    assert.equal(proof.mergeCommitOid, mergeCommit);
  } finally { rmSync(squash.root, { recursive: true, force: true }); }

  const rebase = fixture('proof-rebase');
  try {
    writeFileSync(join(rebase.worktree.path, 'rebased.txt'), 'rebased\n');
    git(rebase.worktree.path, ['add', 'rebased.txt']);
    git(rebase.worktree.path, ['commit', '-m', 'feature to rebase']);
    const originalHead = git(rebase.worktree.path, ['rev-parse', 'HEAD']);
    writeFileSync(join(rebase.main, 'main-only.txt'), 'advance base\n');
    git(rebase.main, ['add', 'main-only.txt']);
    git(rebase.main, ['commit', '-m', 'advance main']);
    git(rebase.worktree.path, ['rebase', 'main']);
    const rebasedHead = git(rebase.worktree.path, ['rev-parse', 'HEAD']);
    git(rebase.main, ['merge', '--ff-only', rebase.worktree.branch]);
    assert.notEqual(rebasedHead, originalHead);
    assert.notEqual(spawnSync('git', [
      'merge-base', '--is-ancestor', originalHead, 'main',
    ], { cwd: rebase.main }).status, 0);
    const entry = readWorktreeRegistry(
      discoverWorktreeRepository({ startDir: rebase.main }),
    ).registry.entries['proof-rebase'];
    const proof = await verifyMergedPullRequest({
      startDir: rebase.main, entry, pullRequest: '72',
      github: mergedPr(rebase, rebasedHead, { headRefOid: rebasedHead, mergeMode: 'rebase' }),
    });
    assert.equal(proof.mergeMode, 'rebase');
    assert.equal(proof.mergeCommitOid, rebasedHead);
  } finally { rmSync(rebase.root, { recursive: true, force: true }); }
});

test('[req:WT-12] preflight reports dirty, active session, outbox, delivery and pending handoff without mutation', async () => {
  const f = fixture('blocked');
  try {
    writeFileSync(join(f.worktree.path, 'untracked.txt'), 'local\n');
    const discovered = discoverWorktreeRepository({ startDir: f.main });
    const registry = readWorktreeRegistry(discovered).registry;
    const context = {
      project_id: registry.projectId,
      repository_id: registry.repositoryId,
      worktree_id: f.worktree.worktreeId,
      work_session_id: 'work-blocked',
      branch: f.worktree.branch,
      head_sha: f.worktree.head,
      change_slug: 'blocked-change',
      delivery_id: 'delivery-blocked',
      state: 'active', revision: 1, updated_at: '2026-08-22T12:00:00.000Z',
    };
    writeSessionRegistry(f.vault, {
      version: 2,
      sessions: { blocked: { status: 'active', work_session_id: 'work-blocked' } },
      active_contexts_schema: 1,
      active_contexts_revision: 1,
      active_contexts: { blocked: context },
    });
    mkdirSync(join(f.vault, '.brain', 'memory-outbox'), { recursive: true });
    writeFileSync(join(f.vault, '.brain', 'memory-outbox', 'handoff.json'), JSON.stringify({
      id: 'handoff-pending', memory_key: 'handoff.latest',
    }));
    const beforeRegistry = readFileSync(join(f.vault, '.brain', 'SESSION_REGISTRY.json'));
    const report = inspectWorktreeCleanup({ startDir: f.main, slug: 'blocked' });
    assert.equal(report.ok, false);
    assert.deepEqual(report.blockers.map((item) => item.code), [
      'WENDKEEP_WORKTREE_DIRTY',
      'WENDKEEP_WORKTREE_ACTIVE_SESSION',
      'WENDKEEP_WORKTREE_ACTIVE_DELIVERY',
      'WENDKEEP_WORKTREE_OUTBOX_PENDING',
      'WENDKEEP_WORKTREE_HANDOFF_PENDING',
    ]);
    assert.deepEqual([...report.blockers.map((item) => item.code)].sort(), [
      'WENDKEEP_WORKTREE_ACTIVE_DELIVERY',
      'WENDKEEP_WORKTREE_ACTIVE_SESSION',
      'WENDKEEP_WORKTREE_DIRTY',
      'WENDKEEP_WORKTREE_HANDOFF_PENDING',
      'WENDKEEP_WORKTREE_OUTBOX_PENDING',
    ].sort());
    assert.deepEqual(readFileSync(join(f.vault, '.brain', 'SESSION_REGISTRY.json')), beforeRegistry);
    assert.ok(report.blockers.every((item) => String(item.recovery || '').trim()));
    const gitBefore = git(f.main, ['worktree', 'list', '--porcelain']);
    const refsBefore = git(f.main, ['show-ref']);
    const outboxBefore = readFileSync(join(f.vault, '.brain', 'memory-outbox', 'handoff.json'));
    await assert.rejects(
      removeManagedWorktree({ startDir: f.main, slug: 'blocked', reason: 'abandono explícito' }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_DIRTY',
    );
    assert.equal(git(f.main, ['worktree', 'list', '--porcelain']), gitBefore);
    assert.equal(git(f.main, ['show-ref']), refsBefore);
    assert.deepEqual(readFileSync(join(f.vault, '.brain', 'SESSION_REGISTRY.json')), beforeRegistry);
    assert.deepEqual(readFileSync(join(f.vault, '.brain', 'memory-outbox', 'handoff.json')), outboxBefore);
    assert.equal(existsSync(cleanupReceiptPath(discovered)), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:WT-13] finish removes a merged worktree, closes only its context and appends one idempotent receipt', async () => {
  const f = fixture('finish');
  try {
    const { mergeCommit } = mergedFeature(f);
    const repository = discoverWorktreeRepository({ startDir: f.main });
    const registry = readWorktreeRegistry(repository).registry;
    mkdirSync(dirname(cleanupReceiptPath(repository)), { recursive: true });
    const priorReceipt = `${JSON.stringify({ id: 'prior-receipt', slug: 'sibling', outcome: 'completed' })}\n`;
    writeFileSync(cleanupReceiptPath(repository), priorReceipt);
    const evidencePath = join(f.vault, 'evidence-preserved.md');
    writeFileSync(evidencePath, 'historical evidence\n');
    const target = {
      project_id: registry.projectId, repository_id: registry.repositoryId,
      worktree_id: f.worktree.worktreeId, work_session_id: 'work-target',
      branch: f.worktree.branch, head_sha: f.worktree.head, change_slug: 'finish-change',
      state: 'active', revision: 1, updated_at: '2026-08-22T12:00:00.000Z',
    };
    const sibling = {
      project_id: registry.projectId, repository_id: registry.repositoryId,
      worktree_id: 'sibling-worktree', work_session_id: 'work-sibling',
      branch: 'wk/sibling', head_sha: 'abcdef1', change_slug: 'sibling-change',
      state: 'active', revision: 1, updated_at: '2026-08-22T12:00:00.000Z',
    };
    writeSessionRegistry(f.vault, {
      version: 2,
      sessions: {},
      active_contexts_schema: 1,
      active_contexts_revision: 2,
      active_contexts: {
        [activeContextKey(target)]: target,
        [activeContextKey(sibling)]: sibling,
      },
    });
    const first = await finishManagedWorktree({
      startDir: f.main, slug: 'finish', pullRequest: '72', github: mergedPr(f, mergeCommit),
      now: () => '2026-08-22T13:00:00.000Z',
    });
    assert.equal(first.state, 'completed');
    assert.equal(first.idempotent, false);
    assert.equal(existsSync(f.worktree.path), false);
    assert.equal(git(f.main, ['branch', '--list', f.worktree.branch]), '');
    const contexts = readSessionRegistry(f.vault).active_contexts;
    assert.equal(contexts[activeContextKey(target)].state, 'closed');
    assert.equal(contexts[activeContextKey(sibling)].state, 'active');
    const receiptLines = readFileSync(cleanupReceiptPath(repository), 'utf8').trim().split(/\r?\n/);
    assert.equal(receiptLines.length, 2);
    assert.equal(`${receiptLines[0]}\n`, priorReceipt);
    assert.equal(JSON.parse(receiptLines[1]).pull_request.number, 72);
    assert.equal(readFileSync(evidencePath, 'utf8'), 'historical evidence\n');
    assert.equal(git(f.main, ['worktree', 'list', '--porcelain']).includes(f.worktree.path), false);
    assert.equal(git(f.main, ['worktree', 'prune', '--dry-run', '--verbose']), '');

    const second = await finishManagedWorktree({
      startDir: f.main, slug: 'finish', pullRequest: '72', github: mergedPr(f, mergeCommit),
    });
    assert.equal(second.idempotent, true);
    assert.equal(readFileSync(cleanupReceiptPath(repository), 'utf8').trim().split(/\r?\n/).length, 2);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:WT-14] explicit remove requires a reason, preserves an unmerged branch and is idempotent', async () => {
  const f = fixture('abandon');
  try {
    const gitCalls = [];
    const recordingSpawn = (command, args, options) => {
      gitCalls.push([command, ...args]);
      return spawnSync(command, args, options);
    };
    await assert.rejects(
      removeManagedWorktree({ startDir: f.main, slug: 'abandon', reason: '' }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_REASON_REQUIRED',
    );
    const removed = await removeManagedWorktree({
      startDir: f.main, slug: 'abandon', reason: 'PR descartado pelo mantenedor', spawn: recordingSpawn,
    });
    assert.equal(removed.state, 'completed');
    assert.equal(existsSync(f.worktree.path), false);
    assert.notEqual(git(f.main, ['branch', '--list', f.worktree.branch]), '');
    assert.equal(gitCalls.flat().includes('--force'), false);
    const again = await removeManagedWorktree({
      startDir: f.main, slug: 'abandon', reason: 'PR descartado pelo mantenedor',
    });
    assert.equal(again.idempotent, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:WT-14] cleanup merged and prune are deterministic dry-run by default and mutate only with apply', async () => {
  const f = fixture('batch');
  try {
    const { mergeCommit } = mergedFeature(f);
    const blocked = createManagedWorktree({ startDir: f.main, slug: 'batch-blocked' });
    writeFileSync(join(blocked.path, 'blocked-feature.txt'), 'blocked feature\n');
    git(blocked.path, ['add', 'blocked-feature.txt']);
    git(blocked.path, ['commit', '-m', 'blocked feature']);
    git(f.main, ['merge', '--no-ff', blocked.branch, '-m', 'merge blocked feature']);
    const blockedMergeCommit = git(f.main, ['rev-parse', 'HEAD']);
    writeFileSync(join(blocked.path, 'untracked-after-merge.txt'), 'blocks cleanup\n');
    const repository = discoverWorktreeRepository({ startDir: f.main });
    mutateWorktreeRegistry(repository, (registry) => {
      registry.entries.batch.pullRequest = { number: 72, url: 'https://github.com/acme/repo/pull/72' };
      registry.entries['batch-blocked'].pullRequest = {
        number: 73, url: 'https://github.com/acme/repo/pull/73',
      };
      return registry;
    });
    const github = async ({ entry }) => ({
      number: entry.branch === blocked.branch ? 73 : 72,
      url: `https://github.com/acme/repo/pull/${entry.branch === blocked.branch ? 73 : 72}`,
      state: 'MERGED',
      mergedAt: '2026-08-22T12:00:00.000Z',
      headRefName: entry.branch,
      baseRefName: 'main',
      mergeCommitOid: entry.branch === blocked.branch ? blockedMergeCommit : mergeCommit,
      isCrossRepository: false,
    });
    const registryBefore = readFileSync(join(repository.commonDir, 'wendkeep', 'worktrees-v1.json'));
    const sessionRegistryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    const sessionsBefore = existsSync(sessionRegistryPath) ? readFileSync(sessionRegistryPath) : null;
    const gitBefore = git(f.main, ['worktree', 'list', '--porcelain']);
    const refsBefore = git(f.main, ['show-ref']);
    const dryRun = await cleanupMergedWorktrees({
      startDir: f.main, github,
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.ok, false);
    assert.deepEqual(dryRun.actions.map((item) => item.slug), ['batch', 'batch-blocked']);
    assert.deepEqual(dryRun.actions[1].blockers, ['WENDKEEP_WORKTREE_DIRTY']);
    assert.equal(existsSync(f.worktree.path), true);
    assert.deepEqual(readFileSync(join(repository.commonDir, 'wendkeep', 'worktrees-v1.json')), registryBefore);
    assert.deepEqual(existsSync(sessionRegistryPath) ? readFileSync(sessionRegistryPath) : null, sessionsBefore);
    assert.equal(git(f.main, ['worktree', 'list', '--porcelain']), gitBefore);
    assert.equal(git(f.main, ['show-ref']), refsBefore);
    assert.equal(existsSync(cleanupReceiptPath(repository)), false);

    const applied = await cleanupMergedWorktrees({
      startDir: f.main, apply: true, github,
    });
    assert.equal(applied.actions[0].outcome, 'completed');
    assert.equal(applied.actions[1].outcome, 'blocked');
    assert.equal(existsSync(f.worktree.path), false);
    assert.equal(existsSync(blocked.path), true);

    const stale = fixture('stale');
    try {
      const staleRepository = discoverWorktreeRepository({ startDir: stale.main });
      rmSync(stale.worktree.path, { recursive: true, force: true });
      const staleRegistryBefore = readFileSync(join(staleRepository.commonDir, 'wendkeep', 'worktrees-v1.json'));
      const gitMetadataBefore = git(stale.main, ['worktree', 'list', '--porcelain']);
      const receiptsBefore = existsSync(cleanupReceiptPath(staleRepository))
        ? readFileSync(cleanupReceiptPath(staleRepository)) : null;
      const preview = pruneManagedWorktrees({ startDir: stale.main });
      assert.equal(preview.dryRun, true);
      assert.ok(preview.actions.some((item) => item.path === stale.worktree.path));
      assert.deepEqual(
        readFileSync(join(staleRepository.commonDir, 'wendkeep', 'worktrees-v1.json')),
        staleRegistryBefore,
      );
      assert.deepEqual(
        existsSync(cleanupReceiptPath(staleRepository)) ? readFileSync(cleanupReceiptPath(staleRepository)) : null,
        receiptsBefore,
      );
      assert.equal(git(stale.main, ['worktree', 'list', '--porcelain']), gitMetadataBefore);
      const pruned = pruneManagedWorktrees({ startDir: stale.main, apply: true });
      assert.equal(pruned.dryRun, false);
      assert.equal(git(stale.main, ['worktree', 'list', '--porcelain']).includes(stale.worktree.path), false);
    } finally { rmSync(stale.root, { recursive: true, force: true }); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:WT-15] interrupted cleanup resumes only after the path vanished and concurrent cleanup stays blocked', async () => {
  const crashed = fixture('crashed');
  try {
    const { mergeCommit } = mergedFeature(crashed);
    const repository = discoverWorktreeRepository({ startDir: crashed.main });
    const registry = readWorktreeRegistry(repository).registry;
    const target = {
      project_id: registry.projectId, repository_id: registry.repositoryId,
      worktree_id: crashed.worktree.worktreeId, work_session_id: 'work-crashed',
      branch: crashed.worktree.branch, head_sha: crashed.worktree.head,
      change_slug: 'crashed-change', delivery_id: 'delivery-crashed',
      state: 'active', revision: 1, updated_at: '2026-08-22T12:00:00.000Z',
    };
    const sibling = {
      project_id: registry.projectId, repository_id: registry.repositoryId,
      worktree_id: 'sibling-worktree', work_session_id: 'work-sibling',
      branch: 'wk/sibling', head_sha: 'abcdef1', change_slug: 'sibling-change',
      state: 'active', revision: 1, updated_at: '2026-08-22T12:00:00.000Z',
    };
    writeSessionRegistry(crashed.vault, {
      version: 2,
      sessions: {
        crashed: {
          status: 'active', work_session_id: 'work-crashed',
          project_scope: { repoRoot: crashed.worktree.path },
        },
      },
      active_contexts_schema: 1,
      active_contexts_revision: 2,
      active_contexts: {
        [activeContextKey(target)]: target,
        [activeContextKey(sibling)]: sibling,
      },
    });
    mutateWorktreeRegistry(repository, (registry) => {
      registry.entries.crashed = {
        ...registry.entries.crashed,
        state: 'cleaning',
        pullRequest: { number: 72, url: 'https://github.com/acme/repo/pull/72' },
        cleanup: {
          schemaVersion: 1, operationId: 'interrupted-op', state: 'cleaning', mode: 'finish',
          authority: 'https://github.com/acme/repo/pull/72', startedAt: '2026-08-22T12:00:00.000Z',
        },
      };
      return registry;
    });
    git(crashed.main, ['worktree', 'remove', crashed.worktree.path]);
    const resumed = await finishManagedWorktree({
      startDir: crashed.main, slug: 'crashed', github: mergedPr(crashed, mergeCommit),
    });
    assert.equal(resumed.state, 'completed');
    assert.equal(resumed.receipt.operationId, 'interrupted-op');
    assert.equal(readFileSync(cleanupReceiptPath(repository), 'utf8').trim().split(/\r?\n/).length, 1);
    const contexts = readSessionRegistry(crashed.vault).active_contexts;
    assert.equal(contexts[activeContextKey(target)].state, 'closed');
    assert.equal(contexts[activeContextKey(target)].delivery_id, '');
    assert.equal(contexts[activeContextKey(sibling)].state, 'active');
  } finally { rmSync(crashed.root, { recursive: true, force: true }); }

  const busy = fixture('busy');
  try {
    const { mergeCommit } = mergedFeature(busy);
    const repository = discoverWorktreeRepository({ startDir: busy.main });
    mutateWorktreeRegistry(repository, (registry) => {
      registry.entries.busy = {
        ...registry.entries.busy,
        state: 'cleaning',
        cleanup: {
          schemaVersion: 1, operationId: 'busy-op', state: 'cleaning', mode: 'finish',
          authority: 'https://github.com/acme/repo/pull/72', startedAt: '2026-08-22T12:00:00.000Z',
        },
      };
      return registry;
    });
    await assert.rejects(
      finishManagedWorktree({
        startDir: busy.main, slug: 'busy', pullRequest: '72', github: mergedPr(busy, mergeCommit),
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_CLEANUP_BUSY',
    );
    assert.equal(existsSync(busy.worktree.path), true);
    assert.equal(existsSync(cleanupReceiptPath(repository)), false);
  } finally { rmSync(busy.root, { recursive: true, force: true }); }
});

test('[req:WT-13] branch deletion is CAS-safe when the ref moves after worktree removal', async () => {
  const f = fixture('cas');
  try {
    const { mergeCommit } = mergedFeature(f);
    let moved = false;
    const movingSpawn = (command, args, options) => {
      const result = spawnSync(command, args, options);
      if (!moved && command === 'git' && args[0] === 'worktree' && args[1] === 'remove'
        && result.status === 0) {
        moved = true;
        git(f.main, ['update-ref', `refs/heads/${f.worktree.branch}`, mergeCommit]);
      }
      return result;
    };
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main, slug: 'cas', pullRequest: '72',
        github: mergedPr(f, mergeCommit), spawn: movingSpawn,
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_GIT_FAILED',
    );
    assert.equal(git(f.main, ['rev-parse', f.worktree.branch]), mergeCommit);
    assert.equal(readWorktreeRegistry(
      discoverWorktreeRepository({ startDir: f.main }),
    ).registry.entries.cas.cleanup.state, 'failed');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:WT-15] Git removal failure preserves path and branch, records recovery, and retries cleanly', async () => {
  const f = fixture('git-failure');
  try {
    const { mergeCommit } = mergedFeature(f);
    let failed = false;
    const failingSpawn = (command, args, options) => {
      if (!failed && command === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        failed = true;
        return { status: 1, stdout: '', stderr: 'simulated open handle' };
      }
      return spawnSync(command, args, options);
    };
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main, slug: 'git-failure', pullRequest: '72',
        github: mergedPr(f, mergeCommit), spawn: failingSpawn,
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_GIT_FAILED',
    );
    assert.equal(existsSync(f.worktree.path), true);
    assert.notEqual(git(f.main, ['branch', '--list', f.worktree.branch]), '');
    const failedEntry = readWorktreeRegistry(
      discoverWorktreeRepository({ startDir: f.main }),
    ).registry.entries['git-failure'];
    assert.equal(failedEntry.cleanup.state, 'failed');
    assert.equal(failedEntry.cleanup.error.code, 'WENDKEEP_WORKTREE_GIT_FAILED');
    const retried = await finishManagedWorktree({
      startDir: f.main, slug: 'git-failure', github: mergedPr(f, mergeCommit),
    });
    assert.equal(retried.state, 'completed');
    assert.equal(existsSync(f.worktree.path), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:WT-15] failure after path removal leaves the branch and resumes missing prune/receipt steps', async () => {
  const f = fixture('prune-failure');
  try {
    const { mergeCommit } = mergedFeature(f);
    let failed = false;
    const failingSpawn = (command, args, options) => {
      if (!failed && command === 'git' && args[0] === 'worktree' && args[1] === 'prune') {
        failed = true;
        return { status: 1, stdout: '', stderr: 'simulated prune failure' };
      }
      return spawnSync(command, args, options);
    };
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main, slug: f.slug, pullRequest: '72',
        github: mergedPr(f, mergeCommit), spawn: failingSpawn,
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_GIT_FAILED',
    );
    assert.equal(existsSync(f.worktree.path), false);
    assert.notEqual(git(f.main, ['branch', '--list', f.worktree.branch]), '');
    const failedEntry = readWorktreeRegistry(
      discoverWorktreeRepository({ startDir: f.main }),
    ).registry.entries[f.slug];
    assert.equal(failedEntry.cleanup.state, 'failed');
    assert.equal(existsSync(cleanupReceiptPath(
      discoverWorktreeRepository({ startDir: f.main }),
    )), false);
    const resumed = await finishManagedWorktree({
      startDir: f.main, slug: f.slug, github: mergedPr(f, mergeCommit),
    });
    assert.equal(resumed.state, 'completed');
    assert.equal(git(f.main, ['branch', '--list', f.worktree.branch]), '');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:WT-15] concurrent finish calls remove and append exactly once', async () => {
  const f = fixture('concurrent-finish');
  try {
    const { mergeCommit } = mergedFeature(f);
    let arrived = 0;
    let release;
    const gate = new Promise((resolveGate) => { release = resolveGate; });
    const github = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
      return mergedPr(f, mergeCommit)();
    };
    const results = await Promise.all([
      finishManagedWorktree({ startDir: f.main, slug: f.slug, pullRequest: '72', github }),
      finishManagedWorktree({ startDir: f.main, slug: f.slug, pullRequest: '72', github }),
    ]);
    assert.deepEqual(results.map((item) => item.idempotent).sort(), [false, true]);
    const repository = discoverWorktreeRepository({ startDir: f.main });
    assert.equal(readFileSync(cleanupReceiptPath(repository), 'utf8').trim().split(/\r?\n/).length, 1);
    assert.equal(git(f.main, ['worktree', 'list', '--porcelain']).includes(f.worktree.path), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:WT-16] remote branch deletion is opt-in and a missing remote branch is idempotent', async () => {
  const f = fixture('remote');
  try {
    const remote = join(f.root, 'origin.git');
    git(f.root, ['init', '--bare', remote]);
    git(f.main, ['remote', 'add', 'origin', remote]);
    git(f.main, ['push', '-u', 'origin', 'main']);
    const { mergeCommit } = mergedFeature(f);
    git(f.main, ['push', 'origin', f.worktree.branch]);
    await finishManagedWorktree({
      startDir: f.main, slug: 'remote', pullRequest: '72', github: mergedPr(f, mergeCommit),
    });
    assert.notEqual(git(f.main, ['ls-remote', '--heads', 'origin', `refs/heads/${f.worktree.branch}`]), '');
  } finally { rmSync(f.root, { recursive: true, force: true }); }

  const missing = fixture('remote-missing');
  try {
    const remote = join(missing.root, 'origin.git');
    git(missing.root, ['init', '--bare', remote]);
    git(missing.main, ['remote', 'add', 'origin', remote]);
    git(missing.main, ['push', '-u', 'origin', 'main']);
    const { mergeCommit } = mergedFeature(missing);
    const completed = await finishManagedWorktree({
      startDir: missing.main, slug: 'remote-missing', pullRequest: '72',
      github: mergedPr(missing, mergeCommit), deleteRemote: true,
    });
    assert.equal(completed.receipt.remote_branch_deleted, false);
  } finally { rmSync(missing.root, { recursive: true, force: true }); }

  const authorized = fixture('remote-authorized');
  try {
    const remote = join(authorized.root, 'origin.git');
    git(authorized.root, ['init', '--bare', remote]);
    git(authorized.main, ['remote', 'add', 'origin', remote]);
    git(authorized.main, ['push', '-u', 'origin', 'main']);
    const { mergeCommit } = mergedFeature(authorized);
    git(authorized.main, ['push', 'origin', authorized.worktree.branch]);
    const calls = [];
    const recordingSpawn = (command, args, options) => {
      calls.push([command, ...args]);
      return spawnSync(command, args, options);
    };
    const completed = await finishManagedWorktree({
      startDir: authorized.main, slug: authorized.slug, pullRequest: '72',
      github: mergedPr(authorized, mergeCommit), deleteRemote: true, spawn: recordingSpawn,
    });
    assert.equal(completed.receipt.remote_branch_deleted, true);
    assert.equal(git(authorized.main, [
      'ls-remote', '--heads', 'origin', `refs/heads/${authorized.worktree.branch}`,
    ]), '');
    assert.ok(calls.some((args) => (
      args[0] === 'git' && args[1] === 'push' && args[2] === 'origin'
      && args[3] === '--delete' && args[4] === authorized.worktree.branch && args.length === 5
    )));
  } finally { rmSync(authorized.root, { recursive: true, force: true }); }

  const diverged = fixture('remote-diverged');
  try {
    const remote = join(diverged.root, 'origin.git');
    git(diverged.root, ['init', '--bare', remote]);
    git(diverged.main, ['remote', 'add', 'origin', remote]);
    git(diverged.main, ['push', '-u', 'origin', 'main']);
    const { mergeCommit } = mergedFeature(diverged);
    const branchHead = git(diverged.worktree.path, ['rev-parse', 'HEAD']);
    const remoteHead = git(diverged.main, ['commit-tree', 'HEAD^{tree}', '-p', branchHead, '-m', 'remote divergence']);
    git(diverged.main, ['push', 'origin', `${remoteHead}:refs/heads/${diverged.worktree.branch}`]);
    await assert.rejects(
      finishManagedWorktree({
        startDir: diverged.main, slug: diverged.slug, pullRequest: '72',
        github: mergedPr(diverged, mergeCommit), deleteRemote: true,
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_REMOTE_DIVERGED',
    );
    assert.equal(git(diverged.main, [
      'ls-remote', '--heads', 'origin', `refs/heads/${diverged.worktree.branch}`,
    ]).split(/\s+/)[0], remoteHead);
    assert.notEqual(git(diverged.main, ['branch', '--list', diverged.worktree.branch]), '');
  } finally { rmSync(diverged.root, { recursive: true, force: true }); }

  const unavailable = fixture('remote-unavailable');
  try {
    const remote = join(unavailable.root, 'origin.git');
    git(unavailable.root, ['init', '--bare', remote]);
    git(unavailable.main, ['remote', 'add', 'origin', remote]);
    git(unavailable.main, ['push', '-u', 'origin', 'main']);
    const { mergeCommit } = mergedFeature(unavailable);
    const networkSpawn = (command, args, options) => (
      command === 'git' && args[0] === 'ls-remote'
        ? { status: 1, stdout: '', stderr: 'network unavailable' }
        : spawnSync(command, args, options)
    );
    await assert.rejects(
      finishManagedWorktree({
        startDir: unavailable.main, slug: unavailable.slug, pullRequest: '72',
        github: mergedPr(unavailable, mergeCommit), deleteRemote: true, spawn: networkSpawn,
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_REMOTE_UNAVAILABLE',
    );
    assert.notEqual(git(unavailable.main, ['branch', '--list', unavailable.worktree.branch]), '');
  } finally { rmSync(unavailable.root, { recursive: true, force: true }); }
});

test('[req:WT-17] cleanup diagnostics identify an interrupted reservation with an objective recovery', () => {
  const f = fixture('diagnose');
  try {
    const repository = discoverWorktreeRepository({ startDir: f.main });
    mutateWorktreeRegistry(repository, (registry) => {
      registry.entries.diagnose = {
        ...registry.entries.diagnose,
        state: 'cleaning',
        pullRequest: { number: 72 },
        cleanup: {
          schemaVersion: 1, operationId: 'diagnose-op', state: 'cleaning', mode: 'finish',
          authority: 'pr:72', startedAt: '2026-08-22T12:00:00.000Z',
        },
      };
      return registry;
    });
    git(f.main, ['worktree', 'remove', f.worktree.path]);
    const diagnostic = diagnoseManagedWorktreeCleanups({ startDir: f.main });
    assert.deepEqual(diagnostic.issues.map((item) => item.errorCode), [
      'WENDKEEP_WORKTREE_CLEANUP_INTERRUPTED',
    ]);
    assert.match(diagnostic.issues[0].repair, /worktree finish diagnose --pr 72/);
    const doctor = diagnoseManagedWorktrees({ startDir: f.main });
    assert.ok(doctor.issues.some((item) => (
      item.slug === 'diagnose' && item.errorCode === 'WENDKEEP_WORKTREE_CLEANUP_INTERRUPTED'
    )));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
