const TERMINAL_SESSION_STATUSES = new Set([
  'done',
  'superseded',
  'completed',
  'closed',
  'inactive',
  'abandoned',
]);

function sessionEntry(registry, event) {
  const sessionId = String(event?.canonical_session_id || '').trim();
  return sessionId ? registry?.sessions?.[sessionId] || null : null;
}

/** Pure, fail-closed policy shared by doctor and interactive curation. */
export function classifyMemoryCandidate(candidate, registry = { sessions: {} }) {
  if (candidate?.reason !== 'conflict' || candidate?.memory_key !== 'handoff.latest') {
    return { classification: 'actionable' };
  }

  const events = Array.isArray(candidate.events) ? candidate.events : [];
  if (!events.length) return { classification: 'unknown' };
  const entries = events.map((event) => sessionEntry(registry, event));
  if (entries.some((entry) => !entry)) return { classification: 'unknown' };
  if (entries.some((entry) => String(entry.status || '').trim() === 'active')) {
    return { classification: 'actionable' };
  }
  if (entries.every((entry) => TERMINAL_SESSION_STATUSES.has(String(entry.status || '').trim()))) {
    return { classification: 'historical', recommended_action: 'reject' };
  }
  return { classification: 'unknown' };
}

export function candidateSessionContext(event, registry = { sessions: {} }) {
  const entry = sessionEntry(registry, event);
  if (!entry) return {};
  const status = String(entry.status || '').trim();
  const changeSlug = String(entry.change_slug || entry.changeSlug || '').trim();
  return {
    ...(status ? { session_status: status } : {}),
    ...(changeSlug ? { change_slug: changeSlug } : {}),
  };
}

export function isHistoricalHandoffCandidate(candidate, registry) {
  return classifyMemoryCandidate(candidate, registry).classification === 'historical';
}
