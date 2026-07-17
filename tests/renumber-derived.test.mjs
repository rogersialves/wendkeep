// DRV-4 — renumber-bugs/renumber-learnings: cronológico, move DIA/raiz → mês, links, idempotente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planRenumberDerived, renumberDerived, DERIVED_KINDS } from '../hooks/renumber-derived.mjs';

function seedVault() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-rnd-'));
  const w = (rel, content) => {
    mkdirSync(join(vault, rel, '..'), { recursive: true });
    writeFileSync(join(vault, rel), content);
  };
  // 3 eras: raiz datada (mais antiga), DIA legado (meio), mês sem número (mais nova)
  w('05-Bugs/2026-03-01-bug-raiz-antiga.md', '---\ntype: bug\ndate: 2026-03-01\n---\n# Bug - raiz antiga\n');
  w('05-Bugs/2026/06-JUN/DIA 10/NUT-463-login-quebrado.md', '---\ntype: bug\ndate: 2026-06-10\n---\n# Bug - login quebrado\n');
  w('05-Bugs/2026/07-JUL/2026-07-16-bug-parser.md', '---\ntype: bug\ndate: 2026-07-16\n---\n# Bug - parser\n');
  // sessão com wikilinks pros três (full-path e basename)
  w('02-Sessões/2026/07-JUL/DIA 16/20-00-s.md', [
    '# Sessão',
    '- [[05-Bugs/2026-03-01-bug-raiz-antiga]]',
    '- [[05-Bugs/2026/06-JUN/DIA 10/NUT-463-login-quebrado|o bug do login]]',
    '- [[2026-07-16-bug-parser]]',
  ].join('\n'));
  return vault;
}

test('planRenumberDerived: chronological order, month-folder destination, no DIA, pure', () => {
  const vault = seedVault();
  try {
    const plan = planRenumberDerived(vault, 'bugs');
    assert.equal(plan.length, 3);
    assert.match(plan[0].newRelNoExt, /^05-Bugs\/2026\/03-MAR\/BUG-0001-raiz-antiga$/, 'raiz datada vai pro mês da data');
    assert.match(plan[1].newRelNoExt, /^05-Bugs\/2026\/06-JUN\/BUG-0002-nut-463-login-quebrado$|^05-Bugs\/2026\/06-JUN\/BUG-0002-.*login-quebrado$/, 'DIA legado sobe pro mês');
    assert.match(plan[2].newRelNoExt, /^05-Bugs\/2026\/07-JUL\/BUG-0003-parser$/, 'já-no-mês só renomeia');
    for (const r of plan) assert.doesNotMatch(r.newRelNoExt, /\/DIA /, 'nenhum destino com DIA');
    // puro: nada foi escrito
    assert.ok(existsSync(join(vault, '05-Bugs', '2026-03-01-bug-raiz-antiga.md')), 'preview não move');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('renumberDerived --apply: moves, normalizes, rewrites links, cleans empty DIA, idempotent', () => {
  const vault = seedVault();
  try {
    const report = renumberDerived(vault, 'bugs', { apply: true });
    assert.equal(report.renamed, 3);

    // arquivos no lugar novo
    const jul = join(vault, '05-Bugs', '2026', '07-JUL');
    assert.ok(existsSync(join(vault, '05-Bugs', '2026', '03-MAR', 'BUG-0001-raiz-antiga.md')));
    assert.ok(readdirSync(join(vault, '05-Bugs', '2026', '06-JUN')).some((f) => f.startsWith('BUG-0002-')));
    assert.ok(readdirSync(jul).some((f) => f.startsWith('BUG-0003-')));

    // normalize: type/bug:/H1
    const b1 = readFileSync(join(vault, '05-Bugs', '2026', '03-MAR', 'BUG-0001-raiz-antiga.md'), 'utf8');
    assert.match(b1, /^type: bug$/m);
    assert.match(b1, /^bug: 1$/m);
    assert.match(b1, /^# BUG-0001 — raiz antiga$/m);

    // DIA vazio removido; sem tmp órfão
    assert.ok(!existsSync(join(vault, '05-Bugs', '2026', '06-JUN', 'DIA 10')), 'DIA vazio limpo');
    const leftovers = readdirSync(join(vault, '05-Bugs')).filter((f) => f.includes('.wk-renum'));
    assert.equal(leftovers.length, 0);

    // wikilinks reescritos (full-path, com alias, e basename)
    const sess = readFileSync(join(vault, '02-Sessões', '2026', '07-JUL', 'DIA 16', '20-00-s.md'), 'utf8');
    assert.match(sess, /\[\[05-Bugs\/2026\/03-MAR\/BUG-0001-raiz-antiga\]\]/);
    assert.match(sess, /\[\[05-Bugs\/2026\/06-JUN\/BUG-0002-[^\]|]+\|o bug do login\]\]/, 'alias preservado');
    assert.match(sess, /\[\[BUG-0003-parser\]\]/, 'basename link atualizado');
    assert.doesNotMatch(sess, /2026-07-16-bug-parser/);

    // idempotente
    const again = renumberDerived(vault, 'bugs', { apply: true });
    assert.equal(again.renamed, 0, 'segundo apply é no-op');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// DRV-4 (CLI) — bin: preview default, --apply, --json, exit 2 sem vault
test('CLI renumber-bugs: preview default, --apply writes, --json, exit 2 without vault', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname } = await import('node:path');
  const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');
  const vault = seedVault();
  try {
    const preview = spawnSync(process.execPath, [BIN, 'renumber-bugs', '--vault', vault], { encoding: 'utf8' });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /3 bug\(s\)/);
    assert.match(preview.stdout, /preview/i, 'avisa que nada foi escrito');
    assert.ok(existsSync(join(vault, '05-Bugs', '2026-03-01-bug-raiz-antiga.md')), 'preview não move');

    const applied = spawnSync(process.execPath, [BIN, 'renumber-bugs', '--vault', vault, '--apply', '--json'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    const report = JSON.parse(applied.stdout);
    assert.equal(report.renamed, 3);
    assert.ok(existsSync(join(vault, '05-Bugs', '2026', '03-MAR', 'BUG-0001-raiz-antiga.md')));

    const noVault = spawnSync(process.execPath, [BIN, 'renumber-learnings'], { encoding: 'utf8', env: { ...process.env, OBSIDIAN_VAULT_PATH: '' }, cwd: tmpdir() });
    assert.equal(noVault.status, 2, 'exit 2 sem vault');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('renumberDerived: learnings kind uses APR- and apr: field', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-rnd-apr-'));
  try {
    const dir = join(vault, '06-Aprendizados', '2026', '07-JUL', 'DIA 16');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-16-metro-tunnel.md'), '---\ntype: learning\ndate: 2026-07-16\n---\n# Aprendizado - metro tunnel\n');
    const report = renumberDerived(vault, 'learnings', { apply: true });
    assert.equal(report.renamed, 1);
    const out = join(vault, '06-Aprendizados', '2026', '07-JUL', 'APR-0001-metro-tunnel.md');
    assert.ok(existsSync(out));
    const c = readFileSync(out, 'utf8');
    assert.match(c, /^apr: 1$/m);
    assert.match(c, /^# APR-0001 — metro tunnel$/m);
    assert.ok(DERIVED_KINDS.learnings.prefix === 'APR');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
