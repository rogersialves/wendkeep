import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeStackedFrontmatter, repairStackedFrontmatter, splitStackedFrontmatter } from '../hooks/frontmatter-repair.mjs';
import { checkStackedFrontmatter } from '../hooks/harness-doctor.mjs';

// Forma do dano real: o prepend empilha do TOPO, então o bloco de baixo é o original (único
// com as chaves-base) e o de cima é a gravação mais recente.
const ORIGINAL = [
  '---',
  'type: session',
  'date: 2026-07-23',
  'provider: claude',
  'source:',
  '  - "codex-hook"',
  'tool_calls: 782',
  'tools:',
  '  - "Bash"',
  '---',
].join('\n');

const PREPENDED = [
  '---',
  'observability_caller: "subagent-stop"',
  'tool_calls: 1200',
  'tools:',
  '  - "Bash"',
  '  - "Read"',
  '---',
].join('\n');

const BODY = '# 02:05 - Sessão\n\n## Iterações\n\ntexto\n';
const DAMAGED = `${PREPENDED}\n\n${ORIGINAL}\n\n${BODY}`;

const leadingBlocks = (content) => {
  let rest = content;
  let n = 0;
  while (/^---\n/.test(rest)) {
    const i = rest.indexOf('\n---', 4);
    if (i < 0) break;
    n += 1;
    rest = rest.slice(i + 4).trimStart();
  }
  return n;
};

const fmKeys = (content) => {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1].split('\n').filter((l) => /^[A-Za-z0-9_-]+:/.test(l)).map((l) => l.split(':')[0]) : [];
};

function vaultWith(notes) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-repair-'));
  const dir = join(vault, '02-Sessões', '2026', '07-JUL', 'DIA 23');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(notes)) writeFileSync(join(dir, name), content);
  return { vault, note: (name) => join(dir, name) };
}

test('splitStackedFrontmatter separa os blocos do topo do corpo', () => {
  const r = splitStackedFrontmatter(DAMAGED);
  assert.equal(r.blocks.length, 2, 'os dois blocos empilhados');
  assert.match(r.blocks[0], /tool_calls: 1200/, 'blocks[0] é o do topo (mais recente)');
  assert.match(r.blocks[1], /type: session/, 'blocks[1] é o original (chaves-base)');
  assert.equal(r.body, BODY);
});

// Detector e reparador precisam usar a MESMA regra de "empilhado", senão o doctor acusaria
// uma nota que o reparo não conserta — ou o reparo comeria corpo que o doctor acha são.
test('splitStackedFrontmatter concorda com checkStackedFrontmatter sobre `---` no corpo', () => {
  const comRegra = `${ORIGINAL}\n\n# x\n\ntexto\n\n---\n\nmais texto\n`;
  const r = splitStackedFrontmatter(comRegra);
  assert.equal(r.blocks.length, 1, 'regra horizontal no corpo não é bloco empilhado');
  assert.match(r.body, /mais texto/, 'e continua no corpo');

  const { vault } = vaultWith({ 'regra.md': comRegra });
  try {
    assert.equal(checkStackedFrontmatter(vault).count, 0, 'o detector concorda');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('mergeStackedFrontmatter: valor do bloco de cima vence na chave repetida', () => {
  const merged = mergeStackedFrontmatter(DAMAGED);
  assert.match(merged, /^tool_calls: 1200$/m, 'a gravação mais recente ganha');
  assert.doesNotMatch(merged, /tool_calls: 782/, 'o valor antigo não sobrevive');
});

test('mergeStackedFrontmatter: chaves-base do bloco de baixo são preservadas', () => {
  const merged = mergeStackedFrontmatter(DAMAGED);
  for (const key of ['type', 'date', 'provider', 'source']) {
    assert.match(merged, new RegExp(`^${key}:`, 'm'), `${key} sobrevive ao merge`);
  }
  assert.match(merged, /^source:\n {2}- "codex-hook"$/m, 'lista aninhada intacta');
});

test('mergeStackedFrontmatter: chave só do bloco de cima é anexada, não descartada', () => {
  const merged = mergeStackedFrontmatter(DAMAGED);
  assert.match(merged, /^observability_caller: "subagent-stop"$/m);
});

test('mergeStackedFrontmatter: lista YAML do bloco vencedor é reproduzida literalmente', () => {
  const merged = mergeStackedFrontmatter(DAMAGED);
  assert.match(merged, /^tools:\n {2}- "Bash"\n {2}- "Read"$/m, 'a lista do topo vence, byte-a-byte');
});

test('mergeStackedFrontmatter: resultado tem um bloco só e o corpo intacto', () => {
  const merged = mergeStackedFrontmatter(DAMAGED);
  assert.equal(leadingBlocks(merged), 1);
  assert.ok(merged.endsWith(BODY), 'corpo preservado no fim');
});

test('mergeStackedFrontmatter: nenhuma chave de entrada se perde', () => {
  const merged = mergeStackedFrontmatter(DAMAGED);
  const got = new Set(fmKeys(merged));
  for (const key of [...fmKeys(`${PREPENDED}\n`), ...fmKeys(`${ORIGINAL}\n`)]) {
    assert.ok(got.has(key), `chave ${key} presente no resultado`);
  }
});

test('mergeStackedFrontmatter: nota sã ou sem frontmatter devolve null', () => {
  assert.equal(mergeStackedFrontmatter(`${ORIGINAL}\n\n${BODY}`), null, 'um bloco só: nada a fazer');
  assert.equal(mergeStackedFrontmatter(BODY), null, 'sem frontmatter');
  assert.equal(mergeStackedFrontmatter(''), null);
});

test('mergeStackedFrontmatter: funde os 4 blocos do caso real, o do topo vencendo', () => {
  const b = (n) => ['---', 'observability_caller: "subagent-stop"', `tool_calls: ${n}`, '---'].join('\n');
  const merged = mergeStackedFrontmatter(`${b(1200)}\n\n${b(868)}\n\n${b(840)}\n\n${ORIGINAL}\n\n${BODY}`);
  assert.equal(leadingBlocks(merged), 1);
  assert.match(merged, /^tool_calls: 1200$/m);
  assert.match(merged, /^type: session$/m);
});

test('repairStackedFrontmatter: dry-run não toca no arquivo', () => {
  const { vault, note } = vaultWith({ 'quebrada.md': DAMAGED });
  try {
    const before = readFileSync(note('quebrada.md'), 'utf8');
    const r = repairStackedFrontmatter(vault);

    assert.equal(r.applied, false);
    assert.equal(r.repaired.length, 1, 'a nota aparece no relatório mesmo em dry-run');
    assert.equal(readFileSync(note('quebrada.md'), 'utf8'), before, 'byte-idêntico');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('repairStackedFrontmatter --apply conserta a nota e ela some do doctor', () => {
  const { vault, note } = vaultWith({ 'quebrada.md': DAMAGED, 'boa.md': `${ORIGINAL}\n\n${BODY}` });
  try {
    assert.equal(checkStackedFrontmatter(vault).count, 1, 'pré-condição');

    const r = repairStackedFrontmatter(vault, { apply: true });

    assert.equal(r.applied, true);
    assert.equal(r.repaired.length, 1);
    assert.equal(checkStackedFrontmatter(vault).count, 0, 'o doctor deixa de acusar');
    const fixed = readFileSync(note('quebrada.md'), 'utf8');
    assert.equal(leadingBlocks(fixed), 1);
    assert.match(fixed, /^tool_calls: 1200$/m);
    assert.match(fixed, /^type: session$/m);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('repairStackedFrontmatter --apply é idempotente', () => {
  const { vault, note } = vaultWith({ 'quebrada.md': DAMAGED });
  try {
    repairStackedFrontmatter(vault, { apply: true });
    const after = readFileSync(note('quebrada.md'), 'utf8');
    const mtime = statSync(note('quebrada.md')).mtimeMs;

    const second = repairStackedFrontmatter(vault, { apply: true });

    assert.equal(second.repaired.length, 0, 'nada a reparar na segunda passada');
    assert.equal(readFileSync(note('quebrada.md'), 'utf8'), after);
    assert.equal(statSync(note('quebrada.md')).mtimeMs, mtime, 'não reescreve');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('repairStackedFrontmatter: nota travada por outro processo é pulada, não corrompida', () => {
  const { vault, note } = vaultWith({ 'quebrada.md': DAMAGED });
  try {
    mkdirSync(`${note('quebrada.md')}.lock`);

    const r = repairStackedFrontmatter(vault, { apply: true, lockTimeoutMs: 40 });

    assert.equal(r.repaired.length, 0);
    assert.equal(r.skipped.length, 1, 'reportada como pulada');
    assert.equal(readFileSync(note('quebrada.md'), 'utf8'), DAMAGED, 'byte-idêntico');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

// --- CLI: wendkeep note repair-frontmatter ---------------------------------

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');
const spawnRepair = (vault, args = []) => spawnSync(
  process.execPath,
  [BIN, 'note', 'repair-frontmatter', ...args, '--vault', vault],
  { encoding: 'utf8' },
);

test('CLI repair-frontmatter: dry-run relata sem escrever e avisa como aplicar', () => {
  const { vault, note } = vaultWith({ 'quebrada.md': DAMAGED });
  try {
    const r = spawnRepair(vault);

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 nota\(s\) com frontmatter empilhado seriam reparada\(s\)/);
    assert.match(r.stdout, /quebrada\.md \(2 blocos -> 1\)/);
    assert.match(r.stdout, /dry-run — nada escrito/);
    assert.equal(readFileSync(note('quebrada.md'), 'utf8'), DAMAGED, 'byte-idêntico');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('CLI repair-frontmatter --apply grava e a segunda passada não acha nada', () => {
  const { vault, note } = vaultWith({ 'quebrada.md': DAMAGED });
  try {
    const r = spawnRepair(vault, ['--apply']);

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 nota\(s\) com frontmatter empilhado reparada\(s\)/);
    assert.doesNotMatch(r.stdout, /dry-run/);
    assert.equal(leadingBlocks(readFileSync(note('quebrada.md'), 'utf8')), 1);

    const again = spawnRepair(vault, ['--apply']);
    assert.match(again.stdout, /^0 nota\(s\)/, 'idempotente pela CLI');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('CLI repair-frontmatter --json emite o relatório estruturado', () => {
  const { vault } = vaultWith({ 'quebrada.md': DAMAGED });
  try {
    const r = spawnRepair(vault, ['--json']);

    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.applied, false);
    assert.equal(parsed.repaired.length, 1);
    assert.equal(parsed.repaired[0].blocks, 2);
    assert.match(parsed.repaired[0].file, /quebrada\.md$/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('CLI note: subcomando desconhecido cita repair-frontmatter na ajuda', () => {
  const { vault } = vaultWith({ 'boa.md': `${ORIGINAL}\n\n${BODY}` });
  try {
    const r = spawnSync(process.execPath, [BIN, 'note', 'inexistente', '--vault', vault], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /repair-frontmatter/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('repairStackedFrontmatter: vault sem notas empilhadas não repara nada', () => {
  const { vault } = vaultWith({ 'boa.md': `${ORIGINAL}\n\n${BODY}` });
  try {
    const r = repairStackedFrontmatter(vault, { apply: true });
    assert.deepEqual(r.repaired, []);
    assert.deepEqual(r.skipped, []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
