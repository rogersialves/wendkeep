import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mutateSessionRegistry, readSessionRegistry } from './obsidian-common.mjs';
import { mkdirVaultPath, writeVaultFileSync } from './vault-path-safety.mjs';

export const ACTIVE_CONTEXTS_SCHEMA_VERSION = 1;
const POINTER = '.brain/CURRENT_CHANGE.md';
const DELIVERY_POINTER = '.brain/runtime/CURRENT_DELIVERY';
const ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const DELIVERY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/;

function contextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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
} = {}) {
  const normalized = normalizeIdentity(identity);
  const key = activeContextKey(normalized);
  const result = mutateRegistry(vaultBase, (registry) => {
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
  });
  projectLegacyActiveChange(vaultBase);
  projectLegacyActiveDelivery(vaultBase);
  return result;
}

export function setActiveContextChange(vaultBase, identity, slug, options = {}) {
  const normalizedSlug = String(slug || '').trim();
  if (!SLUG_PATTERN.test(normalizedSlug)) {
    throw contextError('WENDKEEP_ACTIVE_CONTEXT_CHANGE_INVALID', 'change_slug inválido ou ausente');
  }
  return mutateActiveContext(vaultBase, identity, (context) => ({
    ...context,
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
  if (Object.keys(contextsOf(registry)).length) return { migrated: false, reason: 'already-initialized' };
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
