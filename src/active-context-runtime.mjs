import { readSessionRegistry } from '../hooks/obsidian-common.mjs';
import {
  activeContextRegistryInitialized,
  migrateLegacyActiveContext,
  resolveActiveContext,
} from '../hooks/active-context-store.mjs';
import { captureProjectScope, compareProjectScopes } from '../hooks/project-scope.mjs';
import {
  discoverWorktreeRepository,
  readWorktreeRegistry,
  worktreeIdentity,
} from '../packages/vault/src/worktree-metadata.mjs';
import { readProjectForValidation } from '../packages/vault/src/validate-memory.mjs';

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function activeSession(entry) {
  return entry?.status === 'active'
    && entry?.project_scope?.complete === true
    && typeof entry?.work_session_id === 'string'
    && entry.work_session_id.trim();
}

export function resolveRuntimeActiveContext({
  vaultBase,
  projectRoot = process.cwd(),
  sessionId = '',
  spawn,
} = {}) {
  const project = readProjectForValidation(vaultBase);
  if (!project.ok || !project.projectId) {
    throw runtimeError('WENDKEEP_ACTIVE_CONTEXT_IDENTITY_UNAVAILABLE', 'PROJECT.json não prova project_id');
  }
  let repository;
  try { repository = discoverWorktreeRepository({ startDir: projectRoot, ...(spawn ? { spawn } : {}) }); }
  catch (error) {
    throw runtimeError('WENDKEEP_ACTIVE_CONTEXT_IDENTITY_UNAVAILABLE', error.message);
  }
  const metadata = readWorktreeRegistry(repository).registry;
  if (!metadata) {
    throw runtimeError(
      'WENDKEEP_ACTIVE_CONTEXT_IDENTITY_UNAVAILABLE',
      'registry de worktrees ausente; não é seguro inventar repository_id/worktree_id',
    );
  }
  if (metadata.projectId !== project.projectId) {
    throw runtimeError('WENDKEEP_ACTIVE_CONTEXT_IDENTITY_MISMATCH', 'registry de worktrees pertence a outro projeto');
  }

  const registry = readSessionRegistry(vaultBase);
  const sessions = registry.sessions || {};
  const worktreeId = worktreeIdentity(metadata.repositoryId, repository.gitDir);
  const requested = String(sessionId || '').trim();
  const rows = requested ? [[requested, sessions[requested]]] : Object.entries(sessions);
  const matches = [];
  for (const [candidateId, entry] of rows) {
    if (!activeSession(entry)) continue;
    const actual = captureProjectScope({
      input: { cwd: projectRoot },
      projectRoot,
      projectId: project.projectId,
      provider: entry.provider || '',
      sessionId: candidateId,
      ...(spawn ? { spawn } : {}),
    });
    if (!compareProjectScopes(entry.project_scope, actual).ok) continue;
    matches.push({ sessionId: candidateId, entry, actual });
  }
  if (!matches.length) {
    throw runtimeError(
      'WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND',
      requested ? 'sessão causal não corresponde à worktree atual' : 'nenhuma sessão ativa corresponde à worktree atual',
    );
  }
  let selected = matches[0];
  if (matches.length > 1) {
    const active = Object.values(registry.active_contexts || {}).filter((context) => (
      context?.state === 'active'
      && context.project_id === project.projectId
      && context.repository_id === metadata.repositoryId
      && context.worktree_id === worktreeId
    ));
    const narrowed = active.length === 1
      ? matches.filter(({ entry }) => String(entry.work_session_id) === active[0].work_session_id)
      : [];
    if (narrowed.length !== 1) {
      throw runtimeError(
        'WENDKEEP_ACTIVE_CONTEXT_AMBIGUOUS',
        'mais de uma sessão ativa corresponde à worktree; informe --session',
      );
    }
    [selected] = narrowed;
  }
  return {
    projectId: project.projectId,
    repositoryId: metadata.repositoryId,
    worktreeId,
    workSessionId: String(selected.entry.work_session_id),
    branch: selected.actual.branch,
    headSha: selected.actual.head,
    sessionId: selected.sessionId,
    ...(selected.entry.host_coverage ? { hostCoverage: structuredClone(selected.entry.host_coverage) } : {}),
  };
}

export function resolveCommandActiveContext({
  vaultBase,
  projectRoot = process.cwd(),
  sessionId = '',
  spawn,
  requireExisting = false,
} = {}) {
  const requestedSession = String(sessionId || '').trim();
  let identity;
  try {
    identity = resolveRuntimeActiveContext({
      vaultBase, projectRoot, sessionId: requestedSession, ...(spawn ? { spawn } : {}),
    });
  } catch (error) {
    const registry = readSessionRegistry(vaultBase);
    const initialized = activeContextRegistryInitialized(registry);
    const legacyUnavailable = error?.code === 'WENDKEEP_ACTIVE_CONTEXT_IDENTITY_UNAVAILABLE'
      || (!requestedSession && error?.code === 'WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND');
    if (!initialized && legacyUnavailable) return null;
    throw error;
  }
  migrateLegacyActiveContext(vaultBase, {
    identityForSession: (candidateId) => resolveRuntimeActiveContext({
      vaultBase, projectRoot, sessionId: candidateId, ...(spawn ? { spawn } : {}),
    }),
  });
  if (requireExisting) {
    const registry = readSessionRegistry(vaultBase);
    if (!activeContextRegistryInitialized(registry)) return null;
    resolveActiveContext(vaultBase, identity);
  }
  return identity;
}
