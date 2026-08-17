import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startObserverServer } from '../src/observer-server.mjs';
import {
  buildMemoryEventBatch,
  listMemoryOutbox,
  publishObserverMemory,
  retryObserverMemoryOutbox,
} from '../src/observer-memory-publish.mjs';
import { registerObserverProject } from '../src/observer-store.mjs';
import { makeDataDir, makeObserverFixture } from './helpers/observer-fixture.mjs';

function seedMemory(fixture) {
  const files = {
    'CORE.md': '# Core WendKeep\n\nRegra canônica do projeto.\n',
    '02-Sessões/2026/08-AGO/DIA 17/session.md': '# Sessão completa\n\nTurno preservado.\n',
    '04-Decisões/2026/08-AGO/ADR-0001.md': '# Decisão\n\nDecisão registrada.\n',
    '05-Bugs/2026/08-AGO/BUG-0001.md': '# Bug\n\nFalha registrada.\n',
    '06-Aprendizados/2026/08-AGO/APR-0001.md': '# Aprendizado\n\nLição registrada.\n',
    '07-Specs/memory.md': '# Spec\n\nContrato registrado.\n',
    '08-Mudanças/example/proposta.md': '# Change\n\nMudança registrada.\n',
    '.brain/SESSION_REGISTRY.json': '{"version":2,"sessions":{}}\n',
  };
  for (const [path, content] of Object.entries(files)) {
    const target = join(fixture.vaultBase, ...path.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

test('[req:MEM-HOOK-5] coletor reúne conteúdo completo das raízes autorizadas e evita o estado do próprio publisher', () => {
  const fixture = makeObserverFixture();
  try {
    seedMemory(fixture);
    const first = buildMemoryEventBatch({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      now: '2026-08-17T12:00:00.000Z',
    });
    assert.equal(first.events.length, 12);
    assert.equal(first.events.find((item) => item.logical_path === 'CORE.md').content, '# Core WendKeep\n\nRegra canônica do projeto.\n');
    assert.equal(first.events.find((item) => item.logical_path === '04-Decisões/2026/08-AGO/ADR-0001.md').entity_type, 'decision');
    assert.equal(first.events.find((item) => item.logical_path === '05-Bugs/2026/08-AGO/BUG-0001.md').entity_type, 'bug');
    assert.equal(first.events.find((item) => item.logical_path === '08-Mudanças/example/proposta.md').entity_type, 'change');

    writeFileSync(join(fixture.vaultBase, 'CORE.md'), '# Core WendKeep\n\nAtualizado.\n', 'utf8');
    const second = buildMemoryEventBatch({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      now: '2026-08-17T12:01:00.000Z',
      state: first.nextState,
    });
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].logical_path, 'CORE.md');
    assert.equal(second.events[0].revision, 2);
  } finally {
    fixture.cleanup();
  }
});

test('[req:MEM-HOOK-5] [req:MEM-RECOVERY-8] publisher faz outbox completo quando o container está indisponível', async () => {
  const fixture = makeObserverFixture();
  try {
    seedMemory(fixture);
    const result = await publishObserverMemory({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      url: 'http://127.0.0.1:1',
      now: '2026-08-17T12:00:00.000Z',
    });
    assert.equal(result.ok, false);
    assert.equal(result.queued, true);
    assert.equal(listMemoryOutbox(fixture.vaultBase).length, 1);
    const queued = JSON.parse(readFileSync(listMemoryOutbox(fixture.vaultBase)[0], 'utf8'));
    assert.equal(queued.events.length, 12);
    assert.equal(queued.events.some((item) => /registrada|preservado|canônica|WendKeep/.test(item.content)), true);
  } finally {
    fixture.cleanup();
  }
});

test('[req:MEM-HOOK-5] reenvio do outbox confirma o conteúdo no container e remove somente o lote aceito', async () => {
  const fixture = makeObserverFixture();
  const dataDir = makeDataDir();
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir });
  try {
    seedMemory(fixture);
    registerObserverProject(dataDir, { projectId: fixture.projectId, projectName: fixture.projectName });
    await publishObserverMemory({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      url: 'http://127.0.0.1:1',
      now: '2026-08-17T12:00:00.000Z',
    });
    assert.equal(listMemoryOutbox(fixture.vaultBase).length, 1);
    const result = await retryObserverMemoryOutbox({
      vaultBase: fixture.vaultBase,
      projectId: fixture.projectId,
      url: 'http://127.0.0.1:' + server.address().port,
    });
    assert.equal(result.confirmed, 1);
    assert.equal(listMemoryOutbox(fixture.vaultBase).length, 0);
  } finally {
    await server.close();
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
