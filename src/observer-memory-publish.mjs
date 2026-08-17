import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { MAX_MEMORY_CONTENT_BYTES } from './observer-memory.mjs';

export const MEMORY_OUTBOX_REL = '.brain/observer-memory-outbox';
export const MEMORY_STATE_FILE = '.brain/observer-memory-state.json';
const MEMORY_SCHEMA_VERSION = 1;
const ROOT_FILES = new Set(['CORE.md', 'DIGEST.md', 'SHARED_MEMORY.md']);
const ROOTS = [
  '02-Sessões',
  '04-Decisões',
  '05-Bugs',
  '06-Aprendizados',
  '07-Specs',
  '08-Mudanças',
  '.brain',
];
const TRANSIENT_NAMES = new Set(['observer-memory-outbox', 'observer-outbox']);

function isoNow(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('captured_at inválido.');
  return date.toISOString();
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function atomicJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = path + '.' + process.pid + '.' + Date.now() + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(temp, path);
}

function readState(vaultBase) {
  return readJson(join(vaultBase, MEMORY_STATE_FILE), {
    schema_version: MEMORY_SCHEMA_VERSION,
    files: {},
  });
}

function entityType(logicalPath) {
  if (logicalPath.startsWith('02-Sessões/')) return 'session';
  if (logicalPath.startsWith('04-Decisões/')) return 'decision';
  if (logicalPath.startsWith('05-Bugs/')) return 'bug';
  if (logicalPath.startsWith('06-Aprendizados/')) return 'learning';
  if (logicalPath.startsWith('07-Specs/')) return 'spec';
  if (logicalPath.startsWith('08-Mudanças/')) return 'change';
  return 'memory';
}

function shouldSkip(name, relativePath) {
  if (TRANSIENT_NAMES.has(name) || name.endsWith('.tmp') || name.endsWith('.lock')) return true;
  if (relativePath === MEMORY_STATE_FILE) return true;
  return false;
}

function walkDirectory(root, relativeRoot, output) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const logicalPath = relativeRoot ? relativeRoot + '/' + entry.name : entry.name;
    if (shouldSkip(entry.name, logicalPath)) continue;
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(absolute, logicalPath, output);
    } else if (entry.isFile()) {
      output.push({ absolute, logicalPath });
    }
  }
}

function memoryFiles(vaultBase) {
  const files = [];
  for (const root of ROOTS) {
    const absolute = join(vaultBase, root);
    if (root === '.brain' || root.includes('-')) walkDirectory(absolute, root, files);
  }
  for (const rootFile of ROOT_FILES) {
    const absolute = join(vaultBase, rootFile);
    if (existsSync(absolute) && statSync(absolute).isFile()) files.push({ absolute, logicalPath: rootFile });
  }
  return files.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
}

export function localMemoryManifest(vaultBase) {
  return Object.fromEntries(memoryFiles(vaultBase).map((file) => {
    const content = readFileSync(file.absolute, 'utf8');
    return [file.logicalPath, {
      logical_path: file.logicalPath,
      content_hash: hash(content),
      bytes: Buffer.byteLength(content, 'utf8'),
    }];
  }));
}

function projectIdFromVault(vaultBase) {
  const project = readJson(join(vaultBase, '.brain', 'PROJECT.json'), null);
  return project?.projectId || project?.project_id || '';
}

function eventId(projectId, logicalPath, revision, contentHash) {
  return 'mem-' + hash([projectId, logicalPath, revision, contentHash].join(':')).slice(0, 24);
}

function makeEvent({ projectId, logicalPath, content, revision, sourceSessionId, sourceTurnId, capturedAt, operation = 'upsert' }) {
  const body = content || '';
  const contentHash = hash(body);
  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    event_id: eventId(projectId, logicalPath, revision, contentHash),
    project_id: projectId,
    entity_type: entityType(logicalPath),
    logical_path: logicalPath,
    operation,
    ...(operation === 'upsert' ? { content: body } : {}),
    content_hash: contentHash,
    revision,
    source_session_id: String(sourceSessionId || ''),
    source_turn_id: String(sourceTurnId || ''),
    captured_at: capturedAt,
  };
}

export function buildMemoryEventBatch({
  vaultBase,
  projectId = projectIdFromVault(vaultBase),
  sourceSessionId = '',
  sourceTurnId = '',
  now = new Date(),
  state = readState(vaultBase),
} = {}) {
  if (!vaultBase || !projectId) throw new Error('vaultBase e projectId são obrigatórios.');
  const capturedAt = isoNow(now);
  const currentFiles = memoryFiles(vaultBase);
  const currentPaths = new Set(currentFiles.map((file) => file.logicalPath));
  const nextState = {
    schema_version: MEMORY_SCHEMA_VERSION,
    files: { ...(state.files || {}) },
  };
  const events = [];

  for (const file of currentFiles) {
    const content = readFileSync(file.absolute, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_CONTENT_BYTES) {
      throw new Error('arquivo excede o limite de memória: ' + file.logicalPath);
    }
    const contentHash = hash(content);
    const previous = state.files?.[file.logicalPath];
    if (previous?.content_hash === contentHash) {
      nextState.files[file.logicalPath] = previous;
      continue;
    }
    const revision = Number(previous?.revision || 0) + 1;
    const next = { content_hash: contentHash, revision, event_id: eventId(projectId, file.logicalPath, revision, contentHash) };
    nextState.files[file.logicalPath] = next;
    events.push(makeEvent({
      projectId,
      logicalPath: file.logicalPath,
      content,
      revision,
      sourceSessionId,
      sourceTurnId,
      capturedAt,
    }));
  }

  for (const [logicalPath, previous] of Object.entries(state.files || {})) {
    if (currentPaths.has(logicalPath)) continue;
    const revision = Number(previous.revision || 0) + 1;
    events.push(makeEvent({
      projectId,
      logicalPath,
      content: '',
      revision,
      sourceSessionId,
      sourceTurnId,
      capturedAt,
      operation: 'delete',
    }));
    delete nextState.files[logicalPath];
  }

  return { events, nextState, scanned: currentFiles.length, changed: events.length };
}

export function commitMemoryPublishState(vaultBase, state) {
  atomicJson(join(vaultBase, MEMORY_STATE_FILE), state);
}

function outboxDir(vaultBase) {
  return join(vaultBase, MEMORY_OUTBOX_REL);
}

function outboxPath(vaultBase, events) {
  const id = hash(JSON.stringify(events)).slice(0, 24);
  return join(outboxDir(vaultBase), id + '.json');
}

function queueMemoryBatch(vaultBase, events) {
  mkdirSync(outboxDir(vaultBase), { recursive: true });
  const path = outboxPath(vaultBase, events);
  if (!existsSync(path)) atomicJson(path, { schema_version: MEMORY_SCHEMA_VERSION, events });
  return path;
}

export function listMemoryOutbox(vaultBase) {
  const dir = outboxDir(vaultBase);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
}

async function postBatch(url, projectId, events, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(
    String(url).replace(/\/$/, '') + '/v1/projects/' + encodeURIComponent(projectId) + '/memory/events',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ events }),
    },
  );
  if (!response.ok) throw new Error('Observer respondeu HTTP ' + response.status + '.');
  return response.json();
}

export async function retryObserverMemoryOutbox({
  vaultBase,
  projectId = projectIdFromVault(vaultBase),
  url,
  fetchImpl = globalThis.fetch,
} = {}) {
  const files = listMemoryOutbox(vaultBase);
  if (!url) return { attempted: 0, confirmed: 0, pending: files.length };
  let attempted = 0;
  let confirmed = 0;
  for (const path of files) {
    attempted += 1;
    try {
      const batch = readJson(path, null);
      if (!batch?.events?.length) {
        unlinkSync(path);
        continue;
      }
      await postBatch(url, projectId, batch.events, fetchImpl);
      unlinkSync(path);
      confirmed += 1;
    } catch {
      break;
    }
  }
  return { attempted, confirmed, pending: listMemoryOutbox(vaultBase).length };
}

export async function compareMemoryParity({
  vaultBase,
  projectId = projectIdFromVault(vaultBase),
  url,
  fetchImpl = globalThis.fetch,
} = {}) {
  const response = await fetchImpl(
    String(url).replace(/\/$/, '') + '/v1/projects/' + encodeURIComponent(projectId) + '/memory/tree',
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) throw new Error('Observer respondeu HTTP ' + response.status + '.');
  const body = await response.json();
  const local = localMemoryManifest(vaultBase);
  const remote = Object.fromEntries((body.documents || []).map((item) => [item.logical_path, item]));
  const missing = Object.keys(local).filter((path) => !remote[path]);
  const mismatched = Object.keys(local).filter((path) => remote[path] && remote[path].content_hash !== local[path].content_hash);
  const extra = Object.keys(remote).filter((path) => !local[path]);
  return {
    files: Object.keys(local).length,
    remote_files: Object.keys(remote).length,
    missing: missing.length,
    mismatched: mismatched.length,
    extra: extra.length,
    missing_paths: missing,
    mismatched_paths: mismatched,
    extra_paths: extra,
  };
}

export async function publishObserverMemory({
  vaultBase,
  projectId = projectIdFromVault(vaultBase),
  url,
  sourceSessionId = '',
  sourceTurnId = '',
  now = new Date(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!vaultBase || !projectId) throw new Error('vaultBase e projectId são obrigatórios.');
  await retryObserverMemoryOutbox({ vaultBase, projectId, url, fetchImpl });
  const state = readState(vaultBase);
  const batch = buildMemoryEventBatch({ vaultBase, projectId, sourceSessionId, sourceTurnId, now, state });
  if (batch.events.length === 0) {
    commitMemoryPublishState(vaultBase, batch.nextState);
    return { ok: true, queued: false, scanned: batch.scanned, changed: 0, pending: listMemoryOutbox(vaultBase).length };
  }
  if (!url) {
    queueMemoryBatch(vaultBase, batch.events);
    commitMemoryPublishState(vaultBase, batch.nextState);
    return { ok: false, queued: true, scanned: batch.scanned, changed: batch.changed, pending: listMemoryOutbox(vaultBase).length, hookExitCode: 0 };
  }
  try {
    await postBatch(url, projectId, batch.events, fetchImpl);
    commitMemoryPublishState(vaultBase, batch.nextState);
    return { ok: true, queued: false, scanned: batch.scanned, changed: batch.changed, pending: listMemoryOutbox(vaultBase).length };
  } catch (error) {
    queueMemoryBatch(vaultBase, batch.events);
    commitMemoryPublishState(vaultBase, batch.nextState);
    return { ok: false, queued: true, scanned: batch.scanned, changed: batch.changed, pending: listMemoryOutbox(vaultBase).length, hookExitCode: 0, error: error.message };
  }
}
