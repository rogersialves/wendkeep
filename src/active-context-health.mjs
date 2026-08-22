import { spawnSync } from 'node:child_process';

import {
  mutateSessionRegistry,
  readSessionRegistry,
} from '../hooks/obsidian-common.mjs';
import {
  projectLegacyActiveChange,
  projectLegacyActiveDelivery,
} from '../hooks/active-context-store.mjs';
import {
  discoverWorktreeRepository,
  readWorktreeRegistry,
  worktreeIdentity,
} from '../packages/vault/src/worktree-metadata.mjs';
import { sanitizeMemoryText } from '../packages/vault/src/memory-schema.mjs';

export const ACTIVE_CONTEXT_DIAGNOSTICS = Object.freeze({
  SESSION_ORPHAN: 'WENDKEEP_ACTIVE_CONTEXT_SESSION_ORPHAN',
  WORKTREE_REMOVED: 'WENDKEEP_ACTIVE_CONTEXT_WORKTREE_REMOVED',
  LEASE_EXPIRED: 'WENDKEEP_ACTIVE_CONTEXT_LEASE_EXPIRED',
  TOPOLOGY_UNPROVEN: 'WENDKEEP_ACTIVE_CONTEXT_TOPOLOGY_UNPROVEN',
  IDENTITY_MISMATCH: 'WENDKEEP_ACTIVE_CONTEXT_IDENTITY_MISMATCH',
});

const ACTIONABLE_CODES = new Set([
  ACTIVE_CONTEXT_DIAGNOSTICS.SESSION_ORPHAN,
  ACTIVE_CONTEXT_DIAGNOSTICS.WORKTREE_REMOVED,
  ACTIVE_CONTEXT_DIAGNOSTICS.LEASE_EXPIRED,
]);

function healthError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function contextualRegistryInitialized(registry) {
  return Boolean(registry && (
    Object.hasOwn(registry, 'active_contexts')
    || Object.hasOwn(registry, 'active_contexts_schema')
    || Object.hasOwn(registry, 'active_contexts_revision')
  ));
}

function contextsOf(registry) {
  return registry?.active_contexts && typeof registry.active_contexts === 'object'
    && !Array.isArray(registry.active_contexts)
    ? registry.active_contexts : {};
}

function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function activeOwnerSessions(registry, context) {
  return Object.entries(registry.sessions || {}).filter(([, entry]) => (
    entry?.status === 'active'
    && entry?.project_scope?.complete === true
    && String(entry.project_scope.projectId || '') === String(context.project_id || '')
    && String(entry.work_session_id || '') === String(context.work_session_id || '')
  ));
}

function leaseExpired(registry, lease, context) {
  if (!lease || lease.state !== 'active' || lease.expires_on !== 'request-stop') return false;
  const owner = registry.sessions?.[String(lease.session_id || '')];
  if (!owner || owner.status !== 'active'
    || owner?.project_scope?.complete !== true
    || String(owner.project_scope.projectId || '') !== String(context.project_id || '')) return true;
  const requestedSequence = nonNegativeInteger(lease.request_turn_sequence, -1);
  const stoppedSequence = nonNegativeInteger(owner.last_stop_turn_sequence, -1);
  if (requestedSequence >= 0 && stoppedSequence >= requestedSequence) return true;
  const requestedTurn = String(lease.request_turn_id || '');
  return Boolean(requestedTurn && requestedTurn === String(owner.last_stop_turn_id || ''));
}

function issue(code, key, context, message, repairable = true) {
  return {
    code,
    key,
    revision: nonNegativeInteger(context?.revision),
    repairable,
    message,
  };
}

export function inspectActiveContextTopology({
  projectRoot = process.cwd(),
  spawn = spawnSync,
} = {}) {
  try {
    const repository = discoverWorktreeRepository({ startDir: projectRoot, spawn });
    const metadata = readWorktreeRegistry(repository).registry;
    if (!metadata) {
      return {
        proven: false,
        errorCode: 'WENDKEEP_WORKTREE_REGISTRY_MISSING',
        message: 'registry de worktrees ausente',
      };
    }
    const ids = [];
    for (const worktree of repository.worktrees) {
      const discovered = discoverWorktreeRepository({ startDir: worktree.path, spawn });
      if (discovered.commonDir !== repository.commonDir) {
        throw healthError('WENDKEEP_WORKTREE_IDENTITY_MISMATCH', 'worktree pertence a outro Git common dir');
      }
      ids.push(worktreeIdentity(metadata.repositoryId, discovered.gitDir));
    }
    return {
      proven: true,
      projectId: metadata.projectId,
      repositoryId: metadata.repositoryId,
      worktreeIds: [...new Set(ids)].sort(),
    };
  } catch (error) {
    return {
      proven: false,
      errorCode: error?.code || 'WENDKEEP_ACTIVE_CONTEXT_TOPOLOGY_FAILED',
      message: String(error?.message || error),
    };
  }
}

export function diagnoseActiveContexts({ registry = {}, topology = {} } = {}) {
  const initialized = contextualRegistryInitialized(registry);
  if (!initialized) {
    return { initialized: false, contexts: 0, healthy: 0, topology_proven: false, issues: [] };
  }

  const active = Object.entries(contextsOf(registry)).filter(([, context]) => context?.state === 'active');
  const issues = [];
  let healthy = 0;
  for (const [key, context] of active) {
    const contextIssues = [];
    if (!activeOwnerSessions(registry, context).length) {
      contextIssues.push(issue(
        ACTIVE_CONTEXT_DIAGNOSTICS.SESSION_ORPHAN,
        key,
        context,
        'nenhuma sessão ativa possui a work_session_id do contexto',
      ));
    }

    if (!topology?.proven) {
      contextIssues.push(issue(
        ACTIVE_CONTEXT_DIAGNOSTICS.TOPOLOGY_UNPROVEN,
        key,
        context,
        `topologia Git não provada${topology?.errorCode ? ` (${topology.errorCode})` : ''}`,
        false,
      ));
    } else if (context.project_id !== topology.projectId || context.repository_id !== topology.repositoryId) {
      contextIssues.push(issue(
        ACTIVE_CONTEXT_DIAGNOSTICS.IDENTITY_MISMATCH,
        key,
        context,
        'contexto não pertence ao projeto/repositório provado pelo checkout',
        false,
      ));
    } else if (!(topology.worktreeIds || []).includes(context.worktree_id)) {
      contextIssues.push(issue(
        ACTIVE_CONTEXT_DIAGNOSTICS.WORKTREE_REMOVED,
        key,
        context,
        'worktree_id não existe na topologia Git atual',
      ));
    }

    if (leaseExpired(registry, context.operating_profile_task, context)) {
      contextIssues.push(issue(
        ACTIVE_CONTEXT_DIAGNOSTICS.LEASE_EXPIRED,
        key,
        context,
        'lease request-stop permaneceu ativa depois do término de sua requisição',
      ));
    }
    if (!contextIssues.length) healthy += 1;
    issues.push(...contextIssues);
  }
  return {
    initialized: true,
    contexts: active.length,
    healthy,
    topology_proven: topology?.proven === true,
    issues,
  };
}

export function inspectActiveContextHealth({
  vaultBase,
  projectRoot = process.cwd(),
  spawn = spawnSync,
} = {}) {
  const registry = readSessionRegistry(vaultBase);
  const topology = inspectActiveContextTopology({ projectRoot, spawn });
  return diagnoseActiveContexts({ registry, topology });
}

export function renderActiveContextHealthLines(result) {
  if (!result.initialized) return ['[active-contexts] legado — store contextual não inicializado'];
  const repairable = result.issues.filter((item) => item.repairable).length;
  const lines = [
    `[active-contexts] ${result.contexts} ativo(s) · ${result.healthy} saudável(is) · ${result.issues.length} diagnóstico(s) · ${repairable} reparável(is)`,
  ];
  for (const item of result.issues) {
    lines.push(`  ${item.repairable ? '→' : '!'} ${item.code}: ${item.key} @ revision ${item.revision} — ${item.message}`);
    if (item.repairable) {
      lines.push(`    wendkeep context repair --key "${item.key}" --revision ${item.revision} --reason "<motivo>" --session <id>`);
    }
  }
  if (!result.issues.length) lines.push('  active contexts íntegros ✓');
  return lines;
}

function requiredKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/.test(key) || key.length > 482) {
    throw healthError('WENDKEEP_CONTEXT_ARGS', 'repair requer --key <repository:worktree:work-session>');
  }
  return key;
}

function requiredRevision(value) {
  const raw = String(value ?? '').trim();
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
    throw healthError('WENDKEEP_CONTEXT_ARGS', 'repair requer --revision <inteiro não negativo>');
  }
  return parsed;
}

function requiredReason(value) {
  const reason = sanitizeMemoryText(String(value || ''))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!reason) throw healthError('WENDKEEP_CONTEXT_ARGS', 'repair requer --reason <texto>');
  if (reason.length > 240) throw healthError('WENDKEEP_CONTEXT_ARGS', '--reason excede 240 caracteres');
  return reason;
}

function globalRevision(registry) {
  return nonNegativeInteger(registry.active_contexts_revision);
}

export function repairActiveContext({
  vaultBase,
  projectRoot = process.cwd(),
  key,
  revision,
  reason,
  actorSessionId,
  spawn = spawnSync,
  topologyProvider = (options) => inspectActiveContextTopology(options),
  mutateRegistry = mutateSessionRegistry,
  projectChange = projectLegacyActiveChange,
  projectDelivery = projectLegacyActiveDelivery,
  now = () => new Date(),
} = {}) {
  const targetKey = requiredKey(key);
  const expectedRevision = requiredRevision(revision);
  const safeReason = requiredReason(reason);
  const actorId = String(actorSessionId || '').trim();
  if (!actorId) throw healthError('WENDKEEP_CONTEXT_SESSION', 'repair requer --session <id>');

  const result = mutateRegistry(vaultBase, (registry) => {
    if (!contextualRegistryInitialized(registry)) {
      throw healthError('WENDKEEP_ACTIVE_CONTEXT_NOT_INITIALIZED', 'store contextual não inicializado');
    }
    const actor = registry.sessions?.[actorId];
    if (!actor || actor.status !== 'active') {
      throw healthError('WENDKEEP_CONTEXT_SESSION', `sessão ator ativa não encontrada: ${actorId}`);
    }
    const current = contextsOf(registry)[targetKey];
    if (!current || current.state !== 'active') {
      throw healthError('WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND', `active context não encontrado: ${targetKey}`);
    }
    if (actor?.project_scope?.complete !== true
      || String(actor.project_scope.projectId || '') !== String(current.project_id || '')) {
      throw healthError(
        'WENDKEEP_ACTIVE_CONTEXT_ACTOR_MISMATCH',
        'sessão ator não pertence ao projeto do active context',
      );
    }
    const currentRevision = nonNegativeInteger(current.revision);
    if (currentRevision !== expectedRevision) {
      throw healthError(
        'WENDKEEP_ACTIVE_CONTEXT_CAS_MISMATCH',
        `active context revision mudou de ${expectedRevision} para ${currentRevision}`,
      );
    }
    const topology = topologyProvider({ projectRoot, spawn, registry: structuredClone(registry) });
    const diagnosis = diagnoseActiveContexts({ registry, topology });
    const targetIssues = diagnosis.issues.filter((item) => item.key === targetKey);
    if (targetIssues.some((item) => item.code === ACTIVE_CONTEXT_DIAGNOSTICS.TOPOLOGY_UNPROVEN)) {
      throw healthError('WENDKEEP_ACTIVE_CONTEXT_TOPOLOGY_UNPROVEN', 'topologia Git não pôde ser revalidada');
    }
    if (targetIssues.some((item) => !item.repairable)) {
      throw healthError('WENDKEEP_ACTIVE_CONTEXT_IDENTITY_MISMATCH', 'identidade do contexto não corresponde ao checkout provado');
    }
    const actionable = targetIssues.filter((item) => ACTIONABLE_CODES.has(item.code));
    if (!actionable.length) {
      throw healthError('WENDKEEP_ACTIVE_CONTEXT_HEALTHY', 'active context não possui condição reparável vigente');
    }

    const codes = [...new Set(actionable.map((item) => item.code))].sort();
    const closeContext = codes.includes(ACTIVE_CONTEXT_DIAGNOSTICS.SESSION_ORPHAN)
      || codes.includes(ACTIVE_CONTEXT_DIAGNOSTICS.WORKTREE_REMOVED);
    const at = now().toISOString();
    const lease = current.operating_profile_task;
    const expireLease = codes.includes(ACTIVE_CONTEXT_DIAGNOSTICS.LEASE_EXPIRED)
      && lease?.state === 'active';
    const next = {
      ...current,
      ...(expireLease ? {
        operating_profile_task: { ...lease, state: 'expired', expired_at: at },
      } : {}),
      ...(closeContext ? { state: 'closed', closed_at: at } : {}),
      revision: currentRevision + 1,
      updated_at: at,
    };
    const effect = closeContext ? 'context-closed' : 'lease-expired';
    const receipt = {
      operation: 'repair',
      key: targetKey,
      from_revision: currentRevision,
      to_revision: next.revision,
      diagnostics: codes,
      effect,
      actor: { session_id: actorId, provider: String(actor.provider || '') },
      reason: safeReason,
      at,
    };
    registry.active_contexts = { ...contextsOf(registry), [targetKey]: next };
    registry.active_contexts_schema = nonNegativeInteger(registry.active_contexts_schema, 1) || 1;
    registry.active_contexts_revision = globalRevision(registry) + 1;
    registry.active_context_repairs = [
      ...(Array.isArray(registry.active_context_repairs) ? registry.active_context_repairs : []),
      receipt,
    ];
    return {
      status: 'repaired',
      key: targetKey,
      revision: next.revision,
      effect,
      diagnostics: codes,
      receipt,
    };
  });
  projectChange(vaultBase);
  projectDelivery(vaultBase);
  return result;
}
