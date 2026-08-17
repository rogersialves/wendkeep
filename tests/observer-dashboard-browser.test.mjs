import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { startObserverServer } from '../src/observer-server.mjs';
import { makeDataDir } from './helpers/observer-fixture.mjs';

test('[req:OBS-LOCAL-1] browser contract serve página real do Observer sem desbloqueio', async () => {
  const dataDir = makeDataDir();
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /<main[^>]+id="app"/i);
    assert.doesNotMatch(html, /id="auth-form"|id="token-input"|PRIVATE LOCAL FEED/i);
    assert.doesNotMatch(html, /id="dashboard-panel"[^>]+hidden/i);
    assert.match(html, /id="project-list"/i);
    assert.match(html, /id="project-detail"/i);
    assert.match(html, /id="workspace-panel"/i);
    assert.match(html, /id="workspace-content"/i);
    assert.match(html, /Sessões/i);
    assert.match(html, /Consumo/i);
    assert.match(html, /Memória/i);
    assert.match(html, /Changes/i);
    assert.match(html, /Sincronização/i);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
