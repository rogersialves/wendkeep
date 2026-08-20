import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { startObserverServer } from '../src/observer-server.mjs';
import {
  observerSqlRuntimeSupport,
} from '../src/observer-sql-store.mjs';
import { makeDataDir } from './helpers/observer-fixture.mjs';

async function request(base, path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

function requestWithHost(base, path, host) {
  const target = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: { host },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('[req:OBS-RUNTIME-1] store SQL não importa node:sqlite estaticamente', () => {
  const source = readFileSync(new URL('../src/observer-sql-store.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /import\s+\{\s*DatabaseSync\s*\}\s+from\s+['"]node:sqlite['"]/);
  assert.deepEqual(observerSqlRuntimeSupport('18.20.8'), {
    supported: false,
    minimum: '22.13.0',
    current: '18.20.8',
  });
  assert.equal(observerSqlRuntimeSupport('22.12.0').supported, false);
  assert.equal(observerSqlRuntimeSupport('22.13.0').supported, true);
  assert.equal(observerSqlRuntimeSupport('24.1.0').supported, true);
});

test('[req:OBS-SEC-1] non-loopback exige token já na abertura', async () => {
  const dataDir = makeDataDir();
  try {
    await assert.rejects(
      () => startObserverServer({ host: '0.0.0.0', port: 0, dataDir, allowNonLoopback: true }),
      (error) => error?.code === 'WENDKEEP_OBSERVER_TOKEN_REQUIRED',
    );
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('[req:OBS-SEC-2] mutações loopback exigem Bearer token', async () => {
  const dataDir = makeDataDir();
  const token = 'observer-test-token';
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, token });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await request(base, '/v1/projects/project-a', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: 'project-a', project_name: 'Project A' }),
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error.code, 'observer_auth_required');

    const accepted = await request(base, '/v1/projects/project-a', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ project_id: 'project-a', project_name: 'Project A' }),
    });
    assert.equal(accepted.status, 201);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-3] Host e Origin incompatíveis são recusados', async () => {
  const dataDir = makeDataDir();
  const token = 'observer-test-token';
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, token });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const badHost = await requestWithHost(base, '/v1/projects', 'evil.example');
    assert.equal(badHost.status, 421);
    assert.equal(badHost.body.error.code, 'invalid_host');

    const badOrigin = await request(base, '/v1/projects', {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.body.error.code, 'invalid_origin');
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
