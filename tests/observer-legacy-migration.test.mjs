import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startObserverServer } from '../src/observer-server.mjs';
import { makeDataDir } from './helpers/observer-fixture.mjs';

test('[req:SQL-OBS-5] startup importa memória Markdown legada do volume para SQLite sem apagar a fonte', async () => {
  const dataDir = makeDataDir();
  const projectRoot = join(dataDir, 'memory', 'legacy-project');
  const logicalPath = '04-Decisões/2026/08-AGO/ADR-0001.md';
  const content = '# Decisão legada\n\nPreservada no banco.\n';
  mkdirSync(join(projectRoot, '04-Decisões/2026/08-AGO'), { recursive: true });
  writeFileSync(join(projectRoot, logicalPath), content, 'utf8');
  writeFileSync(join(dataDir, 'MEMORY_INDEX.json'), JSON.stringify({ schema_version: 1, projects: { 'legacy-project': { project_name: 'Legado' } } }), 'utf8');
  try {
    const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const tree = await (await fetch(`${base}/v1/projects/legacy-project/memory/tree`)).json();
      assert.equal(tree.document_count, 1);
      const document = await (await fetch(`${base}/v1/projects/legacy-project/memory/document?path=${encodeURIComponent(logicalPath)}`)).json();
      assert.equal(document.content, content);
      assert.equal(document.revision, 1);
      assert.equal((await fetch(`${base}/v1/projects`)).status, 200);
    } finally {
      await server.close();
    }
    const second = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir });
    try {
      const health = await (await fetch(`http://127.0.0.1:${second.address().port}/healthz`)).json();
      assert.equal(health.database.legacy_migration.skipped, true);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
