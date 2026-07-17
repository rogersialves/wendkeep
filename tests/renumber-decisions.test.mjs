// 0.30.0 — retroactive ADR renumbering. Every note in 04-Decisões becomes ADR-<NNNN>-<slug> in
// chronological order; files are renamed in place and every wikilink to them is rewritten across
// the vault. Covers the three historical naming eras (ADR-NNN, dated escolha, hand-written).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  slugFromDecisionName, decisionSortKey, normalizeDecisionContent,
  planRenumber, renumberDecisions,
} from '../hooks/renumber-decisions.mjs';
import { getNextAdrNumber } from '../hooks/obsidian-common.mjs';

function note(date, { type = 'decision', adr = '', h1 = 'Título' } = {}) {
  return `---
type: ${type}
date: ${date}${adr ? `\nadr: ${adr}` : ''}
tags:
  - decisao
---

# ${h1}

corpo
`;
}

// Build a vault with the three naming eras deliberately OUT of chronological order.
function seedVault() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-renum-'));
  const dec = join(vault, '04-Decisões');
  const mk = (rel, content) => { const abs = join(dec, rel); mkdirSync(join(abs, '..'), { recursive: true }); writeFileSync(abs, content); return abs; };
  mk(join('2026', '03-MAR', 'DIA 29', 'ADR-001-a.md'), note('2026-03-29', { type: 'decisao', h1: 'Alfa' }));
  mk(join('2026', '05-MAI', 'DIA 18', 'ADR-002-b.md'), note('2026-05-18', { type: 'decision', h1: 'Beta' }));
  mk(join('2026', '06-JUN', 'DIA 10', '2026-06-10-escolha-c.md'), note('2026-06-10', { type: 'decision', h1: 'Gama' }));
  mk(join('2026', '04-ABR', 'DIA 05', '2026-04-05-d.md'), note('2026-04-05', { type: 'decisão', h1: 'Delta' }));
  return vault;
}

test('slugFromDecisionName strips every era prefix', () => {
  assert.equal(slugFromDecisionName('ADR-012-precos-canonicos.md'), 'precos-canonicos');
  assert.equal(slugFromDecisionName('2026-06-10-escolha-qual-abordagem.md'), 'qual-abordagem');
  assert.equal(slugFromDecisionName('2026-05-31-kinetic-noir.md'), 'kinetic-noir');
  assert.equal(slugFromDecisionName('security-upgrade-nut-463.md'), 'security-upgrade-nut-463');
});

test('decisionSortKey orders by date, then time, then existing ADR number', () => {
  const a = decisionSortKey({ abs: '/x/ADR-001-a.md', base: 'ADR-001-a.md', content: 'date: 2026-03-29\n' });
  const b = decisionSortKey({ abs: '/x/ADR-002-b.md', base: 'ADR-002-b.md', content: 'date: 2026-05-18\n' });
  assert.ok(a < b, 'earlier date sorts first');
  const t1 = decisionSortKey({ abs: '/x/e.md', base: 'e.md', content: 'date: 2026-05-18\nstarted_at: 2026-05-18T09:00:00\n' });
  const t2 = decisionSortKey({ abs: '/x/f.md', base: 'f.md', content: 'date: 2026-05-18\nstarted_at: 2026-05-18T14:00:00\n' });
  assert.ok(t1 < t2, 'earlier time sorts first within a day');
});

test('normalizeDecisionContent sets type/adr/H1 canonically', () => {
  const out = normalizeDecisionContent(note('2026-03-29', { type: 'decisao', h1: 'Alfa' }), 7);
  assert.match(out, /^type: decision$/m);
  assert.match(out, /^adr: 7$/m);
  assert.match(out, /^# ADR-0007 — Alfa$/m);
  // idempotent: an already-labelled H1 doesn't double-prefix
  const twice = normalizeDecisionContent(out, 7);
  assert.match(twice, /^# ADR-0007 — Alfa$/m);
  assert.doesNotMatch(twice, /ADR-0007 — ADR-0007/);
});

test('planRenumber assigns sequential ADR numbers in strict chronological order', () => {
  const vault = seedVault();
  try {
    const plan = planRenumber(vault);
    assert.equal(plan.length, 4);
    // chronological: a(03-29) d(04-05) b(05-18) c(06-10)
    assert.match(plan[0].newRelNoExt, /ADR-0001-a$/);
    assert.match(plan[1].newRelNoExt, /ADR-0002-d$/);
    assert.match(plan[2].newRelNoExt, /ADR-0003-b$/);
    assert.match(plan[3].newRelNoExt, /ADR-0004-c$/);
    // DRV-7 — destino é a pasta do MÊS da data, sem subpasta DIA
    assert.match(plan[1].newRelNoExt, /^04-Decisões\/2026\/04-ABR\/ADR-0002-d$/);
    for (const p of plan) assert.doesNotMatch(p.newRelNoExt, /\/DIA /, 'nenhum destino com DIA');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// DRV-7 fallback — sem data resolvível (nem frontmatter, nem nome, nem pasta DIA), a nota
// preserva o dirname atual: nunca é movida às cegas nem perdida.
test('renumberDecisions: note with no resolvable date stays in its current folder', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-renum-nd-'));
  try {
    const dec = join(vault, '04-Decisões');
    mkdirSync(dec, { recursive: true });
    // sem `date:` no frontmatter, sem prefixo YYYY-MM-DD no nome, na raiz (sem pasta de mês/DIA)
    writeFileSync(join(dec, 'ADR-003-sem-data.md'), '---\ntype: decision\ntags:\n  - decisao\n---\n\n# Sem data\n\ncorpo\n');
    const plan = planRenumber(vault);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].newRelNoExt, '04-Decisões/ADR-0001-sem-data', 'renomeia mas fica na raiz');
    renumberDecisions(vault, { apply: true });
    assert.ok(existsSync(join(dec, 'ADR-0001-sem-data.md')), 'permanece no dirname original');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('renumberDecisions apply renames files, rewrites wikilinks vault-wide, is idempotent', () => {
  const vault = seedVault();
  try {
    // a session that links to decisions by full path, by basename, and with an ADR alias
    const sessDir = join(vault, '02-Sessões', '2026', '06-JUN', 'DIA 20');
    mkdirSync(sessDir, { recursive: true });
    const sess = join(sessDir, '10-00-s.md');
    writeFileSync(sess, [
      'Ver [[04-Decisões/2026/05-MAI/DIA 18/ADR-002-b]] e',
      '[[2026-06-10-escolha-c]] mais',
      '[[04-Decisões/2026/03-MAR/DIA 29/ADR-001-a|ADR-001]] fim',
    ].join('\n'));

    const dry = renumberDecisions(vault, { apply: false });
    assert.equal(dry.renamed, 4, 'all four change name (3-digit->4-digit or era rename)');
    assert.ok(existsSync(join(vault, '04-Decisões', '2026', '06-JUN', 'DIA 10', '2026-06-10-escolha-c.md')), 'dry-run wrote nothing');

    const rep = renumberDecisions(vault, { apply: true });
    assert.equal(rep.renamed, 4);
    // DRV-7 — arquivos movidos pra pasta do mês (sem DIA), DIA de origem removido
    assert.ok(existsSync(join(vault, '04-Decisões', '2026', '04-ABR', 'ADR-0002-d.md')));
    assert.ok(existsSync(join(vault, '04-Decisões', '2026', '06-JUN', 'ADR-0004-c.md')));
    assert.ok(!existsSync(join(vault, '04-Decisões', '2026', '06-JUN', 'DIA 10', '2026-06-10-escolha-c.md')), 'old name gone');
    assert.ok(!existsSync(join(vault, '04-Decisões', '2026', '06-JUN', 'DIA 10')), 'DIA de origem vazio removido');
    assert.ok(!existsSync(join(vault, '04-Decisões', '2026', '04-ABR', 'DIA 05')), 'DIA 05 removido');
    // no stray temp files
    const leftovers = [];
    (function walk(d) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.includes('.wk-renum-')) leftovers.push(p); } })(join(vault, '04-Decisões'));
    assert.equal(leftovers.length, 0, 'temp files cleaned');

    // wikilinks rewritten pro NOVO caminho de mês (full path, basename, and alias)
    const s = readFileSync(sess, 'utf8');
    assert.match(s, /\[\[04-Decisões\/2026\/05-MAI\/ADR-0003-b\]\]/);
    assert.match(s, /\[\[ADR-0004-c\]\]/);
    assert.match(s, /\[\[04-Decisões\/2026\/03-MAR\/ADR-0001-a\|ADR-0001\]\]/);

    // body normalized
    const dNote = readFileSync(join(vault, '04-Decisões', '2026', '04-ABR', 'ADR-0002-d.md'), 'utf8');
    assert.match(dNote, /^type: decision$/m);
    assert.match(dNote, /^adr: 2$/m);
    assert.match(dNote, /^# ADR-0002 — Delta$/m);

    // getNextAdrNumber now continues after the max
    assert.equal(getNextAdrNumber(vault), 5);

    // idempotent: a second apply renames nothing and leaves links intact
    const again = renumberDecisions(vault, { apply: true });
    assert.equal(again.renamed, 0, 'already canonical -> no renames');
    assert.equal(readFileSync(sess, 'utf8'), s, 'links unchanged on re-run');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
