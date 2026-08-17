import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { startObserverServer } from '../src/observer-server.mjs';
import { makeDataDir } from './helpers/observer-fixture.mjs';

function memoryEvent({
  projectId = 'project-a',
  eventId = 'memory-a',
  path = '02-Sessões/2026/08-AGO/DIA 17/session.md',
  content = '# Sessão WendKeep\n\nConteúdo completo consultável pelo Observer.\n',
} = {}) {
  return {
    schema_version: 1,
    event_id: eventId,
    project_id: projectId,
    entity_type: 'session',
    logical_path: path,
    operation: 'upsert',
    content,
    content_hash: createHash('sha256').update(content).digest('hex'),
    revision: 1,
    source_session_id: 'session-a',
    source_turn_id: 'turn-a',
    captured_at: '2026-08-17T12:00:00.000Z',
  };
}

async function request(base, path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

test('[req:MEM-API-3] [req:MEM-QUERY-4] API ingere lote, lista árvore, lê documento completo e busca', async () => {
  const dataDir = makeDataDir();
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir });
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'content-type': 'application/json' };
  try {
    const registered = await request(base, '/v1/projects/project-a', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ project_id: 'project-a', project_name: 'Project A' }),
    });
    assert.equal(registered.status, 201);

    const event = memoryEvent();
    const accepted = await request(base, '/v1/projects/project-a/memory/events', {
      method: 'POST',
      headers,
      body: JSON.stringify({ events: [event] }),
    });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.accepted, 1);

    const tree = await request(base, '/v1/projects/project-a/memory/tree');
    assert.equal(tree.status, 200);
    assert.equal(tree.body.document_count, 1);
    assert.equal(tree.body.documents[0].logical_path, event.logical_path);

    const document = await request(base, '/v1/projects/project-a/memory/document?path=' + encodeURIComponent(event.logical_path));
    assert.equal(document.status, 200);
    assert.equal(document.body.content, event.content);
    assert.equal(document.body.content_hash, event.content_hash);

    const search = await request(base, '/v1/projects/project-a/memory/search?q=consultável');
    assert.equal(search.status, 200);
    assert.equal(search.body.results[0].logical_path, event.logical_path);

    const sync = await request(base, '/v1/projects/project-a/sync');
    assert.equal(sync.status, 200);
    assert.equal(sync.body.document_count, 1);
    assert.equal(sync.body.mode, 'container-authority');

    const mode = await request(base, '/v1/projects/project-a/sync', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ mode: 'container-authority' }),
    });
    assert.equal(mode.status, 200);
    assert.equal(mode.body.mode, 'container-authority');
    const exported = await request(base, '/v1/projects/project-a/memory/export');
    assert.equal(exported.status, 200);
    assert.equal(exported.body.mode, 'container-authority');
    assert.equal(exported.body.documents[0].content, event.content);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:MEM-API-3] API isola projetos e rejeita caminhos inválidos', async () => {
  const dataDir = makeDataDir();
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir });
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'content-type': 'application/json' };
  try {
    await request(base, '/v1/projects/project-a', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ project_id: 'project-a', project_name: 'Project A' }),
    });
    const event = memoryEvent();
    const accepted = await request(base, '/v1/projects/project-a/memory/events', {
      method: 'POST',
      headers,
      body: JSON.stringify({ events: [event] }),
    });
    assert.equal(accepted.status, 201);

    const other = await request(base, '/v1/projects/project-b/memory/tree');
    assert.equal(other.status, 404);
    const invalid = await request(base, '/v1/projects/project-a/memory/document?path=' + encodeURIComponent('../outside.md'));
    assert.equal(invalid.status, 400);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
