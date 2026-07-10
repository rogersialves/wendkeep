// 0.21.0 — the enforcement layer the planning failure exposed (NutriGym session 243d5556):
// skills existed but nothing routed the model to them; the change was archived as a raw
// scaffold via --force. Three fixes: (A) wk_process router injected every session,
// (B) session-ensure stamps session_id (4th creation path missed in 0.18),
// (C) archive gate blocks unfilled scaffolds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildInjection } from '../hooks/brain-inject.mjs';
import { scaffoldPlaceholders } from '../hooks/change-core.mjs';

// --- A: process router --------------------------------------------------------

test('buildInjection always carries the wk_process router (pt-BR default)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-bi-'));
  try {
    const out = buildInjection(vault);
    assert.match(out, /<wk_process>/);
    assert.match(out, /wk-brainstorming/);
    assert.match(out, /wk-planning/);
    assert.match(out, /wendkeep change new/);
    assert.match(out, /wk-tdd/);
    assert.match(out, /wk-verify/);
    assert.match(out, /spec_impact/);
    assert.match(out, /--force/); // the forbidden-force rule is stated
    assert.match(out, /PROIBIDO|NUNCA/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('wk_process router follows the vault locale (en)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-bi-en-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    writeFileSync(join(vault, '.brain', 'config.json'), JSON.stringify({ locale: 'en' }), 'utf8');
    const out = buildInjection(vault);
    assert.match(out, /<wk_process>/);
    assert.match(out, /NEVER/);
    assert.doesNotMatch(out, /PROIBIDO/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// --- C: anti-scaffold gate -----------------------------------------------------

test('scaffoldPlaceholders flags an unfilled scaffold and clears when filled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-chg-'));
  try {
    writeFileSync(join(dir, 'proposta.md'), '# x\n\n## Por quê\n\n(motivo da mudança)\n', 'utf8');
    writeFileSync(join(dir, 'design.md'), '# x — design\n\n## Abordagem\n\n(abordagem técnica)\n', 'utf8');
    writeFileSync(join(dir, 'tarefas.md'), '# x — tarefas\n\n- [ ] 1.1 (primeira tarefa)\n', 'utf8');
    const found = scaffoldPlaceholders(dir);
    assert.ok(found.length >= 3, `flags all three files (got: ${found.join('; ')})`);

    writeFileSync(join(dir, 'proposta.md'), '# x\n\n## Por quê\n\nChangelog visível no app.\n', 'utf8');
    writeFileSync(join(dir, 'design.md'), '# x — design\n\n## Abordagem\n\nTela + fonte MD versionada.\n', 'utf8');
    writeFileSync(join(dir, 'tarefas.md'), '# x — tarefas\n\n- [x] 1.1 render changelog [req:CHG-1]\n', 'utf8');
    assert.deepEqual(scaffoldPlaceholders(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('change archive BLOCKS a raw scaffold (CLI e2e), message names the scaffold', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-gate-'));
  try {
    const run = (args) => spawnSync(process.execPath, ['bin/wendkeep.mjs', 'change', ...args, '--vault', vault], { encoding: 'utf8' });
    const mk = run(['new', 'raw-idea']);
    assert.equal(mk.status, 0, mk.stderr);
    const ar = run(['archive', 'raw-idea']);
    assert.notEqual(ar.status, 0, 'archive must fail on a raw scaffold');
    assert.match(ar.stderr, /scaffold/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// --- B: session-ensure stamps session_id ---------------------------------------

test('session-ensure created note carries session_id in frontmatter', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-ens-'));
  try {
    const input = JSON.stringify({ session_id: 'ens-abc-123', prompt: 'planejar tela home do app', cwd: vault });
    const r = spawnSync(process.execPath, ['hooks/session-ensure.mjs'], {
      encoding: 'utf8',
      input,
      env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
    });
    assert.equal(r.status, 0, r.stderr);
    // find the created note
    const notes = [];
    (function walk(d) {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.md')) notes.push(p);
      }
    })(join(vault, '02-Sessões'));
    assert.equal(notes.length, 1, 'one session note created');
    const content = readFileSync(notes[0], 'utf8');
    assert.match(content, /^session_id:\s*["']?ens-abc-123["']?\s*$/m);
    assert.match(content, /^provider:\s*\S+/m);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
