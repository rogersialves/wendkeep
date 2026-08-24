import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { git, initGitRepository as initGitProject } from './helpers/git-fixture.mjs';
import { receiptGenesisHash } from '../src/receipt-ledger.mjs';
import { acquireArchiveOperationLock } from '../src/archive-operation-lock.mjs';
import { buildSpecPromotionPlan, captureSpecBaseline } from '../hooks/spec-core.mjs';
import { archiveSourceDigest } from '../hooks/change-core.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

// G0 (0.21.0): archive blocks unfilled scaffolds, so archive-path tests must fill
// proposta/design like a real planned change would.
function fillScaffold(vault, slug, dir = '08-Mudanças') {
  writeFileSync(join(vault, dir, slug, 'proposta.md'), `---\nspec_impact: none\nspec_impact_reason: "Sem alteração de contrato neste fixture"\nspecs: []\n---\n\n# ${slug}\n\n## Por quê\n\nTeste.\n\n## O que muda\n\nTeste.\n`);
  writeFileSync(join(vault, dir, slug, 'design.md'), `# ${slug} — design\n\n## Abordagem\n\nTeste.\n`);
}

function writeLivingRequirement(vault, id, capability = 'core') {
  mkdirSync(join(vault, '07-Specs'), { recursive: true });
  writeFileSync(join(vault, '07-Specs', `${capability}.md`), `# ${capability}\n\n## Requisitos\n\n### Requisito: ${id} — comportamento\ncritério observável\n`);
}

test('change new: proposta links the active session from the control file (G2)', async () => {
  const { writeControl } = await import('../hooks/obsidian-common.mjs');
  const vault = mkdtempSync(join(tmpdir(), 'wk-src-'));
  try {
    writeControl(vault, { status: 'active', session_file: '02-Sessões/2026/07-JUL/DIA 05/10-00-demo.md' });
    const r = spawnSync(process.execPath, [BIN, 'change', 'new', 'x', '--vault', vault], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const proposta = readFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), 'utf8');
    assert.match(proposta, /\[\[02-Sessões\/2026\/07-JUL\/DIA 05\/10-00-demo\]\]/, 'session wikilink in source:');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('archive bloqueia spec_impact pendente ou required sem delta', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-impact-gate-'));
  const spawn = (args) => spawnSync(process.execPath, [BIN, 'change', ...args, '--vault', vault], { encoding: 'utf8' });
  try {
    assert.equal(spawn(['new', 'x']).status, 0);
    writeFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), '---\nspec_impact: pending\nspec_impact_reason: ""\nspecs: []\n---\n# x\n## Por quê\nreal\n## O que muda\nreal\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'design.md'), '# x — design\n## Abordagem\nreal\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 feito\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'verdict.json'), JSON.stringify({ ok: true, coverage: [] }));
    let r = spawn(['archive', 'x']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /spec_impact.*pending/i);

    writeFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), '---\nspec_impact: required\nspec_impact_reason: ""\nspecs: [auth]\n---\n# x\n## Por quê\nreal\n## O que muda\nreal\n');
    r = spawn(['archive', 'x']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /auth|delta/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

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

test('[req:OP-8] CLI pública change new <slug> --simple preserva o scaffold legado compacto', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-simple-cli-'));
  try {
    const result = spawnSync(
      process.execPath,
      [BIN, 'change', 'new', 'legacy-simple', '--simple', '--vault', vault],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /change created/);

    const changeDir = join(vault, '08-Mudanças', 'legacy-simple');
    assert.deepEqual(
      readdirSync(changeDir).sort(),
      ['.spec-base.json', '.spec-impact-v1', 'proposta.md', 'tarefas.md'],
      '--simple preserva os dois artefatos autorais e os metadados internos legados',
    );

    const proposta = readFileSync(join(changeDir, 'proposta.md'), 'utf8');
    assert.match(proposta, /^spec_impact: none$/m);
    assert.match(proposta, /^spec_impact_reason: ".+"$/m);
    assert.match(
      readFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'utf8'),
      /^change: legacy-simple$/m,
      'a CLI ainda seleciona a change simples como atual',
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('wendkeep change new then archive: moves + writes ADR', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-archcli-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-archclip-'));
  try {
    const spawn = (args) => spawnSync(process.execPath, [BIN, ...args, '--vault', vault, '--project', proj], { encoding: 'utf8' });
    initGitProject(proj);
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 feito\n');
    assert.equal(spawn(['verify', '--deep']).status, 0);
    const r = spawn(['change', 'archive', 'x']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(vault, '08-Mudanças', '_arquivo')), 'archived dir exists');
    assert.match(r.stdout, /WENDKEEP_CHANGE_ARCHIVED: operation=archive; state=verified; blocker=null;/);
    assert.match(r.stdout, /expected=\{"change_slug":"x"\}; observed=\{/);
    assert.match(r.stdout, /recovery=null/);
    assert.match(r.stdout, /reason_codes=\[\]; diagnostics=\[\]; repair=null/);
    assert.match(r.stdout, /ADR:/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('wendkeep verify: runs task sensors, writes evidencia.json', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-ver-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-verp-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', 'x'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [ ] 1.1 do it [sensor:ok] [sensor:also-ok] [sensor:ok]\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: x\n');
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [
      { id: 'ok', severity: 'critical', command: 'node -e "process.exit(0)"' },
      { id: 'also-ok', severity: 'critical', command: 'node -e "process.exit(0)"' },
    ] }));
    initGitProject(proj);
    const r = spawnSync(process.execPath, [BIN, 'verify', '--vault', vault, '--project', proj], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const ev = JSON.parse(readFileSync(join(vault, '08-Mudanças', 'x', 'evidencia.json'), 'utf8'));
    assert.equal(ev.schema_version, 2);
    assert.deepEqual(ev.sensors.map((e) => [e.id, e.status]), [['ok', 'green'], ['also-ok', 'green']]);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('wendkeep verify: a second critical sensor on the same task is evidence and blocks the gate', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-multi-ver-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-multi-verp-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', 'x'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 do it [sensor:ok] [sensor:blocked]\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: x\n');
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [
      { id: 'ok', severity: 'critical', command: 'node -e "process.exit(0)"' },
      { id: 'blocked', severity: 'critical', command: 'node -e "process.exit(1)"' },
    ] }));
    initGitProject(proj);
    const r = spawnSync(process.execPath, [BIN, 'verify', '--vault', vault, '--project', proj], { encoding: 'utf8' });
    assert.equal(r.status, 1, 'the second critical sensor must block verify');
    const ev = JSON.parse(readFileSync(join(vault, '08-Mudanças', 'x', 'evidencia.json'), 'utf8'));
    assert.deepEqual(ev.sensors.map((e) => [e.id, e.status]), [['ok', 'green'], ['blocked', 'red']]);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('[req:OP-10] wendkeep verify exports its effective --vault to sensor processes', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-sensor-vault-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-sensor-vaultp-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', 'x'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 bind [sensor:vault-env]\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: x\n');
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{
      id: 'vault-env',
      severity: 'critical',
      command: 'node -e "require(\'node:fs\').writeFileSync(\'seen-vault.txt\', process.env.OBSIDIAN_VAULT_PATH || \'\')"',
    }] }));
    initGitProject(proj);
    const result = spawnSync(process.execPath, [BIN, 'verify', '--vault', vault, '--project', proj], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(proj, 'seen-vault.txt'), 'utf8'), vault);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('[req:OP-10] nested wendkeep sensor keeps verify effective Vault over the project binding', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-sensor-nested-vault-'));
  const vault = join(root, 'selected-vault');
  const proj = join(root, 'project');
  const decoy = join(proj, '.decoy-vault');
  const slug = 'selected-vault-change';
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', slug), { recursive: true });
    mkdirSync(join(decoy, '.brain'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', slug, 'tarefas.md'), '- [x] 1.1 bind [sensor:nested-vault]\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), `change: ${slug}\n`);
    writeFileSync(join(proj, '.wendkeep.json'), `${JSON.stringify({
      schemaVersion: 1,
      projectId: 'decoy-project',
      vault: '.decoy-vault',
    }, null, 2)}\n`);
    writeFileSync(join(decoy, '.brain', 'PROJECT.json'), `${JSON.stringify({
      schemaVersion: 1,
      projectId: 'decoy-project',
      projectName: 'project',
    }, null, 2)}\n`);
    const sensorScript = join(proj, 'nested-sensor.mjs');
    writeFileSync(sensorScript, `
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'change', 'status'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: process.env,
});
process.exit(result.status === 0 && result.stdout.includes(${JSON.stringify(slug)}) ? 0 : 1);
`);
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{
      id: 'nested-vault',
      severity: 'critical',
      command: `node "${sensorScript}"`,
    }] }));

    initGitProject(proj);
    const result = spawnSync(process.execPath, [BIN, 'verify', '--vault', vault, '--project', proj], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('archive blocked until verify green when a task declares a sensor', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-gate-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-gatep-'));
  const spawn = (args) => spawnSync(process.execPath, [BIN, ...args, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 do it [sensor:ok]\n');
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'ok', severity: 'critical', command: 'node -e "process.exit(0)"' }] }));
    const blocked = spawn(['change', 'archive', 'x']);
    assert.equal(blocked.status, 1, 'archive blocked without evidence');
    assert.match(blocked.stderr, /BLOCKED/);
    // 0.31.0: --deep também grava o auto-verdict (agora sempre exigido pelo gate)
    initGitProject(proj);
    assert.equal(spawn(['verify', '--deep']).status, 0);
    const ok = spawn(['change', 'archive', 'x']);
    assert.equal(ok.status, 0, ok.stderr);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('archive promotes spec deltas into 07-Specs (living contract)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-spec-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-specp-'));
  const spawn = (args) => spawnSync(process.execPath, [BIN, ...args, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    initGitProject(proj);
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), '---\ntype: change\nstatus: active\nspec_impact: required\nspec_impact_reason: ""\nspecs: [auth]\n---\n# x\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 feito\n');
    mkdirSync(join(vault, '08-Mudanças', 'x', 'specs', 'auth'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requisito: Login\nusuário faz login\n');
    assert.equal(spawn(['verify', '--deep']).status, 0);
    const r = spawn(['change', 'archive', 'x']);
    assert.equal(r.status, 0, r.stderr);
    const live = readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8');
    assert.match(live, /### Requisito: Login/);
    assert.match(r.stdout, /auth/);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('warning sensor red does not block verify or archive', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-warn-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-warnp-'));
  const spawn = (args) => spawnSync(process.execPath, [BIN, ...args, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 polish [sensor:style]\n');
    // style is a RED warning sensor (exit 1) — advisory, must NOT gate.
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'style', severity: 'warning', command: 'exit 1' }] }));
    initGitProject(proj);
    assert.equal(spawn(['verify', '--deep']).status, 0, 'red warning still passes verify (--deep grava o auto-verdict)');
    const arch = spawn(['change', 'archive', 'x']);
    assert.equal(arch.status, 0, `red warning does not block archive; stderr=${arch.stderr}`);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('archive requires a verdict when a task declares [req:]; ADR lists the req id', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-verdict-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-verdictp-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    initGitProject(proj);
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeLivingRequirement(vault, 'X-1');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 faz [req:X-1]\n');
    const blocked = spawn(['change', 'archive', 'x']);
    assert.equal(blocked.status, 1, 'blocked without verdict');
    assert.match(blocked.stderr, /verdict/i);
    assert.equal(spawn(['verify', '--deep']).status, 0);
    const pkg = JSON.parse(readFileSync(join(vault, '08-Mudanças', 'x', 'verificacao.json'), 'utf8'));
    writeFileSync(join(vault, '08-Mudanças', 'x', 'verdict.json'), JSON.stringify({
      slug: 'x', ok: true, coverage: [{ req: 'X-1', covered: true }],
      tasksHash: pkg.tasksHash,
      effectiveSpecHash: pkg.effectiveSpecHash,
      evidenceEnvelopeId: pkg.evidenceEnvelopeId,
      evidenceBinding: pkg.evidenceBinding,
      notes: [],
    }));
    const ok = spawn(['change', 'archive', 'x']);
    assert.equal(ok.status, 0, ok.stderr);
    // ADR now lands in the dated month folder (04-Decisões/<year>/<MM-MMM>/) — locate it.
    const adrPath = (function find(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { const hit = find(p); if (hit) return hit; }
        else if (e.name === 'ADR-0001-x.md') return p;
      }
      return '';
    })(join(vault, '04-Decisões'));
    assert.ok(adrPath, 'ADR-0001-x.md found under 04-Decisões');
    assert.match(readFileSync(adrPath, 'utf8'), /X-1/);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('archive blocks a stale verdict when tarefas.md changed after verification (G3/#6)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-stale-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-stalep-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    mkdirSync(join(vault, '.brain'), { recursive: true });
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [] }));
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeLivingRequirement(vault, 'X-1');
    const tarefas = join(vault, '08-Mudanças', 'x', 'tarefas.md');
    writeFileSync(tarefas, '- [x] 1.1 faz [req:X-1]\n');
    initGitProject(proj);
    assert.equal(spawn(['verify', '--deep']).status, 0);
    const pkg = JSON.parse(readFileSync(join(vault, '08-Mudanças', 'x', 'verificacao.json'), 'utf8'));
    assert.ok(pkg.tasksHash, 'package carries tasksHash');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'verdict.json'), JSON.stringify({ slug: 'x', ok: true, coverage: [{ req: 'X-1', covered: true }], tasksHash: pkg.tasksHash, effectiveSpecHash: pkg.effectiveSpecHash, evidenceEnvelopeId: pkg.evidenceEnvelopeId, evidenceBinding: pkg.evidenceBinding, notes: [] }));
    // muda as tarefas depois do verdict -> stale
    writeFileSync(tarefas, '- [x] 1.1 faz [req:X-1]\n- [x] 1.2 nova\n');
    const blocked = spawn(['change', 'archive', 'x']);
    assert.equal(blocked.status, 1, 'stale verdict blocks');
    assert.match(blocked.stderr, /stale|re-verifique/i);
    // volta ao estado verificado -> passa
    writeFileSync(tarefas, '- [x] 1.1 faz [req:X-1]\n');
    assert.equal(spawn(['change', 'archive', 'x']).status, 0);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('[req:EVID-6] public archive gate rejects foreign package and verdict checkout bindings', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-binding-gate-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-binding-project-'));
  const run = (args) => spawnSync(process.execPath, [
    BIN, ...args, '--vault', vault, '--project', proj,
  ], { encoding: 'utf8' });
  const changeDir = join(vault, '08-Mudanças', 'x');
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    mkdirSync(join(vault, '.brain'), { recursive: true });
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [] }));
    assert.equal(run(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeLivingRequirement(vault, 'X-1');
    writeFileSync(join(changeDir, 'tarefas.md'), '- [x] 1.1 faz [req:X-1]\n');
    initGitProject(proj);
    const deep = run(['verify', '--deep']);
    assert.equal(deep.status, 0, deep.stderr);
    const pkgPath = join(changeDir, 'verificacao.json');
    const verdictPath = join(changeDir, 'verdict.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const validVerdict = {
      slug: 'x', ok: true, coverage: [{ req: 'X-1', covered: true }],
      tasksHash: pkg.tasksHash,
      effectiveSpecHash: pkg.effectiveSpecHash,
      evidenceEnvelopeId: pkg.evidenceEnvelopeId,
      evidenceBinding: pkg.evidenceBinding,
      notes: [],
    };
    writeFileSync(verdictPath, JSON.stringify(validVerdict));

    writeFileSync(pkgPath, JSON.stringify({
      ...pkg,
      evidenceBinding: { ...pkg.evidenceBinding, worktree_id: 'foreign-package-worktree' },
    }));
    const packageBlocked = run(['change', 'archive', 'x']);
    assert.equal(packageBlocked.status, 1, packageBlocked.stderr);
    assert.match(packageBlocked.stderr, /WENDKEEP_PROVENANCE_GATE_BLOCKED/);
    assert.match(packageBlocked.stderr, /binding|conflict|diverg/i);

    writeFileSync(pkgPath, JSON.stringify(pkg));
    writeFileSync(verdictPath, JSON.stringify({
      ...validVerdict,
      evidenceBinding: { ...pkg.evidenceBinding, worktree_id: 'foreign-verdict-worktree' },
    }));
    const verdictBlocked = run(['change', 'archive', 'x']);
    assert.equal(verdictBlocked.status, 1, verdictBlocked.stderr);
    assert.match(verdictBlocked.stderr, /WENDKEEP_PROVENANCE_GATE_BLOCKED/);
    assert.match(verdictBlocked.stderr, /binding|conflict|diverg/i);

    writeFileSync(verdictPath, JSON.stringify(validVerdict));
    const archived = run(['change', 'archive', 'x']);
    assert.equal(archived.status, 0, archived.stderr);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('archive blocks on open tasks; --force overrides (G1)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-open-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-openp-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    initGitProject(proj);
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [ ] 1.1 pendente\n- [x] 1.2 feita\n');
    assert.equal(spawn(['verify', '--deep']).status, 0);
    const blocked = spawn(['change', 'archive', 'x']);
    assert.equal(blocked.status, 1, 'open task blocks');
    assert.match(blocked.stderr, /aberta/i);
    const forced = spawn(['change', 'archive', 'x', '--force']);
    assert.equal(forced.status, 0, forced.stderr);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('[req:PROV-3] archive exige envelope v2 mesmo sem sensor e --force não ignora proveniência', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-provenance-archive-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-provenance-archive-project-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    initGitProject(proj);
    const created = spawn(['new', 'x']);
    assert.equal(created.status, 0, created.stderr);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 concluída\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'verdict.json'), JSON.stringify({ slug: 'x', ok: true, coverage: [] }));

    const blocked = spawn(['archive', 'x']);
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /WENDKEEP_PROVENANCE_GATE_BLOCKED/);
    assert.match(blocked.stderr, /unproven|envelope v2|proveni[eê]ncia/i);

    const forced = spawn(['archive', 'x', '--force']);
    assert.equal(forced.status, 1, forced.stderr);
    assert.match(forced.stderr, /WENDKEEP_PROVENANCE_GATE_BLOCKED/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('[req:PROV-2] archive recusa evidência legacy-unbound com recuperação fresca', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-provenance-legacy-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-provenance-legacy-project-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    initGitProject(proj);
    const created = spawn(['new', 'x']);
    assert.equal(created.status, 0, created.stderr);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 concluída\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'evidencia.json'), JSON.stringify([{ id: 'tests', status: 'green' }]));
    writeFileSync(join(vault, '08-Mudanças', 'x', 'verdict.json'), JSON.stringify({ slug: 'x', ok: true, coverage: [] }));

    const blocked = spawn(['archive', 'x']);
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /WENDKEEP_PROVENANCE_GATE_BLOCKED/);
    assert.match(blocked.stderr, /legacy-unbound/i);
    assert.match(blocked.stderr, /verify --deep/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('[req:PROV-1] archive aceita pacote e verdict ligados ao envelope v2 fresco', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-provenance-fresh-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-provenance-fresh-project-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    initGitProject(proj);
    const created = spawn(['change', 'new', 'x']);
    assert.equal(created.status, 0, created.stderr);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 concluída\n');
    assert.equal(spawn(['verify', '--deep']).status, 0);
    const envelope = JSON.parse(readFileSync(join(vault, '08-Mudanças', 'x', 'evidencia.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync(join(vault, '08-Mudanças', 'x', 'verificacao.json'), 'utf8'));
    const verdict = JSON.parse(readFileSync(join(vault, '08-Mudanças', 'x', 'verdict.json'), 'utf8'));
    assert.equal(envelope.schema_version, 2);
    assert.equal(pkg.evidenceEnvelopeId, envelope.envelope_id);
    assert.equal(verdict.evidenceEnvelopeId, envelope.envelope_id);

    const archived = spawn(['change', 'archive', 'x']);
    assert.equal(archived.status, 0, archived.stderr);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('[req:PROV-1] archive exige contrato v2 completo de package e verdict inclusive reqless', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-provenance-contract-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-provenance-contract-project-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    initGitProject(proj);
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 concluída\n');
    assert.equal(spawn(['verify', '--deep']).status, 0);
    const changeDir = join(vault, '08-Mudanças', 'x');
    const packagePath = join(changeDir, 'verificacao.json');
    const verdictPath = join(changeDir, 'verdict.json');
    const validPackage = JSON.parse(readFileSync(packagePath, 'utf8'));
    const validVerdict = JSON.parse(readFileSync(verdictPath, 'utf8'));
    const cases = [
      ['package.slug', packagePath, validPackage, (value) => { delete value.slug; }],
      ['package.tasksHash', packagePath, validPackage, (value) => { delete value.tasksHash; }],
      ['package.effectiveSpecHash', packagePath, validPackage, (value) => { delete value.effectiveSpecHash; }],
      ['package.evidenceEnvelopeId', packagePath, validPackage, (value) => { delete value.evidenceEnvelopeId; }],
      ['package.evidenceBinding', packagePath, validPackage, (value) => { delete value.evidenceBinding; }],
      ['package.requirements[]', packagePath, validPackage, (value) => { value.requirements = {}; }],
      ['package.tasks[]', packagePath, validPackage, (value) => { value.tasks = null; }],
      ['package.sensors[]', packagePath, validPackage, (value) => { value.sensors = 'green'; }],
      ['verdict.slug', verdictPath, validVerdict, (value) => { delete value.slug; }],
      ['verdict.tasksHash', verdictPath, validVerdict, (value) => { delete value.tasksHash; }],
      ['verdict.effectiveSpecHash', verdictPath, validVerdict, (value) => { delete value.effectiveSpecHash; }],
      ['verdict.evidenceEnvelopeId', verdictPath, validVerdict, (value) => { delete value.evidenceEnvelopeId; }],
      ['verdict.evidenceBinding', verdictPath, validVerdict, (value) => { delete value.evidenceBinding; }],
      ['verdict.coverage[]', verdictPath, validVerdict, (value) => { value.coverage = {}; }],
      ['verdict.notes[]', verdictPath, validVerdict, (value) => { value.notes = null; }],
    ];
    for (const [label, path, original, mutate] of cases) {
      writeFileSync(packagePath, JSON.stringify(validPackage));
      writeFileSync(verdictPath, JSON.stringify(validVerdict));
      const invalid = structuredClone(original);
      mutate(invalid);
      writeFileSync(path, JSON.stringify(invalid));
      const blocked = spawn(['change', 'archive', 'x', '--force']);
      assert.equal(blocked.status, 1, `${label} ausente/inválido deve bloquear: ${blocked.stderr}`);
      assert.equal(existsSync(changeDir), true, `${label} não pode mover a change`);
    }

    writeFileSync(packagePath, JSON.stringify(validPackage));
    writeFileSync(verdictPath, JSON.stringify({ ...validVerdict, notes: null }));
    const jsonBlocked = spawn(['change', 'archive', 'x', '--json']);
    assert.equal(jsonBlocked.status, 1, jsonBlocked.stderr);
    const payload = JSON.parse(jsonBlocked.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'WENDKEEP_PROVENANCE_GATE_BLOCKED');
    assert.equal(payload.operation, 'archive');
    assert.equal(payload.state, 'unproven');
    assert.ok(payload.reason_codes.includes('PROV_VERDICT_SCHEMA_INVALID'));
    assert.ok(Array.isArray(payload.diagnostics));
    assert.equal(payload.blocker, payload.diagnostics[0].blocker);
    assert.equal(payload.expected, null);
    assert.equal(payload.observed, null);
    assert.equal(payload.recovery, 'wendkeep verify --deep --change x');
    assert.equal(payload.repair.command, 'wendkeep verify --deep --change x');

    const tarefasPath = join(changeDir, 'tarefas.md');
    const authorizedTasks = readFileSync(tarefasPath, 'utf8');
    writeFileSync(tarefasPath, '- [ ] 1.1 token=ghp_private ghp_isolated npm_isolated sk-isolated Authorization: Bearer opaque-secret eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature C:\\Users\\Roger Alves\\vault.md \\\\server\\share\\vault.md /srv/wendkeep/private/vault.md\n');
    const sanitizedJson = spawn(['change', 'archive', 'x', '--json']);
    assert.equal(sanitizedJson.status, 1, sanitizedJson.stderr);
    const sanitizedPayload = JSON.parse(sanitizedJson.stdout);
    assert.equal(sanitizedPayload.code, 'WENDKEEP_PROVENANCE_GATE_BLOCKED');
    assert.equal(sanitizedPayload.operation, 'archive');
    assert.equal(sanitizedPayload.state, 'unproven');
    assert.equal(sanitizedPayload.expected, null);
    assert.equal(sanitizedPayload.observed, null);
    assert.equal(sanitizedPayload.recovery, 'wendkeep verify --deep --change x');
    assert.doesNotMatch(JSON.stringify(sanitizedPayload), /ghp_private|ghp_isolated|npm_isolated|sk-isolated|opaque-secret|eyJhbGci|Roger Alves|server\\share|srv\/wendkeep|vault\.md/);
    const sanitizedText = spawn(['change', 'archive', 'x']);
    assert.equal(sanitizedText.status, 1);
    for (const value of [sanitizedPayload.code, sanitizedPayload.operation, sanitizedPayload.state,
      sanitizedPayload.blocker, sanitizedPayload.recovery]) {
      assert.match(sanitizedText.stderr, new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(sanitizedText.stderr, /expected=null; observed=null/);
    assert.doesNotMatch(sanitizedText.stderr, /ghp_private|ghp_isolated|npm_isolated|sk-isolated|opaque-secret|eyJhbGci|Roger Alves|server\\share|srv\/wendkeep|vault\.md/);
    writeFileSync(tarefasPath, authorizedTasks);

    writeFileSync(verdictPath, JSON.stringify(validVerdict));
    assert.equal(spawn(['change', 'archive', 'x']).status, 0, 'reverify package completo fecha o gate');
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('[req:PROV-3] archive operation lock reaproveita lock cujo owner morreu e preserva BUSY para owner vivo', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-archive-owner-lock-'));
  const lockPath = join(root, 'runtime', 'change-archive-operation.lock');
  try {
    const helperUrl = new URL('../src/archive-operation-lock.mjs', import.meta.url).href;
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', [
      `import { acquireArchiveOperationLock } from ${JSON.stringify(helperUrl)};`,
      `acquireArchiveOperationLock({ lockPath: ${JSON.stringify(lockPath)} });`,
    ].join('\n')], { encoding: 'utf8' });
    assert.equal(crashed.status, 0, crashed.stderr);
    assert.equal(existsSync(lockPath), true, 'crash deixa a identidade durável do owner no lock');

    const successor = acquireArchiveOperationLock({ lockPath });
    assert.equal(successor.active, true, 'owner morto é reaped e um sucessor adquire o lock');
    assert.throws(
      () => acquireArchiveOperationLock({ lockPath }),
      (error) => error?.code === 'WENDKEEP_ARCHIVE_BUSY',
      'owner sucessor vivo continua protegido por BUSY',
    );
    successor.release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:PROV-3] crash imediatamente após publicar marker deixa lock completo e reapable', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-archive-publish-crash-'));
  const lockPath = join(root, 'runtime', 'change-archive-operation.lock');
  const sentinel = join(root, 'publish-boundary-reached');
  try {
    const helperUrl = new URL('../src/archive-operation-lock.mjs', import.meta.url).href;
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', [
      `import { writeFileSync } from 'node:fs';`,
      `import { acquireArchiveOperationLock } from ${JSON.stringify(helperUrl)};`,
      `acquireArchiveOperationLock({ lockPath: ${JSON.stringify(lockPath)}, faultInjection: {`,
      `  afterPublishRename: () => { writeFileSync(${JSON.stringify(sentinel)}, 'reached'); process.exit(0); },`,
      `} });`,
    ].join('\n')], { encoding: 'utf8' });
    assert.equal(crashed.status, 0, crashed.stderr);
    assert.equal(existsSync(sentinel), true, 'subprocess morreu na janela exata após publicação');
    const entries = readdirSync(lockPath);
    assert.equal(entries.length, 1);
    const marker = join(lockPath, entries[0]);
    assert.equal(lstatSync(marker).nlink, 1, 'marker canônico nunca depende de hardlink pendente');
    const successor = acquireArchiveOperationLock({ lockPath });
    successor.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:PROV-3] default limita falha persistente de publicação a três tentativas', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-archive-lock-deadline-'));
  const lockPath = join(root, 'runtime', 'change-archive-operation.lock');
  try {
    let attempts = 0;
    assert.throws(
      () => acquireArchiveOperationLock({
        lockPath,
        faultInjection: {
          beforePublishRename: () => {
            attempts += 1;
            const error = new Error('persistent rename failure');
            error.code = 'EACCES';
            throw error;
          },
        },
      }),
      (error) => error?.code === 'WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE',
    );
    assert.equal(attempts, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:PROV-3] release nunca apaga lock sucessor substituído após a última checagem', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wk-archive-release-replace-'));
  const lockPath = join(root, 'runtime', 'change-archive-operation.lock');
  let successor;
  let replacementUnsupported = false;
  try {
    const owner = acquireArchiveOperationLock({
      lockPath,
      faultInjection: {
        beforeReleaseCommit: () => {
          try {
            rmSync(lockPath, { recursive: true, force: true });
          } catch (error) {
            if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) throw error;
            replacementUnsupported = true;
            throw error;
          }
          successor = acquireArchiveOperationLock({ lockPath });
        },
      },
    });
    assert.throws(
      () => owner.release(),
      (error) => error?.code === 'WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST',
    );
    if (replacementUnsupported) {
      t.skip('runtime Windows não permite substituir marker enquanto o descritor está aberto');
      return;
    }
    assert.equal(successor?.active, true, 'replacement volta ao path canônico e não é apagado');
    assert.throws(
      () => acquireArchiveOperationLock({ lockPath }),
      (error) => error?.code === 'WENDKEEP_ARCHIVE_BUSY',
    );
    successor.release();
  } finally {
    try { successor?.release(); } catch { /* cleanup best effort */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:PROV-3] boundary mutante detecta unlink e replacement físico do operation lock', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wk-archive-boundary-replace-'));
  const lockPath = join(root, 'runtime', 'change-archive-operation.lock');
  let owner;
  let successor;
  try {
    owner = acquireArchiveOperationLock({ lockPath });
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) throw error;
      try { owner.release(); } catch { /* partial rm already invalidated ownership */ }
      owner = undefined;
      t.skip('runtime Windows não permite substituir marker enquanto o descritor está aberto');
      return;
    }
    successor = acquireArchiveOperationLock({ lockPath });
    assert.throws(
      () => owner.assertOwned(),
      (error) => error?.code === 'WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST',
    );
    assert.equal(successor.active, true);
    successor.release();
  } finally {
    try { owner?.release(); } catch { /* cleanup best effort */ }
    try { successor?.release(); } catch { /* cleanup best effort */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:PROV-3] consumer não injeta replacement de lock no CLI produtivo', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-archive-release-json-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-archive-release-json-project-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    initGitProject(proj);
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 concluída\n');
    assert.equal(spawn(['verify', '--deep', '--change', 'x']).status, 0);

    const changeUrl = new URL('../src/change.mjs', import.meta.url).href;
    const lockUrl = new URL('../src/archive-operation-lock.mjs', import.meta.url).href;
    const driver = [
      `import { rmSync } from 'node:fs';`,
      `import { runChange } from ${JSON.stringify(changeUrl)};`,
      `import { acquireArchiveOperationLock } from ${JSON.stringify(lockUrl)};`,
      `runChange(['archive', 'x', '--json', '--vault', ${JSON.stringify(vault)}, '--project', ${JSON.stringify(proj)}], {`,
      `  archiveLockFactory: (args) => acquireArchiveOperationLock({ ...args, faultInjection: {`,
      `    beforeReleaseCommit: ({ lockPath }) => {`,
      `      rmSync(lockPath, { recursive: true, force: true });`,
      `      acquireArchiveOperationLock({ lockPath });`,
      `    },`,
      `  } }),`,
      `});`,
    ].join('\n');
    const released = spawnSync(process.execPath, ['--input-type=module', '-e', driver], { encoding: 'utf8' });
    assert.equal(released.status, 0, released.stderr);
    const payload = JSON.parse(released.stdout);
    assert.equal(payload.code, 'WENDKEEP_CHANGE_ARCHIVED');
    assert.equal(payload.operation, 'archive');
    assert.equal(payload.state, 'verified');
    assert.equal(existsSync(join(vault, '08-Mudanças', 'x')), false);
    assert.equal(existsSync(join(vault, '08-Mudanças', '_arquivo')), true);
    assert.equal(existsSync(join(vault, '.brain', 'runtime', 'change-archive-operation.lock')), false,
      'factory injetada foi ignorada e nenhum successor foi criado');
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('[req:PROV-3] consumer não injeta finalizer falso no CLI produtivo', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-archive-cleanup-json-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-archive-cleanup-json-project-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    initGitProject(proj);
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 concluída\n');
    assert.equal(spawn(['verify', '--deep', '--change', 'x']).status, 0);
    const changeUrl = new URL('../src/change.mjs', import.meta.url).href;
    const driver = [
      `import { runChange } from ${JSON.stringify(changeUrl)};`,
      `runChange(['archive', 'x', '--json', '--vault', ${JSON.stringify(vault)}, '--project', ${JSON.stringify(proj)}], {`,
      `  archiveTransactionFinalizer: () => {`,
      `    const error = new Error('cleanup fault'); error.code = 'PROV_ARCHIVE_TRANSACTION_CLEANUP_FAILED'; throw error;`,
      `  },`,
      `});`,
    ].join('\n');
    const failed = spawnSync(process.execPath, ['--input-type=module', '-e', driver], { encoding: 'utf8' });
    assert.equal(failed.status, 0, failed.stderr);
    const payload = JSON.parse(failed.stdout);
    assert.equal(payload.code, 'WENDKEEP_CHANGE_ARCHIVED');
    assert.equal(payload.state, 'verified');
    const transactions = join(vault, '.brain', 'runtime', 'archive-transactions');
    const retained = readdirSync(transactions);
    assert.equal(retained.length, 1);
    const manifest = JSON.parse(readFileSync(join(transactions, retained[0], 'archive-transaction.json'), 'utf8'));
    assert.equal(manifest.phase, 'completed');
    assert.equal(existsSync(join(transactions, retained[0], 'original')), true);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('[req:PROV-3] recriação pública após completed impede sucesso e preserva os dois estados', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-archive-final-source-race-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-archive-final-source-race-project-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    initGitProject(proj);
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 concluída\n');
    assert.equal(spawn(['verify', '--deep', '--change', 'x']).status, 0);
    const preload = join(vault, 'recreate-source.mjs');
    writeFileSync(preload, [
      `import fs from 'node:fs';`,
      `import path from 'node:path';`,
      `import { syncBuiltinESMExports } from 'node:module';`,
      `const originalRead = fs.readFileSync; let recreated = false;`,
      `fs.readFileSync = function(target, ...args) {`,
      `  const value = originalRead.call(this, target, ...args);`,
      `  if (!recreated && String(target).endsWith('archive-transaction.json') && String(value).includes('"phase":"completed"')) {`,
      `    recreated = true; const source = ${JSON.stringify(join(vault, '08-Mudanças', 'x'))};`,
      `    fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(path.join(source, 'concurrent.txt'), 'CONCURRENT\\n');`,
      `  }`,
      `  return value;`,
      `};`,
      `syncBuiltinESMExports();`,
    ].join('\n'));
    const result = spawnSync(process.execPath, [
      '--import', pathToFileURL(preload).href, BIN, 'change', 'archive', 'x', '--json',
      '--vault', vault, '--project', proj,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.code, 'PROV_ARCHIVE_PUBLIC_NAMESPACE_RECREATED');
    assert.equal(payload.observed.publication_state, 'published-recovery-required');
    assert.equal(payload.observed.transaction_phase, 'completed');
    assert.equal(readFileSync(join(vault, '08-Mudanças', 'x', 'concurrent.txt'), 'utf8'), 'CONCURRENT\n');
    assert.equal(existsSync(join(vault, '08-Mudanças', '_arquivo')), true);
    const operationId = payload.observed.operation_id;
    assert.equal(existsSync(join(vault, '.brain', 'runtime', 'archive-transactions', operationId, 'original')), true);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('[req:PROV-8] recover inválido sanitiza slug, bearer, JWT e UNC em JSON e texto', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-archive-recover-sanitize-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-archive-recover-sanitize-project-'));
  const sensitiveSlug = 'Authorization: Bearer opaque-secret eyJhbGciOiJIUzI1NiJ9.payload.signature \\\\server\\share\\vault';
  const spawn = (json) => spawnSync(process.execPath, [BIN, 'change', 'archive', 'recover', 'invalid-operation',
    '--change', sensitiveSlug, ...(json ? ['--json'] : []), '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    const json = spawn(true);
    assert.equal(json.status, 1);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.operation, 'archive-recover');
    assert.doesNotMatch(JSON.stringify(payload), /opaque-secret|eyJhbGci|server\\share|vault/i);
    const text = spawn(false);
    assert.equal(text.status, 1);
    assert.doesNotMatch(text.stderr, /opaque-secret|eyJhbGci|server\\share|vault/i);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('[req:PROV-8] recover --spec-action converge promoção parcial sob lock real', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-archive-recover-spec-cli-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-archive-recover-spec-cli-project-'));
  try {
    const living = join(vault, '07-Specs');
    mkdirSync(living, { recursive: true });
    writeFileSync(join(living, 'auth.md'), '### Requisito: AUTH-1 — auth\nAUTH-OLD\n');
    writeFileSync(join(living, 'billing.md'), '### Requisito: BILL-1 — billing\nBILL-OLD\n');
    const change = join(vault, '08-Mudanças', '_arquivo', '2026-08-23-x');
    for (const [capability, id] of [['auth', 'AUTH-1'], ['billing', 'BILL-1']]) {
      mkdirSync(join(change, 'specs', capability), { recursive: true });
      writeFileSync(join(change, 'specs', capability, 'spec.md'),
        `## MODIFIED Requirements\n### Requisito: ${id} — ${capability}\n${capability.toUpperCase()}-NEW\n`);
    }
    const { plan } = buildSpecPromotionPlan(vault, change, ['auth', 'billing'], {
      recoveryRoot: join(vault, '.brain', 'runtime', 'archive-transactions', '33333333-3333-4333-8333-333333333333'),
      changeWikilink: '[[08-Mudanças/_arquivo/2026-08-23-x/proposta]]',
      dateStr: '2026-08-23',
    });
    writeFileSync(join(change, '.spec-base.json'), `${JSON.stringify({
      version: 1,
      specs: Object.fromEntries(plan.entries.filter((entry) => entry.kind === 'capability')
        .map((entry) => [entry.capability, { hash: entry.before.digest.slice(7), requirements: {} }])),
    })}\n`);
    const first = plan.entries.find((entry) => entry.capability === 'auth');
    writeFileSync(join(vault, first.target), Buffer.from(first.after.content_base64, 'base64').toString('utf8'));
    assert.match(readFileSync(join(living, 'auth.md'), 'utf8'), /AUTH-NEW/);
    assert.match(readFileSync(join(living, 'billing.md'), 'utf8'), /BILL-OLD/);
    const operationId = '33333333-3333-4333-8333-333333333333';
    const transaction = join(vault, '.brain', 'runtime', 'archive-transactions', operationId);
    mkdirSync(join(transaction, 'original'), { recursive: true });
    writeFileSync(join(transaction, 'original', 'tarefas.md'), 'retido\n');
    writeFileSync(join(transaction, 'archive-transaction.json'), `${JSON.stringify({
      schema_version: 1,
      operation: 'archive',
      operation_id: operationId,
      change_slug: 'x',
      phase: 'promotion-prepared',
      source_digest: `sha256:${'a'.repeat(64)}`,
      destination_rel: '08-Mudanças/_arquivo/2026-08-23-x',
      destination_digest: archiveSourceDigest(change),
      spec_promotion_plan: plan,
      spec_changes: plan.changes,
      spec_promotion_state: 'prepared',
    })}\n`);
    const recovered = spawnSync(process.execPath, [BIN, 'change', 'archive', 'recover', operationId,
      '--change', 'x', '--spec-action', 'rollback', '--json', '--vault', vault, '--project', proj], { encoding: 'utf8' });
    assert.equal(recovered.status, 1, recovered.stderr);
    const payload = JSON.parse(recovered.stdout);
    assert.equal(payload.spec_promotion_state, 'rolled-back');
    assert.equal('changes' in payload, false, 'serializer não devolve plan.changes cru');
    assert.doesNotMatch(JSON.stringify(payload), /content_base64|07-Specs|archive-transactions|AUTH-(?:OLD|NEW)/);
    assert.match(readFileSync(join(living, 'auth.md'), 'utf8'), /AUTH-OLD/);
    assert.match(readFileSync(join(living, 'billing.md'), 'utf8'), /BILL-OLD/);
    const manifest = JSON.parse(readFileSync(join(transaction, 'archive-transaction.json'), 'utf8'));
    assert.equal(manifest.phase, 'recovery-required');
    assert.equal(manifest.spec_promotion_state, 'rolled-back');
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('[req:PROV-3] recover rejeita journal que redireciona target, claim ou candidate', async (t) => {
  const attacks = [
    ['CORE target', 'target', '.brain/CORE.md'],
    ['SESSION_REGISTRY target', 'target', '.brain/SESSION_REGISTRY.json'],
    ['arquivo privado target', 'target', '08-Mudanças/_arquivo/2026-08-23-x/private.md'],
    ['CORE claim', 'claim_target', '.brain/CORE.md'],
    ['CORE candidate', 'candidate_target', '.brain/CORE.md'],
    ['traversal target', 'target', '../outside.txt'],
  ];
  for (let attackIndex = 0; attackIndex < attacks.length; attackIndex += 1) {
    const [name, field, maliciousRel] = attacks[attackIndex];
    await t.test(name, () => {
      const vault = mkdtempSync(join(tmpdir(), 'wk-archive-recover-tamper-'));
      const proj = mkdtempSync(join(tmpdir(), 'wk-archive-recover-tamper-project-'));
      const operationId = `9${String(attackIndex).repeat(7)}-9000-4000-8000-${String(attackIndex).repeat(12)}`;
      const spawn = (args) => spawnSync(process.execPath, [BIN, ...args, '--vault', vault, '--project', proj], { encoding: 'utf8' });
      try {
        const living = join(vault, '07-Specs');
        mkdirSync(living, { recursive: true });
        writeFileSync(join(living, 'auth.md'), '### Requisito: AUTH-1 — auth\nAUTH-OLD\n');
        const archived = join(vault, '08-Mudanças', '_arquivo', '2026-08-23-x');
        mkdirSync(join(archived, 'specs', 'auth'), { recursive: true });
        writeFileSync(join(archived, 'specs', 'auth', 'spec.md'),
          '## MODIFIED Requirements\n### Requisito: AUTH-1 — auth\nAUTH-NEW\n');
        const transaction = join(vault, '.brain', 'runtime', 'archive-transactions', operationId);
        const { plan } = buildSpecPromotionPlan(vault, archived, ['auth'], {
          recoveryRoot: transaction,
          changeWikilink: '[[08-Mudanças/_arquivo/2026-08-23-x/proposta]]',
          dateStr: '2026-08-23',
        });
        const entry = plan.entries.find((candidate) => candidate.capability === 'auth');
        writeFileSync(join(archived, '.spec-base.json'), `${JSON.stringify({
          version: 1,
          specs: { auth: { hash: entry.before.digest.slice(7), requirements: {} } },
        })}\n`);
        const malicious = resolve(vault, maliciousRel);
        mkdirSync(dirname(malicious), { recursive: true });
        const protectedContent = field === 'claim_target'
          ? Buffer.from(entry.before.content_base64, 'base64').toString('utf8')
          : field === 'candidate_target'
            ? Buffer.from(entry.after.content_base64, 'base64').toString('utf8')
            : 'PROTECTED\n';
        writeFileSync(malicious, protectedContent);
        entry[field] = maliciousRel.replaceAll('\\', '/');
        if (field === 'target') {
          const image = (content) => ({
            exists: true,
            content_base64: Buffer.from(content).toString('base64'),
            digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
          });
          entry.before = image(protectedContent);
          entry.after = image('ATTACKER-CONTENT\n');
          plan.changes[0].before_digest = entry.before.digest;
          plan.changes[0].after_digest = entry.after.digest;
        }
        mkdirSync(join(transaction, 'original'), { recursive: true });
        writeFileSync(join(transaction, 'original', 'tarefas.md'), 'retido\n');
        writeFileSync(join(transaction, 'archive-transaction.json'), `${JSON.stringify({
          schema_version: 1,
          operation: 'archive',
          operation_id: operationId,
          change_slug: 'x',
          phase: 'promotion-prepared',
          source_digest: `sha256:${'a'.repeat(64)}`,
          destination_rel: '08-Mudanças/_arquivo/2026-08-23-x',
          destination_digest: archiveSourceDigest(archived),
          spec_promotion_plan: plan,
          spec_changes: plan.changes,
          spec_promotion_state: 'prepared',
        })}\n`);
        const result = spawn(['change', 'archive', 'recover', operationId, '--change', 'x',
          '--spec-action', 'resume', '--json']);
        assert.equal(result.status, 1, result.stderr);
        const payload = JSON.parse(result.stdout);
        assert.equal(payload.code, 'PROV_SPEC_PROMOTION_PLAN_INVALID', JSON.stringify(payload));
        assert.equal(readFileSync(malicious, 'utf8'), protectedContent, 'arquivo fora da whitelist permanece intacto');
        assert.doesNotMatch(JSON.stringify(payload), /CORE\.md|SESSION_REGISTRY|private\.md|outside\.txt|PROTECTED|ATTACKER/);
        if (attackIndex === 0) {
          const text = spawn(['change', 'archive', 'recover', operationId, '--change', 'x',
            '--spec-action', 'resume']);
          assert.equal(text.status, 1);
          for (const value of [payload.code, payload.operation, payload.state, payload.blocker]) {
            assert.match(text.stderr, new RegExp(String(value)));
          }
          assert.doesNotMatch(text.stderr, /CORE\.md|content_base64|07-Specs|archive-transactions|PROTECTED|ATTACKER/);
        }
      } finally {
        rmSync(vault, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
      }
    });
  }
});

test('[req:PROV-3] recover rederiva conjunto, imagens e metadata completos do archive', async (t) => {
  const mutations = [
    ['state ausente', ({ plan }) => { plan.entries = plan.entries.filter((entry) => entry.kind !== 'state'); }],
    ['README ausente', ({ plan }) => { plan.entries = plan.entries.filter((entry) => entry.kind !== 'readme'); }],
    ['capability duplicada', ({ plan }) => { plan.entries.splice(1, 0, structuredClone(plan.entries[0])); }],
    ['capability inválida', ({ plan }) => { plan.entries[0].capability = '../CORE'; }],
    ['digest da imagem divergente', ({ plan }) => { plan.entries[0].after.digest = `sha256:${'0'.repeat(64)}`; }],
    ['base64 não canônico', ({ plan }) => { plan.entries[0].after.content_base64 += '='; }],
    ['changes não derivados', ({ plan }) => { plan.changes[0].after_digest = `sha256:${'1'.repeat(64)}`; }],
    ['state postimage não derivada', ({ plan }) => {
      const state = plan.entries.find((entry) => entry.kind === 'state');
      const content = `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), specs: {} }, null, 2)}\n`;
      state.after.content_base64 = Buffer.from(content).toString('base64');
      state.after.digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    }],
    ['README before-image autoafirmada', ({ plan }) => {
      const readme = plan.entries.find((entry) => entry.kind === 'readme');
      const content = 'README CONTROLADO PELO JOURNAL\n';
      readme.before.exists = true;
      readme.before.content_base64 = Buffer.from(content).toString('base64');
      readme.before.digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    }],
    ['delta e plano coerentes divergem do archive publicado', ({ manifest, archived, transaction, vault }) => {
      writeFileSync(join(archived, 'specs', 'auth', 'spec.md'),
        '## MODIFIED Requirements\n### Requisito: AUTH-1 — auth\nAUTH-ATTACKER\n');
      const baselinePath = join(archived, '.spec-base.json');
      const baseline = readFileSync(baselinePath, 'utf8');
      captureSpecBaseline(vault, archived, { refresh: true });
      const rebuilt = buildSpecPromotionPlan(vault, archived, ['auth'], {
        recoveryRoot: transaction,
        changeWikilink: '[[08-Mudanças/_arquivo/2026-08-23-x/proposta]]',
        dateStr: '2026-08-23',
      });
      writeFileSync(baselinePath, baseline);
      manifest.spec_promotion_plan = rebuilt.plan;
      manifest.spec_changes = rebuilt.plan.changes;
    }],
    ['destination sem binding do slug', ({ manifest }) => { manifest.destination_rel = '08-Mudanças/_arquivo/2026-08-23-y'; }],
  ];
  for (let index = 0; index < mutations.length; index += 1) {
    const [name, mutate] = mutations[index];
    await t.test(name, () => {
      const vault = mkdtempSync(join(tmpdir(), 'wk-archive-recover-schema-'));
      const proj = mkdtempSync(join(tmpdir(), 'wk-archive-recover-schema-project-'));
      const digit = String(index % 10);
      const operationId = `8${digit.repeat(7)}-8000-4000-8000-${digit.repeat(12)}`;
      const spawn = (args) => spawnSync(process.execPath, [BIN, ...args, '--vault', vault, '--project', proj], { encoding: 'utf8' });
      try {
        mkdirSync(join(vault, '07-Specs'), { recursive: true });
        const original = '### Requisito: AUTH-1 — auth\nAUTH-OLD\n';
        writeFileSync(join(vault, '07-Specs', 'auth.md'), original);
        const archived = join(vault, '08-Mudanças', '_arquivo', '2026-08-23-x');
        mkdirSync(join(archived, 'specs', 'auth'), { recursive: true });
        writeFileSync(join(archived, 'specs', 'auth', 'spec.md'),
          '## MODIFIED Requirements\n### Requisito: AUTH-1 — auth\nAUTH-NEW\n');
        const transaction = join(vault, '.brain', 'runtime', 'archive-transactions', operationId);
        const { plan } = buildSpecPromotionPlan(vault, archived, ['auth'], {
          recoveryRoot: transaction,
          changeWikilink: '[[08-Mudanças/_arquivo/2026-08-23-x/proposta]]',
          dateStr: '2026-08-23',
        });
        writeFileSync(join(archived, '.spec-base.json'), `${JSON.stringify({
          version: 1,
          specs: { auth: { hash: plan.entries[0].before.digest.slice(7), requirements: {} } },
        })}\n`);
        const manifest = {
          schema_version: 1,
          operation: 'archive',
          operation_id: operationId,
          change_slug: 'x',
          phase: 'promotion-prepared',
          source_digest: `sha256:${'a'.repeat(64)}`,
          destination_rel: '08-Mudanças/_arquivo/2026-08-23-x',
          destination_digest: archiveSourceDigest(archived),
          spec_promotion_plan: plan,
          spec_changes: plan.changes,
          spec_promotion_state: 'prepared',
        };
        mutate({ plan, manifest, archived, transaction, vault });
        mkdirSync(join(transaction, 'original'), { recursive: true });
        writeFileSync(join(transaction, 'original', 'tarefas.md'), 'retido\n');
        writeFileSync(join(transaction, 'archive-transaction.json'), `${JSON.stringify(manifest)}\n`);
        const result = spawn(['change', 'archive', 'recover', operationId, '--change', 'x',
          '--spec-action', 'resume', '--json']);
        assert.equal(result.status, 1, result.stderr);
        const payload = JSON.parse(result.stdout);
        assert.equal(payload.code, 'PROV_SPEC_PROMOTION_PLAN_INVALID', JSON.stringify(payload));
        assert.equal(readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8'), original);
        assert.doesNotMatch(JSON.stringify(payload), /content_base64|07-Specs|archive-transactions|AUTH-(?:OLD|NEW)/);
      } finally {
        rmSync(vault, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
      }
    });
  }
});

test('[req:PROV-3] candidate canônico por hardlink nunca apaga arquivo privado', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-archive-recover-hardlink-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-archive-recover-hardlink-project-'));
  const operationId = '77777777-7777-4777-8777-777777777777';
  const spawn = (args) => spawnSync(process.execPath, [BIN, ...args, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '07-Specs'), { recursive: true });
    writeFileSync(join(vault, '07-Specs', 'auth.md'), '### Requisito: AUTH-1 — auth\nAUTH-OLD\n');
    const archived = join(vault, '08-Mudanças', '_arquivo', '2026-08-23-x');
    mkdirSync(join(archived, 'specs', 'auth'), { recursive: true });
    writeFileSync(join(archived, 'specs', 'auth', 'spec.md'),
      '## MODIFIED Requirements\n### Requisito: AUTH-1 — auth\nAUTH-NEW\n');
    const transaction = join(vault, '.brain', 'runtime', 'archive-transactions', operationId);
    const { plan } = buildSpecPromotionPlan(vault, archived, ['auth'], {
      recoveryRoot: transaction,
      changeWikilink: '[[08-Mudanças/_arquivo/2026-08-23-x/proposta]]',
      dateStr: '2026-08-23',
    });
    const entry = plan.entries[0];
    writeFileSync(join(archived, '.spec-base.json'), `${JSON.stringify({
      version: 1, specs: { auth: { hash: entry.before.digest.slice(7), requirements: {} } },
    })}\n`);
    mkdirSync(transaction, { recursive: true });
    const core = join(vault, '.brain', 'CORE.md');
    mkdirSync(dirname(core), { recursive: true });
    const protectedContent = Buffer.from(entry.after.content_base64, 'base64').toString('utf8');
    writeFileSync(core, protectedContent);
    linkSync(core, join(vault, entry.candidate_target));
    mkdirSync(join(transaction, 'original'), { recursive: true });
    writeFileSync(join(transaction, 'original', 'tarefas.md'), 'retido\n');
    writeFileSync(join(transaction, 'archive-transaction.json'), `${JSON.stringify({
      schema_version: 1,
      operation: 'archive',
      operation_id: operationId,
      change_slug: 'x',
      phase: 'promotion-prepared',
      source_digest: `sha256:${'a'.repeat(64)}`,
      destination_rel: '08-Mudanças/_arquivo/2026-08-23-x',
      destination_digest: archiveSourceDigest(archived),
      spec_promotion_plan: plan,
      spec_changes: plan.changes,
      spec_promotion_state: 'prepared',
    })}\n`);
    const result = spawn(['change', 'archive', 'recover', operationId, '--change', 'x',
      '--spec-action', 'resume', '--json']);
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.code, 'PROV_SPEC_PROMOTION_RECOVERY_CONFLICT');
    assert.equal(readFileSync(core, 'utf8'), protectedContent);
    assert.equal(lstatSync(core).nlink, 2, 'alias suspeito permanece para recovery manual, sem unlink destrutivo');
    assert.doesNotMatch(JSON.stringify(payload), /CORE\.md|content_base64|07-Specs|archive-transactions|AUTH-(?:OLD|NEW)/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('[req:PROV-3] subprocess crash real preserva plano e recovery CLI converge por CAS', async (t) => {
  for (const crash of [
    { name: 'após primeira capability', mode: 'after-candidate-unlink', status: 88, action: 'rollback' },
    { name: 'entre hardlink e unlink do candidate', mode: 'after-candidate-link', status: 89, action: 'resume' },
    { name: 'writer por handle pré-aberto altera o inode reclamado', mode: 'open-handle-writer', status: 1, action: null },
    { name: 'perda física do lock entre claim e commit', mode: 'lose-lock-after-claim', status: 1, action: null, lockLoss: true },
  ]) {
    await t.test(crash.name, () => {
      const vault = mkdtempSync(join(tmpdir(), 'wk-archive-real-crash-'));
      const proj = mkdtempSync(join(tmpdir(), 'wk-archive-real-crash-project-'));
      const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
      try {
        initGitProject(proj);
        mkdirSync(join(vault, '07-Specs'), { recursive: true });
        for (const [capability, id] of [['auth', 'AUTH-1'], ['billing', 'BILL-1']]) {
          writeFileSync(join(vault, '07-Specs', `${capability}.md`),
            `### Requisito: ${id} — ${capability}\n${capability.toUpperCase()}-OLD\n`);
        }
        assert.equal(spawn(['change', 'new', 'x']).status, 0);
        const changeDir = join(vault, '08-Mudanças', 'x');
        writeFileSync(join(changeDir, 'proposta.md'), [
          '---', 'type: change', 'status: active', 'spec_impact: required',
          'spec_impact_reason: "contrato"', 'specs: [auth, billing]', '---', '# x', '',
        ].join('\n'));
        writeFileSync(join(changeDir, 'design.md'), '# x — design\n\n## Abordagem\n\nTeste.\n');
        writeFileSync(join(changeDir, 'tarefas.md'), '- [x] 1.1 concluída\n');
        for (const [capability, id] of [['auth', 'AUTH-1'], ['billing', 'BILL-1']]) {
          mkdirSync(join(changeDir, 'specs', capability), { recursive: true });
          writeFileSync(join(changeDir, 'specs', capability, 'spec.md'),
            `## MODIFIED Requirements\n### Requisito: ${id} — ${capability}\n${capability.toUpperCase()}-NEW\n`);
        }
        assert.equal(spawn(['verify', '--deep', '--change', 'x']).status, 0);

        const preload = join(vault, 'crash-fs.mjs');
        writeFileSync(preload, [
          `import fs from 'node:fs';`,
          `import { syncBuiltinESMExports } from 'node:module';`,
          `const mode = process.env.WK_TEST_CRASH_MODE;`,
          `const originalLink = fs.linkSync; const originalUnlink = fs.unlinkSync; const originalRename = fs.renameSync;`,
          `fs.renameSync = function(source, target) {`,
          `  const capabilityClaim = /[\\\\/]07-Specs[\\\\/]auth\\.md$/i.test(String(source)) && String(target).endsWith('.before');`,
          `  const intercept = mode === 'open-handle-writer' && capabilityClaim;`,
          `  const fd = intercept ? fs.openSync(source, 'r+') : null;`,
          `  const result = originalRename.call(this, source, target);`,
          `  if (intercept) { fs.writeSync(fd, Buffer.from('HANDLE-THIRD\\n'), 0, 13, 0); fs.fsyncSync(fd); fs.closeSync(fd); }`,
          `  if (mode === 'lose-lock-after-claim' && capabilityClaim) fs.rmSync(${JSON.stringify(join(vault, '.brain', 'runtime', 'change-archive-operation.lock'))}, { recursive: true, force: true });`,
          `  return result;`,
          `};`,
          `fs.linkSync = function(source, target) {`,
          `  const result = originalLink.call(this, source, target);`,
          `  if (mode === 'after-candidate-link' && String(source).endsWith('.candidate')) process.exit(89);`,
          `  return result;`,
          `};`,
          `fs.unlinkSync = function(target) {`,
          `  const candidate = String(target).endsWith('.candidate');`,
          `  const result = originalUnlink.call(this, target);`,
          `  if (mode === 'after-candidate-unlink' && candidate) process.exit(88);`,
          `  return result;`,
          `};`,
          `syncBuiltinESMExports();`,
        ].join('\n'));
        const archived = spawnSync(process.execPath, [
          '--import', pathToFileURL(preload).href, BIN, 'change', 'archive', 'x', '--json',
          '--vault', vault, '--project', proj,
        ], { encoding: 'utf8', env: { ...process.env, WK_TEST_CRASH_MODE: crash.mode } });
        assert.equal(archived.status, crash.status, `${archived.stderr}\n${archived.stdout}`);

        const transactionRoot = join(vault, '.brain', 'runtime', 'archive-transactions');
        const operationId = readdirSync(transactionRoot)[0];
        const manifestPath = join(transactionRoot, operationId, 'archive-transaction.json');
        const prepared = JSON.parse(readFileSync(manifestPath, 'utf8'));
        assert.equal(prepared.phase, crash.action || crash.lockLoss ? 'promotion-prepared' : 'recovery-required');
        assert.equal(prepared.spec_promotion_plan.schema_version, 1);
        assert.equal(prepared.spec_promotion_plan.entries.length >= 4, true);
        const authEntry = prepared.spec_promotion_plan.entries.find((entry) => entry.capability === 'auth');
        if (!crash.action) {
          if (crash.lockLoss) {
            const payload = JSON.parse(archived.stdout);
            assert.equal(payload.code, 'WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST');
            assert.equal(payload.observed.publication_state, 'published-recovery-required');
            assert.equal(payload.observed.transaction_phase, 'promotion-prepared');
            assert.equal(existsSync(join(vault, authEntry.candidate_target)), false,
              'ownership é revalidada antes de publicar candidate');
            assert.equal(existsSync(join(vault, '08-Mudanças', 'x')), false);
            return;
          }
          assert.equal(prepared.blocker, 'PROV_SPEC_PROMOTION_ATOMIC_FAILED');
          assert.match(Buffer.from(authEntry.before.content_base64, 'base64').toString('utf8'), /AUTH-OLD/,
            'before-image autorizada permanece durável no journal');
          const possibleGenerations = [join(vault, authEntry.target), join(vault, authEntry.claim_target),
            ...readdirSync(join(transactionRoot, operationId)).map((name) => join(transactionRoot, operationId, name))];
          assert.equal(possibleGenerations.some((path) => {
            try { return /HANDLE-THIRD/.test(readFileSync(path, 'utf8')); } catch { return false; }
          }), true, 'bytes concorrentes permanecem em uma geração recuperável');
          assert.equal(existsSync(join(vault, '08-Mudanças', 'x')), false,
            'falha pós-publicação não inventa rollback do namespace público');
          return;
        }
        if (crash.status === 89) {
          const candidate = join(vault, authEntry.candidate_target);
          assert.equal(existsSync(candidate), true);
          assert.equal(lstatSync(candidate).nlink, 2);
        }

        const recovered = spawn(['change', 'archive', 'recover', operationId, '--change', 'x',
          '--spec-action', crash.action, '--json']);
        assert.equal(recovered.status, 1, recovered.stderr);
        const payload = JSON.parse(recovered.stdout);
        assert.equal(payload.spec_promotion_state, crash.action === 'resume' ? 'resumed' : 'rolled-back');
        const expected = crash.action === 'resume' ? /AUTH-NEW/ : /AUTH-OLD/;
        assert.match(readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8'), expected);
        assert.match(readFileSync(join(vault, '07-Specs', 'billing.md'), 'utf8'),
          crash.action === 'resume' ? /BILLING-NEW/ : /BILLING-OLD/);
      } finally {
        rmSync(vault, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
      }
    });
  }
});

test('[req:PROV-3] tarball/API não expõem mutadores de archive, recovery ou promoção', () => {
  const probe = [
    `const [change, core, spec] = await Promise.all([`,
    `  import(${JSON.stringify(new URL('../src/change.mjs', import.meta.url).href)}),`,
    `  import(${JSON.stringify(new URL('../hooks/change-core.mjs', import.meta.url).href)}),`,
    `  import(${JSON.stringify(new URL('../hooks/spec-core.mjs', import.meta.url).href)}),`,
    `]);`,
    `const forbidden = ['archiveChange', 'archiveChangeMutation', 'recoverArchiveSpecPromotion', 'applySpecPromotionPlan', 'promoteSpecs'];`,
    `for (const name of forbidden) {`,
    `  if (name in change || name in core || name in spec) throw new Error('forbidden export: ' + name);`,
    `}`,
    `if (Object.keys(change).join(',') !== 'runChange') throw new Error('unexpected change API: ' + Object.keys(change));`,
  ].join('\n');
  const api = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
  assert.equal(api.status, 0, api.stderr);

  const packed = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd pack --dry-run --json --ignore-scripts'], {
      cwd: dirname(dirname(BIN)), encoding: 'utf8', shell: false,
    })
    : spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: dirname(dirname(BIN)), encoding: 'utf8', shell: false,
    });
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map((entry) => entry.path.replaceAll('\\', '/'));
  assert.equal(files.includes('packages/private/archive-authority.mjs'), false);
});

test('[req:PROV-3] consumer não injeta fault seam entre receipt e primeira mutação', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-archive-boundary-json-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-archive-boundary-json-project-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    initGitProject(proj);
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 concluída\n');
    assert.equal(spawn(['verify', '--deep', '--change', 'x']).status, 0);

    const changeUrl = new URL('../src/change.mjs', import.meta.url).href;
    const lockUrl = new URL('../src/archive-operation-lock.mjs', import.meta.url).href;
    const driver = [
      `import { rmSync } from 'node:fs';`,
      `import { runChange } from ${JSON.stringify(changeUrl)};`,
      `import { acquireArchiveOperationLock } from ${JSON.stringify(lockUrl)};`,
      `let replaced = false; let successor;`,
      `runChange(['archive', 'x', '--json', '--vault', ${JSON.stringify(vault)}, '--project', ${JSON.stringify(proj)}], {`,
      `  archiveLockFactory: acquireArchiveOperationLock,`,
      `  archiveLockFaultInjection: { afterAssertOwned: ({ count, lockPath }) => {`,
      `    if (!replaced && count === 4) {`,
      `      replaced = true; rmSync(lockPath, { recursive: true, force: true });`,
      `      successor = acquireArchiveOperationLock({ lockPath });`,
      `    }`,
      `  } },`,
      `});`,
    ].join('\n');
    const replaced = spawnSync(process.execPath, ['--input-type=module', '-e', driver], { encoding: 'utf8' });
    assert.equal(replaced.status, 0, replaced.stderr);
    const payload = JSON.parse(replaced.stdout);
    assert.equal(payload.code, 'WENDKEEP_CHANGE_ARCHIVED');
    assert.equal(payload.state, 'verified');
    assert.equal(existsSync(join(vault, '08-Mudanças', 'x')), false);
    assert.equal(existsSync(join(vault, '08-Mudanças', '_arquivo')), true);
    assert.equal(existsSync(join(vault, '.brain', 'runtime', 'change-archive-operation.lock')), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('[req:PROV-1] mutação após verdict da recaptura final não entra no snapshot autorizado', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-archive-final-recapture-race-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-archive-final-recapture-race-project-'));
  const spawn = (args, options = {}) => spawnSync(process.execPath, [...args, '--vault', vault, '--project', proj], {
    encoding: 'utf8', ...options,
  });
  try {
    initGitProject(proj);
    assert.equal(spawn([BIN, 'change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    const source = join(vault, '08-Mudanças', 'x');
    const tasksPath = join(source, 'tarefas.md');
    writeFileSync(tasksPath, '- [x] 1.1 bytes autorizados\n');
    assert.equal(spawn([BIN, 'verify', '--deep', '--change', 'x']).status, 0);

    const preload = join(vault, 'mutate-after-final-verdict.mjs');
    const ledger = join(proj, '.git', 'wendkeep', 'change-archive-receipts-v2.jsonl');
    writeFileSync(preload, [
      `import fs from 'node:fs';`,
      `import { syncBuiltinESMExports } from 'node:module';`,
      `const originalRead = fs.readFileSync; let readsAfterReceipt = 0;`,
      `fs.readFileSync = function(target, ...args) {`,
      `  const value = originalRead.call(this, target, ...args);`,
      `  if (String(target).endsWith('verdict.json') && fs.existsSync(${JSON.stringify(ledger)})) {`,
      `    readsAfterReceipt += 1;`,
      `    if (readsAfterReceipt === 2) fs.writeFileSync(${JSON.stringify(tasksPath)}, '- [x] 1.1 BYTES-CONCORRENTES\\n');`,
      `  }`,
      `  return value;`,
      `};`,
      `syncBuiltinESMExports();`,
    ].join('\n'));
    const result = spawn(['--import', pathToFileURL(preload).href, BIN,
      'change', 'archive', 'x', '--json']);
    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.code, 'WENDKEEP_PROVENANCE_GATE_BLOCKED', JSON.stringify(payload));
    assert.equal(payload.blocker, 'PROV_ARCHIVE_INPUT_CHANGED');
    assert.ok(payload.reason_codes.includes('PROV_ARCHIVE_INPUT_CHANGED'));
    assert.equal(readFileSync(tasksPath, 'utf8'), '- [x] 1.1 BYTES-CONCORRENTES\n');
    assert.equal(existsSync(source), true, 'namespace original é restaurado intacto');
    assert.equal(existsSync(join(vault, '08-Mudanças', '_arquivo')), false,
      'bytes fora da autorização não são publicados');
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('[req:PROV-7] archive valida ledger separado e só então grava autorização v2 ancorada no prefixo legado', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-archive-ledger-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-archive-ledger-project-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  const runtime = join(proj, '.git', 'wendkeep');
  const ledgerPath = join(runtime, 'change-archive-receipts-v2.jsonl');
  const checkpointPath = join(runtime, 'change-archive-receipts-v2.checkpoint.json');
  const legacyPath = join(runtime, 'change-archive-receipts-v1.jsonl');
  try {
    initGitProject(proj);
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    const changeDir = join(vault, '08-Mudanças', 'x');
    writeFileSync(join(changeDir, 'proposta.md'), '---\ntype: change\nstatus: active\nspec_impact: required\nspec_impact_reason: "Contrato de autorização"\nspecs: [auth]\n---\n# x\n\n## Por quê\n\nTeste.\n\n## O que muda\n\nTeste.\n');
    mkdirSync(join(changeDir, 'specs', 'auth'), { recursive: true });
    writeFileSync(join(changeDir, 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requisito: AUTH-ARCHIVE — autorização persistida\narchive autorizado possui receipt\n');
    writeFileSync(join(changeDir, 'tarefas.md'), '- [x] 1.1 concluída\n');
    assert.equal(spawn(['verify', '--deep', '--change', 'x']).status, 0);

    const blockedOperationId = '22222222-2222-4222-8222-222222222222';
    const blockedTransaction = join(vault, '.brain', 'runtime', 'archive-transactions', blockedOperationId);
    mkdirSync(join(blockedTransaction, 'original'), { recursive: true });
    writeFileSync(join(blockedTransaction, 'original', 'tarefas.md'), '- [x] original retido\n');
    writeFileSync(join(blockedTransaction, 'archive-transaction.json'), `${JSON.stringify({
      schema_version: 1,
      operation: 'archive',
      operation_id: blockedOperationId,
      change_slug: 'x',
      phase: 'recovery-required',
      blocker: 'PROV_ARCHIVE_ROLLBACK_COLLISION',
    })}\n`);
    const recoveryBlocked = spawn(['change', 'archive', 'x', '--json']);
    assert.equal(recoveryBlocked.status, 1, recoveryBlocked.stderr);
    const recoveryBlockedPayload = JSON.parse(recoveryBlocked.stdout);
    assert.equal(recoveryBlockedPayload.code, 'PROV_ARCHIVE_RECOVERY_REQUIRED');
    assert.equal(recoveryBlockedPayload.observed.operation_id, blockedOperationId);
    assert.equal(existsSync(ledgerPath), false, 'journal pendente bloqueia antes do receipt');
    rmSync(blockedTransaction, { recursive: true, force: true });

    const invalidOperationId = '44444444-4444-4444-8444-444444444444';
    const invalidTransaction = join(vault, '.brain', 'runtime', 'archive-transactions', invalidOperationId);
    mkdirSync(join(invalidTransaction, 'original'), { recursive: true });
    writeFileSync(join(invalidTransaction, 'archive-transaction.json'), '{"schema_version":1');
    const invalidJournal = spawn(['change', 'archive', 'x', '--json']);
    assert.equal(invalidJournal.status, 1, invalidJournal.stderr);
    const invalidPayload = JSON.parse(invalidJournal.stdout);
    assert.equal(invalidPayload.code, 'PROV_ARCHIVE_RECOVERY_JOURNAL_INVALID');
    assert.equal(invalidPayload.observed.operation_id, invalidOperationId);
    assert.equal(invalidPayload.repair.command,
      `wendkeep change archive recover ${invalidOperationId} --change x`);
    assert.equal(existsSync(ledgerPath), false, 'journal inválido bloqueia antes do receipt');
    rmSync(invalidTransaction, { recursive: true, force: true });

    for (const [suffix, manifest] of [
      ['5', null],
      ['6', JSON.stringify({ schema_version: 99, operation: 'archive', operation_id: '66666666-6666-4666-8666-666666666666', change_slug: 'x', phase: 'recovery-required' })],
      ['7', JSON.stringify({ schema_version: 1, operation: 'archive', operation_id: '88888888-8888-4888-8888-888888888888', change_slug: 'x', phase: 'recovery-required' })],
    ]) {
      const operationId = `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`;
      const transaction = join(vault, '.brain', 'runtime', 'archive-transactions', operationId);
      mkdirSync(join(transaction, 'original'), { recursive: true });
      writeFileSync(join(transaction, 'original', 'tarefas.md'), 'retido\n');
      if (manifest !== null) writeFileSync(join(transaction, 'archive-transaction.json'), `${manifest}\n`);
      const blocked = spawn(['change', 'archive', 'x', '--json']);
      assert.equal(blocked.status, 1, blocked.stderr);
      const payload = JSON.parse(blocked.stdout);
      assert.equal(payload.code, 'PROV_ARCHIVE_RECOVERY_JOURNAL_INVALID');
      assert.equal(payload.observed.operation_id, operationId);
      assert.equal(existsSync(ledgerPath), false);
      rmSync(transaction, { recursive: true, force: true });
    }

    const heldOperation = acquireArchiveOperationLock({
      lockPath: join(vault, '.brain', 'runtime', 'change-archive-operation.lock'),
    });
    const busy = spawn(['change', 'archive', 'x', '--json']);
    assert.equal(busy.status, 1, busy.stderr);
    const busyPayload = JSON.parse(busy.stdout);
    assert.equal(busyPayload.code, 'WENDKEEP_ARCHIVE_BUSY');
    assert.equal(busyPayload.operation, 'archive');
    assert.equal(busyPayload.state, 'conflict');
    assert.equal(busyPayload.blocker, 'WENDKEEP_ARCHIVE_BUSY');
    assert.deepEqual(busyPayload.expected, { owner_state: 'available' });
    assert.deepEqual(busyPayload.observed, { owner_state: 'live' });
    assert.equal(busyPayload.recovery, 'wendkeep change archive x');
    assert.equal(busyPayload.repair.command, 'wendkeep change archive x');
    assert.equal(existsSync(ledgerPath), false, 'lock causal bloqueia antes do receipt e de qualquer mutação');
    heldOperation.release();

    const verdictPath = join(changeDir, 'verdict.json');
    const validVerdict = JSON.parse(readFileSync(verdictPath, 'utf8'));
    writeFileSync(verdictPath, JSON.stringify({ ...validVerdict, notes: null }));
    const proofBlocked = spawn(['change', 'archive', 'x', '--force']);
    assert.equal(proofBlocked.status, 1, proofBlocked.stderr);
    assert.equal(existsSync(ledgerPath), false, 'gate inválido não pode emitir autorização');
    writeFileSync(verdictPath, JSON.stringify(validVerdict));

    mkdirSync(runtime, { recursive: true });
    const legacyPrefix = '{"schema_version":1,"event":"archive-era-v1"}\n';
    writeFileSync(legacyPath, legacyPrefix);
    const partial = '{"schema_version":2';
    writeFileSync(ledgerPath, partial);
    const corrupted = spawn(['change', 'archive', 'x', '--json']);
    assert.equal(corrupted.status, 1, corrupted.stderr);
    const blockedPayload = JSON.parse(corrupted.stdout);
    assert.equal(blockedPayload.code, 'WENDKEEP_RECEIPT_LEDGER_TRUNCATED');
    assert.equal(blockedPayload.operation, 'archive');
    assert.equal(blockedPayload.state, 'conflict', JSON.stringify(blockedPayload));
    assert.ok(blockedPayload.reason_codes.includes('WENDKEEP_RECEIPT_LEDGER_TRUNCATED'));
    assert.equal(readFileSync(ledgerPath, 'utf8'), partial, 'tail inválido permanece para recuperação explícita');
    assert.equal(existsSync(changeDir), true, 'ledger inválido bloqueia antes de mover a change');
    assert.equal(existsSync(join(vault, '07-Specs', 'auth.md')), false, 'ledger inválido não pode promover spec');
    assert.equal(existsSync(join(vault, '04-Decisões')), false, 'ledger inválido não pode criar ADR');

    rmSync(ledgerPath);
    rmSync(checkpointPath, { force: true });
    const archived = spawn(['change', 'archive', 'x', '--json']);
    assert.equal(archived.status, 0, archived.stderr);
    const archivedPayload = JSON.parse(archived.stdout);
    assert.equal(archivedPayload.ok, true);
    assert.equal(archivedPayload.code, 'WENDKEEP_CHANGE_ARCHIVED');
    assert.equal(archivedPayload.operation, 'archive');
    assert.equal(archivedPayload.state, 'verified');
    assert.equal(archivedPayload.blocker, null);
    assert.deepEqual(archivedPayload.expected, { change_slug: 'x' });
    assert.equal(archivedPayload.observed.archived_rel, archivedPayload.archived_rel);
    assert.equal(archivedPayload.recovery, null);
    assert.deepEqual(archivedPayload.reason_codes, []);
    assert.deepEqual(archivedPayload.diagnostics, []);
    assert.equal(archivedPayload.repair, null);
    assert.deepEqual(archivedPayload.promoted, ['auth']);
    assert.match(readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8'), /AUTH-ARCHIVE/);
    assert.equal(readFileSync(legacyPath, 'utf8'), legacyPrefix, 'prefixo v1 é âncora read-only');
    const records = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 1);
    assert.equal(records[0].schema_version, 2);
    assert.equal(records[0].kind, 'change-archive-authorization');
    assert.equal(records[0].subject.operation, 'archive');
    assert.equal(records[0].subject.outcome, 'authorized');
    assert.equal(records[0].subject.change_slug, 'x');
    assert.equal(records[0].previous_hash, receiptGenesisHash(legacyPrefix));
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    assert.equal(checkpoint.last_sequence, records[0].sequence);
    assert.equal(checkpoint.last_hash, records[0].receipt_hash);
    const archiveTransactions = join(vault, '.brain', 'runtime', 'archive-transactions');
    const retainedTransactions = readdirSync(archiveTransactions);
    assert.equal(retainedTransactions.length, 1, 'journal completed permanece como autoridade');
    const retainedRoot = join(archiveTransactions, retainedTransactions[0]);
    const retainedManifest = JSON.parse(readFileSync(join(retainedRoot, 'archive-transaction.json'), 'utf8'));
    assert.equal(retainedManifest.phase, 'completed');
    assert.equal(existsSync(join(retainedRoot, 'original')), true);
    assert.equal(retainedManifest.spec_promotion_state, 'applied');
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('[req:PROV-1] archive recaptura source/index/untracked, history, spec e sensor; reverify fecha cada gate', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-archive-recapture-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-archive-recapture-project-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  const changeDir = join(vault, '08-Mudanças', 'x');
  const verdictPath = join(changeDir, 'verdict.json');
  const verifyAndVerdict = () => {
    const verified = spawn(['verify', '--deep', '--change', 'x']);
    assert.equal(verified.status, 0, verified.stderr);
    const pkg = JSON.parse(readFileSync(join(changeDir, 'verificacao.json'), 'utf8'));
    writeFileSync(verdictPath, JSON.stringify({
      slug: 'x',
      ok: true,
      coverage: [{ req: 'X-1', covered: true, evidence: 'tests/change-cli.test.mjs' }],
      tasksHash: pkg.tasksHash,
      effectiveSpecHash: pkg.effectiveSpecHash,
      evidenceEnvelopeId: pkg.evidenceEnvelopeId,
      evidenceBinding: pkg.evidenceBinding,
      notes: [],
    }));
  };
  const assertBlocked = (label) => {
    const blocked = spawn(['change', 'archive', 'x', '--json', '--force']);
    assert.equal(blocked.status, 1, `${label}: ${blocked.stderr}`);
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.ok, false, label);
    assert.ok(['stale', 'conflict', 'unproven'].includes(payload.state), `${label}: ${payload.state}`);
    assert.equal(payload.repair.command, 'wendkeep verify --deep --change x', label);
    assert.equal(existsSync(changeDir), true, `${label}: --force não pode mover a change`);
  };
  try {
    initGitProject(proj);
    writeFileSync(join(proj, 'source.txt'), 'baseline\n');
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({
      version: 1,
      sensors: [{ id: 'proof', severity: 'critical', command: 'node -e "process.exit(0)"' }],
    }));
    git(proj, 'add', 'source.txt', 'wendkeep.sensors.json');
    git(proj, 'commit', '-q', '-m', 'tracked verification inputs');

    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeLivingRequirement(vault, 'X-1');
    writeFileSync(join(changeDir, 'tarefas.md'), '- [x] 1.1 prova [req:X-1] [sensor:proof]\n');
    verifyAndVerdict();

    writeFileSync(join(proj, 'source.txt'), 'unstaged mutation\n');
    assertBlocked('source mutation');
    verifyAndVerdict();

    writeFileSync(join(proj, 'source.txt'), 'indexed mutation\n');
    git(proj, 'add', 'source.txt');
    assertBlocked('index mutation');
    verifyAndVerdict();

    writeFileSync(join(proj, 'untracked.txt'), 'new input\n');
    assertBlocked('untracked mutation');
    verifyAndVerdict();

    git(proj, 'add', 'untracked.txt');
    git(proj, 'commit', '-q', '-m', 'capture staged and untracked state');
    git(proj, 'commit', '--amend', '-q', '-m', 'rewritten history');
    assertBlocked('amend/rebase history mutation');
    verifyAndVerdict();

    writeLivingRequirement(vault, 'X-1', 'core');
    writeFileSync(join(vault, '07-Specs', 'core.md'), '# core\n\n## Requisitos\n\n### Requisito: X-1 — comportamento\ncritério observável alterado\n');
    assertBlocked('spec mutation');
    verifyAndVerdict();

    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({
      version: 1,
      sensors: [{ id: 'proof', severity: 'critical', command: 'node -e "void 0"' }],
    }));
    assertBlocked('sensor mutation');
    verifyAndVerdict();

    const archived = spawn(['change', 'archive', 'x']);
    assert.equal(archived.status, 0, archived.stderr);
    assert.equal(existsSync(changeDir), false, 'último reverify fecha todos os gates');
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('[req:PROV-1] archive bloqueia envelope stale e binding estrangeiro com estado/código de proveniência', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-provenance-stale-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-provenance-stale-project-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  const envelopePath = join(vault, '08-Mudanças', 'x', 'evidencia.json');
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    initGitProject(proj);
    const created = spawn(['change', 'new', 'x']);
    assert.equal(created.status, 0, created.stderr);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 concluída\n');
    assert.equal(spawn(['verify', '--deep']).status, 0);

    const original = JSON.parse(readFileSync(envelopePath, 'utf8'));
    const packagePath = join(vault, '08-Mudanças', 'x', 'verificacao.json');
    const originalPackage = JSON.parse(readFileSync(packagePath, 'utf8'));
    writeFileSync(packagePath, JSON.stringify({ ...originalPackage, tasksHash: `sha256:${'e'.repeat(64)}` }));
    const stalePackage = spawn(['change', 'archive', 'x']);
    assert.equal(stalePackage.status, 1, stalePackage.stderr);
    assert.match(stalePackage.stderr, /WENDKEEP_PROVENANCE_GATE_BLOCKED/);
    assert.match(stalePackage.stderr, /stale|conflict|fresh|fresca/i);
    writeFileSync(packagePath, JSON.stringify(originalPackage));

    writeFileSync(envelopePath, JSON.stringify({ ...original, worktree_digest: `sha256:${'f'.repeat(64)}` }));
    const stale = spawn(['change', 'archive', 'x']);
    assert.equal(stale.status, 1, stale.stderr);
    assert.match(stale.stderr, /WENDKEEP_PROVENANCE_GATE_BLOCKED/);
    assert.match(stale.stderr, /conflict|envelope_id|binding/i, 'tamper sem recomputar envelope_id é conflito');

    writeFileSync(envelopePath, JSON.stringify({ ...original, worktree_id: 'foreign-worktree' }));
    const foreign = spawn(['change', 'archive', 'x']);
    assert.equal(foreign.status, 1, foreign.stderr);
    assert.match(foreign.stderr, /WENDKEEP_PROVENANCE_GATE_BLOCKED/);
    assert.match(foreign.stderr, /conflict|binding|foreign|diverg/i);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('change status <slug>: one screen with tasks, sensors, verdict state', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-status-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault], { encoding: 'utf8' });
  try {
    assert.equal(spawn(['new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 feita [req:X-1] [sensor:tests] [sensor:memory-health]\n- [ ] 1.2 aberta\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'evidencia.json'), JSON.stringify([
      { id: 'tests', status: 'green', severity: 'critical' },
      { id: 'memory-health', status: 'green', severity: 'critical' },
    ]));
    const r = spawn(['status', 'x']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /x/);
    assert.match(r.stdout, /1 done.*1 open|1 aberta/i);
    assert.match(r.stdout, /\[x\] 1\.1/);
    assert.match(r.stdout, /\[sensor:tests\].*\[sensor:memory-health\]/);
    assert.match(r.stdout, /tests.*green|✓ tests/i);
    assert.match(r.stdout, /verdict: ausente/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('change list and status without slug expose every open change and its pending tasks', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-status-global-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault], { encoding: 'utf8' });
  try {
    assert.equal(spawn(['new', 'a']).status, 0);
    assert.equal(spawn(['new', 'b']).status, 0, 'b becomes global pointer');
    for (const [slug, task] of [['a', '1.1 Claude pendente'], ['b', '2.1 Codex pendente']]) {
      fillScaffold(vault, slug);
      writeFileSync(join(vault, '08-Mudanças', slug, 'tarefas.md'), `- [ ] ${task}\n`);
    }
    const list = spawn(['list']);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /ATUAL — b/);
    assert.match(list.stdout, /ABERTA — a/);
    assert.match(list.stdout, /1\.1 Claude pendente/);
    assert.match(list.stdout, /2\.1 Codex pendente/);
    const status = spawn(['status']);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /ATUAL — b/);
    assert.match(status.stdout, /ABERTA — a/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('change done/undone: toggles a task from the CLI (0.7.0)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-donecli-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault], { encoding: 'utf8' });
  try {
    assert.equal(spawn(['new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [ ] 1.1 faz\n');
    assert.equal(spawn(['done', '1.1']).status, 0);
    assert.match(readFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), 'utf8'), /- \[x\] 1\.1/);
    assert.equal(spawn(['undone', '1.1']).status, 0);
    assert.match(readFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), 'utf8'), /- \[ \] 1\.1/);
    assert.equal(spawn(['done', '9.9']).status, 2, 'missing id errors');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('change diff: previews the spec promotion without writing (0.7.0)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-diff-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault], { encoding: 'utf8' });
  try {
    assert.equal(spawn(['new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), '---\nspecs: [auth]\n---\n# x\n');
    mkdirSync(join(vault, '08-Mudanças', 'x', 'specs', 'auth'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requisito: AUTH-2 — logout\nsai\n\n## MODIFIED Requirements\n### Requisito: AUTH-1 — login\n2fa\n');
    mkdirSync(join(vault, '07-Specs'), { recursive: true });
    writeFileSync(join(vault, '07-Specs', 'auth.md'), '# auth\n## Requisitos\n### Requisito: AUTH-1 — login\nsimples\n');
    const r = spawn(['diff']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\+ .*AUTH-2/);
    assert.match(r.stdout, /~ .*AUTH-1/);
    // dry-run: spec vivo intacto
    assert.match(readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8'), /simples/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('sensors add: appends to wendkeep.sensors.json, creates file, dedups by id (0.9.0)', () => {
  const proj = mkdtempSync(join(tmpdir(), 'wk-sadd-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'sensors', ...a, '--project', proj], { encoding: 'utf8' });
  try {
    // creates the file when absent
    assert.equal(spawn(['add', 'tests', 'npm test']).status, 0);
    let cfg = JSON.parse(readFileSync(join(proj, 'wendkeep.sensors.json'), 'utf8'));
    assert.equal(cfg.version, 1);
    assert.match(cfg.$schema || '', /wendkeep\.sensors\.schema\.json/);
    assert.equal(cfg.sensors[0].id, 'tests');
    assert.equal(cfg.sensors[0].command, 'npm test');
    assert.equal(cfg.sensors[0].severity, 'critical');
    // second sensor with flags
    assert.equal(spawn(['add', 'lint', 'npm run lint', '--severity', 'warning']).status, 0);
    cfg = JSON.parse(readFileSync(join(proj, 'wendkeep.sensors.json'), 'utf8'));
    assert.equal(cfg.sensors.length, 2);
    assert.equal(cfg.sensors[1].severity, 'warning');
    // mutation type carries report
    assert.equal(spawn(['add', 'mut', 'npx stryker run', '--type', 'mutation', '--report', 'reports/m.json']).status, 0);
    cfg = JSON.parse(readFileSync(join(proj, 'wendkeep.sensors.json'), 'utf8'));
    assert.equal(cfg.sensors.find((s) => s.id === 'mut').report, 'reports/m.json');
    // dedup: adding an existing id errors
    assert.equal(spawn(['add', 'tests', 'echo x']).status, 2, 'duplicate id errors');
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test('spec list/show + sensors list: read-only views (0.7.0)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-views-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-viewsp-'));
  try {
    mkdirSync(join(vault, '07-Specs'), { recursive: true });
    writeFileSync(join(vault, '07-Specs', 'auth.md'), '# auth\n## Requisitos\n### Requisito: AUTH-1 — login\nx\n\n### Requisito: AUTH-2 — logout\ny\n\n> Atualizado por [[a]] em 2026-07-05.\n');
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'tests', type: 'command', severity: 'critical', command: 'npm test' }] }));
    const list = spawnSync(process.execPath, [BIN, 'spec', 'list', '--vault', vault], { encoding: 'utf8' });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /auth: 2 requisito/);
    assert.match(list.stdout, /2026-07-05/);
    const show = spawnSync(process.execPath, [BIN, 'spec', 'show', 'auth', '--vault', vault], { encoding: 'utf8' });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /AUTH-1 — login/);
    const sens = spawnSync(process.execPath, [BIN, 'sensors', 'list', '--project', proj], { encoding: 'utf8' });
    assert.equal(sens.status, 0, sens.stderr);
    assert.match(sens.stdout, /tests: command · critical · npm test/);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('sensors schema: valid JSON, seed points $schema at it (0.7.0)', async () => {
  const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'schema', 'wendkeep.sensors.schema.json'), 'utf8'));
  assert.equal(schema.properties.version.const, 1);
  const { renderSensorsJson } = await import('../src/dotcontext-seed.mjs');
  const seeded = JSON.parse(renderSensorsJson({}));
  assert.match(seeded.$schema, /wendkeep\.sensors\.schema\.json/);
});

test('wendkeep lesson add: writes a lesson under .brain/lessons', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-les-cli-'));
  try {
    const r = spawnSync(process.execPath, [BIN, 'lesson', 'add', 'gate falso verde', 'sensor sem report engana', '--vault', vault], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /lesson:.*gate-falso-verde/);
    assert.ok(existsSync(join(vault, '.brain', 'lessons')));
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('verify: mutation survivors -> fix tasks + exit 1; clean report resets the round', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-mutf-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-mutfp-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', 'm'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'm', 'tarefas.md'), '- [ ] 1.1 base [sensor:mut]\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: m\n');
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'mut', type: 'mutation', severity: 'critical', command: 'exit 0', report: 'rep.json' }] }));
    writeFileSync(join(proj, 'rep.json'), JSON.stringify({ files: { 'a.js': { mutants: [{ mutatorName: 'M', status: 'Survived', location: { start: { line: 3 } } }] } } }));
    // G4: sobrevivente = exit 1 (a suíte não discrimina)
    initGitProject(proj);
    assert.equal(spawn(['verify']).status, 1, 'survivor fails verify');
    const tarefas = join(vault, '08-Mudanças', 'm', 'tarefas.md');
    assert.match(readFileSync(tarefas, 'utf8'), /mata mutante a\.js:3/, 'fix task appended');
    assert.equal(spawn(['verify']).status, 1);
    assert.equal((readFileSync(tarefas, 'utf8').match(/mata mutante a\.js:3/g) || []).length, 1, 'no duplicate on re-run');
    // #5: report limpo -> exit 0 + contador resetado
    writeFileSync(join(proj, 'rep.json'), JSON.stringify({ files: {} }));
    assert.equal(spawn(['verify']).status, 0, 'clean report passes');
    assert.ok(!existsSync(join(vault, '08-Mudanças', 'm', '.mutation-round')), 'round reset');
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('verify: 3rd round escalates with an auto-lesson instead of new fix tasks', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-mut3-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-mut3p-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', 'm'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'm', 'tarefas.md'), '- [ ] 1.1 base [sensor:mut]\n');
    writeFileSync(join(vault, '08-Mudanças', 'm', '.mutation-round'), '3');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: m\n');
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'mut', type: 'mutation', severity: 'critical', command: 'exit 0', report: 'rep.json' }] }));
    writeFileSync(join(proj, 'rep.json'), JSON.stringify({ files: { 'a.js': { mutants: [{ mutatorName: 'M', status: 'Survived', location: { start: { line: 3 } } }] } } }));
    initGitProject(proj);
    const r = spawn(['verify']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /3 rodadas/);
    assert.doesNotMatch(readFileSync(join(vault, '08-Mudanças', 'm', 'tarefas.md'), 'utf8'), /mata mutante/, 'no new fix task at cap');
    const lessons = join(vault, '.brain', 'lessons');
    assert.ok(existsSync(lessons), 'auto-lesson dir');
    assert.ok(readdirSync(lessons).some((f) => /mutantes-persistentes/.test(f)), 'auto-lesson written');
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

// --- 0.31.0: gate endurecido + abandon + specs união ---------------------------

test('archive exige verdict SEMPRE (mesmo sem [req:]); verify --deep destrava', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-vall-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-vallp-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [] }));
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 feito\n');
    const blocked = spawn(['change', 'archive', 'x']);
    assert.equal(blocked.status, 1, 'sem verdict bloqueia mesmo sem [req:]');
    assert.match(blocked.stderr, /verdict.*verify --deep|WENDKEEP_PROVENANCE_GATE_BLOCKED/i);
    initGitProject(proj);
    assert.equal(spawn(['verify', '--deep']).status, 0, 'auto-verdict trivial');
    assert.equal(spawn(['change', 'archive', 'x']).status, 0, 'com verdict passa');
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('G0 inescapável: scaffold cru bloqueia mesmo com --force', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-g0f-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    assert.equal(spawn(['new', 'x']).status, 0);
    const forced = spawn(['archive', 'x', '--force']);
    assert.equal(forced.status, 1, '--force não pula G0');
    assert.match(forced.stderr, /scaffold/i);
    assert.match(forced.stderr, /abandon/i, 'mensagem aponta a saída legítima');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('--force rastreável: ADR ganha forced: true + aviso; trivial ganha trivial: true', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-fflag-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-fflagp-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  const findAdr = (name) => (function find(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { const hit = find(p); if (hit) return hit; }
      else if (e.name === name) return p;
    }
    return '';
  })(join(vault, '04-Decisões'));
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    initGitProject(proj);
    // forced: tarefa aberta + verdict trivial válido + --force
    assert.equal(spawn(['change', 'new', 'f1']).status, 0);
    fillScaffold(vault, 'f1');
    writeFileSync(join(vault, '08-Mudanças', 'f1', 'tarefas.md'), '- [ ] 1.1 pendente\n');
    assert.equal(spawn(['verify', '--deep', '--change', 'f1']).status, 0);
    const forced = spawn(['change', 'archive', 'f1', '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    const adr1 = readFileSync(findAdr('ADR-0001-f1.md'), 'utf8');
    assert.match(adr1, /^forced: true$/m, 'frontmatter forced');
    assert.match(adr1, /⚠️/, 'aviso no corpo');
    assert.match(adr1, /^trivial: true$/m, 'sem req/sensor também é trivial');
    assert.match(forced.stderr, /trivial/i, 'stderr avisa trivial');
    // não-forced e não-trivial: nada de flags
    assert.equal(spawn(['change', 'new', 'f2']).status, 0);
    fillScaffold(vault, 'f2');
    writeLivingRequirement(vault, 'F-1');
    writeFileSync(join(vault, '08-Mudanças', 'f2', 'tarefas.md'), '- [x] 1.1 feito [req:F-1]\n');
    assert.equal(spawn(['verify', '--deep', '--change', 'f2']).status, 0);
    const pkg = JSON.parse(readFileSync(join(vault, '08-Mudanças', 'f2', 'verificacao.json'), 'utf8'));
    writeFileSync(join(vault, '08-Mudanças', 'f2', 'verdict.json'), JSON.stringify({
      slug: 'f2', ok: true, coverage: [{ req: 'F-1', covered: true }],
      tasksHash: pkg.tasksHash,
      effectiveSpecHash: pkg.effectiveSpecHash,
      evidenceEnvelopeId: pkg.evidenceEnvelopeId,
      evidenceBinding: pkg.evidenceBinding,
      notes: [],
    }));
    assert.equal(spawn(['change', 'archive', 'f2']).status, 0);
    const adr2 = readFileSync(findAdr('ADR-0002-f2.md'), 'utf8');
    assert.doesNotMatch(adr2, /forced: true/);
    assert.doesNotMatch(adr2, /trivial: true/);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('change abandon: move sem ADR, sem promoção, limpa ponteiro só da ativa', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-aband-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    assert.equal(spawn(['new', 'x']).status, 0);
    // delta REAL no disco — abandono NÃO pode promover
    mkdirSync(join(vault, '08-Mudanças', 'x', 'specs', 'auth'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requisito: Login\nreal\n');
    const r = spawn(['abandon', 'x']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /abandoned/);
    const arch = readdirSync(join(vault, '08-Mudanças', '_arquivo')).find((d) => d.endsWith('-x-abandonada'));
    assert.ok(arch, 'movida para _arquivo/<data>-x-abandonada');
    assert.match(readFileSync(join(vault, '08-Mudanças', '_arquivo', arch, 'proposta.md'), 'utf8'), /^status: abandoned$/m);
    assert.ok(!existsSync(join(vault, '07-Specs', 'auth.md')), '07-Specs intocado');
    // nenhum ADR
    const adrs = (function walk(d) {
      let out = [];
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) out = out.concat(walk(p));
        else if (/^ADR-/.test(e.name)) out.push(p);
      }
      return out;
    })(join(vault, '04-Decisões'));
    assert.equal(adrs.length, 0, 'abandono não gera ADR');
    // ponteiro limpo (era a ativa)
    assert.match(readFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'utf8'), /^change:\s*$/m);
    // abandonar não-ativa preserva o ponteiro da ativa
    assert.equal(spawn(['new', 'a']).status, 0);
    assert.equal(spawn(['new', 'b']).status, 0); // b vira a ativa
    assert.equal(spawn(['abandon', 'a']).status, 0);
    assert.match(readFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'utf8'), /^change: b$/m);
    // slug inexistente
    assert.equal(spawn(['abandon', 'nao-existe']).status, 2);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('specs união: delta real no disco promove mesmo com specs: [] (warning); placeholder não', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-union-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-unionp-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    mkdirSync(join(vault, '.brain'), { recursive: true });
    initGitProject(proj);
    mkdirSync(join(vault, '08-Mudanças', 'x', 'specs', 'exemplo'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'design.md'), '# x — design\n\n## Abordagem\n\nLegado.\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'specs', 'exemplo', 'spec.md'), '## ADDED Requirements\n### Requisito: (nome)\n(comportamento)\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), '# x\n\n## Por quê\n\nLegado.\n\n## O que muda\n\nLegado.\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 feito\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: x\n');
    // proposta ficou com specs: [] (fillScaffold não mexe) — delta REAL só no disco
    mkdirSync(join(vault, '08-Mudanças', 'x', 'specs', 'auth'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requisito: Login\nusuário faz login\n');
    assert.equal(spawn(['verify', '--deep', '--change', 'x']).status, 0);
    const r = spawn(['change', 'archive', 'x']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8'), /Requisito: Login/, 'delta do disco promovido');
    assert.match(r.stderr, /não listada[^\n]*auth/i, 'warning da cap não listada');
    assert.ok(!existsSync(join(vault, '07-Specs', 'exemplo.md')), 'placeholder exemplo filtrado');
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('verify --deep: trivial auto-writes verdict; a change with [req:] only writes the package', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-deep-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-deepp-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'ok', severity: 'critical', command: 'exit 0' }] }));
    // trivial: no [req:]
    mkdirSync(join(vault, '08-Mudanças', 't'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 't', 'tarefas.md'), '- [ ] 1.1 faz [sensor:ok]\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: t\n');
    initGitProject(proj);
    assert.equal(spawn(['verify', '--deep']).status, 0);
    assert.ok(existsSync(join(vault, '08-Mudanças', 't', 'verificacao.json')));
    assert.ok(existsSync(join(vault, '08-Mudanças', 't', 'verdict.json')), 'trivial auto-verdict');
    // with [req:]: package yes, verdict no (agent pass required)
    mkdirSync(join(vault, '08-Mudanças', 'r'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'r', 'proposta.md'), '---\nspecs: []\n---\n');
    writeLivingRequirement(vault, 'X-1');
    writeFileSync(join(vault, '08-Mudanças', 'r', 'tarefas.md'), '- [ ] 1.1 faz [req:X-1] [sensor:ok]\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: r\n');
    assert.equal(spawn(['verify', '--deep']).status, 0);
    const reqPackage = JSON.parse(readFileSync(join(vault, '08-Mudanças', 'r', 'verificacao.json'), 'utf8'));
    assert.equal(reqPackage.requirements[0].id, 'X-1');
    assert.equal(reqPackage.requirements[0].capability, 'core');
    assert.equal(reqPackage.requirements[0].body, 'critério observável');
    assert.equal(reqPackage.requirements[0].operation, 'BASE');
    assert.equal(reqPackage.requirements[0].source, 'living');
    assert.equal(reqPackage.effectiveSpecHash.length, 64);
    assert.ok(!existsSync(join(vault, '08-Mudanças', 'r', 'verdict.json')), 'req change needs the agent verdict');
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});
