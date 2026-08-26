import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  EVIDENCE_INDEX_FILE,
  EVIDENCE_INDEX_VERSION,
  chunkMarkdownDocument,
} from './evidence-recall.mjs';
import {
  assertVaultPathSafe,
  mkdirVaultPath,
  writeVaultFileAtomic,
} from './vault-path-safety.mjs';

export const EVIDENCE_INDEX_STATE_FILE = 'EVIDENCE_INDEX_STATE.json';
export const EVIDENCE_INDEX_STATE_VERSION = 1;

const EXCLUDED_DIRECTORIES = new Set([
  '.brain', '.git', '.obsidian', '.worktrees', 'node_modules',
]);

function brainDir(vaultBase) {
  return join(vaultBase, '.brain');
}

function indexPath(vaultBase) {
  return join(brainDir(vaultBase), EVIDENCE_INDEX_FILE);
}

function statePath(vaultBase) {
  return join(brainDir(vaultBase), EVIDENCE_INDEX_STATE_FILE);
}

function hash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function checkedFile(vaultBase, path, label, { allowMissing = true } = {}) {
  return assertVaultPathSafe(vaultBase, path, {
    allowMissing,
    expectedType: 'file',
    label,
  });
}

function readOptionalFile(vaultBase, path, label) {
  let checked = checkedFile(vaultBase, path, label);
  if (!checked.exists) return null;
  checked = checkedFile(vaultBase, checked.target, label, { allowMissing: false });
  return readFileSync(checked.target, 'utf8');
}

function writeIfChanged(vaultBase, path, content, label) {
  const current = readOptionalFile(vaultBase, path, label);
  if (current === content) return false;
  writeVaultFileAtomic(vaultBase, path, content, 'utf8', { label });
  return true;
}

function projectIdForVault(vaultBase) {
  try {
    const raw = readOptionalFile(
      vaultBase,
      join(brainDir(vaultBase), 'PROJECT.json'),
      'autoridade PROJECT.json do índice de evidências',
    );
    return raw === null ? '' : String(JSON.parse(raw).projectId || '');
  } catch {
    return '';
  }
}

function walkMarkdown(root, dir = root, found = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (entry.isSymbolicLink?.()) continue;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) walkMarkdown(root, join(dir, entry.name), found);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) found.push(join(dir, entry.name));
  }
  return found;
}

function nsText(value, fallbackMs = 0) {
  if (typeof value === 'bigint') return value.toString();
  const milliseconds = Number(fallbackMs || 0);
  return BigInt(Math.max(0, Math.trunc(milliseconds * 1_000_000))).toString();
}

function documentFingerprint(path) {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) return null;
  return {
    size: stat.size.toString(),
    mtime_ns: nsText(stat.mtimeNs, stat.mtimeMs),
    ctime_ns: nsText(stat.ctimeNs, stat.ctimeMs),
  };
}

function sameFingerprint(left, right) {
  return Boolean(left && right)
    && left.size === right.size
    && left.mtime_ns === right.mtime_ns
    && left.ctime_ns === right.ctime_ns;
}

function validChunk(row, projectId) {
  return Boolean(row && typeof row === 'object' && !Array.isArray(row))
    && row.index_version === EVIDENCE_INDEX_VERSION
    && typeof row.logical_path === 'string'
    && typeof row.chunk_id === 'string'
    && String(row.project_id || '') === projectId;
}

function readIndex(vaultBase, projectId) {
  const raw = readOptionalFile(vaultBase, indexPath(vaultBase), 'índice local de evidências');
  if (raw === null) return { status: 'missing', rows: [] };
  try {
    const rows = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    if (!rows.every((row) => validChunk(row, projectId))) throw new Error('invalid evidence chunk');
    return { status: 'ok', rows };
  } catch {
    return { status: 'corrupt', rows: [] };
  }
}

function validDocumentState(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    && typeof value.size === 'string'
    && typeof value.mtime_ns === 'string'
    && typeof value.ctime_ns === 'string'
    && typeof value.content_hash === 'string'
    && Number.isInteger(value.chunk_count)
    && value.chunk_count >= 0;
}

function parseState(raw, projectId) {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.schema_version !== EVIDENCE_INDEX_STATE_VERSION
        || parsed?.index_version !== EVIDENCE_INDEX_VERSION
        || String(parsed?.project_id || '') !== projectId
        || !parsed?.documents
        || typeof parsed.documents !== 'object'
        || Array.isArray(parsed.documents)
        || !Object.values(parsed.documents).every(validDocumentState)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadEvidenceIndexState(vaultBase) {
  const projectId = projectIdForVault(vaultBase);
  const raw = readOptionalFile(vaultBase, statePath(vaultBase), 'estado incremental do índice de evidências');
  return parseState(raw, projectId);
}

function groupByLogicalPath(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.logical_path)) grouped.set(row.logical_path, []);
    grouped.get(row.logical_path).push(row);
  }
  for (const values of grouped.values()) {
    values.sort((left, right) => left.ordinal - right.ordinal
      || left.chunk_id.localeCompare(right.chunk_id));
  }
  return grouped;
}

function sortedRecord(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function renderState(projectId, documents) {
  return `${JSON.stringify({
    schema_version: EVIDENCE_INDEX_STATE_VERSION,
    index_version: EVIDENCE_INDEX_VERSION,
    project_id: projectId,
    documents: sortedRecord(documents),
  }, null, 2)}\n`;
}

function renderIndex(chunks) {
  return chunks.map((chunk) => JSON.stringify(chunk)).join('\n') + (chunks.length ? '\n' : '');
}

/**
 * Refresh the derived local evidence index without re-reading unchanged Markdown.
 * The state sidecar is only a cache hint: missing, corrupt or incompatible state
 * causes a deterministic full rebuild from the Vault authority.
 */
export function refreshEvidenceIndex(vaultBase, { force = false } = {}) {
  mkdirVaultPath(vaultBase, brainDir(vaultBase), { label: 'raiz .brain do índice de evidências' });
  const projectId = projectIdForVault(vaultBase);
  const priorIndex = readIndex(vaultBase, projectId);
  const priorStateRaw = readOptionalFile(
    vaultBase,
    statePath(vaultBase),
    'estado incremental do índice de evidências',
  );
  const priorState = parseState(priorStateRaw, projectId);
  const fullRebuild = Boolean(force || priorIndex.status !== 'ok' || !priorState);
  const priorRows = fullRebuild ? [] : priorIndex.rows;
  const priorByPath = groupByLogicalPath(priorRows);
  const priorDocuments = fullRebuild ? {} : priorState.documents;

  const chunks = [];
  const documents = {};
  const seen = new Set();
  let readDocuments = 0;
  let reusedDocuments = 0;
  let reindexedDocuments = 0;

  const files = walkMarkdown(vaultBase)
    .map((path) => ({
      path,
      logicalPath: relative(vaultBase, path).replaceAll('\\', '/'),
    }))
    .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));

  for (const item of files) {
    let fingerprint;
    try { fingerprint = documentFingerprint(item.path); } catch { continue; }
    if (!fingerprint) continue;
    seen.add(item.logicalPath);

    const previous = priorDocuments[item.logicalPath];
    const previousChunks = priorByPath.get(item.logicalPath) || [];
    const reusableChunkSet = Boolean(previous)
      && previousChunks.length === previous.chunk_count;

    if (!fullRebuild && reusableChunkSet && sameFingerprint(previous, fingerprint)) {
      chunks.push(...previousChunks);
      documents[item.logicalPath] = previous;
      reusedDocuments += 1;
      continue;
    }

    let content;
    try { content = readFileSync(item.path, 'utf8'); } catch { continue; }
    readDocuments += 1;
    const contentHash = hash(content);

    if (!fullRebuild && reusableChunkSet && previous.content_hash === contentHash) {
      chunks.push(...previousChunks);
      documents[item.logicalPath] = {
        ...fingerprint,
        content_hash: contentHash,
        chunk_count: previousChunks.length,
      };
      reusedDocuments += 1;
      continue;
    }

    const nextChunks = chunkMarkdownDocument({
      projectId,
      logicalPath: item.logicalPath,
      content,
    });
    chunks.push(...nextChunks);
    documents[item.logicalPath] = {
      ...fingerprint,
      content_hash: contentHash,
      chunk_count: nextChunks.length,
    };
    reindexedDocuments += 1;
  }

  chunks.sort((left, right) => left.logical_path.localeCompare(right.logical_path)
    || left.ordinal - right.ordinal || left.chunk_id.localeCompare(right.chunk_id));

  const deletedDocuments = Object.keys(priorDocuments)
    .filter((logicalPath) => !seen.has(logicalPath)).length;
  const indexWritten = writeIfChanged(
    vaultBase,
    indexPath(vaultBase),
    renderIndex(chunks),
    'índice local de evidências',
  );
  const stateWritten = writeIfChanged(
    vaultBase,
    statePath(vaultBase),
    renderState(projectId, documents),
    'estado incremental do índice de evidências',
  );

  return {
    chunks,
    documents: Object.keys(documents).length,
    read_documents: readDocuments,
    reused_documents: reusedDocuments,
    reindexed_documents: reindexedDocuments,
    deleted_documents: deletedDocuments,
    full_rebuild: fullRebuild,
    index_written: indexWritten,
    state_written: stateWritten,
  };
}

export function buildIncrementalEvidenceIndex(vaultBase, options = {}) {
  return refreshEvidenceIndex(vaultBase, options).chunks;
}
