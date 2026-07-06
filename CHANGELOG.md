# Changelog

All notable changes to **wendkeep** are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.17.0] — 2026-07-06

Retroactive memory, now agent-agnostic (Codex).

### Added
- **`wendkeep import --source codex|all`** — import now covers **Codex** too. Codex rollouts
  (`~/.codex/sessions/**`) aren't organized by project, so they're scoped by the `cwd` recorded
  in each session's `session_meta` — matched case- and separator-insensitively, including
  subdirectories. `--source` defaults to **`all`** (both agents); narrow with `claude` / `codex`.
  `--codex-from <dir>` overrides the sessions root.
- Transcript parsers now carry a `provider` field, so an imported note is tagged with the
  transcript's **real** provider (`provider: codex` for Codex) instead of the ambient default.

### Changed
- `wendkeep import` default source is now **`all`** (was Claude-only in 0.16.0). Still idempotent —
  already-imported sessions are skipped by `session_id`, per project (Claude by slug dir, Codex by
  `session_meta.cwd`).
- Import registration keys off the **discovered** `session_id` (filename for Claude,
  `session_meta.id` for Codex) so the dedup key and the registry key are always identical —
  closes a latent duplicate-on-reimport gap if a transcript's filename ever diverged from its
  internal id.
- Validated on real data: **24** Codex sessions discovered for a production project (across
  drive-case variants), 0 parse errors, notes correctly tagged `codex`.

## [0.16.0] — 2026-07-06

Retroactive memory.

### Added
- **`wendkeep import`** — backfill the vault with this project's *past* Claude Code sessions.
  It scans `.claude/projects/<slug>/*.jsonl`, and for every session not already in the vault
  (deduped by `session_id` against the `SESSION_REGISTRY`) reconstructs a full, dated session
  note — frontmatter, one iteration block per turn, cost + subagent telemetry, derived
  decision/bug/learning notes, and a finalized closing — placed in its **real** date folder
  (`02-Sessões/<year>/<MM-MMM>/DIA <dd>/`), not today's. One command turns your whole history
  into memory that `wendkeep cost` immediately aggregates.
  - Offline replay of the live capture flow (same `buildSessionContent` / `insertIteration` /
    `finalizeSessionFile` / usage + subagent code) so an imported note is indistinguishable
    from a captured one.
  - Options: `--from <dir>` (point at the `.claude/projects` folder explicitly), `--project`,
    `--since <date>`, `--limit <n>`, `--dry-run` (report without writing), `--json`.
  - Idempotent: re-running skips everything already imported. Never overwrites an existing note.
  - v1 covers Claude Code transcripts; Codex is a follow-up.

### Changed
- `session-start.mjs` now guards its `main()` behind the standard `import.meta.url` check (like
  `session-stop.mjs`) so its note-building helpers can be imported by `import`/tests without
  running the hook. No behavioral change when invoked as a hook.

## [0.15.0] — 2026-07-06

### Added
- **`wendkeep cost --top [N]`** — the N priciest sessions (cost incl. subagents · date · file),
  most expensive first (default 10). Spot where the money went. `cost --json` now also carries
  the per-session `sessions` list.

## [0.14.0] — 2026-07-06

### Changed
- **dotcontext is no longer a default companion.** wendkeep's native a2 loop (`change` /
  `verify` / gate) recreates dotcontext's execution/gate role, so pinning it duplicates the
  harness. The interactive / `--yes` default is now **`context-mode` only**; dotcontext stays
  selectable via `--companions dotcontext` for anyone already invested.
- **README:** rewrote "Install & set up" with a clear **`init` options table** and a
  per-companion breakdown; clarified that `--no-mcp` skips **only wendkeep's own** vault MCP
  (companion MCPs still follow `--companions`).

## [0.13.0] — 2026-07-06

Cost intelligence: waste + average.

### Added
- **Wasted-spend tracking:** a killed/failed workflow run's subagent cost is now recorded per
  session (`subagents_wasted_usd` + a line in the note's `## Subagents & Workflows`) and rolled
  up by `wendkeep cost` (`desperdiçado (runs killed/failed): $X`). Money burned on aborted runs
  was invisible before.
- **`wendkeep cost` per-session average** (`$/sessão`) alongside the vault total.

## [0.12.0] — 2026-07-06

Deeper subagent/workflow telemetry.

### Added
- **Workflow run metadata** in the `## Subagents & Workflows` section: each run now shows its
  **status** (completed / killed / …), phase titles, duration and agent count — read from the
  authoritative `workflows/wf_*.json`. On a real session this surfaced a **killed** run that
  still cost $2.50 next to the completed $5.76 one — wasted spend you couldn't see before.
- **Subagent tools rollup:** the distinct tools the subagents used, shown in the section and a
  new `subagents_tools` frontmatter field.

## [0.11.0] — 2026-07-06

Vault-wide cost.

### Added
- **`wendkeep cost`** — aggregate AI-coding spend across every session note in the vault:
  total (main + subagents), by model, by day. `--since <YYYY-MM-DD>` to window; `--json` for
  scripting. Builds on the per-session cost the capture hooks already record — on a real
  project vault it surfaced **~$4.7k across 140 sessions** in one command.

## [0.10.0] — 2026-07-06

Subagent & workflow telemetry — closing the biggest observability gap.

### Added
- **Subagent + workflow capture:** the Stop hook now scans the session's sibling subagent
  transcripts (`<session>/subagents/**`) and workflow runs, and folds them into the session
  note — a new `## Subagents & Workflows` section (aggregate + a collapsible per-subagent
  table) plus frontmatter fields (`subagents_count`, `subagents_tokens_total`,
  `subagents_custo_usd`, `tokens_total_incl_subagents`). Reuses the token-usage parser
  (deduped per request). Previously a session that spawned a Workflow recorded ONLY the main
  transcript — on a real audit session that hid **12 subagents / 4.6M tokens / $7.59** (2× the
  main). The main `tokens_total` stays the main agent's (comparable to Claude Code's own
  display); subagents are a separate axis.
- Provider-gated by structure (Claude Code's `subagents/` layout); fail-open — never blocks Stop.

## [0.9.1] — 2026-07-06

Interactive install UX: language first.

### Added
- **`wendkeep init` asks the vault language first** on an interactive TTY (when `--locale`
  isn't passed): `[1] Português  [2] English`. The answer drives the folders, scaffold and
  skills — and the remaining prompts (vault path, companion selection) now render in the
  chosen locale instead of always Portuguese. `--yes`, `--locale` and non-TTY are unchanged.

## [0.9.0] — 2026-07-06

Engineering debt: sensor editing + i18n coherence for auto-generated notes.

### Added
- **`wendkeep sensors add <id> "<command>"`** (`--severity` / `--type` / `--report` / `--name`
  / `--description`) — append a sensor to `wendkeep.sensors.json` (creates the file with
  `$schema` when absent, dedups by id) instead of hand-editing JSON.
- **Locale-aware derived notes:** the auto-generated bug/decision/learning notes render their
  headings + callout in the vault locale — an `en` vault no longer gets Portuguese headings.

### Deferred (with reason)
- `migrate-locale`: renaming a populated vault breaks every wikilink to the old folder names;
  needs a backlink-repair pass — its own effort, not a patch.
- Code-hash verdict freshness: a change carries no file manifest, so "the code" is undefined;
  the existing `tarefas.md` hash already blocks task drift.

## [0.8.1] — 2026-07-06

Polish: i18n coherence + presentation.

### Added
- **Locale-aware process skills + vault docs:** an `en` vault now seeds the `wk-*` skills,
  the vault README, the change template, and the specs README in English (previously
  Portuguese regardless of locale). Completes the `--locale en` promise.
- **`wendkeep.sensors.json` at the repo root** — the project gates itself with its own
  test/check sensors (dogfooding the harness).

### Changed
- npm `description` now describes the harness + a2 loop (was capture-only).
- CI: `actions/checkout` and `actions/setup-node` bumped to `v5` (v4 runner deprecation).
- README: the i18n "known limitation" is resolved.

## [0.8.0] — 2026-07-05

Reach: internationalization + agent-agnostic distribution.

### Added
- **Vault locale (i18n):** `wendkeep init --locale en` creates an English vault
  (`02-Sessions`, `04-Decisions`, `08-Changes`, …, English months, English change scaffold,
  English CORE skeleton, localized theme/graph groups). The locale is a vault property
  (`.brain/config.json`), locked at init; absent = `pt-BR` — existing vaults are untouched
  and never renamed. Parsers are **bilingual everywhere** (`Requisito|Requirement`,
  `mata mutante|kill mutant`, CORE section sets), so mixed content never breaks.
- **AGENTS.md managed section:** `sync-defs`/`init` maintain a marker-delimited section in
  the project's `AGENTS.md` (loop summary + skill inventory) — one file that Codex, Amp,
  Cursor, Zed and any AGENTS.md-reading agent picks up. User content around it is preserved.
- **Harness contract v1.2** (`docs/14`): locale + AGENTS.md channel.

### Deferred
- Extra mutation-report formats (mutmut/PIT) and per-agent session-hook wiring — backlog
  (`docs/17`).

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
[0.15.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.15.0
[0.14.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.14.0
[0.13.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.13.0
[0.12.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.12.0
[0.11.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.11.0
[0.10.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.10.0
[0.9.1]: https://github.com/rogersialves/wendkeep/releases/tag/v0.9.1
[0.9.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.9.0
[0.8.1]: https://github.com/rogersialves/wendkeep/releases/tag/v0.8.1
[0.8.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.8.0
[0.7.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.7.0
[0.6.1]: https://github.com/rogersialves/wendkeep/releases/tag/v0.6.1
[0.6.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.6.0
[0.5.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.5.0
[0.4.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.4.0
[0.3.0]: https://www.npmjs.com/package/wendkeep/v/0.3.0
[0.2.7]: https://www.npmjs.com/package/wendkeep/v/0.2.7
[0.2.0]: https://www.npmjs.com/package/wendkeep/v/0.2.0
[0.1.0]: https://www.npmjs.com/package/wendkeep/v/0.1.0
