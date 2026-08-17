import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export const MEMORY_SCHEMA_VERSION = 1;
export const MEMORY_EVENTS_FILE = 'MEMORY_EVENTS.jsonl';
export const MEMORY_INDEX_FILE = 'MEMORY_INDEX.json';
export const MEMORY_ROOT = 'memory';
export const MAX_MEMORY_CONTENT_BYTES = 2 * 1024 * 1024;
export const MEMORY_MODES = new Set(['mirror', 'container-read', 'container-authority']);

const ENTITY_TYPES = new Set(['session', 'decision', 'bug', 'learning', 'spec', 'change', 'memory']);
const OPERATIONS = new Set(['upsert', 'delete']);
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/;
const ROOTS = [
  '02-Sessões/',
  '04-Decisões/',
  '05-Bugs/',
  '06-Aprendizados/',
  '07-Specs/',
  '08-Mudanças/',
  '.brain/',
];
const ROOT_FILES = new Set(['CORE.md', 'DIGEST.md', 'SHARED_MEMORY.md']);

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

function atomicJson(path, value) {
  const temp = path + '.' + process.pid + '.' + Date.now() + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(temp, path);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function ensureDataDir(dataDir) {
  if (!dataDir) throw new Error('dataDir é obrigatório.');
  mkdirSync(dataDir, { recursive: true });
}

function projectIdValid(projectId) {
  return typeof projectId === 'string' && PROJECT_ID_RE.test(projectId);
}

function normalizedLogicalPath(value) {
  const original = String(value ?? '');
  const normalized = original.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || /^[A-Za-z]:\//.test(normalized) || original.startsWith('/') || original.startsWith('\\')) {
    return '';
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return '';
  if (!(ROOT_FILES.has(normalized) || ROOTS.some((root) => normalized.startsWith(root)))) return '';
  return normalized;
}

function memoryFilePath(dataDir, projectId, logicalPath) {
  const base = join(dataDir, MEMORY_ROOT, projectId);
  const target = join(base, ...logicalPath.split('/'));
  const rel = relative(base, target);
  if (rel.startsWith('..' + sep) || rel === '..' || /^[A-Za-z]:/.test(rel)) {
    throw new Error('logical_path fora do projeto.');
  }
  return target;
}

function defaultIndex() {
  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    projects: {},
  };
}

function loadIndex(dataDir) {
  ensureDataDir(dataDir);
  const index = readJson(join(dataDir, MEMORY_INDEX_FILE), null);
  if (index?.schema_version === MEMORY_SCHEMA_VERSION && index.projects && typeof index.projects === 'object') {
    return index;
  }
  return defaultIndex();
}

function saveIndex(dataDir, index) {
  index.generated_at = new Date().toISOString();
  atomicJson(join(dataDir, MEMORY_INDEX_FILE), index);
}

function readEventLines(dataDir) {
  const path = join(dataDir, MEMORY_EVENTS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function projectState(index, projectId) {
  if (!index.projects[projectId]) {
    index.projects[projectId] = {
      project_id: projectId,
      mode: 'mirror',
      documents: {},
      event_count: 0,
      conflict_count: 0,
      last_event_at: '',
    };
  }
  return index.projects[projectId];
}

function eventPayload(event) {
  const clone = { ...event };
  delete clone.event_id;
  return JSON.stringify(clone);
}

export function validateMemoryEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, errors: ['evento deve ser um objeto JSON.'] };
  }
  if (event.schema_version !== MEMORY_SCHEMA_VERSION) errors.push('schema_version incompatível.');
  if (typeof event.event_id !== 'string' || !event.event_id.trim()) errors.push('event_id ausente.');
  if (!projectIdValid(event.project_id)) errors.push('project_id inválido.');
  if (!ENTITY_TYPES.has(event.entity_type)) errors.push('entity_type inválido.');
  const path = normalizedLogicalPath(event.logical_path);
  if (!path) errors.push('logical_path inválido ou fora das raízes autorizadas.');
  if (!OPERATIONS.has(event.operation)) errors.push('operation inválida.');
  if (!Number.isInteger(event.revision) || event.revision < 1) errors.push('revision inválida.');
  if (typeof event.content_hash !== 'string' || !/^[a-f0-9]{64}$/.test(event.content_hash)) {
    errors.push('content_hash inválido.');
  }
  if (typeof event.captured_at !== 'string' || Number.isNaN(Date.parse(event.captured_at))) {
    errors.push('captured_at inválido.');
  }
  if (event.operation === 'upsert') {
    if (typeof event.content !== 'string') errors.push('content ausente.');
    else {
      if (Buffer.byteLength(event.content, 'utf8') > MAX_MEMORY_CONTENT_BYTES) errors.push('content excede o limite.');
      if (event.content_hash !== hashContent(event.content)) errors.push('content_hash não corresponde ao conteúdo.');
    }
  }
  return { ok: errors.length === 0, errors, logical_path: path };
}

export function applyMemoryEvent(dataDir, event) {
  ensureDataDir(dataDir);
  const validation = validateMemoryEvent(event);
  if (!validation.ok) return { accepted: false, errors: validation.errors };
  const index = loadIndex(dataDir);
  const state = projectState(index, event.project_id);
  const existingEvent = readEventLines(dataDir).find((item) => item.event_id === event.event_id);
  if (existingEvent) {
    if (eventPayload(existingEvent) === eventPayload(event)) {
      return { accepted: false, duplicate: true, event_id: event.event_id };
    }
    state.conflict_count += 1;
    saveIndex(dataDir, index);
    return { accepted: false, conflict: true, errors: ['event_id reutilizado com payload diferente.'] };
  }

  const current = state.documents[validation.logical_path];
  if (current && event.revision < current.revision) {
    state.conflict_count += 1;
    saveIndex(dataDir, index);
    return { accepted: false, conflict: true, stale: true, errors: ['revisão antiga não pode substituir a atual.'] };
  }
  if (current && event.revision === current.revision && current.content_hash !== event.content_hash) {
    state.conflict_count += 1;
    saveIndex(dataDir, index);
    return { accepted: false, conflict: true, errors: ['revisão já possui conteúdo diferente.'] };
  }

  const path = memoryFilePath(dataDir, event.project_id, validation.logical_path);
  if (event.operation === 'delete') {
    rmSync(path, { force: true });
    delete state.documents[validation.logical_path];
  } else {
    mkdirSync(dirname(path), { recursive: true });
    const temp = path + '.' + process.pid + '.' + Date.now() + '.tmp';
    writeFileSync(temp, event.content, 'utf8');
    renameSync(temp, path);
    state.documents[validation.logical_path] = {
      project_id: event.project_id,
      logical_path: validation.logical_path,
      entity_type: event.entity_type,
      content_hash: event.content_hash,
      revision: event.revision,
      source_session_id: String(event.source_session_id || ''),
      source_turn_id: String(event.source_turn_id || ''),
      captured_at: event.captured_at,
      bytes: Buffer.byteLength(event.content, 'utf8'),
    };
  }
  appendFileSync(join(dataDir, MEMORY_EVENTS_FILE), JSON.stringify(event) + '\n', 'utf8');
  state.event_count += 1;
  state.last_event_at = event.captured_at;
  saveIndex(dataDir, index);
  return { accepted: true, duplicate: false, event_id: event.event_id, document: state.documents[validation.logical_path] || null };
}

export function readMemoryTree(dataDir, projectId, prefix = '') {
  const index = loadIndex(dataDir);
  const state = index.projects[projectId] || projectState(index, projectId);
  const normalizedPrefix = String(prefix || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  const documents = Object.values(state.documents)
    .filter((item) => !normalizedPrefix || item.logical_path.startsWith(normalizedPrefix + '/') || item.logical_path === normalizedPrefix)
    .sort((a, b) => a.logical_path.localeCompare(b.logical_path));
  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    project_id: projectId,
    documents,
    document_count: documents.length,
    categories: [...new Set(documents.map((item) => item.logical_path.split('/')[0]))].sort(),
  };
}

export function setMemoryMode(dataDir, projectId, mode) {
  if (!MEMORY_MODES.has(mode)) {
    const error = new Error('modo de memória inválido.');
    error.code = 'invalid_memory_mode';
    throw error;
  }
  const index = loadIndex(dataDir);
  const state = projectState(index, projectId);
  state.mode = mode;
  saveIndex(dataDir, index);
  return readMemorySync(dataDir, projectId);
}

export function readMemoryDocument(dataDir, projectId, logicalPath) {
  const path = normalizedLogicalPath(logicalPath);
  if (!projectIdValid(projectId) || !path) {
    const error = new Error('documento inválido.');
    error.code = 'invalid_memory_path';
    throw error;
  }
  const index = loadIndex(dataDir);
  const metadata = index.projects[projectId]?.documents?.[path];
  if (!metadata) {
    const error = new Error('documento não encontrado.');
    error.code = 'memory_not_found';
    throw error;
  }
  return { ...metadata, content: readFileSync(memoryFilePath(dataDir, projectId, path), 'utf8') };
}

export function exportMemoryBundle(dataDir, projectId) {
  const tree = readMemoryTree(dataDir, projectId);
  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    project_id: projectId,
    mode: readMemorySync(dataDir, projectId).mode,
    documents: tree.documents.map((metadata) => ({
      ...metadata,
      content: readMemoryDocument(dataDir, projectId, metadata.logical_path).content,
    })),
  };
}

export function searchMemory(dataDir, projectId, query) {
  const term = String(query || '').trim().toLowerCase();
  if (!term) return [];
  return readMemoryTree(dataDir, projectId).documents.flatMap((metadata) => {
    let content;
    try { content = readFileSync(memoryFilePath(dataDir, projectId, metadata.logical_path), 'utf8'); } catch { return []; }
    const haystack = metadata.logical_path + '\n' + content;
    const at = haystack.toLowerCase().indexOf(term);
    if (at < 0) return [];
    const start = Math.max(0, at - 80);
    return [{ ...metadata, excerpt: haystack.slice(start, start + 240).replace(/\s+/g, ' ').trim() }];
  });
}

export function readMemorySync(dataDir, projectId) {
  const index = loadIndex(dataDir);
  const state = index.projects[projectId] || projectState(index, projectId);
  return {
    project_id: projectId,
    mode: state.mode || 'mirror',
    document_count: Object.keys(state.documents).length,
    event_count: Number(state.event_count || 0),
    conflict_count: Number(state.conflict_count || 0),
    pending_count: 0,
    last_event_at: state.last_event_at || '',
  };
}
