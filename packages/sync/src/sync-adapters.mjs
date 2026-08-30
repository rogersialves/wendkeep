import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  applySyncEvent, canonicalSyncJson, createSyncState, resolveSyncConflict, validateSyncEvent,
} from './sync-protocol.mjs';

function adapterError(code, message) {
  return Object.assign(new Error(message), { code });
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function parseLedger(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw adapterError('WENDKEEP_SYNC_BACKEND_CORRUPT', `backend event line ${index + 1} is corrupt`); }
  });
}

function readState(path, projectId) {
  if (!existsSync(path)) return createSyncState(projectId);
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (state?.schema_version !== 1 || state?.project_id !== projectId) throw new Error('state identity mismatch');
    return state;
  } catch (error) {
    throw adapterError('WENDKEEP_SYNC_BACKEND_CORRUPT', `backend state is corrupt: ${error.message}`);
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withLock(path, operation, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const started = Date.now();
  mkdirSync(dirname(path), { recursive: true });
  while (true) {
    try { mkdirSync(path); break; }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
      } catch (inspectError) {
        if (inspectError?.code !== 'ENOENT') throw inspectError;
        continue;
      }
      if (Date.now() - started >= timeoutMs) throw adapterError('WENDKEEP_SYNC_BACKEND_BUSY', 'backend lock is busy');
      sleep(20);
    }
  }
  try { return operation(); }
  finally { rmSync(path, { recursive: true, force: true }); }
}

export function createFilesystemSyncAdapter(rootPath, { available = true } = {}) {
  const root = resolve(rootPath);
  const statePath = join(root, 'STATE.json');
  const eventsPath = join(root, 'EVENTS.jsonl');
  const lockPath = join(root, '.sync.lock');
  const assertAvailable = () => {
    if (!available) throw adapterError('WENDKEEP_SYNC_BACKEND_UNAVAILABLE', 'filesystem backend is unavailable');
  };
  return {
    kind: 'filesystem',
    id: `filesystem:${root}`,
    async push(event) {
      assertAvailable();
      validateSyncEvent(event);
      return withLock(lockPath, () => {
        const events = parseLedger(eventsPath);
        const state = readState(statePath, event.project_id);
        const result = applySyncEvent(state, event);
        if (!events.some((item) => item.event_id === event.event_id)) {
          mkdirSync(root, { recursive: true });
          const previous = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : '';
          writeFileSync(eventsPath, `${previous}${canonicalSyncJson(event)}\n`, 'utf8');
        }
        atomicJson(statePath, state);
        return result;
      });
    },
    async pull({ cursor = 0, projectId = '' } = {}) {
      assertAvailable();
      const offset = Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) throw adapterError('WENDKEEP_SYNC_CURSOR_INVALID', 'cursor is invalid');
      const events = parseLedger(eventsPath);
      const inferredProject = projectId || events[0]?.project_id || '';
      const state = inferredProject ? readState(statePath, inferredProject) : null;
      return {
        schema_version: 1,
        cursor: events.length,
        events: events.slice(offset),
        state,
      };
    },
    async resolve(options = {}) {
      assertAvailable();
      return withLock(lockPath, () => {
        const state = readState(statePath, options.projectId);
        const result = resolveSyncConflict(state, options);
        const previous = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : '';
        writeFileSync(eventsPath, `${previous}${canonicalSyncJson(result.event)}\n`, 'utf8');
        atomicJson(statePath, state);
        return result;
      });
    },
  };
}

function httpUrl(base, suffix) {
  let parsed;
  try { parsed = new URL(base); } catch { throw adapterError('WENDKEEP_SYNC_HTTP_URL_INVALID', 'HTTP backend URL is invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw adapterError('WENDKEEP_SYNC_HTTP_URL_INVALID', 'HTTP backend must use HTTP(S)');
  return `${parsed.href.replace(/\/$/, '')}/${suffix}`;
}

export function createHttpSyncAdapter({ url, fetchImpl = globalThis.fetch, headers = {} } = {}) {
  if (typeof fetchImpl !== 'function') throw adapterError('WENDKEEP_SYNC_HTTP_UNAVAILABLE', 'fetch is unavailable');
  const request = async (target, init) => {
    let response;
    try { response = await fetchImpl(target, init); }
    catch { throw adapterError('WENDKEEP_SYNC_BACKEND_UNAVAILABLE', 'HTTP backend is unavailable'); }
    if (!response?.ok) throw adapterError('WENDKEEP_SYNC_HTTP_FAILED', `HTTP backend returned ${response?.status || 'error'}`);
    return response.json();
  };
  return {
    kind: 'http',
    id: `http:${syncHost(url)}`,
    async push(event) {
      validateSyncEvent(event);
      return request(httpUrl(url, 'events'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: canonicalSyncJson(event),
      });
    },
    async pull({ cursor = 0, projectId } = {}) {
      const query = new URLSearchParams({ project_id: String(projectId || ''), cursor: String(cursor) });
      return request(`${httpUrl(url, 'events')}?${query}`, { method: 'GET', headers: { ...headers } });
    },
    async resolve(options = {}) {
      return request(httpUrl(url, 'conflicts/resolve'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: canonicalSyncJson(options),
      });
    },
  };
}

function syncHost(value) {
  try { return new URL(value).host; } catch { return 'invalid'; }
}

export async function pushSyncEvents({ adapter, events = [], onAcknowledged = async () => {} } = {}) {
  if (!adapter?.push) throw adapterError('WENDKEEP_SYNC_ADAPTER_INVALID', 'sync adapter cannot push');
  const results = [];
  for (const event of events) {
    const result = await adapter.push(event);
    results.push(result);
    if (['applied', 'duplicate', 'conflict', 'pending'].includes(result.status)) {
      await onAcknowledged(event, result);
    }
  }
  return results;
}

export async function pullSyncEvents({ adapter, cursor = 0, projectId = '' } = {}) {
  if (!adapter?.pull) throw adapterError('WENDKEEP_SYNC_ADAPTER_INVALID', 'sync adapter cannot pull');
  return adapter.pull({ cursor, projectId });
}
