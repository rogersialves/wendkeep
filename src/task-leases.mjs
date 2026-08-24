import { randomUUID } from 'node:crypto';
import { activeContextKey } from '../hooks/active-context-store.mjs';
import { mutateSessionRegistry } from '../hooks/obsidian-common.mjs';

function leaseError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function contextsOf(registry) {
  return registry.active_contexts && typeof registry.active_contexts === 'object'
    && !Array.isArray(registry.active_contexts) ? registry.active_contexts : {};
}

function leaseKey(changeSlug, taskId) {
  return `${String(changeSlug)}:${String(taskId)}`;
}

function expiresAt(lease) {
  const value = Date.parse(String(lease?.expires_at || ''));
  return Number.isFinite(value) ? value : 0;
}

function bumpContext(context, now) {
  context.revision = Number.isSafeInteger(Number(context.revision)) ? Number(context.revision) + 1 : 1;
  context.updated_at = now.toISOString();
}

export function claimTaskLease({
  vaultBase,
  identity,
  changeSlug,
  taskId,
  ownerSessionId,
  leaseSeconds = 900,
  now = new Date(),
} = {}) {
  const key = leaseKey(changeSlug, taskId);
  const contextKey = activeContextKey(identity);
  const duration = Number(leaseSeconds);
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 86_400) {
    throw leaseError('TASK_LEASE_DURATION_INVALID', 'lease duration must be between 1 and 86400 seconds');
  }
  return mutateSessionRegistry(vaultBase, (registry) => {
    const contexts = contextsOf(registry);
    const target = contexts[contextKey];
    if (!target || target.state !== 'active') throw leaseError('TASK_ACTIVE_CONTEXT_NOT_FOUND', 'active context not found');
    if (String(target.change_slug || '') !== String(changeSlug || '')) {
      throw leaseError('TASK_CHANGE_CONTEXT_MISMATCH', 'task change differs from active context');
    }

    for (const context of Object.values(contexts)) {
      const existing = context?.task_leases?.[key];
      if (!existing || existing.state !== 'active') continue;
      if (expiresAt(existing) <= now.getTime()) {
        existing.state = 'expired';
        existing.expired_at = now.toISOString();
        bumpContext(context, now);
        continue;
      }
      if (existing.owner_session_id === String(ownerSessionId)
        && existing.owner_work_session_id === identity.workSessionId) return structuredClone(existing);
      throw leaseError('TASK_LEASE_CONFLICT', `task ${taskId} is claimed by another active session`, {
        owner_session_id: existing.owner_session_id,
      });
    }

    const lease = {
      schema_version: 1,
      lease_id: randomUUID(),
      change_slug: String(changeSlug),
      task_id: String(taskId),
      owner_session_id: String(ownerSessionId),
      owner_work_session_id: String(identity.workSessionId),
      state: 'active',
      claimed_at: now.toISOString(),
      expires_at: new Date(now.getTime() + duration * 1000).toISOString(),
    };
    target.task_leases = { ...(target.task_leases || {}), [key]: lease };
    bumpContext(target, now);
    registry.active_contexts_revision = Number(registry.active_contexts_revision || 0) + 1;
    return structuredClone(lease);
  });
}

export function releaseTaskLease({ vaultBase, identity, changeSlug, taskId, ownerSessionId, now = new Date() } = {}) {
  const key = leaseKey(changeSlug, taskId);
  return mutateSessionRegistry(vaultBase, (registry) => {
    const contexts = contextsOf(registry);
    let found = null;
    for (const context of Object.values(contexts)) {
      const lease = context?.task_leases?.[key];
      if (lease?.state === 'active') { found = { context, lease }; break; }
    }
    if (!found) throw leaseError('TASK_LEASE_NOT_FOUND', `no active lease for task ${taskId}`);
    if (found.lease.owner_session_id !== String(ownerSessionId)
      || found.lease.owner_work_session_id !== identity.workSessionId) {
      throw leaseError('TASK_LEASE_NOT_OWNER', `session does not own task ${taskId}`);
    }
    found.lease.state = 'released';
    found.lease.released_at = now.toISOString();
    bumpContext(found.context, now);
    registry.active_contexts_revision = Number(registry.active_contexts_revision || 0) + 1;
    return structuredClone(found.lease);
  });
}
