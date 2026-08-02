import { randomUUID } from 'node:crypto';

import {
  createTaskOperatingProfileLease,
} from '../src/operating-profile.mjs';
import { mutateSessionRegistry } from './obsidian-common.mjs';

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

export function setSessionTaskOperatingProfile(vaultBase, sessionId, profile, {
  reason,
  leaseId = randomUUID(),
  now,
} = {}) {
  const issuedAt = isoTimestamp(now);
  return mutateSessionRegistry(vaultBase, (registry) => {
    const sessions = registry.sessions || (registry.sessions = {});
    if (!Object.hasOwn(sessions, sessionId)) throw missingSessionError(sessionId);
    const current = sessions[sessionId];
    const turnId = typeof current.last_prompt_turn_id === 'string'
      ? current.last_prompt_turn_id.trim()
      : '';
    const hasRegisteredTurn = Boolean(
      turnId
      && current.turn_sequences
      && Object.hasOwn(current.turn_sequences, turnId)
      && current.turn_sequences[turnId] === current.last_turn_sequence
    );
    const lease = createTaskOperatingProfileLease({
      profile,
      reason,
      sessionId,
      turnId,
      turnSequence: hasRegisteredTurn ? current.last_turn_sequence : undefined,
      leaseId,
      issuedAt,
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
} = {}) {
  if (!sessionId || !leaseId) return false;
  const consumedAt = isoTimestamp(now);
  return mutateSessionRegistry(vaultBase, (registry) => {
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
