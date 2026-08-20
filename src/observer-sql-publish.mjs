import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseTranscriptContent } from '../packages/integrations/src/transcripts.mjs';
import { parseSessionCost, } from './cost.mjs';
import { buildSessionIdentityMap, listMigrationDocuments, parseFrontmatter, sessionEvents } from './observer-sql-migrate.mjs';
import { observerAuthHeaders } from './observer-auth.mjs';
import { sanitizeObserverContent, sanitizeObserverMetadata } from './observer-privacy.mjs';

export const SQL_OUTBOX_REL = '.brain/observer-sql-outbox';
export const SQL_STATE_REL = '.brain/observer-sql-state.json';
export const SQL_PUBLISHER_LEASE_REL = '.brain/observer-sql-publisher.lock';
const SQL_SCHEMA_VERSION = 1;
export const SQL_EVENT_BATCH_SIZE = 64;
export const SQL_EVENT_BATCH_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_REQUEST_TIMEOUT_MS = 120000;
export const SQL_LEASE_STALE_MS = MAX_REQUEST_TIMEOUT_MS + 30000;
const REQUEST_TIMEOUT_BYTES_STEP = 1024 * 1024;
const CAPTURE_LEVELS = new Set(['metadata', 'messages', 'full-transcript']);

export function observerSqlRequestTimeoutMs(rawBytes) {
  const size = Math.max(0, Number(rawBytes) || 0);
  const oversizedBytes = Math.max(0, size - SQL_EVENT_BATCH_BYTES);
  return Math.min(
    MAX_REQUEST_TIMEOUT_MS,
    REQUEST_TIMEOUT_MS + Math.ceil(oversizedBytes / REQUEST_TIMEOUT_BYTES_STEP) * 1000,
  );
}

export function normalizeObserverCaptureLevel(value = process.env.WENDKEEP_OBSERVER_CAPTURE_LEVEL || 'metadata') {
  const level = String(value || 'metadata').trim().toLowerCase();
  if (!CAPTURE_LEVELS.has(level)) {
    const error = new Error(`Nível de captura inválido: ${level}. Use metadata, messages ou full-transcript.`);
    error.code = 'WENDKEEP_OBSERVER_CAPTURE_LEVEL_INVALID';
    throw error;
  }
  return level;
}

function text(value, fallback = '') { return String(value ?? fallback); }
function hash(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
function eventId(kind, projectId, seed) { return `sql-${kind}-${hash(`${projectId}:${seed}`).slice(0, 24)}`; }
function isoNow(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('occurred_at inválido.');
  return date.toISOString();
}
function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function atomicJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}
function statePath(vaultBase) { return join(vaultBase, SQL_STATE_REL); }
function readState(vaultBase) {
  return readJson(statePath(vaultBase), { schema_version: SQL_SCHEMA_VERSION, files: {}, transcripts: {} });
}
function outboxDir(vaultBase) { return join(vaultBase, SQL_OUTBOX_REL); }
function outboxPath(vaultBase, batch) { return join(outboxDir(vaultBase), `sql-${hash(JSON.stringify(batch.events)).slice(0, 24)}.json`); }

function normalizePath(value) { return String(value || '').replaceAll('\\', '/'); }
function readRegistry(vaultBase) {
  return readJson(join(vaultBase, '.brain', 'SESSION_REGISTRY.json'), { sessions: {} });
}
function registryEntry(vaultBase, logicalPath, sessionId) {
  const sessions = readRegistry(vaultBase).sessions || {};
  return Object.entries(sessions).find(([id, entry]) => id === sessionId || normalizePath(entry?.session_file) === logicalPath)?.[1] || {};
}
function transcriptIdFromPath(path) { return basename(String(path || '')).replace(/\.jsonl?$/i, '') || ''; }
function modelProvider(provider, model) {
  const clean = String(provider || '').toLowerCase();
  if (clean.includes('claude') || clean.includes('anthropic') || String(model).startsWith('claude-')) return 'anthropic';
  if (clean.includes('codex') || clean.includes('openai') || String(model).startsWith('gpt-')) return 'openai';
  return clean;
}
function tokenPayload(usage = {}) {
  return {
    input: Number(usage.input) || 0,
    cache_write: Number(usage.cacheWrite) || 0,
    cache_read: Number(usage.cached) || 0,
    output: Number(usage.output) || 0,
    reasoning: Number(usage.reasoning) || 0,
    total: Number(usage.total) || 0,
  };
}

function documentEvent({ projectId, logicalPath, content, metadata, revision, occurredAt }) {
  const safeContent = sanitizeObserverContent(content);
  const safeMetadata = sanitizeObserverMetadata(metadata);
  const contentHash = hash(safeContent);
  return {
    schema_version: 1,
    event_id: eventId('document', projectId, `${logicalPath}:${revision}:${contentHash}`),
    kind: 'document.upsert',
    project_id: projectId,
    occurred_at: occurredAt,
    payload: {
      logical_path: logicalPath,
      entity_type: logicalPath.startsWith('02-Sessões/') ? 'session'
        : logicalPath.startsWith('04-Decisões/') ? 'decision'
          : logicalPath.startsWith('05-Bugs/') ? 'bug'
            : logicalPath.startsWith('06-Aprendizados/') ? 'learning'
              : logicalPath.startsWith('07-Specs/') ? 'spec'
                : logicalPath.startsWith('08-Mudanças/') ? 'change' : 'memory',
      title: basename(logicalPath).replace(/\.md$/i, ''),
      content: safeContent,
      content_hash: contentHash,
      revision,
      metadata: safeMetadata,
      source_session_id: text(safeMetadata?.session_id),
    },
  };
}

function agentEvent({ projectId, sessionId, agentId, parentAgentId = '', role = 'main', provider = '', model = '', input = {}, occurredAt }) {
  const fingerprint = hash({ agentId, role, provider, model, input: input.agent_id || input.agent_transcript_path || '' }).slice(0, 24);
  return {
    schema_version: 1,
    event_id: eventId('agent', projectId, `${agentId}:${fingerprint}`),
    kind: 'agent.upsert',
    project_id: projectId,
    occurred_at: occurredAt,
    payload: {
      agent_id: agentId,
      session_id: sessionId,
      parent_agent_id: parentAgentId || null,
      role,
      agent_name: text(input.agent_name || input.agentName || provider),
      agent_type: text(input.agent_type || input.agentType || role),
      workflow: text(input.workflow),
      status: text(input.status, 'running'),
      model,
      effort: text(input.effort || input.nivel_pensamento),
      started_at: input.started_at || null,
      ended_at: input.ended_at || null,
    },
  };
}

function transcriptCalls({ projectId, sessionId, agentId, role, provider, modelFallback, transcriptId, content, occurredAt, includeMessages }) {
  let parsed;
  try { parsed = parseTranscriptContent(content); } catch { return []; }
  return (parsed.turns || []).flatMap((turn, index) => {
    const prompt = (turn.userPrompts || []).join('\n\n');
    const response = (turn.assistantMessages || []).join('\n\n');
    const tokens = tokenPayload(turn.usage);
    if (!prompt && !response && !tokens.total) return [];
    const model = text(turn.model || parsed.model || modelFallback, '?');
    const stableTurn = turn.turnId || index + 1;
    const turnRevision = turn.status === 'complete'
      ? 'complete'
      : hash({ prompt, response, tokens, status: turn.status }).slice(0, 16);
    const callId = eventId('call', projectId, `${transcriptId}:${agentId}:${stableTurn}:${turnRevision}`);
    return [{
      schema_version: 1,
      event_id: eventId('call-event', projectId, callId),
      kind: 'llm_call',
      project_id: projectId,
      occurred_at: text(turn.timestamp, occurredAt),
      payload: {
        call_id: callId,
        session_id: sessionId,
        agent_id: agentId,
        role,
        provider,
        model_provider: modelProvider(provider, model),
        model,
        effort: '',
        sequence: index + 1,
        occurred_at: text(turn.timestamp, occurredAt),
        tokens,
        cost_usd: 0,
        cost_status: 'unknown',
        transcript_id: transcriptId,
        prompt_text: includeMessages ? prompt : '',
        response_text: includeMessages ? response : '',
        status: turn.status === 'aborted' ? 'aborted' : 'complete',
        metadata: { tools: turn.tools || [], source: 'transcript-parser' },
      },
    }];
  });
}

function sourceCandidates({ vaultBase, logicalPath, fm, input }) {
  const sessionId = text(fm.session_id || input?.session_id || input?.sessionId);
  const registry = registryEntry(vaultBase, logicalPath, sessionId);
  const candidates = [];
  const add = (path, id = '', role = 'main', agentInput = {}) => {
    if (!path || !existsSync(path)) return;
    const transcriptId = text(id) || transcriptIdFromPath(path);
    if (transcriptId && !candidates.some((item) => item.transcriptId === transcriptId)) candidates.push({ path, transcriptId, role, agentInput });
  };
  add(input?.transcript_path || input?.transcriptPath || '', input?.transcript_id || input?.transcriptId, 'main', input || {});
  add(input?.agent_transcript_path || input?.agentTranscriptPath || '', input?.agent_transcript_id || input?.agentTranscriptId, 'subagent', input || {});
  add(fm.transcript_path || fm.transcriptPath || '', fm.observability_transcript_id);
  add(registry.transcript_path, registry.transcript_id);
  for (const path of registry.transcript_paths || []) add(path, transcriptIdFromPath(path));
  return candidates;
}

function completeTranscriptEvents({ projectId, sessionId, mainAgentId, provider, model, source, now, captureLevel }) {
  const content = readFileSync(source.path, 'utf8');
  const agentId = source.role === 'subagent'
    ? `${projectId}:${sessionId}:subagent:${hash(source.path).slice(0, 16)}`
    : mainAgentId;
  const agent = source.role === 'subagent'
    ? agentEvent({ projectId, sessionId, agentId, parentAgentId: mainAgentId, role: 'subagent', provider, model, input: source.agentInput, occurredAt: now })
    : null;
  const fingerprint = hash(content);
  const transcript = captureLevel === 'full-transcript' ? {
    schema_version: 1,
    event_id: eventId('transcript', projectId, `${source.transcriptId}:${fingerprint}`),
    kind: 'transcript.upsert',
    project_id: projectId,
    occurred_at: now,
    payload: {
      transcript_id: source.transcriptId,
      session_id: sessionId,
      agent_id: agentId,
      coverage: 'complete',
      content,
      source: 'hook-transcript',
      metadata: { source_label: basename(source.path), source_hash: hash(normalizePath(source.path)) },
    },
  } : null;
  const calls = transcriptCalls({
    projectId,
    sessionId,
    agentId,
    role: source.role,
    provider,
    modelFallback: model,
    transcriptId: source.transcriptId,
    content,
    occurredAt: now,
    includeMessages: captureLevel !== 'metadata',
  });
  return { events: [agent, transcript, ...calls].filter(Boolean), fingerprint, transcriptId: source.transcriptId };
}

function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    if (seen.has(event.event_id)) return false;
    seen.add(event.event_id);
    return true;
  });
}

export function buildObserverSqlEventBatch({ vaultBase, projectId, input = {}, now = new Date(), state = readState(vaultBase), remoteDocuments = {}, captureLevel = process.env.WENDKEEP_OBSERVER_CAPTURE_LEVEL || 'metadata', forceFull = false } = {}) {
  if (!vaultBase || !projectId) throw new Error('vaultBase e projectId são obrigatórios.');
  const occurredAt = isoNow(now);
  const resolvedCaptureLevel = normalizeObserverCaptureLevel(captureLevel);
  const nextState = { schema_version: SQL_SCHEMA_VERSION, files: { ...(state.files || {}) }, transcripts: { ...(state.transcripts || {}) } };
  const events = [];
  const sessionContexts = [];
  const files = listMigrationDocuments(vaultBase);
  const sessionFiles = files.flatMap((file) => {
    if (!file.logicalPath.startsWith('02-Sessões/')) return [];
    const content = readFileSync(file.absolute, 'utf8');
    const fm = parseFrontmatter(content);
    return fm.type === 'session' ? [{ file, content, fm }] : [];
  });
  const sessionIdentity = buildSessionIdentityMap({ projectId, sessionFiles });
  let changed = 0;
  for (const file of files) {
    const content = readFileSync(file.absolute, 'utf8');
    const contentHash = hash(sanitizeObserverContent(content));
    const previous = state.files?.[file.logicalPath];
    const remote = remoteDocuments?.[file.logicalPath];
    const baseRevision = Math.max(Number(previous?.revision || 0), Number(remote?.revision || 0));
    const unchanged = previous?.content_hash === contentHash || remote?.content_hash === contentHash;
    const revision = baseRevision + (unchanged ? 0 : 1);
    nextState.files[file.logicalPath] = { content_hash: contentHash, revision: revision || 1 };
    const fm = parseFrontmatter(content);
    if (fm.type === 'session') sessionContexts.push({ file, content, fm, contentHash, revision: revision || 1, sessionId: sessionIdentity.get(file.logicalPath) });
    if (!forceFull && previous?.content_hash === contentHash) continue;
    changed += 1;
    events.push(documentEvent({ projectId, logicalPath: file.logicalPath, content, metadata: fm, revision: revision || 1, occurredAt }));
    if (fm.type === 'session') {
      const cost = parseSessionCost(content) || { model: '?', mainCost: 0, subCost: 0, tokens: 0, subTokens: 0, ledger: [] };
      events.push(...sessionEvents({ projectId, logicalPath: file.logicalPath, content, cost, revision: revision || 1, sessionId: sessionIdentity.get(file.logicalPath) }).events);
    }
  }

  for (const context of sessionContexts) {
    const sessionId = text(context.sessionId || context.fm.session_id || `historical:${hash(`${projectId}:${context.file.logicalPath}`).slice(0, 20)}`);
    const mainAgentId = `${projectId}:${sessionId}:main`;
    const provider = text(context.fm.provider);
    const model = text(context.fm.modelo || context.fm.custo_modelo_label, '?');
    const sources = sourceCandidates({ vaultBase, logicalPath: context.file.logicalPath, fm: context.fm, input })
      .map((source) => ({ ...source, role: source.role || 'main' }));
    for (const source of sources) {
      const content = readFileSync(source.path, 'utf8');
      const fingerprint = hash(content);
      const previousTranscript = state.transcripts?.[source.transcriptId];
      if (!forceFull && previousTranscript?.content_hash === fingerprint && previousTranscript?.coverage === resolvedCaptureLevel) continue;
      const complete = completeTranscriptEvents({ projectId, sessionId, mainAgentId, provider, model, source, now: occurredAt, captureLevel: resolvedCaptureLevel });
      nextState.transcripts[source.transcriptId] = { content_hash: complete.fingerprint, coverage: resolvedCaptureLevel };
      const summaryId = complete.transcriptId;
      for (const event of complete.events) {
        if (event.kind === 'agent.upsert' && event.payload.agent_id !== mainAgentId) events.push(event);
        else if (event.kind !== 'agent.upsert') events.push(event);
      }
      // A session document may have emitted a summary-only placeholder. The
      // complete event follows it and is intentionally idempotent by content hash.
      void summaryId;
    }
    if (sources.length === 0 && context.fm.observability_transcript_id) {
      nextState.transcripts[context.fm.observability_transcript_id] ||= { content_hash: '', coverage: 'summary_only' };
    }
  }
  return { events: dedupeEvents(events), nextState, scanned: Object.keys(nextState.files).length, changed };
}

function hookEventName(input = {}) {
  return text(input.hook_event_name || input.hookEventName || input.event_name || input.event).toLowerCase();
}

function incrementalSessionContext(vaultBase, input = {}) {
  const registry = readRegistry(vaultBase);
  const requestedId = text(
    input.session_id || input.sessionId || input.thread_id || input.threadId
      || input.conversation_id || input.conversationId,
  );
  const pair = Object.entries(registry.sessions || {}).find(([sessionId, entry]) => (
    (requestedId && sessionId === requestedId)
    || (input.session_file && normalizePath(entry?.session_file) === normalizePath(input.session_file))
  ));
  if (!pair?.[1]?.session_file) return null;
  const logicalPath = normalizePath(pair[1].session_file);
  if (!logicalPath || logicalPath.startsWith('/') || logicalPath.includes('..')) return null;
  const absolute = join(vaultBase, logicalPath);
  if (!existsSync(absolute)) return null;
  const content = readFileSync(absolute, 'utf8');
  return {
    sessionId: pair[0],
    entry: pair[1],
    file: { logicalPath, absolute },
    content,
    fm: parseFrontmatter(content),
  };
}

/** Build only the session/subagent evidence named by the current hook payload. */
export function buildObserverSqlIncrementalBatch({
  vaultBase,
  projectId,
  input = {},
  now = new Date(),
  state = readState(vaultBase),
  captureLevel = process.env.WENDKEEP_OBSERVER_CAPTURE_LEVEL || 'metadata',
} = {}) {
  if (!vaultBase || !projectId) throw new Error('vaultBase e projectId são obrigatórios.');
  const eventName = hookEventName(input);
  const nextState = {
    schema_version: SQL_SCHEMA_VERSION,
    files: { ...(state.files || {}) },
    transcripts: { ...(state.transcripts || {}) },
  };
  if (eventName.includes('sessionstart')) {
    return { events: [], nextState, scanned: 0, changed: 0, scope: 'drain-only' };
  }
  const context = incrementalSessionContext(vaultBase, input);
  if (!context) return { events: [], nextState, scanned: 0, changed: 0, scope: 'drain-only' };

  const occurredAt = isoNow(now);
  const resolvedCaptureLevel = normalizeObserverCaptureLevel(captureLevel);
  const events = [];
  let changed = 0;
  const safeContent = sanitizeObserverContent(context.content);
  const contentHash = hash(safeContent);
  const previous = state.files?.[context.file.logicalPath];
  const revision = Math.max(1, Number(previous?.revision || 0) + (previous?.content_hash === contentHash ? 0 : 1));
  nextState.files[context.file.logicalPath] = { content_hash: contentHash, revision };
  if (previous?.content_hash !== contentHash) {
    changed += 1;
    events.push(documentEvent({
      projectId,
      logicalPath: context.file.logicalPath,
      content: context.content,
      metadata: context.fm,
      revision,
      occurredAt,
    }));
    const cost = parseSessionCost(context.content)
      || { model: '?', mainCost: 0, subCost: 0, tokens: 0, subTokens: 0, ledger: [] };
    const sessionProjection = sessionEvents({
      projectId,
      logicalPath: context.file.logicalPath,
      content: context.content,
      cost,
      revision,
      sessionId: context.sessionId,
    }).events;
    events.push(...sessionProjection.filter((event) => !(
      eventName.includes('subagentstop') && event.kind === 'transcript.upsert'
    )));
  }

  const mainAgentId = `${projectId}:${context.sessionId}:main`;
  const provider = text(context.fm.provider);
  const model = text(context.fm.modelo || context.fm.custo_modelo_label, '?');
  let sources = sourceCandidates({
    vaultBase,
    logicalPath: context.file.logicalPath,
    fm: context.fm,
    input,
  });
  if (input.agent_transcript_path || input.agentTranscriptPath || eventName.includes('subagentstop')) {
    sources = sources.filter((source) => source.role === 'subagent').slice(0, 1);
  } else {
    sources = sources.filter((source) => source.role === 'main').slice(0, 1);
  }
  for (const source of sources) {
    const transcriptContent = readFileSync(source.path, 'utf8');
    const fingerprint = hash(transcriptContent);
    const previousTranscript = state.transcripts?.[source.transcriptId];
    if (previousTranscript?.content_hash === fingerprint && previousTranscript?.coverage === resolvedCaptureLevel) continue;
    const complete = completeTranscriptEvents({
      projectId,
      sessionId: context.sessionId,
      mainAgentId,
      provider,
      model,
      source,
      now: occurredAt,
      captureLevel: resolvedCaptureLevel,
    });
    nextState.transcripts[source.transcriptId] = {
      content_hash: complete.fingerprint,
      coverage: resolvedCaptureLevel,
    };
    events.push(...complete.events);
    changed += 1;
  }
  return {
    events: dedupeEvents(events),
    nextState,
    scanned: 1,
    changed,
    scope: `session:${context.sessionId}`,
  };
}

function queueOutbox(vaultBase, batch) {
  mkdirSync(outboxDir(vaultBase), { recursive: true });
  const path = outboxPath(vaultBase, batch);
  if (!existsSync(path)) atomicJson(path, batch);
  return path;
}

function eventCoalesceKey(event) {
  const payload = event.payload || {};
  const entityFields = {
    'document.upsert': ['logical_path'],
    'document.delete': ['logical_path'],
    'session.upsert': ['session_id'],
    'agent.upsert': ['agent_id'],
    'usage.rollup': ['rollup_key'],
    llm_call: ['call_id'],
    'transcript.upsert': ['transcript_id'],
  }[event.kind] || [];
  const entityId = entityFields.map((field) => payload[field]).find(Boolean) || event.event_id;
  return [
    event.project_id,
    event.kind,
    entityId,
  ].join('\u001f');
}

const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
function waitSync(milliseconds) { Atomics.wait(WAIT_ARRAY, 0, 0, milliseconds); }

function acquireBatchFileLease(path, waitMs = 0) {
  const lock = `${path}.lock`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + Math.max(0, waitMs);
  do {
    try {
      mkdirSync(lock);
      atomicJson(join(lock, 'owner.json'), { token, pid: process.pid, acquired_at: new Date().toISOString() });
      return { path: lock, token };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > SQL_LEASE_STALE_MS) {
          const stale = `${lock}.stale-${process.pid}-${Date.now()}`;
          renameSync(lock, stale);
          rmSync(stale, { recursive: true, force: true });
          continue;
        }
      } catch { /* another process recovered or released it */ }
      if (Date.now() >= deadline) return null;
      waitSync(Math.min(5, Math.max(1, deadline - Date.now())));
    }
  } while (Date.now() <= deadline);
  return null;
}

function releaseBatchFileLease(lease) {
  if (!lease) return;
  const owner = readJson(join(lease.path, 'owner.json'), {});
  if (owner.token === lease.token) rmSync(lease.path, { recursive: true, force: true });
}

/** Queue a precise writer batch and replace older pending state for the same logical scope. */
export function enqueueObserverSqlBatch(vaultBase, batch, { scope = 'incremental', now = new Date() } = {}) {
  if (!batch?.project_id || !Array.isArray(batch.events)) throw new Error('Batch incremental do Observer inválido.');
  if (!batch.events.length) return { queued: false, events: 0, path: '' };
  mkdirSync(outboxDir(vaultBase), { recursive: true });
  const path = join(outboxDir(vaultBase), `sql-live-${hash(`${batch.project_id}:${scope}`).slice(0, 24)}.json`);
  const lease = acquireBatchFileLease(path, 200);
  if (!lease) {
    const fallback = queueOutbox(vaultBase, { ...batch, enqueued_at: isoNow(now), scope });
    return { queued: true, events: batch.events.length, path: fallback, coalesced: false };
  }
  try {
    const existing = readJson(path, { events: [] });
    const merged = new Map();
    for (const event of [...(existing.events || []), ...batch.events]) merged.set(eventCoalesceKey(event), event);
    const timestamp = isoNow(now);
    atomicJson(path, {
      schema_version: SQL_SCHEMA_VERSION,
      project_id: batch.project_id,
      scope,
      enqueued_at: existing.enqueued_at || timestamp,
      updated_at: timestamp,
      events: [...merged.values()],
    });
    return { queued: true, events: merged.size, path, coalesced: true };
  } finally {
    releaseBatchFileLease(lease);
  }
}

/** Writer seam for note/archive commands: enqueue exactly one known logical document. */
export function enqueueObserverDocumentChange({
  vaultBase,
  projectId,
  logicalPath,
  deleted = false,
  now = new Date(),
} = {}) {
  const normalized = normalizePath(logicalPath);
  if (!vaultBase || !projectId || !normalized || normalized.startsWith('/') || normalized.includes('..')) {
    throw new Error('Documento incremental do Observer inválido.');
  }
  const state = readState(vaultBase);
  const nextState = {
    schema_version: SQL_SCHEMA_VERSION,
    files: { ...(state.files || {}) },
    transcripts: { ...(state.transcripts || {}) },
  };
  const previous = state.files?.[normalized];
  const revision = Math.max(1, Number(previous?.revision || 0) + 1);
  const occurredAt = isoNow(now);
  let event;
  if (deleted) {
    if (!previous) return { queued: false, unchanged: true, events: 0 };
    event = {
      schema_version: 1,
      event_id: eventId('document-delete', projectId, `${normalized}:${revision}`),
      kind: 'document.delete',
      project_id: projectId,
      occurred_at: occurredAt,
      payload: { logical_path: normalized, revision },
    };
    nextState.files[normalized] = { ...previous, revision, deleted: true };
  } else {
    const absolute = join(vaultBase, normalized);
    if (!existsSync(absolute)) return { queued: false, missing: true, events: 0 };
    const content = readFileSync(absolute, 'utf8');
    const metadata = parseFrontmatter(content);
    const contentHash = hash(sanitizeObserverContent(content));
    if (previous?.content_hash === contentHash && previous?.deleted !== true) {
      return { queued: false, unchanged: true, events: 0 };
    }
    event = documentEvent({ projectId, logicalPath: normalized, content, metadata, revision, occurredAt });
    nextState.files[normalized] = { content_hash: contentHash, revision };
  }
  const queued = enqueueObserverSqlBatch(vaultBase, {
    schema_version: SQL_SCHEMA_VERSION,
    project_id: projectId,
    events: [event],
  }, { scope: `document:${normalized}`, now });
  atomicJson(statePath(vaultBase), nextState);
  return { ...queued, event_id: event.event_id, deleted };
}

export function listSqlOutbox(vaultBase) {
  const dir = outboxDir(vaultBase);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^sql-(?:live-)?[a-f0-9]{24}\.json$/.test(name)).sort().flatMap((name) => {
    try { return [{ path: join(dir, name), ...JSON.parse(readFileSync(join(dir, name), 'utf8')) }]; } catch { return []; }
  });
}

export function inspectObserverSqlOutbox(vaultBase, currentTime = Date.now()) {
  const batches = listSqlOutbox(vaultBase);
  let bytes = 0;
  let oldestAt = '';
  let events = 0;
  for (const batch of batches) {
    try { bytes += statSync(batch.path).size; } catch { /* raced with a drain */ }
    events += Array.isArray(batch.events) ? batch.events.length : 0;
    const candidate = text(batch.enqueued_at || batch.updated_at);
    if (candidate && (!oldestAt || candidate < oldestAt)) oldestAt = candidate;
  }
  const oldestAgeMs = oldestAt ? Math.max(0, Number(currentTime) - Date.parse(oldestAt)) : 0;
  return { batches: batches.length, events, bytes, oldest_at: oldestAt, oldest_age_ms: oldestAgeMs };
}

function leasePath(vaultBase) { return join(vaultBase, SQL_PUBLISHER_LEASE_REL); }

function acquirePublisherLease(vaultBase, currentTime = Date.now()) {
  const path = leasePath(vaultBase);
  mkdirSync(join(path, '..'), { recursive: true });
  const token = `${process.pid}-${currentTime}-${Math.random().toString(16).slice(2)}`;
  try {
    mkdirSync(path);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let age = 0;
    try { age = currentTime - statSync(path).mtimeMs; } catch { return null; }
    if (age <= SQL_LEASE_STALE_MS) return null;
    const stale = `${path}.stale-${token}`;
    try {
      renameSync(path, stale);
      rmSync(stale, { recursive: true, force: true });
      mkdirSync(path);
    } catch { return null; }
  }
  atomicJson(join(path, 'owner.json'), { token, pid: process.pid, acquired_at: new Date(currentTime).toISOString() });
  return { path, token };
}

function releasePublisherLease(lease) {
  if (!lease) return;
  const owner = readJson(join(lease.path, 'owner.json'), {});
  if (owner.token === lease.token) rmSync(lease.path, { recursive: true, force: true });
}

async function postSqlChunk({ url, projectId, events, fetchImpl = globalThis.fetch, token = '' }) {
  const controller = new AbortController();
  const rawBody = Buffer.from(JSON.stringify({ events }), 'utf8');
  const timer = setTimeout(() => controller.abort(), observerSqlRequestTimeoutMs(rawBody.byteLength));
  const wireBody = gzipSync(rawBody);
  try {
    const response = await fetchImpl(`${String(url).replace(/\/$/, '')}/v1/projects/${encodeURIComponent(projectId)}/ingest`, {
      method: 'POST',
      headers: observerAuthHeaders(token, { 'content-type': 'application/json', 'content-encoding': 'gzip', accept: 'application/json' }),
      body: wireBody,
      signal: controller.signal,
    });
    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok || responseBody.conflicts > 0 || responseBody.rejected > 0) throw new Error(`Observer ingest respondeu HTTP ${response.status}.`);
    return responseBody;
  } finally { clearTimeout(timer); }
}

async function readRemoteDocuments({ url, projectId, fetchImpl = globalThis.fetch, token = '' }) {
  if (!url) return {};
  try {
    const response = await fetchImpl(`${String(url).replace(/\/$/, '')}/v1/projects/${encodeURIComponent(projectId)}/memory/tree`, {
      headers: observerAuthHeaders(token, { accept: 'application/json' }),
    });
    if (!response.ok) return {};
    const body = await response.json().catch(() => ({}));
    return Object.fromEntries((body.documents || []).map((item) => [item.logical_path, item]));
  } catch {
    return {};
  }
}

async function postSqlBatch({ url, projectId, events, fetchImpl = globalThis.fetch, token = '' }) {
  const aggregate = { accepted: 0, rejected: 0, conflicts: 0, stale: 0, duplicates: 0 };
  let chunk = [];
  let chunkBytes = 0;
  const send = async (items) => {
    if (!items.length) return;
    const response = await postSqlChunk({
      url,
      projectId,
      events: items,
      fetchImpl,
      token,
    });
    for (const key of Object.keys(aggregate)) aggregate[key] += Number(response?.[key]) || 0;
  };
  for (const event of events) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    const exceedsCount = chunk.length >= SQL_EVENT_BATCH_SIZE;
    const exceedsBytes = chunk.length > 0 && chunkBytes + eventBytes > SQL_EVENT_BATCH_BYTES;
    if (exceedsCount || exceedsBytes) {
      await send(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(event);
    chunkBytes += eventBytes;
  }
  await send(chunk);
  return aggregate;
}

export async function retryObserverSqlOutbox({ vaultBase, projectId, url, fetchImpl = globalThis.fetch, token = process.env.WENDKEEP_OBSERVER_TOKEN || '' } = {}) {
  const pending = listSqlOutbox(vaultBase);
  if (!url) return { attempted: 0, confirmed: 0, pending: pending.length };
  const lease = acquirePublisherLease(vaultBase);
  if (!lease) return { attempted: 0, confirmed: 0, pending: pending.length, busy: true };
  let attempted = 0;
  let confirmed = 0;
  try {
    for (const batch of pending) {
      if (batch.project_id && batch.project_id !== projectId) continue;
      const batchLease = acquireBatchFileLease(batch.path);
      if (!batchLease) continue;
      attempted += 1;
      try {
        const current = readJson(batch.path, null);
        if (!current?.events?.length) continue;
        await postSqlBatch({ url, projectId, events: current.events, fetchImpl, token });
        if (existsSync(batch.path)) unlinkSync(batch.path);
        confirmed += 1;
      } catch { break; }
      finally { releaseBatchFileLease(batchLease); }
    }
    return { attempted, confirmed, pending: listSqlOutbox(vaultBase).length, busy: false };
  } finally {
    releasePublisherLease(lease);
  }
}

/** Hook path: enqueue at most one touched session/subagent, then drain under one lease. */
export async function publishObserverSqlIncremental({
  vaultBase,
  projectId,
  url = process.env.WENDKEEP_OBSERVER_URL || '',
  input = {},
  now = new Date(),
  fetchImpl = globalThis.fetch,
  token = process.env.WENDKEEP_OBSERVER_TOKEN || '',
  captureLevel = process.env.WENDKEEP_OBSERVER_CAPTURE_LEVEL || 'metadata',
} = {}) {
  if (!vaultBase || !projectId) throw new Error('vaultBase e projectId são obrigatórios.');
  const state = readState(vaultBase);
  const batch = buildObserverSqlIncrementalBatch({
    vaultBase, projectId, input, now, state, captureLevel,
  });
  const queued = enqueueObserverSqlBatch(vaultBase, {
    schema_version: SQL_SCHEMA_VERSION,
    project_id: projectId,
    events: batch.events,
  }, { scope: batch.scope, now });
  if (batch.events.length) atomicJson(statePath(vaultBase), batch.nextState);
  const replay = await retryObserverSqlOutbox({ vaultBase, projectId, url, fetchImpl, token });
  const pending = listSqlOutbox(vaultBase).length;
  return {
    ok: pending === 0,
    queued: pending > 0,
    scanned: batch.scanned,
    changed: batch.changed,
    enqueued_events: queued.events || 0,
    pending,
    replay,
    hookExitCode: 0,
  };
}

export async function publishObserverSql({ vaultBase, projectId, url = process.env.WENDKEEP_OBSERVER_URL || '', input = {}, now = new Date(), fetchImpl = globalThis.fetch, token = process.env.WENDKEEP_OBSERVER_TOKEN || '', captureLevel = process.env.WENDKEEP_OBSERVER_CAPTURE_LEVEL || 'metadata', forceFull = false } = {}) {
  if (!vaultBase || !projectId) throw new Error('vaultBase e projectId são obrigatórios.');
  const replay = await retryObserverSqlOutbox({ vaultBase, projectId, url, fetchImpl, token });
  const state = readState(vaultBase);
  const remoteDocuments = forceFull || Object.keys(state.files || {}).length === 0
    ? await readRemoteDocuments({ url, projectId, fetchImpl, token })
    : {};
  const batch = buildObserverSqlEventBatch({ vaultBase, projectId, input, now, state, remoteDocuments, captureLevel, forceFull });
  if (!batch.events.length) {
    atomicJson(statePath(vaultBase), batch.nextState);
    return { ok: true, queued: false, scanned: batch.scanned, changed: batch.changed, pending: listSqlOutbox(vaultBase).length, replay };
  }
  if (!url) {
    queueOutbox(vaultBase, { schema_version: SQL_SCHEMA_VERSION, project_id: projectId, events: batch.events });
    atomicJson(statePath(vaultBase), batch.nextState);
    return { ok: false, queued: true, scanned: batch.scanned, changed: batch.changed, pending: listSqlOutbox(vaultBase).length, replay, hookExitCode: 0 };
  }
  try {
    const response = await postSqlBatch({ url, projectId, events: batch.events, fetchImpl, token });
    atomicJson(statePath(vaultBase), batch.nextState);
    return { ok: true, queued: false, scanned: batch.scanned, changed: batch.changed, pending: listSqlOutbox(vaultBase).length, replay, response };
  } catch (error) {
    queueOutbox(vaultBase, { schema_version: SQL_SCHEMA_VERSION, project_id: projectId, events: batch.events });
    atomicJson(statePath(vaultBase), batch.nextState);
    return { ok: false, queued: true, scanned: batch.scanned, changed: batch.changed, pending: listSqlOutbox(vaultBase).length, replay, hookExitCode: 0, error: error.message };
  }
}
