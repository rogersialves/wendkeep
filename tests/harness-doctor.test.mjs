import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHarness } from '../hooks/harness-doctor.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

test('checkHarness: flags invalid sensors.json and a broken active pointer', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-doc-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-docp-'));
  try {
    writeFileSync(join(proj, 'wendkeep.sensors.json'), '{ not json');
    mkdirSync(join(vault, '.brain'), { recursive: true });
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: ghost\n');
    const r = checkHarness(vault, proj);
    assert.ok(r.errors.some((e) => /sensors\.json/i.test(e)), 'invalid sensors');
    assert.ok(r.errors.some((e) => /ghost/.test(e)), 'broken pointer');
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('checkHarness: flags an orphan [req:]; clean vault has no errors', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-doc2-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-doc2p-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', 'x'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), '---\nspecs: []\n---\n# x\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [ ] 1.1 faz [req:NOPE-1]\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: x\n');
    const r = checkHarness(vault, proj);
    assert.ok(r.errors.some((e) => /NOPE-1/.test(e)), 'orphan req flagged');

    // resolve the req in a living spec -> no more orphan error
    mkdirSync(join(vault, '07-Specs'), { recursive: true });
    writeFileSync(join(vault, '07-Specs', 'cap.md'), '# cap\n## Requisitos\n### Requisito: NOPE-1 — existe\nok\n\n> Atualizado por [[x]] em 2026-07-05.\n');
    const r2 = checkHarness(vault, proj);
    assert.ok(!r2.errors.some((e) => /NOPE-1/.test(e)), 'req now resolves');
    assert.equal(r2.errors.length, 0, `clean: ${r2.errors.join('; ')}`);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('checkHarness diagnostica spec_impact pendente na change ativa', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-doc-impact-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-doc-impactp-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', 'x'), { recursive: true });
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: x\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', '.spec-impact-v1'), '1\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), '---\nspec_impact: pending\nspec_impact_reason: ""\nspecs: []\n---\n');
    const r = checkHarness(vault, proj);
    assert.ok(!r.errors.some((e) => /spec_impact.*pending/i.test(e)));
    assert.ok(r.attention.some((e) => /spec_impact.*pending/i.test(e)));
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('doctor runtime tolera trabalho em andamento por padrão e --strict o promove a falha', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-doc-runtime-'));
  const project = mkdtempSync(join(tmpdir(), 'wk-doc-runtimep-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', 'x'), { recursive: true });
    writeFileSync(join(project, 'package.json'), '{"name":"doctor-runtime"}\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: x\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', '.spec-impact-v1'), '1\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), '---\nspec_impact: pending\nspec_impact_reason: ""\nspecs: []\n---\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [ ] 1.1 implementar\n');

    const normal = spawnSync(process.execPath, [
      BIN, 'doctor', '--scope', 'runtime', '--project', project, '--vault', vault,
    ], { cwd: project, encoding: 'utf8' });
    assert.equal(normal.status, 0, normal.stderr || normal.stdout);
    assert.match(normal.stdout, /\[runtime\].*atenção/);
    assert.doesNotMatch(normal.stdout, /\[integridade\]|\[memória\]/);

    const strict = spawnSync(process.execPath, [
      BIN, 'doctor', '--scope', 'runtime', '--strict', '--project', project, '--vault', vault,
    ], { cwd: project, encoding: 'utf8' });
    assert.equal(strict.status, 1, strict.stderr || strict.stdout);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
