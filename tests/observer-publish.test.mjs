import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startObserverServer } from '../src/observer-server.mjs';
import { publishObserverSnapshot, listOutbox } from '../src/observer-publish.mjs';
import { makeDataDir, makeObserverFixture } from './helpers/observer-fixture.mjs';
import { registerObserverProject } from '../src/observer-store.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'observer-publish.mjs');
const TOKEN = 'observer-test-token';

test('[req:OBS-LOCAL-4] publisher grava outbox e não bloqueia quando Observer está indisponível', async () => {
  const fixture = makeObserverFixture();
  try {
    const result = await publishObserverSnapshot({
      vaultBase: fixture.vaultBase,
      projectRoot: fixture.projectRoot,
      url: 'http://127.0.0.1:1',
      now: '2026-08-16T12:00:00Z',
    });
    assert.equal(result.ok, false);
    assert.equal(result.queued, true);
    assert.equal(result.hookExitCode, 0);
    assert.equal(listOutbox(fixture.vaultBase).length, 1);
    assert.doesNotMatch(JSON.stringify(listOutbox(fixture.vaultBase)), /CORE\.md|C:\\\\GitHub/);
  } finally {
    fixture.cleanup();
  }
});

test('[req:OBS-LOCAL-4] publisher autenticado confirma evento e remove somente outbox aceita', async () => {
  const fixture = makeObserverFixture();
  const dataDir = makeDataDir();
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, token: TOKEN });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    registerObserverProject(dataDir, { projectId: fixture.projectId, projectName: fixture.projectName });
    const result = await publishObserverSnapshot({
      vaultBase: fixture.vaultBase,
      projectRoot: fixture.projectRoot,
      url,
      token: TOKEN,
      now: '2026-08-16T12:00:00Z',
    });
    assert.equal(result.ok, true);
    assert.equal(result.queued, false);
    assert.equal(result.memory.ok, true);
    const memoryResponse = await fetch(url + '/v1/projects/' + encodeURIComponent(fixture.projectId) + '/memory/tree');
    const memory = await memoryResponse.json();
    assert.equal(memoryResponse.ok, true);
    assert.ok(memory.document_count > 0);
    assert.equal(listOutbox(fixture.vaultBase).length, 0);
  } finally {
    await server.close();
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-LOCAL-4] hook publisher encerra com sucesso mesmo sem servidor', () => {
  const fixture = makeObserverFixture();
  try {
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: fixture.projectRoot, obsidian_vault_path: fixture.vaultBase }),
      encoding: 'utf8',
      env: { ...process.env, WENDKEEP_OBSERVER_URL: 'http://127.0.0.1:1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(listOutbox(fixture.vaultBase).length, 1);
  } finally {
    fixture.cleanup();
  }
});
