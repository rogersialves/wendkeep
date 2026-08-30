import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishObserverSqlIncremental } from './observer-sql-publish.mjs';
import { observerAuthHeaders, resolveObserverToken } from './observer-auth.mjs';
import { readProjectForValidation } from '../packages/vault/src/validate-memory.mjs';
import { createObserverPolicy } from '../packages/observer/src/policy.mjs';
import { createObserverEncryption } from '../packages/observer/src/encryption.mjs';

const OUTBOX_REL = join('.brain', 'observer-outbox');
const REQUEST_TIMEOUT_MS = 500;

function decodeObserverKey(value) {
  const raw = String(value || '').trim();
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.byteLength !== 32) throw Object.assign(new Error('Observer outbox key deve ter 32 bytes em hex/base64.'), { code: 'observer_encryption_key_invalid' });
  return key;
}

export function resolveObserverPublisherSecurity({ env = process.env } = {}) {
  const policyFile = String(env.WENDKEEP_OBSERVER_POLICY_FILE || '').trim();
  const policy = policyFile
    ? createObserverPolicy(JSON.parse(readFileSync(policyFile, 'utf8')))
    : createObserverPolicy();
  const keyEnvName = String(env.WENDKEEP_OBSERVER_OUTBOX_KEY_ENV || '').trim();
  if (!keyEnvName) return { policy, outboxEncryption: null };
  const key = decodeObserverKey(env[keyEnvName]);
  return {
    policy,
    outboxEncryption: createObserverEncryption({
      required: true,
      keyId: String(env.WENDKEEP_OBSERVER_OUTBOX_KEY_ID || keyEnvName),
      keyProvider: () => key,
    }),
  };
}

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

async function postSnapshot(url, event, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${String(url).replace(/\/$/, '')}/v1/projects/${encodeURIComponent(event.project_id)}/snapshot`, {
      method: 'POST',
      headers: observerAuthHeaders(token, {
        'content-type': 'application/json',
      }),
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

export async function retryObserverOutbox({ vaultBase, url, token = process.env.WENDKEEP_OBSERVER_TOKEN || '' } = {}) {
  if (!url) return { attempted: 0, confirmed: 0, pending: listOutbox(vaultBase).length };
  let attempted = 0;
  let confirmed = 0;
  for (const event of listOutbox(vaultBase)) {
    attempted += 1;
    try {
      await postSnapshot(url, event, token);
      removeOutbox(vaultBase, event.event_id);
      confirmed += 1;
    } catch { /* preserve the event for a later retry */ }
  }
  return { attempted, confirmed, pending: listOutbox(vaultBase).length };
}

export async function publishObserverSnapshot({
  vaultBase,
  url = process.env.WENDKEEP_OBSERVER_URL || '',
  now = new Date(),
  input = {},
  token = process.env.WENDKEEP_OBSERVER_TOKEN || '',
  policy = null,
  outboxEncryption = null,
} = {}) {
  try {
    const project = readProjectForValidation(vaultBase);
    if (!project.ok || !project.projectId) throw new Error(project.errors?.join(' ') || 'PROJECT.json inválido.');
    const sql = await publishObserverSqlIncremental({
      vaultBase,
      projectId: project.projectId,
      url,
      input,
      now,
      token,
      policy,
      outboxEncryption,
    });
    // SQLite is the only live authority. The legacy snapshot store remains
    // readable solely as a migration source for pre-SQL installations.
    const memory = { ok: sql.ok, queued: sql.queued, changed: sql.changed, pending: sql.pending, authority: 'sqlite' };
    return { ok: sql.ok, queued: sql.queued, hookExitCode: 0, memory, sql };
  } catch (error) {
    return { ok: false, queued: false, hookExitCode: 0, error: error.message };
  }
}
