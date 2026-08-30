import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  cleanupReservationForWorktree,
  cleanupTombstoneForWorktree,
  comparableCleanupPath,
  mutateSessionRegistry,
  readSessionRegistry,
} from './obsidian-common.mjs';
import { mkdirVaultPath, writeVaultFileSync } from './vault-path-safety.mjs';
import { migrateActiveContextRegistryState } from '../packages/migrations/src/index.mjs';

export const ACTIVE_CONTEXTS_SCHEMA_VERSION = 1;
const POINTER = '.brain/CURRENT_CHANGE.md';
const DELIVERY_POINTER = '.brain/runtime/CURRENT_DELIVERY';
const ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const DELIVERY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/;

export function activeContextRegistryInitialized(registry = {}) {
  return Object.hasOwn(registry, 'active_contexts')
    || Object.hasOwn(registry, 'active_contexts_schema')
    || Object.hasOwn(registry, 'active_contexts_revision');
}

function contextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ownerProcessAlive(ownerPid) {
  const pid = Number(ownerPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function requiredId(value, label) {
  const normalized = String(value || '').trim();
  if (!ID_PATTERN.test(normalized)) {
    throw contextError('WENDKEEP_ACTIVE_CONTEXT_IDENTITY_INVALID', `${label} inválido ou ausente`);
  }
  return normalized;
}

function optionalText(value, maxLength = 240) {
  const normalized = String(value || '').trim();
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
}

function subjectIds(value) {
  return [...new Set(Array.isArray(value) ? value : [])].map(String).sort();
}

function subjectSnapshot(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => Object.fromEntries(
      Object.entries(item || {}).sort(([left], [right]) => left.localeCompare(right)),
    ))
    .sort((left, right) => String(left.key || '').localeCompare(String(right.key || '')));
}

function sameSubjectField(left, right) {
  return String(left || '') === String(right || '');
}

function sameCleanupSubject(left, right) {
  return sameSubjectField(left?.project_id, right?.project_id)
    && sameSubjectField(left?.repository_id, right?.repository_id)
    && sameSubjectField(left?.worktree_id, right?.worktree_id)
    && sameSubjectField(left?.work_session_id, right?.work_session_id)
    && sameSubjectField(left?.change_slug, right?.change_slug)
    && JSON.stringify(subjectIds(left?.target_context_ids))
      === JSON.stringify(subjectIds(right?.target_context_ids))
    && JSON.stringify(subjectIds(left?.target_change_slugs))
      === JSON.stringify(subjectIds(right?.target_change_slugs))
    && JSON.stringify(subjectSnapshot(left?.target_context_snapshot))
      === JSON.stringify(subjectSnapshot(right?.target_context_snapshot))
    && sameSubjectField(left?.actor_context_id, right?.actor_context_id)
    && sameSubjectField(left?.worktree_path, right?.worktree_path)
    && sameSubjectField(left?.mode, right?.mode)
    && sameSubjectField(left?.authority, right?.authority)
    && sameSubjectField(left?.head, right?.head)
    && sameSubjectField(left?.slug, right?.slug)
    && sameSubjectField(left?.pull_request_number, right?.pull_request_number)
    && sameSubjectField(left?.pull_request_repository, right?.pull_request_repository)
    && sameSubjectField(left?.head_ref_oid, right?.head_ref_oid)
    && sameSubjectField(left?.merge_commit_oid, right?.merge_commit_oid);
}

function cleanupSubjectFromOptions({
  projectId = '', repositoryId = '', worktreeId = '', workSessionId = '', changeSlug = '',
  targetContextIds = [], targetChangeSlugs = [], targetContextSnapshot = [], actorContextId = '',
  worktreePath = '', mode = '', authority = '', head = '', slug = '',
  pullRequestNumber = '', pullRequestRepository = '', headRefOid = '', mergeCommitOid = '',
} = {}) {
  return {
    project_id: String(projectId || ''),
    repository_id: String(repositoryId || ''),
    worktree_id: String(worktreeId || ''),
    work_session_id: String(workSessionId || ''),
    change_slug: String(changeSlug || ''),
    target_context_ids: subjectIds(targetContextIds),
    target_change_slugs: subjectIds(targetChangeSlugs),
    target_context_snapshot: subjectSnapshot(targetContextSnapshot),
    actor_context_id: String(actorContextId || ''),
    worktree_path: String(worktreePath || ''),
    mode: String(mode || ''),
    authority: String(authority || ''),
    head: String(head || ''),
    slug: String(slug || ''),
    pull_request_number: String(pullRequestNumber || ''),
    pull_request_repository: String(pullRequestRepository || ''),
    head_ref_oid: String(headRefOid || ''),
    merge_commit_oid: String(mergeCommitOid || ''),
  };
}

function normalizeIdentity(identity = {}, { requireWorkSession = true } = {}) {
  const workSessionId = requireWorkSession
    ? requiredId(identity.workSessionId ?? identity.work_session_id, 'work_session_id')
    : optionalText(identity.workSessionId ?? identity.work_session_id, 160);
  return {
    projectId: requiredId(identity.projectId ?? identity.project_id, 'project_id'),
    repositoryId: requiredId(identity.repositoryId ?? identity.repository_id, 'repository_id'),
    worktreeId: requiredId(identity.worktreeId ?? identity.worktree_id, 'worktree_id'),
    workSessionId,
    branch: optionalText(identity.branch, 240),
    headSha: optionalText(identity.headSha ?? identity.head_sha, 80),
  };
}

export function activeContextKey(identity) {
  const normalized = normalizeIdentity(identity);
  return `${normalized.repositoryId}:${normalized.worktreeId}:${normalized.workSessionId}`;
}

function contextsOf(registry) {
  return registry?.active_contexts && typeof registry.active_contexts === 'object'
    && !Array.isArray(registry.active_contexts)
    ? registry.active_contexts : {};
}

function currentGlobalRevision(registry) {
  const value = Number(registry?.active_contexts_revision);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function currentContextRevision(context) {
  const value = Number(context?.revision);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function activeContexts(registry) {
  return Object.entries(contextsOf(registry)).filter(([, context]) => context?.state === 'active');
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

function legacyProjection(registry) {
  const active = activeContexts(registry);
  if (active.length !== 1) return '';
  return String(active[0][1]?.change_slug || '').trim();
}

export function projectLegacyActiveChange(vaultBase, registry = readSessionRegistry(vaultBase)) {
  const slug = legacyProjection(registry);
  mkdirVaultPath(vaultBase, join(vaultBase, '.brain'), { label: 'raiz de controle da change' });
  writeVaultFileSync(
    vaultBase,
    join(vaultBase, POINTER),
    slug ? `change: ${slug}\n` : 'change:\n',
    'utf8',
    { label: 'projeção legada CURRENT_CHANGE.md' },
  );
  return slug;
}

export function projectLegacyActiveDelivery(vaultBase, registry = readSessionRegistry(vaultBase)) {
  const active = activeContexts(registry);
  const id = active.length === 1 ? optionalText(active[0][1]?.delivery_id, 101) : '';
  mkdirVaultPath(vaultBase, join(vaultBase, '.brain', 'runtime'), {
    label: 'runtime da projeção legada de delivery',
  });
  writeVaultFileSync(
    vaultBase,
    join(vaultBase, DELIVERY_POINTER),
    id ? `${id}\n` : '',
    'utf8',
    { label: 'projeção legada CURRENT_DELIVERY' },
  );
  return id;
}

export function resolveActiveContext(vaultBase, query = {}) {
  const normalized = normalizeIdentity(query, { requireWorkSession: false });
  const registry = readSessionRegistry(vaultBase);
  let workSessionId = normalized.workSessionId;
  const sessionId = optionalText(query.sessionId ?? query.session_id, 160);
  if (!workSessionId && sessionId) {
    const entry = registry.sessions?.[sessionId];
    if (entry?.status !== 'active' || !entry.work_session_id) {
      throw contextError('WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND', 'sessão causal ativa não encontrada');
    }
    workSessionId = String(entry.work_session_id);
  }

  const candidates = activeContexts(registry).filter(([, context]) => (
    context.project_id === normalized.projectId
    && context.repository_id === normalized.repositoryId
    && context.worktree_id === normalized.worktreeId
    && (!workSessionId || context.work_session_id === workSessionId)
  ));
  if (!candidates.length) {
    throw contextError('WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND', 'active context não encontrado para a identidade informada');
  }
  if (candidates.length > 1) {
    throw contextError(
      'WENDKEEP_ACTIVE_CONTEXT_AMBIGUOUS',
      'mais de um active context corresponde à worktree; informe a sessão causal',
    );
  }
  return structuredClone(candidates[0][1]);
}

export function mutateActiveContext(vaultBase, identity, updater, {
  expectedRevision,
  now = new Date().toISOString(),
  mutateRegistry = mutateSessionRegistry,
  projectLegacy = true,
  cleanupOperationId = '',
} = {}) {
  const normalized = normalizeIdentity(identity);
  const key = activeContextKey(normalized);
  const result = mutateRegistry(vaultBase, (registry) => {
    Object.assign(registry, migrateActiveContextRegistryState(registry));
    const terminal = cleanupTombstoneForWorktree(
      registry, normalized.worktreeId, normalized.repositoryId,
    ) || cleanupTombstoneForWorktree(registry, normalized.worktreeId);
    if (terminal
      && String(terminal.operation_id || '') !== String(cleanupOperationId || '')) {
      throw contextError(
        'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_TERMINAL',
        'a worktree já foi finalizada por um cleanup anterior',
      );
    }
    const cleanupReservation = cleanupReservationForWorktree(
      registry, normalized.worktreeId, normalized.repositoryId,
    ) || cleanupReservationForWorktree(registry, normalized.worktreeId);
    if (cleanupReservation
      && String(cleanupReservation.operation_id || '') !== String(cleanupOperationId || '')) {
      throw contextError(
        'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_RESERVED',
        'active context está reservado por um cleanup em andamento',
      );
    }
    const contexts = contextsOf(registry);
    const existing = contexts[key] || null;
    const revision = currentContextRevision(existing);
    if (expectedRevision !== undefined && Number(expectedRevision) !== revision) {
      throw contextError(
        'WENDKEEP_ACTIVE_CONTEXT_STALE',
        `active context revision mudou de ${expectedRevision} para ${revision}`,
      );
    }
    const base = existing || {
      project_id: normalized.projectId,
      repository_id: normalized.repositoryId,
      worktree_id: normalized.worktreeId,
      work_session_id: normalized.workSessionId,
      branch: normalized.branch,
      head_sha: normalized.headSha,
      change_slug: '',
      state: 'active',
      revision: 0,
      updated_at: String(now),
    };
    const updated = updater(structuredClone(base));
    if (!updated || typeof updated !== 'object' || Array.isArray(updated)) {
      throw contextError('WENDKEEP_ACTIVE_CONTEXT_INVALID', 'mutação retornou active context inválido');
    }
    for (const [field, expected] of [
      ['project_id', normalized.projectId],
      ['repository_id', normalized.repositoryId],
      ['worktree_id', normalized.worktreeId],
      ['work_session_id', normalized.workSessionId],
    ]) {
      if (updated[field] !== expected) {
        throw contextError('WENDKEEP_ACTIVE_CONTEXT_IDENTITY_MISMATCH', `${field} não pode mudar`);
      }
    }
    const next = {
      ...updated,
      branch: normalized.branch || optionalText(updated.branch, 240),
      head_sha: normalized.headSha || optionalText(updated.head_sha, 80),
      state: updated.state === 'closed' ? 'closed' : 'active',
      revision: revision + 1,
      updated_at: String(now),
    };
    registry.active_contexts_schema = ACTIVE_CONTEXTS_SCHEMA_VERSION;
    registry.active_contexts_revision = currentGlobalRevision(registry) + 1;
    registry.active_contexts = { ...contexts, [key]: next };
    return { key, context: structuredClone(next), registryRevision: registry.active_contexts_revision };
  }, { cleanupOperationId });
  if (projectLegacy) {
    projectLegacyActiveChange(vaultBase);
    projectLegacyActiveDelivery(vaultBase);
  }
  return result;
}

export function reserveActiveContextCleanup(vaultBase, {
  operationId,
  projectId,
  repositoryId,
  worktreeId,
  workSessionId = '',
  changeSlug = '',
  targetContextIds = [],
  targetChangeSlugs = [],
  targetContextSnapshot = [],
  allowClosedContexts = false,
  allowActiveSessions = false,
  actorContextId = '',
  worktreePath = '',
  mode = '',
  authority = '',
  head = '',
  slug = '',
  pullRequestNumber = '',
  pullRequestRepository = '',
  headRefOid = '',
  mergeCommitOid = '',
  ownerPid = process.pid,
  attemptToken = '',
  phase = 'reserved',
  now = new Date().toISOString(),
} = {}) {
  const operation = requiredId(operationId, 'cleanup operation_id');
  const project = requiredId(projectId, 'project_id');
  const repository = requiredId(repositoryId, 'repository_id');
  const worktree = requiredId(worktreeId, 'worktree_id');
  return mutateSessionRegistry(vaultBase, (registry) => {
    const terminal = cleanupTombstoneForWorktree(registry, worktree, repository)
      || cleanupTombstoneForWorktree(registry, worktree);
    if (terminal && String(terminal.repository_id || '') !== repository) {
      throw contextError(
        'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_TERMINAL_CONFLICT',
        'o tombstone terminal pertence a outro repositório',
      );
    }
    if (terminal && String(terminal.operation_id || '') !== operation) {
      throw contextError(
        'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_TERMINAL',
        'a worktree já foi finalizada por um cleanup anterior',
      );
    }
    const existing = cleanupReservationForWorktree(registry, worktree, repository);
    const foreignReservation = cleanupReservationForWorktree(registry, worktree);
    if (foreignReservation && (!existing || foreignReservation !== existing)) {
      throw contextError(
        'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_RESERVED',
        'já existe um cleanup reservado para esta worktree',
      );
    }
    if (existing && String(existing.operation_id || '') !== operation) {
      throw contextError(
        'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_BUSY',
        'já existe um cleanup reservado para esta worktree',
      );
    }
    if (existing && String(existing.operation_id || '') === operation) {
      const storedAttempt = String(existing.attempt_token || '');
      const requestedAttempt = String(attemptToken || '');
      const sameAttempt = requestedAttempt && storedAttempt
        && requestedAttempt === storedAttempt;
      const terminalPhase = ['failed', 'finalized'].includes(String(existing.phase || ''));
      if (!sameAttempt && !terminalPhase && ownerProcessAlive(existing.owner_pid)) {
        throw contextError(
          'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_BUSY',
          'já existe uma tentativa ativa para esta operação de cleanup',
        );
      }
    }
    const active = Object.entries(contextsOf(registry))
      .filter(([, context]) => context?.state === 'active'
        && context?.worktree_id === worktree);
    if (active.some(([, context]) => String(context?.repository_id || '') !== repository)) {
      throw contextError(
        'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_RESERVED',
        'há um active context de outro repositório com o mesmo worktree_id',
      );
    }
    const scopedActive = active.filter(([, context]) => context?.repository_id === repository);
    const actualContextIds = scopedActive.map(([key]) => String(key)).sort();
    const actualChangeSlugs = [...new Set(scopedActive
      .map(([, context]) => String(context?.change_slug || '').trim())
      .filter(Boolean))].sort();
    const expectedContextIds = subjectIds(targetContextIds);
    const expectedChangeSlugs = subjectIds(targetChangeSlugs);
    const expectedSnapshot = contextCausalSnapshot(
      (targetContextSnapshot || []).map((context) => [context.key, context]),
    );
    const actualSnapshot = contextCausalSnapshot(scopedActive);
    const closedForRetry = allowClosedContexts
      && actualContextIds.length === 0
      && expectedContextIds.length > 0;
    if ((!closedForRetry && JSON.stringify(actualContextIds) !== JSON.stringify(expectedContextIds))
      || (!closedForRetry && JSON.stringify(actualChangeSlugs) !== JSON.stringify(expectedChangeSlugs))
      || (!closedForRetry && expectedSnapshot.length
        && JSON.stringify(actualSnapshot) !== JSON.stringify(expectedSnapshot))) {
      throw contextError(
        'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_CONTEXT_MISMATCH',
        'active contexts mudaram antes da reserva do cleanup',
      );
    }
    const comparablePath = comparableCleanupPath(worktreePath);
    const activeSessions = Object.entries(registry.sessions || {}).filter(([, session]) => {
      if (session?.status !== 'active') return false;
      const sameSession = workSessionId && String(session.work_session_id || '') === String(workSessionId);
      const sessionPath = comparableCleanupPath(session?.project_scope?.repoRoot);
      return sameSession || (comparablePath && sessionPath === comparablePath);
    });
    if (activeSessions.length && !allowActiveSessions) {
      throw contextError(
        'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_SESSION_RESERVED',
        'sessão ativa está reservada por um cleanup em andamento',
      );
    }
    if (allowActiveSessions) {
      // A path ausente só é retomável quando a sessão causal é fechada na
      // mesma transação que reinstala a reserva. O retry não pode deixar uma
      // sessão ativa apontando para uma worktree já removida.
      for (const [sessionId, session] of activeSessions) {
        registry.sessions[sessionId] = {
          ...session,
          status: 'done',
          active_activation_id: '',
          ended_at: String(now),
        };
      }
    }
    const reservations = {
      ...(registry.cleanup_reservations || {}),
      [`${repository}:${worktree}`]: {
        state: 'cleaning',
        operation_id: operation,
        project_id: project,
        repository_id: repository,
        worktree_id: worktree,
        work_session_id: optionalText(workSessionId, 160),
        change_slug: optionalText(changeSlug, 160),
        target_context_ids: expectedContextIds,
        target_change_slugs: expectedChangeSlugs,
        target_context_snapshot: subjectSnapshot(expectedSnapshot),
        actor_context_id: optionalText(actorContextId, 160),
        worktree_path: optionalText(worktreePath, 1024),
        mode: optionalText(mode, 32),
        authority: optionalText(authority, 240),
        head: optionalText(head, 80),
        slug: optionalText(slug, 160),
        pull_request_number: optionalText(pullRequestNumber, 80),
        pull_request_repository: optionalText(pullRequestRepository, 240),
        head_ref_oid: optionalText(headRefOid, 160),
        merge_commit_oid: optionalText(mergeCommitOid, 160),
        owner_pid: Number.isSafeInteger(Number(ownerPid)) ? Number(ownerPid) : process.pid,
        phase: optionalText(phase, 48),
        ...(attemptToken ? { attempt_token: optionalText(attemptToken, 160) } : {}),
        updated_at: String(now),
      },
    };
    registry.cleanup_reservations = reservations;
    return structuredClone(reservations[`${repository}:${worktree}`]);
  }, { cleanupOperationId: operation });
}

export function releaseActiveContextCleanup(vaultBase, operationId, {
  repositoryId = '', worktreeId = '', attemptToken = '',
} = {}) {
  const operation = String(operationId || '').trim();
  if (!operation) return false;
  let released = false;
  mutateSessionRegistry(vaultBase, (registry) => {
    const reservations = { ...(registry.cleanup_reservations || {}) };
    const matchingKeys = Object.keys(reservations).filter((key) => (
      String(reservations[key]?.operation_id || '') === operation
    ));
    if ((!repositoryId || !worktreeId) && matchingKeys.length !== 1) return false;
    const candidates = repositoryId && worktreeId
      ? [`${String(repositoryId).trim()}:${String(worktreeId).trim()}`]
      : matchingKeys;
    for (const key of candidates) {
      const reservation = reservations[key];
      if (String(reservation?.operation_id || '') !== operation) continue;
      if (reservation?.attempt_token
        && String(reservation.attempt_token) !== String(attemptToken || '')) continue;
      delete reservations[key];
      released = true;
    }
    if (Object.keys(reservations).length) registry.cleanup_reservations = reservations;
    else delete registry.cleanup_reservations;
    return released;
  }, { cleanupOperationId: operation });
  return released;
}

export function updateActiveContextCleanupPhase(vaultBase, {
  operationId,
  repositoryId,
  worktreeId,
  attemptToken = '',
  phase,
  now = new Date().toISOString(),
} = {}) {
  const operation = requiredId(operationId, 'cleanup operation_id');
  const repository = requiredId(repositoryId, 'repository_id');
  const worktree = requiredId(worktreeId, 'worktree_id');
  const requestedPhase = optionalText(phase, 48);
  let updated = false;
  mutateSessionRegistry(vaultBase, (registry) => {
    const key = `${repository}:${worktree}`;
    const reservations = { ...(registry.cleanup_reservations || {}) };
    const reservation = reservations[key];
    if (String(reservation?.operation_id || '') !== operation
      || (attemptToken && String(reservation?.attempt_token || '') !== String(attemptToken))) {
      throw contextError(
        'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_BUSY',
        'a tentativa de cleanup não possui mais a reserva CAS esperada',
      );
    }
    reservations[key] = {
      ...reservation,
      phase: requestedPhase,
      updated_at: String(now),
    };
    registry.cleanup_reservations = reservations;
    updated = true;
    return structuredClone(reservations[key]);
  }, { cleanupOperationId: operation });
  return updated;
}

export function markActiveContextCleanupTerminal(vaultBase, {
  operationId,
  projectId,
  repositoryId,
  worktreeId,
  workSessionId = '',
  changeSlug = '',
  targetContextIds = [],
  targetChangeSlugs = [],
  targetContextSnapshot = [],
  worktreePath = '',
  subjectHash = '',
  actorContextId = '',
  mode = '',
  authority = '',
  head = '',
  slug = '',
  pullRequestNumber = '',
  pullRequestRepository = '',
  headRefOid = '',
  mergeCommitOid = '',
  attemptToken = '',
  allowMissingReservation = false,
  now = new Date().toISOString(),
} = {}) {
  const operation = requiredId(operationId, 'cleanup operation_id');
  const project = requiredId(projectId, 'project_id');
  const repository = requiredId(repositoryId, 'repository_id');
  const worktree = requiredId(worktreeId, 'worktree_id');
  const subject = String(subjectHash || '').trim();
  if (!subject) {
    throw contextError('WENDKEEP_ACTIVE_CONTEXT_CLEANUP_SUBJECT_INVALID', 'cleanup subject_hash inválido ou ausente');
  }
  const requestedSubject = cleanupSubjectFromOptions({
    projectId, repositoryId, worktreeId, workSessionId, changeSlug,
    targetContextIds, targetChangeSlugs, targetContextSnapshot, actorContextId,
    worktreePath, mode, authority, head, slug,
    pullRequestNumber, pullRequestRepository, headRefOid, mergeCommitOid,
  });
  return mutateSessionRegistry(vaultBase, (registry) => {
    const existing = cleanupTombstoneForWorktree(registry, worktree, repository)
      || cleanupTombstoneForWorktree(registry, worktree);
    if (existing && String(existing.operation_id || '') !== operation) {
      throw contextError(
        'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_TERMINAL_CONFLICT',
        'o tombstone terminal pertence a outra operação',
      );
    }
    const reservationKey = `${repository}:${worktree}`;
    const reservation = registry.cleanup_reservations?.[reservationKey]
      || cleanupReservationForWorktree(registry, worktree);
    if (!reservation && !allowMissingReservation && !existing) {
      throw contextError(
        'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_BUSY',
        'a reserva owner da operação não está mais disponível',
      );
    }
    const reservationSubject = reservation && cleanupSubjectFromOptions({
      projectId: reservation.project_id,
      repositoryId: reservation.repository_id,
      worktreeId: reservation.worktree_id,
      workSessionId: reservation.work_session_id,
      changeSlug: reservation.change_slug,
      targetContextIds: reservation.target_context_ids,
      targetChangeSlugs: reservation.target_change_slugs,
      targetContextSnapshot: reservation.target_context_snapshot,
      actorContextId: reservation.actor_context_id,
      worktreePath: reservation.worktree_path,
      mode: reservation.mode,
      authority: reservation.authority,
      head: reservation.head,
      slug: reservation.slug,
      pullRequestNumber: reservation.pull_request_number,
      pullRequestRepository: reservation.pull_request_repository,
      headRefOid: reservation.head_ref_oid,
      mergeCommitOid: reservation.merge_commit_oid,
    });
    if (reservation) {
      const sameOperation = String(reservation.operation_id || '') === operation;
      const sameOwner = String(reservation.attempt_token || '') === String(attemptToken || '');
      if (!sameOperation || (reservation.attempt_token && !sameOwner)) {
        throw contextError(
          'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_BUSY',
          'a reserva owner da operação mudou antes do tombstone terminal',
        );
      }
      if (!sameCleanupSubject(reservationSubject, requestedSubject)) {
        throw contextError(
          'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_CAS_CONFLICT',
          'o subject reservado mudou antes do tombstone terminal',
        );
      }
    }
    let adoptTombstoneAttempt = false;
    if (existing) {
      const existingSubject = cleanupSubjectFromOptions({
        projectId: existing.project_id,
        repositoryId: existing.repository_id,
        worktreeId: existing.worktree_id,
        workSessionId: existing.work_session_id,
        changeSlug: existing.change_slug,
        targetContextIds: existing.target_context_ids,
        targetChangeSlugs: existing.target_change_slugs,
        targetContextSnapshot: existing.target_context_snapshot,
        actorContextId: existing.actor_context_id,
        worktreePath: existing.worktree_path,
        mode: existing.mode,
        authority: existing.authority,
        head: existing.head,
        slug: existing.slug,
        pullRequestNumber: existing.pull_request_number,
        pullRequestRepository: existing.pull_request_repository,
        headRefOid: existing.head_ref_oid,
        mergeCommitOid: existing.merge_commit_oid,
      });
      const sameSubject = String(existing.subject_hash || '') === subject
        && sameCleanupSubject(existingSubject, requestedSubject);
      const sameOwner = !existing.attempt_token
        || String(existing.attempt_token) === String(attemptToken || '');
      const canAdopt = Boolean(
        reservation
        && String(reservation.operation_id || '') === operation
        && String(reservation.attempt_token || '') === String(attemptToken || '')
        && sameSubject
        && sameCleanupSubject(existingSubject, reservationSubject),
      );
      adoptTombstoneAttempt = canAdopt && !sameOwner;
      if (!sameSubject || (!sameOwner && !adoptTombstoneAttempt)) {
        throw contextError(
          'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_TERMINAL_CONFLICT',
          'o tombstone terminal não corresponde ao owner/subject reservado',
        );
      }
    }
    const active = Object.values(contextsOf(registry)).filter((context) => (
      context?.state === 'active' && String(context?.worktree_id || '') === worktree
    ));
    if (active.length) {
      throw contextError(
        'WENDKEEP_ACTIVE_CONTEXT_CLEANUP_CONTEXT_MISMATCH',
        'não é seguro criar tombstone enquanto há active context',
      );
    }
    registry.cleanup_tombstones = {
      ...(registry.cleanup_tombstones || {}),
      [`${repository}:${worktree}`]: {
        state: 'cleaned',
        operation_id: operation,
        project_id: project,
        repository_id: repository,
        worktree_id: worktree,
        work_session_id: optionalText(workSessionId, 160),
        change_slug: optionalText(changeSlug, 160),
        target_context_ids: subjectIds(targetContextIds),
        target_change_slugs: subjectIds(targetChangeSlugs),
        target_context_snapshot: subjectSnapshot(targetContextSnapshot),
        worktree_path: optionalText(worktreePath, 1024),
        subject_hash: optionalText(subject, 240),
        actor_context_id: optionalText(actorContextId, 160),
        mode: optionalText(mode, 32),
        authority: optionalText(authority, 240),
        head: optionalText(head, 80),
        slug: optionalText(slug, 160),
        pull_request_number: optionalText(pullRequestNumber, 80),
        pull_request_repository: optionalText(pullRequestRepository, 240),
        head_ref_oid: optionalText(headRefOid, 160),
        merge_commit_oid: optionalText(mergeCommitOid, 160),
        attempt_token: optionalText(attemptToken, 160),
        updated_at: String(now),
      },
    };
    return structuredClone(registry.cleanup_tombstones[`${repository}:${worktree}`]);
  }, { cleanupOperationId: operation });
}

export function setActiveContextChange(vaultBase, identity, slug, options = {}) {
  const normalizedSlug = String(slug || '').trim();
  if (!SLUG_PATTERN.test(normalizedSlug)) {
    throw contextError('WENDKEEP_ACTIVE_CONTEXT_CHANGE_INVALID', 'change_slug inválido ou ausente');
  }
  return mutateActiveContext(vaultBase, identity, (context) => ({
    ...context,
    ...(identity?.hostCoverage ? { host_coverage: structuredClone(identity.hostCoverage) } : {}),
    change_slug: normalizedSlug,
    state: 'active',
  }), options);
}

export function clearActiveContextChange(vaultBase, identity, options = {}) {
  return mutateActiveContext(vaultBase, identity, (context) => ({
    ...context,
    change_slug: '',
    state: 'active',
  }), options);
}

export function setActiveContextDelivery(vaultBase, identity, deliveryId, options = {}) {
  const normalizedId = String(deliveryId || '').trim();
  if (!DELIVERY_PATTERN.test(normalizedId)) {
    throw contextError('WENDKEEP_ACTIVE_CONTEXT_DELIVERY_INVALID', 'delivery_id inválido ou ausente');
  }
  return mutateActiveContext(vaultBase, identity, (context) => ({
    ...context,
    ...(identity?.hostCoverage ? { host_coverage: structuredClone(identity.hostCoverage) } : {}),
    delivery_id: normalizedId,
    state: 'active',
  }), options);
}

export function clearActiveContextDelivery(vaultBase, identity, options = {}) {
  return mutateActiveContext(vaultBase, identity, (context) => ({
    ...context,
    delivery_id: '',
    state: 'active',
  }), options);
}

function legacyPointer(vaultBase) {
  try {
    return readFileSync(join(vaultBase, POINTER), 'utf8').match(/^change:\s*(.+)$/m)?.[1]?.trim() || '';
  } catch {
    return '';
  }
}

export function migrateLegacyActiveContext(vaultBase, {
  identityForSession,
  now = new Date().toISOString(),
} = {}) {
  const slug = legacyPointer(vaultBase);
  if (!slug) return { migrated: false, reason: 'no-pointer' };
  const registry = readSessionRegistry(vaultBase);
  if (activeContextRegistryInitialized(registry)) return { migrated: false, reason: 'already-initialized' };
  if (typeof identityForSession !== 'function') return { migrated: false, reason: 'identity-unavailable' };

  const candidates = [];
  for (const [sessionId, entry] of Object.entries(registry.sessions || {})) {
    if (entry?.status !== 'active' || entry?.project_scope?.complete !== true || !entry?.work_session_id) continue;
    let candidate;
    try { candidate = normalizeIdentity(identityForSession(sessionId, entry)); } catch { continue; }
    if (candidate.projectId !== entry.project_scope.projectId
      || candidate.workSessionId !== String(entry.work_session_id)) continue;
    candidates.push(candidate);
  }
  if (candidates.length !== 1) {
    return { migrated: false, reason: candidates.length ? 'ambiguous' : 'identity-unavailable' };
  }
  const result = setActiveContextChange(vaultBase, candidates[0], slug, { now });
  return { migrated: true, key: result.key, context: result.context };
}
