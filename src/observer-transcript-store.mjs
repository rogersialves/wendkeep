import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { decryptObserverValue, encryptObserverValue } from '../packages/observer/src/encryption.mjs';

export const TRANSCRIPT_CODEC = 'gzip';

export function encodeTranscript(content, { encryption = null, aad = '' } = {}) {
  const text = String(content ?? '');
  const raw = Buffer.from(text, 'utf8');
  const compressed = gzipSync(raw, { mtime: 0 });
  const envelope = encryption
    ? encryptObserverValue(encryption, compressed.toString('base64'), { aad })
    : null;
  const stored = envelope ? Buffer.from(JSON.stringify(envelope), 'utf8') : compressed;
  return {
    codec: envelope ? 'aes-256-gcm+gzip' : TRANSCRIPT_CODEC,
    content_gzip: stored,
    content_sha256: createHash('sha256').update(raw).digest('hex'),
    original_bytes: raw.byteLength,
    compressed_bytes: stored.byteLength,
  };
}

export function decodeTranscript(row, { encryption = null, aad = '' } = {}) {
  if (!row) return null;
  const stored = Buffer.from(row.content_gzip || []);
  let compressed = stored;
  if (row.codec === 'aes-256-gcm+gzip') {
    if (!encryption) {
      const error = new Error('Chave do transcript protegido indisponível.');
      error.code = 'observer_encryption_key_unavailable';
      throw error;
    }
    const envelope = JSON.parse(stored.toString('utf8'));
    compressed = Buffer.from(decryptObserverValue(encryption, envelope, { aad }), 'base64');
  }
  const raw = [TRANSCRIPT_CODEC, 'aes-256-gcm+gzip'].includes(row.codec) ? gunzipSync(compressed) : compressed;
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
    compressed_bytes: Number(row.compressed_bytes) || stored.byteLength,
    source: row.source || '',
    occurred_at: row.occurred_at,
    metadata: parseJson(row.metadata_json),
  };
}

function parseJson(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}
