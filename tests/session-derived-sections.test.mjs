// DRV-10 / DRV-11: as seções derivadas do corpo refletem a sessão inteira — não só os
// itens capturados no turno. Bug de produção: o Encerramento listava 15 ADRs e 5 APRs
// enquanto o corpo mostrava 3 decisões e "Nenhum aprendizado registrado ainda.".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeSessionFile } from '../hooks/session-stop.mjs';
import { repairDerivedSections } from '../hooks/derived-sections.mjs';
import { checkStaleDerivedSections, renderStaleDerivedSectionLines } from '../hooks/harness-doctor.mjs';

const TX = { rawTextForDetection: '', latestAssistantMessage: 'fim', userPrompts: [], tools: [] };

// Forma real da nota, com os placeholders que o session-start escreve.
const NOTE = `---
type: session
date: 2026-07-25
ended_at:
status: active
---

# 20-26 - sessão

## Iterações

### 20:26 - início

texto

## Decisões geradas nesta sessão

Nenhuma decisão registrada ainda.

## Bugs gerados nesta sessão

Nenhum bug registrado ainda.

## Aprendizados gerados nesta sessão

Nenhum aprendizado registrado ainda.

## Pendências

Nenhuma.
`;

const sectionOf = (content, heading) => {
  const i = content.indexOf(`## ${heading}`);
  if (i < 0) return '';
  const j = content.indexOf('\n## ', i + 3);
  return content.slice(i, j < 0 ? content.length : j);
};
const linksIn = (content, heading) => (sectionOf(content, heading).match(/\[\[[^\]]+\]\]/g) || []);

// --- DRV-10: o fecho escreve as seções -------------------------------------

test('finalize escreve as três seções com o mesmo created do Encerramento', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-derived-'));
  try {
    const note = join(dir, 'note.md');
    writeFileSync(note, NOTE);
    const created = {
      decisions: ['04-Decisões/2026/07-JUL/ADR-0003-a.md', '04-Decisões/2026/07-JUL/ADR-0005-b.md'],
      bugs: ['05-Bugs/2026/07-JUL/BUG-0001-c.md'],
      learnings: ['06-Aprendizados/2026/07-JUL/APR-0001-d.md', '06-Aprendizados/2026/07-JUL/APR-0002-e.md'],
    };

    finalizeSessionFile(note, TX, created, '2026-07-25T10:00:00');
    const out = readFileSync(note, 'utf8');

    assert.equal(linksIn(out, 'Decisões geradas nesta sessão').length, 2);
    assert.equal(linksIn(out, 'Bugs gerados nesta sessão').length, 1);
    assert.equal(linksIn(out, 'Aprendizados gerados nesta sessão').length, 2);
    assert.doesNotMatch(sectionOf(out, 'Aprendizados gerados nesta sessão'), /Nenhum aprendizado/,
      'placeholder sai quando há itens');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finalize: o corpo lista o mesmo conjunto que o Encerramento', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-derived-'));
  try {
    const note = join(dir, 'note.md');
    writeFileSync(note, NOTE);
    const created = {
      decisions: ['04-Decisões/2026/07-JUL/ADR-0003-a.md'],
      bugs: [],
      learnings: ['06-Aprendizados/2026/07-JUL/APR-0001-d.md'],
    };

    finalizeSessionFile(note, TX, created, '2026-07-25T10:00:00');
    const out = readFileSync(note, 'utf8');

    const enc = sectionOf(out, 'Encerramento');
    for (const rel of [...created.decisions, ...created.learnings]) {
      const slug = rel.replace(/\.md$/, '');
      assert.ok(enc.includes(slug), `${slug} no Encerramento`);
      assert.ok(out.slice(0, out.indexOf('## Encerramento')).includes(slug), `${slug} no corpo`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finalize preserva o placeholder quando a sessão não gerou nada daquele tipo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-derived-'));
  try {
    const note = join(dir, 'note.md');
    writeFileSync(note, NOTE);

    finalizeSessionFile(note, TX, { decisions: [], bugs: [], learnings: [] }, '2026-07-25T10:00:00');
    const out = readFileSync(note, 'utf8');

    assert.match(sectionOf(out, 'Bugs gerados nesta sessão'), /Nenhum bug registrado ainda\./,
      'seção vazia é informação, não defeito');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finalize é idempotente: segunda passada não duplica nem reescreve', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-derived-'));
  try {
    const note = join(dir, 'note.md');
    writeFileSync(note, NOTE);
    const created = { decisions: ['04-Decisões/2026/07-JUL/ADR-0003-a.md'], bugs: [], learnings: [] };

    // A 1a passada também normaliza o texto de Pendências (comportamento pré-existente do
    // replacePendingSection); a idempotência que importa é do estado já finalizado em diante.
    finalizeSessionFile(note, TX, created, '2026-07-25T10:00:00');
    finalizeSessionFile(note, TX, created, '2026-07-25T10:00:00');
    const settled = readFileSync(note, 'utf8');
    const mtime = statSync(note).mtimeMs;

    finalizeSessionFile(note, TX, created, '2026-07-25T10:00:00');

    assert.equal(readFileSync(note, 'utf8'), settled, 'byte-idêntico');
    assert.equal(statSync(note).mtimeMs, mtime, 'nem reescreve');
    assert.equal(linksIn(settled, 'Decisões geradas nesta sessão').length, 1, 'sem duplicata');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- DRV-11: reparo retroativo ---------------------------------------------

const SESSION_REL = '02-Sessões/2026/07-JUL/DIA 25/10-00-sessao.md';

function vaultWithDerived({ decisions = 0, bugs = 0, learnings = 0, body = NOTE } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-repair-sec-'));
  const notePath = join(vault, ...SESSION_REL.split('/'));
  mkdirSync(join(notePath, '..'), { recursive: true });
  writeFileSync(notePath, body);

  const link = `[[${SESSION_REL.replace(/\.md$/, '')}]]`;
  const make = (folder, prefix, n) => {
    if (!n) return;
    const dir = join(vault, folder, '2026', '07-JUL');
    mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= n; i += 1) {
      const num = String(i).padStart(4, '0');
      writeFileSync(join(dir, `${prefix}-${num}-x.md`),
        `---\ntype: derived\nsource:\n  - "${link}"\n---\n\n# ${prefix}-${num}\n`);
    }
  };
  make('04-Decisões', 'ADR', decisions);
  make('05-Bugs', 'BUG', bugs);
  make('06-Aprendizados', 'APR', learnings);
  return { vault, notePath };
}

test('repair-sections reconstrói as seções de uma nota já fechada', () => {
  const { vault, notePath } = vaultWithDerived({ decisions: 15, learnings: 5 });
  try {
    const r = repairDerivedSections(vault, { apply: true });

    assert.equal(r.applied, true);
    assert.equal(r.repaired.length, 1);
    const out = readFileSync(notePath, 'utf8');
    assert.equal(linksIn(out, 'Decisões geradas nesta sessão').length, 15);
    assert.equal(linksIn(out, 'Aprendizados gerados nesta sessão').length, 5);
    assert.doesNotMatch(sectionOf(out, 'Aprendizados gerados nesta sessão'), /Nenhum aprendizado/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('repair-sections: dry-run relata sem tocar no arquivo', () => {
  const { vault, notePath } = vaultWithDerived({ decisions: 3 });
  try {
    const before = readFileSync(notePath, 'utf8');

    const r = repairDerivedSections(vault);

    assert.equal(r.applied, false);
    assert.equal(r.repaired.length, 1);
    assert.equal(readFileSync(notePath, 'utf8'), before, 'byte-idêntico');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('repair-sections é idempotente', () => {
  const { vault, notePath } = vaultWithDerived({ decisions: 3, bugs: 1 });
  try {
    repairDerivedSections(vault, { apply: true });
    const after = readFileSync(notePath, 'utf8');
    const mtime = statSync(notePath).mtimeMs;

    const second = repairDerivedSections(vault, { apply: true });

    assert.equal(second.repaired.length, 0, 'nada a reparar na segunda passada');
    assert.equal(readFileSync(notePath, 'utf8'), after);
    assert.equal(statSync(notePath).mtimeMs, mtime);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('repair-sections: nota já correta não entra no relatório', () => {
  const { vault } = vaultWithDerived({ decisions: 0, bugs: 0, learnings: 0 });
  try {
    assert.deepEqual(repairDerivedSections(vault, { apply: true }).repaired, []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('repair-sections: nota travada por outro processo é pulada, não corrompida', () => {
  const { vault, notePath } = vaultWithDerived({ decisions: 3 });
  try {
    const before = readFileSync(notePath, 'utf8');
    mkdirSync(`${notePath}.lock`);

    const r = repairDerivedSections(vault, { apply: true, lockTimeoutMs: 40 });

    assert.equal(r.repaired.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.equal(readFileSync(notePath, 'utf8'), before);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

// --- Furos encontrados pela verificação adversarial -------------------------

// `findLinkedDerivedNotes` casa substring no arquivo inteiro, então uma derivada que cita
// outra sessão em `related:` é atribuída às duas. Caso real no vault deste repo: BUG-0001
// declara `session:` de uma sessão e `source:`/`related:` de outra. No Encerramento o erro
// é regenerado a cada reopen; escrito no corpo, ele fica.
test('atribuição usa a proveniência declarada, não toda sessão citada', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-prov-'));
  try {
    const outraRel = '02-Sessões/2026/07-JUL/DIA 16/09-54-outra.md';
    for (const rel of [SESSION_REL, outraRel]) {
      const p = join(vault, ...rel.split('/'));
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, NOTE);
    }
    const dir = join(vault, '04-Decisões', '2026', '07-JUL');
    mkdirSync(dir, { recursive: true });
    // source: aponta para SESSION_REL; related: e prosa citam a outra sessão.
    writeFileSync(join(dir, 'ADR-0001-x.md'), [
      '---', 'type: decision',
      `session: "[[${outraRel.replace(/\.md$/, '')}]]"`,
      'source:', `  - "[[${SESSION_REL.replace(/\.md$/, '')}]]"`,
      'related:', `  - "[[${outraRel.replace(/\.md$/, '')}]]"`,
      '---', '', `# ADR-0001`, '', `Ver também [[${outraRel.replace(/\.md$/, '')}]].`, '',
    ].join('\n'));

    repairDerivedSections(vault, { apply: true });

    const alvo = readFileSync(join(vault, ...SESSION_REL.split('/')), 'utf8');
    const outra = readFileSync(join(vault, ...outraRel.split('/')), 'utf8');
    assert.equal(linksIn(alvo, 'Decisões geradas nesta sessão').length, 1, 'entra na sessão do source:');
    assert.equal(linksIn(outra, 'Decisões geradas nesta sessão').length, 0, 'NÃO entra na sessão só citada');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

// O placeholder sem bullet cai no filtro de lista; a variante COM bullet passaria e viveria
// para sempre junto dos links reais.
test('placeholder com bullet é descartado, não perpetuado', () => {
  const comBullet = NOTE.replace(
    'Nenhuma decisão registrada ainda.',
    '- Nenhuma decisão registrada ainda.',
  );
  const { vault, notePath } = vaultWithDerived({ decisions: 2, body: comBullet });
  try {
    repairDerivedSections(vault, { apply: true });
    const sec = sectionOf(readFileSync(notePath, 'utf8'), 'Decisões geradas nesta sessão');
    assert.doesNotMatch(sec, /Nenhuma decisão registrada/, 'placeholder com bullet sai');
    assert.equal((sec.match(/\[\[/g) || []).length, 2);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

// Reescrever a seção não pode apagar comentário que o dono do vault escreveu ali.
test('prosa escrita na seção sobrevive ao reparo', () => {
  const comProsa = NOTE.replace(
    'Nenhuma decisão registrada ainda.',
    'Contexto: as duas primeiras decisões foram revertidas.',
  );
  const { vault, notePath } = vaultWithDerived({ decisions: 2, body: comProsa });
  try {
    repairDerivedSections(vault, { apply: true });
    const sec = sectionOf(readFileSync(notePath, 'utf8'), 'Decisões geradas nesta sessão');
    assert.match(sec, /Contexto: as duas primeiras decisões foram revertidas\./, 'prosa preservada');
    assert.equal((sec.match(/\[\[/g) || []).length, 2, 'e os links entram');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

// upsert é no-op quando o heading falta: nota importada sem as seções não é remendada
// com headings inventados.
test('nota sem as seções não é alterada', () => {
  const semSecoes = '---\ntype: session\n---\n\n# x\n\n## Iterações\n\ntexto\n';
  const { vault, notePath } = vaultWithDerived({ decisions: 3, body: semSecoes });
  try {
    repairDerivedSections(vault, { apply: true });
    assert.equal(readFileSync(notePath, 'utf8'), semSecoes, 'byte-idêntico');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

// --- DIAG-6: detecção no doctor --------------------------------------------

test('checkStaleDerivedSections conta o que falta na seção', () => {
  const { vault } = vaultWithDerived({ decisions: 15, learnings: 5 });
  try {
    const r = checkStaleDerivedSections(vault);
    assert.equal(r.notes.length, 1);
    assert.equal(r.notes[0].missing, 20, '15 decisões + 5 aprendizados faltando');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('checkStaleDerivedSections: nota em dia não é reportada', () => {
  const { vault } = vaultWithDerived({ decisions: 0 });
  try {
    assert.deepEqual(checkStaleDerivedSections(vault).notes, []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

// Link a mais pode ser curadoria manual do dono do vault — não é sintoma deste bug.
test('checkStaleDerivedSections: excedente na seção não é sintoma', () => {
  const extra = NOTE.replace(
    'Nenhuma decisão registrada ainda.',
    '- [[04-Decisões/2026/07-JUL/ADR-9999-posta-a-mao]]',
  );
  const { vault } = vaultWithDerived({ decisions: 0, body: extra });
  try {
    assert.deepEqual(checkStaleDerivedSections(vault).notes, []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('doctor nomeia as notas afetadas e aponta o comando de reparo', () => {
  const { vault } = vaultWithDerived({ decisions: 15, learnings: 5 });
  try {
    const lines = renderStaleDerivedSectionLines(checkStaleDerivedSections(vault));
    assert.match(lines[0], /^\[derivadas\] 1 sessão\(ões\) com seções desatualizadas/);
    assert.ok(lines.some((l) => l.includes('10-00-sessao.md')), 'nomeia a nota');
    assert.ok(lines.some((l) => l.includes('note repair-sections --apply')), 'aponta o conserto');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('doctor diz que as seções estão em dia quando não há afetadas', () => {
  const { vault } = vaultWithDerived({ decisions: 0 });
  try {
    const lines = renderStaleDerivedSectionLines(checkStaleDerivedSections(vault));
    assert.equal(lines.length, 2);
    assert.match(lines[1], /em dia/);
    assert.ok(!lines.some((l) => l.includes('repair-sections')), 'vault são não sugere reparo');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
