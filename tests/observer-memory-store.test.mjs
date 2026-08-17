import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyMemoryEvent,
  readMemoryDocument,
  readMemorySync,
  readMemoryTree,
  searchMemory,
  validateMemoryEvent,
} from '../src/observer-memory.mjs';
import { makeDataDir } from './helpers/observer-fixture.mjs';

function event({
  projectId = 'project-a',
  eventId = 'memory-1',
  path = '02-Sessões/2026/08-AGO/DIA 17/session.md',
  content = '# Sessão completa\n\nConteúdo pesquisável da sessão.\n',
  revision = 1,
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
    revision,
    source_session_id: 'session-a',
    source_turn_id: 'turn-a',
    captured_at: '2026-08-17T12:00:00.000Z',
  };
}

test('[req:MEM-CANON-1] [req:MEM-EVENT-2] memória grava Markdown completo e sobrevive à leitura do índice', () => {
  const dataDir = makeDataDir();
  try {
    const first = event();
    const accepted = applyMemoryEvent(dataDir, first);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.duplicate, false);

    const document = readMemoryDocument(dataDir, 'project-a', first.logical_path);
    assert.equal(document.content, first.content);
    assert.equal(document.content_hash, first.content_hash);
    assert.equal(document.revision, 1);

    const tree = readMemoryTree(dataDir, 'project-a');
    assert.deepEqual(tree.documents.map((item) => item.logical_path), [first.logical_path]);
    assert.equal(tree.documents[0].entity_type, 'session');

    const sync = readMemorySync(dataDir, 'project-a');
    assert.equal(sync.document_count, 1);
    assert.equal(sync.event_count, 1);
    assert.equal(existsSync(join(dataDir, 'memory', 'project-a', first.logical_path)), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:MEM-EVENT-2] eventos repetidos são no-op e conflito na mesma revisão não sobrescreve conteúdo', () => {
  const dataDir = makeDataDir();
  try {
    const first = event();
    assert.equal(applyMemoryEvent(dataDir, first).accepted, true);
    assert.equal(applyMemoryEvent(dataDir, first).duplicate, true);

    const conflict = event({ eventId: 'memory-conflict', content: '# Conteúdo divergente\n', revision: 1 });
    const result = applyMemoryEvent(dataDir, conflict);
    assert.equal(result.accepted, false);
    assert.equal(result.conflict, true);
    assert.equal(readMemoryDocument(dataDir, 'project-a', first.logical_path).content, first.content);

    const newer = event({ eventId: 'memory-2', content: '# Revisão nova\nConteúdo atualizado.\n', revision: 2 });
    assert.equal(applyMemoryEvent(dataDir, newer).accepted, true);
    assert.equal(readMemoryDocument(dataDir, 'project-a', first.logical_path).content, newer.content);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:MEM-QUERY-4] busca encontra termos do nome e do corpo sem atravessar projetos', () => {
  const dataDir = makeDataDir();
  try {
    applyMemoryEvent(dataDir, event());
    applyMemoryEvent(dataDir, event({
      projectId: 'project-b',
      eventId: 'memory-b',
      path: '05-Bugs/BUG-0001.md',
      content: '# Falha de outro projeto\nsegredo de projeto b\n',
    }));

    const bodyMatches = searchMemory(dataDir, 'project-a', 'pesquisável');
    assert.equal(bodyMatches.length, 1);
    assert.equal(bodyMatches[0].project_id, 'project-a');
    assert.match(bodyMatches[0].excerpt, /pesquisável/);
    assert.deepEqual(searchMemory(dataDir, 'project-a', 'segredo'), []);
    assert.deepEqual(searchMemory(dataDir, 'project-a', 'session.md').map((item) => item.logical_path), [
      '02-Sessões/2026/08-AGO/DIA 17/session.md',
    ]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:MEM-API-3] caminhos absolutos e escapadas são rejeitados antes da persistência', () => {
  const invalid = event({ path: '../outside.md' });
  const absolute = event({ path: 'C:/outside.md' });
  assert.equal(validateMemoryEvent(invalid).ok, false);
  assert.equal(validateMemoryEvent(absolute).ok, false);
});
