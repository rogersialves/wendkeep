export function isBootstrapPrompt(text = '') {
  const clean = String(text || '').trim();
  return clean.startsWith('# AGENTS.md instructions')
    || clean.startsWith('<environment_context>')
    || clean.startsWith('<permissions instructions>')
    || clean.startsWith('<recommended_plugins>')
    || clean.includes('You are Codex, a coding agent')
    || clean.startsWith('## Memory');
}

export function redactSecrets(text) {
  if (!text) return '';
  return String(text)
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b(whsec_[A-Za-z0-9_/-]{8,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)\s*[:=]\s*["']?[^"'\s]+/gi, '$1=[REDACTED_SECRET]')
    .replace(/:\/\/([^:\s/@]+):([^@\s/]+)@/g, '://[REDACTED_SECRET]@');
}

function metadataPayloadLine(name, line) {
  if (name === 'citation_entries') {
    return /\|note=\[[^\]]*\]\s*$/i.test(line)
      || /^[^\s<>]+:\d+(?:-\d+)?(?:\|[^\s].*)?$/i.test(line);
  }
  if (name === 'rollout_ids') {
    return /^(?:[0-9a-f]{8,}(?:-[0-9a-f-]+)*|019f-[A-Za-z0-9_-]+)$/i.test(line);
  }
  return false;
}

function consumeTruncatedMetadata(source, name, tagEnd) {
  let cursor = tagEnd;
  let mode = name;
  let openingLine = true;

  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor);
    const lineEnd = newline === -1 ? source.length : newline;
    const line = source.slice(cursor, lineEnd).replace(/\r$/, '');
    const clean = line.trim();

    if (!clean) {
      if (!openingLine) return cursor;
    } else if (/^<\/?(?:oai-mem-citation|citation_entries|rollout_ids)\b/i.test(clean)) {
      const nested = [...clean.matchAll(/<(citation_entries|rollout_ids)\b[^>]*>/gi)].at(-1);
      if (nested) mode = nested[1].toLowerCase();
    } else if (!(openingLine && name !== 'oai-mem-citation') && !metadataPayloadLine(mode, clean)) {
      return cursor;
    }

    if (newline === -1) return source.length;
    cursor = newline + 1;
    openingLine = false;
  }
  return cursor;
}

function openingPayloadLooksStructural(source, opening) {
  const name = opening[1].toLowerCase();
  const tagEnd = opening.index + opening[0].length;
  const rest = source.slice(tagEnd);
  if (new RegExp(`<\/${name}\\s*>`, 'i').test(rest)) return true;

  if (name === 'oai-mem-citation') {
    const child = /^[\t\r\n ]*<(citation_entries|rollout_ids)\b[^>]*>/i.exec(rest);
    if (!child) return !rest.trim();
    const childRest = rest.slice(child[0].length);
    const lineEnd = childRest.search(/\r?\n/u);
    const sameLine = childRest.slice(0, lineEnd === -1 ? childRest.length : lineEnd);
    if (!sameLine.trim()) return true;
    if (!/^[\t ]/u.test(childRest)) return true;
    if (/^<\/?(?:oai-mem-citation|citation_entries|rollout_ids)\b/i.test(sameLine.trim())) return true;
    return metadataPayloadLine(child[1].toLowerCase(), sameLine.trim());
  }

  const lineEnd = rest.search(/\r?\n/u);
  const sameLine = rest.slice(0, lineEnd === -1 ? rest.length : lineEnd);
  if (!sameLine.trim()) return true;
  if (!/^[\t ]/u.test(rest)) return true;
  if (/^<\/?(?:oai-mem-citation|citation_entries|rollout_ids)\b/i.test(sameLine.trim())) return true;
  return metadataPayloadLine(name, sameLine.trim());
}

function metadataStart(source, opening) {
  const tagStart = opening.index;
  const before = source.slice(0, tagStart);
  const adjacentSession = /<\/session>[\t\r\n ]*$/i.exec(before);
  if (adjacentSession) return adjacentSession.index;

  if (!openingPayloadLooksStructural(source, opening)) return -1;

  const lineStart = before.lastIndexOf('\n') + 1;
  if (!before.slice(lineStart).trim()) return tagStart;

  const name = opening[1].toLowerCase();
  if (name === 'oai-mem-citation'
    && tagStart > 0
    && !/\s/u.test(source[tagStart - 1])) {
    return tagStart;
  }
  return -1;
}

function findAssistantMetadataRemoval(source) {
  const openings = source.matchAll(/<(oai-mem-citation|citation_entries|rollout_ids)\b[^>]*>/gi);
  for (const opening of openings) {
    const start = metadataStart(source, opening);
    if (start < 0) continue;

    const name = opening[1].toLowerCase();
    const tagEnd = opening.index + opening[0].length;
    const closing = new RegExp(`<\/${name}\\s*>`, 'i').exec(source.slice(tagEnd));
    const end = closing
      ? tagEnd + closing.index + closing[0].length
      : consumeTruncatedMetadata(source, name, tagEnd);
    return { start, end };
  }
  return null;
}

function removeAssistantMetadata(source, removal) {
  const before = source.slice(0, removal.start).trimEnd();
  const after = source.slice(removal.end).trimStart();
  if (!before) return after;
  if (!after) return before;
  return `${before}\n${after}`;
}

export function sanitizeAssistantMessage(text) {
  let source = String(text || '');
  if (!source) return '';

  while (source) {
    const removal = findAssistantMetadataRemoval(source);
    if (!removal) break;
    const next = removeAssistantMetadata(source, removal);
    if (next.length >= source.length) break;
    source = next;
  }
  return source;
}
