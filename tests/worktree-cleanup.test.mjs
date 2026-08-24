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
import {
  mutateSessionRegistry,
  readSessionRegistry,
  upsertSessionRegistry,
  writeSessionRegistry,
} from '../hooks/obsidian-common.mjs';
import {
  activeContextKey,
  mutateActiveContext,
  reserveActiveContextCleanup,
} from '../hooks/active-context-store.mjs';
import { createManagedWorktree, diagnoseManagedWorktrees } from '../src/worktree.mjs';
import {
  cleanupMergedWorktrees,
  cleanupReceiptLegacyPath,
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
    headRefOid: git(f.main, [
      'rev-parse', '--verify', `refs/heads/${f.worktree.branch}`,
    ], { ok: false }),
    baseRefName: 'main',
    mergeCommitOid: mergeCommit,
    isCrossRepository: false,
    ...overrides,
  });
}

function mergedSibling(f, slug) {
  const sibling = createManagedWorktree({ startDir: f.main, slug });
  writeFileSync(join(sibling.path, `${slug}.txt`), `${slug}\n`);
  git(sibling.path, ['add', `${slug}.txt`]);
  git(sibling.path, ['commit', '-m', `${slug} feature`]);
  git(f.main, ['merge', '--no-ff', sibling.branch, '-m', `merge ${slug}`]);
  return { sibling, mergeCommit: git(f.main, ['rev-parse', 'HEAD']) };
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
        github: mergedPr(f, mergeCommit, { headRefOid: '0'.repeat(40) }),
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_PR_HEAD_MISMATCH',
    );
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

test('[req:PROV-4] a foreign active context is a blocking mismatch and is never closed by cleanup', async () => {
  const f = fixture('foreign-context');
  try {
    const repository = discoverWorktreeRepository({ startDir: f.main });
    const registry = readWorktreeRegistry(repository).registry;
    const foreign = {
      project_id: 'foreign-project',
      repository_id: 'foreign-repository',
      worktree_id: f.worktree.worktreeId,
      work_session_id: 'foreign-session',
      branch: f.worktree.branch,
      head_sha: f.worktree.head,
      change_slug: 'foreign-change',
      state: 'active', revision: 1, updated_at: '2026-08-22T12:00:00.000Z',
    };
    writeSessionRegistry(f.vault, {
      version: 2,
      sessions: { foreign: { status: 'active', work_session_id: foreign.work_session_id } },
      active_contexts_schema: 1,
      active_contexts_revision: 1,
      active_contexts: { foreign: foreign },
    });
    const report = inspectWorktreeCleanup({ startDir: f.main, slug: f.slug });
    assert.ok(report.blockers.some((item) => item.code === 'WENDKEEP_WORKTREE_CONTEXT_MISMATCH'));
    await assert.rejects(
      removeManagedWorktree({ startDir: f.main, slug: f.slug, reason: 'foreign context' }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_CONTEXT_MISMATCH',
    );
    assert.equal(readSessionRegistry(f.vault).active_contexts.foreign.state, 'active');
    assert.equal(readSessionRegistry(f.vault).active_contexts.foreign.project_id, 'foreign-project');
    assert.equal(readWorktreeRegistry(repository).registry.entries[f.slug].state, 'ready');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:WT-13] finish removes a merged worktree, closes only its context and appends one idempotent receipt', async () => {
  const f = fixture('finish');
  try {
    const { head, mergeCommit } = mergedFeature(f);
    const repository = discoverWorktreeRepository({ startDir: f.main });
    const registry = readWorktreeRegistry(repository).registry;
    const legacyPath = cleanupReceiptLegacyPath(repository);
    const priorReceipt = `${JSON.stringify({ id: 'prior-receipt', slug: 'sibling', outcome: 'completed' })}\n`;
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, priorReceipt);
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
    const targetSecondary = {
      ...target,
      work_session_id: 'work-target-secondary',
      change_slug: 'finish-change-secondary',
      revision: 1,
    };
    writeSessionRegistry(f.vault, {
      version: 2,
      sessions: {},
      active_contexts_schema: 1,
      active_contexts_revision: 2,
      active_contexts: {
        [activeContextKey(target)]: target,
        [activeContextKey(targetSecondary)]: targetSecondary,
        [activeContextKey(sibling)]: sibling,
      },
    });
    const first = await finishManagedWorktree({
      startDir: f.main, slug: 'finish', pullRequest: '72', github: mergedPr(f, mergeCommit),
      actorContext: 'actor-finish',
      now: () => '2026-08-22T13:00:00.000Z',
    });
    assert.equal(first.state, 'completed');
    assert.equal(first.idempotent, false);
    assert.equal(first.receipt.project_id, registry.projectId);
    assert.equal(first.receipt.worktree_id, f.worktree.worktreeId);
    assert.equal(first.receipt.work_session_id, 'work-target');
    assert.equal(first.receipt.change_slug, 'finish-change');
    assert.equal(first.receipt.authority, 'acme/repo#72');
    assert.equal(first.receipt.pull_request_repository, 'acme/repo');
    assert.equal(first.receipt.pull_request_number, '72');
    assert.equal(first.receipt.head_ref_oid, head);
    assert.equal(first.receipt.merge_commit_oid, mergeCommit);
    assert.deepEqual(first.receipt.target_context_ids, [
      activeContextKey(target), activeContextKey(targetSecondary),
    ].sort());
    assert.deepEqual(first.receipt.target_change_slugs, [
      'finish-change', 'finish-change-secondary',
    ]);
    assert.equal(first.receipt.actor_context_id, 'actor-finish');
    assert.equal(existsSync(f.worktree.path), false);
    assert.equal(git(f.main, ['branch', '--list', f.worktree.branch]), '');
    const contexts = readSessionRegistry(f.vault).active_contexts;
    assert.equal(contexts[activeContextKey(target)].state, 'closed');
    assert.equal(contexts[activeContextKey(targetSecondary)].state, 'closed');
    assert.equal(contexts[activeContextKey(sibling)].state, 'active');
    const receiptLines = readFileSync(cleanupReceiptPath(repository), 'utf8').trim().split(/\r?\n/);
    assert.equal(receiptLines.length, 1);
    assert.equal(JSON.parse(receiptLines[0]).claims.pull_request.number, 72);
    assert.equal(readFileSync(legacyPath, 'utf8'), priorReceipt);
    assert.equal(readFileSync(evidencePath, 'utf8'), 'historical evidence\n');
    assert.equal(git(f.main, ['worktree', 'list', '--porcelain']).includes(f.worktree.path), false);
    assert.equal(git(f.main, ['worktree', 'prune', '--dry-run', '--verbose']), '');

    const second = await finishManagedWorktree({
      startDir: f.main, slug: 'finish', pullRequest: '72', github: mergedPr(f, mergeCommit),
    });
    assert.equal(second.idempotent, true);
    assert.equal(readFileSync(cleanupReceiptPath(repository), 'utf8').trim().split(/\r?\n/).length, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-2] cleanup keeps the v1 receipt ledger as a read-only legacy anchor', async () => {
  const f = fixture('legacy-anchor');
  try {
    const { mergeCommit } = mergedFeature(f);
    const repository = discoverWorktreeRepository({ startDir: f.main });
    const legacyPath = cleanupReceiptLegacyPath(repository);
    const legacyBytes = `${JSON.stringify({
      schemaVersion: 1,
      id: 'legacy-foreign-receipt',
      repository_id: 'foreign-repository',
      slug: f.slug,
      mode: 'finish',
      outcome: 'completed',
      branch: 'wk/foreign-branch',
      head: '0'.repeat(40),
    })}\n`;
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, legacyBytes);

    const completed = await finishManagedWorktree({
      startDir: f.main,
      slug: f.slug,
      pullRequest: '72',
      github: mergedPr(f, mergeCommit),
    });

    assert.equal(completed.idempotent, false);
    assert.equal(existsSync(f.worktree.path), false);
    assert.equal(readFileSync(legacyPath, 'utf8'), legacyBytes);
    assert.notEqual(cleanupReceiptPath(repository), legacyPath);
    assert.equal(existsSync(cleanupReceiptPath(repository)), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-7] an intermediate cleanup receipt tamper blocks cleanup before removal and finalize', async () => {
  const f = fixture('tamper-ledger');
  try {
    const { mergeCommit: firstMerge } = mergedFeature(f);
    const first = await finishManagedWorktree({
      startDir: f.main,
      slug: f.slug,
      pullRequest: '72',
      github: mergedPr(f, firstMerge),
    });
    assert.equal(first.idempotent, false);

    const second = mergedSibling(f, 'tamper-ledger-second');
    const secondFixture = {
      ...f,
      slug: 'tamper-ledger-second',
      worktree: second.sibling,
    };
    const receiptPath = cleanupReceiptPath(discoverWorktreeRepository({ startDir: f.main }));
    const lines = readFileSync(receiptPath, 'utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, 1);

    // Keep a valid first record while introducing a second record through the product path.
    await finishManagedWorktree({
      startDir: f.main,
      slug: secondFixture.slug,
      pullRequest: '72',
      github: mergedPr(secondFixture, second.mergeCommit),
    });
    const twoReceipts = readFileSync(receiptPath, 'utf8').trim().split(/\r?\n/);
    assert.equal(twoReceipts.length, 2);
    const tampered = JSON.parse(twoReceipts[0]);
    tampered.slug = 'foreign-worktree';
    twoReceipts[0] = JSON.stringify(tampered);
    writeFileSync(receiptPath, `${twoReceipts.join('\n')}\n`);

    const third = mergedSibling(f, 'tamper-ledger-third');
    const thirdFixture = { ...f, slug: 'tamper-ledger-third', worktree: third.sibling };
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: thirdFixture.slug,
        pullRequest: '72',
        github: mergedPr(thirdFixture, third.mergeCommit),
      }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CORRUPT',
    );
    assert.equal(existsSync(third.sibling.path), true);
    assert.equal(
      readWorktreeRegistry(discoverWorktreeRepository({ startDir: f.main }))
        .registry.entries[thirdFixture.slug].state,
      'ready',
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-7] cleanup checkpoint detects a truncated receipt tail and prevents finalize', async () => {
  const f = fixture('truncated-ledger');
  try {
    const { mergeCommit } = mergedFeature(f);
    await finishManagedWorktree({
      startDir: f.main,
      slug: f.slug,
      pullRequest: '72',
      github: mergedPr(f, mergeCommit),
    });
    const second = mergedSibling(f, 'truncated-ledger-second');
    const repository = discoverWorktreeRepository({ startDir: f.main });
    const receiptPath = cleanupReceiptPath(repository);
    const checkpointPath = `${receiptPath}.checkpoint.json`;
    assert.equal(existsSync(checkpointPath), true);
    writeFileSync(receiptPath, '');

    const third = mergedSibling(f, 'truncated-ledger-third');
    const thirdFixture = { ...f, slug: 'truncated-ledger-third', worktree: third.sibling };
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: thirdFixture.slug,
        pullRequest: '72',
        github: mergedPr(thirdFixture, third.mergeCommit),
      }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_TRUNCATED',
    );
    assert.equal(existsSync(third.sibling.path), true);
    assert.equal(
      readWorktreeRegistry(repository).registry.entries[thirdFixture.slug].state,
      'ready',
    );
    assert.equal(readFileSync(checkpointPath, 'utf8').length > 0, true);
    // The valid receipt history remains recoverable; cleanup did not rewrite it.
    assert.equal(readFileSync(receiptPath, 'utf8'), '');
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
      headRefOid: git(f.main, [
        'rev-parse', '--verify', `refs/heads/${entry.branch}`,
      ], { ok: false }),
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

test('[req:PROV-7] prune --apply validates the receipt ledger before mutating git metadata', () => {
  const f = fixture('prune-invalid-ledger');
  try {
    const repository = discoverWorktreeRepository({ startDir: f.main });
    rmSync(f.worktree.path, { recursive: true, force: true });
    mkdirSync(dirname(cleanupReceiptPath(repository)), { recursive: true });
    writeFileSync(cleanupReceiptPath(repository), '{"schema_version":2,"sequence":1}\n');
    const before = git(f.main, ['worktree', 'list', '--porcelain']);
    assert.throws(
      () => pruneManagedWorktrees({ startDir: f.main, apply: true }),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_TRUNCATED',
    );
    assert.equal(
      diagnoseManagedWorktreeCleanups({ startDir: f.main }).issues[0].errorCode,
      'WENDKEEP_RECEIPT_LEDGER_TRUNCATED',
    );
    assert.equal(git(f.main, ['worktree', 'list', '--porcelain']), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:WT-15] interrupted cleanup resumes only after the path vanished and concurrent cleanup stays blocked', async () => {
  const crashed = fixture('crashed');
  try {
    const { head, mergeCommit } = mergedFeature(crashed);
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
        pullRequest: {
          number: 72,
          url: 'https://github.com/acme/repo/pull/72',
          state: 'MERGED',
          mergedAt: '2026-08-22T12:00:00.000Z',
          headRefName: crashed.worktree.branch,
          headRefOid: head,
          baseRefName: 'main',
          mergeCommitOid: mergeCommit,
          isCrossRepository: false,
        },
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
    assert.equal(
      readSessionRegistry(crashed.vault).sessions.crashed.status,
      'done',
      'retry sem path deve fechar a sessão causal, não apenas o active context',
    );
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

test('[req:PROV-4] an orphaned reservation with a dead owner resumes before path removal', async () => {
  const f = fixture('orphaned-reservation');
  try {
    const { head, mergeCommit } = mergedFeature(f);
    const repository = discoverWorktreeRepository({ startDir: f.main });
    mutateWorktreeRegistry(repository, (registry) => {
      registry.entries[f.slug] = {
        ...registry.entries[f.slug],
        state: 'cleaning',
        pullRequest: {
          number: 72,
          url: 'https://github.com/acme/repo/pull/72',
          state: 'MERGED',
          mergedAt: '2026-08-22T12:00:00.000Z',
          headRefName: f.worktree.branch,
          headRefOid: head,
          baseRefName: 'main',
          mergeCommitOid: mergeCommit,
          isCrossRepository: false,
        },
        cleanup: {
          schemaVersion: 1,
          operationId: 'orphaned-operation',
          ownerPid: 999999,
          state: 'cleaning',
          mode: 'finish',
          authority: 'acme/repo#72',
          startedAt: '2026-08-22T12:00:00.000Z',
        },
      };
      return registry;
    });
    const resumed = await finishManagedWorktree({
      startDir: f.main,
      slug: f.slug,
      github: async () => { throw new Error('orphan retry must use reserved proof'); },
    });
    assert.equal(resumed.state, 'completed');
    assert.equal(resumed.receipt.operationId, 'orphaned-operation');
    assert.equal(existsSync(f.worktree.path), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
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

test('[req:PROV-8] cleanup diagnostics redact stderr secrets, paths and shell metacharacters', async () => {
  const f = fixture('sanitize-cleanup');
  try {
    const { mergeCommit } = mergedFeature(f);
    let failed = false;
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const privatePath = 'C:\\Users\\Roger Alves\\private\\token.txt';
    const failingSpawn = (command, args, options) => {
      if (!failed && command === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        failed = true;
        return {
          status: 1,
          stdout: '',
          stderr: `fatal: ${privatePath}; token=${secret} && echo 'leak'`,
        };
      }
      return spawnSync(command, args, options);
    };
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        pullRequest: '72',
        github: mergedPr(f, mergeCommit),
        spawn: failingSpawn,
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_GIT_FAILED',
    );
    const entry = readWorktreeRegistry(
      discoverWorktreeRepository({ startDir: f.main }),
    ).registry.entries[f.slug];
    const diagnostic = `${entry.cleanup.error.message}\n${entry.cleanup.error.code}`;
    assert.doesNotMatch(diagnostic, /ghp_|token=|C:\\Users|[;&|`$]/);
    assert.match(diagnostic, /WENDKEEP_WORKTREE_GIT_FAILED/);
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

test('[req:PROV-4] cleanup retries append/finalize faults with the reserved operation and no PR re-fetch', async () => {
  for (const phase of ['beforeAppend', 'afterAppend', 'beforeFinalize', 'afterFinalize']) {
    const f = fixture(`fault-${phase.toLowerCase()}`);
    try {
      const { mergeCommit } = mergedFeature(f);
      let injected = true;
      await assert.rejects(
        finishManagedWorktree({
          startDir: f.main,
          slug: f.slug,
          pullRequest: '72',
          github: mergedPr(f, mergeCommit),
          faultInjection: {
            [phase]: () => {
              if (injected) {
                injected = false;
                throw new Error(`fault ${phase}`);
              }
            },
          },
        }),
      );
      const repository = discoverWorktreeRepository({ startDir: f.main });
      const failed = readWorktreeRegistry(repository).registry.entries[f.slug];
      const operationId = failed.cleanup.operationId;
      assert.ok(operationId);
      assert.equal(failed.cleanup.state, phase === 'afterFinalize' ? 'completed' : 'failed');
      assert.equal(
        readSessionRegistry(f.vault).cleanup_reservations?.[`${failed.cleanup.repositoryId}:${failed.cleanup.worktreeId}`]?.operation_id,
        operationId,
      );
      const retried = await finishManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        github: async () => { throw new Error('PR re-fetch must not occur'); },
      });
      assert.equal(retried.state, 'completed');
      assert.equal(retried.receipt.operationId, operationId);
      assert.equal(readWorktreeRegistry(repository).registry.entries[f.slug].state, 'cleaned');
      assert.equal(readSessionRegistry(f.vault).cleanup_reservations, undefined);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
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

test('[req:PROV-2] diagnostics expose v1 cleanup receipts as legacy-unbound without rewriting them', () => {
  const f = fixture('legacy-diagnostic');
  try {
    const repository = discoverWorktreeRepository({ startDir: f.main });
    const legacyPath = cleanupReceiptLegacyPath(repository);
    const legacyBytes = `${JSON.stringify({
      schemaVersion: 1,
      id: 'legacy-cleanup',
      slug: f.slug,
      mode: 'finish',
      outcome: 'completed',
      branch: f.worktree.branch,
      head: f.worktree.head,
    })}\n`;
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, legacyBytes);
    mutateWorktreeRegistry(repository, (registry) => {
      registry.entries[f.slug] = {
        ...registry.entries[f.slug],
        state: 'cleaned',
        cleanup: {
          schemaVersion: 1,
          state: 'completed',
          mode: 'finish',
          receiptId: 'legacy-cleanup',
        },
      };
      return registry;
    });
    const report = diagnoseManagedWorktreeCleanups({ startDir: f.main });
    assert.ok(report.issues.some((item) => (
      item.slug === f.slug
      && item.state === 'legacy-unbound'
      && item.errorCode === 'WENDKEEP_WORKTREE_CLEANUP_RECEIPT_LEGACY_UNBOUND'
    )));
    assert.equal(readFileSync(legacyPath, 'utf8'), legacyBytes);
    assert.equal(existsSync(cleanupReceiptPath(repository)), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-2] empty or corrupt v1 anchors never authorize a cleaned worktree', () => {
  for (const [slug, bytes] of [
    ['legacy-empty', ''],
    ['legacy-corrupt', '{not-json\n'],
  ]) {
    const f = fixture(slug);
    try {
      const repository = discoverWorktreeRepository({ startDir: f.main });
      const legacyPath = cleanupReceiptLegacyPath(repository);
      mkdirSync(dirname(legacyPath), { recursive: true });
      writeFileSync(legacyPath, bytes, 'utf8');
      mutateWorktreeRegistry(repository, (registry) => {
        registry.entries[slug] = {
          ...registry.entries[slug],
          state: 'cleaned',
          cleanup: {
            schemaVersion: 1, mode: 'finish', receiptId: 'legacy-unbound-proof',
          },
        };
        return registry;
      });
      const issue = diagnoseManagedWorktreeCleanups({ startDir: f.main }).issues[0];
      assert.equal(issue.errorCode, 'WENDKEEP_WORKTREE_CLEANUP_RECEIPT_MISSING');
      assert.notEqual(issue.state, 'legacy-unbound');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('[req:PROV-2] completed cleanup receipts use the common provenance gate for registry drift', async () => {
  const f = fixture('receipt-gate-drift');
  try {
    const { mergeCommit } = mergedFeature(f);
    await finishManagedWorktree({
      startDir: f.main,
      slug: f.slug,
      pullRequest: '72',
      github: mergedPr(f, mergeCommit),
    });
    const repository = discoverWorktreeRepository({ startDir: f.main });
    mutateWorktreeRegistry(repository, (registry) => {
      registry.entries[f.slug] = {
        ...registry.entries[f.slug],
        worktreeId: 'foreign-worktree',
        cleanup: { ...registry.entries[f.slug].cleanup, worktreeId: 'foreign-worktree' },
      };
      return registry;
    });
    const diagnosis = diagnoseManagedWorktreeCleanups({ startDir: f.main });
    assert.equal(diagnosis.issues[0].errorCode, 'WENDKEEP_PROVENANCE_GATE_BLOCKED');
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        github: async () => { throw new Error('drift must block before PR proof'); },
      }),
      (error) => error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED',
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-2] initial cleanup requires the common gate before its first registry or Git mutation', async () => {
  const f = fixture('pre-mutation-gate');
  try {
    const { mergeCommit } = mergedFeature(f);
    const calls = [];
    const recordingSpawn = (command, args, options) => {
      calls.push([command, ...args]);
      return spawnSync(command, args, options);
    };
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        pullRequest: '72',
        github: mergedPr(f, mergeCommit),
        spawn: recordingSpawn,
        provenanceGate: () => ({
          ok: false,
          state: 'conflict',
          reasonCodes: ['WENDKEEP_PROVENANCE_CONTEXT_MISMATCH'],
          diagnostics: [{
            blocker: 'WENDKEEP_PROVENANCE_CONTEXT_MISMATCH',
            expected: { project_id: 'fixture' },
            observed: { project_id: 'foreign' },
          }],
          repair: { command: 'wendkeep verify --deep' },
        }),
      }),
      (error) => error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED',
    );
    assert.equal(existsSync(f.worktree.path), true);
    assert.equal(calls.some((args) => args[0] === 'git' && args[1] === 'worktree'
      && args[2] === 'remove'), false);
    assert.equal(readWorktreeRegistry(
      discoverWorktreeRepository({ startDir: f.main }),
    ).registry.entries[f.slug].state, 'ready');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-2] newly appended receipt is classified before finalize', async () => {
  const f = fixture('receipt-before-finalize-gate');
  try {
    const { mergeCommit } = mergedFeature(f);
    let classified = 0;
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        pullRequest: '72',
        github: mergedPr(f, mergeCommit),
        receiptClassifier: () => {
          classified += 1;
          return {
            kind: 'worktree-cleanup',
            ok: false,
            state: 'conflict',
            reasonCodes: ['PROV_RECEIPT_CONFLICT'],
            diagnostics: [{ blocker: 'PROV_RECEIPT_CONFLICT' }],
          };
        },
      }),
      (error) => error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED',
    );
    assert.equal(classified, 1);
    assert.equal(existsSync(f.worktree.path), false);
    assert.equal(readWorktreeRegistry(
      discoverWorktreeRepository({ startDir: f.main }),
    ).registry.entries[f.slug].cleanup.state, 'failed');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-2] cleaned state without a v2 receipt is a structured provenance block', async () => {
  const f = fixture('cleaned-without-receipt');
  try {
    const repository = discoverWorktreeRepository({ startDir: f.main });
    mutateWorktreeRegistry(repository, (registry) => {
      registry.entries[f.slug] = {
        ...registry.entries[f.slug],
        state: 'cleaned',
        cleanup: { schemaVersion: 1, mode: 'finish', receiptId: 'missing-receipt' },
      };
      return registry;
    });
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        github: async () => { throw new Error('missing receipt must block before PR proof'); },
      }),
      (error) => error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED'
        && error?.state === 'unproven',
    );
    const result = await cleanupMergedWorktrees({ startDir: f.main, apply: true });
    assert.equal(result.ok, false);
    assert.equal(result.actions[0].outcome, 'blocked');
    assert.equal(result.actions[0].blockers[0], 'WENDKEEP_PROVENANCE_GATE_BLOCKED');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-4] a context added after the cleanup gate blocks removal and retry stays causal', async () => {
  for (const mode of ['finish', 'remove']) {
    const f = fixture(`context-race-${mode}`);
    try {
      const merged = mode === 'finish' ? mergedFeature(f) : null;
      const repository = discoverWorktreeRepository({ startDir: f.main });
      const initialRegistry = readWorktreeRegistry(repository).registry;
      const target = {
        project_id: initialRegistry.projectId,
        repository_id: initialRegistry.repositoryId,
        worktree_id: f.worktree.worktreeId,
        work_session_id: `session-${mode}-target`,
        branch: f.worktree.branch,
        head_sha: merged?.head || f.worktree.head,
        change_slug: `change-${mode}-target`,
        state: 'active',
        revision: 1,
        updated_at: '2026-08-23T12:00:00.000Z',
      };
      const late = {
        ...target,
        work_session_id: `session-${mode}-late`,
        change_slug: `change-${mode}-late`,
      };
      writeSessionRegistry(f.vault, {
        version: 2,
        sessions: {},
        active_contexts_schema: 1,
        active_contexts_revision: 1,
        active_contexts: { [activeContextKey(target)]: target },
      });
      let injected = false;
      const gate = () => {
        if (!injected) {
          injected = true;
          const current = readSessionRegistry(f.vault);
          writeSessionRegistry(f.vault, {
            ...current,
            active_contexts: {
              ...current.active_contexts,
              [activeContextKey(late)]: late,
            },
          });
        }
        return { ok: true, state: 'verified', reasonCodes: [], diagnostics: [] };
      };
      const first = mode === 'finish'
        ? finishManagedWorktree({
          startDir: f.main, slug: f.slug, pullRequest: '72',
          github: mergedPr(f, merged.mergeCommit), provenanceGate: gate,
        })
        : removeManagedWorktree({
          startDir: f.main, slug: f.slug, reason: 'context race', provenanceGate: gate,
        });
      await assert.rejects(
        first,
        (error) => error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED'
          && error?.blocker === 'WENDKEEP_PROVENANCE_CONTEXT_MISMATCH',
      );
      assert.equal(existsSync(f.worktree.path), true);
      const failed = readWorktreeRegistry(repository).registry.entries[f.slug];
      assert.equal(failed.cleanup.state, 'failed');
      assert.equal(existsSync(cleanupReceiptPath(repository)), false);
      assert.equal(readSessionRegistry(f.vault).active_contexts[activeContextKey(late)].state, 'active');

      const repaired = readSessionRegistry(f.vault);
      delete repaired.active_contexts[activeContextKey(late)];
      writeSessionRegistry(f.vault, repaired);
      const retry = mode === 'finish'
        ? await finishManagedWorktree({
          startDir: f.main, slug: f.slug, github: mergedPr(f, merged.mergeCommit),
        })
        : await removeManagedWorktree({ startDir: f.main, slug: f.slug, reason: 'context race' });
      assert.equal(retry.state, 'completed');
      assert.equal(retry.idempotent, false);
      const again = mode === 'finish'
        ? await finishManagedWorktree({
          startDir: f.main, slug: f.slug, github: mergedPr(f, merged.mergeCommit),
        })
        : await removeManagedWorktree({ startDir: f.main, slug: f.slug, reason: 'context race' });
      assert.equal(again.idempotent, true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('[req:PROV-4] a context introduced before finalize cannot survive a removed worktree', async () => {
  const f = fixture('context-before-finalize');
  try {
    const { head, mergeCommit } = mergedFeature(f);
    const repository = discoverWorktreeRepository({ startDir: f.main });
    const registry = readWorktreeRegistry(repository).registry;
    const target = {
      project_id: registry.projectId,
      repository_id: registry.repositoryId,
      worktree_id: f.worktree.worktreeId,
      work_session_id: 'session-before-finalize-target',
      branch: f.worktree.branch,
      head_sha: head,
      change_slug: 'change-before-finalize-target',
      state: 'active', revision: 1, updated_at: '2026-08-23T12:00:00.000Z',
    };
    const late = {
      ...target,
      work_session_id: 'session-before-finalize-late',
      change_slug: 'change-before-finalize-late',
    };
    writeSessionRegistry(f.vault, {
      version: 2,
      sessions: {},
      active_contexts_schema: 1,
      active_contexts_revision: 1,
      active_contexts: { [activeContextKey(target)]: target },
    });
    let injected = false;
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        pullRequest: '72',
        github: mergedPr(f, mergeCommit),
        faultInjection: {
          beforeFinalize: () => {
            if (injected) return;
            injected = true;
            mutateActiveContext(f.vault, late, (current) => ({
              ...current,
              change_slug: late.change_slug,
              state: 'active',
            }), { projectLegacy: false });
          },
        },
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_RESERVED',
    );
    assert.equal(existsSync(f.worktree.path), false);
    assert.equal(readWorktreeRegistry(repository).registry.entries[f.slug].cleanup.state, 'failed');
    assert.equal(readSessionRegistry(f.vault).active_contexts[activeContextKey(late)], undefined);

    const repaired = readSessionRegistry(f.vault);
    delete repaired.active_contexts[activeContextKey(late)];
    writeSessionRegistry(f.vault, repaired);
    const retry = await finishManagedWorktree({
      startDir: f.main, slug: f.slug, github: mergedPr(f, mergeCommit),
    });
    assert.equal(retry.state, 'completed');
    assert.equal(retry.idempotent, false);
    const again = await finishManagedWorktree({
      startDir: f.main, slug: f.slug, github: mergedPr(f, mergeCommit),
    });
    assert.equal(again.idempotent, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-4] cleanup reservation blocks context creation before path removal and preserves retry identity', async () => {
  for (const mode of ['finish', 'remove']) {
    const f = fixture(`reserved-context-${mode}`);
    try {
      const merged = mode === 'finish' ? mergedFeature(f) : null;
      const repository = discoverWorktreeRepository({ startDir: f.main });
      const registry = readWorktreeRegistry(repository).registry;
      const target = {
        project_id: registry.projectId,
        repository_id: registry.repositoryId,
        worktree_id: f.worktree.worktreeId,
        work_session_id: `reserved-${mode}-target`,
        branch: f.worktree.branch,
        head_sha: merged?.head || f.worktree.head,
        change_slug: `reserved-${mode}-target`,
        state: 'active', revision: 1, updated_at: '2026-08-23T12:00:00.000Z',
      };
      const late = {
        ...target,
        work_session_id: `reserved-${mode}-late`,
        change_slug: `reserved-${mode}-late`,
      };
      writeSessionRegistry(f.vault, {
        version: 2,
        sessions: {},
        active_contexts_schema: 1,
        active_contexts_revision: 1,
        active_contexts: { [activeContextKey(target)]: target },
      });
      let attempted = false;
      const first = mode === 'finish'
        ? finishManagedWorktree({
          startDir: f.main, slug: f.slug, pullRequest: '72',
          github: mergedPr(f, merged.mergeCommit),
          faultInjection: {
            beforePathRemoval: () => {
              attempted = true;
              mutateActiveContext(f.vault, late, (current) => ({
                ...current, change_slug: late.change_slug, state: 'active',
              }), { projectLegacy: false });
            },
          },
        })
        : removeManagedWorktree({
          startDir: f.main, slug: f.slug, reason: 'reserved context',
          faultInjection: {
            beforePathRemoval: () => {
              attempted = true;
              mutateActiveContext(f.vault, late, (current) => ({
                ...current, change_slug: late.change_slug, state: 'active',
              }), { projectLegacy: false });
            },
          },
        });
      let firstError;
      await assert.rejects(first, (error) => {
        firstError = error;
        return error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_RESERVED';
      });
      assert.equal(attempted, true);
      assert.equal(existsSync(f.worktree.path), true);
      assert.equal(readSessionRegistry(f.vault).active_contexts[activeContextKey(late)], undefined);
      assert.equal(readSessionRegistry(f.vault).cleanup_reservations, undefined);
      const failed = readWorktreeRegistry(repository).registry.entries[f.slug];
      assert.equal(failed.cleanup.state, 'failed');
      assert.ok(firstError.operationId);

      const retry = mode === 'finish'
        ? await finishManagedWorktree({
          startDir: f.main, slug: f.slug, github: mergedPr(f, merged.mergeCommit),
        })
        : await removeManagedWorktree({ startDir: f.main, slug: f.slug, reason: 'reserved context' });
      assert.equal(retry.state, 'completed');
      assert.equal(retry.idempotent, false);
      assert.equal(retry.receipt.operationId, firstError.operationId);
      assert.deepEqual(retry.receipt.target_context_ids, [activeContextKey(target)]);
      assert.equal(retry.receipt.work_session_id, target.work_session_id);
      assert.equal(retry.receipt.change_slug, target.change_slug);
      assert.equal(readFileSync(cleanupReceiptPath(repository), 'utf8').trim().split(/\r?\n/).length, 1);
      const again = mode === 'finish'
        ? await finishManagedWorktree({ startDir: f.main, slug: f.slug, github: mergedPr(f, merged.mergeCommit) })
        : await removeManagedWorktree({ startDir: f.main, slug: f.slug, reason: 'reserved context' });
      assert.equal(again.idempotent, true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('[req:PROV-4] an orphaned cleanup reservation is adopted before worktree reservation', async () => {
  const f = fixture('orphaned-reservation');
  try {
    const { head, mergeCommit } = mergedFeature(f);
    const repository = discoverWorktreeRepository({ startDir: f.main });
    const report = inspectWorktreeCleanup({ startDir: f.main, slug: f.slug });
    reserveActiveContextCleanup(f.vault, {
      operationId: 'orphaned-cleanup-operation',
      projectId: report.registry.projectId,
      repositoryId: report.registry.repositoryId,
      worktreeId: report.entry.worktreeId,
      worktreePath: report.entry.path,
      mode: 'finish',
      authority: 'acme/repo#72',
      head,
      slug: f.slug,
      pullRequestNumber: '72',
      pullRequestRepository: 'acme/repo',
      headRefOid: head,
      mergeCommitOid: mergeCommit,
      ownerPid: 999999,
      phase: 'reserved-before-worktree',
    });

    const result = await finishManagedWorktree({
      startDir: f.main,
      slug: f.slug,
      pullRequest: '72',
      github: mergedPr(f, mergeCommit),
    });
    assert.equal(result.state, 'completed');
    assert.equal(result.receipt.operationId, 'orphaned-cleanup-operation');
    assert.equal(readFileSync(cleanupReceiptPath(repository), 'utf8').trim().split(/\r?\n/).length, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-4] a cleaned worktree leaves a terminal barrier for late contexts and sessions', async () => {
  const f = fixture('terminal-barrier');
  try {
    const { mergeCommit } = mergedFeature(f);
    const repository = discoverWorktreeRepository({ startDir: f.main });
    await finishManagedWorktree({
      startDir: f.main,
      slug: f.slug,
      pullRequest: '72',
      github: mergedPr(f, mergeCommit),
    });
    const registry = readWorktreeRegistry(repository).registry;
    const late = {
      project_id: registry.projectId,
      repository_id: registry.repositoryId,
      worktree_id: f.worktree.worktreeId,
      work_session_id: 'late-terminal-session',
      branch: f.worktree.branch,
      head_sha: f.worktree.head,
    };
    assert.throws(
      () => mutateActiveContext(f.vault, late, (current) => ({
        ...current, change_slug: 'late-terminal-change', state: 'active',
      }), { projectLegacy: false }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_TERMINAL',
    );
    assert.throws(
      () => upsertSessionRegistry(f.vault, 'late-terminal-session', {
        status: 'active',
        work_session_id: late.work_session_id,
        project_scope: { complete: true, repoRoot: f.worktree.path },
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_TERMINAL',
    );
    assert.equal(readSessionRegistry(f.vault).active_contexts, undefined);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-4] finalize uses operation and subject CAS before marking cleaned', async () => {
  const f = fixture('finalize-cas');
  try {
    const { mergeCommit } = mergedFeature(f);
    const repository = discoverWorktreeRepository({ startDir: f.main });
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        pullRequest: '72',
        github: mergedPr(f, mergeCommit),
        faultInjection: {
          beforeFinalize: () => {
            mutateWorktreeRegistry(repository, (registry) => {
              const entry = registry.entries[f.slug];
              registry.entries[f.slug] = {
                ...entry,
                cleanup: { ...entry.cleanup, operationId: 'foreign-operation' },
              };
              return registry;
            });
          },
        },
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_CLEANUP_CAS_CONFLICT',
    );
    const entry = readWorktreeRegistry(repository).registry.entries[f.slug];
    assert.notEqual(entry.state, 'cleaned');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-4] finalize subject CAS rederives identity instead of trusting operation id', async () => {
  const f = fixture('finalize-subject-cas');
  try {
    const { mergeCommit } = mergedFeature(f);
    const repository = discoverWorktreeRepository({ startDir: f.main });
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        pullRequest: '72',
        github: mergedPr(f, mergeCommit),
        faultInjection: {
          beforeFinalize: () => {
            mutateWorktreeRegistry(repository, (registry) => {
              const entry = registry.entries[f.slug];
              registry.entries[f.slug] = {
                ...entry,
                path: `${entry.path}-tampered`,
                branch: `${entry.branch}-tampered`,
                cleanup: { ...entry.cleanup, head: 'tampered-head' },
              };
              return registry;
            });
          },
        },
      }),
      (error) => error?.code === 'WENDKEEP_WORKTREE_CLEANUP_CAS_CONFLICT',
    );
    assert.notEqual(readWorktreeRegistry(repository).registry.entries[f.slug].state, 'cleaned');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-4] finalize and terminal reject a stale same-operation attempt owner', async () => {
  const f = fixture('finalize-owner-cas');
  try {
    const { mergeCommit } = mergedFeature(f);
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        pullRequest: '72',
        github: mergedPr(f, mergeCommit),
        faultInjection: {
          beforeFinalize: ({ operationId }) => {
            mutateSessionRegistry(f.vault, (registry) => {
              const key = Object.keys(registry.cleanup_reservations || {})[0];
              registry.cleanup_reservations[key] = {
                ...registry.cleanup_reservations[key],
                attempt_token: 'stale-owner-token',
              };
              return registry;
            }, { cleanupOperationId: operationId });
          },
        },
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_BUSY',
    );
    assert.notEqual(
      readWorktreeRegistry(discoverWorktreeRepository({ startDir: f.main }))
        .registry.entries[f.slug].state,
      'cleaned',
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-4] orphan adoption rejects actor and target snapshot drift', async () => {
  const f = fixture('orphaned-subject-mismatch');
  try {
    const { head, mergeCommit } = mergedFeature(f);
    const repository = discoverWorktreeRepository({ startDir: f.main });
    const report = inspectWorktreeCleanup({ startDir: f.main, slug: f.slug });
    reserveActiveContextCleanup(f.vault, {
      operationId: 'orphaned-subject-operation',
      projectId: report.registry.projectId,
      repositoryId: report.registry.repositoryId,
      worktreeId: report.entry.worktreeId,
      worktreePath: report.entry.path,
      mode: 'finish',
      authority: 'acme/repo#72',
      head,
      slug: f.slug,
      ownerPid: 999999,
      actorContextId: 'foreign-actor',
      targetContextIds: ['foreign-target'],
      targetChangeSlugs: ['foreign-change'],
      allowClosedContexts: true,
      phase: 'reserved-before-worktree',
    });
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        pullRequest: '72',
        github: mergedPr(f, mergeCommit),
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_BUSY',
    );
    assert.equal(existsSync(cleanupReceiptPath(repository)), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-4] an empty first subject stays frozen across retry', async () => {
  const f = fixture('empty-subject-retry');
  try {
    const { mergeCommit } = mergedFeature(f);
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        pullRequest: '72',
        github: mergedPr(f, mergeCommit),
        actorContext: '',
        faultInjection: { beforeAppend: () => { throw new Error('empty subject retry'); } },
      }),
    );
    const repository = discoverWorktreeRepository({ startDir: f.main });
    const failed = readWorktreeRegistry(repository).registry.entries[f.slug];
    assert.equal(failed.cleanup.workSessionId, '');
    assert.equal(failed.cleanup.changeSlug, '');
    assert.deepEqual(failed.cleanup.targetContextIds, []);
    assert.deepEqual(failed.cleanup.targetChangeSlugs, []);
    assert.deepEqual(failed.cleanup.targetContextSnapshot, []);
    assert.equal(failed.cleanup.actorContextId, '');
    const retry = await finishManagedWorktree({
      startDir: f.main,
      slug: f.slug,
      actorContext: 'late-actor',
      github: async () => { throw new Error('retry must use stored proof'); },
    });
    assert.equal(retry.receipt.actor_context_id, '');
    assert.deepEqual(retry.receipt.target_context_ids, []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-4] orphan adoption rejects pull request subject drift', async () => {
  const f = fixture('orphaned-pr-subject-mismatch');
  try {
    const { head, mergeCommit } = mergedFeature(f);
    const repository = discoverWorktreeRepository({ startDir: f.main });
    const report = inspectWorktreeCleanup({ startDir: f.main, slug: f.slug });
    reserveActiveContextCleanup(f.vault, {
      operationId: 'orphaned-pr-operation',
      projectId: report.registry.projectId,
      repositoryId: report.registry.repositoryId,
      worktreeId: report.entry.worktreeId,
      worktreePath: report.entry.path,
      mode: 'finish',
      authority: 'acme/repo#72',
      head,
      slug: f.slug,
      ownerPid: 999999,
      phase: 'reserved-before-worktree',
    });
    mutateSessionRegistry(f.vault, (registry) => {
      const key = `${report.registry.repositoryId}:${report.entry.worktreeId}`;
      registry.cleanup_reservations[key] = {
        ...registry.cleanup_reservations[key],
        pull_request_number: '73',
        pull_request_repository: 'foreign/repo',
        head_ref_oid: 'foreign-head',
        merge_commit_oid: 'foreign-merge',
      };
      return registry;
    }, { cleanupOperationId: 'orphaned-pr-operation' });
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        pullRequest: '72',
        github: mergedPr(f, mergeCommit),
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_BUSY',
    );
    assert.equal(existsSync(cleanupReceiptPath(repository)), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-4] retry preserves the original actor context in the receipt subject', async () => {
  const f = fixture('actor-retry');
  try {
    const { mergeCommit } = mergedFeature(f);
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        pullRequest: '72',
        github: mergedPr(f, mergeCommit),
        actorContext: 'actor-original',
        faultInjection: { beforeFinalize: () => { throw new Error('retry actor fault'); } },
      }),
    );
    const retry = await finishManagedWorktree({
      startDir: f.main,
      slug: f.slug,
      actorContext: 'actor-retry',
      github: async () => { throw new Error('retry must use stored proof'); },
    });
    assert.equal(retry.receipt.actor_context_id, 'actor-original');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:PROV-4] retry adopts a tombstone left by a crash immediately before finalize', async () => {
  const f = fixture('tombstone-finalize-retry');
  try {
    const { mergeCommit } = mergedFeature(f);
    const repository = discoverWorktreeRepository({ startDir: f.main });
    let firstError;
    await assert.rejects(
      finishManagedWorktree({
        startDir: f.main,
        slug: f.slug,
        pullRequest: '72',
        github: mergedPr(f, mergeCommit),
        faultInjection: {
          afterTerminal: () => { throw new Error('crash after terminal tombstone'); },
        },
      }),
      (error) => {
        firstError = error;
        return error?.message.includes('crash after terminal tombstone');
      },
    );
    const firstRegistry = readSessionRegistry(f.vault);
    const [key, oldTombstone] = Object.entries(firstRegistry.cleanup_tombstones || {})[0] || [];
    assert.equal(firstError.operationId, readWorktreeRegistry(repository).registry.entries[f.slug]
      .cleanup.operationId);
    assert.ok(oldTombstone?.attempt_token);
    assert.equal(oldTombstone.operation_id, firstError.operationId);

    const retry = await finishManagedWorktree({
      startDir: f.main,
      slug: f.slug,
      github: async () => { throw new Error('retry must use stored proof'); },
    });
    assert.equal(retry.state, 'completed');
    assert.equal(retry.receipt.operationId, firstError.operationId);
    assert.equal(readFileSync(cleanupReceiptPath(repository), 'utf8').trim().split(/\r?\n/).length, 1);
    const finalTombstone = readSessionRegistry(f.vault).cleanup_tombstones?.[key];
    assert.equal(finalTombstone.operation_id, firstError.operationId);
    assert.notEqual(finalTombstone.attempt_token, oldTombstone.attempt_token);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
