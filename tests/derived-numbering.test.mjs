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

// DRV-8 — dedup de bug/decisão enxerga notas da sessão em qualquer subpasta (incl. DIA legado)
test('existingKeysForSession: finds a session note in a legacy DIA subfolder (recursive)', async () => {
  const { existingKeysForSession } = await import('../hooks/linked-notes.mjs');
  const vault = vaultWith([]);
  try {
    const sessionRel = '02-Sessões/2026/06-JUN/DIA 12/01-26-x.md';
    const dia = join(vault, '04-Decisões', '2026', '06-JUN', 'DIA 12');
    mkdirSync(dia, { recursive: true });
    writeFileSync(join(dia, 'ADR-0018-regra.md'), '---\ntype: decision\ncontent_key: "chave-legada"\nsession: "[[02-Sessões/2026/06-JUN/DIA 12/01-26-x]]"\n---\n# ADR-0018\n');
    const keys = existingKeysForSession(vault, sessionRel, '2026-06-12');
    assert.deepEqual(keys.decisions, ['chave-legada'], 'nota em DIA da sessão é vista (scan recursivo)');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('existingKeysForSession: month-folder note still deduped; unrelated note ignored', async () => {
  const { existingKeysForSession } = await import('../hooks/linked-notes.mjs');
  const vault = vaultWith([]);
  try {
    const sessionRel = '02-Sessões/2026/06-JUN/DIA 12/01-26-x.md';
    const mes = join(vault, '05-Bugs', '2026', '06-JUN');
    mkdirSync(mes, { recursive: true });
    writeFileSync(join(mes, 'BUG-0001-y.md'), '---\ntype: bug\ncontent_key: "chave-mes"\nsession: "[[02-Sessões/2026/06-JUN/DIA 12/01-26-x]]"\n---\n# BUG-0001\n');
    writeFileSync(join(mes, 'BUG-0002-z.md'), '---\ntype: bug\ncontent_key: "outra-sessao"\n---\n# BUG-0002 sem link\n');
    const keys = existingKeysForSession(vault, sessionRel, '2026-06-12');
    assert.deepEqual(keys.bugs, ['chave-mes'], 'nota do mês continua; nota sem link da sessão ignorada');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

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

// DRV-1 — issueRef entra no nome, sem duplicação quando a causa raiz já o contém
test('createLinkedNotes: bug with issueRef keeps the ref in the name, without duplicating it', async () => {
  const { createLinkedNotes } = await import('../hooks/linked-notes.mjs');
  const vault = vaultWith([]);
  try {
    const tx = {
      assistantMessages: [
        'Causa raiz: NUT-463 o endpoint de login retornava 500 quando o token expirava no meio do refresh.',
        'git commit -m "fix(auth): renova token antes do refresh"',
      ],
      userPrompts: ['NUT-463 login quebrado'],
    };
    const linked = createLinkedNotes(vault, '2026-07-16', SESSION_REL, tx, { issueRefs: ['NUT-463'] });
    assert.equal(linked.bugs.length, 1);
    const base = linked.bugs[0].split('/').pop();
    assert.match(base, /^BUG-0001-nut-463-/i, 'ref preservado no nome');
    assert.equal((base.toLowerCase().match(/nut-463/g) || []).length, 1, 'ref aparece UMA vez, sem duplicar');
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
