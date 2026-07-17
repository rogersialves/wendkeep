// DRV-2 — numeração monotônica por pasta derivada (BUG-/APR- espelham ADR-).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getNextDerivedNumber, getNextAdrNumber } from '../hooks/obsidian-common.mjs';

function vaultWith(files) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-num-'));
  for (const rel of files) {
    const abs = join(vault, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, '---\ntype: bug\n---\n# x\n');
  }
  return vault;
}

test('getNextDerivedNumber: empty folder yields 1', () => {
  const vault = vaultWith([]);
  try {
    assert.equal(getNextDerivedNumber(vault, 'bugs', 'BUG'), 1);
    assert.equal(getNextDerivedNumber(vault, 'learnings', 'APR'), 1);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('getNextDerivedNumber: recursive walk across root, month and legacy DIA folders', () => {
  const vault = vaultWith([
    '05-Bugs/BUG-0001-na-raiz.md',
    '05-Bugs/2026/07-JUL/BUG-0003-no-mes.md',
    '05-Bugs/2026/07-JUL/DIA 16/BUG-0007-legado-dia.md',
  ]);
  try {
    assert.equal(getNextDerivedNumber(vault, 'bugs', 'BUG'), 8);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('getNextDerivedNumber: ignores other prefixes and is case-insensitive', () => {
  const vault = vaultWith([
    '05-Bugs/2026/07-JUL/APR-0099-prefixo-errado.md',
    '05-Bugs/2026/07-JUL/bug-0004-minusculo.md',
    '05-Bugs/2026/07-JUL/2026-07-16-bug-sem-numero.md',
  ]);
  try {
    assert.equal(getNextDerivedNumber(vault, 'bugs', 'BUG'), 5, 'APR ignorado; bug- minúsculo conta; nota sem número não conta');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('getNextAdrNumber: still the decisions/ADR behavior (wrapper)', () => {
  const vault = vaultWith(['04-Decisões/2026/07-JUL/ADR-0006-x.md']);
  try {
    assert.equal(getNextAdrNumber(vault), 7);
    assert.equal(getNextDerivedNumber(vault, 'decisions', 'ADR'), 7);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// DRV-1 — createLinkedNotes nomeia BUG-/APR-NNNN na pasta do mês
const SESSION_REL = '02-Sessões/2026/07-JUL/DIA 16/20-00-s.md';
function bugLearningTx() {
  return {
    assistantMessages: [
      'Causa raiz: o parser de tarefas descartava requisitos extras em silêncio quando havia mais de um por linha.',
      'git commit -m "fix(parser): captura todos os requisitos"',
      'Aprendizado: regex sem flag global só retorna o primeiro match e esconde os demais.',
      'Aprendizado: constantes de regex compartilhadas evitam divergência entre parsers.',
    ],
    userPrompts: ['tem um bug no parser de tarefas'],
  };
}

test('createLinkedNotes: bug and learnings are numbered in the month folder (no DIA)', async () => {
  const { createLinkedNotes } = await import('../hooks/linked-notes.mjs');
  const vault = vaultWith([]);
  try {
    const linked = createLinkedNotes(vault, '2026-07-16', SESSION_REL, bugLearningTx(), {});
    assert.equal(linked.bugs.length, 1);
    assert.match(linked.bugs[0], /^05-Bugs\/2026\/07-JUL\/BUG-0001-/, 'bug numerado na pasta do mês');
    assert.doesNotMatch(linked.bugs[0], /DIA/, 'sem subpasta DIA');
    assert.ok(linked.learnings.length >= 2, `learnings extraídos: ${linked.learnings.length}`);
    const nums = linked.learnings.map((r) => Number(r.match(/APR-(\d+)-/)?.[1]));
    assert.deepEqual(nums, nums.map((_, i) => i + 1), 'APR sequencial começando em 1');
    for (const rel of linked.learnings) assert.match(rel, /^06-Aprendizados\/2026\/07-JUL\/APR-\d{4}-/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// DRV-5 — Stop enxerga notas derivadas nas subpastas de mês (não só na raiz)
test('findLinkedDerivedNotes: finds a month-folder note that references the session', async () => {
  const { findLinkedDerivedNotes } = await import('../hooks/session-stop.mjs');
  const vault = mkdtempSync(join(tmpdir(), 'wk-fldn-'));
  try {
    const dir = join(vault, '05-Bugs', '2026', '07-JUL');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'BUG-0001-x.md'), `---\ntype: bug\n---\n# BUG-0001 — x\nVer [[${SESSION_REL.replace(/\.md$/, '')}]]\n`);
    const linked = findLinkedDerivedNotes(vault, SESSION_REL);
    assert.equal(linked.bugs.length, 1, 'nota na subpasta de mês encontrada');
    assert.match(linked.bugs[0], /^05-Bugs\/2026\/07-JUL\/BUG-0001-x\.md$/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('createLinkedNotes: dedup on re-run does not burn numbers; continues from existing max', async () => {
  const { createLinkedNotes } = await import('../hooks/linked-notes.mjs');
  const vault = vaultWith(['05-Bugs/2026/06-JUN/BUG-0041-antigo.md']);
  try {
    const first = createLinkedNotes(vault, '2026-07-16', SESSION_REL, bugLearningTx(), {});
    assert.match(first.bugs[0], /BUG-0042-/, 'continua do max existente');
    const again = createLinkedNotes(vault, '2026-07-16', SESSION_REL, bugLearningTx(), {});
    assert.equal(again.bugs.length, 0, 'dedup por content_key');
    assert.equal(again.learnings.length, 0, 'learnings deduplicados');
    assert.equal(getNextDerivedNumber(vault, 'bugs', 'BUG'), 43, 'número não queimado no re-run');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
