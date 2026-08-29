import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EVIDENCE_SEARCH_STATE_FILE,
  evidenceSearchSqliteAvailable,
  loadEvidenceIndex,
  loadEvidenceSearchState,
  recallEvidenceIndexed,
  refreshEvidenceIndex,
  refreshEvidenceSearchIndex,
  searchEvidenceCandidates,
} from '../hooks/evidence-recall.mjs';

function createVault() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-evidence-search-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  mkdirSync(join(vault, '02-Sessões'), { recursive: true });
  mkdirSync(join(vault, '04-Decisões'), { recursive: true });
  writeFileSync(
    join(vault, '.brain', 'PROJECT.json'),
    `${JSON.stringify({ projectId: 'project-search' }, null, 2)}\n`,
  );
  return vault;
}

function writeDocument(vault, logicalPath, {
  title,
  body,
  authority = 'verified',
  validity = 'active',
  date = '2026-08-26',
} = {}) {
  const path = join(vault, ...logicalPath.split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, [
    '---',
    `title: ${title}`,
    `authority: ${authority}`,
    `validity: ${validity}`,
    `date: ${date}`,
    '---',
    `# ${title}`,
    '',
    '## Evidência',
    '',
    body,
    '',
  ].join('\n'));
  return path;
}

function build(vault, options = {}) {
  const refreshed = refreshEvidenceIndex(vault);
  const search = refreshEvidenceSearchIndex(vault, refreshed.chunks, options);
  return { refreshed, search };
}

test('[req:RECALL-8] lexical sidecar is persistent, bounded, and reaches old evidence', () => {
  const vault = createVault();
  try {
    for (let index = 0; index < 40; index += 1) {
      writeDocument(vault, `02-Sessões/2026-08-${String((index % 25) + 1).padStart(2, '0')}-${index}.md`, {
        title: `Sessão ${index}`,
        body: `registro comum de manutenção número ${index}`,
        authority: 'reported',
        date: `2026-08-${String((index % 25) + 1).padStart(2, '0')}`,
      });
    }
    writeDocument(vault, '04-Decisões/2020-01-01-ancora-antiga.md', {
      title: 'Âncora histórica',
      body: 'A palavra exclusiva nebulosa-ancora preserva esta evidência antiga.',
      date: '2020-01-01',
    });

    const first = build(vault, { sqlite: 'off' });
    assert.equal(first.search.reused, false);
    assert.equal(first.search.sqlite_available, false);
    assert.equal(loadEvidenceSearchState(vault)?.row_count, first.refreshed.chunks.length);

    const second = refreshEvidenceSearchIndex(vault, loadEvidenceIndex(vault), { sqlite: 'off' });
    assert.equal(second.reused, true);
    assert.equal(second.lexical_written, false);

    const found = searchEvidenceCandidates(vault, 'nebulosa-ancora', {
      backend: 'lexical',
      candidateLimit: 3,
      postingBudget: 8,
      sqlite: 'off',
    });
    assert.equal(found.backend, 'lexical-sidecar');
    assert.equal(found.rows[0].logical_path, '04-Decisões/2020-01-01-ancora-antiga.md');
    assert.ok(found.posting_entries <= 8);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:RECALL-8] SQLite availability represents FTS5 and auto mode degrades safely', () => {
  const vault = createVault();
  try {
    writeDocument(vault, '04-Decisões/ADR-capacidade-fts.md', {
      title: 'Capacidade FTS',
      body: 'A evidência contém marcador-capacidade-fts.',
    });

    const first = build(vault, { sqlite: 'auto' });
    assert.equal(first.search.sqlite_available, evidenceSearchSqliteAvailable());

    if (evidenceSearchSqliteAvailable()) {
      assert.equal(first.search.sqlite_reason, '');
      assert.ok(first.search.state.sqlite);
      return;
    }

    assert.equal(first.search.state.sqlite, null);
    assert.ok([
      'node-sqlite-unavailable',
      'fts5-unavailable',
    ].includes(first.search.sqlite_reason));
    assert.equal(searchEvidenceCandidates(vault, 'marcador-capacidade-fts', {
      backend: 'auto',
      candidateLimit: 3,
    }).rows[0].logical_path, '04-Decisões/ADR-capacidade-fts.md');

    assert.throws(
      () => refreshEvidenceSearchIndex(vault, loadEvidenceIndex(vault), {
        force: true,
        sqlite: 'required',
      }),
      (error) => [
        'EVIDENCE_SEARCH_SQLITE_UNAVAILABLE',
        'EVIDENCE_SEARCH_FTS5_UNAVAILABLE',
      ].includes(error?.code),
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:RECALL-8] filters are equivalent across lexical and SQLite FTS backends', {
  skip: !evidenceSearchSqliteAvailable(),
}, () => {
  const vault = createVault();
  try {
    writeDocument(vault, '04-Decisões/100%_real/ADR-verificada.md', {
      title: 'Contrato FTS verificado',
      body: 'O contrato motor-foguete foi validado por teste.',
      authority: 'verified',
    });
    writeDocument(vault, '04-Decisões/100ABreal/ADR-decoy.md', {
      title: 'Contrato FTS fora do prefixo literal',
      body: 'O contrato motor-foguete não pertence ao prefixo com percent e underscore literais.',
      authority: 'verified',
    });
    writeDocument(vault, '02-Sessões/relato.md', {
      title: 'Relato FTS',
      body: 'O relato motor-foguete ainda é apenas observado.',
      authority: 'reported',
    });
    writeDocument(vault, '04-Decisões/ADR-superada.md', {
      title: 'Contrato antigo',
      body: 'O contrato motor-foguete foi substituído.',
      authority: 'verified',
      validity: 'superseded',
    });

    build(vault, { sqlite: 'required' });
    const options = {
      filters: {
        authority: 'verified',
        validity: 'active',
        logical_path_prefix: '04-Decisões/100%_real/',
      },
      candidateLimit: 10,
      postingBudget: 100,
    };
    const lexical = searchEvidenceCandidates(vault, 'motor-foguete', {
      ...options,
      backend: 'lexical',
    });
    const sqlite = searchEvidenceCandidates(vault, 'motor-foguete', {
      ...options,
      backend: 'sqlite',
    });

    assert.equal(sqlite.backend, 'sqlite-fts5');
    assert.deepEqual(
      sqlite.rows.map((row) => row.chunk_id).sort(),
      lexical.rows.map((row) => row.chunk_id).sort(),
    );
    assert.ok(sqlite.rows.every((row) => row.authority === 'verified'
      && row.validity === 'active'
      && row.logical_path.startsWith('04-Decisões/100%_real/')));
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:RECALL-8] source changes invalidate the derived search state and rebuild lazily', () => {
  const vault = createVault();
  try {
    const document = writeDocument(vault, '04-Decisões/ADR-mutável.md', {
      title: 'Estado inicial',
      body: 'A evidência contém sinal-antigo.',
    });
    build(vault, { sqlite: 'off' });
    const before = loadEvidenceSearchState(vault).index_hash;

    writeFileSync(document, [
      '---',
      'title: Estado alterado',
      'authority: verified',
      'validity: active',
      'date: 2026-08-26',
      '---',
      '# Estado alterado',
      '',
      '## Evidência',
      '',
      'A evidência agora contém sinal-novo.',
      '',
    ].join('\n'));
    refreshEvidenceIndex(vault);

    const result = recallEvidenceIndexed(vault, 'sinal-novo', {
      backend: 'lexical',
      sqlite: 'off',
      topK: 3,
    });
    assert.equal(result.metrics.rebuilt, true);
    assert.equal(result.results[0].logical_path, '04-Decisões/ADR-mutável.md');
    assert.notEqual(loadEvidenceSearchState(vault).index_hash, before);
    assert.equal(recallEvidenceIndexed(vault, 'sinal-antigo', {
      backend: 'lexical', sqlite: 'off',
    }).results.length, 0);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:RECALL-8] a corrupted lexical artifact is never trusted and falls back to authority', () => {
  const vault = createVault();
  try {
    writeDocument(vault, '04-Decisões/ADR-recuperação.md', {
      title: 'Recuperação lexical',
      body: 'A evidência íntegra contém chave-recuperável.',
    });
    build(vault, { sqlite: 'off' });
    const state = loadEvidenceSearchState(vault);
    const artifactPath = join(vault, '.brain', ...state.lexical.path.split('/'));
    writeFileSync(artifactPath, '{"tampered":true}\n');

    const result = searchEvidenceCandidates(vault, 'chave-recuperável', {
      backend: 'lexical',
      sqlite: 'off',
      candidateLimit: 5,
    });
    assert.equal(result.backend, 'lexical-ephemeral');
    assert.equal(result.fallback_reason, 'EVIDENCE_SEARCH_ARTIFACT_DIVERGED');
    assert.equal(result.rows[0].logical_path, '04-Decisões/ADR-recuperação.md');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:RECALL-8] posting budget caps lexical work and exposes incomplete candidates', () => {
  const vault = createVault();
  try {
    for (let index = 0; index < 20; index += 1) {
      writeDocument(vault, `04-Decisões/ADR-${String(index).padStart(2, '0')}.md`, {
        title: `Decisão ${index}`,
        body: `termo-comum decisão ${index}`,
      });
    }
    build(vault, { sqlite: 'off' });
    const result = searchEvidenceCandidates(vault, 'termo-comum', {
      backend: 'lexical',
      sqlite: 'off',
      candidateLimit: 10,
      postingBudget: 5,
    });
    assert.equal(result.posting_entries, 5);
    assert.equal(result.has_more, true);
    assert.ok(result.rows.length <= 5);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:RECALL-8] search state remains a derived pointer, not the JSONL authority', () => {
  const vault = createVault();
  try {
    writeDocument(vault, '04-Decisões/ADR-autoridade.md', {
      title: 'Autoridade JSONL',
      body: 'A origem mantém valor-autoritativo.',
    });
    build(vault, { sqlite: 'off' });
    const statePath = join(vault, '.brain', EVIDENCE_SEARCH_STATE_FILE);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.schema_version, 1);
    assert.match(state.lexical.path, /^evidence-search\/lexical-/);
    assert.equal(loadEvidenceIndex(vault)[0].content.includes('valor-autoritativo'), true);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
