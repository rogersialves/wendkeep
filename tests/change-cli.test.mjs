import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

test('wendkeep change new: creates change under the vault', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-chgcli-'));
  try {
    const r = spawnSync(process.execPath, [BIN, 'change', 'new', 'dark-mode', '--vault', vault], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(vault, '08-Mudanças', 'dark-mode', 'proposta.md')));
    assert.match(r.stdout, /change created/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('wendkeep change new then archive: moves + writes ADR', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-archcli-'));
  try {
    const spawn = (args) => spawnSync(process.execPath, [BIN, 'change', ...args, '--vault', vault], { encoding: 'utf8' });
    assert.equal(spawn(['new', 'x']).status, 0);
    const r = spawn(['archive', 'x']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(vault, '08-Mudanças', '_arquivo')), 'archived dir exists');
    assert.match(r.stdout, /ADR:/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('wendkeep verify: runs task sensors, writes evidencia.json', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-ver-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-verp-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', 'x'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [ ] 1.1 do it [sensor:ok]\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: x\n');
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'ok', severity: 'critical', command: 'node -e "process.exit(0)"' }] }));
    const r = spawnSync(process.execPath, [BIN, 'verify', '--vault', vault, '--project', proj], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const ev = JSON.parse(readFileSync(join(vault, '08-Mudanças', 'x', 'evidencia.json'), 'utf8'));
    assert.equal(ev.find((e) => e.id === 'ok').status, 'green');
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('archive blocked until verify green when a task declares a sensor', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-gate-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-gatep-'));
  const spawn = (args) => spawnSync(process.execPath, [BIN, ...args, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [ ] 1.1 do it [sensor:ok]\n');
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'ok', severity: 'critical', command: 'node -e "process.exit(0)"' }] }));
    const blocked = spawn(['change', 'archive', 'x']);
    assert.equal(blocked.status, 1, 'archive blocked without evidence');
    assert.match(blocked.stderr, /BLOCKED/);
    assert.equal(spawn(['verify']).status, 0);
    const ok = spawn(['change', 'archive', 'x']);
    assert.equal(ok.status, 0, ok.stderr);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('archive promotes spec deltas into 07-Specs (living contract)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-spec-'));
  const spawn = (args) => spawnSync(process.execPath, [BIN, 'change', ...args, '--vault', vault], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    assert.equal(spawn(['new', 'x']).status, 0);
    writeFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), '---\ntype: change\nstatus: active\nspecs: [auth]\n---\n# x\n');
    mkdirSync(join(vault, '08-Mudanças', 'x', 'specs', 'auth'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requisito: Login\nusuário faz login\n');
    const r = spawn(['archive', 'x']);
    assert.equal(r.status, 0, r.stderr);
    const live = readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8');
    assert.match(live, /### Requisito: Login/);
    assert.match(r.stdout, /auth/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('warning sensor red does not block verify or archive', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-warn-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-warnp-'));
  const spawn = (args) => spawnSync(process.execPath, [BIN, ...args, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [ ] 1.1 polish [sensor:style]\n');
    // style is a RED warning sensor (exit 1) — advisory, must NOT gate.
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'style', severity: 'warning', command: 'exit 1' }] }));
    assert.equal(spawn(['verify']).status, 0, 'red warning still passes verify');
    const arch = spawn(['change', 'archive', 'x']);
    assert.equal(arch.status, 0, `red warning does not block archive; stderr=${arch.stderr}`);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});
