// e2e: an `en` vault runs the full loop with English folders/headings (0.8.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

test('init --locale en: english folders + config; pt folders absent', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-en-'));
  const projectDir = join(parent, 'EnProj');
  mkdirSync(projectDir);
  try {
    const r = spawnSync(process.execPath, [BIN, 'init', '--project', projectDir, '--locale', 'en', '--no-mcp', '--no-companions', '--no-colors', '--yes'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const vault = join(projectDir, '.EnProj-vault');
    assert.equal(JSON.parse(readFileSync(join(vault, '.brain', 'config.json'), 'utf8')).locale, 'en');
    for (const f of ['02-Sessions', '04-Decisions', '06-Learnings', '08-Changes', '07-Specs']) {
      assert.ok(existsSync(join(vault, f)), `${f} exists`);
    }
    assert.ok(!existsSync(join(vault, '02-Sessões')), 'no pt sessions folder');
    assert.ok(!existsSync(join(vault, '08-Mudanças')), 'no pt changes folder');
    assert.ok(existsSync(join(vault, '07-Specs', 'README.md')), 'specs README seeded');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('en surfaces: months, session folder, CORE skeleton, theme groups', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-ensurf-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    writeFileSync(join(vault, '.brain', 'config.json'), '{ "locale": "en" }');
    const { sessionFolderRel } = await import('../hooks/obsidian-common.mjs');
    const rel = sessionFolderRel(new Date(2026, 1, 3), vault); // fevereiro
    assert.match(rel.replaceAll('\\', '/'), /^02-Sessions\/2026\/02-FEB\/DIA 03$/, `en month+folder: ${rel}`);
    const relPt = sessionFolderRel(new Date(2026, 1, 3)); // sem vault = pt
    assert.match(relPt.replaceAll('\\', '/'), /^02-Sessões\/2026\/02-FEV\//, 'pt default intact');

    const { renderCoreSkeleton, validateCore } = await import('../src/validate-core.mjs');
    const enCore = renderCoreSkeleton('en');
    assert.match(enCore, /## User Preferences/);
    assert.equal(validateCore(enCore).ok, true, 'en skeleton validates');
    assert.equal(validateCore(renderCoreSkeleton()).ok, true, 'pt skeleton still validates');

    const { graphColorGroups } = await import('../src/vault-theme.mjs');
    const { LOCALES } = await import('../hooks/locale.mjs');
    const q = graphColorGroups(LOCALES.en).map((g) => g.query);
    assert.ok(q.some((s) => s.includes('08-Changes')), 'en graph group');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('en vault: change loop end-to-end (scaffold, requirement heading, ADR in 04-Decisions)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-enloop-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    writeFileSync(join(vault, '.brain', 'config.json'), '{ "locale": "en" }');
    assert.equal(spawn(['new', 'x']).status, 0);
    const dir = join(vault, '08-Changes', 'x');
    assert.ok(existsSync(join(dir, 'proposta.md')), 'change under 08-Changes');
    assert.match(readFileSync(join(dir, 'proposta.md'), 'utf8'), /## Why/, 'en scaffold');
    assert.match(readFileSync(join(dir, 'specs', 'exemplo', 'spec.md'), 'utf8'), /### Requirement:/, 'en delta template');
    // promote an en spec + archive
    writeFileSync(join(dir, 'proposta.md'), '---\ntype: change\nstatus: active\nspecs: [auth]\n---\n# x\n');
    writeFileSync(join(dir, 'tarefas.md'), '- [x] 1.1 done\n');
    mkdirSync(join(dir, 'specs', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requirement: AUTH-1 — login\nuser signs in\n');
    const arch = spawn(['archive', 'x']);
    assert.equal(arch.status, 0, arch.stderr);
    const live = readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8');
    assert.match(live, /### Requirement: AUTH-1 — login/, 'living spec renders en heading');
    assert.ok(existsSync(join(vault, '04-Decisions')), 'ADR dir en');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
