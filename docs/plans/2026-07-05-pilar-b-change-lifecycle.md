# Pilar B — Change/spec lifecycle (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a native, zero-dep change/spec lifecycle to wendkeep — `wendkeep change new/list/show/archive`, artifacts in the vault (`08-Mudanças/`, `07-Specs/`), wikilinked to sessions, with the active change injected at SessionStart.

**Architecture:** A vault-facing lib `hooks/change-core.mjs` (pure-ish: scaffold/parse/active-pointer/archive/inject) consumed by both a `src/change.mjs` CLI runner (via `bin/wendkeep.mjs change`) and the `hooks/brain-inject.mjs` SessionStart hook. Archive calls a `gate(changeDir)` interface that is a `{ok:true}` stub in Pilar B (Pilar C replaces it). Completed changes move to `_arquivo/` and mint an ADR into `04-Decisões/` reusing existing ADR helpers.

**Tech Stack:** Node ≥18 ESM, `node --test`, existing wendkeep hook libs (`obsidian-common.mjs`, `linked-notes.mjs`, `brain-inject.mjs`).

## Global Constraints

- ESM only (`.mjs`), no external runtime deps. Run tests with `node --test` (`npm test`).
- wendkeep is **not a git repo** — the "commit" gate is replaced by **Checkpoint: `npm test` green**. Git init is out of scope (tracked in `docs/09`).
- New vault folders keep the PT-BR accented convention (like `02-Sessões`, `04-Decisões`): `07-Specs`, `08-Mudanças`.
- MVP decisions (from `docs/10-a2-native-harness.md`): exactly **one active change** (pointer `.brain/CURRENT_CHANGE.md`); contract lives in `07-Specs/`; `apply` is skill-driven (no CLI `apply`); the gate is a stub here.
- Package `files` already ship `hooks/` and `src/`; new lib `hooks/change-core.mjs` MUST be added to `HOOK_FILES` in `src/taxonomy.mjs` so the tarball smoke test covers it.
- Vault path resolves via `getVaultBase(input)` / `OBSIDIAN_VAULT_PATH` — never hardcode.

## File Structure

- Create `hooks/change-core.mjs` — vault change lib (scaffold, parseTasks, active pointer, archiveChange, buildActiveChangeInjection). Imported by the CLI runner and brain-inject. Added to `HOOK_FILES` (lib, NOT a runnable hook).
- Create `src/change.mjs` — `runChange(argv)` CLI dispatcher (new/list/show/archive).
- Modify `bin/wendkeep.mjs` — add `change` subcommand + help.
- Modify `src/taxonomy.mjs` — `VAULT_FOLDERS += ['07-Specs','08-Mudanças']`; `HOOK_FILES += 'change-core.mjs'`.
- Modify `hooks/brain-inject.mjs` — append the active-change block to the SessionStart injection.
- Modify `hooks/session-stop.mjs` — add a `Change ativa: [[…]]` line to the session note when a change is active (bidirectional graph link).
- Modify `src/vault-theme.mjs` — add `topic-change`/`topic-spec` note accents + graph color groups for the 2 new folders.
- Modify `src/init.mjs` — seed `07-Specs/README.md` + `Templates/Change.md`.
- Create tests: `tests/change-core.test.mjs`, `tests/change-cli.test.mjs`.

---

### Task 1: Vault folders + taxonomy wiring

**Files:**
- Modify: `src/taxonomy.mjs` (VAULT_FOLDERS, HOOK_FILES)
- Test: `tests/change-core.test.mjs` (new file, first assertions)

**Interfaces:**
- Produces: `VAULT_FOLDERS` now includes `'07-Specs'`, `'08-Mudanças'`; `HOOK_FILES` includes `'change-core.mjs'`.

- [ ] **Step 1: Write the failing test**

Create `tests/change-core.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VAULT_FOLDERS, HOOK_FILES } from '../src/taxonomy.mjs';

test('taxonomy: change/spec folders + change-core lib registered', () => {
  assert.ok(VAULT_FOLDERS.includes('07-Specs'));
  assert.ok(VAULT_FOLDERS.includes('08-Mudanças'));
  assert.ok(HOOK_FILES.includes('change-core.mjs'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/change-core.test.mjs`
Expected: FAIL (folders/lib not present).

- [ ] **Step 3: Implement**

In `src/taxonomy.mjs`, add to `VAULT_FOLDERS` after `'06-Aprendizados'`:
```js
  '06-Aprendizados',
  '07-Specs',
  '08-Mudanças',
  'Templates',
```
Add to `HOOK_FILES` (after `'brain-core.mjs'` or near the libs):
```js
  'change-core.mjs',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/change-core.test.mjs`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npm test` — full suite green (init integration tests now create 2 extra folders; they assert on `.length`/specific folders, not exact count — verify none break; if an init test asserts exact folder count, update it to the new count).

---

### Task 2: Change scaffold + `wendkeep change new`

**Files:**
- Create: `hooks/change-core.mjs`
- Create: `src/change.mjs`
- Modify: `bin/wendkeep.mjs`
- Test: `tests/change-core.test.mjs`, `tests/change-cli.test.mjs`

**Interfaces:**
- Produces:
  - `renderChangeScaffold({ slug, sessionRel, dateStr }) -> { proposta, design, tarefas }` (strings)
  - `changeDirRel(slug) -> '08-Mudanças/<slug>'`
  - `newChange(vaultBase, slug, { sessionRel, dateStr }) -> { rel, created:boolean }` (creates the 3 files if absent; sets active pointer)
  - `setActiveChange(vaultBase, slug)` / `activeChange(vaultBase) -> slug|''` (pointer `.brain/CURRENT_CHANGE.md`)
  - `runChange(argv)` dispatches `new`.

- [ ] **Step 1: Write the failing test (scaffold + pointer, pure/unit)**

Append to `tests/change-core.test.mjs`:
```js
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderChangeScaffold, newChange, activeChange, setActiveChange } from '../hooks/change-core.mjs';

test('renderChangeScaffold: frontmatter + session wikilink + task line', () => {
  const { proposta, design, tarefas } = renderChangeScaffold({
    slug: 'dark-mode', sessionRel: '02-Sessões/2026/07-JUL/DIA 05/10-00-x', dateStr: '2026-07-05',
  });
  assert.match(proposta, /type: change/);
  assert.match(proposta, /status: active/);
  assert.match(proposta, /topic-change/);
  assert.match(proposta, /\[\[02-Sessões\/2026\/07-JUL\/DIA 05\/10-00-x\]\]/);
  assert.match(design, /# dark-mode/);
  assert.match(tarefas, /- \[ \] 1\.1/);
});

test('newChange: creates the 3 files + active pointer, non-destructive', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-chg-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  try {
    const r = newChange(vault, 'dark-mode', { sessionRel: '02-Sessões/x', dateStr: '2026-07-05' });
    assert.equal(r.created, true);
    for (const f of ['proposta.md', 'design.md', 'tarefas.md']) {
      assert.ok(existsSync(join(vault, '08-Mudanças', 'dark-mode', f)), `${f} created`);
    }
    assert.equal(activeChange(vault), 'dark-mode');
    // re-run does not clobber
    const again = newChange(vault, 'dark-mode', { sessionRel: '02-Sessões/x', dateStr: '2026-07-05' });
    assert.equal(again.created, false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/change-core.test.mjs`
Expected: FAIL (module `hooks/change-core.mjs` missing).

- [ ] **Step 3: Implement `hooks/change-core.mjs`**

```js
// hooks/change-core.mjs
// Native change/spec lifecycle in the vault (Pilar B). Vault-facing lib consumed by
// the `wendkeep change` CLI and the brain-inject hook. No external deps.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wikilinkFromRel } from './obsidian-common.mjs';

export const CHANGES_DIR = '08-Mudanças';
export const SPECS_DIR = '07-Specs';
export const ARCHIVE_DIR = '_arquivo';
const POINTER = '.brain/CURRENT_CHANGE.md';

export function changeDirRel(slug) {
  return join(CHANGES_DIR, slug);
}

export function renderChangeScaffold({ slug, sessionRel, dateStr }) {
  const source = sessionRel ? `\n  - "${wikilinkFromRel(sessionRel)}"` : ' []';
  const proposta = `---
type: change
status: active
date: ${dateStr}
cssclasses:
  - topic-change
tags:
  - mudanca
source:${source}
specs: []
---

# ${slug}

## Por quê

(motivo da mudança)

## O que muda

(escopo da mudança)
`;
  const design = `# ${slug} — design

## Abordagem

(abordagem técnica)
`;
  const tarefas = `# ${slug} — tarefas

- [ ] 1.1 (primeira tarefa)
`;
  return { proposta, design, tarefas };
}

export function activeChange(vaultBase) {
  try {
    const m = readFileSync(join(vaultBase, POINTER), 'utf8').match(/^change:\s*(.+)$/m);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

export function setActiveChange(vaultBase, slug) {
  const p = join(vaultBase, POINTER);
  mkdirSync(join(vaultBase, '.brain'), { recursive: true });
  writeFileSync(p, `change: ${slug}\n`, 'utf8');
}

export function clearActiveChange(vaultBase) {
  const p = join(vaultBase, POINTER);
  if (existsSync(p)) writeFileSync(p, 'change:\n', 'utf8');
}

export function newChange(vaultBase, slug, { sessionRel = '', dateStr }) {
  const dir = join(vaultBase, CHANGES_DIR, slug);
  const existed = existsSync(join(dir, 'proposta.md'));
  mkdirSync(dir, { recursive: true });
  const files = renderChangeScaffold({ slug, sessionRel, dateStr });
  const write = (name, content) => {
    const f = join(dir, name);
    if (!existsSync(f)) writeFileSync(f, content, 'utf8');
  };
  write('proposta.md', files.proposta);
  write('design.md', files.design);
  write('tarefas.md', files.tarefas);
  setActiveChange(vaultBase, slug);
  return { rel: changeDirRel(slug), created: !existed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/change-core.test.mjs`
Expected: PASS.

- [ ] **Step 5: Implement `src/change.mjs` + wire the CLI**

Create `src/change.mjs`:
```js
// `wendkeep change <sub>` — native change lifecycle CLI.
import { isAbsolute, resolve } from 'node:path';
import { newChange, activeChange } from '../hooks/change-core.mjs';

function resolveVault(argv) {
  let vault;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') vault = argv[++i];
    else if (a.startsWith('--vault=')) vault = a.slice(8);
  }
  const base = vault || process.env.OBSIDIAN_VAULT_PATH;
  if (!base) {
    process.stderr.write('wendkeep change: no vault. Pass --vault <path> or set OBSIDIAN_VAULT_PATH.\n');
    process.exit(2);
  }
  return isAbsolute(base) ? base : resolve(process.cwd(), base);
}

function today() {
  // dateStr is passed by the caller in tests; the CLI derives it once here.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function runChange(argv) {
  const [sub, ...rest] = argv;
  const vaultBase = resolveVault(rest);
  if (sub === 'new') {
    const slug = rest.find((a) => !a.startsWith('-'));
    if (!slug) { process.stderr.write('wendkeep change new: missing <slug>\n'); process.exit(2); }
    const r = newChange(vaultBase, slug, { dateStr: today() });
    process.stdout.write(`change ${r.created ? 'created' : 'exists'}: ${r.rel} (active)\n`);
    process.exit(0);
  }
  process.stderr.write(`wendkeep change: unknown subcommand "${sub}". Known: new, list, show, archive.\n`);
  process.exit(2);
}
```

In `bin/wendkeep.mjs` main switch, after the `sync-defs` case:
```js
    case 'change': {
      const { runChange } = await import('../src/change.mjs');
      runChange(rest);
      break;
    }
```
And add to HELP after the `sync-defs` line:
```
  wendkeep change <sub>        Change lifecycle: new <slug> | list | show <slug> | archive <slug>.
```

- [ ] **Step 6: Write the CLI e2e test**

Create `tests/change-cli.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
```

- [ ] **Step 7: Run + Checkpoint**

Run: `node --check hooks/change-core.mjs && node --check src/change.mjs && node --check bin/wendkeep.mjs && npm test`
Expected: all green. **Checkpoint.**

---

### Task 3: `parseTasks` + `wendkeep change list` / `show`

**Files:**
- Modify: `hooks/change-core.mjs`, `src/change.mjs`
- Test: `tests/change-core.test.mjs`

**Interfaces:**
- Produces:
  - `parseTasks(md) -> [{ id, text, done }]`
  - `listChanges(vaultBase) -> { active: string[], archived: string[] }`
  - `runChange` handles `list`, `show <slug>`.

- [ ] **Step 1: Write the failing test**

Append to `tests/change-core.test.mjs`:
```js
import { parseTasks, listChanges } from '../hooks/change-core.mjs';
import { writeFileSync } from 'node:fs';

test('parseTasks: numbered checklist with done state', () => {
  const md = '# t\n\n- [ ] 1.1 do thing\n- [x] 1.2 done thing\nnot a task\n';
  const t = parseTasks(md);
  assert.equal(t.length, 2);
  assert.deepEqual(t[0], { id: '1.1', text: 'do thing', done: false });
  assert.equal(t[1].done, true);
});

test('listChanges: separates active dirs from _arquivo', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-list-'));
  try {
    mkdirSync(join(vault, '08-Mudanças', 'a'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'a', 'proposta.md'), 'x');
    mkdirSync(join(vault, '08-Mudanças', '_arquivo', '2026-07-05-b'), { recursive: true });
    const l = listChanges(vault);
    assert.deepEqual(l.active, ['a']);
    assert.deepEqual(l.archived, ['2026-07-05-b']);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `node --test tests/change-core.test.mjs` — FAIL (functions missing).

- [ ] **Step 3: Implement in `hooks/change-core.mjs`**

```js
export function parseTasks(md) {
  const tasks = [];
  const re = /^-\s+\[( |x)\]\s+(\S+)\s+(.*)$/gm;
  let m;
  while ((m = re.exec(String(md))) !== null) {
    tasks.push({ id: m[2], text: m[3].trim(), done: m[1] === 'x' });
  }
  return tasks;
}

export function listChanges(vaultBase) {
  const base = join(vaultBase, CHANGES_DIR);
  const active = [];
  let archived = [];
  try {
    for (const name of readdirSync(base)) {
      if (name === ARCHIVE_DIR) continue;
      if (existsSync(join(base, name, 'proposta.md'))) active.push(name);
    }
  } catch { /* no changes dir yet */ }
  try {
    archived = readdirSync(join(base, ARCHIVE_DIR)).filter((n) => !n.startsWith('.'));
  } catch { /* none */ }
  return { active, archived };
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `node --test tests/change-core.test.mjs` — PASS.

- [ ] **Step 5: Wire `list` + `show` in `src/change.mjs`**

Add imports: `import { newChange, activeChange, listChanges, parseTasks } from '../hooks/change-core.mjs';` and `import { readFileSync } from 'node:fs';` and `join` from path.
In `runChange`, before the unknown-subcommand line:
```js
  if (sub === 'list') {
    const { active, archived } = listChanges(vaultBase);
    const cur = activeChange(vaultBase);
    process.stdout.write(`active: ${active.map((s) => (s === cur ? `*${s}` : s)).join(', ') || '(none)'}\n`);
    process.stdout.write(`archived: ${archived.join(', ') || '(none)'}\n`);
    process.exit(0);
  }
  if (sub === 'show') {
    const slug = rest.find((a) => !a.startsWith('-'));
    if (!slug) { process.stderr.write('wendkeep change show: missing <slug>\n'); process.exit(2); }
    let md;
    try { md = readFileSync(join(vaultBase, '08-Mudanças', slug, 'tarefas.md'), 'utf8'); }
    catch { process.stderr.write(`wendkeep change show: not found: ${slug}\n`); process.exit(2); }
    const tasks = parseTasks(md);
    const open = tasks.filter((t) => !t.done).length;
    process.stdout.write(`${slug}: ${tasks.length} task(s), ${open} open\n`);
    for (const t of tasks) process.stdout.write(`  [${t.done ? 'x' : ' '}] ${t.id} ${t.text}\n`);
    process.exit(0);
  }
```

- [ ] **Step 6: Run + Checkpoint**

Run: `node --check src/change.mjs && npm test` — green. **Checkpoint.**

---

### Task 4: Active-change pointer → brain-inject at SessionStart

**Files:**
- Modify: `hooks/change-core.mjs` (`buildActiveChangeInjection`)
- Modify: `hooks/brain-inject.mjs`
- Test: `tests/change-core.test.mjs`

**Interfaces:**
- Consumes: `activeChange`, `parseTasks` (Task 2/3).
- Produces: `buildActiveChangeInjection(vaultBase, { maxTasks }) -> string` (`''` when no active change).

- [ ] **Step 1: Write the failing test**

Append to `tests/change-core.test.mjs`:
```js
import { buildActiveChangeInjection } from '../hooks/change-core.mjs';

test('buildActiveChangeInjection: block with open tasks when a change is active', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-inj-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', 'dark-mode'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'dark-mode', 'tarefas.md'), '- [x] 1.1 done\n- [ ] 1.2 open one\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: dark-mode\n');
    const out = buildActiveChangeInjection(vault);
    assert.match(out, /<active_change>/);
    assert.match(out, /dark-mode/);
    assert.match(out, /1\.2 open one/);
    assert.doesNotMatch(out, /1\.1 done/); // only open tasks
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('buildActiveChangeInjection: empty when no active change', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-noinj-'));
  try { assert.equal(buildActiveChangeInjection(vault), ''); }
  finally { rmSync(vault, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify FAIL** — `node --test tests/change-core.test.mjs`.

- [ ] **Step 3: Implement `buildActiveChangeInjection` in `hooks/change-core.mjs`**

```js
export function buildActiveChangeInjection(vaultBase, { maxTasks = 8 } = {}) {
  const slug = activeChange(vaultBase);
  if (!slug) return '';
  let md = '';
  try { md = readFileSync(join(vaultBase, CHANGES_DIR, slug, 'tarefas.md'), 'utf8'); } catch { return ''; }
  const open = parseTasks(md).filter((t) => !t.done).slice(0, maxTasks);
  const lines = open.map((t) => `- [ ] ${t.id} ${t.text}`);
  const more = open.length === maxTasks ? '\n*…mais tarefas em tarefas.md*' : '';
  return `<active_change>
Mudança ativa: ${slug} — [[${CHANGES_DIR}/${slug}/proposta]]. Tarefas abertas:
${lines.join('\n')}${more}
</active_change>`;
}
```

- [ ] **Step 4: Run to verify PASS** — `node --test tests/change-core.test.mjs`.

- [ ] **Step 5: Wire into `hooks/brain-inject.mjs`**

Add import at top: `import { buildActiveChangeInjection } from './change-core.mjs';`
In `buildInjection(vaultBase)`, before the final `return [...].join('\n')`, append the active-change block when present. Change the assembly so the return concatenates `buildActiveChangeInjection(vaultBase)` after the `</brain_memory>` block:
```js
  const brain = ['<brain_memory>', ...lines, pointer, '</brain_memory>'].join('\n');
  const change = buildActiveChangeInjection(vaultBase);
  return change ? `${brain}\n${change}` : brain;
```
(Replace the existing single `return` accordingly.)

- [ ] **Step 6: Run + Checkpoint**

Run: `node --check hooks/brain-inject.mjs && node --test tests/change-core.test.mjs && npm test` — green. **Checkpoint.**

---

### Task 5: `archiveChange` + `wendkeep change archive` (gate stub + ADR)

**Files:**
- Modify: `hooks/change-core.mjs` (`gateStub`, `archiveChange`)
- Modify: `src/change.mjs`
- Test: `tests/change-core.test.mjs`, `tests/change-cli.test.mjs`

**Interfaces:**
- Consumes: `activeChange`, `clearActiveChange`; from `obsidian-common.mjs`: `getNextAdrNumber`, `formatDate`, `datedFolderRel` (ADR path helper), `wikilinkFromRel`, `ensureDir`.
- Produces:
  - `gateGreen(_changeDir) -> { ok: true, failing: [] }` (stub; Pilar C overrides)
  - `archiveChange(vaultBase, slug, { gate=gateGreen, dateStr, adrNum }) -> { ok, failing, archivedRel?, adrRel? }`

- [ ] **Step 1: Write the failing test**

Append to `tests/change-core.test.mjs`:
```js
import { archiveChange, gateGreen } from '../hooks/change-core.mjs';

test('archiveChange: moves to _arquivo, mints ADR, clears active (gate ok)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-arch-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', 'dark-mode'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'dark-mode', 'proposta.md'), '---\ntype: change\n---\n# dark-mode\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: dark-mode\n');
    const r = archiveChange(vault, 'dark-mode', { dateStr: '2026-07-05', adrNum: 20 });
    assert.equal(r.ok, true);
    assert.ok(existsSync(join(vault, '08-Mudanças', '_arquivo', '2026-07-05-dark-mode', 'proposta.md')));
    assert.ok(!existsSync(join(vault, '08-Mudanças', 'dark-mode')), 'original moved');
    // ADR written somewhere under 04-Decisões, wikilinking the change
    const adr = readFileSync(r.adrRel.startsWith(vault) ? r.adrRel : join(vault, r.adrRel), 'utf8');
    assert.match(adr, /dark-mode/);
    assert.equal(activeChange(vault), ''); // cleared
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('archiveChange: gate red blocks archive', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-archred-'));
  try {
    mkdirSync(join(vault, '08-Mudanças', 'x'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), '# x\n');
    const r = archiveChange(vault, 'x', { dateStr: '2026-07-05', adrNum: 1, gate: () => ({ ok: false, failing: ['tests'] }) });
    assert.equal(r.ok, false);
    assert.ok(existsSync(join(vault, '08-Mudanças', 'x')), 'not moved when gate red');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify FAIL** — `node --test tests/change-core.test.mjs`.

- [ ] **Step 3: Implement in `hooks/change-core.mjs`**

Add imports at top of the file: extend the existing obsidian-common import to include the helpers used:
```js
import { wikilinkFromRel, ensureDir } from './obsidian-common.mjs';
```
(Keep the ADR folder simple: archive writes the ADR at `04-Decisões/<dateStr year>/<slug>.md`-style path built inline to avoid coupling; reuse `ensureDir`.)
```js
export function gateGreen() {
  return { ok: true, failing: [] };
}

export function archiveChange(vaultBase, slug, { gate = gateGreen, dateStr, adrNum }) {
  const src = join(vaultBase, CHANGES_DIR, slug);
  const verdict = gate(src);
  if (!verdict.ok) return { ok: false, failing: verdict.failing || [] };

  const destRel = join(CHANGES_DIR, ARCHIVE_DIR, `${dateStr}-${slug}`);
  const dest = join(vaultBase, destRel);
  ensureDir(join(vaultBase, CHANGES_DIR, ARCHIVE_DIR));
  renameSync(src, dest);

  // Mint an ADR into 04-Decisões wikilinking the archived change.
  const [year] = String(dateStr).split('-');
  const adrDirRel = join('04-Decisões', year);
  ensureDir(join(vaultBase, adrDirRel));
  const num = String(adrNum).padStart(3, '0');
  const adrRel = join(adrDirRel, `ADR-${num}-${slug}.md`);
  const changeWikilink = wikilinkFromRel(join(destRel, 'proposta'));
  writeFileSync(join(vaultBase, adrRel), `---
type: decision
status: accepted
date: ${dateStr}
cssclasses:
  - topic-decision
tags:
  - decisao
---

# ADR-${num} — ${slug}

## Decisão

Mudança ${changeWikilink} concluída e arquivada.
`, 'utf8');

  clearActiveChange(vaultBase);
  return { ok: true, failing: [], archivedRel: destRel, adrRel };
}
```

- [ ] **Step 4: Run to verify PASS** — `node --test tests/change-core.test.mjs`.

- [ ] **Step 5: Wire `archive` into `src/change.mjs`**

Add import: `import { newChange, activeChange, listChanges, parseTasks, archiveChange } from '../hooks/change-core.mjs';` and `getNextAdrNumber` from obsidian-common:
`import { getNextAdrNumber } from '../hooks/obsidian-common.mjs';`
In `runChange`, add before the unknown line:
```js
  if (sub === 'archive') {
    const slug = rest.find((a) => !a.startsWith('-')) || activeChange(vaultBase);
    if (!slug) { process.stderr.write('wendkeep change archive: missing <slug> and no active change\n'); process.exit(2); }
    const r = archiveChange(vaultBase, slug, { dateStr: today(), adrNum: getNextAdrNumber(vaultBase) });
    if (!r.ok) {
      process.stderr.write(`change archive BLOCKED (gate): failing sensors: ${r.failing.join(', ')}\n`);
      process.exit(1);
    }
    process.stdout.write(`archived: ${r.archivedRel}; ADR: ${r.adrRel}\n`);
    process.exit(0);
  }
```

- [ ] **Step 6: CLI e2e for archive**

Append to `tests/change-cli.test.mjs`:
```js
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
```

- [ ] **Step 7: Run + Checkpoint** — `node --check src/change.mjs && npm test` green. **Checkpoint.**

---

### Task 6: Session ↔ change bidirectional graph link

**Files:**
- Modify: `hooks/session-stop.mjs`
- Test: `tests/change-core.test.mjs` (unit for the helper) — keep session-stop change minimal.

**Interfaces:**
- Consumes: `activeChange` (Task 2).
- Produces: `activeChangeLink(vaultBase) -> string` (`''` or `Change ativa: [[08-Mudanças/<slug>/proposta]]`) exported from `change-core.mjs`.

- [ ] **Step 1: Write the failing test**

Append to `tests/change-core.test.mjs`:
```js
import { activeChangeLink } from '../hooks/change-core.mjs';

test('activeChangeLink: wikilink to active change proposta, empty when none', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-link-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    assert.equal(activeChangeLink(vault), '');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: dark-mode\n');
    assert.match(activeChangeLink(vault), /\[\[08-Mudanças\/dark-mode\/proposta\]\]/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify FAIL** — `node --test tests/change-core.test.mjs`.

- [ ] **Step 3: Implement `activeChangeLink` in `hooks/change-core.mjs`**

```js
export function activeChangeLink(vaultBase) {
  const slug = activeChange(vaultBase);
  return slug ? `Change ativa: [[${CHANGES_DIR}/${slug}/proposta]]` : '';
}
```

- [ ] **Step 4: Run to verify PASS** — `node --test tests/change-core.test.mjs`.

- [ ] **Step 5: Wire into `hooks/session-stop.mjs`**

Add import: `import { activeChangeLink } from './change-core.mjs';`
In the session-note write path (where the iteration/turn content is appended in `main()`), after the vault-complement/iteration block, append the link line when non-empty. Locate the section that writes the turn/iteration body and add:
```js
  const chgLink = activeChangeLink(vaultBase);
  if (chgLink) {
    // append once per note: only if not already present
    // (reuse the existing appendFileSync path used for iterations; guard on includes)
  }
```
Minimal, safe implementation: after the note file path (`activePath`) is known and the turn is appended, do a guarded append:
```js
  try {
    const chgLink = activeChangeLink(vaultBase);
    if (chgLink) {
      const notePath = join(vaultBase, sessionRel);
      const cur = readFileSync(notePath, 'utf8');
      if (!cur.includes(chgLink)) writeFileSync(notePath, `${cur.trimEnd()}\n\n${chgLink}\n`, 'utf8');
    }
  } catch { /* fail-quiet: never break Stop */ }
```
(Place inside the existing `try` region of `main()` after the session note is finalized; `sessionRel` is the note's vault-relative path already computed there. If the variable name differs, use the local that holds the active note's relative path.)

- [ ] **Step 6: Run + Checkpoint** — `node --check hooks/session-stop.mjs && npm test` green. Manually confirm `hooks/session-stop.mjs` still parses and the guarded block sits inside the fail-open `try`. **Checkpoint.**

---

### Task 7: Colors — topic-change / topic-spec + graph groups

**Files:**
- Modify: `src/vault-theme.mjs`
- Test: `tests/vault-theme.test.mjs`

**Interfaces:**
- Produces: `renderColorSnippetCss()` styles `.topic-change` and `.topic-spec`; `graphColorGroups()` includes `08-Mudanças` and `07-Specs`.

- [ ] **Step 1: Write the failing test**

Append to `tests/vault-theme.test.mjs`:
```js
test('colors: change/spec note classes + graph groups for new folders', () => {
  const css = renderColorSnippetCss();
  assert.ok(css.includes('topic-change'));
  assert.ok(css.includes('topic-spec'));
  const q = graphColorGroups().map((g) => g.query);
  assert.ok(q.some((s) => s.includes('08-Mudanças')));
  assert.ok(q.some((s) => s.includes('07-Specs')));
});
```

- [ ] **Step 2: Run to verify FAIL** — `node --test tests/vault-theme.test.mjs`.

- [ ] **Step 3: Implement in `src/vault-theme.mjs`**

Add to `NOTE_COLORS`:
```js
  change: { cssClass: 'topic-change', folder: '08-Mudanças', palette: 'amber' },
  spec: { cssClass: 'topic-spec', folder: '07-Specs', palette: 'teal' },
```
Add to `FOLDER_PALETTE`:
```js
  ['07-Specs', 'teal'],
  ['08-Mudanças', 'amber'],
```
(`NOTE_COLORS` already drives `graphColorGroups()` and the per-topic CSS block generation, so both assertions are satisfied by the additions.)

- [ ] **Step 4: Run to verify PASS** — `node --test tests/vault-theme.test.mjs`.

- [ ] **Step 5: Seed spec README + change template in `src/init.mjs`**

After the `.brain` seeding block in `runInit`, add (non-destructive):
```js
  const specsReadme = join(vaultPath, '07-Specs', 'README.md');
  if (!existsSync(specsReadme)) writeFileSync(specsReadme, '# Specs — contrato vivo\n\nCapacidades do projeto (requisitos/cenários). Changes em `08-Mudanças/` promovem deltas aqui no `wendkeep change archive`.\n', 'utf8');
  const changeTpl = join(vaultPath, 'Templates', 'Change.md');
  if (!existsSync(changeTpl)) writeFileSync(changeTpl, '---\ntype: change\nstatus: active\ncssclasses:\n  - topic-change\n---\n\n# <slug>\n\n## Por quê\n\n## O que muda\n', 'utf8');
```

- [ ] **Step 6: Run + Checkpoint** — `node --check src/init.mjs && npm test` green. **Checkpoint.**

---

## Self-Review

- **Spec coverage:** vault folders (T1) ✓; scaffold+new (T2) ✓; parse/list/show (T3) ✓; active-change brain-inject (T4) ✓; archive+ADR+gate-seam (T5) ✓; session↔change link (T6) ✓; colors (T7) ✓; init seed (T7 step 5) ✓. Gate is a stub here — real sensors are **Pilar C** (separate plan), as designed. Skills/`/wk:*` are **Pilar A** (separate plan).
- **Placeholder scan:** none — all steps carry real code. The `08-Mudanças` accent is intentional and matches existing folders.
- **Type consistency:** `activeChange`/`setActiveChange`/`clearActiveChange`, `newChange`, `parseTasks`, `listChanges`, `buildActiveChangeInjection`, `archiveChange`, `gateGreen`, `activeChangeLink` — names consistent across tasks and between `change-core.mjs` and consumers. `gate` seam signature `(changeDir) -> {ok, failing}` matches the stub and the Pilar C override.

## Notes for the executor

- After Task 1, run the FULL suite — the 2 new `VAULT_FOLDERS` may break any init test asserting an exact folder count; update those assertions to the new count (`VAULT_FOLDERS.length`).
- `session-stop.mjs` is large (~1100 lines); make Task 6's edit a **small guarded append inside the existing fail-open `try`** — do not restructure the file. If the exact insertion point is unclear, place it immediately before `writeHookOutput` at the end of the successful-write branch, using the local variable that holds the active note's vault-relative path.
- Do not add `change-core.mjs` to `RUNNABLE_HOOKS` — it is a lib, not a stdin/stdout hook.
