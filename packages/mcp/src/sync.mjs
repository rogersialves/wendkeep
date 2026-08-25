export const SYNC_MCP_TOOL_DEFINITIONS = [
  {
    name: 'wendkeep_sync_status',
    description: 'Read local-first sync health, pending count, and explicit conflict count.',
    effect: 'read',
  },
  {
    name: 'wendkeep_sync_conflicts',
    description: 'List explicit sync conflict candidates without returning authored payloads.',
    effect: 'read',
  },
];

function publicCandidate(candidate) {
  return {
    event_id: String(candidate?.event_id || ''),
    revision: Number(candidate?.revision || 0),
    content_hash: String(candidate?.content_hash || ''),
    actor_id: String(candidate?.actor_id || ''),
    device_id: String(candidate?.device_id || ''),
    observed_at: String(candidate?.observed_at || ''),
    operation: String(candidate?.operation || ''),
    privacy: String(candidate?.privacy || ''),
  };
}

export function inspectSyncForMcp({ outbox, state = null } = {}) {
  const safeOutbox = outbox && typeof outbox === 'object'
    ? {
        status: String(outbox.status || 'corrupt'),
        events: Number(outbox.events || 0),
        pending: Number(outbox.pending || 0),
        acknowledged: Number(outbox.acknowledged || 0),
        ...(outbox.code ? { code: String(outbox.code) } : {}),
      }
    : { status: 'corrupt', events: 0, pending: 0, acknowledged: 0, code: 'WENDKEEP_SYNC_STATE_UNAVAILABLE' };
  if (safeOutbox.status === 'disabled') return { enabled: false, outbox: safeOutbox, conflicts: 0 };
  if (!state || typeof state !== 'object') return {
    enabled: true,
    outbox: { ...safeOutbox, status: 'corrupt', code: 'WENDKEEP_SYNC_STATE_UNAVAILABLE' },
    conflicts: 0,
  };
  const conflicts = Object.values(state.conflicts || {}).filter((item) => item?.status === 'open').length;
  return { enabled: true, outbox: safeOutbox, conflicts };
}

export function listSyncConflictsForMcp({ state } = {}) {
  return Object.entries(state?.conflicts || {})
    .filter(([, item]) => item?.status === 'open')
    .map(([recordKey, item]) => ({
      record_key: recordKey,
      status: 'open',
      candidates: (item.candidates || []).map(publicCandidate),
    }))
    .sort((left, right) => left.record_key.localeCompare(right.record_key));
}
