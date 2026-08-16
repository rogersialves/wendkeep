import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { sanitizeMemoryText } from './memory-schema.mjs';

const SHARED_HANDOFF_FIELDS = Object.freeze([
  ['objective', 'objective.current'],
  ['delivered', 'state.delivered'],
  ['constraints', 'constraint.active'],
  ['decisions', 'decision.active'],
  ['next_actions', 'next.action'],
  ['blockers', 'blocker.active'],
  ['risks', 'risk.known'],
]);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function sanitizeValue(value) {
  if (typeof value === 'string') return sanitizeMemoryText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sanitizeValue(value[key])]));
  }
  return value;
}

function hasMeaningfulValue(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

/** Normalize the portable operational handoff without inventing missing identity. */
export function normalizeSharedHandoff(shared) {
  if (!shared || typeof shared !== 'object' || Array.isArray(shared)) return null;

  const normalized = {};
  const workSessionId = sanitizeMemoryText(shared.work_session_id ?? shared.workSessionId ?? '').trim();
  if (workSessionId) normalized.work_session_id = workSessionId;

  for (const [field] of SHARED_HANDOFF_FIELDS) {
    if (!Object.hasOwn(shared, field)) continue;
    const value = sanitizeValue(shared[field]);
    if (hasMeaningfulValue(value)) normalized[field] = value;
  }

  return Object.keys(normalized).length ? normalized : null;
}

function eventId(context, memoryKey, value) {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      context.projectId,
      context.identity?.canonicalConversationId,
      context.activation?.id,
      context.turn?.id,
      memoryKey,
      canonicalValue(value),
    ]))
    .digest('hex')
    .slice(0, 24);
  return `mem-${digest}`;
}

function makeEvent(context, { memoryKey, value, authority, evidence }) {
  const cleanValue = sanitizeValue(value);
  const event = {
    v: 1,
    event_id: eventId(context, memoryKey, cleanValue),
    project_id: String(context.projectId || ''),
    memory_key: memoryKey,
    operation: 'assert',
    value: cleanValue,
    authority,
    canonical_session_id: String(context.identity?.canonicalConversationId || ''),
    activation_id: String(context.activation?.id || ''),
    activation_epoch: Number(context.activation?.epoch || 0),
    turn_sequence: Number(context.turn?.sequence || 0),
    source_turn_id: String(context.turn?.id || ''),
    observed_at: context.observedAt,
    evidence: (evidence || []).filter(Boolean).map((item) => sanitizeMemoryText(item)),
  };
  if (context.workSessionId) event.work_session_id = context.workSessionId;
  return event;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function filesBelow(dir, accept, found = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) filesBelow(path, accept, found);
    else if (accept(entry.name)) found.push(path);
  }
  return found;
}

function vaultRel(vaultBase, path) {
  return relative(vaultBase, path).replaceAll('\\', '/');
}

function nextActionFrom(summary) {
  const match = String(summary || '').match(/(?:a\s+)?pr[oó]xima\s+(?:change\s+)?(?:ser[aá]|[ée]|:)\s+(?:a\s+)?([^.!?\n]+)/i);
  if (!match) return null;
  const text = sanitizeMemoryText(match[1].trim());
  const id = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  return id && text ? { id, summary: text } : null;
}

export function collectLifecycleEvidence(vaultBase, { changeSlug = '', summary = '', noteRel = '' } = {}) {
  const evidence = {};
  const slug = String(changeSlug || '').trim();
  if (slug) {
    const changeRoots = ['08-Mudanças', '08-Changes'];
    let archivedDir = '';
    for (const root of changeRoots) {
      const archive = join(vaultBase, root, '_arquivo');
      let names = [];
      try { names = readdirSync(archive, { withFileTypes: true }); } catch { /* absent locale */ }
      const match = names.find((entry) => entry.isDirectory() && (entry.name === slug || entry.name.endsWith(`-${slug}`)));
      if (match) { archivedDir = join(archive, match.name); break; }
    }

    const adrPattern = new RegExp(`^ADR-(\\d{4})-${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.md$`, 'i');
    const adrPath = filesBelow(vaultBase, (name) => adrPattern.test(name))[0];
    if (archivedDir && adrPath) {
      const adr = (basename(adrPath).match(/^ADR-\d{4}/i) || [''])[0].toUpperCase();
      evidence.change = { slug, status: 'archived', adr, path: vaultRel(vaultBase, adrPath) };
      const verdictPath = join(archivedDir, 'verdict.json');
      const verdict = readJson(verdictPath);
      if (verdict && typeof verdict.ok === 'boolean' && Array.isArray(verdict.coverage)) {
        evidence.verdict = {
          ok: verdict.ok,
          covered: verdict.coverage.filter((item) => item?.covered === true).length,
          total: verdict.coverage.length,
          path: vaultRel(vaultBase, verdictPath),
        };
      }
      const sensorPath = join(archivedDir, 'evidencia.json');
      const sensors = readJson(sensorPath);
      if (Array.isArray(sensors) && sensors.length && sensors.every((item) => item?.status === 'green')) {
        evidence.sensors = [...new Set(sensors.map((item) => String(item.id || '')).filter(Boolean))].sort();
      }
    }
  }

  const nextAction = nextActionFrom(summary);
  if (nextAction) evidence.nextAction = nextAction;
  const commit = String(summary || '').match(/\b[0-9a-f]{40}\b/i)?.[0];
  if (commit) {
    evidence.git = {
      commit: commit.toLowerCase(),
      pushed: !/(?:nenhum|sem)\s+push/i.test(String(summary || '')),
      verified: false,
      path: noteRel,
    };
  }
  return evidence;
}

export function buildSessionMemoryEvents({
  projectId,
  identity,
  activation,
  turn,
  noteRel,
  observedAt,
  summary,
  evidence = {},
  shared,
}) {
  const normalizedShared = normalizeSharedHandoff(shared);
  const context = {
    projectId, identity, activation, turn, observedAt,
    workSessionId: normalizedShared?.work_session_id || '',
  };
  const events = [];

  if (normalizedShared) {
    for (const [field, memoryKey] of SHARED_HANDOFF_FIELDS) {
      if (!Object.hasOwn(normalizedShared, field)) continue;
      events.push(makeEvent(context, {
        memoryKey,
        value: normalizedShared[field],
        authority: 'reported',
        evidence: [noteRel],
      }));
    }
  }

  if (!events.length) {
    events.push(makeEvent(context, {
      memoryKey: 'handoff.latest',
      value: sanitizeMemoryText(summary),
      authority: 'reported',
      evidence: [noteRel],
    }));
  }

  if (evidence.change?.slug && evidence.change?.status && evidence.change?.adr) {
    events.push(makeEvent(context, {
      memoryKey: `change.${evidence.change.slug}.status`,
      value: { status: evidence.change.status, adr: evidence.change.adr },
      authority: 'verified',
      evidence: [evidence.change.path || evidence.change.adr],
    }));
  }

  if (evidence.verdict?.path && typeof evidence.verdict.ok === 'boolean') {
    events.push(makeEvent(context, {
      memoryKey: 'quality.latest-verdict',
      value: {
        ok: evidence.verdict.ok,
        covered: Number(evidence.verdict.covered || 0),
        total: Number(evidence.verdict.total || 0),
      },
      authority: 'verified',
      evidence: [evidence.verdict.path],
    }));
  }

  if (Array.isArray(evidence.sensors) && evidence.sensors.length) {
    events.push(makeEvent(context, {
      memoryKey: 'quality.latest-sensors',
      value: [...new Set(evidence.sensors.map(String))].sort(),
      authority: 'verified',
      evidence: evidence.sensors,
    }));
  }

  if (evidence.git?.commit) {
    events.push(makeEvent(context, {
      memoryKey: 'git.local-head',
      value: {
        commit: evidence.git.commit,
        pushed: Boolean(evidence.git.pushed),
        push_status: evidence.git.pushed ? 'pushed' : 'nenhum push',
      },
      authority: evidence.git.verified === false ? 'reported' : 'verified',
      evidence: [evidence.git.path || evidence.git.commit],
    }));
  }

  if (evidence.nextAction?.id && evidence.nextAction?.summary) {
    events.push(makeEvent(context, {
      memoryKey: `next.${evidence.nextAction.id}`,
      value: sanitizeMemoryText(evidence.nextAction.summary),
      authority: 'verified',
      evidence: [noteRel],
    }));
  }

  return events;
}
