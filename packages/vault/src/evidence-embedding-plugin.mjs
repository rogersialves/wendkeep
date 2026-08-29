import { createHash } from 'node:crypto';

export const EVIDENCE_EMBEDDING_PROTOCOL_VERSION = 1;
export const EVIDENCE_EMBEDDING_DEFAULT_MAX_CANDIDATES = 128;
export const EVIDENCE_EMBEDDING_MAX_CANDIDATES = 512;
export const EVIDENCE_EMBEDDING_DEFAULT_MAX_INPUT_BYTES = 256 * 1024;
export const EVIDENCE_EMBEDDING_MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const EVIDENCE_EMBEDDING_MAX_DIMENSIONS = 65_536;

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9._-]{1,127}$/;
const MANIFEST_KEYS = [
  'dimensions',
  'integrity',
  'locality',
  'max_batch_size',
  'max_input_bytes',
  'model_fingerprint',
  'model_id',
  'model_revision',
  'network',
  'plugin_id',
  'plugin_version',
  'protocol_version',
  'retention',
  'schema_version',
  'transport',
];
const RESPONSE_KEYS = [
  'document_vectors',
  'model_fingerprint',
  'query_vector',
  'schema_version',
];

export class EvidenceEmbeddingPluginError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'EvidenceEmbeddingPluginError';
    this.code = 'EVIDENCE_EMBEDDING_PLUGIN_INVALID';
    this.errors = [...errors];
  }
}

export class EvidenceEmbeddingBudgetError extends Error {
  constructor(message, { requiredBytes = null, maxBytes = null } = {}) {
    super(message);
    this.name = 'EvidenceEmbeddingBudgetError';
    this.code = 'EVIDENCE_EMBEDDING_BUDGET_EXCEEDED';
    this.required_bytes = requiredBytes;
    this.max_bytes = maxBytes;
  }
}

export class EvidenceEmbeddingResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EvidenceEmbeddingResponseError';
    this.code = 'EVIDENCE_EMBEDDING_RESPONSE_INVALID';
  }
}

export class EvidenceEmbeddingExecutionError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'EvidenceEmbeddingExecutionError';
    this.code = 'EVIDENCE_EMBEDDING_EXECUTION_FAILED';
    this.cause = cause;
  }
}

function compareText(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort(compareText)
    .filter((key) => value[key] !== undefined)
    .map((key) => [key, canonicalize(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function manifestPayload(manifest = {}) {
  return {
    schema_version: manifest.schema_version,
    protocol_version: manifest.protocol_version,
    plugin_id: manifest.plugin_id,
    plugin_version: manifest.plugin_version,
    model_id: manifest.model_id,
    model_revision: manifest.model_revision,
    model_fingerprint: manifest.model_fingerprint,
    dimensions: manifest.dimensions,
    locality: manifest.locality,
    transport: manifest.transport,
    network: manifest.network,
    retention: manifest.retention,
    max_batch_size: manifest.max_batch_size,
    max_input_bytes: manifest.max_input_bytes,
  };
}

export function evidenceEmbeddingManifestIntegrity(manifest) {
  return sha256(stableJson(manifestPayload(manifest)));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function positiveInteger(value, field, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) return field;
  return '';
}

function versionText(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 64
    && /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(value);
}

export function verifyEvidenceEmbeddingPlugin(plugin) {
  const errors = [];
  const manifest = plugin?.manifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push('manifest');
    return { valid: false, errors, expected_integrity: '' };
  }
  const keys = Object.keys(manifest).sort(compareText);
  if (stableJson(keys) !== stableJson(MANIFEST_KEYS)) errors.push('manifest_fields');
  if (manifest.schema_version !== 1) errors.push('schema_version');
  if (manifest.protocol_version !== EVIDENCE_EMBEDDING_PROTOCOL_VERSION) errors.push('protocol_version');
  if (!IDENTIFIER.test(String(manifest.plugin_id || ''))) errors.push('plugin_id');
  if (!versionText(manifest.plugin_version)) errors.push('plugin_version');
  if (!IDENTIFIER.test(String(manifest.model_id || ''))) errors.push('model_id');
  if (!versionText(manifest.model_revision)) errors.push('model_revision');
  if (!SHA256.test(String(manifest.model_fingerprint || ''))) errors.push('model_fingerprint');
  const dimensionsError = positiveInteger(
    manifest.dimensions,
    'dimensions',
    EVIDENCE_EMBEDDING_MAX_DIMENSIONS,
  );
  if (dimensionsError) errors.push(dimensionsError);
  if (manifest.locality !== 'local') errors.push('locality');
  if (manifest.transport !== 'in-process') errors.push('transport');
  if (manifest.network !== 'forbidden') errors.push('network');
  if (manifest.retention !== 'none') errors.push('retention');
  const batchError = positiveInteger(
    manifest.max_batch_size,
    'max_batch_size',
    EVIDENCE_EMBEDDING_MAX_CANDIDATES,
  );
  if (batchError) errors.push(batchError);
  const bytesError = positiveInteger(
    manifest.max_input_bytes,
    'max_input_bytes',
    EVIDENCE_EMBEDDING_MAX_INPUT_BYTES,
  );
  if (bytesError) errors.push(bytesError);
  const expectedIntegrity = evidenceEmbeddingManifestIntegrity(manifest);
  if (!SHA256.test(String(manifest.integrity || ''))
      || manifest.integrity !== expectedIntegrity) errors.push('integrity');
  if (typeof plugin?.embed !== 'function') errors.push('embed');
  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    expected_integrity: expectedIntegrity,
  };
}

export function buildEvidenceEmbeddingManifest({
  plugin_id: pluginId,
  plugin_version: pluginVersion,
  model_id: modelId,
  model_revision: modelRevision,
  model_fingerprint: modelFingerprint,
  dimensions,
  locality = 'local',
  transport = 'in-process',
  network = 'forbidden',
  retention = 'none',
  max_batch_size: maxBatchSize = EVIDENCE_EMBEDDING_DEFAULT_MAX_CANDIDATES,
  max_input_bytes: maxInputBytes = EVIDENCE_EMBEDDING_DEFAULT_MAX_INPUT_BYTES,
} = {}) {
  const payload = {
    schema_version: 1,
    protocol_version: EVIDENCE_EMBEDDING_PROTOCOL_VERSION,
    plugin_id: pluginId,
    plugin_version: pluginVersion,
    model_id: modelId,
    model_revision: modelRevision,
    model_fingerprint: modelFingerprint,
    dimensions,
    locality,
    transport,
    network,
    retention,
    max_batch_size: maxBatchSize,
    max_input_bytes: maxInputBytes,
  };
  const manifest = deepFreeze({
    ...payload,
    integrity: evidenceEmbeddingManifestIntegrity(payload),
  });
  const validation = verifyEvidenceEmbeddingPlugin({ manifest, embed() {} });
  if (!validation.valid) {
    throw new EvidenceEmbeddingPluginError(
      `invalid evidence embedding manifest: ${validation.errors.join(', ')}`,
      validation.errors,
    );
  }
  return manifest;
}

export function createEvidenceEmbeddingPlugin({ manifest, embed } = {}) {
  const normalizedManifest = manifest?.integrity
    ? deepFreeze({ ...manifest })
    : buildEvidenceEmbeddingManifest(manifest || {});
  const plugin = Object.freeze({ manifest: normalizedManifest, embed });
  const validation = verifyEvidenceEmbeddingPlugin(plugin);
  if (!validation.valid) {
    throw new EvidenceEmbeddingPluginError(
      `invalid evidence embedding plugin: ${validation.errors.join(', ')}`,
      validation.errors,
    );
  }
  return plugin;
}

function normalizeInteger(value, fallback, { min = 1, max } = {}) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new RangeError(`embedding limit must be an integer between ${min} and ${max}`);
  }
  return number;
}

function candidateText(row) {
  return [row?.title, row?.heading, row?.content]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function requestPrefix(manifest, query) {
  return `{"schema_version":1,"model_fingerprint":${JSON.stringify(manifest.model_fingerprint)},"query":${JSON.stringify({ text: query })},"documents":[`;
}

function requestBytes(prefix, documentJson, footer = ']}') {
  const documents = documentJson.join(',');
  return Buffer.byteLength(`${prefix}${documents}${footer}`, 'utf8');
}

function selectDocuments(rows, query, manifest, { maxCandidates, maxInputBytes }) {
  const effectiveCandidates = Math.min(maxCandidates, manifest.max_batch_size);
  const effectiveBytes = Math.min(maxInputBytes, manifest.max_input_bytes);
  const prefix = requestPrefix(manifest, query);
  const baseBytes = requestBytes(prefix, []);
  if (baseBytes > effectiveBytes) {
    throw new EvidenceEmbeddingBudgetError(
      'embedding query exceeds the configured input byte budget',
      { requiredBytes: baseBytes, maxBytes: effectiveBytes },
    );
  }
  const documents = [];
  const documentJson = [];
  for (let index = 0; index < rows.length && documents.length < effectiveCandidates; index += 1) {
    const row = rows[index];
    const id = String(row?.chunk_id || '').trim();
    const text = candidateText(row);
    if (!id || !text) continue;
    const document = { id, text };
    const rendered = JSON.stringify(document);
    const nextBytes = requestBytes(prefix, [...documentJson, rendered]);
    if (nextBytes > effectiveBytes) break;
    documents.push({ id, text, row, original_index: index });
    documentJson.push(rendered);
  }
  if (rows.length && !documents.length) {
    const first = { id: String(rows[0]?.chunk_id || ''), text: candidateText(rows[0]) };
    throw new EvidenceEmbeddingBudgetError(
      'embedding byte budget cannot fit the first candidate',
      {
        requiredBytes: requestBytes(prefix, [JSON.stringify(first)]),
        maxBytes: effectiveBytes,
      },
    );
  }
  return {
    documents,
    inputBytes: requestBytes(prefix, documentJson),
    maxCandidates: effectiveCandidates,
    maxInputBytes: effectiveBytes,
  };
}

function validVector(vector, dimensions) {
  return Array.isArray(vector)
    && vector.length === dimensions
    && vector.every((value) => typeof value === 'number' && Number.isFinite(value));
}

function vectorNorm(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function cosine(left, right) {
  const leftNorm = vectorNorm(left);
  const rightNorm = vectorNorm(right);
  if (!leftNorm || !rightNorm) {
    throw new EvidenceEmbeddingResponseError('embedding vectors must have a non-zero norm');
  }
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index] * right[index];
  return dot / (leftNorm * rightNorm);
}

function validateResponse(response, manifest, documents) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new EvidenceEmbeddingResponseError('embedding response must be an object');
  }
  if (stableJson(Object.keys(response).sort(compareText)) !== stableJson(RESPONSE_KEYS)) {
    throw new EvidenceEmbeddingResponseError('embedding response contains unexpected fields');
  }
  if (response.schema_version !== 1) {
    throw new EvidenceEmbeddingResponseError('embedding response schema version is unsupported');
  }
  if (response.model_fingerprint !== manifest.model_fingerprint) {
    throw new EvidenceEmbeddingResponseError('embedding response model fingerprint diverges');
  }
  if (!validVector(response.query_vector, manifest.dimensions)) {
    throw new EvidenceEmbeddingResponseError('embedding query vector is invalid');
  }
  if (!Array.isArray(response.document_vectors)
      || response.document_vectors.length !== documents.length) {
    throw new EvidenceEmbeddingResponseError('embedding document vector count diverges');
  }
  const expectedIds = new Set(documents.map((document) => document.id));
  const vectors = new Map();
  for (const item of response.document_vectors) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || stableJson(Object.keys(item).sort(compareText)) !== stableJson(['id', 'vector'])) {
      throw new EvidenceEmbeddingResponseError('embedding document vector is invalid');
    }
    const id = String(item.id || '');
    if (!expectedIds.has(id) || vectors.has(id)) {
      throw new EvidenceEmbeddingResponseError('embedding document vector id diverges');
    }
    if (!validVector(item.vector, manifest.dimensions)) {
      throw new EvidenceEmbeddingResponseError('embedding document vector dimensions are invalid');
    }
    vectors.set(id, item.vector);
  }
  return { queryVector: response.query_vector, vectors };
}

function baseMetrics(status, reason = '') {
  return {
    schema_version: 1,
    status,
    reason,
    plugin_id: '',
    plugin_version: '',
    model_id: '',
    model_revision: '',
    model_fingerprint: '',
    dimensions: 0,
    requested_candidates: 0,
    embedded_candidates: 0,
    skipped_candidates: 0,
    input_bytes: 0,
    scores: [],
  };
}

function pluginMetrics(manifest, rows, selection = null) {
  return {
    schema_version: 1,
    status: 'applied',
    reason: '',
    plugin_id: manifest.plugin_id,
    plugin_version: manifest.plugin_version,
    model_id: manifest.model_id,
    model_revision: manifest.model_revision,
    model_fingerprint: manifest.model_fingerprint,
    dimensions: manifest.dimensions,
    requested_candidates: rows.length,
    embedded_candidates: selection?.documents.length || 0,
    skipped_candidates: Math.max(0, rows.length - (selection?.documents.length || 0)),
    input_bytes: selection?.inputBytes || 0,
    scores: [],
  };
}

function fallback(rows, plugin, error) {
  const manifest = plugin?.manifest;
  return {
    rows: [...rows],
    metrics: {
      ...baseMetrics('fallback', String(error?.code || 'EVIDENCE_EMBEDDING_UNAVAILABLE')),
      plugin_id: String(manifest?.plugin_id || ''),
      plugin_version: String(manifest?.plugin_version || ''),
      model_id: String(manifest?.model_id || ''),
      model_revision: String(manifest?.model_revision || ''),
      model_fingerprint: String(manifest?.model_fingerprint || ''),
      dimensions: Number(manifest?.dimensions || 0),
      requested_candidates: rows.length,
      skipped_candidates: rows.length,
    },
  };
}

function normalizePluginError(error) {
  if (String(error?.code || '').startsWith('EVIDENCE_EMBEDDING_')) return error;
  return new EvidenceEmbeddingExecutionError('evidence embedding plugin execution failed', error);
}

export async function rerankEvidenceCandidatesWithEmbedding(rows, query, {
  enabled = false,
  plugin = null,
  required = false,
  maxCandidates: requestedMaxCandidates,
  maxInputBytes: requestedMaxInputBytes,
  signal,
} = {}) {
  if (!Array.isArray(rows)) throw new TypeError('embedding candidates must be an array');
  const original = [...rows];
  if (!enabled) {
    return {
      rows: original,
      metrics: {
        ...baseMetrics('disabled', 'disabled'),
        requested_candidates: original.length,
        skipped_candidates: original.length,
      },
    };
  }
  if (!String(query || '').trim()) {
    const error = new TypeError('embedding query must not be empty');
    if (required) throw error;
    return fallback(original, plugin, error);
  }
  if (!plugin) {
    const error = new EvidenceEmbeddingPluginError('evidence embedding plugin is required', ['plugin']);
    if (required) throw error;
    return fallback(original, plugin, error);
  }
  const validation = verifyEvidenceEmbeddingPlugin(plugin);
  if (!validation.valid) {
    const error = new EvidenceEmbeddingPluginError(
      `invalid evidence embedding plugin: ${validation.errors.join(', ')}`,
      validation.errors,
    );
    if (required) throw error;
    return fallback(original, plugin, error);
  }
  if (!original.length) {
    return {
      rows: original,
      metrics: {
        ...pluginMetrics(plugin.manifest, original),
        status: 'skipped',
        reason: 'no-candidates',
      },
    };
  }

  const maxCandidates = normalizeInteger(
    requestedMaxCandidates,
    EVIDENCE_EMBEDDING_DEFAULT_MAX_CANDIDATES,
    { max: EVIDENCE_EMBEDDING_MAX_CANDIDATES },
  );
  const maxInputBytes = normalizeInteger(
    requestedMaxInputBytes,
    EVIDENCE_EMBEDDING_DEFAULT_MAX_INPUT_BYTES,
    { max: EVIDENCE_EMBEDDING_MAX_INPUT_BYTES },
  );

  let selection;
  try {
    selection = selectDocuments(original, String(query), plugin.manifest, {
      maxCandidates,
      maxInputBytes,
    });
    if (signal?.aborted) {
      throw new EvidenceEmbeddingExecutionError('evidence embedding request was aborted');
    }
    const response = await plugin.embed({
      schema_version: 1,
      model_fingerprint: plugin.manifest.model_fingerprint,
      query: { text: String(query) },
      documents: selection.documents.map(({ id, text }) => ({ id, text })),
    }, { signal });
    const validated = validateResponse(response, plugin.manifest, selection.documents);
    const scored = selection.documents.map((document) => ({
      document,
      similarity: cosine(validated.queryVector, validated.vectors.get(document.id)),
    })).sort((left, right) => right.similarity - left.similarity
      || left.document.original_index - right.document.original_index
      || compareText(left.document.id, right.document.id));
    const embeddedIds = new Set(selection.documents.map((document) => document.id));
    const trailing = original.filter((row) => !embeddedIds.has(String(row?.chunk_id || '')));
    const metrics = pluginMetrics(plugin.manifest, original, selection);
    metrics.scores = scored.map(({ document, similarity }) => ({
      chunk_id: document.id,
      similarity,
    }));
    return {
      rows: [...scored.map(({ document }) => document.row), ...trailing],
      metrics,
    };
  } catch (rawError) {
    const error = normalizePluginError(rawError);
    if (required) throw error;
    return fallback(original, plugin, error);
  }
}
