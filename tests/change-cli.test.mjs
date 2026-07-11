import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

// G0 (0.21.0): archive blocks unfilled scaffolds, so archive-path tests must fill
// proposta/design like a real planned change would.
function fillScaffold(vault, slug, dir = '08-Mudanças') {
  writeFileSync(join(vault, dir, slug, 'proposta.md'), `---\nspec_impact: none\nspec_impact_reason: "Sem alteração de contrato neste fixture"\nspecs: []\n---\n\n# ${slug}\n\n## Por quê\n\nTeste.\n\n## O que muda\n\nTeste.\n`);
  writeFileSync(join(vault, dir, slug, 'design.md'), `# ${slug} — design\n\n## Abordagem\n\nTeste.\n`);
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

test('wendkeep change new then archive: moves + writes ADR', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-archcli-'));
  try {
    const spawn = (args) => spawnSync(process.execPath, [BIN, 'change', ...args, '--vault', vault], { encoding: 'utf8' });
    assert.equal(spawn(['new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 feito\n');
    // 0.31.0: verdict sempre exigido — trivial destrava com o auto-verdict do verify --deep.
    writeFileSync(join(vault, '08-Mudanças', 'x', 'verdict.json'), JSON.stringify({ slug: 'x', ok: true, coverage: [] }));
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
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 do it [sensor:ok]\n');
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'ok', severity: 'critical', command: 'node -e "process.exit(0)"' }] }));
    const blocked = spawn(['change', 'archive', 'x']);
    assert.equal(blocked.status, 1, 'archive blocked without evidence');
    assert.match(blocked.stderr, /BLOCKED/);
    // 0.31.0: --deep também grava o auto-verdict (agora sempre exigido pelo gate)
    assert.equal(spawn(['verify', '--deep']).status, 0);
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
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), '---\ntype: change\nstatus: active\nspec_impact: required\nspec_impact_reason: ""\nspecs: [auth]\n---\n# x\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 feito\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'verdict.json'), JSON.stringify({ slug: 'x', ok: true, coverage: [] }));
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
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 polish [sensor:style]\n');
    // style is a RED warning sensor (exit 1) — advisory, must NOT gate.
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'style', severity: 'warning', command: 'exit 1' }] }));
    assert.equal(spawn(['verify', '--deep']).status, 0, 'red warning still passes verify (--deep grava o auto-verdict)');
    const arch = spawn(['change', 'archive', 'x']);
    assert.equal(arch.status, 0, `red warning does not block archive; stderr=${arch.stderr}`);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('archive requires a verdict when a task declares [req:]; ADR lists the req id', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-verdict-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    assert.equal(spawn(['new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 faz [req:X-1]\n');
    const blocked = spawn(['archive', 'x']);
    assert.equal(blocked.status, 1, 'blocked without verdict');
    assert.match(blocked.stderr, /verdict/i);
    writeFileSync(join(vault, '08-Mudanças', 'x', 'verdict.json'), JSON.stringify({ slug: 'x', ok: true, coverage: [{ req: 'X-1', covered: true }] }));
    const ok = spawn(['archive', 'x']);
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
  } finally { rmSync(vault, { recursive: true, force: true }); }
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
    const tarefas = join(vault, '08-Mudanças', 'x', 'tarefas.md');
    writeFileSync(tarefas, '- [x] 1.1 faz [req:X-1]\n');
    assert.equal(spawn(['verify', '--deep']).status, 0);
    const pkg = JSON.parse(readFileSync(join(vault, '08-Mudanças', 'x', 'verificacao.json'), 'utf8'));
    assert.ok(pkg.tasksHash, 'package carries tasksHash');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'verdict.json'), JSON.stringify({ slug: 'x', ok: true, coverage: [{ req: 'X-1', covered: true }], tasksHash: pkg.tasksHash }));
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

test('archive blocks on open tasks; --force overrides (G1)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-open-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    assert.equal(spawn(['new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [ ] 1.1 pendente\n- [x] 1.2 feita\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'verdict.json'), JSON.stringify({ slug: 'x', ok: true, coverage: [] }));
    const blocked = spawn(['archive', 'x']);
    assert.equal(blocked.status, 1, 'open task blocks');
    assert.match(blocked.stderr, /aberta/i);
    const forced = spawn(['archive', 'x', '--force']);
    assert.equal(forced.status, 0, forced.stderr);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('change status <slug>: one screen with tasks, sensors, verdict state', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-status-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault], { encoding: 'utf8' });
  try {
    assert.equal(spawn(['new', 'x']).status, 0);
    fillScaffold(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 feita [req:X-1] [sensor:tests]\n- [ ] 1.2 aberta\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'evidencia.json'), JSON.stringify([{ id: 'tests', status: 'green', severity: 'critical' }]));
    const r = spawn(['status', 'x']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /x/);
    assert.match(r.stdout, /1 done.*1 open|1 aberta/i);
    assert.match(r.stdout, /\[x\] 1\.1/);
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
    assert.match(blocked.stderr, /verdict.*verify --deep/i);
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
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault], { encoding: 'utf8' });
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
    // forced: tarefa aberta + verdict trivial válido + --force
    assert.equal(spawn(['new', 'f1']).status, 0);
    fillScaffold(vault, 'f1');
    writeFileSync(join(vault, '08-Mudanças', 'f1', 'tarefas.md'), '- [ ] 1.1 pendente\n');
    writeFileSync(join(vault, '08-Mudanças', 'f1', 'verdict.json'), JSON.stringify({ slug: 'f1', ok: true, coverage: [] }));
    const forced = spawn(['archive', 'f1', '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    const adr1 = readFileSync(findAdr('ADR-0001-f1.md'), 'utf8');
    assert.match(adr1, /^forced: true$/m, 'frontmatter forced');
    assert.match(adr1, /⚠️/, 'aviso no corpo');
    assert.match(adr1, /^trivial: true$/m, 'sem req/sensor também é trivial');
    assert.match(forced.stderr, /trivial/i, 'stderr avisa trivial');
    // não-forced e não-trivial: nada de flags
    assert.equal(spawn(['new', 'f2']).status, 0);
    fillScaffold(vault, 'f2');
    writeFileSync(join(vault, '08-Mudanças', 'f2', 'tarefas.md'), '- [x] 1.1 feito [req:F-1]\n');
    writeFileSync(join(vault, '08-Mudanças', 'f2', 'verdict.json'), JSON.stringify({ slug: 'f2', ok: true, coverage: [{ req: 'F-1', covered: true }] }));
    assert.equal(spawn(['archive', 'f2']).status, 0);
    const adr2 = readFileSync(findAdr('ADR-0002-f2.md'), 'utf8');
    assert.doesNotMatch(adr2, /forced: true/);
    assert.doesNotMatch(adr2, /trivial: true/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
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
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', 'x', 'specs', 'exemplo'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'design.md'), '# x — design\n\n## Abordagem\n\nLegado.\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'specs', 'exemplo', 'spec.md'), '## ADDED Requirements\n### Requisito: (nome)\n(comportamento)\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), '# x\n\n## Por quê\n\nLegado.\n\n## O que muda\n\nLegado.\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 feito\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'verdict.json'), JSON.stringify({ slug: 'x', ok: true, coverage: [] }));
    // proposta ficou com specs: [] (fillScaffold não mexe) — delta REAL só no disco
    mkdirSync(join(vault, '08-Mudanças', 'x', 'specs', 'auth'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requisito: Login\nusuário faz login\n');
    const r = spawn(['archive', 'x']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8'), /Requisito: Login/, 'delta do disco promovido');
    assert.match(r.stderr, /não listada[^\n]*auth/i, 'warning da cap não listada');
    assert.ok(!existsSync(join(vault, '07-Specs', 'exemplo.md')), 'placeholder exemplo filtrado');
  } finally { rmSync(vault, { recursive: true, force: true }); }
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
    assert.equal(spawn(['verify', '--deep']).status, 0);
    assert.ok(existsSync(join(vault, '08-Mudanças', 't', 'verificacao.json')));
    assert.ok(existsSync(join(vault, '08-Mudanças', 't', 'verdict.json')), 'trivial auto-verdict');
    // with [req:]: package yes, verdict no (agent pass required)
    mkdirSync(join(vault, '08-Mudanças', 'r'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'r', 'tarefas.md'), '- [ ] 1.1 faz [req:X-1] [sensor:ok]\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: r\n');
    assert.equal(spawn(['verify', '--deep']).status, 0);
    assert.ok(existsSync(join(vault, '08-Mudanças', 'r', 'verificacao.json')));
    assert.ok(!existsSync(join(vault, '08-Mudanças', 'r', 'verdict.json')), 'req change needs the agent verdict');
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});
