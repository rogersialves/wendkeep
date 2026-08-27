import assert from 'node:assert/strict';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadEvidenceSearchState,
  refreshEvidenceIndex,
  refreshEvidenceSearchIndex,
} from '../hooks/evidence-recall.mjs';
import {
  inspectEvidenceSearchHealth,
  renderEvidenceSearchHealthLines,
} from '../src/evidence-search-health.mjs';

function scratch() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-doctor-evidence-search-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  mkdirSync(join(vault, '04-Decisões'), { recursive: true });
  writeFileSync(
    join(vault, '.brain', 'PROJECT.json'),
    `${JSON.stringify({ projectId: 'doctor-evidence-search' }, null, 2)}\n`,
  );
  return vault;
}

function writeDecision(vault, body) {
  const path = join(vault, '04-Decisões', 'ADR-busca.md');
  writeFileSync(path, [
    '---',
    'title: Métrica de recall',
    'authority: verified',
    'validity: active',
    'date: 2026-08-27',
    '---',
    '# Métrica de recall',
    '',
    '## Evidência',
    '',
    body,
    '',
  ].join('\n'));
  return path;
}

function build(vault) {
  const index = refreshEvidenceIndex(vault);
  const search = refreshEvidenceSearchIndex(vault, index.chunks, {
    force: true,
    sqlite: 'off',
  });
  return { index, search };
}

function byteSnapshot(root) {
  const entries = [];
  const walk = (dir, rel = '') => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const itemRel = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, itemRel);
      else entries.push([itemRel, readFileSync(path)]);
    }
  };
  walk(root);
  return entries;
}

test('[req:RECALL-10] doctor reports current authority and bounded search artifacts read-only', () => {
  const vault = scratch();
  try {
    writeDecision(vault, 'A evidência contém marcador-doctor-recall.');
    const built = build(vault);
    assert.equal(built.search.sqlite_available, false);
    const before = byteSnapshot(vault);

    const health = inspectEvidenceSearchHealth(vault);
    assert.deepEqual(byteSnapshot(vault), before, 'recall health inspection must be read-only');
    assert.equal(health.schemaVersion, 1);
    assert.equal(health.status, 'healthy');
    assert.equal(health.authorityStatus, 'present');
    assert.ok(health.authorityBytes > 0);
    assert.equal(health.incrementalStateStatus, 'ok');
    assert.equal(health.documentCount, 1);
    assert.equal(health.searchStateStatus, 'current');
    assert.equal(health.rowCount, built.index.chunks.length);
    assert.equal(health.sourceIndexCurrent, true);
    assert.equal(health.sourceStateCurrent, true);
    assert.equal(health.lexicalStatus, 'current');
    assert.ok(health.lexicalBytes > health.authorityBytes);
    assert.equal(health.sqliteStatus, 'not-built');
    assert.equal(health.backend, 'lexical-sidecar');

    const rendered = renderEvidenceSearchHealthLines(health).join('\n');
    assert.match(rendered, /\[recall\] saudável/i);
    assert.match(rendered, /backend: lexical-sidecar/i);
    assert.match(rendered, /documentos: 1/i);
    assert.match(rendered, /lexical: atual/i);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:RECALL-10] source changes expose stale derived search without rebuilding it', () => {
  const vault = scratch();
  try {
    const document = writeDecision(vault, 'A evidência contém sinal-antigo-doctor.');
    build(vault);
    const stateBefore = readFileSync(join(vault, '.brain', 'EVIDENCE_SEARCH_STATE.json'));

    writeDecision(vault, 'A evidência agora contém sinal-novo-doctor.');
    refreshEvidenceIndex(vault);
    const health = inspectEvidenceSearchHealth(vault);

    assert.equal(health.status, 'warning');
    assert.equal(health.searchStateStatus, 'stale');
    assert.equal(health.sourceIndexCurrent, false);
    assert.equal(health.backend, 'lexical-ephemeral');
    assert.deepEqual(
      readFileSync(join(vault, '.brain', 'EVIDENCE_SEARCH_STATE.json')),
      stateBefore,
      'doctor must not rebuild stale search state',
    );
    assert.ok(statSync(document).isFile());
    assert.match(
      renderEvidenceSearchHealthLines(health).join('\n'),
      /próximo recall pode reconstruir/i,
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:RECALL-10] unsafe derived artifact blocks recall diagnostics without leaking a path', (t) => {
  const vault = scratch();
  const outside = mkdtempSync(join(tmpdir(), 'wk-doctor-evidence-search-outside-'));
  try {
    writeDecision(vault, 'A evidência contém marcador-hardlink-recall.');
    build(vault);
    const state = loadEvidenceSearchState(vault);
    const artifact = join(vault, '.brain', ...state.lexical.path.split('/'));
    try {
      linkSync(artifact, join(outside, 'lexical-hardlink.json'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    const before = byteSnapshot(vault);
    const health = inspectEvidenceSearchHealth(vault);

    assert.equal(health.status, 'blocked');
    assert.equal(health.errorCode, 'VAULT_PATH_UNSAFE');
    assert.deepEqual(byteSnapshot(vault), before, 'blocked inspection must remain read-only');
    const rendered = renderEvidenceSearchHealthLines(health).join('\n');
    assert.match(rendered, /\[recall\] bloqueado/i);
    assert.match(rendered, /VAULT_PATH_UNSAFE/);
    assert.equal(rendered.includes(vault), false);
    assert.equal(rendered.includes(outside), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
