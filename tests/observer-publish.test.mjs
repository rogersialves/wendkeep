import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startObserverServer } from '../src/observer-server.mjs';
import { publishObserverSnapshot } from '../src/observer-publish.mjs';
import { listSqlOutbox } from '../src/observer-sql-publish.mjs';
import { makeDataDir, makeObserverFixture, observerBootstrap } from './helpers/observer-fixture.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'observer-publish.mjs');
const TOKEN = 'observer-test-token';

function addSession(fixture) {
  const relative = '02-Sessões/2026/08-AGO/DIA 16/fixture.md';
  mkdirSync(join(fixture.vaultBase, dirname(relative)), { recursive: true });
  writeFileSync(join(fixture.vaultBase, relative), [
    '---', 'type: session', 'session_id: fixture-session', 'provider: codex', 'status: done', '---', '', '# Fixture', '',
  ].join('\n'));
}

test('[req:OBS-LOCAL-4] publisher grava outbox e não bloqueia quando Observer está indisponível', async () => {
  const fixture = makeObserverFixture();
  try {
    addSession(fixture);
    const result = await publishObserverSnapshot({
      vaultBase: fixture.vaultBase,
      projectRoot: fixture.projectRoot,
      url: 'http://127.0.0.1:1',
      now: '2026-08-16T12:00:00Z',
      input: { hook_event_name: 'Stop', session_id: 'fixture-session' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.queued, true);
    assert.equal(result.hookExitCode, 0);
    assert.equal(listSqlOutbox(fixture.vaultBase).length, 1);
    assert.doesNotMatch(JSON.stringify(listSqlOutbox(fixture.vaultBase)), /CORE\.md|C:\\\\GitHub/);
  } finally {
    fixture.cleanup();
  }
});

test('[req:OBS-LOCAL-4] publisher autenticado confirma evento e remove somente outbox aceita', async () => {
  const fixture = makeObserverFixture();
  const dataDir = makeDataDir();
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, ...observerBootstrap(TOKEN) });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    addSession(fixture);
    const registration = await fetch(`${url}/v1/projects/${fixture.projectId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ project_id: fixture.projectId, project_name: fixture.projectName }),
    });
    assert.equal(registration.ok, true);
    const result = await publishObserverSnapshot({
      vaultBase: fixture.vaultBase,
      projectRoot: fixture.projectRoot,
      url,
      token: TOKEN,
      now: '2026-08-16T12:00:00Z',
      input: { hook_event_name: 'Stop', session_id: 'fixture-session' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.queued, false);
    assert.equal(result.memory.ok, true);
    const memoryResponse = await fetch(url + '/v1/projects/' + encodeURIComponent(fixture.projectId) + '/memory/tree');
    const memory = await memoryResponse.json();
    assert.equal(memoryResponse.ok, true);
    assert.ok(memory.document_count > 0);
    assert.equal(listSqlOutbox(fixture.vaultBase).length, 0);
  } finally {
    await server.close();
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-LOCAL-4] hook publisher encerra com sucesso mesmo sem servidor', () => {
  const fixture = makeObserverFixture();
  try {
    addSession(fixture);
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: fixture.projectRoot, obsidian_vault_path: fixture.vaultBase, hook_event_name: 'Stop', session_id: 'fixture-session' }),
      encoding: 'utf8',
      env: { ...process.env, WENDKEEP_OBSERVER_URL: 'http://127.0.0.1:1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(listSqlOutbox(fixture.vaultBase).length, 1);
  } finally {
    fixture.cleanup();
  }
});
