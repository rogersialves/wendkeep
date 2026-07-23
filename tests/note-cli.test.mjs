// DRV-3 — `wendkeep note new` cria nota derivada numerada no path certo e imprime o path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function freshVault() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-note-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  return vault;
}
const spawnNote = (vault, args) => spawnSync(process.execPath, [BIN, 'note', ...args, '--vault', vault], { encoding: 'utf8' });

test('note new --type bug: sequential numbers, stdout is the vault path, correct content', () => {
  const vault = freshVault();
  try {
    const r1 = spawnNote(vault, ['new', '--type', 'bug', 'Parser descarta requisitos', '--date', '2026-07-16']);
    assert.equal(r1.status, 0, r1.stderr);
    const rel1 = r1.stdout.trim();
    assert.match(rel1, /^05-Bugs\/2026\/07-JUL\/BUG-0001-parser-descarta-requisitos\.md$/);
    const c = readFileSync(join(vault, rel1), 'utf8');
    assert.match(c, /^type: bug$/m);
    assert.match(c, /^bug: 1$/m);
    assert.match(c, /^status: open$/m, 'nota manual nasce aberta');
    assert.match(c, /^# BUG-0001 — Parser descarta requisitos$/m);

    const r2 = spawnNote(vault, ['new', '--type', 'bug', 'Outro problema', '--date', '2026-07-16']);
    assert.match(r2.stdout.trim(), /BUG-0002-outro-problema\.md$/, 'sequencial');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('note new --type learning: APR prefix in 06-Aprendizados', () => {
  const vault = freshVault();
  try {
    const r = spawnNote(vault, ['new', '--type', 'learning', 'Regex sem flag global', '--date', '2026-05-18']);
    assert.equal(r.status, 0, r.stderr);
    const rel = r.stdout.trim();
    assert.match(rel, /^06-Aprendizados\/2026\/05-MAI\/APR-0001-regex-sem-flag-global\.md$/);
    const c = readFileSync(join(vault, rel), 'utf8');
    assert.match(c, /^type: learning$/m);
    assert.match(c, /^apr: 1$/m);
    assert.match(c, /^# APR-0001 — Regex sem flag global$/m);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('note new: en locale lands in 06-Learnings', () => {
  const vault = freshVault();
  try {
    writeFileSync(join(vault, '.brain', 'config.json'), '{ "locale": "en" }');
    const r = spawnNote(vault, ['new', '--type', 'learning', 'Shared regex constants', '--date', '2026-07-16']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout.trim(), /^06-Learnings\/2026\/07-JUL\/APR-0001-shared-regex-constants\.md$/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('note new: active session goes into source: as wikilink', async () => {
  const { writeControl } = await import('../hooks/obsidian-common.mjs');
  const vault = freshVault();
  try {
    writeControl(vault, { status: 'active', session_file: '02-Sessões/2026/07-JUL/DIA 16/20-00-demo.md' });
    const r = spawnNote(vault, ['new', '--type', 'bug', 'Com sessão ativa', '--date', '2026-07-16']);
    assert.equal(r.status, 0, r.stderr);
    const c = readFileSync(join(vault, r.stdout.trim()), 'utf8');
    assert.match(c, /\[\[02-Sessões\/2026\/07-JUL\/DIA 16\/20-00-demo\]\]/, 'backlink da sessão ativa');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('note relink --apply: backfills orphan derived notes with the modal session', () => {
  const vault = freshVault();
  try {
    const bugDir = join(vault, '05-Bugs', '2026', '07-JUL');
    mkdirSync(bugDir, { recursive: true });
    writeFileSync(join(bugDir, 'BUG-0001-a.md'), '---\ntype: bug\nbug: 1\ncssclasses:\n  - topic-bug\n---\n\n# BUG-0001\n');
    writeFileSync(join(bugDir, 'BUG-0002-b.md'), '---\ntype: bug\nbug: 2\nsource:\n  - "[[02-Sessões/2026/07-JUL/DIA 19/14-58-analise]]"\nrelated:\n  - "[[02-Sessões/2026/07-JUL/DIA 19/14-58-analise]]"\ncssclasses:\n  - topic-bug\n---\n\n# BUG-0002\n');
    const dry = spawnNote(vault, ['relink']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(!readFileSync(join(bugDir, 'BUG-0001-a.md'), 'utf8').includes('source:'), 'dry-run não escreve');
    const r = spawnNote(vault, ['relink', '--apply']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(bugDir, 'BUG-0001-a.md'), 'utf8'), /\[\[02-Sessões\/2026\/07-JUL\/DIA 19\/14-58-analise\]\]/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('note new: invalid input exits 2 and writes nothing', () => {
  const vault = freshVault();
  try {
    const before = readdirSync(vault, { recursive: true }).length;
    for (const args of [
      ['new', '--type', 'banana', 'x'],
      ['new', '--type', 'bug'],
      ['new', 'sem tipo'],
      ['new', '--type', 'bug', 'x', '--date', 'ontem'],
    ]) {
      const r = spawnNote(vault, args);
      assert.equal(r.status, 2, `exit 2 para ${JSON.stringify(args)}; stdout=${r.stdout}`);
    }
    assert.equal(readdirSync(vault, { recursive: true }).length, before, 'vault intocado');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
