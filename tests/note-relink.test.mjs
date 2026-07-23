// DRV-9 — note relink: backfill de proveniência das notas derivadas órfãs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relinkDerivedNotes } from '../hooks/linked-notes.mjs';

const SESS_A = '02-Sessões/2026/07-JUL/DIA 19/14-58-analise';
const SESS_B = '02-Sessões/2026/07-JUL/DIA 19/02-46-impl';
const withSrc = (n, sess) => `---\ntype: bug\ndate: 2026-07-19\nbug: ${n}\nsource:\n  - "[[${sess}]]"\nrelated:\n  - "[[${sess}]]"\ncssclasses:\n  - topic-bug\ntags:\n  - bug\n---\n\n# BUG-000${n}\n`;
const orphan = (n) => `---\ntype: bug\ndate: 2026-07-19\nbug: ${n}\ncssclasses:\n  - topic-bug\ntags:\n  - bug\n---\n\n# BUG-000${n}\n`;

function vaultWithNotes() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-relink-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  const bugDir = join(vault, '05-Bugs', '2026', '07-JUL');
  mkdirSync(bugDir, { recursive: true });
  writeFileSync(join(bugDir, 'BUG-0001-a.md'), orphan(1));
  writeFileSync(join(bugDir, 'BUG-0002-b.md'), orphan(2));
  // MINORITÁRIA primeiro na ordem de walk: discrimina "modal por contagem" de "primeiro-visto".
  writeFileSync(join(bugDir, 'BUG-0003-c.md'), withSrc(3, SESS_B)); // minority, aparece antes
  writeFileSync(join(bugDir, 'BUG-0004-d.md'), withSrc(4, SESS_A));
  writeFileSync(join(bugDir, 'BUG-0005-e.md'), withSrc(5, SESS_A)); // majority (modal)
  return { vault, bugDir };
}

test('relinkDerivedNotes: dry-run reports orphans, writes nothing', () => {
  const { vault, bugDir } = vaultWithNotes();
  try {
    const r = relinkDerivedNotes(vault, {});
    assert.equal(r.applied, false);
    assert.equal(r.linked.length, 2, 'BUG-0001 e 0002 seriam linkados');
    assert.ok(!readFileSync(join(bugDir, 'BUG-0001-a.md'), 'utf8').includes('source:'), 'dry-run não escreve');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('relinkDerivedNotes: apply injects the MODAL source into orphans (SESS_A over SESS_B)', () => {
  const { vault, bugDir } = vaultWithNotes();
  try {
    const r = relinkDerivedNotes(vault, { apply: true });
    assert.equal(r.applied, true);
    assert.equal(r.linked.length, 2);
    for (const f of ['BUG-0001-a.md', 'BUG-0002-b.md']) {
      const c = readFileSync(join(bugDir, f), 'utf8');
      assert.match(c, /^source:\n {2}- "\[\[02-Sessões\/2026\/07-JUL\/DIA 19\/14-58-analise\]\]"$/m, `${f} herda a modal SESS_A`);
      assert.match(c, /^related:\n {2}- "\[\[.*14-58-analise\]\]"$/m);
      assert.doesNotMatch(c, /02-46-impl/, 'nunca a minoritária');
      assert.ok(c.startsWith('---\n') && c.indexOf('\n---\n') > c.indexOf('source:'), 'source dentro do frontmatter');
    }
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('relinkDerivedNotes: idempotent and skips orphans with no source sibling', () => {
  const { vault, bugDir } = vaultWithNotes();
  try {
    relinkDerivedNotes(vault, { apply: true });
    const again = relinkDerivedNotes(vault, { apply: true });
    assert.equal(again.linked.length, 0, 'idempotente: nada a linkar na 2ª passada');
    // 2ª passada não anexa um 2º bloco source: no arquivo já linkado.
    const twice = readFileSync(join(bugDir, 'BUG-0001-a.md'), 'utf8');
    assert.equal((twice.match(/^source:/gm) || []).length, 1, 'exatamente um bloco source após 2 applies');

    const aprDir = join(vault, '06-Aprendizados', '2026', '07-JUL');
    mkdirSync(aprDir, { recursive: true });
    writeFileSync(join(aprDir, 'APR-0001-x.md'), '---\ntype: learning\ndate: 2026-07-19\napr: 1\ncssclasses:\n  - topic-learning\n---\n\n# APR-0001\n');
    const r = relinkDerivedNotes(vault, { apply: true });
    assert.equal(r.linked.length, 0, 'sem irmão-fonte não linka');
    assert.ok(r.skipped.some((s) => s.file.includes('APR-0001')), 'reporta o pulado');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
