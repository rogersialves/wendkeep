# Changelog

All notable changes to **wendkeep** are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] — 2026-07-05

Ergonomics: the loop without hand-editing files.

### Added
- **`change status`** — one screen: tasks (done/open with `[req:]`/`[sensor:]`), sensor
  evidence, verdict state (ok / stale / incomplete / absent), mutation round.
- **`change done <id>` / `undone <id>`** — tick tasks from the CLI (exact-id anchored).
- **`change diff`** — dry-run preview of the spec promotion (`+` ADDED / `~` MODIFIED /
  `-` REMOVED / `!` warnings) without touching `07-Specs`.
- **`spec list` / `spec show <capability>`** — read-only views over the living specs.
- **`sensors list`** — the sensors from `wendkeep.sensors.json`; a **JSON Schema** for the
  file now ships in the package (`schema/`) and the init seed points `$schema` at it.
- README: "the loop in five minutes" worked example.

### Fixed
- `change` subcommands without a positional argument no longer mistake the `--vault` value
  for a slug.

## [0.6.1] — 2026-07-05

Hardening: CI + real-world gate holes found by self-audit.

### Added
- **CI (GitHub Actions):** test + check matrix on ubuntu/windows × Node 18/20/22.
- **Open-task gate:** `change archive` blocks while tasks are open (`- [ ]`, including mutation
  fix-tasks `M.n` — a surviving mutant can no longer be archived). Explicit escape: `--force`.
- **Freshness seal (`tasksHash`):** `verify --deep` fingerprints `tarefas.md` into the package
  and verdict; the gate rejects a verdict minted against different tasks as stale. Pre-0.6.1
  verdicts (no hash) still accepted.
- **Auto-lesson on mutation escalation:** the 3rd surviving round records a project-local lesson.
- **Session link in proposta:** `change new` fills `source:` with the active session (graph edge
  proposta → sessão).

### Fixed
- `.mutation-round` now resets when the report comes back clean (a future survivor starts a
  fresh 3-round cycle instead of instantly escalating).
- `verify` exits 1 when mutants survive (was 0 — CI couldn't see it).
- `.brain/lessons/` capped at 50 (oldest pruned) instead of growing unbounded.

## [0.6.0] — 2026-07-05

Enforcement layer (Wave B of the TLC-parity program) — closes TLC parity.

### Added
- **Discrimination sensor (`type: mutation`):** delegates to the project's mutation tool and
  parses its mutation-testing-elements report; surviving mutants become fix tasks in the active
  change (`- [ ] M.n mata mutante file:line`), bounded to 3 rounds before escalating.
- **Harness self-check:** `wendkeep doctor` now validates the a2 state — an invalid
  `wendkeep.sensors.json`, a broken `CURRENT_CHANGE` pointer, changes without a `proposta.md`,
  an orphan `[req:]` (unknown requirement), and stale verdicts.
- **Lessons loop:** `wendkeep lesson add "<trigger>" "<lesson>"` records a project-local lesson in
  `.brain/lessons/`; `brain-inject` surfaces the recent ones as a `<lessons>` block at SessionStart.
- **Auto-sizing:** `wendkeep change new <slug> --simple` scaffolds only proposta + tarefas
  (no design / spec-delta) for trivial changes.
- **Harness contract v1.1** (`docs/14-harness-contract.md`): the mutation + lesson formats.

## [0.5.0] — 2026-07-05

Verification & credibility layer (Wave A of the TLC-parity program). The gate stops being
"green sensors" alone and starts requiring an independent verdict for changes that touch a spec.

### Added
- **Requirement IDs + traceability:** living-spec requirements carry a stable ID
  (`### Requisito: GATE-1 — nome`); tasks reference them with `[req:<ID>]`; the archive ADR
  lists the requirements it satisfied. Rastro req → task → verdict → ADR.
- **`wendkeep verify --deep`:** assembles a verification package (`verificacao.json`) for an
  independent pass. A trivial change (no `[req:]`, sensors green) gets an auto verdict.
- **Independent verdict gate:** `change archive` now also requires `verdict.json` (`ok`, covering
  every declared `[req:]`) for requirement-bearing changes.
- **TLC-grade process skills:** rewrote `wk-tdd` (spec-derived assertions, non-shallow litmus,
  test adequacy, test-learning) and `wk-brainstorming` (closure gate + out-of-scope); new
  `wk-verify` (fresh read-only verifier, author≠verifier).
- **Harness contract v1** (`docs/14-harness-contract.md`): the extension-point formats.

### Changed
- Requirement-less changes are unaffected — the sensor gate remains their proof. The verdict
  requirement applies only when a change declares `[req:]` tasks. Specs from 0.4.0 (headings
  without an ID) stay valid.

## [0.4.0] — 2026-07-05

Spec promotion (the living contract) + harness fixes.

### Added
- **Spec promotion** — `wendkeep change archive` merges each capability's spec delta
  (`## ADDED` / `## MODIFIED` / `## REMOVED Requirements`) into the living
  `07-Specs/<capability>.md`. Multi-capability per change via `specs: [slugs]` in the
  proposta; the living spec footer wikilinks the archived change (`hooks/spec-core.mjs`).
- Change scaffold now seeds an example spec delta at `specs/exemplo/spec.md`.
- `wendkeep change archive` prints promoted capabilities and surfaces delta warnings
  (ADDED-already-exists / MODIFIED-missing) without blocking.

### Changed
- `wendkeep init` now runs `sync-defs` itself — process skills and agents are delivered
  to `.claude/skills` / `.codex/agents` immediately (no manual step).
- The archive gate and `wendkeep verify` share one rule: only **critical** (or missing)
  sensors block; a red `warning` sensor is advisory. Evidence records each sensor's severity.
- README documents the change/verify/skills commands and the a2 loop.

## [0.3.0] — 2026-07-05

The a2 native harness — a zero-dependency spec→change→proof loop on the vault memory
core (recreates the best of OpenSpec + dotcontext + superpowers, natively).

### Added
- **Pilar B — change lifecycle:** `wendkeep change new|list|show|archive`. Scaffolds
  `08-Mudanças/<slug>/` (proposta/design/tarefas); the active change is injected at the
  next `SessionStart`; archive moves the change to `_arquivo/` and mints an ADR in
  `04-Decisões/`. New vault folders `07-Specs/`, `08-Mudanças/` (`hooks/change-core.mjs`).
- **Pilar C — verify + gate:** `wendkeep verify` runs a change's task-declared sensors
  (`[sensor:<id>]` hints) from a native `wendkeep.sensors.json`, records `evidencia.json`;
  `change archive` gates on the evidence (`hooks/sensors-core.mjs`).
- **Pilar A — process skills:** native `wk-workflow` / `wk-tdd` / `wk-debugging` /
  `wk-brainstorming` / `wk-planning` seeded into `.brain/skills` (`src/skills-seed.mjs`).

## [0.2.7] — 2026-06-30

### Added
- **Definitions layer:** `.brain/agents/` + `.brain/skills/` as versioned source of truth,
  copied into the project with `wendkeep sync-defs`.
- **dotcontext seed:** a starter `.context/config/sensors.json` (a `validate-memory` sensor
  plus one per detected `package.json` script) when the dotcontext companion is selected.

## [0.2.1] – [0.2.6] — 2026-06-29

Rapid iteration on the companion + memory layers (same day):
- **Companions** wired the most agent-agnostic way (context-mode / dotcontext as MCP,
  understand-anything via a domain-graph SessionStart injector, caveman via installer).
- **Obsidian color system** — a mode-agnostic CSS snippet (note-type accents) + graph
  color groups, merged non-destructively into `.obsidian/`.
- **Curated memory protocol** — `.brain/CORE.md` + `COMPACTION_PROTOCOL.md` and
  `wendkeep validate-memory` (cap 25 lines, 3 sections, no secrets/PII).
- Cross-platform caveman installer fix (npx non-interactive; Gemini excluded).
- Derived notes grouped by month under the year.

## [0.2.0] — 2026-06-29

### Added
- Companion plugins/MCP selection in `wendkeep init` (context-mode, understand-anything,
  caveman) with idempotent settings/`.mcp.json` merging.

## [0.1.0] — 2026-06-29

Initial release — the capture engine, extracted from a system in daily production use.

### Added
- Automatic session capture (`SessionStart` / `UserPromptSubmit` / `Stop` hooks) into
  `02-Sessões/` as turn-by-turn Markdown.
- Multi-agent provider detection (Claude Code, Codex, Copilot).
- Token & cost tracking (cache-aware `pricing.json`).
- Auto-extracted derived notes (decisions / bugs / learnings), backlinked to the session.
- Curated memory (`.brain/` cold index + `CORE` + `DIGEST` injected at `SessionStart`).
- `wendkeep init` (cross-platform installer) + optional `@bitbonsai/mcpvault` MCP server.

<!-- Only v0.4.0+ is tagged in git (history starts here); older versions link to npm. -->
[0.7.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.7.0
[0.6.1]: https://github.com/rogersialves/wendkeep/releases/tag/v0.6.1
[0.6.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.6.0
[0.5.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.5.0
[0.4.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.4.0
[0.3.0]: https://www.npmjs.com/package/wendkeep/v/0.3.0
[0.2.7]: https://www.npmjs.com/package/wendkeep/v/0.2.7
[0.2.0]: https://www.npmjs.com/package/wendkeep/v/0.2.0
[0.1.0]: https://www.npmjs.com/package/wendkeep/v/0.1.0
