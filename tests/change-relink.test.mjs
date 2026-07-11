// 0.35.0 — archive/abandon movem a pasta da change e todo wikilink gravado antes (sessões
// fechadas, decisões, outras changes) morria (visto em produção: links cinza no grafo).
// Agora o move reescreve os wikilinks vault-wide, e `wendkeep change relink` cura
// retroativamente os links já mortos de vaults antigos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { relinkChanges } from '../hooks/change-core.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');
const run = (vault, args) => spawnSync(process.execPath, [BIN, ...args, '--vault', vault], { encoding: 'utf8' });

function vaultWithSessionLink(slug) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-relink-'));
  mkdirSync(join(vault, '04-Decisões'), { recursive: true });
  assert.equal(run(vault, ['change', 'new', slug]).status, 0);
  const dir = join(vault, '08-Mudanças', slug);
  writeFileSync(join(dir, 'proposta.md'), `---\ntype: change\nstatus: active\nspec_impact: none\nspec_impact_reason: "teste"\nspecs: []\n---\n\n# ${slug}\n\n## Por quê\n\nreal\n\n## O que muda\n\nreal\n`);
  writeFileSync(join(dir, 'design.md'), `# ${slug} — design\n\nreal\n`);
  writeFileSync(join(dir, 'tarefas.md'), '- [x] 1.1 feito\n');
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ slug, ok: true, coverage: [] }));
  // sessão FECHADA que linkou a change (full-path e com alias)
  const sessDir = join(vault, '02-Sessões', '2026', '07-JUL', 'DIA 11');
  mkdirSync(sessDir, { recursive: true });
  const sess = join(sessDir, '10-00-s.md');
  writeFileSync(sess, [
    '## Mudanças',
    '',
    `- [[08-Mudanças/${slug}/proposta]]`,
    `- Ver [[08-Mudanças/${slug}/proposta|${slug}]] e [[08-Mudanças/${slug}/design]].`,
    '',
  ].join('\n'));
  return { vault, sess };
}

test('archive reescreve os wikilinks da change no vault inteiro (alias preservado)', () => {
  const { vault, sess } = vaultWithSessionLink('x');
  try {
    const r = run(vault, ['change', 'archive', 'x']);
    assert.equal(r.status, 0, r.stderr);
    const arch = readdirSync(join(vault, '08-Mudanças', '_arquivo')).find((d) => d.endsWith('-x'));
    const s = readFileSync(sess, 'utf8');
    assert.match(s, new RegExp(`\\[\\[08-Mudanças/_arquivo/${arch}/proposta\\]\\]`), 'full-path reescrito');
    assert.match(s, new RegExp(`\\[\\[08-Mudanças/_arquivo/${arch}/proposta\\|x\\]\\]`), 'alias preservado');
    assert.match(s, new RegExp(`\\[\\[08-Mudanças/_arquivo/${arch}/design\\]\\]`), 'outros arquivos da change também');
    assert.doesNotMatch(s, /\[\[08-Mudanças\/x\//, 'nenhum link antigo sobra');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('abandon também reescreve os wikilinks', () => {
  const { vault, sess } = vaultWithSessionLink('y');
  try {
    assert.equal(run(vault, ['change', 'abandon', 'y']).status, 0);
    const arch = readdirSync(join(vault, '08-Mudanças', '_arquivo')).find((d) => d.endsWith('-y-abandonada'));
    assert.match(readFileSync(sess, 'utf8'), new RegExp(`\\[\\[08-Mudanças/_arquivo/${arch}/proposta\\]\\]`));
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('relinkChanges retroativo: cura link morto; dry-run não grava; ambíguo pulado; vivo intocado', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-relret-'));
  try {
    // estado legado: change arquivada SEM reescrita (pré-0.35) + link morto numa sessão
    mkdirSync(join(vault, '08-Mudanças', '_arquivo', '2026-07-10-old', 'planos'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', '_arquivo', '2026-07-10-old', 'proposta.md'), '---\nstatus: archived\n---\n# old\n');
    // change VIVA com link válido (não pode ser tocada)
    mkdirSync(join(vault, '08-Mudanças', 'viva'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'viva', 'proposta.md'), '---\nstatus: active\n---\n# viva\n');
    // slug ambíguo: dois archives -dup
    mkdirSync(join(vault, '08-Mudanças', '_arquivo', '2026-07-09-dup'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', '_arquivo', '2026-07-10-dup'), { recursive: true });
    const sessDir = join(vault, '02-Sessões', '2026', '07-JUL', 'DIA 10');
    mkdirSync(sessDir, { recursive: true });
    const sess = join(sessDir, '09-00-s.md');
    writeFileSync(sess, [
      '- [[08-Mudanças/old/proposta]]',
      '- [[08-Mudanças/old/planos/abc123|plano]]',
      '- [[08-Mudanças/viva/proposta]]',
      '- [[08-Mudanças/dup/proposta]]',
      '- [[08-Mudanças/_arquivo/2026-07-10-old/design]]',
    ].join('\n'));

    // dry-run: reporta sem gravar
    const dry = relinkChanges(vault, { apply: false });
    assert.equal(dry.applied, false);
    assert.ok(dry.rewritten.some((r) => r.from === '08-Mudanças/old' && r.to === '08-Mudanças/_arquivo/2026-07-10-old'));
    assert.ok(dry.ambiguous.some((a) => a.includes('dup')), 'ambíguo reportado');
    assert.match(readFileSync(sess, 'utf8'), /\[\[08-Mudanças\/old\/proposta\]\]/, 'dry-run não gravou');

    // apply
    const rep = relinkChanges(vault, { apply: true });
    assert.ok(rep.filesTouched >= 1);
    const s = readFileSync(sess, 'utf8');
    assert.match(s, /\[\[08-Mudanças\/_arquivo\/2026-07-10-old\/proposta\]\]/, 'link morto curado');
    assert.match(s, /\[\[08-Mudanças\/_arquivo\/2026-07-10-old\/planos\/abc123\|plano\]\]/, 'subpath + alias curados');
    assert.match(s, /\[\[08-Mudanças\/viva\/proposta\]\]/, 'change viva intocada');
    assert.match(s, /\[\[08-Mudanças\/dup\/proposta\]\]/, 'ambíguo pulado');
    assert.match(s, /\[\[08-Mudanças\/_arquivo\/2026-07-10-old\/design\]\]/, 'link já-arquivado intocado');
    // idempotente
    const again = relinkChanges(vault, { apply: true });
    assert.equal(again.filesTouched, 0, 'segunda passada é no-op');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('change relink CLI: dry-run default + --apply', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-relcli-'));
  try {
    mkdirSync(join(vault, '08-Mudanças', '_arquivo', '2026-07-10-z'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', '_arquivo', '2026-07-10-z', 'proposta.md'), '# z\n');
    mkdirSync(join(vault, '02-Sessões'), { recursive: true });
    const sess = join(vault, '02-Sessões', 's.md');
    writeFileSync(sess, '[[08-Mudanças/z/proposta]]\n');
    const dry = run(vault, ['change', 'relink']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /dry-run|preview/i);
    assert.match(readFileSync(sess, 'utf8'), /\[\[08-Mudanças\/z\/proposta\]\]/, 'não gravou');
    const ap = run(vault, ['change', 'relink', '--apply']);
    assert.equal(ap.status, 0, ap.stderr);
    assert.match(readFileSync(sess, 'utf8'), /\[\[08-Mudanças\/_arquivo\/2026-07-10-z\/proposta\]\]/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
