import { readSessionRegistry } from './obsidian-common.mjs';
import {
  activeContextRegistryInitialized,
  resolveActiveContext,
} from './active-context-store.mjs';
import { resolveRuntimeActiveContext } from '../src/active-context-runtime.mjs';

export { activeContextRegistryInitialized } from './active-context-store.mjs';

const IDENTITY_FIELDS = Object.freeze([
  ['work_session_id', 'workSessionId'],
  ['repository_id', 'repositoryId'],
  ['worktree_id', 'worktreeId'],
  ['branch', 'branch'],
  ['change_slug', 'changeSlug'],
]);

function contextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function text(value) {
  return String(value ?? '').trim();
}

function contextsOf(registry) {
  return registry?.active_contexts && typeof registry.active_contexts === 'object'
    && !Array.isArray(registry.active_contexts)
    ? registry.active_contexts : {};
}

function assertAuthority(identity, context) {
  if (!identity || !context || context.state !== 'active') {
    throw contextError(
      'WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND',
      'active context causal não foi resolvido antes do Stop',
    );
  }
  for (const [contextField, identityField] of [
    ['project_id', 'projectId'],
    ['repository_id', 'repositoryId'],
    ['worktree_id', 'worktreeId'],
    ['work_session_id', 'workSessionId'],
  ]) {
    if (!text(context[contextField]) || text(context[contextField]) !== text(identity[identityField])) {
      throw contextError(
        'WENDKEEP_ACTIVE_CONTEXT_IDENTITY_MISMATCH',
        `${contextField} do active context não corresponde à sessão causal`,
      );
    }
  }
  if (!text(context.branch) || text(context.branch) !== text(identity.branch)) {
    throw contextError(
      'WENDKEEP_ACTIVE_CONTEXT_IDENTITY_MISMATCH',
      'branch do active context não corresponde à sessão causal',
    );
  }
}

export function resolveHandoffEvidenceAuthority(vaultBase, {
  input = {},
  sessionId = '',
  projectRoot = input.cwd || process.cwd(),
  registry = readSessionRegistry(vaultBase),
  resolveCommand = resolveRuntimeActiveContext,
  resolveContext = resolveActiveContext,
} = {}) {
  if (!activeContextRegistryInitialized(registry)) {
    return { mode: 'legacy', identity: null, context: null };
  }
  const identity = resolveCommand({
    vaultBase,
    projectRoot,
    sessionId,
  });
  if (!identity) {
    throw contextError(
      'WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND',
      'registry contextual inicializado sem identidade causal para o Stop',
    );
  }
  const context = resolveContext(vaultBase, { ...identity, sessionId });
  assertAuthority(identity, context);
  return { mode: 'contextual', identity, context };
}

export function resolveReadOnlyEvidenceActiveContext({
  vaultBase,
  projectRoot = process.cwd(),
  sessionId = '',
} = {}) {
  const authority = resolveHandoffEvidenceAuthority(vaultBase, {
    input: { cwd: projectRoot },
    projectRoot,
    sessionId,
  });
  return authority.mode === 'contextual' ? authority.identity : null;
}

function suppliedShared(input) {
  const supplied = input?.shared || input?.handoff?.shared;
  return supplied && typeof supplied === 'object' && !Array.isArray(supplied)
    ? { ...supplied }
    : {};
}

function suppliedIdentityValues(input, shared, snake, camel) {
  const direct = input?.shared && typeof input.shared === 'object' && !Array.isArray(input.shared)
    ? input.shared : {};
  const nested = input?.handoff?.shared && typeof input.handoff.shared === 'object'
    && !Array.isArray(input.handoff.shared)
    ? input.handoff.shared : {};
  return [
    shared[snake], shared[camel],
    direct[snake], direct[camel],
    nested[snake], nested[camel],
    input?.[snake], input?.[camel],
  ]
    .map(text)
    .filter(Boolean);
}

export function buildCausalSharedHandoff({ input = {}, entry = {}, authority } = {}) {
  const shared = suppliedShared(input);
  if (authority?.mode !== 'contextual') {
    const workSessionId = text(
      shared.work_session_id
      || shared.workSessionId
      || input.work_session_id
      || input.workSessionId
      || entry?.work_session_id,
    );
    if (!shared.work_session_id && workSessionId) shared.work_session_id = workSessionId;
    return Object.keys(shared).length ? shared : null;
  }

  assertAuthority(authority.identity, authority.context);
  const expected = {
    workSessionId: text(authority.identity.workSessionId),
    repositoryId: text(authority.identity.repositoryId),
    worktreeId: text(authority.identity.worktreeId),
    branch: text(authority.identity.branch || authority.context.branch),
    changeSlug: text(authority.context.change_slug),
  };
  for (const [snake, camel] of IDENTITY_FIELDS) {
    const suppliedValues = suppliedIdentityValues(input, shared, snake, camel);
    if (suppliedValues.some((supplied) => supplied !== expected[camel])) {
      throw contextError(
        'WENDKEEP_HANDOFF_CONTEXT_MISMATCH',
        `${snake} do handoff não corresponde ao active context causal`,
      );
    }
    delete shared[camel];
    if (expected[camel]) shared[snake] = expected[camel];
    else delete shared[snake];
  }
  return Object.keys(shared).length ? shared : null;
}

export function causalChangeSlug(entry = {}, authority = {}) {
  return authority?.mode === 'contextual'
    ? text(authority.context?.change_slug)
    : text(entry?.change_slug);
}

export function scopeEvidenceRows(rows, { activeContext = null, registry = {} } = {}) {
  if (!Array.isArray(rows) || !activeContextRegistryInitialized(registry)) return rows;

  const callerWorkSession = text(activeContext?.workSessionId ?? activeContext?.work_session_id);
  const sessions = registry.sessions || {};
  const activeContexts = Object.values(contextsOf(registry))
    .filter((context) => context?.state === 'active');
  const activeChangeOwners = new Map();
  for (const context of activeContexts) {
    const slug = text(context.change_slug);
    if (slug) activeChangeOwners.set(slug, text(context.work_session_id));
  }

  return rows.filter((row) => {
    const sessionId = text(row?.session_id);
    const rowWorkSession = text(row?.work_session_id)
      || text(sessionId && sessions[sessionId]?.work_session_id);
    if (sessionId && !rowWorkSession) return false;
    if (rowWorkSession && rowWorkSession !== callerWorkSession) return false;
    if (rowWorkSession && !callerWorkSession) return false;

    const changeSlug = text(row?.change_slug);
    const owner = activeChangeOwners.get(changeSlug) || '';
    if (owner && owner !== callerWorkSession) return false;
    if (owner && !callerWorkSession) return false;
    return true;
  });
}
