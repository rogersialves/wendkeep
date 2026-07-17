// CLI-1/CLI-2 — --help nunca executa; flag desconhecida no import nunca vira default destrutivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function freshVault() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-cli-safety-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  return vault;
}

// CLI-1 — `wendkeep import --help` imprime usage, exit 0, e NÃO escreve nada no vault.
test('import --help: prints usage, exit 0, writes nothing to the vault', () => {
  const vault = freshVault();
  try {
    const before = readdirSync(vault, { recursive: true }).length;
    const r = spawnSync(process.execPath, [BIN, 'import', '--help', '--vault', vault], { encoding: 'utf8' });
    assert.equal(r.status, 0, `exit 0 esperado; stderr: ${r.stderr}`);
    assert.match(r.stdout, /import/i, 'usage menciona o comando');
    assert.equal(readdirSync(vault, { recursive: true }).length, before, 'vault intocado');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// CLI-1 — --help funciona mesmo sem vault resolvível (fora de projeto).
test('import --help: works without any vault (no "no vault" failure)', () => {
  const r = spawnSync(process.execPath, [BIN, 'import', '--help'], { encoding: 'utf8', env: { ...process.env, OBSIDIAN_VAULT_PATH: '' }, cwd: tmpdir() });
  assert.equal(r.status, 0, `exit 0 esperado; stderr: ${r.stderr}`);
  assert.match(r.stdout, /import/i);
});

// CLI-1 — -h curto também intercepta em outro subcomando qualquer.
test('change -h: prints usage and exit 0 without executing', () => {
  const r = spawnSync(process.execPath, [BIN, 'change', '-h'], { encoding: 'utf8', env: { ...process.env, OBSIDIAN_VAULT_PATH: '' }, cwd: tmpdir() });
  assert.equal(r.status, 0, `exit 0 esperado; stderr: ${r.stderr}`);
  assert.match(r.stdout, /change/i);
});

// CLI-2 — flag desconhecida no import: erro citando a flag, exit 2, zero escrita.
test('import with unknown flag: names the flag, exit 2, writes nothing', () => {
  const vault = freshVault();
  try {
    const before = readdirSync(vault, { recursive: true }).length;
    const r = spawnSync(process.execPath, [BIN, 'import', '--qualquer-coisa', '--vault', vault], { encoding: 'utf8' });
    assert.equal(r.status, 2, `exit 2 esperado; stdout: ${r.stdout}`);
    assert.match(r.stderr, /--qualquer-coisa/, 'stderr cita a flag desconhecida');
    assert.match(r.stderr, /--help/, 'stderr sugere --help');
    assert.equal(readdirSync(vault, { recursive: true }).length, before, 'vault intocado');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// ---- Round 1 de fix do verdict independente: costuras do verify ----

function changeFixture({ tarefas, specReqs }) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-vfx-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-vfxp-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  const dir = join(vault, '08-Mudanças', 'x');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'proposta.md'), '---\ntype: change\nstatus: active\nspec_impact: required\nspec_impact_reason: ""\nspecs: [core]\n---\n\n# x\n');
  writeFileSync(join(dir, 'tarefas.md'), tarefas);
  if (specReqs) {
    mkdirSync(join(dir, 'specs', 'core'), { recursive: true });
    writeFileSync(join(dir, 'specs', 'core', 'spec.md'), `## ADDED Requirements\n${specReqs}`);
  }
  writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: x\n');
  return { vault, proj, dir };
}

// REQ-1 (e2e) — verify --deep propaga TODOS os [req:] de uma tarefa pro pacote.
test('verify --deep: a multi-[req:] task lands every id in verificacao.json', () => {
  const { vault, proj, dir } = changeFixture({
    tarefas: '- [x] 1.1 faz X [req:A-1] [req:A-2] [req:A-3]\n',
    specReqs: '### Requisito: A-1 — um\nc1\n\n### Requisito: A-2 — dois\nc2\n\n### Requisito: A-3 — três\nc3\n',
  });
  try {
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [] }));
    const r = spawnSync(process.execPath, [BIN, 'verify', '--deep', '--vault', vault, '--project', proj], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const pkg = JSON.parse(readFileSync(join(dir, 'verificacao.json'), 'utf8'));
    const ids = pkg.requirements.map((q) => q.id).sort();
    assert.deepEqual(ids, ['A-1', 'A-2', 'A-3'], 'os TRÊS reqs entram no pacote — nenhum descartado');
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

// SEN-1 (CLI) — sensors.json ausente: aviso com path + dica --project (nunca "sensor não definido" sozinho).
test('verify: missing sensors.json warns with the resolved path and --project hint', () => {
  const { vault, proj } = changeFixture({ tarefas: '- [x] 1.1 faz [sensor:ok]\n' });
  try {
    const r = spawnSync(process.execPath, [BIN, 'verify', '--vault', vault, '--project', proj], { encoding: 'utf8' });
    assert.match(r.stderr, /wendkeep\.sensors\.json não encontrado em /, 'diz o que faltou');
    assert.ok(r.stderr.includes(proj), 'diz ONDE procurou');
    assert.match(r.stderr, /--project/, 'ensina a saída');
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

// SEN-1 (CLI) — sensors.json inválido: exit 2 com a mensagem do parse, nunca lista vazia silenciosa.
test('verify: broken sensors.json fails loud with the parse error', () => {
  const { vault, proj } = changeFixture({ tarefas: '- [x] 1.1 faz [sensor:ok]\n' });
  try {
    writeFileSync(join(proj, 'wendkeep.sensors.json'), '{ broken');
    const r = spawnSync(process.execPath, [BIN, 'verify', '--vault', vault, '--project', proj], { encoding: 'utf8' });
    assert.equal(r.status, 2, `exit 2 esperado; stderr: ${r.stderr}`);
    assert.match(r.stderr, /inválido/, 'nomeia o problema');
    assert.doesNotMatch(r.stderr, /sensor não definido/, 'nunca o diagnóstico enganoso');
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

// SEN-2 (CLI) — verify de um subdiretório sem --project acha os sensores da raiz.
test('verify: run from a subdirectory without --project finds the root sensors', () => {
  const { vault, proj, dir } = changeFixture({ tarefas: '- [x] 1.1 faz [sensor:ok]\n' });
  try {
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'ok', severity: 'critical', command: 'node -e "process.exit(0)"' }] }));
    const sub = join(proj, 'mobile-app', 'src');
    mkdirSync(sub, { recursive: true });
    const r = spawnSync(process.execPath, [BIN, 'verify', '--vault', vault], { encoding: 'utf8', cwd: sub });
    assert.equal(r.status, 0, r.stderr);
    const ev = JSON.parse(readFileSync(join(dir, 'evidencia.json'), 'utf8'));
    assert.equal(ev.find((e) => e.id === 'ok').status, 'green', 'sensor da raiz achado e verde a partir do subdir');
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});
