import {
  closeSync,
  openSync,
  readSync,
} from 'node:fs';

export const DEFAULT_CODEX_META_LINE_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

function trimCarriageReturn(buffer) {
  return buffer.length > 0 && buffer[buffer.length - 1] === 0x0d
    ? buffer.subarray(0, buffer.length - 1)
    : buffer;
}

// Codex writes session_meta as the first physical JSONL line. Read only that line: the
// transcript body can be hundreds of MiB and is irrelevant to identity/discovery.
export function readFirstJsonlLine(
  path,
  { maxBytes = DEFAULT_CODEX_META_LINE_BYTES } = {},
) {
  if (typeof path !== 'string' || !path) {
    return { ok: false, reason: 'INVALID_PATH' };
  }

  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return { ok: false, reason: 'READ_ERROR' };
  }

  let fd;
  try {
    fd = openSync(path, 'r');
    const parts = [];
    let totalBytes = 0;

    while (totalBytes <= limit) {
      // The extra byte distinguishes an exactly-at-limit line followed by LF from a line
      // whose content exceeds the limit.
      const remaining = (limit + 1) - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);

      if (bytesRead === 0) {
        if (totalBytes === 0) return { ok: false, reason: 'EMPTY_FILE' };
        const lineBuffer = trimCarriageReturn(Buffer.concat(parts, totalBytes));
        return {
          ok: true,
          line: lineBuffer.toString('utf8'),
          lineBytes: lineBuffer.length,
        };
      }

      const bytes = chunk.subarray(0, bytesRead);
      const newlineAt = bytes.indexOf(0x0a);
      if (newlineAt !== -1) {
        if (totalBytes + newlineAt > limit) {
          return { ok: false, reason: 'LINE_TOO_LONG' };
        }
        parts.push(bytes.subarray(0, newlineAt));
        const lineBuffer = trimCarriageReturn(Buffer.concat(parts, totalBytes + newlineAt));
        if (lineBuffer.length === 0) return { ok: false, reason: 'EMPTY_FILE' };
        return {
          ok: true,
          line: lineBuffer.toString('utf8'),
          lineBytes: lineBuffer.length,
        };
      }

      parts.push(bytes);
      totalBytes += bytesRead;
      if (totalBytes > limit) return { ok: false, reason: 'LINE_TOO_LONG' };
    }

    return { ok: false, reason: 'LINE_TOO_LONG' };
  } catch {
    return { ok: false, reason: 'READ_ERROR' };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

export function readCodexRolloutMeta(
  path,
  { maxLineBytes = DEFAULT_CODEX_META_LINE_BYTES } = {},
) {
  const first = readFirstJsonlLine(path, { maxBytes: maxLineBytes });
  if (!first.ok) return first;

  let event;
  try {
    event = JSON.parse(first.line);
  } catch {
    return { ok: false, reason: 'INVALID_JSON' };
  }

  if (!event || typeof event !== 'object' || Array.isArray(event)
    || event.type !== 'session_meta') {
    return { ok: false, reason: 'NOT_SESSION_META' };
  }
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return { ok: false, reason: 'INVALID_META' };
  }

  return {
    ok: true,
    meta: event.payload,
    lineBytes: first.lineBytes,
  };
}
