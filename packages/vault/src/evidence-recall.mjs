import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

export const EVIDENCE_INDEX_FILE = 'EVIDENCE_INDEX.jsonl';
export const EVIDENCE_INDEX_VERSION = 1;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'for', 'in',
  'is', 'o', 'os', 'or', 'para', 'por', 'the', 'to', 'um', 'uma', 'with', 'com', 'que',
]);

function hash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function cleanText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/[\t ]+/g, ' ').trim();
}

export function normalizeRecallText(value) {
  return cleanText(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function recallTerms(value) {
  return normalizeRecallText(value).match(/[\p{L}\p{N}]+(?:[._-][\p{L}\p{N}]+)*/gu)
    ?.filter((term) => term.length > 1 && !STOP_WORDS.has(term)) || [];
}

function parseFrontmatter(content) {
  const match = String(content || '').match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return { data: {}, body: String(content || '') };
  const data = {};
  for (const line of match[1].split('\n')) {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!item) continue;
    data[item[1]] = item[2].replace(/^['"]|['"]$/g, '');
  }
  return { data, body: String(content || '').slice(match[0].length) };
}

function inferredChangeSlug(logicalPath, metadata) {
  const explicit = metadata.change_slug || metadata.change || '';
  if (explicit) return String(explicit);
  const segments = String(logicalPath || '').replaceAll('\\', '/').split('/');
  const at = segments.findIndex((segment) => /^(?:08-Mudan[cç]as|08-Changes)$/i.test(segment));
  return at >= 0 ? String(segments[at + 1] || '').replace(/^\d{4}-\d{2}-\d{2}-/, '') : '';
}

function entityType(logicalPath, heading, block, fallback = 'document') {
  const signal = normalizeRecallText(`${logicalPath} ${heading}`);
  const headingSignal = normalizeRecallText(heading);
  if (/^\s*[-*]\s+\[[ xX]\]/m.test(block) || /\b(tasks?|tarefas?)\b/.test(headingSignal)) return 'task';
  if (/\b(decisions?|decisoes?|adr)\b/.test(signal) || /(^|\/)04-/.test(logicalPath)) return 'decision';
  if (/\b(requirements?|requisitos?|specs?|contratos?)\b/.test(signal) || /(^|\/)07-/.test(logicalPath)) return 'requirement';
  if (/\b(evidence|evidencia|verdict|teste|test)\b/.test(signal)) return 'evidence';
  if (/\b(session|sessao)\b/.test(signal) || /(^|\/)02-/.test(logicalPath)) return 'session';
  return String(fallback || 'document');
}

function authorityFor(logicalPath, metadata, kind) {
  if (['verified', 'reported', 'candidate'].includes(metadata.authority)) return metadata.authority;
  if (kind === 'decision' || kind === 'requirement' || kind === 'evidence'
      || /(^|\/)(?:04-|07-)/.test(logicalPath)) return 'verified';
  return kind === 'session' ? 'reported' : 'candidate';
}

function validityFor(metadata, block) {
  const explicit = normalizeRecallText(metadata.validity || metadata.status || '');
  if (/superseded|superado|deprecated|obsoleto|rejected|abandon/.test(explicit)) return 'superseded';
  if (/closed|done|archived|active|ativo|accepted|complete/.test(explicit)) return 'active';
  if (/\b(?:superseded|superado|obsoleto)\b/i.test(block)) return 'superseded';
  return 'active';
}

function observedAt(metadata) {
  const raw = metadata.observed_at || metadata.updated_at || metadata.ended_at
    || metadata.date || metadata.created_at || '';
  if (!raw) return new Date(0).toISOString();
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}

function splitLongBlock(block, maxChars = 1200) {
  if (block.length <= maxChars) return [block];
  const out = [];
  let rest = block;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function indexableBlockParts(block) {
  const maxIndexedChars = 4 * 1024 * 1024;
  if (block.length <= maxIndexedChars) return splitLongBlock(block);
  const samples = 256;
  const sampleChars = Math.floor(maxIndexedChars / samples);
  const stride = block.length / samples;
  return Array.from({ length: samples }, (_, index) => {
    const start = Math.min(block.length - sampleChars, Math.floor(index * stride));
    return cleanText(block.slice(Math.max(0, start), Math.max(0, start) + sampleChars));
  }).filter(Boolean);
}

export function chunkMarkdownDocument({
  projectId = '', logicalPath = '', content = '', metadata = {}, entityType: fallbackType = 'document',
} = {}) {
  const parsed = parseFrontmatter(content);
  const meta = { ...parsed.data, ...(metadata || {}) };
  const lines = parsed.body.replace(/\r\n/g, '\n').split('\n');
  const title = cleanText(meta.title || lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, '')
    || basename(logicalPath).replace(/\.md$/i, ''));
  let heading = title;
  let buffer = [];
  const blocks = [];
  let inFence = false;

  const flush = () => {
    const block = cleanText(buffer.join('\n'));
    if (block) indexableBlockParts(block).forEach((part) => blocks.push({ heading, content: part }));
    buffer = [];
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) inFence = !inFence;
    const headingMatch = !inFence && line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      heading = cleanText(headingMatch[1]);
      continue;
    }
    if (!inFence && !line.trim()) flush();
    else buffer.push(line);
  }
  flush();

  const common = {
    index_version: EVIDENCE_INDEX_VERSION,
    project_id: String(projectId || ''),
    logical_path: String(logicalPath || '').replaceAll('\\', '/'),
    title,
    change_slug: inferredChangeSlug(logicalPath, meta),
    session_id: String(meta.session_id || ''),
    work_session_id: String(meta.work_session_id || ''),
    observed_at: observedAt(meta),
  };
  return blocks.map((block, ordinal) => {
    const kind = entityType(common.logical_path, block.heading, block.content, meta.entity_type || fallbackType);
    return {
      ...common,
      chunk_id: `chunk-${hash(`${projectId}\0${common.logical_path}\0${block.heading}\0${ordinal}\0${block.content}`).slice(0, 24)}`,
      heading: block.heading,
      entity_type: kind,
      authority: authorityFor(common.logical_path, meta, kind),
      validity: validityFor(meta, block.content),
      ordinal,
      content: block.content,
      content_hash: hash(block.content),
    };
  });
}

function walkMarkdown(root, dir = root, found = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (entry.name === '.brain' || entry.name === '.obsidian' || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(root, path, found);
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

function projectIdForVault(vaultBase) {
  try {
    return String(JSON.parse(readFileSync(join(vaultBase, '.brain', 'PROJECT.json'), 'utf8')).projectId || '');
  } catch {
    return '';
  }
}

export function buildEvidenceIndex(vaultBase) {
  const projectId = projectIdForVault(vaultBase);
  const chunks = [];
  for (const path of walkMarkdown(vaultBase)) {
    let content = '';
    try { content = readFileSync(path, 'utf8'); } catch { continue; }
    chunks.push(...chunkMarkdownDocument({
      projectId,
      logicalPath: relative(vaultBase, path).replaceAll('\\', '/'),
      content,
    }));
  }
  chunks.sort((left, right) => left.logical_path.localeCompare(right.logical_path)
    || left.ordinal - right.ordinal || left.chunk_id.localeCompare(right.chunk_id));
  const output = chunks.map((chunk) => JSON.stringify(chunk)).join('\n') + (chunks.length ? '\n' : '');
  writeFileSync(join(vaultBase, '.brain', EVIDENCE_INDEX_FILE), output, 'utf8');
  return chunks;
}

export function loadEvidenceIndex(vaultBase) {
  const path = join(vaultBase, '.brain', EVIDENCE_INDEX_FILE);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function occurrences(terms, text) {
  const tokens = recallTerms(text);
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return terms.reduce((sum, term) => sum + (counts.get(term) || 0), 0);
}

function excerptFor(content, query, terms, max = 360) {
  const raw = cleanText(content);
  const normalized = normalizeRecallText(raw);
  const phrase = normalizeRecallText(query);
  let at = phrase ? normalized.indexOf(phrase) : -1;
  if (at < 0) at = terms.map((term) => normalized.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - Math.floor(max * 0.3));
  const end = Math.min(raw.length, start + max);
  return `${start > 0 ? '…' : ''}${raw.slice(start, end).trim()}${end < raw.length ? '…' : ''}`;
}

function recencyScore(observed, now) {
  const instant = Date.parse(observed || '');
  if (!Number.isFinite(instant)) return 0;
  const days = Math.max(0, (now - instant) / 86_400_000);
  return Math.max(0, 1.5 * (1 - Math.min(days, 365) / 365));
}

export function recallEvidence(rows, query, { topK = 5, now = Date.now() } = {}) {
  const terms = [...new Set(recallTerms(query))];
  if (!terms.length || !Array.isArray(rows) || !rows.length) return [];
  const docs = rows.map((row) => ({
    row,
    contentTerms: recallTerms(row.content),
    allTerms: new Set(recallTerms(`${row.title} ${row.heading} ${row.logical_path} ${row.content}`)),
  }));
  const df = new Map(terms.map((term) => [term, docs.filter((doc) => doc.allTerms.has(term)).length]));
  const averageLength = docs.reduce((sum, doc) => sum + doc.contentTerms.length, 0) / docs.length || 1;
  const phrase = normalizeRecallText(query);
  const scored = docs.map(({ row, contentTerms, allTerms }) => {
    let score = 0;
    for (const term of terms) {
      const frequency = occurrences([term], row.content);
      const idf = Math.log(1 + ((docs.length - (df.get(term) || 0) + 0.5) / ((df.get(term) || 0) + 0.5)));
      if (frequency) score += idf * ((frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * contentTerms.length / averageLength)));
      if (recallTerms(row.title).includes(term)) score += idf * 3;
      if (recallTerms(row.heading).includes(term)) score += idf * 2.5;
      if (recallTerms(row.logical_path).includes(term)) score += idf * 1.5;
    }
    if (phrase && normalizeRecallText(`${row.title} ${row.heading} ${row.content}`).includes(phrase)) score += 6;
    if (row.authority === 'verified') score += 2;
    else if (row.authority === 'reported') score += 1;
    if (row.validity === 'superseded') score -= 8;
    else if (row.validity === 'active') score += 1;
    score += recencyScore(row.observed_at, now);
    const matchedTerms = terms.filter((term) => allTerms.has(term));
    return {
      ...row,
      score: Number(score.toFixed(6)),
      matched_terms: matchedTerms,
      excerpt: excerptFor(row.content, query, matchedTerms),
    };
  }).filter((row) => row.matched_terms.length && row.score > 0)
    .sort((left, right) => right.score - left.score
      || String(right.observed_at).localeCompare(String(left.observed_at))
      || left.logical_path.localeCompare(right.logical_path));

  const selected = [];
  const perSource = new Map();
  for (const row of scored) {
    const count = perSource.get(row.logical_path) || 0;
    if (count >= 1 && scored.some((candidate) => !perSource.has(candidate.logical_path))) continue;
    selected.push(row);
    perSource.set(row.logical_path, count + 1);
    if (selected.length >= topK) break;
  }
  if (selected.length < topK) {
    for (const row of scored) {
      if (selected.some((item) => item.chunk_id === row.chunk_id)) continue;
      selected.push(row);
      if (selected.length >= topK) break;
    }
  }
  return selected;
}

export function renderEvidenceContext(results, { maxBytes = 3072 } = {}) {
  const lines = ['<wk_evidence_recall>'];
  for (const [index, item] of results.entries()) {
    const entry = [
      `${index + 1}. ${item.title || item.logical_path} — ${item.heading || '(sem heading)'}`,
      `   ${item.excerpt}`,
      `   source:${item.logical_path} authority:${item.authority} validity:${item.validity} as_of:${item.observed_at}`,
    ];
    const candidate = [...lines, ...entry, '</wk_evidence_recall>'].join('\n');
    if (Buffer.byteLength(candidate, 'utf8') > maxBytes) break;
    lines.push(...entry);
  }
  lines.push('</wk_evidence_recall>');
  return lines.length === 2 ? '' : lines.join('\n');
}

export function benchmarkEvidenceRecall(rows, cases, { topK = 5, now = Date.now() } = {}) {
  let reciprocal = 0;
  let recalled = 0;
  let stale = 0;
  let evidenceCorrect = 0;
  let handoffs = 0;
  let handoffsFound = 0;
  for (const item of cases) {
    const results = recallEvidence(rows, item.query, { topK, now });
    const rank = results.findIndex((row) => row.chunk_id === item.expected_chunk_id
      || row.logical_path === item.expected_path);
    if (rank >= 0) { recalled += 1; reciprocal += 1 / (rank + 1); }
    if (results[0]?.validity === 'superseded') stale += 1;
    if (results.every((row) => row.logical_path && row.heading && row.authority && row.observed_at)) evidenceCorrect += 1;
    if (item.handoff) {
      handoffs += 1;
      if (rank >= 0) handoffsFound += 1;
    }
  }
  const count = Math.max(1, cases.length);
  return {
    recall_at_5: recalled / count,
    mrr: reciprocal / count,
    stale_answer_rate: stale / count,
    evidence_accuracy: evidenceCorrect / count,
    handoff_success: handoffs ? handoffsFound / handoffs : 1,
  };
}
