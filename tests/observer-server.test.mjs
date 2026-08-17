import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { startObserverServer } from '../src/observer-server.mjs';
import { buildProjectSnapshot } from '../src/observer-snapshot.mjs';
import { makeDataDir, makeObserverFixture } from './helpers/observer-fixture.mjs';

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

test('[req:OBS-3] [req:OBS-5] servidor protege API, registra projeto e publica snapshot', async () => {
  const dataDir = makeDataDir();
  const fixture = makeObserverFixture();
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, token: 'local-secret' });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await request(base, '/healthz');
    const denied = await request(base, '/v1/projects');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true, service: 'wendkeep-observer', schema_version: 1 });
    assert.equal(denied.status, 401);

    const auth = { authorization: 'Bearer local-secret', 'content-type': 'application/json' };
    const registered = await request(base, '/v1/projects/project-a', {
      method: 'PUT', headers: auth, body: JSON.stringify({ project_id: 'project-a', project_name: 'Project A' }),
    });
    assert.equal(registered.status, 201);
    const snapshot = buildProjectSnapshot({ vaultBase: fixture.vaultBase, projectRoot: fixture.projectRoot, now: '2026-08-16T12:00:00Z' });
    const published = await request(base, '/v1/projects/project-a/snapshot', {
      method: 'POST', headers: auth, body: JSON.stringify(snapshot),
    });
    assert.equal(published.status, 201);

    const projects = await request(base, '/v1/projects', { headers: { authorization: 'Bearer local-secret' } });
    assert.deepEqual(projects.body.projects.map((p) => p.projectId), ['project-a']);
    const changes = await request(base, '/v1/projects/project-a/changes', { headers: { authorization: 'Bearer local-secret' } });
    assert.equal(changes.body.changes[0].openTasks, 1);

    const raw = await request(base, '/v1/projects/project-a/snapshot', {
      method: 'POST', headers: auth, body: JSON.stringify({ ...snapshot, projectRoot: 'C:\\GitHub\\secret' }),
    });
    assert.equal(raw.status, 400);
  } finally {
    await server.close();
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-5] servidor recusa bind não-loopback e JSON inválido', async () => {
  const dataDir = makeDataDir();
  await assert.rejects(
    () => startObserverServer({ host: '0.0.0.0', port: 0, dataDir, token: 'x' }),
    /loopback/i,
  );
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, token: 'x' });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await request(base, '/v1/projects/project-a', {
      method: 'PUT',
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      body: '{invalid',
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'invalid_json');

    const oversized = await request(base, '/v1/projects/project-a', {
      method: 'PUT',
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: 'project-a', project_name: 'x'.repeat(40 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.error.code, 'payload_too_large');
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-7] servidor permite bind interno explícito somente quando autorizado', async () => {
  const dataDir = makeDataDir();
  const server = await startObserverServer({ host: '0.0.0.0', port: 0, dataDir, token: 'x', allowNonLoopback: true });
  try {
    assert.equal(server.address().address, '0.0.0.0');
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[sensor:observer-e2e] [req:OBS-3] [req:OBS-4] [req:OBS-7] dois projetos permanecem isolados após replay e restart', async () => {
  const dataDir = makeDataDir();
  const first = makeObserverFixture({ projectId: 'project-a', slug: 'change-a', openTasks: ['A task'] });
  const second = makeObserverFixture({ projectId: 'project-b', slug: 'change-b', openTasks: ['B task'] });
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, token: 'local-secret' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer local-secret', 'content-type': 'application/json' };
  try {
    for (const fixture of [first, second]) {
      const registration = await request(base, `/v1/projects/${fixture.projectId}`, {
        method: 'PUT', headers, body: JSON.stringify({ project_id: fixture.projectId, project_name: fixture.projectName }),
      });
      assert.equal(registration.status, 201);
      const snapshot = buildProjectSnapshot({ vaultBase: fixture.vaultBase, projectRoot: fixture.projectRoot, now: '2026-08-16T12:00:00Z' });
      const published = await request(base, `/v1/projects/${fixture.projectId}/snapshot`, {
        method: 'POST', headers, body: JSON.stringify(snapshot),
      });
      assert.equal(published.status, 201);
      const replay = await request(base, `/v1/projects/${fixture.projectId}/snapshot`, {
        method: 'POST', headers, body: JSON.stringify(snapshot),
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.duplicate, true);
    }
    const projects = await request(base, '/v1/projects', { headers });
    assert.deepEqual(projects.body.projects.map((item) => item.projectId), ['project-a', 'project-b']);
    const firstChanges = await request(base, '/v1/projects/project-a/changes', { headers });
    const secondChanges = await request(base, '/v1/projects/project-b/changes', { headers });
    assert.equal(firstChanges.body.changes[0].slug, 'change-a');
    assert.equal(secondChanges.body.changes[0].slug, 'change-b');
  } finally {
    await server.close();
    const restarted = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, token: 'local-secret' });
    try {
      const persisted = await request(`http://127.0.0.1:${restarted.address().port}`, '/v1/projects', { headers });
      assert.deepEqual(persisted.body.projects.map((item) => item.projectId), ['project-a', 'project-b']);
    } finally {
      await restarted.close();
      first.cleanup();
      second.cleanup();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
});
