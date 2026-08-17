import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startObserverServer } from '../src/observer-server.mjs';
import { runObserver } from '../src/observer.mjs';
import { makeDataDir, makeObserverFixture } from './helpers/observer-fixture.mjs';

test('[req:MEM-MIGRATION-6] observer memory import registra o projeto, envia o vault e devolve paridade', async () => {
  const fixture = makeObserverFixture();
  const dataDir = makeDataDir();
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir });
  try {
    mkdirSync(join(fixture.vaultBase, '02-Sessões/2026/08-AGO/DIA 17'), { recursive: true });
    writeFileSync(
      join(fixture.vaultBase, '02-Sessões/2026/08-AGO/DIA 17/full.md'),
      '# Conteúdo integral\n\nImportação do WendKeep.\n',
      'utf8',
    );
    let stdout = '';
    const status = await runObserver([
      'memory',
      'import',
      '--project',
      fixture.projectRoot,
      '--vault',
      fixture.vaultBase,
      '--data-dir',
      dataDir,
      '--url',
      'http://127.0.0.1:' + server.address().port,
      '--json',
    ], { write: (chunk) => { stdout += String(chunk); } });
    assert.equal(status, 0);
    const body = JSON.parse(stdout);
    assert.equal(body.ok, true);
    assert.equal(body.parity.missing, 0);
    assert.equal(body.parity.mismatched, 0);
    assert.ok(body.parity.files > 0);
  } finally {
    await server.close();
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
