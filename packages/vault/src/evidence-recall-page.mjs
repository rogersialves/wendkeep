import { createHash } from 'node:crypto';
import { normalizeRecallText, recallEvidence } from './evidence-recall.mjs';

export const EVIDENCE_RECALL_CURSOR_VERSION = 1;
export const EVIDENCE_RECALL_DEFAULT_LIMIT = 5;
export const EVIDENCE_RECALL_MAX_LIMIT = 100;
export const EVIDENCE_RECALL_DEFAULT_MAX_BYTES = 64 * 1024;
export const EVIDENCE_RECALL_MAX_BYTES = 16 * 1024 * 1024;

const CURSOR_MAX_CHARS = 8 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const EXACT_FILTER_FIELDS = [
  'authority',
  'validity',
  'entity_type',
  'project_id',
  'change_slug',
  'session_id',
  'work_session_id',
  'logical_path',
];
const FILTER_FIELDS = new Set([...EXACT_FILTER_FIELDS, 'logical_path_prefix']);

export class EvidenceRecallCursorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EvidenceRecallCursorError';
    this.code = 'EVIDENCE_RECALL_CURSOR_INVALID';
  }
}

export class EvidenceRecallBudgetError extends Error {
  constructor(message, { requiredBytes = null, maxBytes = null } = {}) {
    super(message);
    this.name = 'EvidenceRecallBudgetError';
    this.code = 'EVIDENCE_RECALL_BUDGET_TOO_SMALL';
    this.required_bytes = requiredBytes;
    this.max_bytes = maxBytes;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = canonicalize(value[key]);
  }
  return out;
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function compareText(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function normalizeStringSet(value, field) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : [value];
  const normalized = [];
  for (const item of values) {
    if (typeof item !== 'string') {
      throw new TypeError(`evidence recall filter ${field} must be a string or string array`);
    }
    const text = item.trim();
    if (text) normalized.push(text);
  }
  return [...new Set(normalized)].sort(compareText);
}

export function normalizeEvidenceRecallFilters(filters = {}) {
  if (filters === undefined || filters === null) return {};
  if (typeof filters !== 'object' || Array.isArray(filters)) {
    throw new TypeError('evidence recall filters must be an object');
  }
  for (const field of Object.keys(filters)) {
    if (!FILTER_FIELDS.has(field)) {
      throw new TypeError(`unsupported evidence recall filter: ${field}`);
    }
  }
  const normalized = {};
  for (const field of EXACT_FILTER_FIELDS) {
    const values = normalizeStringSet(filters[field], field);
    if (values.length) normalized[field] = values;
  }
  if (normalized.logical_path) {
    normalized.logical_path = [...new Set(normalized.logical_path
      .map((path) => path.replaceAll('\\', '/')))].sort(compareText);
  }
  const prefixes = [...new Set(
    normalizeStringSet(filters.logical_path_prefix, 'logical_path_prefix')
      .map((prefix) => prefix.replaceAll('\\', '/')),
  )].sort(compareText);
  if (prefixes.length) normalized.logical_path_prefix = prefixes;
  return normalized;
}

export function filterEvidenceRecallRows(rows, filters = {}) {
  const normalized = normalizeEvidenceRecallFilters(filters);
  const docs = Array.isArray(rows) ? rows : [];
  return docs.filter((row) => {
    for (const field of EXACT_FILTER_FIELDS) {
      const expected = normalized[field];
      if (expected?.length && !expected.includes(String(row?.[field] ?? ''))) return false;
    }
    const prefixes = normalized.logical_path_prefix;
    if (prefixes?.length) {
      const path = String(row?.logical_path ?? '').replaceAll('\\', '/');
      if (!prefixes.some((prefix) => path.startsWith(prefix))) return false;
    }
    return true;
  });
}

function indexDescriptor(row) {
  return {
    index_version: row?.index_version ?? null,
    project_id: String(row?.project_id ?? ''),
    logical_path: String(row?.logical_path ?? ''),
    title: String(row?.title ?? ''),
    heading: String(row?.heading ?? ''),
    change_slug: String(row?.change_slug ?? ''),
    session_id: String(row?.session_id ?? ''),
    work_session_id: String(row?.work_session_id ?? ''),
    observed_at: String(row?.observed_at ?? ''),
    chunk_id: String(row?.chunk_id ?? ''),
    entity_type: String(row?.entity_type ?? ''),
    authority: String(row?.authority ?? ''),
    validity: String(row?.validity ?? ''),
    ordinal: Number(row?.ordinal ?? 0),
    content_hash: String(row?.content_hash ?? ''),
  };
}

function canonicalRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({ row, descriptor: stableJson(indexDescriptor(row)) }))
    .sort((left, right) => compareText(left.row?.logical_path, right.row?.logical_path)
      || Number(left.row?.ordinal ?? 0) - Number(right.row?.ordinal ?? 0)
      || compareText(left.row?.chunk_id, right.row?.chunk_id)
      || compareText(left.row?.content_hash, right.row?.content_hash)
      || compareText(left.descriptor, right.descriptor))
    .map(({ row }) => row);
}

function evidenceIndexHash(rows) {
  return sha256(canonicalRows(rows).map((row) => stableJson(indexDescriptor(row))).join('\n'));
}

function evidenceRequestHash(query, filters) {
  return sha256(stableJson({
    query: normalizeRecallText(query),
    filters,
  }));
}

function invalidCursor(message) {
  throw new EvidenceRecallCursorError(message);
}

function validateCursorPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    invalidCursor('evidence recall cursor payload must be an object');
  }
  const keys = Object.keys(payload).sort();
  const expectedKeys = ['as_of', 'index_hash', 'offset', 'request_hash', 'version'];
  if (stableJson(keys) !== stableJson(expectedKeys)) {
    invalidCursor('evidence recall cursor payload has unexpected fields');
  }
  if (payload.version !== EVIDENCE_RECALL_CURSOR_VERSION) {
    invalidCursor('evidence recall cursor version is unsupported');
  }
  if (!HASH_PATTERN.test(String(payload.index_hash || ''))
      || !HASH_PATTERN.test(String(payload.request_hash || ''))) {
    invalidCursor('evidence recall cursor hashes are invalid');
  }
  if (!Number.isSafeInteger(payload.offset) || payload.offset < 0) {
    invalidCursor('evidence recall cursor offset is invalid');
  }
  if (!Number.isSafeInteger(payload.as_of) || Number.isNaN(new Date(payload.as_of).getTime())) {
    invalidCursor('evidence recall cursor as_of is invalid');
  }
  return payload;
}

function encodeCursor(payload) {
  const envelope = {
    payload,
    checksum: sha256(stableJson(payload)),
  };
  return Buffer.from(stableJson(envelope), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > CURSOR_MAX_CHARS
      || !BASE64URL_PATTERN.test(cursor)) {
    invalidCursor('evidence recall cursor encoding is invalid');
  }
  let decoded = '';
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) invalidCursor('evidence recall cursor encoding is not canonical');
    decoded = bytes.toString('utf8');
  } catch (error) {
    if (error instanceof EvidenceRecallCursorError) throw error;
    invalidCursor('evidence recall cursor encoding is invalid');
  }
  let envelope = null;
  try {
    envelope = JSON.parse(decoded);
  } catch {
    invalidCursor('evidence recall cursor JSON is invalid');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || stableJson(Object.keys(envelope).sort()) !== stableJson(['checksum', 'payload'])) {
    invalidCursor('evidence recall cursor envelope is invalid');
  }
  const payload = validateCursorPayload(envelope.payload);
  if (!HASH_PATTERN.test(String(envelope.checksum || ''))
      || envelope.checksum !== sha256(stableJson(payload))) {
    invalidCursor('evidence recall cursor checksum is invalid');
  }
  return payload;
}

function normalizeLimit(value) {
  const limit = Number(value ?? EVIDENCE_RECALL_DEFAULT_LIMIT);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVIDENCE_RECALL_MAX_LIMIT) {
    throw new RangeError(`evidence recall limit must be an integer between 1 and ${EVIDENCE_RECALL_MAX_LIMIT}`);
  }
  return limit;
}

function normalizeMaxBytes(value) {
  const maxBytes = Number(value ?? EVIDENCE_RECALL_DEFAULT_MAX_BYTES);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > EVIDENCE_RECALL_MAX_BYTES) {
    throw new RangeError(`evidence recall maxBytes must be an integer between 2 and ${EVIDENCE_RECALL_MAX_BYTES}`);
  }
  return maxBytes;
}

function normalizeNow(value) {
  const now = Number(value ?? Date.now());
  if (!Number.isSafeInteger(now) || Number.isNaN(new Date(now).getTime())) {
    throw new RangeError('evidence recall now must be a valid integer timestamp');
  }
  return now;
}

function compactResult(row) {
  const { content, ...rest } = row || {};
  return {
    ...rest,
    excerpt: String(rest.excerpt ?? ''),
    content_bytes: Buffer.byteLength(String(content ?? ''), 'utf8'),
    content_omitted: Object.prototype.hasOwnProperty.call(row || {}, 'content'),
  };
}

function serializedBytes(results) {
  return Buffer.byteLength(JSON.stringify(results), 'utf8');
}

function withTruncatedExcerpt(candidate, existing, maxBytes) {
  const characters = Array.from(String(candidate.excerpt ?? ''));
  if (!characters.length) return null;
  const makeCandidate = (count) => ({
    ...candidate,
    excerpt: count > 0 ? `${characters.slice(0, count).join('')}…` : '',
    excerpt_truncated: true,
  });
  const minimum = makeCandidate(0);
  if (serializedBytes([...existing, minimum]) > maxBytes) return null;
  let low = 0;
  let high = characters.length - 1;
  let best = minimum;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const current = makeCandidate(middle);
    if (serializedBytes([...existing, current]) <= maxBytes) {
      best = current;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

export function recallEvidencePage(rows, query, {
  cursor = null,
  filters = {},
  limit: requestedLimit,
  topK,
  maxBytes: requestedMaxBytes,
  now,
} = {}) {
  const limit = normalizeLimit(requestedLimit ?? topK);
  const maxBytes = normalizeMaxBytes(requestedMaxBytes);
  const normalizedFilters = normalizeEvidenceRecallFilters(filters);
  const docs = canonicalRows(rows);
  const indexHash = evidenceIndexHash(docs);
  const requestHash = evidenceRequestHash(query, normalizedFilters);
  const cursorPayload = cursor ? decodeCursor(cursor) : null;
  if (cursorPayload?.index_hash !== undefined && cursorPayload.index_hash !== indexHash) {
    invalidCursor('evidence recall cursor does not match the current index');
  }
  if (cursorPayload?.request_hash !== undefined && cursorPayload.request_hash !== requestHash) {
    invalidCursor('evidence recall cursor does not match the current query and filters');
  }
  const asOf = cursorPayload ? cursorPayload.as_of : normalizeNow(now);
  const offset = cursorPayload?.offset ?? 0;
  const scoped = filterEvidenceRecallRows(docs, normalizedFilters);
  const ranked = recallEvidence(scoped, query, {
    topK: Math.max(1, scoped.length),
    now: asOf,
  });
  if (offset > ranked.length) {
    invalidCursor('evidence recall cursor offset exceeds the result set');
  }

  const results = [];
  let position = offset;
  while (position < ranked.length && results.length < limit) {
    const candidate = compactResult(ranked[position]);
    if (serializedBytes([...results, candidate]) <= maxBytes) {
      results.push(candidate);
      position += 1;
      continue;
    }
    const truncated = withTruncatedExcerpt(candidate, results, maxBytes);
    if (truncated) {
      results.push(truncated);
      position += 1;
      continue;
    }
    if (!results.length) {
      const requiredBytes = serializedBytes([{
        ...candidate,
        excerpt: '',
        excerpt_truncated: true,
      }]);
      throw new EvidenceRecallBudgetError(
        'evidence recall byte budget cannot fit the next result metadata',
        { requiredBytes, maxBytes },
      );
    }
    break;
  }

  const hasMore = position < ranked.length;
  const nextCursor = hasMore ? encodeCursor({
    version: EVIDENCE_RECALL_CURSOR_VERSION,
    index_hash: indexHash,
    request_hash: requestHash,
    offset: position,
    as_of: asOf,
  }) : null;
  return {
    results,
    next_cursor: nextCursor,
    has_more: hasMore,
    matched_count: ranked.length,
    returned_count: results.length,
    returned_bytes: serializedBytes(results),
    offset,
    limit,
    max_bytes: maxBytes,
    as_of: new Date(asOf).toISOString(),
  };
}
