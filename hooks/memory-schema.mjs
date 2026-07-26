import { createHash } from 'node:crypto';

export const SHARED_LIMITS = Object.freeze({ lines: 48, bytes: 6144, lineChars: 320 });

export const SHARED_SECTIONS = Object.freeze([
  'Objetivo Atual',
  'Estado Entregue',
  'Restrições Ativas',
  'Decisões em Vigor',
  'Próximas Ações',
  'Bloqueios',
  'Riscos Conhecidos',
  'Último Handoff',
]);

const AUTHORITIES = new Set(['verified', 'reported', 'candidate']);
const OPERATIONS = new Set(['assert', 'replace', 'add', 'remove']);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const HARNESS_BLOCK = /<(recommended_plugins|environment_context|apps_instructions|plugins_instructions|skills_instructions)\b[^>]*>[\s\S]*?<\/\1>/gi;
const WINDOWS_LOCAL_PATH = /\b[A-Z]:\\(?:Users|Documents and Settings)\\[^\r\n"'<>|]*/gi;
const UNIX_TRANSCRIPT_PATH = /\/(?:home|Users|private|var|tmp)\/[^\r\n"'<>]*(?:rollout|transcript|sessions?)[^\r\n"'<>]*/gi;
const EMAIL = /\b[\w.%+-]+@(?!(?:[\w.-]+\.)?example\.(?:com|org|net)\b)[\w.-]+\.[A-Za-z]{2,}\b/gi;

function stringValue(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * Pure, idempotent boundary sanitizer used before event persistence and again before
 * projection/injection. It deliberately preserves example.com addresses for docs/tests.
 */
export function sanitizeMemoryText(value) {
  return stringValue(value)
    .replace(HARNESS_BLOCK, '')
    .replace(/<recommended_plugins\b[^>]*>[\s\S]*?<\/recommended_plugins>/gi, '')
    .replace(/\b(PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|ACCESS_KEY)\s*=\s*[^\s,;]+/gi, '$1=[REDACTED_SECRET]')
    .replace(/(["']?(?:password|passwd|token|secret|api[_-]?key|access[_-]?key)["']?\s*:\s*["'])[^"'\r\n]+(["'])/gi, '$1[REDACTED_SECRET]$2')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, '[REDACTED_SECRET]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_SECRET]')
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/g, '[REDACTED_SECRET]')
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_SECRET]')
    .replace(/\bwhsec_[A-Za-z0-9]{20,}\b/g, '[REDACTED_SECRET]')
    .replace(WINDOWS_LOCAL_PATH, '[REDACTED_LOCAL_PATH]')
    .replace(UNIX_TRANSCRIPT_PATH, '[REDACTED_LOCAL_PATH]')
    .replace(/\btranscript(?:_path)?\s*[=:]\s*[^\s,;]+/gi, 'transcript_path=[REDACTED_LOCAL_PATH]')
    .replace(EMAIL, '[REDACTED_EMAIL]');
}

export function eventBelongsToVault(event, projectId) {
  return typeof event?.project_id === 'string'
    && event.project_id.length > 0
    && typeof projectId === 'string'
    && projectId.length > 0
    && event.project_id === projectId;
}

function requiredString(event, field, errors) {
  if (typeof event[field] !== 'string' || !event[field].trim()) errors.push(`${field} deve ser string não vazia.`);
}

function sanitizedField(event, field, errors) {
  if (!(field in event)) return;
  const raw = stringValue(event[field]);
  if (sanitizeMemoryText(raw) !== raw) errors.push(`${field} contém segredo, PII, path local ou payload de harness não sanitizado.`);
}

/** Validate one immutable ledger/outbox event without reading or writing the vault. */
export function validateMemoryEvent(event, { projectId } = {}) {
  const errors = [];
  const warnings = [];
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, errors: ['Evento deve ser um objeto.'], warnings };
  }

  if (event.v !== 1) errors.push('v deve ser 1.');
  requiredString(event, 'event_id', errors);
  requiredString(event, 'memory_key', errors);
  requiredString(event, 'operation', errors);
  requiredString(event, 'authority', errors);
  requiredString(event, 'activation_id', errors);
  requiredString(event, 'observed_at', errors);

  if (event.operation && !OPERATIONS.has(event.operation)) {
    errors.push(`operation inválida: ${event.operation}.`);
  }
  if (event.operation !== 'remove' && !Object.hasOwn(event, 'value')) {
    errors.push('value é obrigatório para operation diferente de remove.');
  }
  if (event.authority && !AUTHORITIES.has(event.authority)) {
    errors.push(`authority inválida: ${event.authority}.`);
  }
  if (!Number.isInteger(event.turn_sequence) || event.turn_sequence < 0) {
    errors.push('turn_sequence deve ser inteiro não negativo.');
  }
  if (typeof event.observed_at === 'string'
      && (!ISO_INSTANT.test(event.observed_at) || Number.isNaN(Date.parse(event.observed_at)))) {
    errors.push('observed_at deve ser um instante ISO-8601 UTC.');
  }
  if (!Array.isArray(event.evidence) || event.evidence.some((item) => typeof item !== 'string')) {
    errors.push('evidence deve ser um array de strings.');
  }
  if (event.project_id !== undefined && (typeof event.project_id !== 'string' || !event.project_id)) {
    errors.push('project_id, quando presente, deve ser string não vazia.');
  }
  if (projectId !== undefined && !eventBelongsToVault(event, projectId)) {
    errors.push(`project_id não pertence ao vault esperado (${projectId}).`);
  }

  for (const field of ['value', 'evidence']) sanitizedField(event, field, errors);
  return { ok: errors.length === 0, errors, warnings };
}

function sectionFor(memoryKey) {
  const key = String(memoryKey || '').toLowerCase();
  if (/^(objective|goal)\b/.test(key)) return 'Objetivo Atual';
  if (/^(constraint|restriction)\b/.test(key)) return 'Restrições Ativas';
  if (/^(decision|adr)\b/.test(key)) return 'Decisões em Vigor';
  if (/^(next|action)\b/.test(key)) return 'Próximas Ações';
  if (/^(block|blocker)\b/.test(key)) return 'Bloqueios';
  if (/^risk\b/.test(key)) return 'Riscos Conhecidos';
  if (/^handoff\b/.test(key)) return 'Último Handoff';
  return 'Estado Entregue';
}

function hashProjection(events) {
  if (!events.length) {
    // Must match memory-store.reduceMemoryEvents([]): an empty operational state is still
    // represented by the reducer's canonical {state,tombstones} envelope, not by raw [].
    return createHash('sha256').update(JSON.stringify({ state: {}, tombstones: {} })).digest('hex');
  }
  const canonical = events.map((event) => ({
    event_id: event.event_id,
    memory_key: event.memory_key,
    operation: event.operation,
    value: sanitizeMemoryText(event.value),
    authority: event.authority,
    observed_at: event.observed_at,
    evidence: Array.isArray(event.evidence) ? event.evidence.map(sanitizeMemoryText) : [],
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function eventLine(event) {
  const value = event.operation === 'remove' ? '[removido]' : sanitizeMemoryText(event.value);
  const evidence = Array.isArray(event.evidence) && event.evidence.length
    ? event.evidence.map(sanitizeMemoryText).join(', ')
    : 'none';
  const source = sanitizeMemoryText(event.source_turn_id || event.canonical_session_id || event.activation_id || 'unknown');
  const line = `- [${sanitizeMemoryText(event.event_id)}] ${value} · authority:${sanitizeMemoryText(event.authority)} · source:${source} · as_of:${sanitizeMemoryText(event.observed_at)} · evidence:${evidence}`;
  return line.length <= SHARED_LIMITS.lineChars
    ? line
    : `${line.slice(0, SHARED_LIMITS.lineChars - 1).trimEnd()}…`;
}

function defaultInstant(events) {
  const instants = events
    .map((event) => event.observed_at)
    .filter((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
    .sort();
  return instants.at(-1) || new Date(0).toISOString();
}

/** Render the generated operational projection. Inputs are sanitized a second time. */
export function renderSharedMemory({
  revision = 0,
  eventCursor = 'none',
  events = [],
  stateHash,
  updatedAt,
  reviewAfter,
} = {}) {
  const safeEvents = Array.isArray(events) ? events : [];
  const updated = updatedAt || defaultInstant(safeEvents);
  const review = reviewAfter || new Date(Date.parse(updated) + (7 * 24 * 60 * 60 * 1000)).toISOString();
  const grouped = new Map(SHARED_SECTIONS.map((section) => [section, []]));
  for (const event of safeEvents) grouped.get(sectionFor(event.memory_key)).push(eventLine(event));

  const lines = [
    '---',
    'schema_version: 2',
    `revision: ${Number.isInteger(revision) ? revision : 0}`,
    `event_cursor: ${sanitizeMemoryText(eventCursor || 'none')}`,
    `state_hash: ${sanitizeMemoryText(stateHash || hashProjection(safeEvents))}`,
    `updated_at: ${sanitizeMemoryText(updated)}`,
    `review_after: ${sanitizeMemoryText(review)}`,
    '---',
    '',
    '# SHARED_MEMORY — projeção operacional gerada',
    '',
  ];
  for (const section of SHARED_SECTIONS) {
    lines.push(`## ${section}`, ...(grouped.get(section).length ? grouped.get(section) : ['- (vazio)']), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function parseScalar(value) {
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

/** Parse SHARED without throwing so hooks can surface a valid degraded context. */
export function parseSharedMemory(content) {
  const text = String(content ?? '').replace(/\r\n/g, '\n');
  const errors = [];
  const metadata = {};
  const sections = new Map();
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return { ok: false, errors: ['Frontmatter de SHARED ausente ou inválido.'], metadata, sections };
  }
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      errors.push(`Linha inválida no frontmatter: ${line}`);
      continue;
    }
    const key = line.slice(0, separator).trim();
    metadata[key] = parseScalar(line.slice(separator + 1).trim());
  }

  let current = null;
  const seenOrder = [];
  for (const line of text.slice(match[0].length).split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1];
      if (sections.has(current)) errors.push(`Seção duplicada: ## ${current}`);
      else {
        sections.set(current, []);
        seenOrder.push(current);
      }
    } else if (current && line.trim()) {
      sections.get(current).push(line);
    }
  }
  if (seenOrder.length !== SHARED_SECTIONS.length
      || seenOrder.some((section, index) => section !== SHARED_SECTIONS[index])) {
    errors.push(`Seções fixas ausentes, extras ou fora de ordem: esperado ${SHARED_SECTIONS.join(' | ')}.`);
  }
  return { ok: errors.length === 0, errors, metadata, sections };
}

function actualLineCount(text) {
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

export function validateSharedMemory(content, { eventIds } = {}) {
  const text = String(content ?? '').replace(/\r\n/g, '\n');
  const parsed = parseSharedMemory(text);
  const errors = [...parsed.errors];
  const warnings = [];
  const lineCount = actualLineCount(text);
  const bytes = Buffer.byteLength(text, 'utf8');

  if (lineCount > SHARED_LIMITS.lines) errors.push(`SHARED tem ${lineCount} linhas; limite ${SHARED_LIMITS.lines}.`);
  if (bytes > SHARED_LIMITS.bytes) errors.push(`SHARED tem ${bytes} bytes; limite ${SHARED_LIMITS.bytes}.`);
  text.split('\n').forEach((line, index) => {
    if (line.length > SHARED_LIMITS.lineChars) {
      errors.push(`Linha ${index + 1} tem ${line.length} caracteres; limite ${SHARED_LIMITS.lineChars}.`);
    }
  });
  if (sanitizeMemoryText(text) !== text) errors.push('SHARED contém segredo, PII, path local ou payload de harness não sanitizado.');

  const { metadata } = parsed;
  if (metadata.schema_version !== 2) errors.push('schema_version deve ser 2.');
  if (!Number.isInteger(metadata.revision) || metadata.revision < 0) errors.push('revision deve ser inteiro não negativo.');
  for (const key of ['event_cursor', 'state_hash', 'updated_at', 'review_after']) {
    if (typeof metadata[key] !== 'string' || !metadata[key]) errors.push(`${key} é obrigatório.`);
  }
  for (const key of ['updated_at', 'review_after']) {
    if (typeof metadata[key] === 'string'
        && (!ISO_INSTANT.test(metadata[key]) || Number.isNaN(Date.parse(metadata[key])))) {
      errors.push(`${key} deve ser um instante ISO-8601 UTC.`);
    }
  }
  if (eventIds instanceof Set) {
    const cursor = metadata.event_cursor;
    if (cursor !== 'none' && !eventIds.has(cursor)) errors.push(`event_cursor "${cursor}" não existe no ledger.`);
    if (cursor === 'none' && eventIds.size > 0) errors.push('event_cursor none diverge de um ledger não vazio.');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    lineCount,
    bytes,
    metadata,
    sections: parsed.sections,
  };
}

/**
 * Classify SHARED from its own bytes without accepting malformed v2 as legacy.
 * Empty v2 sidecar files are intentionally not part of this pure classification;
 * vault-level operational evidence is handled by memory-mode.mjs.
 */
export function classifySharedMemory(content) {
  const text = String(content ?? '').replace(/\r\n/g, '\n');
  if (validateSharedMemory(text).ok) return { mode: 'v2', reason: 'valid-v2' };
  const hasV2Signature = /^(?:schema_version|event_cursor|state_hash)\s*:/m.test(text)
    || /^# SHARED_MEMORY\s+[—-]\s+proje[cç][aã]o operacional gerada\s*$/mi.test(text);
  return hasV2Signature
    ? { mode: 'v2', reason: 'v2-signature' }
    : { mode: 'legacy', reason: text.trim() ? 'legacy-shared' : 'shared-absent' };
}
