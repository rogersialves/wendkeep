import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EVIDENCE_INDEX_STATE_FILE,
  buildEvidenceIndex,
  loadEvidenceIndex,
  loadEvidenceIndexState,
  refreshEvidenceIndex,
} from '../hooks/evidence-recall.mjs';

function createVault() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-evidence-incremental-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  mkdirSync(join(vault, '02-Sessões'), { recursive: true });
  mkdirSync(join(vault, '04-Decisões'), { recursive: true });
  writeFileSync(
    join(vault, '.brain', 'PROJECT.json'),
    `${JSON.stringify({ projectId: 'project-incremental' }, null, 2)}\n`,
  );
  return vault;
}

function writeDocument(path, title, body) {
  writeFileSync(path, `---\ntitle: ${title}\ndate: 2026-08-25\n---\n# ${title}\n\n## Conteúdo\n\n${body}\n`);
}

test('[req:RECALL-7] unchanged Markdown reuses chunks without reading document bodies', () => {
  const vault = createVault();
  const decision = join(vault, '04-Decisões', 'ADR-0001-index.md');
  const session = join(vault, '02-Sessões', '2026-08-25-recall.md');
  try {
    writeDocument(decision, 'Índice incremental', 'O índice reaproveita chunks de documentos inalterados.');
    writeDocument(session, 'Sessão de recall', 'A sessão preserva uma evidência histórica independente.');

    const first = refreshEvidenceIndex(vault);
    assert.equal(first.full_rebuild, true);
    assert.equal(first.documents, 2);
    assert.equal(first.read_documents, 2);
    assert.equal(first.reindexed_documents, 2);
    assert.equal(first.reused_documents, 0);
    assert.equal(first.deleted_documents, 0);
    assert.equal(first.index_written, true);
    assert.equal(first.state_written, true);

    const before = readFileSync(join(vault, '.brain', 'EVIDENCE_INDEX.jsonl'), 'utf8');
    const beforeRows = loadEvidenceIndex(vault);
    const decisionChunks = beforeRows
      .filter((row) => row.logical_path === '04-Decisões/ADR-0001-index.md')
      .map((row) => row.chunk_id);

    const second = refreshEvidenceIndex(vault);
    assert.equal(second.full_rebuild, false);
    assert.equal(second.read_documents, 0);
    assert.equal(second.reindexed_documents, 0);
    assert.equal(second.reused_documents, 2);
    assert.equal(second.index_written, false);
    assert.equal(second.state_written, false);
    assert.equal(readFileSync(join(vault, '.brain', 'EVIDENCE_INDEX.jsonl'), 'utf8'), before);

    writeDocument(decision, 'Índice incremental', 'Somente este documento mudou e deve ser reindexado.');
    const third = refreshEvidenceIndex(vault);
    assert.equal(third.full_rebuild, false);
    assert.equal(third.read_documents, 1);
    assert.equal(third.reindexed_documents, 1);
    assert.equal(third.reused_documents, 1);
    assert.equal(third.deleted_documents, 0);
    assert.match(readFileSync(join(vault, '.brain', 'EVIDENCE_INDEX.jsonl'), 'utf8'), /Somente este documento mudou/);
    assert.notDeepEqual(
      loadEvidenceIndex(vault)
        .filter((row) => row.logical_path === '04-Decisões/ADR-0001-index.md')
        .map((row) => row.chunk_id),
      decisionChunks,
    );

    unlinkSync(session);
    const fourth = refreshEvidenceIndex(vault);
    assert.equal(fourth.read_documents, 0);
    assert.equal(fourth.reindexed_documents, 0);
    assert.equal(fourth.reused_documents, 1);
    assert.equal(fourth.deleted_documents, 1);
    assert.ok(loadEvidenceIndex(vault).every((row) => row.logical_path !== '02-Sessões/2026-08-25-recall.md'));
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:RECALL-7] corrupt or tampered cache falls back to a deterministic full rebuild', () => {
  const vault = createVault();
  const decision = join(vault, '04-Decisões', 'ADR-0002-rebuild.md');
  const indexFile = join(vault, '.brain', 'EVIDENCE_INDEX.jsonl');
  try {
    writeDocument(decision, 'Rebuild seguro', 'O Vault continua sendo a autoridade do índice derivado.');
    const built = buildEvidenceIndex(vault);
    assert.ok(built.length > 0);
    assert.equal(loadEvidenceIndexState(vault)?.documents?.['04-Decisões/ADR-0002-rebuild.md']?.chunk_count > 0, true);

    writeFileSync(join(vault, '.brain', EVIDENCE_INDEX_STATE_FILE), '{invalid-json');
    const repairedState = refreshEvidenceIndex(vault);
    assert.equal(repairedState.full_rebuild, true);
    assert.equal(repairedState.read_documents, 1);
    assert.equal(repairedState.reindexed_documents, 1);
    assert.equal(loadEvidenceIndexState(vault)?.schema_version, 1);

    writeFileSync(indexFile, '{invalid-json\n');
    const repairedIndex = refreshEvidenceIndex(vault);
    assert.equal(repairedIndex.full_rebuild, true);
    assert.equal(repairedIndex.read_documents, 1);
    assert.equal(repairedIndex.reindexed_documents, 1);
    assert.ok(loadEvidenceIndex(vault).length > 0);

    const tampered = loadEvidenceIndex(vault);
    tampered[0] = { ...tampered[0], content: 'conteúdo adulterado, mas JSON válido' };
    writeFileSync(indexFile, `${tampered.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const repairedTamper = refreshEvidenceIndex(vault);
    assert.equal(repairedTamper.full_rebuild, true);
    assert.equal(repairedTamper.read_documents, 1);
    assert.doesNotMatch(readFileSync(indexFile, 'utf8'), /conteúdo adulterado/);
    assert.match(readFileSync(indexFile, 'utf8'), /Vault continua sendo a autoridade/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:RECALL-7] hardlinked Markdown never imports bytes from outside the Vault authority', () => {
  const vault = createVault();
  const outside = mkdtempSync(join(tmpdir(), 'wk-evidence-outside-'));
  const external = join(outside, 'external.md');
  const alias = join(vault, '04-Decisões', 'ADR-9999-external.md');
  try {
    writeDocument(external, 'Segredo externo', 'private-secret-value must never enter the derived index.');
    linkSync(external, alias);
    const result = refreshEvidenceIndex(vault);
    assert.equal(result.documents, 0);
    assert.equal(result.chunks.length, 0);
    assert.doesNotMatch(readFileSync(join(vault, '.brain', 'EVIDENCE_INDEX.jsonl'), 'utf8'), /private-secret-value/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
