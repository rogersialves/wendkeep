import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptSpecsState, buildEffectiveRequirementPackage, captureSpecBaseline, checkSpecsState, parseRequirements, parseDelta, applyDelta, renderSpec, parseSpecsList, promoteSpecs, evaluateVerdict, tasksHashOf, isPlaceholderDelta, discoverSpecDeltas, parseSpecImpact, specConflicts, validateSpecImpact } from '../hooks/spec-core.mjs';

test('isPlaceholderDelta: scaffold puro true; delta real/REMOVED false; bilíngue', () => {
  const scaffoldPt = '## ADDED Requirements\n### Requisito: (nome)\n(comportamento / cenários)\n\n## MODIFIED Requirements\n\n## REMOVED Requirements\n';
  const scaffoldEn = '## ADDED Requirements\n### Requirement: (name)\n(behaviour / scenarios)\n\n## MODIFIED Requirements\n\n## REMOVED Requirements\n';
  assert.equal(isPlaceholderDelta(scaffoldPt), true);
  assert.equal(isPlaceholderDelta(scaffoldEn), true);
  assert.equal(isPlaceholderDelta('## ADDED Requirements\n\n## MODIFIED Requirements\n'), true, 'delta vazio = placeholder');
  assert.equal(isPlaceholderDelta('## ADDED Requirements\n### Requisito: Login\nreal\n'), false);
  assert.equal(isPlaceholderDelta('## REMOVED Requirements\n### Requisito: Velho\nx\n'), false, 'REMOVED é intenção real');
});

test('discoverSpecDeltas: lista caps com delta real; ignora placeholder; [] sem specs/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-disc-'));
  try {
    assert.deepEqual(discoverSpecDeltas(dir), [], 'sem specs/');
    mkdirSync(join(dir, 'specs', 'exemplo'), { recursive: true });
    writeFileSync(join(dir, 'specs', 'exemplo', 'spec.md'), '## ADDED Requirements\n### Requisito: (nome)\n(comportamento / cenários)\n');
    mkdirSync(join(dir, 'specs', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requisito: Login\nreal\n');
    mkdirSync(join(dir, 'specs', 'vazio'), { recursive: true }); // sem spec.md
    assert.deepEqual(discoverSpecDeltas(dir), ['auth']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseSpecImpact + validateSpecImpact: pending/required/none e legado', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-impact-'));
  try {
    writeFileSync(join(dir, '.spec-impact-v1'), '1\n');
    writeFileSync(join(dir, 'proposta.md'), '---\nspec_impact: pending\nspec_impact_reason: ""\nspecs: []\n---\n');
    assert.equal(parseSpecImpact(readFileSync(join(dir, 'proposta.md'), 'utf8')).status, 'pending');
    assert.equal(validateSpecImpact(dir).ok, false);

    writeFileSync(join(dir, 'proposta.md'), '---\nspec_impact: none\nspec_impact_reason: ""\nspecs: []\n---\n');
    assert.match(validateSpecImpact(dir).errors.join(' '), /justificativa/i);
    writeFileSync(join(dir, 'proposta.md'), '---\nspec_impact: none\nspec_impact_reason: "Refactor interno"\nspecs: []\n---\n');
    assert.equal(validateSpecImpact(dir).ok, true);

    writeFileSync(join(dir, 'proposta.md'), '---\nspec_impact: required\nspec_impact_reason: ""\nspecs: [auth]\n---\n');
    assert.match(validateSpecImpact(dir).errors.join(' '), /auth/);
    mkdirSync(join(dir, 'specs', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requisito: AUTH-1 — Login\nUsuário entra.\n');
    assert.equal(validateSpecImpact(dir).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const legacy = mkdtempSync(join(tmpdir(), 'wk-impact-legacy-'));
  try {
    writeFileSync(join(legacy, 'proposta.md'), '---\nspecs: []\n---\n');
    const state = validateSpecImpact(legacy);
    assert.equal(state.ok, true);
    assert.equal(state.legacy, true);
    assert.match(state.warnings.join(' '), /legad/i);
  } finally { rmSync(legacy, { recursive: true, force: true }); }
});

test('evaluateVerdict: tasksHash mismatch = stale; sem hash no verdict = retrocompat', () => {
  const v = { ok: true, coverage: [{ req: 'A-1', covered: true }], tasksHash: 'abc123', effectiveSpecHash: 'spec-a' };
  assert.deepEqual(evaluateVerdict(v, ['A-1'], { tasksHash: 'abc123' }), { ok: true, missing: [] });
  const stale = evaluateVerdict(v, ['A-1'], { tasksHash: 'zzz999' });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  const specStale = evaluateVerdict(v, ['A-1'], { tasksHash: 'abc123', effectiveSpecHash: 'spec-b' });
  assert.equal(specStale.stale, true);
  // verdict pré-0.6.1 (sem tasksHash): aceito
  const old = { ok: true, coverage: [{ req: 'A-1', covered: true }] };
  assert.equal(evaluateVerdict(old, ['A-1'], { tasksHash: 'abc123' }).ok, true);
  // hash estável e curto
  assert.equal(tasksHashOf('x'), tasksHashOf('x'));
  assert.notEqual(tasksHashOf('x'), tasksHashOf('y'));
  assert.equal(tasksHashOf('x').length, 12);
});

test('evaluateVerdict: sem req = trivial ok; com req exige verdict cobrindo', () => {
  const v = { ok: true, coverage: [{ req: 'A-1', covered: true }] };
  assert.deepEqual(evaluateVerdict(v, ['A-1']), { ok: true, missing: [] });
  assert.deepEqual(evaluateVerdict(v, ['A-1', 'A-2']), { ok: false, missing: ['A-2'] });
  assert.deepEqual(evaluateVerdict(null, []), { ok: true, missing: [] }); // trivial: nada a verificar
  assert.deepEqual(evaluateVerdict(null, ['A-1']), { ok: false, missing: [] }); // tem req, sem verdict = bloqueia
  assert.deepEqual(evaluateVerdict({ ok: false, coverage: [{ req: 'A-1', covered: true }] }, ['A-1']), { ok: false, missing: [] });
});

test('parseRequirements: ordered blocks, drops trailing footer', () => {
  const md = '# cap\n\n## Requisitos\n\n### Requisito: A\ncorpo A\n\n### Requisito: B\ncorpo B\n\n> Atualizado por [[x]] em 2026-07-05.\n';
  const r = parseRequirements(md);
  assert.deepEqual(r.map((x) => x.name), ['A', 'B']);
  assert.equal(r[0].body, 'corpo A');
  assert.equal(r[1].body, 'corpo B');
});

test('parseDelta: three sections', () => {
  const md = '## ADDED Requirements\n### Requisito: New\nx\n\n## MODIFIED Requirements\n### Requisito: Old\ny\n\n## REMOVED Requirements\n### Requisito: Gone\n';
  const d = parseDelta(md);
  assert.deepEqual(d.added.map((r) => r.name), ['New']);
  assert.deepEqual(d.modified.map((r) => r.name), ['Old']);
  assert.deepEqual(d.removed, ['Gone']);
});

test('applyDelta: upsert added/modified, delete removed, warns on inconsistency', () => {
  const base = [{ name: 'A', body: 'a' }, { name: 'B', body: 'b' }];
  const { reqs, warnings } = applyDelta(base, { added: [{ name: 'C', body: 'c' }], modified: [{ name: 'A', body: 'a2' }], removed: ['B'] });
  assert.deepEqual(reqs.map((r) => r.name), ['A', 'C']);
  assert.equal(reqs.find((r) => r.name === 'A').body, 'a2');
  assert.equal(warnings.length, 0);
  const w = applyDelta(base, { added: [{ name: 'A', body: 'dup' }], modified: [], removed: ['Z'] });
  assert.ok(w.warnings.some((x) => /A/.test(x)));
  assert.ok(w.warnings.some((x) => /Z/.test(x)));
});

test('renderSpec round-trips through parseRequirements', () => {
  const reqs = [{ name: 'A', body: 'corpo a' }, { name: 'B', body: 'corpo b' }];
  const md = renderSpec('minha-cap', reqs, { footer: 'nota' });
  assert.match(md, /type: spec/);
  assert.match(md, /# minha-cap/);
  assert.match(md, /> nota/);
  assert.deepEqual(parseRequirements(md).map((r) => r.name), ['A', 'B']);
});

test('parseSpecsList: inline and block YAML', () => {
  assert.deepEqual(parseSpecsList('---\nspecs: [auth, billing]\n---\n'), ['auth', 'billing']);
  assert.deepEqual(parseSpecsList('---\nspecs:\n  - auth\n  - "billing"\n---\n'), ['auth', 'billing']);
  assert.deepEqual(parseSpecsList('---\nspecs: []\n---\n'), []);
});

test('promoteSpecs: applies delta to a fresh living spec, then modifies in place', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-promo-'));
  try {
    const changeDir = join(vault, '08-Mudanças', 'x');
    mkdirSync(join(changeDir, 'specs', 'auth'), { recursive: true });
    writeFileSync(join(changeDir, 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requisito: Login\nusuário faz login\n');
    const r = promoteSpecs(vault, changeDir, ['auth'], { changeWikilink: '[[arq/proposta]]', dateStr: '2026-07-05' });
    assert.deepEqual(r.promoted, ['auth']);
    const live = readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8');
    assert.match(live, /### Requisito: Login/);
    assert.match(live, /\[\[arq\/proposta\]\]/);
    writeFileSync(join(changeDir, 'specs', 'auth', 'spec.md'), '## MODIFIED Requirements\n### Requisito: Login\nlogin com 2FA\n');
    promoteSpecs(vault, changeDir, ['auth'], { changeWikilink: '[[arq2/proposta]]', dateStr: '2026-07-06' });
    assert.match(readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8'), /login com 2FA/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('promoteSpecs: delta ausente/placeholder falha fechado', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-promo-fail-'));
  try {
    const changeDir = join(vault, '08-Mudanças', 'x');
    mkdirSync(changeDir, { recursive: true });
    assert.throws(() => promoteSpecs(vault, changeDir, ['auth']), /delta/i);
    mkdirSync(join(changeDir, 'specs', 'auth'), { recursive: true });
    writeFileSync(join(changeDir, 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requisito: (nome)\n(comportamento)\n');
    assert.throws(() => promoteSpecs(vault, changeDir, ['auth']), /placeholder/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('parseRequirements: extrai id do heading; retrocompat sem id', () => {
  const md = '## Requisitos\n\n### Requisito: GATE-1 — trava sem verde\ncorpo\n\n### Requisito: sem id\nx\n';
  const r = parseRequirements(md);
  assert.equal(r[0].id, 'GATE-1');
  assert.equal(r[0].name, 'trava sem verde');
  assert.equal(r[1].id, null);
  assert.equal(r[1].name, 'sem id');
});

test('parseRequirements accepts compound requirement ids used by product specs', () => {
  const [req] = parseRequirements('### Requisito: LOGIN-ORBIT-4 — entrada orbital\ncritério\n');
  assert.equal(req.id, 'LOGIN-ORBIT-4');
  assert.equal(req.name, 'entrada orbital');
});

test('applyDelta: casa por id; render mantém "ID — nome"', () => {
  const base = parseRequirements('### Requisito: GATE-1 — antigo\na\n');
  const delta = { added: [], modified: parseRequirements('### Requisito: GATE-1 — novo nome\nb\n'), removed: [] };
  const { reqs } = applyDelta(base, delta);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].id, 'GATE-1');
  assert.equal(reqs[0].name, 'novo nome');
  assert.match(renderSpec('gate', reqs, {}), /### Requisito: GATE-1 — novo nome/);
});

test('effective spec merges ADDED/MODIFIED/REMOVED with provenance', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-effective-'));
  const change = join(vault, '08-Mudanças', 'x');
  try {
    mkdirSync(join(vault, '07-Specs'), { recursive: true });
    mkdirSync(join(change, 'specs', 'auth'), { recursive: true });
    writeFileSync(join(vault, '07-Specs', 'auth.md'), renderSpec('auth', [
      { id: 'AUTH-1', name: 'login', body: 'antigo' },
      { id: 'AUTH-2', name: 'legado', body: 'remover' },
    ]));
    writeFileSync(join(change, 'proposta.md'), '---\nspecs: [auth]\n---\n');
    writeFileSync(join(change, 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requisito: AUTH-3 — logout\nnovo\n\n## MODIFIED Requirements\n### Requisito: AUTH-1 — login\natualizado\n\n## REMOVED Requirements\n### Requisito: AUTH-2 — legado\nremover\n');
    const pkg = buildEffectiveRequirementPackage(vault, change, ['AUTH-1', 'AUTH-3']);
    assert.deepEqual(pkg.errors, []);
    assert.deepEqual(pkg.missing, []);
    assert.equal(pkg.requirements.find((r) => r.id === 'AUTH-1').operation, 'MODIFIED');
    assert.equal(pkg.requirements.find((r) => r.id === 'AUTH-1').body, 'atualizado');
    assert.equal(pkg.requirements.find((r) => r.id === 'AUTH-3').operation, 'ADDED');
    assert.ok(!pkg.specs[0].requirements.some((r) => r.id === 'AUTH-2'));
    assert.equal(pkg.hash.length, 64);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('spec state detects direct living-spec edits', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-state-'));
  try {
    mkdirSync(join(vault, '07-Specs'), { recursive: true });
    const path = join(vault, '07-Specs', 'auth.md');
    writeFileSync(path, renderSpec('auth', [{ id: 'AUTH-1', name: 'login', body: 'v1' }]));
    adoptSpecsState(vault);
    assert.equal(checkSpecsState(vault).ok, true);
    writeFileSync(path, renderSpec('auth', [{ id: 'AUTH-1', name: 'login', body: 'edit direto' }]));
    assert.deepEqual(checkSpecsState(vault).changed, ['auth']);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('baseline conflict is requirement-scoped', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-conflict-'));
  const change = join(vault, '08-Mudanças', 'x');
  try {
    mkdirSync(join(vault, '07-Specs'), { recursive: true });
    mkdirSync(join(change, 'specs', 'auth'), { recursive: true });
    const live = join(vault, '07-Specs', 'auth.md');
    writeFileSync(live, renderSpec('auth', [{ id: 'AUTH-1', name: 'login', body: 'v1' }, { id: 'AUTH-2', name: 'logout', body: 'v1' }]));
    writeFileSync(join(change, 'specs', 'auth', 'spec.md'), '## MODIFIED Requirements\n### Requisito: AUTH-1 — login\nminha mudança\n');
    captureSpecBaseline(vault, change);
    writeFileSync(live, renderSpec('auth', [{ id: 'AUTH-1', name: 'login', body: 'v1' }, { id: 'AUTH-2', name: 'logout', body: 'outra change' }]));
    assert.deepEqual(specConflicts(vault, change, ['auth']), []);
    writeFileSync(live, renderSpec('auth', [{ id: 'AUTH-1', name: 'login', body: 'outra change' }, { id: 'AUTH-2', name: 'logout', body: 'outra change' }]));
    assert.match(specConflicts(vault, change, ['auth'])[0], /AUTH-1 mudou/);
    assert.throws(() => promoteSpecs(vault, change, ['auth']), /conflito de spec/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
