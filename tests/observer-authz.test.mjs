import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  ensureObserverDatabase,
  registerSqlProject,
} from '../src/observer-sql-store.mjs';
import { startObserverServer } from '../src/observer-server.mjs';
import {
  authorizeObserverPrincipal,
  recordObserverAudit,
} from '../packages/observer/src/authz.mjs';
import {
  registerObserverToken,
  resolveObserverPrincipal,
  revokeObserverToken,
  rotateObserverToken,
} from '../packages/observer/src/token-registry.mjs';
import { makeDataDir } from './helpers/observer-fixture.mjs';

const NOW = '2026-08-29T12:00:00.000Z';

test('[req:OBS-SEC-AUTHZ] role matrix discriminates ingest, transcript, memory and sync capabilities', () => {
  const expected = {
    viewer: [false, false, false, true, false],
    auditor: [false, true, true, true, false],
    publisher: [true, false, false, false, true],
    admin: [true, true, true, true, true],
  };
  const capabilities = ['ingest:write', 'transcript:read', 'memory:content:read', 'sync:read', 'sync:write'];
  for (const [role, grants] of Object.entries(expected)) {
    const principal = { ok: true, role, project_ids: ['project-a'], scopes: ['*'] };
    assert.deepEqual(capabilities.map((capability) => authorizeObserverPrincipal(principal, {
      projectId: 'project-a', capability,
    }).ok), grants, role);
  }
});

test('[req:OBS-SEC-AUTHZ] tokens are hash-only, project-scoped, role/scope constrained, expiring and immediately revocable', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a' });
    registerSqlProject(db, { projectId: 'project-b' });
    registerObserverToken(db, {
      tokenId: 'viewer-a', token: 'raw-viewer-secret', role: 'viewer', projectIds: ['project-a'],
      scopes: ['usage:summary:read'], createdAt: NOW, expiresAt: '2026-08-30T12:00:00.000Z',
    });
    const persisted = db.prepare('SELECT token_hash, scopes_json FROM observer_tokens WHERE token_id = ?').get('viewer-a');
    assert.equal(JSON.stringify(persisted).includes('raw-viewer-secret'), false);

    const principal = resolveObserverPrincipal(db, 'raw-viewer-secret', { now: NOW });
    assert.equal(authorizeObserverPrincipal(principal, { projectId: 'project-a', capability: 'usage:summary:read' }).ok, true);
    assert.equal(authorizeObserverPrincipal(principal, { projectId: 'project-a', capability: 'usage:calls:read' }).ok, false);
    assert.equal(authorizeObserverPrincipal(principal, { projectId: 'project-b', capability: 'usage:summary:read' }).code, 'observer_project_forbidden');
    assert.equal(resolveObserverPrincipal(db, 'raw-viewer-secret', { now: '2026-08-31T00:00:00.000Z' }).code, 'observer_token_expired');

    const rotated = rotateObserverToken(db, {
      tokenId: 'viewer-a', newTokenId: 'viewer-a-2', newToken: 'rotated-secret',
      rotatedAt: '2026-08-29T13:00:00.000Z', expiresAt: '2026-08-30T13:00:00.000Z',
    });
    assert.equal(rotated.rotated_from, 'viewer-a');
    assert.equal(resolveObserverPrincipal(db, 'raw-viewer-secret', { now: '2026-08-29T14:00:00.000Z' }).code, 'observer_token_revoked');
    assert.equal(resolveObserverPrincipal(db, 'rotated-secret', { now: '2026-08-29T14:00:00.000Z' }).token_id, 'viewer-a-2');
    revokeObserverToken(db, { tokenId: 'viewer-a-2', revokedAt: '2026-08-29T15:00:00.000Z' });
    assert.equal(resolveObserverPrincipal(db, 'rotated-secret', { now: '2026-08-29T15:00:01.000Z' }).code, 'observer_token_revoked');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-AUDIT] sensitive access audit stores metadata but never request/response payloads or bearer secrets', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a' });
    recordObserverAudit(db, {
      auditId: 'audit-1', projectId: 'project-a', tokenId: 'auditor-a', capability: 'transcript:read',
      outcome: 'allowed', occurredAt: NOW,
      metadata: { route: '/v1/projects/project-a/transcripts/t-1', authorization: 'Bearer forbidden', payload: 'private transcript' },
    });
    const row = db.prepare('SELECT * FROM observer_access_audit WHERE audit_id = ?').get('audit-1');
    const serialized = JSON.stringify(row);
    assert.equal(serialized.includes('Bearer forbidden'), false);
    assert.equal(serialized.includes('private transcript'), false);
    assert.equal(serialized.includes('/v1/projects/project-a/transcripts/t-1'), true);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-ENDPOINT] optional loopback auth and endpoint capabilities fail closed per project', async () => {
  const dataDir = makeDataDir();
  let db = ensureObserverDatabase(dataDir);
  registerSqlProject(db, { projectId: 'project-a' });
  registerSqlProject(db, { projectId: 'project-b' });
  registerObserverToken(db, {
    tokenId: 'viewer-a', token: 'viewer-a-secret', role: 'viewer', projectIds: ['project-a'],
    scopes: ['project:read', 'usage:summary:read'], createdAt: NOW, expiresAt: '2026-08-30T12:00:00.000Z',
  });
  registerObserverToken(db, {
    tokenId: 'admin-a', token: 'admin-a-secret', role: 'admin', projectIds: ['project-a'],
    scopes: ['*'], createdAt: NOW, expiresAt: '2026-08-30T12:00:00.000Z',
  });
  db.close();
  const server = await startObserverServer({
    host: '127.0.0.1', port: 0, dataDir,
    security: { enabled: true, requireLoopbackAuth: true, clock: () => new Date(NOW) },
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/v1/projects/project-a/usage/summary`)).status, 401);
    assert.equal((await fetch(`${base}/v1/projects/project-a/usage/calls`)).status, 401);
    assert.equal((await fetch(`${base}/v1/projects/project-a/usage/summary`, { headers: { authorization: 'Bearer viewer-a-secret' } })).status, 200);
    assert.equal((await fetch(`${base}/v1/projects/project-a/usage/calls`, { headers: { authorization: 'Bearer viewer-a-secret' } })).status, 403);
    assert.equal((await fetch(`${base}/v1/projects/project-b/usage/summary`, { headers: { authorization: 'Bearer viewer-a-secret' } })).status, 403);
    const visibleProjects = await (await fetch(`${base}/v1/projects`, { headers: { authorization: 'Bearer viewer-a-secret' } })).json();
    assert.deepEqual(visibleProjects.projects.map((project) => project.projectId), ['project-a']);
    assert.equal((await fetch(`${base}/v1/projects/project-a/security`, { headers: { authorization: 'Bearer viewer-a-secret' } })).status, 403);
    const securityState = await (await fetch(`${base}/v1/projects/project-a/security`, { headers: { authorization: 'Bearer admin-a-secret' } })).json();
    assert.equal(securityState.tokens.active, 2);
    assert.equal(JSON.stringify(securityState).includes('token_hash'), false);
    assert.equal(JSON.stringify(securityState).includes('admin-a-secret'), false);
    const invalidPolicy = await fetch(`${base}/v1/projects/project-a/security/policy`, {
      method: 'PUT',
      headers: { authorization: 'Bearer admin-a-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ unknown_authority: true }),
    });
    assert.equal(invalidPolicy.status, 400);
    const savedPolicy = await fetch(`${base}/v1/projects/project-a/security/policy`, {
      method: 'PUT',
      headers: { authorization: 'Bearer admin-a-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ retention: { documents: 30, calls: 14, transcripts: 7 } }),
    });
    assert.equal(savedPolicy.status, 200);
    const retention = await (await fetch(`${base}/v1/projects/project-a/security/retention`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-a-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: true, operation_id: 'scheduled-2026-08-29' }),
    })).json();
    assert.deepEqual(Object.keys(retention.cutoffs).sort(), ['calls', 'documents', 'transcripts']);
    assert.equal(retention.receipts.every((receipt) => receipt.dry_run), true);
    const dryRun = await (await fetch(`${base}/v1/projects/project-a/security/purge`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-a-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ before: '2026-08-01T00:00:00.000Z', classes: ['calls'], dry_run: true }),
    })).json();
    assert.equal(dryRun.dry_run, true);
  } finally {
    await server.close();
  }
  const audited = ensureObserverDatabase(dataDir);
  try {
    assert.equal(audited.prepare("SELECT COUNT(*) AS count FROM observer_access_audit WHERE project_id = 'project-a' AND capability = 'usage:calls:read' AND outcome = 'denied'").get().count, 2);
  } finally {
    audited.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-BOOTSTRAP] bootstrap is hash-only, project-scoped, expiring, rotatable and immediately revocable', async () => {
  const dataDir = makeDataDir();
  let observedAt = NOW;
  const server = await startObserverServer({
    host: '127.0.0.1', port: 0, dataDir, token: 'bootstrap-project-a-secret',
    bootstrap: {
      tokenId: 'bootstrap-project-a', role: 'admin', projectIds: ['project-a'], scopes: ['*'],
      expiresAt: '2026-08-30T12:00:00.000Z',
    },
    security: { enabled: true, clock: () => new Date(observedAt) },
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer bootstrap-project-a-secret', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/v1/projects/project-a`, {
      method: 'PUT', headers, body: JSON.stringify({ project_id: 'project-a' }),
    })).status, 201);
    assert.equal((await fetch(`${base}/v1/projects/project-b`, {
      method: 'PUT', headers, body: JSON.stringify({ project_id: 'project-b' }),
    })).status, 403);

    let db = ensureObserverDatabase(dataDir);
    const stored = db.prepare("SELECT token_hash, project_ids_json, expires_at FROM observer_tokens WHERE token_id = 'bootstrap-project-a'").get();
    assert.equal(JSON.stringify(stored).includes('bootstrap-project-a-secret'), false);
    assert.deepEqual(JSON.parse(stored.project_ids_json), ['project-a']);
    assert.equal(stored.expires_at, '2026-08-30T12:00:00.000Z');
    db.close();

    observedAt = '2026-08-31T12:00:00.000Z';
    assert.equal((await fetch(`${base}/v1/projects/project-a/usage/summary`, { headers })).status, 401);

    db = ensureObserverDatabase(dataDir);
    rotateObserverToken(db, {
      tokenId: 'bootstrap-project-a', newTokenId: 'bootstrap-project-a-rotated', newToken: 'rotated-project-a-secret',
      rotatedAt: observedAt, expiresAt: '2026-09-02T12:00:00.000Z',
    });
    db.close();
    assert.equal((await fetch(`${base}/v1/projects/project-a/usage/summary`, { headers })).status, 401);
    const rotatedHeaders = { authorization: 'Bearer rotated-project-a-secret' };
    assert.equal((await fetch(`${base}/v1/projects/project-a/usage/summary`, { headers: rotatedHeaders })).status, 200);

    db = ensureObserverDatabase(dataDir);
    revokeObserverToken(db, { tokenId: 'bootstrap-project-a-rotated', revokedAt: '2026-08-31T12:01:00.000Z' });
    db.close();
    observedAt = '2026-08-31T12:01:01.000Z';
    assert.equal((await fetch(`${base}/v1/projects/project-a/usage/summary`, { headers: rotatedHeaders })).status, 401);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
