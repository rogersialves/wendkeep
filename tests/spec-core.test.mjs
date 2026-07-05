import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRequirements, parseDelta, applyDelta, renderSpec, parseSpecsList, promoteSpecs } from '../hooks/spec-core.mjs';

test('parseRequirements: ordered blocks, drops trailing footer', () => {
  const md = '# cap\n\n## Requisitos\n\n### Requisito: A\ncorpo A\n\n### Requisito: B\ncorpo B\n\n> Atualizado por [[x]] em 2026-07-05.\n';
  const r = parseRequirements(md);
  assert.deepEqual(r.map((x) => x.name), ['A', 'B']);
  assert.equal(r[0].body, 'corpo A');
  assert.equal(r[1].body, 'corpo B');
});

test('parseDelta: three sections', () => {
  const md = '## ADDED Requirements\n### Requisito: New\nx\n\n## MODIFIED Requirements\n### Requisito: Old\ny\n\n## REMOVED Requirements\n### Requisito: Gone\n';
  const d = parseDelta(md);
  assert.deepEqual(d.added.map((r) => r.name), ['New']);
  assert.deepEqual(d.modified.map((r) => r.name), ['Old']);
  assert.deepEqual(d.removed, ['Gone']);
});

test('applyDelta: upsert added/modified, delete removed, warns on inconsistency', () => {
  const base = [{ name: 'A', body: 'a' }, { name: 'B', body: 'b' }];
  const { reqs, warnings } = applyDelta(base, { added: [{ name: 'C', body: 'c' }], modified: [{ name: 'A', body: 'a2' }], removed: ['B'] });
  assert.deepEqual(reqs.map((r) => r.name), ['A', 'C']);
  assert.equal(reqs.find((r) => r.name === 'A').body, 'a2');
  assert.equal(warnings.length, 0);
  const w = applyDelta(base, { added: [{ name: 'A', body: 'dup' }], modified: [], removed: ['Z'] });
  assert.ok(w.warnings.some((x) => /A/.test(x)));
  assert.ok(w.warnings.some((x) => /Z/.test(x)));
});

test('renderSpec round-trips through parseRequirements', () => {
  const reqs = [{ name: 'A', body: 'corpo a' }, { name: 'B', body: 'corpo b' }];
  const md = renderSpec('minha-cap', reqs, { footer: 'nota' });
  assert.match(md, /type: spec/);
  assert.match(md, /# minha-cap/);
  assert.match(md, /> nota/);
  assert.deepEqual(parseRequirements(md).map((r) => r.name), ['A', 'B']);
});

test('parseSpecsList: inline and block YAML', () => {
  assert.deepEqual(parseSpecsList('---\nspecs: [auth, billing]\n---\n'), ['auth', 'billing']);
  assert.deepEqual(parseSpecsList('---\nspecs:\n  - auth\n  - "billing"\n---\n'), ['auth', 'billing']);
  assert.deepEqual(parseSpecsList('---\nspecs: []\n---\n'), []);
});

test('promoteSpecs: applies delta to a fresh living spec, then modifies in place', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-promo-'));
  try {
    const changeDir = join(vault, '08-Mudanças', 'x');
    mkdirSync(join(changeDir, 'specs', 'auth'), { recursive: true });
    writeFileSync(join(changeDir, 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requisito: Login\nusuário faz login\n');
    const r = promoteSpecs(vault, changeDir, ['auth'], { changeWikilink: '[[arq/proposta]]', dateStr: '2026-07-05' });
    assert.deepEqual(r.promoted, ['auth']);
    const live = readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8');
    assert.match(live, /### Requisito: Login/);
    assert.match(live, /\[\[arq\/proposta\]\]/);
    writeFileSync(join(changeDir, 'specs', 'auth', 'spec.md'), '## MODIFIED Requirements\n### Requisito: Login\nlogin com 2FA\n');
    promoteSpecs(vault, changeDir, ['auth'], { changeWikilink: '[[arq2/proposta]]', dateStr: '2026-07-06' });
    assert.match(readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8'), /login com 2FA/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
