# Pilar A — Native process skills (Implementation Plan)

> Implements Pilar A of `docs/10-a2-native-harness.md` (the HOW layer). **For agentic workers:** use superpowers:executing-plans.

**Goal:** `wendkeep init` seeds a set of native, zero-dep process skills into the vault's `.brain/skills`, so any agent (via `wendkeep sync-defs` → `.claude/skills`) gets the a2 discipline without depending on superpowers.

**Architecture:** New content module `src/skills-seed.mjs` holds the skill bodies (`WK_SKILLS`) + `seedWkSkills(brainDir)`; `init` calls it after `seedDefinitions`; the existing `syncDefs` already copies every `.brain/skills/<name>/` to `.claude/skills/` unchanged. Skills are wendkeep-flavored (reference `change`/`verify`), concise, native prose — not copies of superpowers.

**Tech Stack:** Node ≥18 ESM, `node --test`. Non-destructive seeding (write-if-absent), mirrors `seedDefinitions`.

## Global Constraints

- ESM, no external deps. `npm test` = `node --test`. No git → "commit" = **Checkpoint: `npm test` green**.
- Skills live in `.brain/skills/<name>/SKILL.md` (source of truth in the vault). Distribution is `wendkeep sync-defs` (agent-agnostic; already implemented — do NOT modify `syncDefs`).
- Each SKILL.md has YAML frontmatter `name:` + `description:` then a concise body. `name` MUST equal the folder name.
- Seeding is non-destructive: never overwrite a user-edited skill (write-if-absent).
- The 5 skills: `wk-workflow` (a2 loop keystone), `wk-tdd`, `wk-debugging`, `wk-brainstorming`, `wk-planning`.

## File Structure

- Create `src/skills-seed.mjs` — `WK_SKILLS` (array of `{name, description, body}`) + `seedWkSkills(brainDir)`.
- Modify `src/init.mjs` — call `seedWkSkills(brainDir)` after `seedDefinitions(brainDir)`; fold created paths into the log.
- Test `tests/skills-seed.test.mjs` — content + idempotence (unit).
- Test — extend `tests/validate-memory-cli.test.mjs` — init seeds skills + `sync-defs` copies `wk-workflow` to `.claude/skills` (e2e).

---

### Task 1: `src/skills-seed.mjs` — the 5 native skills + seeder

**Files:** Create `src/skills-seed.mjs`; Test `tests/skills-seed.test.mjs`.

**Interfaces:** Produces:
- `WK_SKILLS: Array<{ name, description, body }>` — body is the full SKILL.md (frontmatter + content).
- `seedWkSkills(brainDir) -> string[]` — writes each `<brainDir>/skills/<name>/SKILL.md` if absent; returns created paths.

- [ ] **Step 1: Failing test** — create `tests/skills-seed.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WK_SKILLS, seedWkSkills } from '../src/skills-seed.mjs';

test('WK_SKILLS: the 5 process skills, each valid SKILL.md with matching name', () => {
  const names = WK_SKILLS.map((s) => s.name);
  for (const n of ['wk-workflow', 'wk-tdd', 'wk-debugging', 'wk-brainstorming', 'wk-planning']) {
    assert.ok(names.includes(n), `has ${n}`);
  }
  for (const s of WK_SKILLS) {
    assert.match(s.body, new RegExp(`name:\\s*${s.name}\\b`), `${s.name} frontmatter name`);
    assert.match(s.body, /description:/, `${s.name} has description`);
    assert.ok(s.body.length > 200, `${s.name} body non-trivial`);
  }
});

test('wk-workflow references the wendkeep loop commands', () => {
  const wf = WK_SKILLS.find((s) => s.name === 'wk-workflow').body;
  assert.match(wf, /wendkeep change new/);
  assert.match(wf, /wendkeep verify/);
  assert.match(wf, /\[sensor:/);
});

test('seedWkSkills: writes each SKILL.md, non-destructive', () => {
  const brain = mkdtempSync(join(tmpdir(), 'wk-skills-'));
  try {
    const created = seedWkSkills(brain);
    assert.equal(created.length, WK_SKILLS.length);
    assert.ok(existsSync(join(brain, 'skills', 'wk-workflow', 'SKILL.md')));
    const before = readFileSync(join(brain, 'skills', 'wk-tdd', 'SKILL.md'), 'utf8');
    // second run: no overwrite, nothing new created
    assert.equal(seedWkSkills(brain).length, 0);
    assert.equal(readFileSync(join(brain, 'skills', 'wk-tdd', 'SKILL.md'), 'utf8'), before);
  } finally { rmSync(brain, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run → FAIL** — `node --test tests/skills-seed.test.mjs`.

- [ ] **Step 3: Implement** `src/skills-seed.mjs` — author the 5 skills (concise, native prose). Structure:
```js
// src/skills-seed.mjs — native, zero-dep process skills (Pilar A: the HOW layer).
// Seeded into the vault's .brain/skills; distributed by `wendkeep sync-defs`.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function skill(name, description, body) {
  return { name, description, body: `---\nname: ${name}\ndescription: ${description}\n---\n${body}` };
}

export const WK_SKILLS = [
  skill('wk-workflow', 'Use quando começar qualquer mudança não-trivial — orquestra o loop a2 (explore→propose→apply→verify→archive) nos comandos wendkeep.', `...`),
  skill('wk-tdd', 'Use ao implementar qualquer comportamento — disciplina RED→GREEN→refactor.', `...`),
  skill('wk-debugging', 'Use quando algo falha/quebra — depuração sistemática por hipótese antes de corrigir.', `...`),
  skill('wk-brainstorming', 'Use quando a ideia ainda é vaga — transforma ideia em design aprovado antes de código.', `...`),
  skill('wk-planning', 'Use após um design aprovado — decompõe em plano de tarefas TDD bite-sized.', `...`),
];

export function seedWkSkills(brainDir) {
  const created = [];
  for (const s of WK_SKILLS) {
    const dir = join(brainDir, 'skills', s.name);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'SKILL.md');
    if (!existsSync(f)) { writeFileSync(f, s.body, 'utf8'); created.push(f); }
  }
  return created;
}
```
Author each body (replace the `...`) as concise native prose. Required content per skill:
- **wk-workflow:** the loop steps mapped to commands — `wendkeep change new <slug>` (propose: fill proposta/design/tarefas), apply each `tarefas.md` task via **wk-tdd**, tag tasks needing proof with `[sensor:id]`, `wendkeep verify` before archiving, `wendkeep change archive` (gates on evidence). One active change at a time. Note the SessionStart injects the active change.
- **wk-tdd:** write the failing test first; run it, watch it fail for the right reason; minimal code to green; refactor; never write code before a red test. Small steps.
- **wk-debugging:** reproduce; form ONE hypothesis; isolate (bisect/log) to confirm before fixing; fix root cause not symptom; verify the repro is gone + tests green. Don't shotgun-change.
- **wk-brainstorming:** one question at a time; propose 2–3 approaches with trade-offs + a recommendation; present a design and get approval BEFORE any code (hard gate); scale the design to complexity.
- **wk-planning:** map files/responsibilities first; bite-sized TDD tasks (test → fail → impl → pass → checkpoint); exact paths + real code, no placeholders; DRY/YAGNI.

- [ ] **Step 4: Run → PASS** — `node --test tests/skills-seed.test.mjs`.

- [ ] **Step 5: Checkpoint** — `node --check src/skills-seed.mjs && npm test` green.

---

### Task 2: `init` seeds the skills; `sync-defs` distributes them

**Files:** Modify `src/init.mjs`; Test `tests/validate-memory-cli.test.mjs`.

**Interfaces:** Consumes: `seedWkSkills` (T1), existing `seedDefinitions` + `syncDefs`. After `init`, `<vault>/.brain/skills/wk-workflow/SKILL.md` exists; after `sync-defs`, `<project>/.claude/skills/wk-workflow/SKILL.md` exists.

- [ ] **Step 1: Failing e2e test** — append to `tests/validate-memory-cli.test.mjs`:
```js
import { seedWkSkills as _wkAssertExists } from '../src/skills-seed.mjs'; // ensure module resolves

test('init seeds wk process skills; sync-defs copies them to .claude/skills', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-skillsync-'));
  const projectDir = join(parent, 'SkProj');
  mkdirSync(projectDir);
  try {
    const init = spawnSync(process.execPath, [BIN, 'init', '--project', projectDir, '--no-mcp', '--no-companions', '--no-colors', '--yes'], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const vault = join(projectDir, '.SkProj-vault');
    assert.ok(existsSync(join(vault, '.brain', 'skills', 'wk-workflow', 'SKILL.md')), 'skill seeded in vault');
    const sync = spawnSync(process.execPath, [BIN, 'sync-defs', '--vault', vault, '--project', projectDir], { encoding: 'utf8' });
    assert.equal(sync.status, 0, sync.stderr);
    assert.ok(existsSync(join(projectDir, '.claude', 'skills', 'wk-workflow', 'SKILL.md')), 'skill synced to .claude');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
```
(The `_wkAssertExists` import is only to fail fast if the module path is wrong; the real assertions are the e2e ones.)

- [ ] **Step 2: Run → FAIL** — `node --test tests/validate-memory-cli.test.mjs`.

- [ ] **Step 3: Implement** — in `src/init.mjs`: add import `import { seedWkSkills } from './skills-seed.mjs';`. After `seedDefinitions(brainDir);` add:
```js
  seedWkSkills(brainDir);
```
(Fold into the existing seed log — no new required output; the `[1/4]` line already says ".brain … seeded".)

- [ ] **Step 4: Run → PASS** — `node --test tests/validate-memory-cli.test.mjs`.

- [ ] **Step 5: Checkpoint** — `node --check src/init.mjs && npm test` green.

---

## Self-Review

- **Spec coverage:** the HOW layer (native process skills) seeded + distributed agent-agnostically via sync-defs ✓ (docs/10 Pilar A). Keystone `wk-workflow` ties Pilars B+C into a loop ✓.
- **Placeholder scan:** the `...` bodies in Task 1 Step 3 are authored in full during implementation (content, not code placeholders) — the required content per skill is enumerated.
- **Type consistency:** `WK_SKILLS` shape `{name, description, body}` + `seedWkSkills(brainDir)->string[]` consistent across T1/T2; `syncDefs` unchanged (copies all skill dirs).

## Verification (end-to-end)

1. `wendkeep init` → `.brain/skills/wk-workflow|wk-tdd|wk-debugging|wk-brainstorming|wk-planning/SKILL.md` present.
2. `wendkeep sync-defs` → same skills under `<project>/.claude/skills/`.
3. `npm test` green (skills-seed unit + sync e2e).
4. Manual read: `wk-workflow` SKILL.md references `wendkeep change new` / `wendkeep verify` / `[sensor:id]`.
