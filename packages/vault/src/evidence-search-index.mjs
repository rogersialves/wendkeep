import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
  EVIDENCE_INDEX_FILE,
  loadEvidenceIndex,
  recallEvidence,
  recallTerms,
} from './evidence-recall.mjs';
import {
  filterEvidenceRecallRows,
  normalizeEvidenceRecallFilters,
} from './evidence-recall-page.mjs';
import { EVIDENCE_INDEX_STATE_FILE } from './evidence-index-store.mjs';
import {
  assertVaultPathSafe,
  mkdirVaultPath,
  renameVaultPath,
  unlinkVaultFile,
  writeVaultFileAtomic,
} from './vault-path-safety.mjs';

export const EVIDENCE_SEARCH_STATE_FILE = 'EVIDENCE_SEARCH_STATE.json';
export const EVIDENCE_SEARCH_STATE_VERSION = 1;
export const EVIDENCE_SEARCH_DEFAULT_CANDIDATES = 512;
export const EVIDENCE_SEARCH_MAX_CANDIDATES = 4096;
export const EVIDENCE_SEARCH_DEFAULT_POSTING_BUDGET = 65_536;
export const EVIDENCE_SEARCH_MAX_POSTING_BUDGET = 1_048_576;

const SEARCH_DIRECTORY = 'evidence-search';
const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_PATH = /^evidence-search\/[A-Za-z0-9._-]+$/;
const require = createRequire(import.meta.url);
const lexicalCache = new Map();
let sqliteCapability = null;

function brainDir(vaultBase) {
  return join(vaultBase, '.brain');
}

function searchDir(vaultBase) {
  return join(brainDir(vaultBase), SEARCH_DIRECTORY);
}

function searchStatePath(vaultBase) {
  return join(brainDir(vaultBase), EVIDENCE_SEARCH_STATE_FILE);
}

function evidenceIndexPath(vaultBase) {
  return join(brainDir(vaultBase), EVIDENCE_INDEX_FILE);
}

function evidenceIndexStatePath(vaultBase) {
  return join(brainDir(vaultBase), EVIDENCE_INDEX_STATE_FILE);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

function bigintText(value, fallbackMs = 0) {
  if (typeof value === 'bigint') return value.toString();
  return BigInt(Math.max(0, Math.trunc(Number(fallbackMs || 0) * 1_000_000))).toString();
}

function safeFile(vaultBase, path, label, { allowMissing = true } = {}) {
  return assertVaultPathSafe(vaultBase, path, {
    allowMissing,
    expectedType: 'file',
    label,
  });
}

function fileFingerprint(vaultBase, path, label) {
  let checked = safeFile(vaultBase, path, label);
  if (!checked.exists) return null;
  checked = safeFile(vaultBase, checked.target, label, { allowMissing: false });
  const stat = statSync(checked.target, { bigint: true });
  if (!stat.isFile()) return null;
  return {
    size: stat.size.toString(),
    mtime_ns: bigintText(stat.mtimeNs, stat.mtimeMs),
    ctime_ns: bigintText(stat.ctimeNs, stat.ctimeMs),
  };
}

function sameFingerprint(left, right) {
  if (left === null || right === null) return left === right;
  return Boolean(left && right)
    && left.size === right.size
    && left.mtime_ns === right.mtime_ns
    && left.ctime_ns === right.ctime_ns;
}

function readSafeFile(vaultBase, path, label, encoding = 'utf8') {
  let checked = safeFile(vaultBase, path, label);
  if (!checked.exists) return null;
  checked = safeFile(vaultBase, checked.target, label, { allowMissing: false });
  return encoding === null ? readFileSync(checked.target) : readFileSync(checked.target, encoding);
}

function validFingerprint(value) {
  return value === null || (Boolean(value && typeof value === 'object' && !Array.isArray(value))
    && /^\d+$/.test(String(value.size || ''))
    && /^\d+$/.test(String(value.mtime_ns || ''))
    && /^\d+$/.test(String(value.ctime_ns || '')));
}

function validArtifact(value, kind) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    && value.kind === kind
    && ARTIFACT_PATH.test(String(value.path || ''))
    && SHA256.test(String(value.hash || ''))
    && validFingerprint(value.fingerprint)
    && value.fingerprint !== null;
}

function parseState(raw) {
  if (raw === null) return null;
  try {
    const state = JSON.parse(raw);
    if (state?.schema_version !== EVIDENCE_SEARCH_STATE_VERSION
        || !SHA256.test(String(state?.index_hash || ''))
        || !Number.isSafeInteger(state?.row_count)
        || state.row_count < 0
        || !state?.source
        || !validFingerprint(state.source.index)
        || state.source.index === null
        || !validFingerprint(state.source.state)
        || !validArtifact(state.lexical, 'lexical')
        || (state.sqlite !== null && !validArtifact(state.sqlite, 'sqlite'))) return null;
    return state;
  } catch {
    return null;
  }
}

export function loadEvidenceSearchState(vaultBase) {
  const raw = readSafeFile(
    vaultBase,
    searchStatePath(vaultBase),
    'estado do índice de busca de evidências',
  );
  return parseState(raw);
}

function currentSource(vaultBase) {
  return {
    index: fileFingerprint(vaultBase, evidenceIndexPath(vaultBase), 'autoridade JSONL da busca de evidências'),
    state: fileFingerprint(vaultBase, evidenceIndexStatePath(vaultBase), 'estado incremental da busca de evidências'),
  };
}

function artifactPath(vaultBase, artifact) {
  return join(brainDir(vaultBase), artifact.path);
}

function artifactCurrent(vaultBase, artifact) {
  try {
    return sameFingerprint(
      artifact.fingerprint,
      fileFingerprint(vaultBase, artifactPath(vaultBase, artifact), `artefato ${artifact.kind} da busca`),
    );
  } catch {
    return false;
  }
}

function stateCurrent(vaultBase, state) {
  if (!state) return false;
  const source = currentSource(vaultBase);
  return sameFingerprint(state.source.index, source.index)
    && sameFingerprint(state.source.state, source.state)
    && artifactCurrent(vaultBase, state.lexical)
    && (state.sqlite === null || artifactCurrent(vaultBase, state.sqlite));
}

function validEvidenceRow(row) {
  return Boolean(row && typeof row === 'object' && !Array.isArray(row))
    && typeof row.chunk_id === 'string'
    && row.chunk_id.length > 0
    && typeof row.logical_path === 'string'
    && Number.isSafeInteger(row.ordinal)
    && row.ordinal >= 0
    && typeof row.content === 'string'
    && SHA256.test(String(row.content_hash || ''))
    && sha256(row.content) === row.content_hash;
}

function canonicalRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('evidence search rows must be an array');
  if (!rows.every(validEvidenceRow)) throw new TypeError('evidence search rows contain an invalid chunk');
  const sorted = [...rows].sort((left, right) => compareText(left.logical_path, right.logical_path)
    || left.ordinal - right.ordinal
    || compareText(left.chunk_id, right.chunk_id)
    || compareText(left.content_hash, right.content_hash));
  const ids = new Set();
  for (const row of sorted) {
    if (ids.has(row.chunk_id)) throw new TypeError(`duplicate evidence chunk id: ${row.chunk_id}`);
    ids.add(row.chunk_id);
  }
  return sorted;
}

export function evidenceSearchIndexHash(rows) {
  return sha256(canonicalRows(rows).map((row) => stableJson(row)).join('\n'));
}

function weightedTerms(row) {
  const weights = new Map();
  const add = (value, multiplier) => {
    const counts = new Map();
    for (const term of recallTerms(value)) {
      counts.set(term, Math.min(32, (counts.get(term) || 0) + 1));
    }
    for (const [term, count] of counts) {
      weights.set(term, (weights.get(term) || 0) + count * multiplier);
    }
  };
  add(row.content, 1);
  add(row.logical_path, 2);
  add(row.heading, 3);
  add(row.title, 4);
  return weights;
}

function buildLexicalArtifact(rows, indexHash) {
  const postings = new Map();
  rows.forEach((row, rowIndex) => {
    for (const [term, weight] of weightedTerms(row)) {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push([rowIndex, weight]);
    }
  });
  const renderedPostings = {};
  for (const term of [...postings.keys()].sort(compareText)) {
    renderedPostings[term] = postings.get(term).sort((left, right) => right[1] - left[1]
      || left[0] - right[0]);
  }
  return {
    schema_version: EVIDENCE_SEARCH_STATE_VERSION,
    index_hash: indexHash,
    row_count: rows.length,
    rows,
    postings: renderedPostings,
  };
}

function validateLexicalArtifact(value, expectedState = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schema_version !== EVIDENCE_SEARCH_STATE_VERSION
      || !SHA256.test(String(value.index_hash || ''))
      || !Number.isSafeInteger(value.row_count)
      || value.row_count < 0
      || !Array.isArray(value.rows)
      || value.rows.length !== value.row_count
      || !value.rows.every(validEvidenceRow)
      || !value.postings
      || typeof value.postings !== 'object'
      || Array.isArray(value.postings)) return false;
  if (expectedState && (value.index_hash !== expectedState.index_hash
      || value.row_count !== expectedState.row_count)) return false;
  for (const [term, entries] of Object.entries(value.postings)) {
    if (!term || !Array.isArray(entries)) return false;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2
          || !Number.isSafeInteger(entry[0]) || entry[0] < 0 || entry[0] >= value.row_count
          || !Number.isFinite(entry[1]) || entry[1] <= 0) return false;
    }
  }
  return evidenceSearchIndexHash(value.rows) === value.index_hash;
}

function lexicalFileContent(artifact) {
  return `${JSON.stringify(artifact)}\n`;
}

function writeContentAddressedText(vaultBase, prefix, indexHash, content) {
  const contentHash = sha256(content);
  const relativePath = `${SEARCH_DIRECTORY}/${prefix}-${indexHash.slice(0, 20)}-${contentHash.slice(0, 20)}.json`;
  const path = join(brainDir(vaultBase), relativePath);
  const current = readSafeFile(vaultBase, path, `artefato ${prefix} da busca`);
  let written = false;
  if (current === null) {
    writeVaultFileAtomic(vaultBase, path, content, 'utf8', {
      label: `artefato imutável ${prefix} da busca`,
      scopeRoot: searchDir(vaultBase),
    });
    written = true;
  } else if (sha256(current) !== contentHash || current !== content) {
    const error = new Error(`content-addressed evidence search artifact diverges: ${relativePath}`);
    error.code = 'EVIDENCE_SEARCH_ARTIFACT_DIVERGED';
    throw error;
  }
  return {
    artifact: {
      kind: 'lexical',
      path: relativePath,
      hash: contentHash,
      fingerprint: fileFingerprint(vaultBase, path, `artefato ${prefix} da busca`),
    },
    written,
  };
}

function sqliteDatabaseSync() {
  try {
    const module = require('node:sqlite');
    return typeof module?.DatabaseSync === 'function' ? module.DatabaseSync : null;
  } catch {
    return null;
  }
}

function detectSqliteCapability() {
  if (sqliteCapability) return sqliteCapability;
  const DatabaseSync = sqliteDatabaseSync();
  if (!DatabaseSync) {
    sqliteCapability = {
      available: false,
      DatabaseSync: null,
      reason: 'node-sqlite-unavailable',
      error_code: 'EVIDENCE_SEARCH_SQLITE_UNAVAILABLE',
    };
    return sqliteCapability;
  }

  let db = null;
  try {
    db = new DatabaseSync(':memory:', { open: true });
    db.exec('CREATE VIRTUAL TABLE evidence_fts_probe USING fts5(content)');
    sqliteCapability = { available: true, DatabaseSync, reason: '', error_code: '' };
  } catch {
    sqliteCapability = {
      available: false,
      DatabaseSync,
      reason: 'fts5-unavailable',
      error_code: 'EVIDENCE_SEARCH_FTS5_UNAVAILABLE',
    };
  } finally {
    try { db?.close(); } catch { /* capability probe is best effort */ }
  }
  return sqliteCapability;
}

export function evidenceSearchSqliteAvailable() {
  return detectSqliteCapability().available;
}

function cleanupSqliteCandidate(vaultBase, path) {
  try { unlinkVaultFile(vaultBase, `${path}-journal`, { label: 'journal temporário FTS' }); } catch { /* best effort */ }
  try { unlinkVaultFile(vaultBase, `${path}-wal`, { label: 'WAL temporário FTS' }); } catch { /* best effort */ }
  try { unlinkVaultFile(vaultBase, `${path}-shm`, { label: 'SHM temporário FTS' }); } catch { /* best effort */ }
  try { unlinkVaultFile(vaultBase, path, { label: 'SQLite temporário FTS' }); } catch { /* best effort */ }
}

function buildSqliteArtifact(vaultBase, rows, indexHash, { required = false } = {}) {
  const capability = detectSqliteCapability();
  if (!capability.available) {
    if (required) {
      const error = new Error(capability.reason === 'node-sqlite-unavailable'
        ? 'node:sqlite is unavailable; evidence FTS requires a compatible Node.js runtime'
        : 'the current node:sqlite build does not include FTS5; evidence search will use the lexical backend');
      error.code = capability.error_code;
      throw error;
    }
    return { artifact: null, written: false, reason: capability.reason };
  }
  const { DatabaseSync } = capability;

  const candidate = join(searchDir(vaultBase), `.fts-${indexHash.slice(0, 20)}-${randomUUID()}.tmp.sqlite`);
  assertVaultPathSafe(vaultBase, candidate, {
    expectedType: 'file',
    mustNotExist: true,
    label: 'candidate SQLite FTS',
  });
  let db = null;
  try {
    db = new DatabaseSync(candidate, { open: true });
    db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = MEMORY;
      CREATE TABLE evidence_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE evidence_rows (
        chunk_id TEXT PRIMARY KEY,
        logical_path TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        authority TEXT NOT NULL,
        validity TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        project_id TEXT NOT NULL,
        change_slug TEXT NOT NULL,
        session_id TEXT NOT NULL,
        work_session_id TEXT NOT NULL,
        row_json TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE VIRTUAL TABLE evidence_fts USING fts5(
        chunk_id UNINDEXED,
        title,
        heading,
        logical_path,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    const insertMeta = db.prepare('INSERT INTO evidence_meta(key, value) VALUES (?, ?)');
    const insertRow = db.prepare(`
      INSERT INTO evidence_rows(
        chunk_id, logical_path, ordinal, authority, validity, entity_type, project_id,
        change_slug, session_id, work_session_id, row_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(`
      INSERT INTO evidence_fts(chunk_id, title, heading, logical_path, content)
      VALUES (?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      insertMeta.run('schema_version', String(EVIDENCE_SEARCH_STATE_VERSION));
      insertMeta.run('index_hash', indexHash);
      insertMeta.run('row_count', String(rows.length));
      for (const row of rows) {
        insertRow.run(
          row.chunk_id,
          row.logical_path,
          row.ordinal,
          String(row.authority || ''),
          String(row.validity || ''),
          String(row.entity_type || ''),
          String(row.project_id || ''),
          String(row.change_slug || ''),
          String(row.session_id || ''),
          String(row.work_session_id || ''),
          JSON.stringify(row),
        );
        insertFts.run(
          row.chunk_id,
          String(row.title || ''),
          String(row.heading || ''),
          row.logical_path,
          row.content,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
    db.close();
    db = null;

    const checkedCandidate = safeFile(vaultBase, candidate, 'candidate SQLite FTS', { allowMissing: false });
    const bytes = readFileSync(checkedCandidate.target);
    const contentHash = sha256(bytes);
    const relativePath = `${SEARCH_DIRECTORY}/fts-${indexHash.slice(0, 20)}-${contentHash.slice(0, 20)}.sqlite`;
    const finalPath = join(brainDir(vaultBase), relativePath);
    const existing = readSafeFile(vaultBase, finalPath, 'artefato SQLite FTS', null);
    let written = false;
    if (existing === null) {
      try {
        renameVaultPath(vaultBase, candidate, finalPath, {
          sourceType: 'file',
          label: 'publicação do SQLite FTS',
        });
        written = true;
      } catch (error) {
        const raced = readSafeFile(vaultBase, finalPath, 'artefato SQLite FTS concorrente', null);
        if (raced === null || sha256(raced) !== contentHash) throw error;
        cleanupSqliteCandidate(vaultBase, candidate);
      }
    } else {
      if (sha256(existing) !== contentHash) {
        const error = new Error(`content-addressed SQLite artifact diverges: ${relativePath}`);
        error.code = 'EVIDENCE_SEARCH_ARTIFACT_DIVERGED';
        throw error;
      }
      cleanupSqliteCandidate(vaultBase, candidate);
    }
    return {
      artifact: {
        kind: 'sqlite',
        path: relativePath,
        hash: contentHash,
        fingerprint: fileFingerprint(vaultBase, finalPath, 'artefato SQLite FTS'),
      },
      written,
      reason: '',
    };
  } catch (error) {
    try { db?.close(); } catch { /* ignore */ }
    cleanupSqliteCandidate(vaultBase, candidate);
    if (required) throw error;
    return { artifact: null, written: false, reason: error?.code || 'sqlite-build-failed' };
  }
}

function normalizeSqliteMode(value) {
  const mode = String(value ?? 'auto').trim().toLowerCase();
  if (!['auto', 'off', 'required'].includes(mode)) {
    throw new TypeError('evidence search sqlite mode must be auto, off, or required');
  }
  return mode;
}

function renderState({ indexHash, rowCount, source, lexical, sqlite }) {
  return `${JSON.stringify({
    schema_version: EVIDENCE_SEARCH_STATE_VERSION,
    index_hash: indexHash,
    row_count: rowCount,
    source,
    lexical,
    sqlite,
  }, null, 2)}\n`;
}

export function refreshEvidenceSearchIndex(vaultBase, rows, {
  force = false,
  sqlite = 'auto',
} = {}) {
  const sqliteMode = normalizeSqliteMode(sqlite);
  mkdirVaultPath(vaultBase, brainDir(vaultBase), { label: 'raiz .brain da busca de evidências' });
  mkdirVaultPath(vaultBase, searchDir(vaultBase), { label: 'diretório de artefatos da busca de evidências' });
  const source = currentSource(vaultBase);
  if (source.index === null) {
    const error = new Error('EVIDENCE_INDEX.jsonl is required before building the search index');
    error.code = 'EVIDENCE_SEARCH_SOURCE_MISSING';
    throw error;
  }

  const previous = loadEvidenceSearchState(vaultBase);
  if (!force && stateCurrent(vaultBase, previous)
      && (sqliteMode !== 'required' || previous.sqlite !== null)) {
    return {
      state: previous,
      reused: true,
      lexical_written: false,
      sqlite_written: false,
      sqlite_available: previous.sqlite !== null,
      sqlite_reason: previous.sqlite ? '' : 'not-built',
    };
  }

  const canonical = canonicalRows(rows);
  const indexHash = sha256(canonical.map((row) => stableJson(row)).join('\n'));
  const lexicalValue = buildLexicalArtifact(canonical, indexHash);
  const lexicalContent = lexicalFileContent(lexicalValue);
  const lexicalResult = writeContentAddressedText(
    vaultBase,
    'lexical',
    indexHash,
    lexicalContent,
  );
  const sqliteResult = sqliteMode === 'off'
    ? { artifact: null, written: false, reason: 'disabled' }
    : buildSqliteArtifact(vaultBase, canonical, indexHash, { required: sqliteMode === 'required' });
  const stateContent = renderState({
    indexHash,
    rowCount: canonical.length,
    source,
    lexical: lexicalResult.artifact,
    sqlite: sqliteResult.artifact,
  });
  const currentState = readSafeFile(vaultBase, searchStatePath(vaultBase), 'estado do índice de busca');
  const stateWritten = currentState !== stateContent;
  if (stateWritten) {
    writeVaultFileAtomic(
      vaultBase,
      searchStatePath(vaultBase),
      stateContent,
      'utf8',
      { label: 'estado do índice de busca de evidências' },
    );
  }
  const state = loadEvidenceSearchState(vaultBase);
  if (!state || !stateCurrent(vaultBase, state)) {
    const error = new Error('published evidence search state did not validate');
    error.code = 'EVIDENCE_SEARCH_STATE_INVALID';
    throw error;
  }
  lexicalCache.set(state.lexical.path, lexicalValue);
  return {
    state,
    reused: false,
    state_written: stateWritten,
    lexical_written: lexicalResult.written,
    sqlite_written: sqliteResult.written,
    sqlite_available: Boolean(sqliteResult.artifact),
    sqlite_reason: sqliteResult.reason,
  };
}

function loadLexical(vaultBase, state) {
  const cacheKey = `${state.lexical.path}:${state.lexical.fingerprint.mtime_ns}:${state.lexical.fingerprint.size}`;
  const cached = lexicalCache.get(cacheKey) || lexicalCache.get(state.lexical.path);
  if (cached && validateLexicalArtifact(cached, state)) return cached;
  const raw = readSafeFile(vaultBase, artifactPath(vaultBase, state.lexical), 'artefato lexical da busca');
  if (raw === null || sha256(raw) !== state.lexical.hash) {
    const error = new Error('evidence lexical search artifact hash mismatch');
    error.code = 'EVIDENCE_SEARCH_ARTIFACT_DIVERGED';
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    const error = new Error('evidence lexical search artifact is invalid JSON');
    error.code = 'EVIDENCE_SEARCH_ARTIFACT_INVALID';
    throw error;
  }
  if (!validateLexicalArtifact(parsed, state)) {
    const error = new Error('evidence lexical search artifact failed validation');
    error.code = 'EVIDENCE_SEARCH_ARTIFACT_INVALID';
    throw error;
  }
  lexicalCache.set(cacheKey, parsed);
  return parsed;
}

function ensureSearchState(vaultBase, { sqlite = 'auto' } = {}) {
  const state = loadEvidenceSearchState(vaultBase);
  if (stateCurrent(vaultBase, state)) return { state, rebuilt: false, ephemeral: null };
  const rows = loadEvidenceIndex(vaultBase);
  if (!rows.length) return { state: null, rebuilt: false, ephemeral: buildLexicalArtifact([], sha256('')) };
  try {
    const refreshed = refreshEvidenceSearchIndex(vaultBase, rows, { force: true, sqlite });
    return { state: refreshed.state, rebuilt: true, ephemeral: null };
  } catch (error) {
    const canonical = canonicalRows(rows);
    const indexHash = sha256(canonical.map((row) => stableJson(row)).join('\n'));
    return {
      state: null,
      rebuilt: false,
      ephemeral: buildLexicalArtifact(canonical, indexHash),
      fallback_reason: error?.code || 'search-index-rebuild-failed',
    };
  }
}

function normalizeCandidateLimit(value) {
  const limit = Number(value ?? EVIDENCE_SEARCH_DEFAULT_CANDIDATES);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVIDENCE_SEARCH_MAX_CANDIDATES) {
    throw new RangeError(`evidence search candidateLimit must be between 1 and ${EVIDENCE_SEARCH_MAX_CANDIDATES}`);
  }
  return limit;
}

function normalizePostingBudget(value) {
  const budget = Number(value ?? EVIDENCE_SEARCH_DEFAULT_POSTING_BUDGET);
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > EVIDENCE_SEARCH_MAX_POSTING_BUDGET) {
    throw new RangeError(`evidence search postingBudget must be between 1 and ${EVIDENCE_SEARCH_MAX_POSTING_BUDGET}`);
  }
  return budget;
}

function normalizeBackend(value) {
  const backend = String(value ?? 'auto').trim().toLowerCase();
  if (!['auto', 'sqlite', 'lexical'].includes(backend)) {
    throw new TypeError('evidence search backend must be auto, sqlite, or lexical');
  }
  return backend;
}

function ftsQuery(query) {
  return [...new Set(recallTerms(query))]
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' OR ');
}

const SQL_FIELDS = new Map([
  ['authority', 'authority'],
  ['validity', 'validity'],
  ['entity_type', 'entity_type'],
  ['project_id', 'project_id'],
  ['change_slug', 'change_slug'],
  ['session_id', 'session_id'],
  ['work_session_id', 'work_session_id'],
  ['logical_path', 'logical_path'],
]);

function escapeLike(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function sqlFilterClause(filters) {
  const clauses = [];
  const parameters = [];
  for (const [field, column] of SQL_FIELDS) {
    const values = filters[field];
    if (!values?.length) continue;
    clauses.push(`r.${column} IN (${values.map(() => '?').join(', ')})`);
    parameters.push(...values);
  }
  if (filters.logical_path_prefix?.length) {
    clauses.push(`(${filters.logical_path_prefix.map(() => "r.logical_path LIKE ? ESCAPE '\\'").join(' OR ')})`);
    parameters.push(...filters.logical_path_prefix.map((prefix) => `${escapeLike(prefix)}%`));
  }
  return {
    sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
    parameters,
  };
}

function searchSqlite(vaultBase, state, query, filters, candidateLimit, postingBudget) {
  const DatabaseSync = sqliteDatabaseSync();
  if (!DatabaseSync || !state.sqlite) {
    const error = new Error('SQLite FTS backend is unavailable');
    error.code = 'EVIDENCE_SEARCH_SQLITE_UNAVAILABLE';
    throw error;
  }
  const expression = ftsQuery(query);
  if (!expression) return { rows: [], posting_entries: 0, has_more: false };
  const path = artifactPath(vaultBase, state.sqlite);
  safeFile(vaultBase, path, 'artefato SQLite FTS', { allowMissing: false });
  let db = null;
  try {
    db = new DatabaseSync(path, { open: true });
    db.exec('PRAGMA query_only = ON');
    const indexHash = db.prepare("SELECT value FROM evidence_meta WHERE key = 'index_hash'").get()?.value;
    const rowCount = Number(db.prepare("SELECT value FROM evidence_meta WHERE key = 'row_count'").get()?.value);
    if (indexHash !== state.index_hash || rowCount !== state.row_count) {
      const error = new Error('SQLite FTS metadata does not match the search state');
      error.code = 'EVIDENCE_SEARCH_ARTIFACT_DIVERGED';
      throw error;
    }
    const filter = sqlFilterClause(filters);
    const matches = db.prepare(`
      SELECT r.row_json,
             bm25(evidence_fts, 0.0, 4.0, 3.0, 2.0, 1.0) AS fts_rank
      FROM evidence_fts
      JOIN evidence_rows r ON r.chunk_id = evidence_fts.chunk_id
      WHERE evidence_fts MATCH ?${filter.sql}
      ORDER BY fts_rank ASC, r.logical_path ASC, r.ordinal ASC, r.chunk_id ASC
      LIMIT ?
    `).all(expression, ...filter.parameters, postingBudget);
    const rows = matches.slice(0, candidateLimit).map((match) => JSON.parse(match.row_json));
    if (!rows.every(validEvidenceRow)) {
      const error = new Error('SQLite FTS returned an invalid evidence row');
      error.code = 'EVIDENCE_SEARCH_ARTIFACT_INVALID';
      throw error;
    }
    return {
      rows,
      posting_entries: matches.length,
      has_more: matches.length > candidateLimit || matches.length === postingBudget,
    };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function searchLexical(artifact, query, filters, candidateLimit, postingBudget) {
  const terms = [...new Set(recallTerms(query))];
  if (!terms.length || !artifact.rows.length) {
    return { rows: [], posting_entries: 0, has_more: false };
  }
  const allowedRows = filterEvidenceRecallRows(artifact.rows, filters);
  const allowed = new Set(allowedRows.map((row) => row.chunk_id));
  const scores = new Map();
  let postingEntries = 0;
  let truncated = false;
  for (const term of terms) {
    const entries = artifact.postings[term] || [];
    const idf = Math.log(1 + artifact.row_count / Math.max(1, entries.length));
    for (const [rowIndex, weight] of entries) {
      if (postingEntries >= postingBudget) { truncated = true; break; }
      postingEntries += 1;
      const row = artifact.rows[rowIndex];
      if (!allowed.has(row.chunk_id)) continue;
      scores.set(rowIndex, (scores.get(rowIndex) || 0) + weight * idf);
    }
    if (postingEntries >= postingBudget) break;
  }
  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]
    || compareText(artifact.rows[left[0]].logical_path, artifact.rows[right[0]].logical_path)
    || artifact.rows[left[0]].ordinal - artifact.rows[right[0]].ordinal
    || compareText(artifact.rows[left[0]].chunk_id, artifact.rows[right[0]].chunk_id));
  return {
    rows: ranked.slice(0, candidateLimit).map(([rowIndex]) => artifact.rows[rowIndex]),
    posting_entries: postingEntries,
    has_more: truncated || ranked.length > candidateLimit,
  };
}

export function searchEvidenceCandidates(vaultBase, query, {
  candidateLimit: requestedCandidateLimit,
  postingBudget: requestedPostingBudget,
  filters = {},
  backend: requestedBackend = 'auto',
  sqlite = 'auto',
} = {}) {
  const candidateLimit = normalizeCandidateLimit(requestedCandidateLimit);
  const postingBudget = normalizePostingBudget(requestedPostingBudget);
  const backend = normalizeBackend(requestedBackend);
  const normalizedFilters = normalizeEvidenceRecallFilters(filters);
  const ensured = ensureSearchState(vaultBase, { sqlite });
  if (!ensured.state && !ensured.ephemeral) {
    return {
      rows: [],
      backend: 'empty',
      candidate_count: 0,
      posting_entries: 0,
      has_more: false,
      rebuilt: ensured.rebuilt,
      fallback_reason: ensured.fallback_reason || '',
      index_hash: '',
    };
  }

  let fallbackReason = ensured.fallback_reason || '';
  if (backend !== 'lexical' && ensured.state?.sqlite) {
    try {
      const result = searchSqlite(
        vaultBase,
        ensured.state,
        query,
        normalizedFilters,
        candidateLimit,
        postingBudget,
      );
      return {
        ...result,
        backend: 'sqlite-fts5',
        candidate_count: result.rows.length,
        rebuilt: ensured.rebuilt,
        fallback_reason: fallbackReason,
        index_hash: ensured.state.index_hash,
      };
    } catch (error) {
      if (backend === 'sqlite') throw error;
      fallbackReason = error?.code || 'sqlite-query-failed';
    }
  } else if (backend === 'sqlite') {
    const error = new Error('SQLite FTS backend is unavailable');
    error.code = 'EVIDENCE_SEARCH_SQLITE_UNAVAILABLE';
    throw error;
  }

  let lexical = ensured.ephemeral;
  if (!lexical && ensured.state) {
    try {
      lexical = loadLexical(vaultBase, ensured.state);
    } catch (error) {
      const rows = loadEvidenceIndex(vaultBase);
      const canonical = canonicalRows(rows);
      const indexHash = sha256(canonical.map((row) => stableJson(row)).join('\n'));
      lexical = buildLexicalArtifact(canonical, indexHash);
      fallbackReason = error?.code || 'lexical-artifact-invalid';
    }
  }
  const result = searchLexical(
    lexical,
    query,
    normalizedFilters,
    candidateLimit,
    postingBudget,
  );
  return {
    ...result,
    backend: ensured.state ? 'lexical-sidecar' : 'lexical-ephemeral',
    candidate_count: result.rows.length,
    rebuilt: ensured.rebuilt,
    fallback_reason: fallbackReason,
    index_hash: lexical.index_hash,
  };
}

export function recallEvidenceIndexed(vaultBase, query, {
  topK = 5,
  now = Date.now(),
  candidateLimit = EVIDENCE_SEARCH_DEFAULT_CANDIDATES,
  postingBudget = EVIDENCE_SEARCH_DEFAULT_POSTING_BUDGET,
  filters = {},
  backend = 'auto',
  sqlite = 'auto',
} = {}) {
  const candidates = searchEvidenceCandidates(vaultBase, query, {
    candidateLimit,
    postingBudget,
    filters,
    backend,
    sqlite,
  });
  return {
    results: recallEvidence(candidates.rows, query, { topK, now }),
    metrics: {
      backend: candidates.backend,
      index_hash: candidates.index_hash,
      candidate_count: candidates.candidate_count,
      posting_entries: candidates.posting_entries,
      has_more_candidates: candidates.has_more,
      rebuilt: candidates.rebuilt,
      fallback_reason: candidates.fallback_reason,
    },
  };
}
