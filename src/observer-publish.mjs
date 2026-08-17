import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProjectSnapshot } from './observer-snapshot.mjs';
import { publishObserverMemory } from './observer-memory-publish.mjs';

const OUTBOX_REL = join('.brain', 'observer-outbox');
const REQUEST_TIMEOUT_MS = 500;

function outboxDir(vaultBase) {
  return join(vaultBase, OUTBOX_REL);
}

function eventPath(vaultBase, eventId) {
  if (!/^obs-[a-f0-9]{24}$/.test(eventId)) throw new Error('event_id inválido para outbox.');
  return join(outboxDir(vaultBase), `${eventId}.json`);
}

function atomicWrite(path, value) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, 'utf8');
  renameSync(temp, path);
}

export function listOutbox(vaultBase) {
  const dir = outboxDir(vaultBase);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^obs-[a-f0-9]{24}\.json$/.test(name))
    .sort()
    .flatMap((name) => {
      try { return [JSON.parse(readFileSync(join(dir, name), 'utf8'))]; }
      catch { return []; }
    });
}

function queueOutbox(vaultBase, event) {
  const dir = outboxDir(vaultBase);
  mkdirSync(dir, { recursive: true });
  const path = eventPath(vaultBase, event.event_id);
  if (!existsSync(path)) atomicWrite(path, event);
  return path;
}

function removeOutbox(vaultBase, eventId) {
  const path = eventPath(vaultBase, eventId);
  if (existsSync(path)) unlinkSync(path);
}

async function postSnapshot(url, event) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${String(url).replace(/\/$/, '')}/v1/projects/${encodeURIComponent(event.project_id)}/snapshot`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    const text = await response.text();
    let body = {};
    try { body = JSON.parse(text); } catch { /* server error remains deterministic below */ }
    if (!response.ok || !(body.accepted === true || body.duplicate === true)) {
      throw new Error(`Observer respondeu HTTP ${response.status}.`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function retryObserverOutbox({ vaultBase, url } = {}) {
  if (!url) return { attempted: 0, confirmed: 0, pending: listOutbox(vaultBase).length };
  let attempted = 0;
  let confirmed = 0;
  for (const event of listOutbox(vaultBase)) {
    attempted += 1;
    try {
      await postSnapshot(url, event);
      removeOutbox(vaultBase, event.event_id);
      confirmed += 1;
    } catch { /* preserve the event for a later retry */ }
  }
  return { attempted, confirmed, pending: listOutbox(vaultBase).length };
}

export async function publishObserverSnapshot({
  vaultBase,
  projectRoot,
  url = process.env.WENDKEEP_OBSERVER_URL || '',
  now = new Date(),
} = {}) {
  try {
    const event = buildProjectSnapshot({ vaultBase, projectRoot, now });
    if (!url) return { ok: true, skipped: true, queued: false, hookExitCode: 0, event_id: event.event_id };

    await retryObserverOutbox({ vaultBase, url });
    let memory;
    try {
      memory = await publishObserverMemory({
        vaultBase,
        projectId: event.project_id,
        url,
        now,
      });
    } catch (error) {
      memory = { ok: false, queued: false, error: error.message };
    }
    try {
      const response = await postSnapshot(url, event);
      return {
        ok: true,
        queued: false,
        hookExitCode: 0,
        event_id: event.event_id,
        duplicate: response.duplicate === true,
        memory,
      };
    } catch (error) {
      queueOutbox(vaultBase, event);
      return {
        ok: false,
        queued: true,
        hookExitCode: 0,
        event_id: event.event_id,
        error: error.message,
        memory,
      };
    }
  } catch (error) {
    return { ok: false, queued: false, hookExitCode: 0, error: error.message };
  }
}
