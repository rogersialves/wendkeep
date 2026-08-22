import { randomUUID } from 'node:crypto';

import {
  createTaskOperatingProfileLease,
} from '../src/operating-profile.mjs';
import { mutateSessionRegistry, readSessionRegistry } from './obsidian-common.mjs';
import { mutateActiveContext, resolveActiveContext } from './active-context-store.mjs';

function isoTimestamp(now) {
  if (typeof now === 'string') return now;
  if (now instanceof Date) return now.toISOString();
  return new Date().toISOString();
}

function missingSessionError(sessionId) {
  const error = new Error(`sessão não encontrada: ${sessionId}`);
  error.code = 'WENDKEEP_SESSION_NOT_FOUND';
  return error;
}

function activeContextRequiredError() {
  const error = new Error('active context causal é obrigatório quando o registry contextual está inicializado');
  error.code = 'WENDKEEP_ACTIVE_CONTEXT_REQUIRED';
  return error;
}

function hasActiveContextRegistry(registry) {
  return Boolean(registry && (
    Object.hasOwn(registry, 'active_contexts')
    || Object.hasOwn(registry, 'active_contexts_schema')
    || Object.hasOwn(registry, 'active_contexts_revision')
  ));
}

function leaseFromSession(current, profile, { reason, leaseId, issuedAt, sessionId }) {
  const turnId = typeof current.last_prompt_turn_id === 'string'
    ? current.last_prompt_turn_id.trim()
    : '';
  const hasRegisteredTurn = Boolean(
    turnId
    && current.turn_sequences
    && Object.hasOwn(current.turn_sequences, turnId)
    && current.turn_sequences[turnId] === current.last_turn_sequence
  );
  return createTaskOperatingProfileLease({
    profile,
    reason,
    sessionId,
    turnId,
    turnSequence: hasRegisteredTurn ? current.last_turn_sequence : undefined,
    leaseId,
    issuedAt,
  });
}

export function sessionTaskOperatingProfile(vaultBase, sessionId, { context = null } = {}) {
  if (context) {
    try { return resolveActiveContext(vaultBase, context).operating_profile_task || null; }
    catch (error) {
      if (error?.code === 'WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND') {
        const registry = readSessionRegistry(vaultBase);
        if (hasActiveContextRegistry(registry)) return null;
        return registry.sessions?.[sessionId]?.operating_profile_task || null;
      }
      throw error;
    }
  }
  const registry = readSessionRegistry(vaultBase);
  if (hasActiveContextRegistry(registry)) return null;
  return registry.sessions?.[sessionId]?.operating_profile_task || null;
}

export function setSessionTaskOperatingProfile(vaultBase, sessionId, profile, {
  reason,
  leaseId = randomUUID(),
  now,
  context = null,
  mutateContext = mutateActiveContext,
} = {}) {
  const issuedAt = isoTimestamp(now);
  if (context) {
    let lease;
    mutateContext(vaultBase, context, (active) => ({
      ...active,
      operating_profile_task: lease,
      state: 'active',
    }), {
      now: issuedAt,
      projectLegacy: false,
      mutateRegistry: (base, mutator) => mutateSessionRegistry(base, (registry) => {
        const sessions = registry.sessions || (registry.sessions = {});
        if (!Object.hasOwn(sessions, sessionId)) throw missingSessionError(sessionId);
        lease = leaseFromSession(sessions[sessionId], profile, {
          reason, leaseId, issuedAt, sessionId,
        });
        return mutator(registry);
      }),
    });
    return lease;
  }
  return mutateSessionRegistry(vaultBase, (registry) => {
    if (hasActiveContextRegistry(registry)) throw activeContextRequiredError();
    const sessions = registry.sessions || (registry.sessions = {});
    if (!Object.hasOwn(sessions, sessionId)) throw missingSessionError(sessionId);
    const current = sessions[sessionId];
    const lease = leaseFromSession(current, profile, {
      reason, leaseId, issuedAt, sessionId,
    });
    sessions[sessionId] = {
      ...current,
      operating_profile_task: lease,
      updated_at: issuedAt,
    };
    return lease;
  });
}

export function consumeSessionTaskOperatingProfile(vaultBase, sessionId, leaseId, {
  now,
  context = null,
  mutateContext = mutateActiveContext,
} = {}) {
  if (!sessionId || !leaseId) return false;
  const consumedAt = isoTimestamp(now);
  if (context) {
    let current;
    try { current = resolveActiveContext(vaultBase, context); }
    catch (error) {
      if (error?.code !== 'WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND') throw error;
      const registry = readSessionRegistry(vaultBase);
      if (hasActiveContextRegistry(registry)) return false;
      return consumeSessionTaskOperatingProfile(vaultBase, sessionId, leaseId, {
        now: consumedAt,
      });
    }
    const lease = current.operating_profile_task;
    if (!lease || lease.state !== 'active' || lease.lease_id !== leaseId) return false;
    let consumed = false;
    try {
      mutateContext(vaultBase, context, (active) => {
        const activeLease = active.operating_profile_task;
        if (!activeLease || activeLease.state !== 'active' || activeLease.lease_id !== leaseId) {
          return active;
        }
        consumed = true;
        return {
          ...active,
          operating_profile_task: {
            ...activeLease,
            state: 'consumed',
            consumed_at: consumedAt,
          },
        };
      }, {
        expectedRevision: current.revision,
        now: consumedAt,
        projectLegacy: false,
      });
    } catch (error) {
      if (error?.code === 'WENDKEEP_ACTIVE_CONTEXT_STALE') return false;
      throw error;
    }
    return consumed;
  }
  return mutateSessionRegistry(vaultBase, (registry) => {
    if (hasActiveContextRegistry(registry)) throw activeContextRequiredError();
    const current = registry.sessions?.[sessionId];
    const lease = current?.operating_profile_task;
    if (!lease || lease.state !== 'active' || lease.lease_id !== leaseId) return false;
    registry.sessions[sessionId] = {
      ...current,
      operating_profile_task: {
        ...lease,
        state: 'consumed',
        consumed_at: consumedAt,
      },
      updated_at: consumedAt,
    };
    return true;
  });
}
