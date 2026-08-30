import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import {
  discoverWorktreeRepository,
  mutateWorktreeRegistry,
  readWorktreeRegistry,
} from '../../vault/src/worktree-metadata.mjs';
import {
  appendReceipt as appendLedgerReceipt,
  createFileReceiptStore,
  readReceiptLedger,
} from '../../evidence/src/receipt-ledger.mjs';
import {
  classifyReceipt,
  evaluateProvenanceGate,
} from '../../evidence/src/provenance-gate.mjs';

const RECEIPT_REL = 'wendkeep/worktree-cleanup-receipts-v2.jsonl';
const LEGACY_RECEIPT_REL = 'wendkeep/worktree-cleanup-receipts-v1.jsonl';
const activeCleanupOperations = new Set();
let controlPlaneComposition = null;

export function configureWorktreeCleanupComposition(composition = {}) {
  const required = [
    'cleanupReservationForWorktree', 'comparableCleanupPath', 'readSessionRegistry',
    'markActiveContextCleanupTerminal', 'mutateActiveContext', 'releaseActiveContextCleanup',
    'reserveActiveContextCleanup', 'updateActiveContextCleanupPhase',
  ];
  for (const name of required) {
    if (typeof composition[name] !== 'function') {
      throw Object.assign(new Error(`worktree cleanup composition requires ${name}`), {
        code: 'WENDKEEP_WORKTREE_COMPOSITION_MISSING',
      });
    }
  }
  controlPlaneComposition = Object.freeze(Object.fromEntries(
    required.map((name) => [name, composition[name]]),
  ));
  return controlPlaneComposition;
}

function composed(name, ...args) {
  if (!controlPlaneComposition) {
    throw Object.assign(new Error('worktree cleanup requires the WendKeep composition root'), {
      code: 'WENDKEEP_WORKTREE_COMPOSITION_MISSING',
    });
  }
  return controlPlaneComposition[name](...args);
}

const cleanupReservationForWorktree = (...args) => composed('cleanupReservationForWorktree', ...args);
const comparableCleanupPath = (...args) => composed('comparableCleanupPath', ...args);
const readSessionRegistry = (...args) => composed('readSessionRegistry', ...args);
const markActiveContextCleanupTerminal = (...args) => composed('markActiveContextCleanupTerminal', ...args);
const mutateActiveContext = (...args) => composed('mutateActiveContext', ...args);
const releaseActiveContextCleanup = (...args) => composed('releaseActiveContextCleanup', ...args);
const reserveActiveContextCleanup = (...args) => composed('reserveActiveContextCleanup', ...args);
const updateActiveContextCleanupPhase = (...args) => composed('updateActiveContextCleanupPhase', ...args);

function cleanupOperationKey(repository, slug) {
  return `${String(repository?.commonDir || '')}\u0000${String(slug || '')}`;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function cleanupReservationIsActive(repository, slug, entry) {
  const key = cleanupOperationKey(repository, slug);
  if (activeCleanupOperations.has(key)) return true;
  // A failed entry is explicitly retryable. The shared SESSION_REGISTRY
  // reservation performs the owner-token CAS; do not re-open the worktree
  // registry lock here (reserve() already holds it).
  if (String(entry?.cleanup?.state || '') === 'failed') return false;
  const pathExists = Boolean(entry?.path && existsSync(entry.path));
  const ownerPid = Number(entry?.cleanup?.ownerPid);
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) return pathExists;
  return processIsAlive(ownerPid);
}

function orphanedReservationOperationId(report, identity, {
  mode, authority, head, slug, resumed,
} = {}) {
  if (resumed) return '';
  const marker = cleanupReservationForWorktree(
    readSessionRegistry(report.registry.vaultPath),
    identity.worktree_id,
    identity.repository_id,
  );
  if (!marker) return '';
  const ownerPid = Number(marker.owner_pid);
  if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && processIsAlive(ownerPid)) return '';
  const sortedIds = (value) => [...new Set(value || [])].map(String).sort();
  const snapshotsEqual = JSON.stringify(
    (Array.isArray(marker.target_context_snapshot) ? marker.target_context_snapshot : [])
      .slice().sort((left, right) => String(left?.key || '').localeCompare(String(right?.key || ''))),
  ) === JSON.stringify(
    (Array.isArray(identity.target_context_snapshot) ? identity.target_context_snapshot : [])
      .slice().sort((left, right) => String(left?.key || '').localeCompare(String(right?.key || ''))),
  );
  const sameSubject = marker.mode === mode
    && marker.authority === authority
    && marker.head === head
    && marker.slug === slug
    && marker.pull_request_number === identity.pull_request_number
    && marker.pull_request_repository === identity.pull_request_repository
    && marker.head_ref_oid === identity.head_ref_oid
    && marker.merge_commit_oid === identity.merge_commit_oid
    && marker.project_id === identity.project_id
    && marker.repository_id === identity.repository_id
    && marker.worktree_id === identity.worktree_id
    && marker.work_session_id === identity.work_session_id
    && marker.change_slug === identity.change_slug
    && marker.actor_context_id === identity.actor_context_id
    && JSON.stringify(sortedIds(marker.target_context_ids))
      === JSON.stringify(sortedIds(identity.target_context_ids))
    && JSON.stringify(sortedIds(marker.target_change_slugs))
      === JSON.stringify(sortedIds(identity.target_change_slugs))
    && snapshotsEqual
    && comparableCleanupPath(marker.worktree_path) === comparableCleanupPath(identity.worktree_path);
  return sameSubject ? String(marker.operation_id || '') : '';
}

function releaseCleanupOperation(repository, slug) {
  activeCleanupOperations.delete(cleanupOperationKey(repository, slug));
}

function sanitizeDiagnosticText(value) {
  let text = String(value || '');
  text = text
    .replace(/\b(?:ghp|github_pat|npm_|sk-|xox[baprs]-)[A-Za-z0-9_\-]+/gi, '[redacted-token]')
    .replace(/\b(?:token|authorization|bearer|password|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '[redacted-token]')
    .replace(/\bBearer\s+[^\s,;]+/gi, '[redacted-token]')
    .replace(/[A-Za-z]:\\[^\r\n"'`;|&]+/g, '[redacted-path]')
    .replace(/(?:^|\s)\/[^\s"'`;|&]+/g, ' [redacted-path]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[;&|`$<>(){}[\]]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text.slice(0, 240);
}

function sanitizeDiagnosticValue(value) {
  if (typeof value === 'string') return sanitizeDiagnosticText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, sanitizeDiagnosticValue(item),
    ]));
  }
  return value;
}

function recoverySegment(value, fallback) {
  const segment = sanitizeDiagnosticText(value)
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return segment || fallback;
}

function cleanupError(code, message, details = {}) {
  const error = new Error(sanitizeDiagnosticText(message));
  Object.assign(error, sanitizeDiagnosticValue(details));
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function canonicalPrAuthority(proof) {
  const repository = githubRepository(proof?.url || proof?.repository || '');
  const number = Number(proof?.number);
  if (!repository || !Number.isSafeInteger(number) || number < 1) {
    throw cleanupError('WENDKEEP_WORKTREE_PR_MISMATCH', 'PR não possui autoridade canônica comprovada.');
  }
  return `${repository}#${number}`;
}

function canonicalPrSnapshot(proof) {
  if (!proof) return null;
  return {
    repository: githubRepository(proof.url || proof.repository || ''),
    number: Number(proof.number),
    head_ref_name: String(proof.headRefName || ''),
    head_ref_oid: String(proof.headRefOid || ''),
    merge_commit_oid: String(proof.mergeCommitOid || ''),
    base_ref_name: String(proof.baseRefName || ''),
    merge_mode: String(proof.mergeMode || 'github'),
  };
}

function normalizedReason(value) {
  const label = recoverySegment(value, 'motivo-nao-informado');
  const digest = sha256(label);
  return { label, digest, authority: `reason:${digest}` };
}

function invokeFault(faultInjection, phase, context = {}) {
  const snake = phase.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  const callback = typeof faultInjection === 'function'
    ? faultInjection
    : faultInjection?.[phase] || faultInjection?.[snake];
  if (typeof callback !== 'function') return;
  const result = callback({ phase, ...context });
  if (result instanceof Error) throw result;
}

function storedPullRequestProof(entry) {
  const proof = entry?.pullRequest;
  if (!proof || typeof proof !== 'object') return null;
  const complete = Boolean(
    proof.number
    && proof.url
    && proof.mergedAt
    && proof.headRefName
    && proof.headRefOid
    && proof.mergeCommitOid
    && proof.baseRefName,
  );
  if (!complete) return null;
  if (String(proof.headRefName) !== String(entry.branch)) {
    throw cleanupError(
      'WENDKEEP_WORKTREE_PR_MISMATCH',
      'A prova reservada do PR não corresponde à branch da worktree.',
    );
  }
  return {
    ...proof,
    repository: githubRepository(proof.url || proof.repository || ''),
    authority: canonicalPrAuthority(proof),
  };
}

function isResumableCleanup(entry, mode) {
  return ['cleaning', 'failed'].includes(String(entry?.cleanup?.state || ''))
    && entry?.cleanup?.mode === mode
    && Boolean(String(entry?.cleanup?.operationId || '').trim());
}

function actorContextId(value) {
  if (value && typeof value === 'object') {
    return String(value.id || value.context_id || value.contextId || value.key || '').trim();
  }
  return String(value || '').trim();
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
      sanitizeDiagnosticText(result.stderr || result.error?.message || `git ${args[0]} falhou`),
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
      sanitizeDiagnosticText(result.stderr || result.error?.message || 'GitHub indisponível.'),
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
  const managedHeadResult = git(startDir, [
    'rev-parse', '--verify', `refs/heads/${entry.branch}`,
  ], { ok: false, spawn });
  const managedHead = managedHeadResult.status === 0
    ? String(managedHeadResult.stdout || '').trim() : '';
  if (!mergeCommitOid || !managedHead || String(value?.headRefOid || '').trim() !== managedHead) {
    throw cleanupError(
      'WENDKEEP_WORKTREE_PR_HEAD_MISMATCH',
      'PR não corresponde ao commit head comprovado da worktree.',
      {
        managedHead,
        receivedHead: String(value?.headRefOid || '').trim(),
        branch: String(entry.branch || ''),
      },
    );
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
    repository: returnedRepository,
    authority: `${returnedRepository}#${Number(value.number || normalized.number)}`,
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

function contextCausalSnapshot(entries = []) {
  return entries.map(([key, context]) => ({
    key: String(key),
    project_id: String(context?.project_id || ''),
    repository_id: String(context?.repository_id || ''),
    worktree_id: String(context?.worktree_id || ''),
    work_session_id: String(context?.work_session_id || ''),
    change_slug: String(context?.change_slug || ''),
    branch: String(context?.branch || ''),
    head_sha: String(context?.head_sha || ''),
    delivery_id: String(context?.delivery_id || ''),
    state: String(context?.state || ''),
    revision: Number(context?.revision || 0),
  })).sort((left, right) => left.key.localeCompare(right.key));
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
        recovery: `limpe o checkout e rode wendkeep worktree finish ${recoverySegment(slug, 'worktree')} novamente`,
      });
    }
  }
  const sessionRegistry = readSessionRegistry(registry.vaultPath);
  const matchingContexts = contextsForWorktree(sessionRegistry, entry);
  const foreignContexts = matchingContexts.filter(([, context]) => (
    context?.project_id !== registry.projectId
    || context?.repository_id !== registry.repositoryId
  ));
  const foreignKeys = new Set(foreignContexts.map(([key]) => key));
  const contexts = matchingContexts.filter(([key]) => !foreignKeys.has(key));
  if (foreignContexts.length) {
    blockers.push({
      code: 'WENDKEEP_WORKTREE_CONTEXT_MISMATCH',
      recovery: 'feche o contexto ativo estrangeiro antes do cleanup',
    });
  }
  const workSessions = new Set(matchingContexts.map(([, context]) => String(context.work_session_id || '')));
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
    contextSnapshot: contextCausalSnapshot(matchingContexts),
  };
}

export function cleanupReceiptPath(repository) {
  return join(repository.commonDir, ...RECEIPT_REL.split('/'));
}

export function cleanupReceiptLegacyPath(repository) {
  return join(repository.commonDir, ...LEGACY_RECEIPT_REL.split('/'));
}

export function cleanupReceiptCheckpointPath(repository) {
  return `${cleanupReceiptPath(repository)}.checkpoint.json`;
}

function receiptStore(repository) {
  return createFileReceiptStore({
    ledgerPath: cleanupReceiptPath(repository),
    checkpointPath: cleanupReceiptCheckpointPath(repository),
    legacyPath: cleanupReceiptLegacyPath(repository),
  });
}

function cleanupReceiptFromRecord(record) {
  const claims = record?.claims || {};
  const observations = record?.observations || {};
  return {
    schema_version: record.schema_version,
    schemaVersion: record.schema_version,
    id: record.receipt_id,
    receipt_id: record.receipt_id,
    receipt_hash: record.receipt_hash,
    sequence: record.sequence,
    previous_hash: record.previous_hash,
    kind: record.kind,
    repository_id: record.subject?.repository_id,
    project_id: record.subject?.project_id,
    worktree_id: record.subject?.worktree_id,
    work_session_id: record.subject?.work_session_id,
    change_slug: record.subject?.change_slug,
    target_context_ids: record.subject?.target_context_ids || [],
    target_change_slugs: record.subject?.target_change_slugs || [],
    target_context_snapshot: record.subject?.target_context_snapshot || [],
    actor_context_id: record.subject?.actor_context_id || '',
    slug: record.subject?.slug,
    mode: record.subject?.mode,
    authority: record.subject?.authority,
    pull_request_number: record.subject?.pull_request_number || '',
    pull_request_repository: record.subject?.pull_request_repository || '',
    head_ref_oid: record.subject?.head_ref_oid || '',
    merge_commit_oid: record.subject?.merge_commit_oid || '',
    worktree_path: record.subject?.worktree_path || '',
    phase: record.subject?.phase || 'finalized',
    operationId: observations.operation_id,
    reservationId: observations.reservation_id || observations.operation_id,
    observations,
    finished_at: record.recorded_at,
    ...claims,
    head_sha: claims.head || record.subject?.head || '',
  };
}

function readReceipts(repository) {
  const ledger = readReceiptLedger({ store: receiptStore(repository) });
  if (existsSync(cleanupReceiptPath(repository))
    && !existsSync(cleanupReceiptCheckpointPath(repository))) {
    throw cleanupError(
      'WENDKEEP_RECEIPT_LEDGER_TRUNCATED',
      'O checkpoint do ledger de cleanup está ausente; a cauda não é comprovável.',
    );
  }
  return ledger.records
    .filter((record) => record.kind === 'worktree-cleanup')
    .map(cleanupReceiptFromRecord);
}

function cleanupReceiptDraft(receipt) {
  return {
    kind: 'worktree-cleanup',
    subject: {
      project_id: String(receipt.project_id || ''),
      repository_id: String(receipt.repository_id || ''),
      worktree_id: String(receipt.worktree_id || ''),
      work_session_id: String(receipt.work_session_id || ''),
      change_slug: String(receipt.change_slug || ''),
      target_context_ids: [...new Set(receipt.target_context_ids || [])].map(String).sort(),
      target_change_slugs: [...new Set(receipt.target_change_slugs || [])].map(String).sort(),
      target_context_snapshot: structuredClone(receipt.target_context_snapshot || []),
      actor_context_id: String(receipt.actor_context_id || ''),
      slug: String(receipt.slug || ''),
      mode: String(receipt.mode || ''),
      authority: String(receipt.authority || ''),
      head: String(receipt.head || ''),
      pull_request_number: String(receipt.pull_request_number || ''),
      pull_request_repository: String(receipt.pull_request_repository || ''),
      head_ref_oid: String(receipt.head_ref_oid || ''),
      merge_commit_oid: String(receipt.merge_commit_oid || ''),
      worktree_path: String(receipt.worktree_path || ''),
      phase: String(receipt.phase || 'finalized'),
    },
    claims: {
      outcome: String(receipt.outcome || ''),
      branch: String(receipt.branch || ''),
      head: String(receipt.head || ''),
      ...(receipt.pull_request ? { pull_request: canonicalPrSnapshot(receipt.pull_request) } : {}),
      ...(receipt.reason ? { reason: recoverySegment(receipt.reason, 'motivo-nao-informado') } : {}),
      ...(receipt.reason_digest ? { reason_digest: String(receipt.reason_digest) } : {}),
      local_branch_deleted: Boolean(receipt.local_branch_deleted),
      remote_branch_deleted: Boolean(receipt.remote_branch_deleted),
    },
    observations: {
      status: 'verified',
      project_id: String(receipt.project_id || ''),
      repository_id: String(receipt.repository_id || ''),
      worktree_id: String(receipt.worktree_id || ''),
      work_session_id: String(receipt.work_session_id || ''),
      change_slug: String(receipt.change_slug || ''),
      target_context_ids: [...new Set(receipt.target_context_ids || [])].map(String).sort(),
      target_change_slugs: [...new Set(receipt.target_change_slugs || [])].map(String).sort(),
      target_context_snapshot: structuredClone(receipt.target_context_snapshot || []),
      actor_context_id: String(receipt.actor_context_id || ''),
      branch: String(receipt.branch || ''),
      head_sha: String(receipt.head || ''),
      authority: String(receipt.authority || ''),
      pull_request_number: String(receipt.pull_request_number || ''),
      pull_request_repository: String(receipt.pull_request_repository || ''),
      head_ref_oid: String(receipt.head_ref_oid || ''),
      merge_commit_oid: String(receipt.merge_commit_oid || ''),
      worktree_path: String(receipt.worktree_path || ''),
      phase: String(receipt.phase || 'finalized'),
      operation_id: String(receipt.operationId || ''),
      reservation_id: String(receipt.reservationId || receipt.operationId || ''),
    },
    recorded_at: String(receipt.finished_at || new Date().toISOString()),
  };
}

function appendReceipt(repository, receipt) {
  const result = appendLedgerReceipt({
    store: receiptStore(repository),
    draft: cleanupReceiptDraft(receipt),
  });
  return cleanupReceiptFromRecord(result.record);
}

function receiptForOperation(repository, operationId, { slug, mode, authority } = {}) {
  if (!operationId) return null;
  const receipt = readReceipts(repository).find((item) => (
    item.operationId === operationId
    && item.slug === slug
    && item.mode === mode
    && item.authority === authority
  ));
  return receipt || null;
}

function cleanupIdentity(report, {
  authority = '', proof = null, actorContext = '', prior = null,
} = {}) {
  const contexts = [...(report.contexts || [])]
    .sort((left, right) => String(left.key).localeCompare(String(right.key)));
  const context = contexts[0]?.context;
  const targetContextIds = contexts.map(({ key, context: item }) => (
    String(item?.context_id || item?.contextId || key)
  )).filter(Boolean).sort();
  const targetChangeSlugs = [...new Set(contexts
    .map(({ context: item }) => String(item?.change_slug || '').trim())
    .filter(Boolean))].sort();
  const targetContextSnapshot = reportContextSnapshot(report);
  const snapshot = canonicalPrSnapshot(proof);
  const hasPrior = prior && typeof prior === 'object';
  const priorHas = (field) => hasPrior && Object.hasOwn(prior, field);
  return {
    project_id: report.registry.projectId,
    repository_id: report.registry.repositoryId,
    worktree_id: report.entry.worktreeId,
    work_session_id: priorHas('workSessionId')
      ? String(prior.workSessionId || '') : String(context?.work_session_id || ''),
    change_slug: priorHas('changeSlug')
      ? String(prior.changeSlug || '') : String(context?.change_slug || ''),
    target_context_ids: priorHas('targetContextIds')
      ? [...(prior.targetContextIds || [])].map(String).sort() : targetContextIds,
    target_change_slugs: priorHas('targetChangeSlugs')
      ? [...(prior.targetChangeSlugs || [])].map(String).sort() : targetChangeSlugs,
    target_context_snapshot: priorHas('targetContextSnapshot')
      ? structuredClone(prior.targetContextSnapshot || []) : targetContextSnapshot,
    // The first attempt is authoritative. A retry may run under a different
    // caller, but must not rewrite the causal actor bound to the receipt.
    actor_context_id: priorHas('actorContextId')
      ? String(prior.actorContextId || '') : actorContextId(actorContext),
    worktree_path: priorHas('worktreePath')
      ? String(prior.worktreePath || '') : String(report.entry.path || ''),
    authority,
    pull_request_number: snapshot?.number ? String(snapshot.number) : '',
    pull_request_repository: snapshot?.repository || '',
    head_ref_oid: snapshot?.head_ref_oid || '',
    merge_commit_oid: snapshot?.merge_commit_oid || '',
  };
}

function identityCausalSnapshot(identity = {}) {
  return {
    project_id: String(identity.project_id || ''),
    repository_id: String(identity.repository_id || ''),
    worktree_id: String(identity.worktree_id || ''),
    work_session_id: String(identity.work_session_id || ''),
    change_slug: String(identity.change_slug || ''),
    target_context_ids: [...new Set(identity.target_context_ids || [])].map(String).sort(),
    target_change_slugs: [...new Set(identity.target_change_slugs || [])].map(String).sort(),
    target_context_snapshot: structuredClone(identity.target_context_snapshot || []),
    actor_context_id: String(identity.actor_context_id || ''),
    worktree_path: String(identity.worktree_path || ''),
  };
}

function reportContextSnapshot(report) {
  if (Array.isArray(report?.contextSnapshot)) return report.contextSnapshot;
  return contextCausalSnapshot((report?.contexts || []).map(({ key, context }) => [key, context]));
}

function cleanupCausalConflict(expected, observed) {
  return cleanupProvenanceError({
    state: 'conflict',
    reasonCodes: ['WENDKEEP_PROVENANCE_CONTEXT_MISMATCH'],
    diagnostics: [{
      blocker: 'WENDKEEP_PROVENANCE_CONTEXT_MISMATCH', expected, observed,
    }],
    repair: { command: 'reconcile active contexts, then retry cleanup' },
  }, expected, observed);
}

function assertCleanupCausalSnapshot({
  expectedReport, observedReport, expectedIdentity, observedIdentity,
} = {}) {
  const expected = {
    contexts: reportContextSnapshot(expectedReport),
    identity: identityCausalSnapshot(expectedIdentity),
    worktree_path: String(expectedReport?.entry?.path || ''),
  };
  const observed = {
    contexts: reportContextSnapshot(observedReport),
    identity: identityCausalSnapshot(observedIdentity),
    worktree_path: String(observedReport?.entry?.path || ''),
  };
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    throw cleanupCausalConflict(expected, observed);
  }
}

function revalidateCleanupBeforeMutation({
  repository,
  slug,
  baselineReport,
  baselineIdentity,
  priorCleanup,
  proof,
  authority,
  actorContext,
  expectedHead,
  spawn,
  provenanceGate,
} = {}) {
  const observedReport = inspectWorktreeCleanup({
    startDir: repository.mainWorktree, slug, spawn,
  });
  if (!observedReport.ok) throw blockerError(observedReport);
  const observedIdentity = cleanupIdentity(observedReport, {
    authority, proof, actorContext, prior: priorCleanup,
  });
  assertCleanupCausalSnapshot({
    expectedReport: baselineReport,
    observedReport,
    expectedIdentity: baselineIdentity,
    observedIdentity,
  });
  const derivedHead = branchHead(repository, observedReport.entry.branch, spawn);
  const effectiveHead = derivedHead || String(expectedHead || '');
  if (!effectiveHead) {
    throw cleanupError(
      'WENDKEEP_WORKTREE_BRANCH_UNPROVEN',
      'Não foi possível provar o head atual da branch antes do cleanup.',
    );
  }
  if (derivedHead && expectedHead && derivedHead !== expectedHead) {
    throw cleanupError(
      'WENDKEEP_WORKTREE_PR_HEAD_MISMATCH',
      'O head atual da branch mudou antes da mutação.',
    );
  }
  requireCleanupOperationGate({
    mode: proof ? 'finish' : 'remove',
    report: observedReport,
    proof,
    authority,
    head: effectiveHead,
    identity: observedIdentity,
    provenanceGate,
  });
  const postGateReport = inspectWorktreeCleanup({
    startDir: repository.mainWorktree, slug, spawn,
  });
  if (!postGateReport.ok) throw blockerError(postGateReport);
  const postGateIdentity = cleanupIdentity(postGateReport, {
    authority, proof, actorContext, prior: priorCleanup,
  });
  assertCleanupCausalSnapshot({
    expectedReport: observedReport,
    observedReport: postGateReport,
    expectedIdentity: observedIdentity,
    observedIdentity: postGateIdentity,
  });
  return { report: postGateReport, identity: postGateIdentity, head: effectiveHead };
}

function assertPostRemovalCausalSnapshot({
  beforeReport, beforeIdentity, repository, slug, proof, authority, actorContext, spawn, priorCleanup,
} = {}) {
  const afterReport = inspectWorktreeCleanup({
    startDir: repository.mainWorktree, slug, spawn,
  });
  if (!afterReport.ok) throw blockerError(afterReport);
  const afterIdentity = cleanupIdentity(afterReport, {
    authority, proof, actorContext, prior: priorCleanup,
  });
  assertCleanupCausalSnapshot({
    expectedReport: beforeReport,
    observedReport: afterReport,
    expectedIdentity: beforeIdentity,
    observedIdentity: afterIdentity,
  });
  return { report: afterReport, identity: afterIdentity };
}

function assertNoActiveCleanupContexts(vaultPath, entry) {
  const registry = readSessionRegistry(vaultPath);
  const observed = contextCausalSnapshot(contextsForWorktree(registry, entry));
  if (observed.length) {
    throw cleanupCausalConflict({ contexts: [] }, { contexts: observed });
  }
}

function reserveContextCausally({
  vaultPath,
  reserveOptions,
  repository,
  slug,
  baselineReport,
  baselineIdentity,
  priorCleanup,
  proof,
  authority,
  actorContext,
  spawn,
} = {}) {
  try {
    return reserveActiveContextCleanup(vaultPath, reserveOptions);
  } catch (error) {
    if (error?.code !== 'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_CONTEXT_MISMATCH') throw error;
    const observedReport = inspectWorktreeCleanup({
      startDir: repository.mainWorktree, slug, spawn,
    });
    const observedIdentity = cleanupIdentity(observedReport, {
      authority, proof, actorContext, prior: priorCleanup,
    });
    throw cleanupCausalConflict({
      contexts: reportContextSnapshot(baselineReport),
      identity: identityCausalSnapshot(baselineIdentity),
    }, {
      contexts: reportContextSnapshot(observedReport),
      identity: identityCausalSnapshot(observedIdentity),
    });
  }
}

function recordPreReservationFailure({
  repository,
  slug,
  mode,
  authority,
  proof,
  reason,
  reasonDigest,
  identity,
  head,
  now,
  operationId,
  error,
} = {}) {
  try {
    const reservation = reserve(repository, slug, {
      mode,
      authority,
      proof,
      reason,
      reasonDigest,
      identity,
      head,
      now,
      operationId,
    });
    const failedRegistry = failReservation(repository, slug, error, now);
    return {
      operationId: reservation.operationId,
      entry: failedRegistry?.entries?.[slug],
    };
  } finally {
    releaseCleanupOperation(repository, slug);
  }
}

function blockerError(report) {
  const first = report.blockers[0];
  return cleanupError(first.code, first.recovery, { blockers: report.blockers });
}

function reserve(repository, slug, {
  mode, authority, proof, reason, reasonDigest, identity = {}, head = '', now,
  operationId = randomUUID(), attemptToken = '',
}) {
  const has = (field) => Object.hasOwn(identity, field);
  const subjectMetadata = {
    ...(has('project_id') ? { projectId: String(identity.project_id || '') } : {}),
    ...(has('repository_id') ? { repositoryId: String(identity.repository_id || '') } : {}),
    ...(has('worktree_id') ? { worktreeId: String(identity.worktree_id || '') } : {}),
    ...(has('work_session_id') ? { workSessionId: String(identity.work_session_id || '') } : {}),
    ...(has('change_slug') ? { changeSlug: String(identity.change_slug || '') } : {}),
    ...(has('target_context_ids')
      ? { targetContextIds: [...new Set(identity.target_context_ids || [])].map(String).sort() } : {}),
    ...(has('target_change_slugs')
      ? { targetChangeSlugs: [...new Set(identity.target_change_slugs || [])].map(String).sort() } : {}),
    ...(has('target_context_snapshot')
      ? { targetContextSnapshot: structuredClone(identity.target_context_snapshot || []) } : {}),
    ...(has('actor_context_id') ? { actorContextId: String(identity.actor_context_id || '') } : {}),
    ...(has('pull_request_number')
      ? { pullRequestNumber: String(identity.pull_request_number || '') } : {}),
    ...(has('pull_request_repository')
      ? { pullRequestRepository: String(identity.pull_request_repository || '') } : {}),
    ...(has('head_ref_oid') ? { headRefOid: String(identity.head_ref_oid || '') } : {}),
    ...(has('merge_commit_oid') ? { mergeCommitOid: String(identity.merge_commit_oid || '') } : {}),
    ...(has('worktree_path') ? { worktreePath: String(identity.worktree_path || '') } : {}),
  };
  let previous = null;
  let resumed = false;
  mutateWorktreeRegistry(repository, (registry) => {
    const entry = registry.entries?.[slug];
    if (!entry) throw cleanupError('WENDKEEP_WORKTREE_NOT_FOUND', `Worktree "${slug}" ausente.`);
    if (entry.state === 'cleaned') {
      previous = entry;
      return registry;
    }
    if (['cleaning', 'failed'].includes(entry.cleanup?.state)) {
      const storedAuthority = String(entry.cleanup.authority || '');
      const compatibleLegacyAuthority = mode === 'finish'
        && proof
        && canonicalPrAuthority(proof) === authority
        && storedAuthority === String(proof.url || '');
      if ((entry.cleanup.state === 'cleaning'
        && cleanupReservationIsActive(repository, slug, entry))
        || entry.cleanup.mode !== mode
        || (storedAuthority !== authority && !compatibleLegacyAuthority)) {
        throw cleanupError('WENDKEEP_WORKTREE_CLEANUP_BUSY', `Cleanup de "${slug}" já está em andamento.`);
      }
      previous = entry;
      resumed = true;
      registry.entries[slug] = {
        ...entry,
        state: 'cleaning',
        ...(proof ? { pullRequest: proof } : {}),
        cleanup: {
          ...entry.cleanup,
          state: 'cleaning',
          ...(reason ? { reason } : {}),
          ...(reasonDigest ? { reason_digest: reasonDigest } : {}),
          ...(mode === 'finish' ? { authority } : {}),
          ...subjectMetadata,
          ...(head ? { head } : {}),
          ...(attemptToken ? { attemptToken } : {}),
          ownerPid: process.pid,
          updatedAt: now,
        },
        updatedAt: now,
      };
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
        ...(reasonDigest ? { reason_digest: reasonDigest } : {}),
        ...subjectMetadata,
        ...(head ? { head } : {}),
        ...(attemptToken ? { attemptToken } : {}),
        ownerPid: process.pid,
        startedAt: now,
      },
      updatedAt: now,
    };
    return registry;
  });
  if (previous?.state !== 'cleaned') {
    activeCleanupOperations.add(cleanupOperationKey(repository, slug));
  }
  return {
    operationId: resumed ? previous.cleanup.operationId : operationId,
    previous,
    resumed,
  };
}

function failReservation(repository, slug, error, now) {
  return mutateWorktreeRegistry(repository, (registry) => {
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
          message: sanitizeDiagnosticText(error?.message || 'Cleanup falhou.'),
        },
      },
      updatedAt: now,
    };
    return registry;
  });
}

function closeContexts(vaultBase, contexts, now, cleanupOperationId = '') {
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
    }), { expectedRevision: context.revision, now, cleanupOperationId });
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

function finalize(repository, slug, {
  receipt, now, expectedOperationId = '', expectedAttemptToken = '', expectedSubjectHash = '',
}) {
  mutateWorktreeRegistry(repository, (registry) => {
    const entry = registry.entries[slug];
    const subject = cleanupReceiptSubject(registry, entry);
    const subjectMismatches = cleanupReceiptCausalMismatches(receipt, subject);
    if (!entry
      || entry.state !== 'cleaning'
      || entry.cleanup?.state !== 'cleaning'
      || String(entry.cleanup?.operationId || '') !== String(expectedOperationId || '')
      || String(entry.cleanup?.attemptToken || '') !== String(expectedAttemptToken || '')
      || (expectedSubjectHash && String(receipt?.id || '') !== String(expectedSubjectHash))
      || subjectMismatches.length
      || !cleanupReceiptMatches(receipt, registry, entry)) {
      throw cleanupError(
        'WENDKEEP_WORKTREE_CLEANUP_CAS_CONFLICT',
        'O subject ou owner do cleanup mudou antes da finalização; nenhuma conclusão foi publicada.',
      );
    }
    registry.entries[slug] = {
      ...entry,
      state: 'cleaned',
      cleanup: {
        ...entry.cleanup,
        state: 'completed',
        receiptId: receipt.id,
        projectId: receipt.project_id,
        worktreeId: receipt.worktree_id,
        workSessionId: receipt.work_session_id,
        changeSlug: receipt.change_slug,
        targetContextIds: receipt.target_context_ids,
        targetChangeSlugs: receipt.target_change_slugs,
        targetContextSnapshot: structuredClone(receipt.target_context_snapshot || []),
        actorContextId: receipt.actor_context_id,
        authority: receipt.authority,
        pullRequestNumber: receipt.pull_request_number,
        pullRequestRepository: receipt.pull_request_repository,
        headRefOid: receipt.head_ref_oid,
        mergeCommitOid: receipt.merge_commit_oid,
        head: receipt.head,
        subjectHash: receipt.id,
        phase: 'finalized',
        finishedAt: now,
      },
      updatedAt: now,
    };
    return registry;
  });
}

function cleanupReceiptSubject(registry, entry) {
  const cleanup = entry?.cleanup || {};
  return {
    project_id: String(registry?.projectId || ''),
    repository_id: String(registry?.repositoryId || ''),
    worktree_id: String(entry?.worktreeId || ''),
    work_session_id: String(cleanup.workSessionId || entry?.workSessionId || ''),
    change_slug: String(cleanup.changeSlug || entry?.changeSlug || ''),
    target_context_ids: [...new Set(cleanup.targetContextIds || [])].map(String).sort(),
    target_change_slugs: [...new Set(cleanup.targetChangeSlugs || [])].map(String).sort(),
    target_context_snapshot: structuredClone(cleanup.targetContextSnapshot || []),
    actor_context_id: String(cleanup.actorContextId || ''),
    branch: String(entry?.branch || ''),
    head_sha: String(cleanup.head || entry?.head || ''),
    authority: String(cleanup.authority || ''),
    pull_request_number: String(cleanup.pullRequestNumber || ''),
    pull_request_repository: String(cleanup.pullRequestRepository || ''),
    head_ref_oid: String(cleanup.headRefOid || ''),
    merge_commit_oid: String(cleanup.mergeCommitOid || ''),
    worktree_path: String(entry?.path || ''),
    phase: String(cleanup.phase || 'finalized'),
  };
}

function comparableContextSnapshot(value = []) {
  return (Array.isArray(value) ? value : [])
    .map((item) => Object.fromEntries(
      Object.entries(item || {}).sort(([left], [right]) => left.localeCompare(right)),
    ))
    .sort((left, right) => String(left.key || '').localeCompare(String(right.key || '')));
}

function cleanupReceiptCausalMismatches(item, subject) {
  const mismatches = [];
  for (const key of [
    'target_context_ids', 'target_change_slugs',
  ]) {
    const expected = [...new Set(subject?.[key] || [])].map(String).sort();
    const observed = [...new Set(item?.[key] || [])].map(String).sort();
    if (JSON.stringify(expected) !== JSON.stringify(observed)) mismatches.push(`${key} mismatch`);
  }
  if (JSON.stringify(comparableContextSnapshot(item?.target_context_snapshot))
    !== JSON.stringify(comparableContextSnapshot(subject?.target_context_snapshot))) {
    mismatches.push('target_context_snapshot mismatch');
  }
  for (const key of [
    'actor_context_id', 'authority', 'pull_request_number', 'pull_request_repository',
    'head_ref_oid', 'merge_commit_oid', 'worktree_path', 'phase',
  ]) {
    if (String(item?.[key] || '') !== String(subject?.[key] || '')) mismatches.push(`${key} mismatch`);
  }
  return mismatches;
}

function cleanupReceiptMatches(item, registry, entry) {
  const cleanup = entry?.cleanup || {};
  return item.repository_id === registry?.repositoryId
    && item.project_id === registry?.projectId
    && item.worktree_id === entry.worktreeId
    && item.work_session_id === (cleanup.workSessionId || '')
    && item.change_slug === (cleanup.changeSlug || '')
    && JSON.stringify([...new Set(item.target_context_ids || [])].map(String).sort())
      === JSON.stringify([...new Set(cleanup.targetContextIds || [])].map(String).sort())
    && JSON.stringify([...new Set(item.target_change_slugs || [])].map(String).sort())
      === JSON.stringify([...new Set(cleanup.targetChangeSlugs || [])].map(String).sort())
    && JSON.stringify(comparableContextSnapshot(item.target_context_snapshot))
      === JSON.stringify(comparableContextSnapshot(cleanup.targetContextSnapshot))
    && item.actor_context_id === (cleanup.actorContextId || '')
    && item.slug === entry.slug
    && item.branch === entry.branch
    && item.mode === cleanup.mode
    && item.authority === cleanup.authority
    && item.pull_request_number === (cleanup.pullRequestNumber || '')
    && item.pull_request_repository === (cleanup.pullRequestRepository || '')
    && item.head_ref_oid === (cleanup.headRefOid || '')
    && item.merge_commit_oid === (cleanup.mergeCommitOid || '')
    && item.worktree_path === (entry.path || '')
    && item.phase === (cleanup.phase || 'finalized')
    && item.head === cleanup.head;
}

function cleanupReceiptAssessment(
  item,
  registry,
  entry,
  { receiptClassifier = classifyReceipt, provenanceGate = evaluateProvenanceGate } = {},
) {
  const subject = cleanupReceiptSubject(registry, entry);
  const observation = {
    ...(item.observations || {}),
    status: item.observations?.status || 'reported',
    receipt_id: item.id,
  };
  const assessment = receiptClassifier({ receipt: item, observation, subject });
  const gate = provenanceGate({
    purpose: 'worktree-cleanup',
    assessments: [assessment],
    requiredKinds: ['worktree-cleanup'],
  });
  const causalMismatches = cleanupReceiptCausalMismatches(item, subject);
  if (!causalMismatches.length) return { gate, subject, observation };
  return {
    gate: {
      ...gate,
      ok: false,
      state: 'conflict',
      reasonCodes: [...new Set([...(gate.reasonCodes || []), 'PROV_RECEIPT_CONFLICT'])],
      diagnostics: [{
        kind: 'worktree-cleanup',
        state: 'conflict',
        blocker: 'PROV_RECEIPT_CONFLICT',
        expected: subject,
        observed: item,
      }],
      repair: gate.repair || { command: 'wendkeep verify --deep' },
    },
    subject,
    observation,
  };
}

function cleanupOperationAssessment({ mode, report, proof, authority, head, identity = {} }) {
  const snapshot = canonicalPrSnapshot(proof);
  const subject = {
    project_id: String(report?.registry?.projectId || ''),
    repository_id: String(report?.registry?.repositoryId || ''),
    worktree_id: String(report?.entry?.worktreeId || ''),
    work_session_id: String(identity.work_session_id || ''),
    change_slug: String(identity.change_slug || ''),
    target_context_ids: [...new Set(identity.target_context_ids || [])].map(String).sort(),
    target_change_slugs: [...new Set(identity.target_change_slugs || [])].map(String).sort(),
    target_context_snapshot: structuredClone(identity.target_context_snapshot || []),
    actor_context_id: String(identity.actor_context_id || ''),
    worktree_path: String(identity.worktree_path || report?.entry?.path || ''),
    branch: String(report?.entry?.branch || ''),
    head_sha: String(head || ''),
    authority: String(authority || ''),
    pull_request_number: snapshot?.number ? String(snapshot.number) : '',
    pull_request_repository: snapshot?.repository || '',
    head_ref_oid: snapshot?.head_ref_oid || '',
    merge_commit_oid: snapshot?.merge_commit_oid || '',
  };
  const identityValid = [
    subject.project_id,
    subject.repository_id,
    subject.worktree_id,
    subject.branch,
    subject.head_sha,
    subject.authority,
  ].every(Boolean);
  const proofValid = mode === 'remove'
    ? /^reason:[a-f0-9]{64}$/.test(subject.authority)
    : Boolean(
      proof?.state === 'MERGED'
      && proof?.headRefName === subject.branch
      && proof?.headRefOid === subject.head_sha
      && proof?.mergeCommitOid
      && canonicalPrAuthority(proof) === subject.authority,
    );
  const state = identityValid && proofValid ? 'verified' : 'unproven';
  const reasonCodes = state === 'verified' ? [] : ['PROV_RECEIPT_INVALID'];
  return {
    kind: 'worktree-cleanup',
    state,
    reasonCodes,
    diagnostics: [{
      kind: 'worktree-cleanup',
      state,
      blocker: reasonCodes[0] || null,
      expected: subject,
      observed: {
        proof: canonicalPrSnapshot(proof),
        mode,
        authority: subject.authority,
        head_sha: subject.head_sha,
        work_session_id: subject.work_session_id,
        change_slug: subject.change_slug,
        target_context_ids: subject.target_context_ids,
        target_change_slugs: subject.target_change_slugs,
        actor_context_id: subject.actor_context_id,
      },
    }],
  };
}

function requireCleanupOperationGate({
  mode, report, proof, authority, head, identity = {},
  provenanceGate = evaluateProvenanceGate,
} = {}) {
  const assessment = cleanupOperationAssessment({
    mode, report, proof, authority, head, identity,
  });
  const gate = provenanceGate({
    purpose: 'worktree-cleanup',
    assessments: [assessment],
    requiredKinds: ['worktree-cleanup'],
  });
  if (gate?.ok !== true || gate?.state !== 'verified') {
    throw cleanupProvenanceError(
      gate || { state: 'unproven', reasonCodes: ['PROV_RECEIPT_INVALID'], diagnostics: [] },
      assessment.diagnostics[0].expected,
      assessment.diagnostics[0].observed,
    );
  }
  return gate;
}

function requireCleanupReceiptGate(
  receipt,
  repository,
  slug,
  { receiptClassifier = classifyReceipt, provenanceGate = evaluateProvenanceGate } = {},
) {
  const { registry } = readWorktreeRegistry(repository);
  const entry = registry?.entries?.[slug];
  const result = cleanupReceiptAssessment(receipt, registry, entry, {
    receiptClassifier,
    provenanceGate,
  });
  if (result.gate?.ok !== true || result.gate?.state !== 'verified') {
    throw cleanupProvenanceError(result.gate, result.subject, receipt);
  }
  return result.gate;
}

function cleanupProvenanceError(gate, subject, observed) {
  const diagnostic = gate?.diagnostics?.[0] || {};
  return cleanupError(
    'WENDKEEP_PROVENANCE_GATE_BLOCKED',
    'O receipt de cleanup não satisfaz o gate de proveniência comum.',
    {
      operation: 'worktree-cleanup',
      state: gate?.state || 'unproven',
      blocker: diagnostic.blocker || gate?.reasonCodes?.[0] || 'PROV_RECEIPT_INVALID',
      reasonCodes: gate?.reasonCodes || [],
      expected: diagnostic.expected || subject,
      observed: diagnostic.observed || observed,
      recovery: gate?.repair?.command || 'wendkeep verify --deep',
    },
  );
}

function existingCompletion(repository, entry, options = {}) {
  if (entry?.state !== 'cleaned') return null;
  const { registry } = readWorktreeRegistry(repository);
  const receipts = readReceipts(repository);
  const receipt = receipts.find((item) => item.id === entry.cleanup?.receiptId);
  if (!receipt) {
    const legacy = hasValidLegacyReceiptAnchor(repository);
    const subject = cleanupReceiptSubject(registry, entry);
    throw cleanupProvenanceError({
      state: legacy ? 'legacy-unbound' : 'unproven',
      reasonCodes: [legacy ? 'PROV_RECEIPT_LEGACY' : 'PROV_RECEIPT_OBSERVATION_MISSING'],
      diagnostics: [{
        blocker: legacy ? 'PROV_RECEIPT_LEGACY' : 'PROV_RECEIPT_OBSERVATION_MISSING',
        expected: subject,
        observed: null,
      }],
      repair: { command: legacy ? 'wendkeep verify --deep' : 'revise o registry e o receipt store' },
    }, subject, null);
  }
  const { gate, subject } = cleanupReceiptAssessment(receipt, registry, entry, options);
  if (!gate.ok) throw cleanupProvenanceError(gate, subject, receipt);
  if (!cleanupReceiptMatches(receipt, registry, entry)) {
    throw cleanupProvenanceError({
      state: 'conflict',
      reasonCodes: ['PROV_RECEIPT_CONFLICT'],
      diagnostics: [{
        blocker: 'PROV_RECEIPT_CONFLICT', expected: subject, observed: receipt,
      }],
      repair: { command: 'wendkeep verify --deep' },
    }, subject, receipt);
  }
  const sessionRegistry = readSessionRegistry(registry.vaultPath);
  const cleanupReservation = cleanupReservationForWorktree(
    sessionRegistry,
    entry?.worktreeId,
    registry?.repositoryId,
  );
  if (receipt.operationId) {
    // Reconcile a crash between finalize and release. The tombstone is
    // durable, so a later writer cannot reopen the cleaned worktree while
    // this idempotent completion is being repaired.
    markActiveContextCleanupTerminal(registry.vaultPath, {
      operationId: receipt.operationId,
      projectId: receipt.project_id,
      repositoryId: receipt.repository_id,
      worktreeId: receipt.worktree_id,
      workSessionId: receipt.work_session_id,
      changeSlug: receipt.change_slug,
      targetContextIds: receipt.target_context_ids,
      targetChangeSlugs: receipt.target_change_slugs,
      targetContextSnapshot: receipt.target_context_snapshot,
      worktreePath: entry.path,
      subjectHash: receipt.id,
      actorContextId: receipt.actor_context_id,
      mode: receipt.mode,
      authority: receipt.authority,
      head: receipt.head,
      slug: receipt.slug,
      pullRequestNumber: receipt.pull_request_number,
      pullRequestRepository: receipt.pull_request_repository,
      headRefOid: receipt.head_ref_oid,
      mergeCommitOid: receipt.merge_commit_oid,
      attemptToken: entry.cleanup?.attemptToken || cleanupReservation?.attempt_token || '',
      allowMissingReservation: true,
    });
  }
  if (cleanupReservation
    && String(cleanupReservation.operation_id || '') === String(receipt.operationId || '')) {
    releaseActiveContextCleanup(registry.vaultPath, receipt.operationId, {
      repositoryId: registry.repositoryId,
      worktreeId: entry.worktreeId,
      attemptToken: cleanupReservation.attempt_token || entry.cleanup?.attemptToken || '',
    });
  }
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
  actorContext = '',
  faultInjection = {},
  provenanceGate = evaluateProvenanceGate,
  receiptClassifier = classifyReceipt,
} = {}) {
  const repository = discoverWorktreeRepository({ startDir, spawn });
  const initial = requiredEntry(repository, slug);
  // Validate the append-only receipt chain before any fetch, reservation, or
  // irreversible worktree mutation. A corrupt/truncated ledger is a hard stop.
  readReceipts(repository);
  const completed = existingCompletion(repository, initial.entry, {
    provenanceGate, receiptClassifier,
  });
  if (completed) return completed;
  if (initial.entry.cleanup?.state === 'cleaning'
    && cleanupReservationIsActive(repository, slug, initial.entry)) {
    throw cleanupError('WENDKEEP_WORKTREE_CLEANUP_BUSY', `Cleanup de "${slug}" já está em andamento.`);
  }
  const resumed = isResumableCleanup(initial.entry, 'finish');
  let proof = resumed ? storedPullRequestProof(initial.entry) : null;
  if (resumed && !proof) {
    throw cleanupError(
      'WENDKEEP_WORKTREE_PR_UNAVAILABLE',
      'A prova reservada do PR está incompleta; não é seguro refazer a prova após a mutação.',
      { operationId: initial.entry.cleanup.operationId },
    );
  }
  if (!proof) {
    const pullRequestReference = pullRequest
      || initial.entry.pullRequest?.number
      || initial.entry.pullRequest?.url;
    if (git(repository.mainWorktree, ['remote', 'get-url', 'origin'], {
      ok: false, spawn,
    }).status === 0) {
      git(repository.mainWorktree, ['fetch', '--prune', 'origin'], { spawn });
    }
    proof = await verifyMergedPullRequest({
      startDir: repository.mainWorktree,
      entry: initial.entry,
      pullRequest: pullRequestReference,
      github,
      spawn,
    });
  }
  const at = String(now());
  const report = inspectWorktreeCleanup({ startDir: repository.mainWorktree, slug, spawn });
  if (!report.ok) throw blockerError(report);
  // The PR proof is awaited above. A concurrent caller may therefore have
  // completed the cleanup while this invocation was waiting. Reconcile the
  // current registry/receipt before deriving the branch head again; otherwise
  // the already-deleted branch is misreported as an unprovable fresh cleanup.
  const racedCompletion = existingCompletion(repository, requiredEntry(repository, slug).entry, {
    provenanceGate, receiptClassifier,
  });
  if (racedCompletion) return racedCompletion;
  const authority = canonicalPrAuthority(proof);
  const initialDerivedHead = branchHead(repository, report.entry.branch, spawn);
  const initialHead = initialDerivedHead || (resumed
    ? String(initial.entry.cleanup?.head || proof.headRefOid || '') : '');
  if (!initialHead) {
    throw cleanupError(
      'WENDKEEP_WORKTREE_BRANCH_UNPROVEN',
      'Não foi possível provar o head atual da branch antes do cleanup.',
    );
  }
  if (proof.headRefOid && initialDerivedHead && proof.headRefOid !== initialDerivedHead) {
    throw cleanupError(
      'WENDKEEP_WORKTREE_PR_HEAD_MISMATCH',
      'O head atual da branch mudou desde a prova do PR.',
    );
  }
  const identity = cleanupIdentity(report, {
    authority, proof, actorContext,
    prior: initial.entry.cleanup,
  });
  requireCleanupOperationGate({
    mode: 'finish', report, proof, authority, head: initialHead, identity, provenanceGate,
  });
  const orphanedOperationId = orphanedReservationOperationId(report, identity, {
    mode: 'finish', authority, head: initialHead, slug, resumed,
  });
  const reservationOperationId = resumed
    ? String(initial.entry.cleanup.operationId)
    : (orphanedOperationId || randomUUID());
  const attemptToken = randomUUID();
  let reservation;
  let contextReservationAcquired = false;
  try {
    reserveContextCausally({
      vaultPath: report.registry.vaultPath,
      repository,
      slug,
      baselineReport: report,
      baselineIdentity: identity,
      priorCleanup: initial.entry.cleanup,
      proof,
      authority,
      actorContext,
      spawn,
      reserveOptions: {
        operationId: reservationOperationId,
        projectId: identity.project_id,
        repositoryId: identity.repository_id,
        worktreeId: identity.worktree_id,
        workSessionId: identity.work_session_id,
        changeSlug: identity.change_slug,
        targetContextIds: identity.target_context_ids,
        targetChangeSlugs: identity.target_change_slugs,
        targetContextSnapshot: identity.target_context_snapshot,
        allowClosedContexts: resumed,
        allowActiveSessions: resumed && !existsSync(report.entry.path),
        actorContextId: identity.actor_context_id,
        worktreePath: report.entry.path,
        mode: 'finish',
        authority,
        head: initialHead,
        slug,
        pullRequestNumber: identity.pull_request_number,
        pullRequestRepository: identity.pull_request_repository,
        headRefOid: identity.head_ref_oid,
        mergeCommitOid: identity.merge_commit_oid,
        ownerPid: process.pid,
        attemptToken,
        phase: 'reserved-before-worktree',
        now: at,
      },
    });
    contextReservationAcquired = true;
    reservation = reserve(repository, slug, {
      mode: 'finish', authority, proof, identity, head: initialHead, now: at,
      operationId: reservationOperationId, attemptToken,
    });
    if (reservation.previous?.state === 'cleaned') {
      releaseActiveContextCleanup(report.registry.vaultPath, reservationOperationId, {
        repositoryId: identity.repository_id,
        worktreeId: identity.worktree_id,
        attemptToken,
      });
      contextReservationAcquired = false;
      return existingCompletion(repository, requiredEntry(repository, slug).entry, {
        provenanceGate, receiptClassifier,
      });
    }
  } catch (error) {
    if (contextReservationAcquired) {
      try {
        releaseActiveContextCleanup(report.registry.vaultPath, reservationOperationId, {
          repositoryId: identity.repository_id,
          worktreeId: identity.worktree_id,
          attemptToken,
        });
      } catch { /* preserve root */ }
    }
    if (!contextReservationAcquired
      && error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED'
      && error?.blocker === 'WENDKEEP_PROVENANCE_CONTEXT_MISMATCH') {
      try {
        const failed = recordPreReservationFailure({
          repository,
          slug,
          mode: 'finish',
          authority,
          proof,
          identity,
          head: initialHead,
          now: at,
          operationId: reservationOperationId,
          error,
        });
        error.operationId = failed.operationId;
        error.state = failed.entry?.cleanup?.state || 'failed';
        error.recovery = cleanupRecovery(failed.entry || initial.entry);
      } catch { /* preserve the causal conflict */ }
    }
    throw error;
  }
  const { operationId } = reservation;
  let irreversibleStarted = false;
  try {
    updateActiveContextCleanupPhase(report.registry.vaultPath, {
      operationId, repositoryId: identity.repository_id, worktreeId: identity.worktree_id,
      attemptToken, phase: 'ready', now: at,
    });
    invokeFault(faultInjection, 'beforePathRemoval', { operationId, slug });
    const mutation = revalidateCleanupBeforeMutation({
      repository,
      slug,
      baselineReport: report,
      baselineIdentity: identity,
      priorCleanup: initial.entry.cleanup,
      proof,
      authority,
      actorContext,
      expectedHead: initialHead,
      spawn,
      provenanceGate,
    });
    const expectedHead = mutation.head;
    updateActiveContextCleanupPhase(report.registry.vaultPath, {
      operationId, repositoryId: identity.repository_id, worktreeId: identity.worktree_id,
      attemptToken, phase: 'removing', now: at,
    });
    irreversibleStarted = true;
    removePath(repository, mutation.report.entry, spawn);
    invokeFault(faultInjection, 'afterPathRemoval', { operationId, slug });
    const postRemoval = assertPostRemovalCausalSnapshot({
      beforeReport: mutation.report,
      beforeIdentity: mutation.identity,
      repository,
      slug,
      proof,
      authority,
      actorContext,
      spawn,
      priorCleanup: initial.entry.cleanup,
    });
    closeContexts(postRemoval.report.registry.vaultPath, postRemoval.report.contexts, at, operationId);
    assertNoActiveCleanupContexts(mutation.report.registry.vaultPath, mutation.report.entry);
    const remoteBranchDeleted = deleteRemote
      ? deleteRemoteBranch(repository, mutation.report.entry.branch, expectedHead, spawn)
      : false;
    const localBranchDeleted = deleteLocalBranch(
      repository, mutation.report.entry.branch, expectedHead, spawn,
    );
    invokeFault(faultInjection, 'afterBranchDeletion', { operationId, slug });
    invokeFault(faultInjection, 'beforeAppend', { operationId, slug });
    const receipt = receiptForOperation(repository, operationId, {
      slug, mode: 'finish', authority,
    }) || appendReceipt(repository, {
      ...identity,
      operationId,
      reservationId: operationId,
      slug,
      mode: 'finish',
      authority,
      outcome: 'completed',
      branch: mutation.report.entry.branch,
      head: expectedHead || mutation.report.entry.head,
      pull_request: proof,
      local_branch_deleted: localBranchDeleted,
      remote_branch_deleted: remoteBranchDeleted,
      worktree_path: mutation.report.entry.path,
      phase: 'finalized',
      finished_at: at,
    });
    requireCleanupReceiptGate(receipt, repository, slug, {
      receiptClassifier, provenanceGate,
    });
    invokeFault(faultInjection, 'afterAppend', { operationId, receipt, slug });
    invokeFault(faultInjection, 'beforeFinalize', { operationId, receipt, slug });
    assertNoActiveCleanupContexts(mutation.report.registry.vaultPath, mutation.report.entry);
    markActiveContextCleanupTerminal(mutation.report.registry.vaultPath, {
      operationId,
      projectId: receipt.project_id,
      repositoryId: receipt.repository_id,
      worktreeId: receipt.worktree_id,
      workSessionId: receipt.work_session_id,
      changeSlug: receipt.change_slug,
      targetContextIds: receipt.target_context_ids,
      targetChangeSlugs: receipt.target_change_slugs,
      targetContextSnapshot: receipt.target_context_snapshot,
      worktreePath: mutation.report.entry.path,
      subjectHash: receipt.id,
      actorContextId: receipt.actor_context_id,
      mode: receipt.mode,
      authority: receipt.authority,
      head: receipt.head,
      slug: receipt.slug,
      pullRequestNumber: receipt.pull_request_number,
      pullRequestRepository: receipt.pull_request_repository,
      headRefOid: receipt.head_ref_oid,
      mergeCommitOid: receipt.merge_commit_oid,
      attemptToken,
      now: at,
    });
    invokeFault(faultInjection, 'afterTerminal', { operationId, receipt, slug });
    finalize(repository, slug, {
      receipt,
      now: at,
      expectedOperationId: operationId,
      expectedAttemptToken: attemptToken,
      expectedSubjectHash: receipt.id,
    });
    invokeFault(faultInjection, 'afterFinalize', { operationId, receipt, slug });
    releaseActiveContextCleanup(report.registry.vaultPath, operationId, {
      repositoryId: identity.repository_id,
      worktreeId: identity.worktree_id,
      attemptToken,
    });
    contextReservationAcquired = false;
    releaseCleanupOperation(repository, slug);
    return { state: 'completed', idempotent: false, receipt };
  } catch (error) {
    let failedRegistry = null;
    try { failedRegistry = failReservation(repository, slug, error, String(now())); } catch { /* preserve root error */ }
    error.operationId = error.operationId || operationId;
    const failedEntry = failedRegistry?.entries?.[slug];
    error.state = failedEntry?.cleanup?.state || 'failed';
    if (error.state === 'failed') error.recovery = cleanupRecovery(failedEntry || initial.entry);
    if (irreversibleStarted) {
      try {
        updateActiveContextCleanupPhase(report.registry.vaultPath, {
          operationId,
          repositoryId: identity.repository_id,
          worktreeId: identity.worktree_id,
          attemptToken,
          phase: failedEntry?.cleanup?.state === 'completed' ? 'finalized' : 'failed',
          now: String(now()),
        });
      } catch { /* preserve root */ }
    }
    if (contextReservationAcquired && !irreversibleStarted) {
      try {
        releaseActiveContextCleanup(report.registry.vaultPath, operationId, {
          repositoryId: identity.repository_id,
          worktreeId: identity.worktree_id,
          attemptToken,
        });
      } catch { /* preserve root */ }
    }
    releaseCleanupOperation(repository, slug);
    throw error;
  }
}

export async function removeManagedWorktree({
  startDir = process.cwd(),
  slug,
  reason,
  spawn = spawnSync,
  now = () => new Date().toISOString(),
  actorContext = '',
  faultInjection = {},
  provenanceGate = evaluateProvenanceGate,
  receiptClassifier = classifyReceipt,
} = {}) {
  const reasonEvidence = normalizedReason(reason);
  if (!String(reason || '').trim()) {
    throw cleanupError('WENDKEEP_WORKTREE_REASON_REQUIRED', '`worktree remove` exige --reason.');
  }
  const repository = discoverWorktreeRepository({ startDir, spawn });
  const initial = requiredEntry(repository, slug);
  readReceipts(repository);
  const completed = existingCompletion(repository, initial.entry, {
    provenanceGate, receiptClassifier,
  });
  if (completed) return completed;
  const report = inspectWorktreeCleanup({ startDir: repository.mainWorktree, slug, spawn });
  if (!report.ok) throw blockerError(report);
  const at = String(now());
  const authority = reasonEvidence.authority;
  const resumed = isResumableCleanup(initial.entry, 'remove');
  if (resumed && initial.entry.cleanup.authority !== authority) {
    throw cleanupError('WENDKEEP_WORKTREE_CLEANUP_BUSY', 'O motivo não corresponde à operação reservada.');
  }
  const initialDerivedHead = branchHead(repository, report.entry.branch, spawn);
  const initialHead = initialDerivedHead || (resumed
    ? String(initial.entry.cleanup?.head || report.entry.head || '') : '');
  if (!initialHead) {
    throw cleanupError(
      'WENDKEEP_WORKTREE_BRANCH_UNPROVEN',
      'Não foi possível provar o head atual da branch antes do cleanup.',
    );
  }
  const identity = cleanupIdentity(report, {
    authority, actorContext, prior: initial.entry.cleanup,
  });
  requireCleanupOperationGate({
    mode: 'remove', report, authority, head: initialHead, identity, provenanceGate,
  });
  const orphanedOperationId = orphanedReservationOperationId(report, identity, {
    mode: 'remove', authority, head: initialHead, slug, resumed,
  });
  const reservationOperationId = resumed
    ? String(initial.entry.cleanup.operationId)
    : (orphanedOperationId || randomUUID());
  const attemptToken = randomUUID();
  let reservation;
  let contextReservationAcquired = false;
  try {
    reserveContextCausally({
      vaultPath: report.registry.vaultPath,
      repository,
      slug,
      baselineReport: report,
      baselineIdentity: identity,
      priorCleanup: initial.entry.cleanup,
      authority,
      actorContext,
      spawn,
      reserveOptions: {
        operationId: reservationOperationId,
        projectId: identity.project_id,
        repositoryId: identity.repository_id,
        worktreeId: identity.worktree_id,
        workSessionId: identity.work_session_id,
        changeSlug: identity.change_slug,
        targetContextIds: identity.target_context_ids,
        targetChangeSlugs: identity.target_change_slugs,
        targetContextSnapshot: identity.target_context_snapshot,
        allowClosedContexts: resumed,
        allowActiveSessions: resumed && !existsSync(report.entry.path),
        actorContextId: identity.actor_context_id,
        worktreePath: report.entry.path,
        mode: 'remove',
        authority,
        head: initialHead,
        slug,
        pullRequestNumber: identity.pull_request_number,
        pullRequestRepository: identity.pull_request_repository,
        headRefOid: identity.head_ref_oid,
        mergeCommitOid: identity.merge_commit_oid,
        ownerPid: process.pid,
        attemptToken,
        phase: 'reserved-before-worktree',
        now: at,
      },
    });
    contextReservationAcquired = true;
    reservation = reserve(repository, slug, {
      mode: 'remove', authority, reason: reasonEvidence.label,
      reasonDigest: reasonEvidence.digest, identity, head: initialHead, now: at,
      operationId: reservationOperationId, attemptToken,
    });
    if (reservation.previous?.state === 'cleaned') {
      releaseActiveContextCleanup(report.registry.vaultPath, reservationOperationId, {
        repositoryId: identity.repository_id,
        worktreeId: identity.worktree_id,
        attemptToken,
      });
      contextReservationAcquired = false;
      return existingCompletion(repository, requiredEntry(repository, slug).entry, {
        provenanceGate, receiptClassifier,
      });
    }
  } catch (error) {
    if (contextReservationAcquired) {
      try {
        releaseActiveContextCleanup(report.registry.vaultPath, reservationOperationId, {
          repositoryId: identity.repository_id,
          worktreeId: identity.worktree_id,
          attemptToken,
        });
      } catch { /* preserve root */ }
    }
    if (!contextReservationAcquired
      && error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED'
      && error?.blocker === 'WENDKEEP_PROVENANCE_CONTEXT_MISMATCH') {
      try {
        const failed = recordPreReservationFailure({
          repository,
          slug,
          mode: 'remove',
          authority,
          reason: reasonEvidence.label,
          reasonDigest: reasonEvidence.digest,
          identity,
          head: initialHead,
          now: at,
          operationId: reservationOperationId,
          error,
        });
        error.operationId = failed.operationId;
        error.state = failed.entry?.cleanup?.state || 'failed';
        error.recovery = cleanupRecovery(failed.entry || initial.entry);
      } catch { /* preserve the causal conflict */ }
    }
    throw error;
  }
  const { operationId } = reservation;
  let irreversibleStarted = false;
  try {
    updateActiveContextCleanupPhase(report.registry.vaultPath, {
      operationId: operationId || reservationOperationId,
      repositoryId: identity.repository_id,
      worktreeId: identity.worktree_id,
      attemptToken,
      phase: 'ready',
      now: at,
    });
    invokeFault(faultInjection, 'beforePathRemoval', { operationId, slug });
    const mutation = revalidateCleanupBeforeMutation({
      repository,
      slug,
      baselineReport: report,
      baselineIdentity: identity,
      priorCleanup: initial.entry.cleanup,
      authority,
      actorContext,
      expectedHead: initialHead,
      spawn,
      provenanceGate,
    });
    const expectedHead = mutation.head;
    updateActiveContextCleanupPhase(report.registry.vaultPath, {
      operationId: reservation.operationId,
      repositoryId: identity.repository_id,
      worktreeId: identity.worktree_id,
      attemptToken,
      phase: 'removing',
      now: at,
    });
    irreversibleStarted = true;
    removePath(repository, mutation.report.entry, spawn);
    invokeFault(faultInjection, 'afterPathRemoval', { operationId, slug });
    const postRemoval = assertPostRemovalCausalSnapshot({
      beforeReport: mutation.report,
      beforeIdentity: mutation.identity,
      repository,
      slug,
      authority,
      actorContext,
      spawn,
      priorCleanup: initial.entry.cleanup,
    });
    closeContexts(postRemoval.report.registry.vaultPath, postRemoval.report.contexts, at, operationId);
    assertNoActiveCleanupContexts(mutation.report.registry.vaultPath, mutation.report.entry);
    invokeFault(faultInjection, 'beforeAppend', { operationId, slug });
    const receipt = receiptForOperation(repository, operationId, {
      slug, mode: 'remove', authority,
    }) || appendReceipt(repository, {
      ...identity,
      operationId,
      reservationId: operationId,
      slug,
      mode: 'remove',
      authority,
      outcome: 'completed',
      branch: mutation.report.entry.branch,
      head: expectedHead,
      reason: reasonEvidence.label,
      reason_digest: reasonEvidence.digest,
      local_branch_deleted: false,
      remote_branch_deleted: false,
      worktree_path: mutation.report.entry.path,
      phase: 'finalized',
      finished_at: at,
    });
    requireCleanupReceiptGate(receipt, repository, slug, {
      receiptClassifier, provenanceGate,
    });
    invokeFault(faultInjection, 'afterAppend', { operationId, receipt, slug });
    invokeFault(faultInjection, 'beforeFinalize', { operationId, receipt, slug });
    assertNoActiveCleanupContexts(mutation.report.registry.vaultPath, mutation.report.entry);
    markActiveContextCleanupTerminal(mutation.report.registry.vaultPath, {
      operationId,
      projectId: receipt.project_id,
      repositoryId: receipt.repository_id,
      worktreeId: receipt.worktree_id,
      workSessionId: receipt.work_session_id,
      changeSlug: receipt.change_slug,
      targetContextIds: receipt.target_context_ids,
      targetChangeSlugs: receipt.target_change_slugs,
      targetContextSnapshot: receipt.target_context_snapshot,
      worktreePath: mutation.report.entry.path,
      subjectHash: receipt.id,
      actorContextId: receipt.actor_context_id,
      mode: receipt.mode,
      authority: receipt.authority,
      head: receipt.head,
      slug: receipt.slug,
      pullRequestNumber: receipt.pull_request_number,
      pullRequestRepository: receipt.pull_request_repository,
      headRefOid: receipt.head_ref_oid,
      mergeCommitOid: receipt.merge_commit_oid,
      attemptToken,
      now: at,
    });
    invokeFault(faultInjection, 'afterTerminal', { operationId, receipt, slug });
    finalize(repository, slug, {
      receipt,
      now: at,
      expectedOperationId: operationId,
      expectedAttemptToken: attemptToken,
      expectedSubjectHash: receipt.id,
    });
    invokeFault(faultInjection, 'afterFinalize', { operationId, receipt, slug });
    releaseActiveContextCleanup(report.registry.vaultPath, operationId, {
      repositoryId: identity.repository_id,
      worktreeId: identity.worktree_id,
      attemptToken,
    });
    contextReservationAcquired = false;
    releaseCleanupOperation(repository, slug);
    return { state: 'completed', idempotent: false, receipt };
  } catch (error) {
    let failedRegistry = null;
    try { failedRegistry = failReservation(repository, slug, error, String(now())); } catch { /* preserve root error */ }
    error.operationId = error.operationId || operationId;
    const failedEntry = failedRegistry?.entries?.[slug];
    error.state = failedEntry?.cleanup?.state || 'failed';
    if (error.state === 'failed') error.recovery = cleanupRecovery(failedEntry || initial.entry);
    if (irreversibleStarted) {
      try {
        updateActiveContextCleanupPhase(report.registry.vaultPath, {
          operationId,
          repositoryId: identity.repository_id,
          worktreeId: identity.worktree_id,
          attemptToken,
          phase: failedEntry?.cleanup?.state === 'completed' ? 'finalized' : 'failed',
          now: String(now()),
        });
      } catch { /* preserve root */ }
    }
    if (contextReservationAcquired && !irreversibleStarted) {
      try {
        releaseActiveContextCleanup(report.registry.vaultPath, operationId, {
          repositoryId: identity.repository_id,
          worktreeId: identity.worktree_id,
          attemptToken,
        });
      } catch { /* preserve root */ }
    }
    releaseCleanupOperation(repository, slug);
    throw error;
  }
}

export async function cleanupMergedWorktrees({
  startDir = process.cwd(),
  apply = false,
  github = defaultGithub,
  spawn = spawnSync,
  now = () => new Date().toISOString(),
  actorContext = '',
  faultInjection = {},
  provenanceGate = evaluateProvenanceGate,
  receiptClassifier = classifyReceipt,
} = {}) {
  const repository = discoverWorktreeRepository({ startDir, spawn });
  readReceipts(repository);
  const { registry } = readWorktreeRegistry(repository);
  const actions = [];
  for (const slug of Object.keys(registry.entries || {}).sort()) {
    const entry = registry.entries[slug];
    if (entry.state === 'cleaned') {
      try {
        const completed = existingCompletion(repository, entry, {
          provenanceGate, receiptClassifier,
        });
        if (completed) continue;
      } catch (error) {
        actions.push({
          slug,
          outcome: 'blocked',
          blockers: [String(error?.code || 'WENDKEEP_PROVENANCE_GATE_BLOCKED')],
          state: error?.state || 'unproven',
          blocker: error?.blocker || '',
          recovery: error?.recovery || 'wendkeep verify --deep',
          expected: error?.expected || null,
          observed: error?.observed || null,
        });
      }
      continue;
    }
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
          actorContext,
          faultInjection,
          provenanceGate,
          receiptClassifier,
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
  // Even metadata-only pruning mutates the shared Git worktree state. Validate
  // the receipt chain first so a corrupt/truncated ledger never gets hidden by
  // a successful prune.
  readReceipts(repository);
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
    const reason = recoverySegment(entry.cleanup.reason, 'confirme-o-abandono');
    return `wendkeep worktree remove ${recoverySegment(entry.slug, 'worktree')} --reason ${reason}`;
  }
  const pullRequest = /^\d+$/.test(String(entry.pullRequest?.number || ''))
    ? String(entry.pullRequest.number) : 'pr';
  return `wendkeep worktree finish ${recoverySegment(entry.slug, 'worktree')} --pr ${pullRequest}`;
}

function hasValidLegacyReceiptAnchor(repository) {
  const path = cleanupReceiptLegacyPath(repository);
  if (!existsSync(path)) return false;
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return false; }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  return lines.every((line) => {
    try {
      const value = JSON.parse(line);
      const schemaVersion = Number(value?.schema_version ?? value?.schemaVersion ?? 0);
      return value && typeof value === 'object' && !Array.isArray(value)
        && String(value.id || value.receipt_id || '').trim()
        && ((schemaVersion === 1 && String(value.outcome || '').trim())
          || (String(value.slug || '').trim()
            && String(value.mode || '').trim()
            && String(value.outcome || '').trim()));
    } catch { return false; }
  });
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
  } catch (error) {
    const ledgerCode = [
      'WENDKEEP_RECEIPT_LEDGER_CORRUPT',
      'WENDKEEP_RECEIPT_LEDGER_TRUNCATED',
      'WENDKEEP_RECEIPT_LEDGER_BUSY',
      'WENDKEEP_RECEIPT_LEDGER_CONFLICT',
    ].includes(error?.code) ? error.code : 'WENDKEEP_WORKTREE_CLEANUP_RECEIPT_INVALID';
    return {
      initialized: true,
      issues: [{
        slug: '*',
        state: 'receipt-invalid',
        errorCode: ledgerCode,
        repair: 'revise o receipt store append-only antes de retomar o cleanup',
      }],
    };
  }
  const hasLegacyReceipts = hasValidLegacyReceiptAnchor(repository);
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
        state: hasLegacyReceipts ? 'legacy-unbound' : entry.state,
        errorCode: hasLegacyReceipts
          ? 'WENDKEEP_WORKTREE_CLEANUP_RECEIPT_LEGACY_UNBOUND'
          : 'WENDKEEP_WORKTREE_CLEANUP_RECEIPT_MISSING',
        repair: hasLegacyReceipts
          ? 'rode wendkeep verify novamente para emitir receipts v2'
          : 'revise o registry e o receipt store; não invente um receipt retroativo',
      });
    } else if (entry.state === 'cleaned' && entry.cleanup?.receiptId) {
      const receipt = receipts.find((item) => item.id === entry.cleanup.receiptId);
      if (receipt) {
        const { gate, subject } = cleanupReceiptAssessment(receipt, registry, entry);
        const matches = cleanupReceiptMatches(receipt, registry, entry);
        if (!gate.ok || !matches) {
          const effectiveGate = gate.ok ? {
            state: 'conflict',
            reasonCodes: ['PROV_RECEIPT_CONFLICT'],
            diagnostics: [{ blocker: 'PROV_RECEIPT_CONFLICT', expected: subject, observed: receipt }],
            repair: { command: 'wendkeep verify --deep' },
          } : gate;
          issues.push({
            slug,
            state: effectiveGate.state,
            errorCode: 'WENDKEEP_PROVENANCE_GATE_BLOCKED',
            reasonCodes: effectiveGate.reasonCodes || [],
            blocker: effectiveGate.diagnostics?.[0]?.blocker || null,
            expected: effectiveGate.diagnostics?.[0]?.expected || subject,
            observed: effectiveGate.diagnostics?.[0]?.observed || receipt,
            repair: effectiveGate.repair?.command || 'wendkeep verify --deep',
          });
        }
      }
    }
  }
  return { initialized: true, issues };
}
