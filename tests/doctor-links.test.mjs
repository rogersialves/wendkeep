// DIAG-1..4 — doctor surfaça órfãos do grafo + sinaliza sessão inativa com atividade recente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVaultLinks, checkSessionActivity } from '../hooks/harness-doctor.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

test('checkVaultLinks: counts derived + artifact orphans and empty graph colors', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-diag-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    const bugDir = join(vault, '05-Bugs', '2026', '07-JUL');
    mkdirSync(bugDir, { recursive: true });
    writeFileSync(join(bugDir, 'BUG-0001-a.md'), '---\ntype: bug\nbug: 1\ncssclasses:\n  - topic-bug\n---\n\n# BUG-0001\n');
    writeFileSync(join(bugDir, 'BUG-0002-b.md'), '---\ntype: bug\nbug: 2\nsource:\n  - "[[02-Sessões/2026/07-JUL/DIA 19/14-58-analise]]"\ncssclasses:\n  - topic-bug\n---\n\n# BUG-0002\n');
    // change 'x': design.md órfão (sem backlink) → conta. change 'y': design.md JÁ linkado → não conta.
    const chX = join(vault, '08-Mudanças', 'x');
    mkdirSync(chX, { recursive: true });
    writeFileSync(join(chX, 'proposta.md'), '# x\n');
    writeFileSync(join(chX, 'design.md'), '# x — design\n\n## Abordagem\n');
    const chY = join(vault, '08-Mudanças', 'y');
    mkdirSync(chY, { recursive: true });
    writeFileSync(join(chY, 'proposta.md'), '# y\n');
    writeFileSync(join(chY, 'design.md'), '# y — design\n\n> Mudança: [[08-Mudanças/y/proposta]]\n\n## Abordagem\n');
    mkdirSync(join(vault, '.obsidian'), { recursive: true });
    writeFileSync(join(vault, '.obsidian', 'graph.json'), JSON.stringify({ colorGroups: [] }));

    const r = checkVaultLinks(vault);
    assert.equal(r.derivedOrphans, 1, 'BUG-0001 é a única órfã');
    assert.equal(r.artifactOrphans, 1, 'só o design.md de x é órfão; o de y já linka (exclusão)');
    assert.equal(r.graphColors, false, 'colorGroups vazio = sem cores');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('checkVaultLinks: graphColors true with groups, null without graph.json', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-diag2-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    assert.equal(checkVaultLinks(vault).graphColors, null, 'sem graph.json = null');
    mkdirSync(join(vault, '.obsidian'), { recursive: true });
    writeFileSync(join(vault, '.obsidian', 'graph.json'), JSON.stringify({ colorGroups: [{ query: 'path:"05-Bugs"', color: { a: 1, rgb: 1 } }] }));
    assert.equal(checkVaultLinks(vault).graphColors, true, 'com grupos = true');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('checkSessionActivity: flags inactive control with a recently-written session note', async () => {
  const { writeControl } = await import('../hooks/obsidian-common.mjs');
  const vault = mkdtempSync(join(tmpdir(), 'wk-sess-'));
  try {
    const sess = '02-Sessões/2026/07-JUL/DIA 23/02-05-x.md';
    mkdirSync(join(vault, '02-Sessões', '2026', '07-JUL', 'DIA 23'), { recursive: true });
    writeFileSync(join(vault, sess), '# sessão\n');
    writeControl(vault, { status: 'inactive', session_file: '', last_session_file: sess });
    const mtime = statSync(join(vault, sess)).mtimeMs;

    const recent = checkSessionActivity(vault, { now: mtime + 1000, windowMs: 5 * 60000 });
    assert.equal(recent.active, false);
    assert.equal(recent.backgroundSuspected, true, 'inativa + escrita recente = suspeita de background');

    const old = checkSessionActivity(vault, { now: mtime + 10 * 60000, windowMs: 5 * 60000 });
    assert.equal(old.backgroundSuspected, false, 'inativa + antiga = sem suspeita');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('doctor: prints the [links] section with a repair command when orphans exist', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-doc-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    const bugDir = join(vault, '05-Bugs', '2026', '07-JUL');
    mkdirSync(bugDir, { recursive: true });
    writeFileSync(join(bugDir, 'BUG-0001-a.md'), '---\ntype: bug\nbug: 1\ncssclasses:\n  - topic-bug\n---\n\n# BUG-0001\n');
    writeFileSync(join(bugDir, 'BUG-0002-b.md'), '---\ntype: bug\nbug: 2\nsource:\n  - "[[02-Sessões/2026/07-JUL/DIA 19/14-58-analise]]"\ncssclasses:\n  - topic-bug\n---\n\n# BUG-0002\n');
    const r = spawnSync(process.execPath, [BIN, 'doctor', '--vault', vault], { encoding: 'utf8' });
    assert.match(r.stdout, /\[links\]/, 'imprime a seção [links]');
    assert.match(r.stdout, /note relink/, 'sugere o comando de reparo das derivadas');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
