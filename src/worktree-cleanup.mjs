import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  discoverWorktreeRepository,
  mutateWorktreeRegistry,
  readWorktreeRegistry,
  withWorktreeRegistryLock,
} from '../packages/vault/src/worktree-metadata.mjs';
import { readSessionRegistry } from '../hooks/obsidian-common.mjs';
import { mutateActiveContext } from '../hooks/active-context-store.mjs';

const RECEIPT_REL = 'wendkeep/worktree-cleanup-receipts-v1.jsonl';

function cleanupError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function git(cwd, args, { ok = true, spawn = spawnSync } = {}) {
  const result = spawn('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (ok && result.status !== 0) {
    throw cleanupError(
      'WENDKEEP_WORKTREE_GIT_FAILED',
      String(result.stderr || result.error?.message || `git ${args[0]} falhou`).trim(),
      { gitArgs: [...args], status: result.status },
    );
  }
  return result;
}

function comparablePath(value) {
  const normalized = resolve(String(value || '')).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function githubRepository(value) {
  const text = String(value || '').trim();
  const repository = text.match(/^https?:\/\/github\.com\/([^/]+\/[^/#?]+)(?:[/?#]|$)/i)?.[1] || '';
  return repository.replace(/\.git$/i, '').toLowerCase();
}

function originRepository(startDir, spawn) {
  const result = git(startDir, ['remote', 'get-url', 'origin'], { ok: false, spawn });
  if (result.status !== 0) return '';
  const value = String(result.stdout || '').trim();
  const repository = value.match(/github\.com[/:]([^/]+\/[^/?#]+)$/i)?.[1] || '';
  return repository.replace(/\.git$/i, '').toLowerCase();
}

function requiredEntry(repository, slug) {
  const { registry } = readWorktreeRegistry(repository);
  const entry = registry?.entries?.[slug];
  if (!entry) {
    throw cleanupError('WENDKEEP_WORKTREE_NOT_FOUND', `Worktree gerenciada não encontrada: "${slug}".`);
  }
  return { registry, entry };
}

function normalizePullRequest(value) {
  const text = String(value || '').trim();
  const number = text.match(/^\d+$/)?.[0]
    || text.match(/\/pull\/(\d+)(?:[/#?]|$)/)?.[1]
    || '';
  if (!number || Number(number) < 1) {
    throw cleanupError('WENDKEEP_WORKTREE_PR_INVALID', 'Referência de Pull Request inválida ou ausente.');
  }
  return { reference: text, number: Number(number) };
}

async function defaultGithub({ cwd, pullRequest }) {
  const result = spawnSync('gh', [
    'pr', 'view', String(pullRequest.number),
    '--json', 'number,url,state,mergedAt,headRefName,headRefOid,baseRefName,mergeCommit,isCrossRepository',
  ], { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw cleanupError(
      'WENDKEEP_WORKTREE_PR_UNAVAILABLE',
      String(result.stderr || result.error?.message || 'GitHub indisponível.').trim(),
    );
  }
  const value = JSON.parse(result.stdout || '{}');
  return { ...value, mergeCommitOid: value.mergeCommit?.oid || '' };
}

export async function verifyMergedPullRequest({
  startDir = process.cwd(),
  entry,
  pullRequest,
  github = defaultGithub,
  spawn = spawnSync,
} = {}) {
  if (!entry?.branch) {
    throw cleanupError('WENDKEEP_WORKTREE_PR_MISMATCH', 'Worktree não possui branch comprovada.');
  }
  const normalized = normalizePullRequest(pullRequest);
  const referencedRepository = githubRepository(normalized.reference);
  const localRepository = originRepository(startDir, spawn);
  if (referencedRepository && localRepository && referencedRepository !== localRepository) {
    throw cleanupError('WENDKEEP_WORKTREE_PR_MISMATCH', 'PR pertence a outro repositório.');
  }
  let value;
  try {
    value = await github({ cwd: startDir, pullRequest: normalized, entry: structuredClone(entry) });
  } catch (error) {
    if (error?.code) throw error;
    throw cleanupError('WENDKEEP_WORKTREE_PR_UNAVAILABLE', error?.message || 'GitHub indisponível.');
  }
  const returnedUrl = String(value?.url || '').trim();
  const returnedRepository = githubRepository(returnedUrl);
  let returnedPullRequest = null;
  try { returnedPullRequest = normalizePullRequest(returnedUrl); } catch { /* fail closed below */ }
  if (!returnedRepository
    || returnedPullRequest?.number !== normalized.number
    || Number(value?.number) !== normalized.number
    || (referencedRepository && referencedRepository !== returnedRepository)
    || (localRepository && localRepository !== returnedRepository)) {
    throw cleanupError('WENDKEEP_WORKTREE_PR_MISMATCH', 'PR pertence a outro repositório.');
  }
  const mergeCommitOid = String(value?.mergeCommitOid || value?.mergeCommit?.oid || '').trim();
  if (value?.state !== 'MERGED' || !value?.mergedAt || !mergeCommitOid) {
    throw cleanupError('WENDKEEP_WORKTREE_PR_NOT_MERGED', `PR #${normalized.number} não está merged.`);
  }
  if (value?.isCrossRepository === true || value?.headRefName !== entry.branch) {
    throw cleanupError('WENDKEEP_WORKTREE_PR_MISMATCH', 'PR não corresponde à branch da worktree.');
  }
  const baseRefName = String(value?.baseRefName || entry.base || '').trim();
  if (!baseRefName || git(startDir, [
    'merge-base', '--is-ancestor', mergeCommitOid, baseRefName,
  ], { ok: false, spawn }).status !== 0) {
    throw cleanupError(
      'WENDKEEP_WORKTREE_PR_MERGE_UNREACHABLE',
      'O merge commit do PR não está alcançável pela base local.',
    );
  }
  return {
    number: Number(value.number || normalized.number),
    url: String(value.url || normalized.reference),
    state: 'MERGED',
    mergedAt: String(value.mergedAt),
    headRefName: String(value.headRefName),
    headRefOid: String(value.headRefOid || ''),
    baseRefName,
    mergeCommitOid,
    mergeMode: String(value.mergeMode || 'github'),
  };
}

function outboxEntries(vaultBase) {
  const path = join(vaultBase, '.brain', 'memory-outbox');
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => {
        const file = join(path, entry.name);
        let event = null;
        try { event = JSON.parse(readFileSync(file, 'utf8')); } catch { /* corrupt is pending */ }
        return { name: entry.name, event };
      });
  } catch { return []; }
}

function contextsForWorktree(registry, entry) {
  return Object.entries(registry?.active_contexts || {})
    .filter(([, context]) => context?.state === 'active' && context?.worktree_id === entry.worktreeId);
}

export function inspectWorktreeCleanup({
  startDir = process.cwd(), slug, spawn = spawnSync,
} = {}) {
  const repository = discoverWorktreeRepository({ startDir, spawn });
  const { registry, entry } = requiredEntry(repository, slug);
  const blockers = [];
  const pathExists = existsSync(entry.path);
  const resumesAfterPathRemoval = !pathExists
    && ['cleaning', 'failed'].includes(String(entry.cleanup?.state || ''))
    && ['finish', 'remove'].includes(String(entry.cleanup?.mode || ''))
    && Boolean(String(entry.cleanup?.operationId || '').trim());
  if (pathExists) {
    const status = git(entry.path, ['status', '--porcelain=v1', '--untracked-files=all'], {
      ok: false, spawn,
    });
    if (status.status !== 0 || String(status.stdout || '').trim()) {
      blockers.push({
        code: 'WENDKEEP_WORKTREE_DIRTY',
        recovery: `limpe o checkout e rode wendkeep worktree finish ${slug} novamente`,
      });
    }
  }
  const sessionRegistry = readSessionRegistry(registry.vaultPath);
  const contexts = contextsForWorktree(sessionRegistry, entry);
  const workSessions = new Set(contexts.map(([, context]) => String(context.work_session_id || '')));
    const activeSessions = Object.entries(sessionRegistry.sessions || {}).filter(([, session]) => (
      session?.status === 'active'
      && (workSessions.has(String(session.work_session_id || ''))
      || (String(session.project_scope?.repoRoot || '').trim()
        && comparablePath(session.project_scope.repoRoot) === comparablePath(entry.path)))
  ));
  if (activeSessions.length && !resumesAfterPathRemoval) {
    blockers.push({
      code: 'WENDKEEP_WORKTREE_ACTIVE_SESSION',
      sessions: activeSessions.map(([id]) => id).sort(),
      recovery: 'finalize ou mova as sessões ativas antes do cleanup',
    });
  }
  if (!resumesAfterPathRemoval
    && contexts.some(([, context]) => String(context.delivery_id || '').trim())) {
    blockers.push({
      code: 'WENDKEEP_WORKTREE_ACTIVE_DELIVERY',
      recovery: 'finalize ou abandone a delivery ativa antes do cleanup',
    });
  }
  const outbox = outboxEntries(registry.vaultPath);
  if (outbox.length) {
    blockers.push({
      code: 'WENDKEEP_WORKTREE_OUTBOX_PENDING',
      count: outbox.length,
      recovery: 'publique ou recupere o memory outbox antes do cleanup',
    });
  }
  if (outbox.some(({ event }) => (
    event?.memory_key === 'handoff.latest' || event?.memoryKey === 'handoff.latest'
  ))) {
    blockers.push({
      code: 'WENDKEEP_WORKTREE_HANDOFF_PENDING',
      recovery: 'publique o handoff pendente antes do cleanup',
    });
  }
  return {
    ok: blockers.length === 0,
    blockers,
    repository,
    registry,
    entry: structuredClone(entry),
    contexts: contexts.map(([key, context]) => ({ key, context: structuredClone(context) })),
  };
}

export function cleanupReceiptPath(repository) {
  return join(repository.commonDir, ...RECEIPT_REL.split('/'));
}

function readReceipts(repository) {
  const path = cleanupReceiptPath(repository);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function receiptId(repositoryId, slug, mode, authority) {
  return createHash('sha256')
    .update(`${repositoryId}\n${slug}\n${mode}\n${authority}\n`)
    .digest('hex').slice(0, 32);
}

function appendReceipt(repository, receipt) {
  const path = cleanupReceiptPath(repository);
  return withWorktreeRegistryLock(path, () => {
    const existing = readReceipts(repository).find((item) => item.id === receipt.id);
    if (existing) return existing;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', flag: 'a' });
    return receipt;
  });
}

function blockerError(report) {
  const first = report.blockers[0];
  return cleanupError(first.code, first.recovery, { blockers: report.blockers });
}

function reserve(repository, slug, { mode, authority, proof, reason, now }) {
  const operationId = randomUUID();
  let previous = null;
  let resumed = false;
  mutateWorktreeRegistry(repository, (registry) => {
    const entry = registry.entries?.[slug];
    if (!entry) throw cleanupError('WENDKEEP_WORKTREE_NOT_FOUND', `Worktree "${slug}" ausente.`);
    if (entry.state === 'cleaned') {
      previous = entry;
      return registry;
    }
    if (entry.cleanup?.state === 'cleaning') {
      if (existsSync(entry.path)
        || entry.cleanup.mode !== mode
        || entry.cleanup.authority !== authority) {
        throw cleanupError('WENDKEEP_WORKTREE_CLEANUP_BUSY', `Cleanup de "${slug}" já está em andamento.`);
      }
      previous = entry;
      resumed = true;
      return registry;
    }
    registry.entries[slug] = {
      ...entry,
      state: 'cleaning',
      ...(proof ? { pullRequest: proof } : {}),
      cleanup: {
        schemaVersion: 1,
        operationId,
        state: 'cleaning',
        mode,
        authority,
        ...(reason ? { reason } : {}),
        startedAt: now,
      },
      updatedAt: now,
    };
    return registry;
  });
  return {
    operationId: resumed ? previous.cleanup.operationId : operationId,
    previous,
    resumed,
  };
}

function associatePullRequest(repository, slug, proof, now) {
  mutateWorktreeRegistry(repository, (registry) => {
    const entry = registry.entries?.[slug];
    if (!entry) throw cleanupError('WENDKEEP_WORKTREE_NOT_FOUND', `Worktree "${slug}" ausente.`);
    if (entry.cleanup?.state === 'cleaning') {
      const authority = proof.url || `pr:${proof.number}`;
      if (entry.cleanup.authority !== authority) {
        throw cleanupError('WENDKEEP_WORKTREE_CLEANUP_BUSY', `Cleanup de "${slug}" já está em andamento.`);
      }
      return registry;
    }
    registry.entries[slug] = { ...entry, pullRequest: proof, updatedAt: now };
    return registry;
  });
}

function failReservation(repository, slug, error, now) {
  mutateWorktreeRegistry(repository, (registry) => {
    const entry = registry.entries?.[slug];
    if (!entry || entry.cleanup?.state !== 'cleaning') return registry;
    registry.entries[slug] = {
      ...entry,
      state: 'cleanup-failed',
      cleanup: {
        ...entry.cleanup,
        state: 'failed',
        failedAt: now,
        error: {
          code: String(error?.code || 'WENDKEEP_WORKTREE_CLEANUP_FAILED'),
          message: String(error?.message || 'Cleanup falhou.'),
        },
      },
      updatedAt: now,
    };
    return registry;
  });
}

function closeContexts(vaultBase, contexts, now) {
  for (const { context } of contexts) {
    mutateActiveContext(vaultBase, {
      projectId: context.project_id,
      repositoryId: context.repository_id,
      worktreeId: context.worktree_id,
      workSessionId: context.work_session_id,
      branch: context.branch,
      headSha: context.head_sha,
    }, (current) => ({
      ...current,
      state: 'closed',
      delivery_id: '',
    }), { expectedRevision: context.revision, now });
  }
}

function removePath(repository, entry, spawn) {
  if (existsSync(entry.path)) {
    git(repository.mainWorktree, ['worktree', 'remove', entry.path], { spawn });
  }
  git(repository.mainWorktree, ['worktree', 'prune'], { spawn });
}

function branchHead(repository, branch, spawn) {
  const result = git(repository.mainWorktree, [
    'rev-parse', '--verify', `refs/heads/${branch}`,
  ], { ok: false, spawn });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function deleteLocalBranch(repository, branch, expectedHead, spawn) {
  if (git(repository.mainWorktree, [
    'show-ref', '--verify', '--quiet', `refs/heads/${branch}`,
  ], { ok: false, spawn }).status !== 0) return false;
  if (!expectedHead) {
    throw cleanupError('WENDKEEP_WORKTREE_BRANCH_UNPROVEN', 'Não foi possível provar o head da branch local.');
  }
  git(repository.mainWorktree, ['update-ref', '-d', `refs/heads/${branch}`, expectedHead], { spawn });
  return true;
}

function deleteRemoteBranch(repository, branch, expectedHead, spawn) {
  const remote = git(repository.mainWorktree, [
    'ls-remote', '--heads', 'origin', `refs/heads/${branch}`,
  ], { ok: false, spawn });
  if (remote.status !== 0) {
    throw cleanupError('WENDKEEP_WORKTREE_REMOTE_UNAVAILABLE', 'Não foi possível consultar a branch remota.');
  }
  const remoteHead = String(remote.stdout || '').trim().split(/\s+/)[0] || '';
  if (!remoteHead) return false;
  if (!expectedHead || remoteHead !== expectedHead) {
    throw cleanupError(
      'WENDKEEP_WORKTREE_REMOTE_DIVERGED',
      'A branch remota divergiu do head comprovado; nenhuma exclusão remota foi feita.',
    );
  }
  git(repository.mainWorktree, ['push', 'origin', '--delete', branch], { spawn });
  return true;
}

function finalize(repository, slug, { receipt, now }) {
  mutateWorktreeRegistry(repository, (registry) => {
    const entry = registry.entries[slug];
    registry.entries[slug] = {
      ...entry,
      state: 'cleaned',
      cleanup: {
        ...entry.cleanup,
        state: 'completed',
        receiptId: receipt.id,
        finishedAt: now,
      },
      updatedAt: now,
    };
    return registry;
  });
}

function existingCompletion(repository, entry) {
  if (entry?.state !== 'cleaned') return null;
  const receipt = readReceipts(repository).find((item) => item.id === entry.cleanup?.receiptId)
    || readReceipts(repository).find((item) => item.slug === entry.slug);
  return receipt ? { state: 'completed', idempotent: true, receipt } : null;
}

export async function finishManagedWorktree({
  startDir = process.cwd(),
  slug,
  pullRequest,
  deleteRemote = false,
  github = defaultGithub,
  spawn = spawnSync,
  now = () => new Date().toISOString(),
} = {}) {
  const repository = discoverWorktreeRepository({ startDir, spawn });
  const initial = requiredEntry(repository, slug);
  const completed = existingCompletion(repository, initial.entry);
  if (completed) return completed;
  const pullRequestReference = pullRequest
    || initial.entry.pullRequest?.number
    || initial.entry.pullRequest?.url;
  if (git(repository.mainWorktree, ['remote', 'get-url', 'origin'], {
    ok: false, spawn,
  }).status === 0) {
    git(repository.mainWorktree, ['fetch', '--prune', 'origin'], { spawn });
  }
  const proof = await verifyMergedPullRequest({
    startDir: repository.mainWorktree,
    entry: initial.entry,
    pullRequest: pullRequestReference,
    github,
    spawn,
  });
  const at = String(now());
  associatePullRequest(repository, slug, proof, at);
  const report = inspectWorktreeCleanup({ startDir: repository.mainWorktree, slug, spawn });
  if (!report.ok) throw blockerError(report);
  const authority = proof.url || `pr:${proof.number}`;
  const reservation = reserve(repository, slug, {
    mode: 'finish', authority, proof, now: at,
  });
  if (reservation.previous?.state === 'cleaned') {
    return existingCompletion(repository, requiredEntry(repository, slug).entry);
  }
  const { operationId } = reservation;
  try {
    const expectedHead = branchHead(repository, report.entry.branch, spawn);
    removePath(repository, report.entry, spawn);
    closeContexts(report.registry.vaultPath, report.contexts, at);
    const remoteBranchDeleted = deleteRemote
      ? deleteRemoteBranch(repository, report.entry.branch, expectedHead, spawn)
      : false;
    const localBranchDeleted = deleteLocalBranch(
      repository, report.entry.branch, expectedHead, spawn,
    );
    const receipt = appendReceipt(repository, {
      schemaVersion: 1,
      id: receiptId(report.registry.repositoryId, slug, 'finish', authority),
      operationId,
      slug,
      mode: 'finish',
      outcome: 'completed',
      branch: report.entry.branch,
      head: expectedHead || report.entry.head,
      pull_request: proof,
      local_branch_deleted: localBranchDeleted,
      remote_branch_deleted: remoteBranchDeleted,
      finished_at: at,
    });
    finalize(repository, slug, { receipt, now: at });
    return { state: 'completed', idempotent: false, receipt };
  } catch (error) {
    failReservation(repository, slug, error, String(now()));
    throw error;
  }
}

export async function removeManagedWorktree({
  startDir = process.cwd(),
  slug,
  reason,
  spawn = spawnSync,
  now = () => new Date().toISOString(),
} = {}) {
  const normalizedReason = String(reason || '').trim();
  if (!normalizedReason) {
    throw cleanupError('WENDKEEP_WORKTREE_REASON_REQUIRED', '`worktree remove` exige --reason.');
  }
  const repository = discoverWorktreeRepository({ startDir, spawn });
  const initial = requiredEntry(repository, slug);
  const completed = existingCompletion(repository, initial.entry);
  if (completed) return completed;
  const report = inspectWorktreeCleanup({ startDir: repository.mainWorktree, slug, spawn });
  if (!report.ok) throw blockerError(report);
  const at = String(now());
  const authority = `reason:${normalizedReason}`;
  const { operationId } = reserve(repository, slug, {
    mode: 'remove', authority, reason: normalizedReason, now: at,
  });
  try {
    removePath(repository, report.entry, spawn);
    closeContexts(report.registry.vaultPath, report.contexts, at);
    const receipt = appendReceipt(repository, {
      schemaVersion: 1,
      id: receiptId(report.registry.repositoryId, slug, 'remove', authority),
      operationId,
      slug,
      mode: 'remove',
      outcome: 'completed',
      branch: report.entry.branch,
      head: report.entry.head,
      reason: normalizedReason,
      local_branch_deleted: false,
      remote_branch_deleted: false,
      finished_at: at,
    });
    finalize(repository, slug, { receipt, now: at });
    return { state: 'completed', idempotent: false, receipt };
  } catch (error) {
    failReservation(repository, slug, error, String(now()));
    throw error;
  }
}

export async function cleanupMergedWorktrees({
  startDir = process.cwd(),
  apply = false,
  github = defaultGithub,
  spawn = spawnSync,
  now = () => new Date().toISOString(),
} = {}) {
  const repository = discoverWorktreeRepository({ startDir, spawn });
  const { registry } = readWorktreeRegistry(repository);
  const actions = [];
  for (const slug of Object.keys(registry.entries || {}).sort()) {
    const entry = registry.entries[slug];
    if (entry.state === 'cleaned') continue;
    const pullRequest = entry.pullRequest?.number || entry.pullRequest?.url;
    if (!pullRequest) {
      actions.push({
        slug, outcome: 'blocked', blockers: ['WENDKEEP_WORKTREE_PR_UNASSOCIATED'],
      });
      continue;
    }
    try {
      const proof = await verifyMergedPullRequest({
        startDir: repository.mainWorktree, entry, pullRequest, github, spawn,
      });
      const report = inspectWorktreeCleanup({
        startDir: repository.mainWorktree, slug, spawn,
      });
      if (!report.ok) {
        actions.push({ slug, outcome: 'blocked', blockers: report.blockers.map((item) => item.code) });
      } else if (!apply) {
        actions.push({ slug, outcome: 'would-finish', pullRequest: proof.number });
      } else {
        const result = await finishManagedWorktree({
          startDir: repository.mainWorktree,
          slug,
          pullRequest,
          github,
          spawn,
          now,
        });
        actions.push({ slug, outcome: result.state, receipt: result.receipt });
      }
    } catch (error) {
      actions.push({ slug, outcome: 'blocked', blockers: [String(error?.code || 'WENDKEEP_WORKTREE_UNPROVEN')] });
    }
  }
  return { ok: actions.every((item) => item.outcome !== 'blocked'), dryRun: !apply, actions };
}

export function pruneManagedWorktrees({
  startDir = process.cwd(), apply = false, spawn = spawnSync,
} = {}) {
  const repository = discoverWorktreeRepository({ startDir, spawn });
  const { registry } = readWorktreeRegistry(repository);
  const listed = git(repository.mainWorktree, ['worktree', 'list', '--porcelain'], { spawn });
  const registeredPaths = new Set(String(listed.stdout || '').split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => comparablePath(line.slice('worktree '.length))));
  const actions = Object.values(registry.entries || {})
    .filter((entry) => (
      entry?.path
      && !existsSync(entry.path)
      && registeredPaths.has(comparablePath(entry.path))
    ))
    .map((entry) => ({ slug: entry.slug, path: entry.path, action: 'prune-git-metadata' }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
  if (apply) git(repository.mainWorktree, ['worktree', 'prune'], { spawn });
  return { dryRun: !apply, actions };
}

function cleanupRecovery(entry) {
  if (entry.cleanup?.mode === 'remove') {
    const reason = String(entry.cleanup.reason || 'confirme o abandono').replaceAll('"', '\\"');
    return `wendkeep worktree remove ${entry.slug} --reason "${reason}"`;
  }
  const pullRequest = entry.pullRequest?.number || entry.pullRequest?.url || '<PR>';
  return `wendkeep worktree finish ${entry.slug} --pr ${pullRequest}`;
}

export function diagnoseManagedWorktreeCleanups({
  startDir = process.cwd(), spawn = spawnSync,
} = {}) {
  let repository;
  let registry;
  try {
    repository = discoverWorktreeRepository({ startDir, spawn });
    ({ registry } = readWorktreeRegistry(repository));
  } catch (error) {
    if (error?.code === 'WENDKEEP_WORKTREE_REGISTRY_MISSING'
      || error?.code === 'WENDKEEP_WORKTREE_GIT_FAILED') {
      return { initialized: false, issues: [] };
    }
    throw error;
  }
  let receipts = [];
  try {
    receipts = readReceipts(repository);
  } catch {
    return {
      initialized: true,
      issues: [{
        slug: '*',
        state: 'receipt-invalid',
        errorCode: 'WENDKEEP_WORKTREE_CLEANUP_RECEIPT_INVALID',
        repair: 'revise o receipt store append-only antes de retomar o cleanup',
      }],
    };
  }
  const receiptIds = new Set(receipts.map((receipt) => receipt.id));
  const issues = [];
  for (const slug of Object.keys(registry.entries || {}).sort()) {
    const entry = registry.entries[slug];
    if (entry.cleanup?.state === 'cleaning') {
      issues.push({
        slug,
        state: entry.state,
        errorCode: existsSync(entry.path)
          ? 'WENDKEEP_WORKTREE_CLEANUP_INCOMPLETE'
          : 'WENDKEEP_WORKTREE_CLEANUP_INTERRUPTED',
        repair: cleanupRecovery(entry),
      });
    } else if (entry.cleanup?.state === 'failed') {
      issues.push({
        slug,
        state: entry.state,
        errorCode: entry.cleanup.error?.code || 'WENDKEEP_WORKTREE_CLEANUP_FAILED',
        repair: cleanupRecovery(entry),
      });
    } else if (entry.state === 'cleaned'
      && (!entry.cleanup?.receiptId || !receiptIds.has(entry.cleanup.receiptId))) {
      issues.push({
        slug,
        state: entry.state,
        errorCode: 'WENDKEEP_WORKTREE_CLEANUP_RECEIPT_MISSING',
        repair: 'revise o registry e o receipt store; não invente um receipt retroativo',
      });
    }
  }
  return { initialized: true, issues };
}
