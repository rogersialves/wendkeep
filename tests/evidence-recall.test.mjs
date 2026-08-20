import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  benchmarkEvidenceRecall,
  buildEvidenceIndex,
  chunkMarkdownDocument,
  loadEvidenceIndex,
  recallEvidence,
  renderEvidenceContext,
} from '../hooks/evidence-recall.mjs';
import { buildPromptEvidenceContext } from '../hooks/evidence-context.mjs';

function document(path, title, heading, text, metadata = {}) {
  return chunkMarkdownDocument({
    projectId: 'project-recall',
    logicalPath: path,
    content: `---\ntitle: ${title}\ndate: ${metadata.date || '2026-08-01'}\nstatus: ${metadata.status || 'active'}\nauthority: ${metadata.authority || 'verified'}\n${metadata.session_id ? `session_id: ${metadata.session_id}\n` : ''}---\n# ${title}\n\n## ${heading}\n\n${text}\n`,
  });
}

function benchmarkFixture() {
  const rows = [];
  const cases = [];
  const topics = [
    ['sqlite-wal', 'Decisão SQLite', 'Autoridade SQL', 'Usar SQLite com WAL para consultas multiprojeto.'],
    ['release-receipt', 'Entrega comprovada', 'Receipt', 'Toda entrega grava receipt append-only com SHA e integridade npm.'],
    ['branch-scope', 'Escopo de branch', 'Registrador HEAD', 'O HEAD da main e da feature coexistem por worktree e branch.'],
    ['doctor-degraded', 'Doctor proporcional', 'Memória degradada', 'Conflito semântico degrada somente a chave ambígua.'],
    ['reopened-bug', 'Bug reaberto', 'Falha de retry', 'O bug de retry foi reaberto após reprodução no Windows.'],
    ['bm25-ranking', 'Recall lexical', 'Ranking BM25', 'BM25 combina frase exata, autoridade, validade e diversidade.'],
    ['prompt-budget', 'Context broker', 'Budget explícito', 'O UserPromptSubmit injeta poucas evidências dentro de 3072 bytes.'],
    ['handoff-claude-codex', 'Handoff Claude Codex', 'Continuidade', 'Claude entregou o parser e Codex deve retomar os testes de integração.'],
    ['handoff-codex-claude', 'Handoff Codex Claude', 'Continuity', 'Codex finished the schema and Claude should resume the migration test.'],
    ['fts-feature-probe', 'Observer FTS5', 'Feature probe', 'O Observer testa FTS5 e usa fallback lexical quando indisponível.'],
  ];
  topics.forEach(([token, title, heading, text], index) => {
    const path = `02-Sessões/2026-08-${String(index + 1).padStart(2, '0')}-${token}.md`;
    const chunks = document(path, title, heading, `${text} Marcador exclusivo ${token}.`, {
      session_id: `session-${index + 1}`,
    });
    rows.push(...chunks);
    const expected = chunks.find((chunk) => chunk.heading === heading);
    cases.push({ query: token.replaceAll('-', ' '), expected_chunk_id: expected.chunk_id, handoff: token.startsWith('handoff-') });
  });
  for (let index = 10; index < 24; index += 1) {
    rows.push(...document(
      `02-Sessões/2026-07-${String(index + 1).padStart(2, '0')}-noise-${index}.md`,
      `Sessão auxiliar ${index}`,
      index % 2 ? 'Feature paralela' : 'Bug fechado',
      `Contexto auxiliar bilíngue sem os marcadores esperados. Parallel branch session number ${index}.`,
      { session_id: `noise-${index}`, authority: index % 3 ? 'reported' : 'candidate' },
    ));
  }
  rows.push(...document(
    '04-Decisões/ADR-0001-old-recall.md', 'Decisão antiga de recall', 'Ranking BM25',
    'BM25 antigo escolhia sempre a resposta obsoleta.',
    { status: 'superseded', date: '2025-01-01' },
  ));
  return { rows, cases };
}

test('[req:RECALL-1] markdown is chunked by headings with complete provenance', () => {
  const chunks = chunkMarkdownDocument({
    projectId: 'project-a',
    logicalPath: '08-Mudanças/scoped-memory/tarefas.md',
    content: '---\nchange_slug: scoped-memory\nsession_id: session-a\nwork_session_id: work-a\ndate: 2026-08-20\n---\n# Plano\n\n## Requisitos\n\nO registrador precisa de escopo.\n\n## Tarefas\n\n- [ ] Implementar migração.\n',
  });
  assert.ok(chunks.length >= 2);
  const requirement = chunks.find((chunk) => chunk.heading === 'Requisitos');
  assert.equal(requirement.entity_type, 'requirement');
  assert.equal(requirement.change_slug, 'scoped-memory');
  assert.equal(requirement.session_id, 'session-a');
  assert.equal(requirement.work_session_id, 'work-a');
  assert.equal(requirement.authority, 'verified');
  assert.match(requirement.content_hash, /^[a-f0-9]{64}$/);
});

test('[req:RECALL-2] ranking returns the matching passage, provenance and active authority', () => {
  const { rows } = benchmarkFixture();
  const results = recallEvidence(rows, 'como funciona o ranking BM25?', { topK: 5, now: Date.parse('2026-08-20') });
  assert.match(results[0].excerpt, /BM25 combina frase exata/i);
  assert.equal(results[0].validity, 'active');
  assert.equal(results[0].authority, 'verified');
  assert.ok(results[0].logical_path);
  assert.ok(results[0].heading);
  assert.ok(results.every((item, index) => index === 0 || item.logical_path !== results[0].logical_path));
});

test('[req:RECALL-3] benchmark with 25 documents exceeds the milestone thresholds', () => {
  const { rows, cases } = benchmarkFixture();
  assert.ok(new Set(rows.map((row) => row.logical_path)).size >= 25);
  const metrics = benchmarkEvidenceRecall(rows, cases, { now: Date.parse('2026-08-20') });
  assert.ok(metrics.recall_at_5 >= 0.85, JSON.stringify(metrics));
  assert.ok(metrics.mrr >= 0.75, JSON.stringify(metrics));
  assert.ok(metrics.stale_answer_rate <= 0.05, JSON.stringify(metrics));
  assert.ok(metrics.evidence_accuracy >= 0.95, JSON.stringify(metrics));
  assert.ok(metrics.handoff_success >= 0.90, JSON.stringify(metrics));
});

test('[req:RECALL-4] local index and UserPromptSubmit context stay independent from Observer', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-evidence-index-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    writeFileSync(join(vault, '.brain', 'PROJECT.json'), JSON.stringify({ projectId: 'project-a' }));
    writeFileSync(join(vault, '04-Decisões', 'ADR-0001-sqlite.md'), '# SQLite\n\n## Decisão\n\nAtivar WAL como autoridade local.\n');
    const built = buildEvidenceIndex(vault);
    assert.ok(built.length >= 1);
    assert.equal(loadEvidenceIndex(vault).length, built.length);
    assert.match(readFileSync(join(vault, '.brain', 'EVIDENCE_INDEX.jsonl'), 'utf8'), /Ativar WAL/);

    const context = buildPromptEvidenceContext(vault, 'qual foi a decisão sobre WAL?', { maxBytes: 900 });
    assert.match(context, /<wk_evidence_recall>/);
    assert.match(context, /Ativar WAL/);
    assert.match(context, /source:04-Decisões\/ADR-0001-sqlite\.md/);
    assert.ok(Buffer.byteLength(context, 'utf8') <= 900);
    assert.equal(buildPromptEvidenceContext(vault, '# AGENTS.md instructions'), '');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:RECALL-5] rendered recall never slices an entry beyond its explicit byte budget', () => {
  const { rows } = benchmarkFixture();
  const output = renderEvidenceContext(recallEvidence(rows, 'handoff Claude Codex', { topK: 5 }), { maxBytes: 700 });
  assert.ok(Buffer.byteLength(output, 'utf8') <= 700);
  assert.match(output, /^<wk_evidence_recall>[\s\S]*<\/wk_evidence_recall>$/);
});
