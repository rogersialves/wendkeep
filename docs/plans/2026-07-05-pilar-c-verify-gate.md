# Pilar C — Verify + evidence gate (Implementation Plan)

> Implements Pilar C of `docs/10-a2-native-harness.md`. Replaces the `gateGreen` stub from Pilar B with a real per-task sensor gate. **For agentic workers:** use superpowers:executing-plans.

**Goal:** `wendkeep verify` runs a change's required sensors and records evidence; `wendkeep change archive` then blocks unless every sensor a task declared is green.

**Architecture:** Native config `wendkeep.sensors.json` at project root (zero dep on dotcontext/`.context`). Tasks declare `[sensor:<id>]`. `hooks/sensors-core.mjs` (pure-ish: load/run/evaluate/required) drives `wendkeep verify` (writes `08-Mudanças/<slug>/evidencia.json`) and the real gate the archive CLI injects into `archiveChange`.

**Tech Stack:** Node ≥18 ESM, `node --test`, `spawnSync` (injectable for tests).

## Global Constraints

- ESM, no external deps. `npm test` = `node --test`. No git → "commit" = **Checkpoint: `npm test` green**.
- `wendkeep.sensors.json` lives at PROJECT ROOT; sensor commands run with cwd = project root. Change + evidence live in the VAULT (`08-Mudanças/<slug>/`).
- Sensor schema (reuse `renderSensorsJson` from `src/dotcontext-seed.mjs`): `{version:1, sensors:[{id,name,description,severity,command}]}`.
- New lib `hooks/sensors-core.mjs` MUST be added to `HOOK_FILES` in `src/taxonomy.mjs`.
- Gate is **per-task**: only sensors declared by the change's tasks are required; a change with no `[sensor:]` hints archives freely.

## File Structure

- Create `hooks/sensors-core.mjs` — `loadSensors`, `runSensors`, `evaluateGate`, `requiredSensors`.
- Modify `hooks/change-core.mjs` — extend `parseTasks` to extract `[sensor:<id>]` into `task.sensor`.
- Create `src/verify.mjs` — `runVerify(argv)` (`wendkeep verify`).
- Modify `src/change.mjs` — `archive` builds the real gate (reads evidence + required) and passes it to `archiveChange`.
- Modify `bin/wendkeep.mjs` — add `verify` command + help.
- Modify `src/init.mjs` — seed `wendkeep.sensors.json` at project root.
- Modify `src/taxonomy.mjs` — `HOOK_FILES += 'sensors-core.mjs'`.
- Tests: `tests/sensors-core.test.mjs`, extend `tests/change-core.test.mjs` (parseTasks sensor), `tests/change-cli.test.mjs` (gate e2e).

---

### Task 1: `HOOK_FILES` + `parseTasks` extracts `[sensor:<id>]`

**Files:** Modify `src/taxonomy.mjs`, `hooks/change-core.mjs`; Test `tests/change-core.test.mjs`.

**Interfaces:** Produces: `parseTasks(md)` items gain optional `sensor` (string|undefined); `HOOK_FILES` includes `'sensors-core.mjs'`.

- [ ] **Step 1: Failing test** — append to `tests/change-core.test.mjs`:
```js
test('parseTasks: extracts [sensor:id] hint, strips it from text', () => {
  const t = parseTasks('- [ ] 1.1 wire toggle [sensor:tests]\n- [ ] 1.2 plain\n');
  assert.equal(t[0].sensor, 'tests');
  assert.equal(t[0].text, 'wire toggle');
  assert.equal(t[1].sensor, undefined);
});
```
Also add a taxonomy assertion to the existing first test: `assert.ok(HOOK_FILES.includes('sensors-core.mjs'));`

- [ ] **Step 2: Run → FAIL** — `node --test tests/change-core.test.mjs`.

- [ ] **Step 3: Implement** — in `hooks/change-core.mjs` replace `parseTasks`:
```js
export function parseTasks(md) {
  const tasks = [];
  const re = /^-\s+\[( |x)\]\s+(\S+)\s+(.*)$/gm;
  const sensorRe = /\[sensor:\s*([\w.-]+)\]/;
  let m;
  while ((m = re.exec(String(md))) !== null) {
    let text = m[3].trim();
    const sm = text.match(sensorRe);
    const sensor = sm ? sm[1] : undefined;
    if (sm) text = text.replace(sensorRe, '').replace(/\s+/g, ' ').trim();
    tasks.push({ id: m[2], text, done: m[1] === 'x', ...(sensor ? { sensor } : {}) });
  }
  return tasks;
}
```
In `src/taxonomy.mjs` add `'sensors-core.mjs'` to `HOOK_FILES` (near `change-core.mjs`).

- [ ] **Step 4: Run → PASS** — `node --test tests/change-core.test.mjs`.

- [ ] **Step 5: Checkpoint** — `npm test` (tarball-smoke will fail until Task 2 creates `sensors-core.mjs`; acceptable mid-task — verify the change-core file passes, full green after Task 2).

---

### Task 2: `hooks/sensors-core.mjs` — load / run / evaluate / required

**Files:** Create `hooks/sensors-core.mjs`; Test `tests/sensors-core.test.mjs`.

**Interfaces:** Produces:
- `loadSensors(projectRoot, file?) -> sensors[]`
- `requiredSensors(tasks) -> string[]` (distinct `task.sensor`)
- `runSensors(sensors, ids, { spawn?, cwd?, now }) -> [{ id, status:'green'|'red', ts }]`
- `evaluateGate(evidence, requiredIds) -> { ok, failing[] }`

- [ ] **Step 1: Failing test** — create `tests/sensors-core.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSensors, requiredSensors, runSensors, evaluateGate } from '../hooks/sensors-core.mjs';

test('requiredSensors: distinct sensor ids from tasks', () => {
  assert.deepEqual(requiredSensors([{ sensor: 'tests' }, { sensor: 'tests' }, { sensor: 'lint' }, {}]), ['tests', 'lint']);
});

test('loadSensors: reads wendkeep.sensors.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-sen-'));
  try {
    writeFileSync(join(dir, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'tests', command: 'x' }] }));
    assert.equal(loadSensors(dir)[0].id, 'tests');
    assert.deepEqual(loadSensors(join(dir, 'nope')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runSensors: green on exit 0, red on non-zero', () => {
  const sensors = [{ id: 'ok', command: 'true' }, { id: 'bad', command: 'false' }];
  const fakeSpawn = (_cmd, _args, opts) => ({ status: opts._forceStatus });
  // stub via command mapping
  const spawn = (cmd) => ({ status: cmd.includes('true') ? 0 : 1 });
  const ev = runSensors(sensors, ['ok', 'bad'], { spawn, now: '2026-07-05T00:00:00Z' });
  const byId = Object.fromEntries(ev.map((e) => [e.id, e.status]));
  assert.equal(byId.ok, 'green');
  assert.equal(byId.bad, 'red');
});

test('evaluateGate: ok when all required green; failing lists missing/red', () => {
  const ev = [{ id: 'tests', status: 'green' }, { id: 'lint', status: 'red' }];
  assert.deepEqual(evaluateGate(ev, ['tests']), { ok: true, failing: [] });
  assert.deepEqual(evaluateGate(ev, ['tests', 'lint', 'typecheck']), { ok: false, failing: ['lint', 'typecheck'] });
});
```

- [ ] **Step 2: Run → FAIL** — `node --test tests/sensors-core.test.mjs`.

- [ ] **Step 3: Implement** `hooks/sensors-core.mjs`:
```js
// hooks/sensors-core.mjs — native sensor runner + evidence gate (Pilar C).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadSensors(projectRoot, file = 'wendkeep.sensors.json') {
  try {
    const data = JSON.parse(readFileSync(join(projectRoot, file), 'utf8'));
    return Array.isArray(data.sensors) ? data.sensors : [];
  } catch {
    return [];
  }
}

export function requiredSensors(tasks) {
  return [...new Set((tasks || []).map((t) => t.sensor).filter(Boolean))];
}

export function runSensors(sensors, ids, { spawn = spawnSync, cwd, now } = {}) {
  const byId = Object.fromEntries((sensors || []).map((s) => [s.id, s]));
  const ts = now || new Date().toISOString();
  const evidence = [];
  for (const id of ids) {
    const s = byId[id];
    if (!s) { evidence.push({ id, status: 'red', ts, note: 'sensor não definido' }); continue; }
    const r = spawn(s.command, [], { cwd, shell: true, stdio: 'ignore' });
    evidence.push({ id, status: (r.status ?? 1) === 0 ? 'green' : 'red', ts });
  }
  return evidence;
}

export function evaluateGate(evidence, requiredIds) {
  const byId = Object.fromEntries((evidence || []).map((e) => [e.id, e.status]));
  const failing = (requiredIds || []).filter((id) => byId[id] !== 'green');
  return { ok: failing.length === 0, failing };
}
```

- [ ] **Step 4: Run → PASS** — `node --test tests/sensors-core.test.mjs`.

- [ ] **Step 5: Checkpoint** — `node --check hooks/sensors-core.mjs && npm test` green.

---

### Task 3: `wendkeep verify` CLI

**Files:** Create `src/verify.mjs`; Modify `bin/wendkeep.mjs`; Test `tests/change-cli.test.mjs`.

**Interfaces:** Consumes: `loadSensors`, `runSensors`, `requiredSensors` (T2), `parseTasks` (T1), `activeChange` (Pilar B). Produces: `runVerify(argv)` writes `08-Mudanças/<slug>/evidencia.json`, exit 1 if any critical required sensor red.

- [ ] **Step 1: Failing e2e test** — append to `tests/change-cli.test.mjs`:
```js
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

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
```

- [ ] **Step 2: Run → FAIL** — `node --test tests/change-cli.test.mjs`.

- [ ] **Step 3: Implement** `src/verify.mjs`:
```js
// `wendkeep verify [--change <slug>]` — run a change's task sensors, record evidence.
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseTasks, activeChange } from '../hooks/change-core.mjs';
import { loadSensors, requiredSensors, runSensors, evaluateGate } from '../hooks/sensors-core.mjs';

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

export function runVerify(argv) {
  const vaultRaw = opt(argv, '--vault') || process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultRaw) { process.stderr.write('wendkeep verify: no vault (--vault or OBSIDIAN_VAULT_PATH).\n'); process.exit(2); }
  const vaultBase = isAbsolute(vaultRaw) ? vaultRaw : resolve(process.cwd(), vaultRaw);
  const projectRoot = resolve(opt(argv, '--project') || process.cwd());
  const slug = opt(argv, '--change') || activeChange(vaultBase);
  if (!slug) { process.stderr.write('wendkeep verify: no change (--change or active).\n'); process.exit(2); }

  const changeDir = join(vaultBase, '08-Mudanças', slug);
  let tarefas = '';
  try { tarefas = readFileSync(join(changeDir, 'tarefas.md'), 'utf8'); }
  catch { process.stderr.write(`wendkeep verify: change not found: ${slug}\n`); process.exit(2); }

  const ids = requiredSensors(parseTasks(tarefas));
  const sensors = loadSensors(projectRoot);
  const evidence = runSensors(sensors, ids, { cwd: projectRoot });
  writeFileSync(join(changeDir, 'evidencia.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  const bySeverity = Object.fromEntries(sensors.map((s) => [s.id, s.severity || 'critical']));
  const critical = ids.filter((id) => bySeverity[id] !== 'warning');
  const { ok, failing } = evaluateGate(evidence, critical);
  for (const e of evidence) process.stdout.write(`  ${e.status === 'green' ? '✓' : '✗'} ${e.id}\n`);
  if (!ok) { process.stderr.write(`verify: critical sensors red: ${failing.join(', ')}\n`); process.exit(1); }
  process.stdout.write(`verify OK (${ids.length} sensor(s))\n`);
  process.exit(0);
}
```
In `bin/wendkeep.mjs`, after the `change` case:
```js
    case 'verify': {
      const { runVerify } = await import('../src/verify.mjs');
      runVerify(rest);
      break;
    }
```
And HELP after the `change` line:
```
  wendkeep verify [--change s]  Run a change's task sensors + record evidence (gate).
```

- [ ] **Step 4: Run → PASS** — `node --test tests/change-cli.test.mjs`.

- [ ] **Step 5: Checkpoint** — `node --check src/verify.mjs bin/wendkeep.mjs && npm test` green.

---

### Task 4: Real gate wired into `change archive`

**Files:** Modify `src/change.mjs`; Test `tests/change-cli.test.mjs`.

**Interfaces:** Consumes: `evaluateGate` (T2), `requiredSensors`/`parseTasks`, `archiveChange` (Pilar B). The archive CLI builds a `gate(changeDir)` that reads `evidencia.json` + the change's required sensors.

- [ ] **Step 1: Failing e2e test** — append to `tests/change-cli.test.mjs`:
```js
test('archive blocked until verify green when a task declares a sensor', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-gate-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-gatep-'));
  const spawn = (args) => spawnSync(process.execPath, [BIN, ...args, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [ ] 1.1 do it [sensor:ok]\n');
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'ok', severity: 'critical', command: 'node -e "process.exit(0)"' }] }));
    // archive without evidence -> blocked
    const blocked = spawn(['change', 'archive', 'x']);
    assert.equal(blocked.status, 1, 'archive blocked without evidence');
    assert.match(blocked.stderr, /BLOCKED/);
    // verify green, then archive ok
    assert.equal(spawn(['verify']).status, 0);
    const ok = spawn(['change', 'archive', 'x']);
    assert.equal(ok.status, 0, ok.stderr);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run → FAIL** (archive currently uses stub `gateGreen`, always ok) — `node --test tests/change-cli.test.mjs`.

- [ ] **Step 3: Implement** — in `src/change.mjs`, add imports:
```js
import { newChange, activeChange, listChanges, parseTasks, archiveChange } from '../hooks/change-core.mjs';
import { evaluateGate, requiredSensors } from '../hooks/sensors-core.mjs';
```
Replace the `archive` branch's `archiveChange(...)` call to build the real gate:
```js
  if (sub === 'archive') {
    const slug = slugArg() || activeChange(vaultBase);
    if (!slug) { process.stderr.write('wendkeep change archive: missing <slug> and no active change\n'); process.exit(2); }
    const changeDir = join(vaultBase, '08-Mudanças', slug);
    const gate = (dir) => {
      let required = [];
      try { required = requiredSensors(parseTasks(readFileSync(join(dir, 'tarefas.md'), 'utf8'))); } catch { /* none */ }
      let evidence = [];
      try { evidence = JSON.parse(readFileSync(join(dir, 'evidencia.json'), 'utf8')); } catch { /* none */ }
      return evaluateGate(evidence, required);
    };
    const r = archiveChange(vaultBase, slug, { dateStr: today(), adrNum: getNextAdrNumber(vaultBase), gate });
    if (!r.ok) {
      process.stderr.write(`change archive BLOCKED (gate): failing sensors: ${r.failing.join(', ')} — run \`wendkeep verify\`.\n`);
      process.exit(1);
    }
    process.stdout.write(`archived: ${r.archivedRel}; ADR: ${r.adrRel}\n`);
    process.exit(0);
  }
```
(The `gate` closure ignores its `dir` arg's default and uses `changeDir`; keep the signature `(dir)` — pass `changeDir` explicitly by using it in the closure. Ensure `readFileSync`/`join` are imported — they already are.)

- [ ] **Step 4: Run → PASS** — `node --test tests/change-cli.test.mjs`.

- [ ] **Step 5: Checkpoint** — `node --check src/change.mjs && npm test` green.

---

### Task 5: `init` seeds `wendkeep.sensors.json`

**Files:** Modify `src/init.mjs`; Test — extend an init test or add a small assertion.

**Interfaces:** Consumes: `renderSensorsJson` from `src/dotcontext-seed.mjs` (reused). After init, `<project>/wendkeep.sensors.json` exists with the `memory-validation` sensor.

- [ ] **Step 1: Failing test** — append to `tests/validate-memory-cli.test.mjs`:
```js
test('init seeds wendkeep.sensors.json at project root', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-sensinit-'));
  const projectDir = join(parent, 'Proj');
  mkdirSync(projectDir);
  try {
    const r = spawnSync(process.execPath, [BIN, 'init', '--project', projectDir, '--no-mcp', '--no-companions', '--no-colors', '--yes'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(readFileSync(join(projectDir, 'wendkeep.sensors.json'), 'utf8'));
    assert.ok(s.sensors.some((x) => x.id === 'memory-validation'));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run → FAIL** — `node --test tests/validate-memory-cli.test.mjs`.

- [ ] **Step 3: Implement** — in `src/init.mjs`: add import `import { seedDotcontext, globalHasDotcontext, resolveDotcontextSkipMcp, renderSensorsJson } from './dotcontext-seed.mjs';` (extend existing import). After the change/spec seed block:
```js
  // Seed the native sensor config (Pilar C) at project root — non-destructive.
  const sensorsFile = join(projectPath, 'wendkeep.sensors.json');
  if (!existsSync(sensorsFile)) {
    let scripts = {};
    try { scripts = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8')).scripts || {}; } catch { /* none */ }
    writeFileSync(sensorsFile, renderSensorsJson(scripts), 'utf8');
  }
```
Ensure `renderSensorsJson` is exported from `src/dotcontext-seed.mjs` (it already is).

- [ ] **Step 4: Run → PASS** — `node --test tests/validate-memory-cli.test.mjs`.

- [ ] **Step 5: Checkpoint** — `node --check src/init.mjs && npm test` green.

---

## Self-Review

- **Spec coverage:** verify CLI (T3) ✓; real gate on archive (T4) ✓; per-task `[sensor:]` (T1) ✓; sensor runner/evaluate (T2) ✓; native root config + seed (T5) ✓. docs/10 Pilar C summary fully covered.
- **Placeholder scan:** none — real code throughout.
- **Type consistency:** `loadSensors/requiredSensors/runSensors/evaluateGate` signatures consistent across T2–T4; evidence shape `{id,status,ts}` consistent; gate `(dir)->{ok,failing}` matches `archiveChange`'s injected `gate` from Pilar B.

## Verification (end-to-end)

1. `wendkeep change new x`; add a task `- [ ] 1.1 … [sensor:tests]`; seed `wendkeep.sensors.json` with a `tests` sensor.
2. `wendkeep change archive x` → **BLOCKED** (no evidence).
3. `wendkeep verify` (green sensor) → `evidencia.json` written; `wendkeep change archive x` → succeeds, ADR minted.
4. `npm test` green (sensors-core unit + gate e2e).
