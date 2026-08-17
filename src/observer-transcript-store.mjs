import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

export const TRANSCRIPT_CODEC = 'gzip';

export function encodeTranscript(content) {
  const text = String(content ?? '');
  const raw = Buffer.from(text, 'utf8');
  const compressed = gzipSync(raw, { mtime: 0 });
  return {
    codec: TRANSCRIPT_CODEC,
    content_gzip: compressed,
    content_sha256: createHash('sha256').update(raw).digest('hex'),
    original_bytes: raw.byteLength,
    compressed_bytes: compressed.byteLength,
  };
}

export function decodeTranscript(row) {
  if (!row) return null;
  const compressed = Buffer.from(row.content_gzip || []);
  const raw = row.codec === TRANSCRIPT_CODEC ? gunzipSync(compressed) : compressed;
  const content = raw.toString('utf8');
  const contentSha256 = createHash('sha256').update(raw).digest('hex');
  if (row.content_sha256 && row.content_sha256 !== contentSha256) {
    const error = new Error('hash do transcript não corresponde ao conteúdo.');
    error.code = 'transcript_hash_mismatch';
    throw error;
  }
  return {
    transcript_id: row.transcript_id,
    project_id: row.project_id,
    session_id: row.session_id,
    agent_id: row.agent_id,
    coverage: row.coverage,
    codec: row.codec,
    content,
    content_sha256: contentSha256,
    original_bytes: Number(row.original_bytes) || raw.byteLength,
    compressed_bytes: Number(row.compressed_bytes) || compressed.byteLength,
    source: row.source || '',
    occurred_at: row.occurred_at,
    metadata: parseJson(row.metadata_json),
  };
}

function parseJson(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}
