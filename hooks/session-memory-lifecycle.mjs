// Durable SessionStop memory publication split into three explicit phases:
// registry-guarded outbox staging -> independent projection -> registry CAS outcome.
// Keeping the MEMORY lock out of the registry critical section avoids lock inversion,
// while the immutable outbox is the durable hand-off between both locks.
import { buildSessionMemoryEvents } from './memory-handoff.mjs';
import { detectMemoryMode } from './memory-mode.mjs';
import { sanitizeMemoryText } from './memory-schema.mjs';
import { enqueueMemoryEvent, projectMemoryOutbox } from './memory-store.mjs';
import { mutateSessionRegistry } from './obsidian-common.mjs';

const DEFAULT_OBSERVED_AT = '1970-01-01T00:00:00.000Z';

const DEFAULT_DEPS = Object.freeze({
  buildSessionMemoryEvents,
  detectMemoryMode,
  enqueueMemoryEvent,
  mutateSessionRegistry,
  projectMemoryOutbox,
  sanitizeMemoryText,
});

function dependencies(overrides = {}) {
  return { ...DEFAULT_DEPS, ...(overrides || {}) };
}

function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeContext(context = {}) {
  const handoff = context.handoff && typeof context.handoff === 'object'
    ? context.handoff
    : context;
  const identity = handoff.identity || context.identity || {};
  const activation = handoff.activation || context.activation || {};
  const turn = handoff.turn || context.turn || {};
  const sessionId = String(
    context.sessionId
    || context.canonicalSessionId
    || identity.canonicalConversationId
    || '',
  );
  const activationId = String(context.activationId || activation.id || '');
  const activationEpoch = nonNegativeInteger(
    context.activationEpoch ?? activation.epoch,
    0,
  );
  const turnId = String(context.turnId || turn.id || '');
  const turnSequence = nonNegativeInteger(context.turnSequence ?? turn.sequence, 0);
  const observedAt = String(context.observedAt || handoff.observedAt || DEFAULT_OBSERVED_AT);
  const disposition = String(
    context.disposition
    || context.stopDisposition
    || 'applied',
  );

  return {
    sessionId,
    activationId,
    activationEpoch,
    turnId,
    turnSequence,
    observedAt,
    disposition,
    handoff: {
      ...handoff,
      identity: { ...identity, canonicalConversationId: sessionId },
      activation: { ...activation, id: activationId, epoch: activationEpoch },
      turn: { ...turn, id: turnId, sequence: turnSequence },
      observedAt,
    },
  };
}

function attemptIdentity(context, memoryMode) {
  return {
    v: 1,
    memory_mode: memoryMode,
    canonical_session_id: context.sessionId,
    activation_id: context.activationId,
    activation_epoch: context.activationEpoch,
    turn_id: context.turnId,
    turn_sequence: context.turnSequence,
    observed_at: context.observedAt,
  };
}

function sameAttempt(left, right) {
  if (!left || !right) return false;
  return String(left.canonical_session_id || '') === String(right.canonical_session_id || '')
    && String(left.activation_id || '') === String(right.activation_id || '')
    && nonNegativeInteger(left.activation_epoch, -1) === nonNegativeInteger(right.activation_epoch, -1)
    && String(left.turn_id || '') === String(right.turn_id || '')
    && nonNegativeInteger(left.turn_sequence, -1) === nonNegativeInteger(right.turn_sequence, -1);
}

function skippedAttempt(context, memoryMode, disposition) {
  return {
    ...attemptIdentity(context, memoryMode),
    disposition,
    state: 'skipped',
    event_ids: [],
    checkpoint: null,
  };
}

function causalDisposition(entry, context) {
  if (!entry || !context.sessionId || !context.activationId || !context.turnId) return 'ambiguous';
  if (['ambiguous', 'stale_turn', 'superseded'].includes(context.disposition)) {
    return context.disposition;
  }

  const activeId = String(entry.active_activation_id || '');
  const active = entry.activations?.[activeId];
  if (!activeId || activeId !== context.activationId || active?.status !== 'active') {
    return 'superseded';
  }
  if (nonNegativeInteger(active.epoch, -1) !== context.activationEpoch) return 'superseded';

  const openedAfter = nonNegativeInteger(active.opened_after_turn_sequence, 0);
  if (context.activationEpoch > 1 && context.turnSequence <= openedAfter) return 'superseded';

  const lastStopSequence = nonNegativeInteger(
    active.last_stop_turn_sequence,
    nonNegativeInteger(entry.last_turn_sequence, 0),
  );
  const lastStopTurnId = String(active.last_stop_turn_id || entry.last_turn_id || '');
  if (lastStopSequence > context.turnSequence) return 'stale_turn';
  if (lastStopTurnId && lastStopTurnId !== context.turnId) return 'stale_turn';
  return 'applied';
}

function retryAttempt(previous) {
  if (previous.state === 'projected' || previous.state === 'duplicate') {
    return { ...previous, disposition: 'duplicate', state: 'duplicate', retry: true };
  }
  if (previous.state === 'enqueued' || previous.state === 'degraded') {
    return { ...previous, state: 'enqueued', retry: true };
  }
  return null;
}

function canPersistAmbiguousSkip(entry, candidate) {
  if (candidate.disposition !== 'ambiguous') return false;
  const entryEpoch = nonNegativeInteger(entry.activation_epoch, -1);
  if (entryEpoch > candidate.activation_epoch) return false;
  if (entryEpoch === candidate.activation_epoch
      && nonNegativeInteger(entry.last_turn_sequence, -1) > candidate.turn_sequence) {
    return false;
  }

  const previous = entry.last_memory_attempt;
  if (!previous) return true;
  const previousEpoch = nonNegativeInteger(previous.activation_epoch, -1);
  if (previousEpoch !== candidate.activation_epoch) return previousEpoch < candidate.activation_epoch;
  const previousTurn = nonNegativeInteger(previous.turn_sequence, -1);
  if (previousTurn !== candidate.turn_sequence) return previousTurn < candidate.turn_sequence;
  return sameAttempt(previous, candidate) && previous.state === 'skipped';
}

/**
 * Revalidate the Stop under SESSION_REGISTRY.lock, durably enqueue every event, and only
 * then acknowledge `last_memory_attempt.state = enqueued` in the same registry mutation.
 */
export function stageStopMemoryAttempt(vaultBase, rawContext, overrides = {}) {
  const deps = dependencies(overrides);
  const context = normalizeContext(rawContext);
  const mode = deps.detectMemoryMode(vaultBase).mode;
  if (mode === 'legacy') return skippedAttempt(context, 'legacy', 'legacy');

  const identity = attemptIdentity(context, 'v2');
  let staged = null;
  deps.mutateSessionRegistry(vaultBase, (registry) => {
    const entry = registry.sessions?.[context.sessionId];
    const disposition = causalDisposition(entry, context);
    if (disposition !== 'applied') {
      staged = skippedAttempt(context, 'v2', disposition);
      if (entry && canPersistAmbiguousSkip(entry, staged)) {
        entry.last_memory_attempt = staged;
        entry.memory_status = 'skipped';
        if (context.activationId) entry.memory_activation_id = context.activationId;
      }
      return staged;
    }

    const previous = entry.last_memory_attempt;
    if (sameAttempt(previous, identity)) {
      const retry = retryAttempt(previous);
      if (retry) {
        staged = retry;
        return staged;
      }
    }

    const events = deps.buildSessionMemoryEvents(context.handoff);
    if (!Array.isArray(events) || events.length === 0) {
      throw new TypeError('Session memory staging requires at least one event.');
    }
    for (const event of events) deps.enqueueMemoryEvent(vaultBase, event);

    staged = {
      ...identity,
      disposition: 'applied',
      state: 'enqueued',
      event_ids: events.map((event) => String(event.event_id || '')),
      checkpoint: null,
    };
    entry.last_memory_attempt = staged;
    entry.memory_status = 'enqueued';
    entry.memory_activation_id = context.activationId;
    return staged;
  });

  return staged || skippedAttempt(context, 'v2', 'ambiguous');
}

function outcome(attempt, state, extra = {}) {
  const eventIds = Array.isArray(attempt?.event_ids) ? [...attempt.event_ids] : [];
  return {
    ...attempt,
    ...extra,
    state,
    status: state,
    event_ids: eventIds,
    eventIds,
    eventCount: eventIds.length,
  };
}

/** Project outside the registry lock. The outbox remains the recovery authority on failure. */
export function projectStopMemoryAttempt(vaultBase, attempt, overrides = {}) {
  const deps = dependencies(overrides);
  if (attempt?.memory_mode === 'legacy') {
    return { ...outcome(attempt, 'skipped'), status: 'legacy' };
  }
  if (attempt?.state === 'duplicate') return outcome(attempt, 'duplicate');
  if (attempt?.state === 'skipped') return outcome(attempt, 'skipped');

  try {
    const projection = deps.projectMemoryOutbox(vaultBase, overrides.projectOptions || {});
    if (projection?.status === 'busy') {
      return outcome(attempt, 'degraded', {
        error: 'memory projector busy; outbox preserved for replay',
        checkpoint: null,
      });
    }
    return outcome(attempt, 'projected', {
      checkpoint: projection.checkpoint && typeof projection.checkpoint === 'object'
        ? { ...projection.checkpoint }
        : {
          revision: projection.revision,
          event_cursor: projection.ledgerCursor || projection.eventCursor,
          state_hash: projection.stateHash,
          ...(projection.ledgerCursor && projection.eventCursor !== projection.ledgerCursor
            ? { causal_event_cursor: projection.eventCursor }
            : {}),
        },
    });
  } catch (error) {
    return outcome(attempt, 'degraded', {
      error: deps.sanitizeMemoryText(error?.message || String(error)),
      checkpoint: null,
    });
  }
}

function activeContextMatches(entry, attempt) {
  const activeId = String(entry?.active_activation_id || '');
  const active = entry?.activations?.[activeId];
  return activeId === String(attempt.activation_id || '')
    && active?.status === 'active'
    && nonNegativeInteger(active.epoch, -1) === nonNegativeInteger(attempt.activation_epoch, -1);
}

function storedAttempt(outcomeValue) {
  const stored = {
    v: 1,
    memory_mode: 'v2',
    canonical_session_id: String(outcomeValue.canonical_session_id || ''),
    activation_id: String(outcomeValue.activation_id || ''),
    activation_epoch: nonNegativeInteger(outcomeValue.activation_epoch, 0),
    turn_id: String(outcomeValue.turn_id || ''),
    turn_sequence: nonNegativeInteger(outcomeValue.turn_sequence, 0),
    disposition: String(outcomeValue.disposition || 'applied'),
    state: outcomeValue.state,
    event_ids: Array.isArray(outcomeValue.event_ids) ? [...outcomeValue.event_ids] : [],
    observed_at: String(outcomeValue.observed_at || DEFAULT_OBSERVED_AT),
  };
  if (outcomeValue.state === 'projected' && outcomeValue.checkpoint) {
    stored.checkpoint = { ...outcomeValue.checkpoint };
  }
  if (outcomeValue.state === 'degraded' && outcomeValue.error) {
    stored.error = String(outcomeValue.error);
  }
  return stored;
}

/** Persist a final outcome only while the exact staged activation/epoch/turn still owns it. */
export function recordStopMemoryOutcome(vaultBase, attempt, outcomeValue, overrides = {}) {
  if (attempt?.memory_mode === 'legacy' || outcomeValue?.status === 'legacy') {
    return { ...outcomeValue, persisted: false, reason: 'legacy' };
  }
  if (outcomeValue?.state === 'duplicate' || outcomeValue?.state === 'skipped') {
    return { ...outcomeValue, persisted: false, reason: outcomeValue.state };
  }
  if (!sameAttempt(attempt, outcomeValue)) {
    return { ...outcomeValue, persisted: false, reason: 'stale-causal-context' };
  }
  if (!['projected', 'degraded'].includes(outcomeValue?.state)) {
    return { ...outcomeValue, persisted: false, reason: 'non-final-outcome' };
  }

  const deps = dependencies(overrides);
  let result = { ...outcomeValue, persisted: false, reason: 'stale-causal-context' };
  deps.mutateSessionRegistry(vaultBase, (registry) => {
    const entry = registry.sessions?.[attempt.canonical_session_id];
    if (!entry || !activeContextMatches(entry, attempt)) return result;
    if (!sameAttempt(entry.last_memory_attempt, attempt)) return result;

    entry.last_memory_attempt = storedAttempt(outcomeValue);
    entry.memory_status = outcomeValue.state;
    entry.memory_activation_id = attempt.activation_id;
    if (outcomeValue.state === 'projected') {
      entry.memory_checkpoint = { ...outcomeValue.checkpoint };
    } else {
      // This branch is reachable only after the exact attempt CAS above. A stale outcome
      // cannot clear a checkpoint owned by a newer activation/turn.
      delete entry.memory_checkpoint;
    }
    result = { ...outcomeValue, persisted: true, reason: 'recorded' };
    return result;
  });
  return result;
}
