import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStackedFrontmatter, renderStackedFrontmatterLines } from '../hooks/harness-doctor.mjs';

const FM = '---\ntype: session\ndate: 2026-07-23\n---\n';

function vaultWith(notes) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-stacked-'));
  const dir = join(vault, '02-Sessões', '2026', '07-JUL', 'DIA 23');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(notes)) writeFileSync(join(dir, name), content);
  return vault;
}

test('checkStackedFrontmatter conta a nota com frontmatter empilhado', () => {
  const vault = vaultWith({
    'boa.md': `${FM}\n# ok\n\ntexto\n`,
    'quebrada.md': `${FM}\n${FM}\n# quebrada\n\ntexto\n`,
  });
  try {
    const r = checkStackedFrontmatter(vault);
    assert.equal(r.count, 1);
    assert.deepEqual(r.notes.map((p) => p.split(/[\\/]/).pop()), ['quebrada.md']);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('checkStackedFrontmatter conta os 3 prepends do caso real como uma nota só', () => {
  const vault = vaultWith({ 'real.md': `${FM}\n${FM}\n${FM}\n${FM}\n# real\n` });
  try {
    assert.equal(checkStackedFrontmatter(vault).count, 1, 'a unidade é a nota, não o bloco');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('checkStackedFrontmatter ignora `---` no corpo e nota sem frontmatter', () => {
  const vault = vaultWith({
    'regra.md': `${FM}\n# x\n\ntexto\n\n---\n\nmais texto\n`,
    'tabela.md': `${FM}\n# x\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`,
    'sem-fm.md': '# x\n\ntexto\n',
  });
  try {
    const r = checkStackedFrontmatter(vault);
    assert.equal(r.count, 0, 'regra horizontal e tabela não são frontmatter empilhado');
    assert.deepEqual(r.notes, []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('doctor imprime a contagem e o caminho relativo de cada nota afetada', () => {
  const vault = vaultWith({ 'quebrada.md': `${FM}\n${FM}\n# quebrada\n` });
  try {
    const lines = renderStackedFrontmatterLines(vault, checkStackedFrontmatter(vault));
    assert.equal(lines[0], '[notas] 1 sessão(ões) com frontmatter empilhado');
    assert.equal(lines.length, 2, 'contagem + uma linha por nota, sem o ✓');
    assert.match(lines[1], /^ {2}✗ 02-Sessões[\\/]2026[\\/]07-JUL[\\/]DIA 23[\\/]quebrada\.md$/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('doctor diz "frontmatter íntegro" quando não há nota empilhada', () => {
  const vault = vaultWith({ 'boa.md': `${FM}\n# ok\n` });
  try {
    const lines = renderStackedFrontmatterLines(vault, checkStackedFrontmatter(vault));
    assert.deepEqual(lines, ['[notas] 0 sessão(ões) com frontmatter empilhado', '  frontmatter íntegro ✓']);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('checkStackedFrontmatter em vault sem 02-Sessões devolve zero', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-stacked-vazio-'));
  try {
    assert.deepEqual(checkStackedFrontmatter(vault), { count: 0, notes: [] });
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
