# Spec promotion — Implementation Plan

> Implements `docs/11-spec-promotion.md` (gap 2: the living contract). **For agentic workers:** use superpowers:executing-plans.

**Goal:** `wendkeep change archive` merges a change's per-capability spec deltas (ADDED/MODIFIED/REMOVED) into the living specs in `07-Specs/`, so the spec always reflects current reality.

**Architecture:** New pure lib `hooks/spec-core.mjs` (parse requirements, parse delta, apply, render, promote). `archiveChange` reads the proposta's `specs:` list and calls `promoteSpecs` before moving the change. No external deps.

**Tech Stack:** Node ≥18 ESM, `node --test`.

## Global Constraints

- ESM, no deps. `npm test` = `node --test`. No git → "commit" = **Checkpoint: `npm test` green**.
- Living spec: `07-Specs/<capability>.md`, requisitos as `### Requisito: <nome>` blocks under `## Requisitos`.
- Delta: `08-Mudanças/<slug>/specs/<capability>/spec.md` with `## ADDED/MODIFIED/REMOVED Requirements` sections.
- Identity = requirement NAME. ADDED/MODIFIED both upsert; REMOVED deletes; inconsistencies warn (stderr), never block.
- New lib `hooks/spec-core.mjs` MUST be added to `HOOK_FILES`.
- No circular import: `spec-core.mjs` imports only `node:*` + `obsidian-common.mjs` (defines its own `SPECS_DIR='07-Specs'`). `change-core.mjs` imports FROM `spec-core.mjs`.

## File Structure

- Create `hooks/spec-core.mjs` — `parseRequirements`, `parseDelta`, `applyDelta`, `renderSpec`, `parseSpecsList`, `promoteSpecs`.
- Modify `hooks/change-core.mjs` — `archiveChange` promotes specs; `renderChangeScaffold` seeds a `specs/exemplo/spec.md` delta template.
- Modify `src/change.mjs` — archive CLI prints promoted caps + warnings.
- Modify `src/taxonomy.mjs` — `HOOK_FILES += 'spec-core.mjs'`.
- Tests: `tests/spec-core.test.mjs` (unit), extend `tests/change-cli.test.mjs` (e2e promotion).

---

### Task 1: `hooks/spec-core.mjs` — parse / apply / render / promote

**Files:** Create `hooks/spec-core.mjs`; Modify `src/taxonomy.mjs`; Test `tests/spec-core.test.mjs`.

**Interfaces:** Produces:
- `parseRequirements(md) -> [{name, body}]` (ordered)
- `parseDelta(md) -> {added:[{name,body}], modified:[{name,body}], removed:[name]}`
- `applyDelta(reqs, delta) -> {reqs:[{name,body}], warnings:[string]}`
- `renderSpec(capability, reqs, {footer?}) -> string`
- `parseSpecsList(propostaMd) -> [slug]`
- `promoteSpecs(vaultBase, changeDir, specs, {changeWikilink, dateStr}) -> {promoted:[cap], warnings:[string]}`

- [ ] **Step 1: Failing test** — create `tests/spec-core.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRequirements, parseDelta, applyDelta, renderSpec, parseSpecsList, promoteSpecs } from '../hooks/spec-core.mjs';

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

test('promoteSpecs: applies delta to a fresh living spec', () => {
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
    // second change modifies it
    writeFileSync(join(changeDir, 'specs', 'auth', 'spec.md'), '## MODIFIED Requirements\n### Requisito: Login\nlogin com 2FA\n');
    promoteSpecs(vault, changeDir, ['auth'], { changeWikilink: '[[arq2/proposta]]', dateStr: '2026-07-06' });
    assert.match(readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8'), /login com 2FA/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run → FAIL** — `node --test tests/spec-core.test.mjs`.

- [ ] **Step 3: Implement** `hooks/spec-core.mjs`:
```js
// hooks/spec-core.mjs — living spec (07-Specs) + change delta merge (OpenSpec native).
// Pure parsing/merge + promoteSpecs (fs). No import from change-core (avoids a cycle).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from './obsidian-common.mjs';

const SPECS_DIR = '07-Specs';
const REQ_RE = /^### Requisito:\s*(.+)$/gm;

export function parseRequirements(md) {
  const text = String(md);
  const matches = [...text.matchAll(REQ_RE)];
  const reqs = [];
  for (let i = 0; i < matches.length; i += 1) {
    const name = matches[i][1].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const body = text.slice(start, end).replace(/(\n>[^\n]*)+\s*$/, '').trim();
    reqs.push({ name, body });
  }
  return reqs;
}

export function parseDelta(md) {
  const text = String(md);
  const grab = (label) => {
    const m = text.match(new RegExp(`^##\\s+${label} Requirements\\s*$`, 'm'));
    if (!m) return '';
    const rest = text.slice(m.index + m[0].length);
    const next = rest.search(/^##\s+\w+ Requirements\s*$/m);
    return next === -1 ? rest : rest.slice(0, next);
  };
  return {
    added: parseRequirements(grab('ADDED')),
    modified: parseRequirements(grab('MODIFIED')),
    removed: parseRequirements(grab('REMOVED')).map((r) => r.name),
  };
}

export function applyDelta(reqs, delta) {
  const order = reqs.map((r) => r.name);
  const map = new Map(reqs.map((r) => [r.name, r.body]));
  const warnings = [];
  for (const r of delta.added || []) {
    if (map.has(r.name)) warnings.push(`ADDED já existe: ${r.name}`); else order.push(r.name);
    map.set(r.name, r.body);
  }
  for (const r of delta.modified || []) {
    if (!map.has(r.name)) { warnings.push(`MODIFIED inexistente: ${r.name}`); order.push(r.name); }
    map.set(r.name, r.body);
  }
  for (const name of delta.removed || []) {
    if (!map.has(name)) warnings.push(`REMOVED inexistente: ${name}`);
    map.delete(name);
  }
  const seen = new Set();
  const out = order.filter((n) => map.has(n) && !seen.has(n) && seen.add(n)).map((n) => ({ name: n, body: map.get(n) }));
  return { reqs: out, warnings };
}

export function renderSpec(capability, reqs, { footer } = {}) {
  const blocks = reqs.map((r) => `### Requisito: ${r.name}\n${r.body}`).join('\n\n');
  const foot = footer ? `\n\n> ${footer}\n` : '\n';
  return `---\ntype: spec\ncssclasses:\n  - topic-spec\ntags:\n  - spec\n---\n\n# ${capability}\n\n## Requisitos\n\n${blocks}${foot}`;
}

export function parseSpecsList(propostaMd) {
  const text = String(propostaMd);
  const inline = text.match(/^specs:\s*\[(.*?)\]\s*$/m);
  if (inline) return inline[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  const block = text.match(/^specs:\s*\n((?:[ \t]*-[ \t]*.+\n?)+)/m);
  if (block) return block[1].split('\n').map((l) => l.replace(/^[ \t]*-[ \t]*/, '').trim().replace(/['"]/g, '')).filter(Boolean);
  return [];
}

export function promoteSpecs(vaultBase, changeDir, specs, { changeWikilink, dateStr } = {}) {
  const promoted = [];
  const warnings = [];
  for (const cap of specs) {
    let delta;
    try { delta = parseDelta(readFileSync(join(changeDir, 'specs', cap, 'spec.md'), 'utf8')); }
    catch { warnings.push(`sem delta para ${cap}`); continue; }
    const livePath = join(vaultBase, SPECS_DIR, `${cap}.md`);
    let current = [];
    try { current = parseRequirements(readFileSync(livePath, 'utf8')); } catch { /* nova capability */ }
    const applied = applyDelta(current, delta);
    warnings.push(...applied.warnings.map((w) => `${cap}: ${w}`));
    ensureDir(join(vaultBase, SPECS_DIR));
    const footer = changeWikilink ? `Atualizado por ${changeWikilink} em ${dateStr}.` : '';
    writeFileSync(livePath, renderSpec(cap, applied.reqs, { footer }), 'utf8');
    promoted.push(cap);
  }
  return { promoted, warnings };
}
```
In `src/taxonomy.mjs`, add `'spec-core.mjs'` to `HOOK_FILES` (right after `'change-core.mjs'`).

- [ ] **Step 4: Run → PASS** — `node --test tests/spec-core.test.mjs`.

- [ ] **Step 5: Checkpoint** — `node --check hooks/spec-core.mjs && npm test` (tarball-smoke green now that the HOOK_FILES entry exists).

---

### Task 2: promote on archive + scaffold delta + CLI output

**Files:** Modify `hooks/change-core.mjs`, `src/change.mjs`; Test `tests/change-cli.test.mjs`, `tests/change-core.test.mjs`.

**Interfaces:** Consumes: `parseSpecsList`, `promoteSpecs` (T1). `archiveChange(...)` return gains `promoted: [cap]` + `specWarnings: [string]`. `renderChangeScaffold` output gains a `specDelta` example string.

- [ ] **Step 1: Failing e2e test** — append to `tests/change-cli.test.mjs`:
```js
test('archive promotes spec deltas into 07-Specs (living contract)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-spec-'));
  const spawn = (args) => spawnSync(process.execPath, [BIN, 'change', ...args, '--vault', vault], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    assert.equal(spawn(['new', 'x']).status, 0);
    // declare a capability + author its delta
    writeFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), '---\ntype: change\nstatus: active\nspecs: [auth]\n---\n# x\n');
    mkdirSync(join(vault, '08-Mudanças', 'x', 'specs', 'auth'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requisito: Login\nusuário faz login\n');
    const r = spawn(['archive', 'x']);
    assert.equal(r.status, 0, r.stderr);
    const live = readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8');
    assert.match(live, /### Requisito: Login/);
    assert.match(r.stdout, /auth/); // CLI reports the promoted capability
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run → FAIL** — `node --test tests/change-cli.test.mjs`.

- [ ] **Step 3: Implement** — in `hooks/change-core.mjs`:
  - Add import: `import { parseSpecsList, promoteSpecs } from './spec-core.mjs';`
  - In `archiveChange`, after the gate passes and `destRel`/`changeWikilink` are computed but BEFORE `renameSync`, read the proposta + promote:
```js
  // Promote spec deltas into the living 07-Specs before archiving (deltas travel with the change).
  let promoted = [];
  let specWarnings = [];
  try {
    const specs = parseSpecsList(readFileSync(join(src, 'proposta.md'), 'utf8'));
    if (specs.length) {
      const changeWikilink = wikilinkFromRel(join(destRel, 'proposta'));
      const res = promoteSpecs(vaultBase, src, specs, { changeWikilink, dateStr });
      promoted = res.promoted; specWarnings = res.warnings;
    }
  } catch { /* proposta ilegível — segue só com ADR */ }
```
  Ensure `destRel` + `changeWikilink` exist above this point (reorder if needed — compute `destRel` and the wikilink before promotion; `renameSync` stays after). Include `promoted`/`specWarnings` in the returned object: `return { ok: true, failing: [], archivedRel: destRel, adrRel, promoted, specWarnings };`
  - Optionally list promoted caps in the ADR body: after the "concluída e arquivada." line add, when `promoted.length`: `\n\nCapabilities: ${promoted.map((c) => wikilinkFromRel(join(SPECS_DIR, c))).join(', ')}.`
  - In `renderChangeScaffold`, add to the returned object a `specDelta` example (so `newChange` can seed `specs/exemplo/spec.md`):
```js
  const specDelta = `## ADDED Requirements\n### Requisito: (nome)\n(comportamento / cenários)\n\n## MODIFIED Requirements\n\n## REMOVED Requirements\n`;
  return { proposta, design, tarefas, specDelta };
```
  - In `newChange`, seed the example delta (non-destructive):
```js
  const exampleDelta = join(dir, 'specs', 'exemplo', 'spec.md');
  if (!existsSync(exampleDelta)) { mkdirSync(join(dir, 'specs', 'exemplo'), { recursive: true }); writeFileSync(exampleDelta, files.specDelta, 'utf8'); }
```
  (`files` already holds the scaffold; `mkdirSync`/`existsSync`/`writeFileSync` already imported.)

  In `src/change.mjs` archive branch, after success print promoted + warnings:
```js
    if (r.promoted && r.promoted.length) process.stdout.write(`specs promovidas: ${r.promoted.join(', ')}\n`);
    if (r.specWarnings && r.specWarnings.length) for (const w of r.specWarnings) process.stderr.write(`  aviso spec: ${w}\n`);
```

- [ ] **Step 4: Run → PASS** — `node --test tests/change-cli.test.mjs`.

- [ ] **Step 5: Guard the scaffold test** — the existing `renderChangeScaffold` test in `tests/change-core.test.mjs` destructures `{ proposta, design, tarefas }`; adding `specDelta` is additive (no change needed). Add one assertion there: `assert.match(specDelta, /ADDED Requirements/);` (destructure `specDelta` too).

- [ ] **Step 6: Checkpoint** — `node --check hooks/change-core.mjs src/change.mjs && npm test` green.

---

## Self-Review

- **Spec coverage (docs/11):** delta parse (T1) ✓; multi-capability promote (T1 `promoteSpecs` loops `specs`) ✓; archive wiring + ADR link (T2) ✓; scaffold delta template (T2) ✓; living-spec render + footer link (T1) ✓; warnings-not-block (T1 `applyDelta`, surfaced by CLI T2) ✓.
- **Placeholder scan:** none — full code.
- **Type consistency:** `{name, body}` req shape + `{added,modified,removed}` delta + `promoteSpecs -> {promoted, warnings}` consistent across T1/T2; `archiveChange` return extended additively (Pilar B/C callers ignore new fields).
- **Cycle check:** `spec-core` imports only `node:*` + `obsidian-common`; `change-core` imports `spec-core`. One direction. ✓

## Verification (end-to-end)

1. `change new x`; set proposta `specs: [auth]`; write `specs/auth/spec.md` with an ADDED requisito.
2. `change archive x` → `07-Specs/auth.md` created with the requisito + footer link; CLI prints `specs promovidas: auth`.
3. A later change with `## MODIFIED Requirements` for `Login` → `auth.md` updates in place.
4. `npm test` green (spec-core unit + promotion e2e).
