import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { startObserverServer } from '../src/observer-server.mjs';
import {
  buildProjectViewModel,
  classifyRefreshError,
  filterProjects,
  isSnapshotStale,
  loadDashboardData,
  REFRESH_INTERVAL_MS,
} from '../web/observer/app.mjs';
import { makeDataDir } from './helpers/observer-fixture.mjs';

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    body: await response.text(),
  };
}

function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

test('[req:OBS-LOCAL-1] dashboard serve HTML diretamente e assets allowlisted', async () => {
  const dataDir = makeDataDir();
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await request(base, '/');
    const styles = await request(base, '/styles.css');
    const script = await request(base, '/app.mjs');
    const favicon = await request(base, '/favicon.svg');
    const traversal = await request(base, '/%2e%2e/package.json');
    assert.equal(page.status, 200);
    assert.match(page.contentType, /text\/html/);
    assert.match(page.body, /WendKeep Observer/);
    assert.match(page.body, /\/styles\.css/);
    assert.match(page.body, /\/app\.mjs/);
    assert.doesNotMatch(page.body, /auth-form|token-input|PRIVATE LOCAL FEED/i);
    assert.match(page.body, /id="dashboard-panel"/);
    assert.doesNotMatch(page.body, /id="dashboard-panel"[^>]+hidden/i);
    assert.equal(styles.status, 200);
    assert.match(styles.contentType, /text\/css/);
    assert.equal(script.status, 200);
    assert.match(script.contentType, /javascript/);
    assert.equal(favicon.status, 200);
    assert.match(favicon.contentType, /image\/svg\+xml/);
    assert.equal(traversal.status, 404);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-LOCAL-1] dashboard carrega projetos sem token ou Authorization', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === '/v1/projects') return jsonResponse({ projects: [{ projectId: 'project-a', projectName: 'Project A' }] });
    return jsonResponse({
      projectId: 'project-a',
      projectName: 'Project A',
      eventCount: 2,
      snapshot: {
        project_id: 'project-a', project_name: 'Project A', wendkeep_version: '0.71.0',
        captured_at: '2026-08-17T12:00:00.000Z',
        session: { status: 'active', provider: 'codex', change_slug: 'observer-dashboard' },
        health: { ok: true, status: 'healthy', failure_count: 0, warning_count: 0 },
        changes: [],
      },
    });
  };
  const data = await loadDashboardData(fetchImpl);
  assert.equal(data.length, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.options.headers), [
    { Accept: 'application/json' }, { Accept: 'application/json' },
  ]);
  assert.equal(calls.some((call) => Object.hasOwn(call.options.headers, 'Authorization')), false);
});

test('[req:OBS-LOCAL-1] view model mantém isolamento e resume cada projeto', () => {
  const model = buildProjectViewModel({ projectId: 'project-a', projectName: 'Project A', eventCount: 3 }, {
    snapshot: {
      project_id: 'project-a', project_name: 'Project A', wendkeep_version: '0.71.0',
      captured_at: '2026-08-17T12:00:00.000Z',
      session: { status: 'active', provider: 'codex', change_slug: 'observer-dashboard', last_seen: '2026-08-17T12:00:00.000Z' },
      health: { ok: true, status: 'healthy', failure_count: 0, warning_count: 1, registry_sessions: 2, derived_notes: 4 },
      changes: [{ slug: 'observer-dashboard', current: true, openTasks: 2, doneTasks: 1, warning: '' }],
      secret: 'CORE.md',
    },
  }, '2026-08-17T12:00:10.000Z');
  assert.deepEqual(model, {
    projectId: 'project-a', projectName: 'Project A', version: '0.71.0', eventCount: 3,
    capturedAt: '2026-08-17T12:00:00.000Z', stale: false,
    session: { status: 'active', provider: 'codex', changeSlug: 'observer-dashboard', lastSeen: '2026-08-17T12:00:00.000Z' },
    health: { ok: true, status: 'healthy', failureCount: 0, warningCount: 1, registrySessions: 2, derivedNotes: 4 },
    changes: [{ slug: 'observer-dashboard', current: true, openTasks: 2, doneTasks: 1, warning: '' }],
  });
  assert.doesNotMatch(JSON.stringify(model), /CORE|secret|path|transcript/i);
  assert.equal(filterProjects([model], 'observer-dashboard').length, 1);
  assert.equal(filterProjects([model], 'atenção').length, 1);
  assert.equal(filterProjects([model], 'não-existe').length, 0);
});

test('[req:OBS-LOCAL-1] stale é determinado pela idade da última captura', () => {
  assert.equal(isSnapshotStale('2026-08-17T12:00:00.000Z', '2026-08-17T12:00:59.000Z'), false);
  assert.equal(isSnapshotStale('2026-08-17T12:00:00.000Z', '2026-08-17T12:01:01.000Z'), true);
  assert.equal(isSnapshotStale('', '2026-08-17T12:01:01.000Z'), true);
  assert.equal(REFRESH_INTERVAL_MS, 15_000);
  assert.deepEqual(classifyRefreshError({ status: 401 }, false), {
    kind: 'unavailable', message: 'Observer indisponível. erro desconhecido.', preserve: false,
  });
  assert.deepEqual(classifyRefreshError(new Error('offline'), true), {
    kind: 'degraded', message: 'Não foi possível atualizar. Última leitura preservada. offline', preserve: true,
  });
  assert.deepEqual(classifyRefreshError(new Error('offline'), false), {
    kind: 'unavailable', message: 'Observer indisponível. offline', preserve: false,
  });
});
