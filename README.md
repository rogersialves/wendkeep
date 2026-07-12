# wendkeep

[Português](README.pt-BR.md) · **English**

> **Your AI coding agent forgets every session. wendkeep makes it remember — in the Obsidian vault you already use.**

[![npm](https://img.shields.io/npm/v/wendkeep.svg)](https://www.npmjs.com/package/wendkeep)
![test](https://github.com/rogersialves/wendkeep/actions/workflows/test.yml/badge.svg)
![zero deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![node](https://img.shields.io/badge/node-%E2%89%A518-blue)

[![wendkeep — persistent memory for AI coding agents, shown as a knowledge graph of sessions, decisions, bugs, learnings and changes](docs/assets/wendkeep-hero.svg)](docs/index.html)

**In the graph:** 🔵 session · 🟣 decision · 🔴 bug · 🟢 learning · 🟡 change — every note, backlinked.

**A persistent‑memory harness for AI coding agents, built on your Obsidian vault.** Every Claude Code / Codex session is captured turn‑by‑turn into local Markdown — with token/cost tracking, auto‑extracted decisions, bugs and learnings, and a curated memory layer injected back at the start of the next session. On top of that memory core sits a native, zero‑dependency **change lifecycle** (spec → change → TDD → sensor‑gated archive) that keeps intent, work and proof wikilinked in one graph. 100% local, open‑core.

```bash
npm i -D wendkeep && npx wendkeep init      # captures from the next session on
npx wendkeep import                          # backfill past Claude + Codex sessions
```

**▶ Interactive demo:** [`docs/index.html`](docs/index.html) — a self-contained page with the live knowledge‑graph hero. Open it locally (or serve `docs/` on any static host). The image above is a static render of it.

> **From one real production vault** (`npx wendkeep stats`): **308** sessions · **1,696** prompts · **$4,836** captured across **46 active days** (Jan–Jul 2026) · **15** models — every one a note in the graph.

<!-- Optional: drop a real Obsidian graph screenshot at docs/assets/graph.png and add it here (see docs/21-graph-screenshot.md). -->

> Extracted from a system in daily production use: the capture engine, cost tracking and graph wiring are battle‑tested; the cross‑platform installer (`wendkeep init`) and the native change loop are the newer parts. See [`docs/`](https://github.com/rogersialves/wendkeep/tree/main/docs) for the project's strategy and decision log.

---

## The problem: the context dies when the window closes

Decisions, dead ends, the reason you chose X over Y — gone next session. The pieces to fix that exist but are scattered (qmd‑sessions, memsearch, Nexus, hand‑written hooks). wendkeep ships them as one turnkey package that writes into a knowledge graph **inside the Obsidian vault you already use** — no manual setup, no snapshot to keep in sync.

| | |
|---|---|
| **Capture** — every turn, on disk | `SessionStart` / `Stop` hooks write each session to a dated Markdown note: prompts, iterations, files touched, wikilinks. |
| **Derive** — decisions, bugs, learnings | Pulled from the transcript into their own notes, backlinked to the session. Your history becomes navigable, not archival. |
| **Recall** — injected back | A budget‑capped `CORE` + `DIGEST` and the active change are fed to the agent at the next `SessionStart`. It resumes where it left off. |
| **Cost** — what it all cost | Per‑model, cache‑aware token pricing per session — plus `cost --trend` with a run‑rate projection across the whole vault. |
| **Multi‑agent** — one install, all agents | Detects the real provider (Claude Code, Codex, Copilot) at runtime. |
| **Local‑first** — no cloud, no account | Everything is plain Markdown on your disk. An optional MCP server (`@bitbonsai/mcpvault`) lets the agent read/write the vault. |

## Requirements

- Node.js ≥ 18
- An AI coding agent with hooks (Claude Code today; Codex supported by the same hooks)
- Obsidian (to view the graph) — optional but the point

## Install & set up

```bash
# in your project
npm install --save-dev wendkeep   # or: npm install -g wendkeep
npx wendkeep init
```

`wendkeep init` is interactive and **idempotent**. It will:

1. Create the vault folder taxonomy and a templated `README.md` (default vault: `<project>/.<project-name>-vault`, e.g. `.MyApp-vault`; override with `--vault`).
2. **Merge** the three session hooks and `OBSIDIAN_VAULT_PATH` into `.claude/settings.json` — without clobbering your existing settings (a `.bak` is saved; an unparseable file is left untouched and a `.new` is written for you to merge).
3. Add the **`wendkeep-vault`** MCP server to `.mcp.json` so the agent can read/write the vault. Skip with `--no-mcp` — e.g. when the agent already has a vault MCP. (`--no-mcp` skips *only wendkeep's own* MCP; companion MCPs still follow `--companions`.)
4. Offer to pin **companion** plugins/MCP (multi-choice; only `context-mode` pre-checked). Each is wired the most agent-agnostic way it supports:
   - **`context-mode`** — context optimizer + FTS5 memory, as a `.mcp.json` MCP server (any agent). The recommended default.
   - **`understand-anything`** — project domain graph, via a `understand-inject` SessionStart hook that injects the graph when generated.
   - **`caveman`** — token-compression mode; runs its own cross-agent installer on non-Claude agents.
   - **`dotcontext`** — *legacy, not recommended.* wendkeep's native a2 loop (`change` / `verify` / gate) already does its job, so installing it **duplicates the harness**. Still selectable via `--companions dotcontext` for anyone already invested (tune with `--dotcontext-mcp` / `--dotcontext-hooks`), but off by default.

   Control with `--companions <csv>` or `--no-companions`. The Claude Code plugin layer (`extraKnownMarketplaces` + `enabledPlugins`) is wired as a bonus where the companion has one.
5. Install a **color system** into the vault's `.obsidian/`: a CSS snippet that accents notes by type (session/decision/bug/learning, via the `cssclasses` the hooks emit) plus graph color groups by folder. Non-destructive merge into `appearance.json`/`graph.json`; skip with `--no-colors`.
6. Seed the **curated memory layer**: `.brain/CORE.md` (the hand-curated hot layer, with the 3 required sections) and `.brain/COMPACTION_PROTOCOL.md` (the protocol guide). The auto layers (`DIGEST.md`, `index.jsonl`) are generated by the hooks. Validate the curated layer with `wendkeep validate-memory` (cap 25 lines, 3 sections, no secrets/PII).
7. Seed the **definitions + skills layer**: `.brain/agents/` + `.brain/skills/` (versioned source of truth), including the native process skills `wk-workflow` / `wk-tdd` / `wk-debugging` / `wk-brainstorming` / `wk-planning` / `wk-verify`. `init` delivers them to `.codex/agents/`, `.claude/skills/`, and `.agents/skills/`; `sync-defs --check` detects stale copies.
8. Seed the **change/spec lifecycle**: the `07-Specs/` + `08-Mudanças/` folders and a native `wendkeep.sensors.json` (a `validate-memory` sensor plus one per detected `package.json` script). Drives `wendkeep change` / `wendkeep verify` — see **Change lifecycle** below.

```bash
npx wendkeep init --vault "~/vaults/work" --project . --yes   # non-interactive (default companion: context-mode)
npx wendkeep init --companions "context-mode,understand-anything" --yes
npx wendkeep init --no-companions --no-mcp --yes              # zero companions, no wendkeep MCP
```

### `init` options

| Flag | What it does |
|---|---|
| `--vault <path>` | Vault folder. Default `<project>/.<project-name>-vault`; interactive init asks. Point it at an existing vault to install into it. |
| `--project <path>` | Project root to wire (default: current directory). |
| `--locale <pt-BR\|en>` | Vault language — folder names, scaffold, skills. Interactive init asks; locked at init. |
| `--companions <csv>` | Companions to pin: `context-mode,caveman,understand-anything` (default: **none** — opt in explicitly; `dotcontext` is legacy). |
| `--no-companions` | Pin no companions. |
| `--no-mcp` | Skip **wendkeep's own** vault MCP (`wendkeep-vault`). Companion MCPs still follow `--companions`. |
| `--no-colors` | Skip the Obsidian color system (`.obsidian` snippet + graph groups). |
| `--yes`, `-y` | Non-interactive; accept defaults (skips the language / vault / companion prompts). |
| `--force` | Overwrite existing wendkeep config blocks. |

Then open the vault in Obsidian, send a test prompt in your agent, and confirm a note appears under `02-Sessões/…` (or `02-Sessions/…` for an `en` vault).

## Updating

Because the hooks live inside the installed package (settings.json calls `npx wendkeep hook <name>`), upgrading is just:

```bash
npm update wendkeep
```

No re‑copying, no snapshot to re‑sync — the package is the single source of truth.

## Commands

| Command | What it does |
|---|---|
| `wendkeep init` | Set up wendkeep in a project (vault taxonomy + settings + MCP + skills). |
| `wendkeep hook <name>` | Run a session hook; invoked by `settings.json` (reads agent JSON on stdin). |
| `wendkeep change <sub>` | Change lifecycle: `new [--simple]` / `list` (global backlog) / `show` / `status [slug]` / `done <id> [--change slug]` / `undone <id> [--change slug]` / `diff` / `archive [--force]`. |
| `wendkeep verify [--deep]` | Run the change's task sensors; `--deep` assembles the independent-verification package. |
| `wendkeep spec <sub>` | `list` / `show` generated contracts; `effective --change <slug>`; `migrate`; `rebase`. |
| `wendkeep sensors <sub>` | `list` / `add <id> "<command>"` — view/edit `wendkeep.sensors.json` (JSON Schema shipped). |
| `wendkeep cost [--since d]` | Aggregate AI-coding spend across the vault's sessions — total, by model, by day (`--json`). |
| `wendkeep import [opts]` | **Retroactive memory** — backfill past **Claude + Codex** sessions into the vault (deduped by `session_id`). `--source all\|claude\|codex` / `--from <dir>` / `--codex-from <dir>` / `--since d` / `--limit n` / `--dry-run` / `--json`. |
| `wendkeep cost rebuild [opts]` | Recalcula custos históricos do transcript principal e subagents usando `SESSION_REGISTRY`. Dry-run por padrão; `--apply` atualiza notas e grava `.brain/COST_REBUILD.json`. Aceita `--session`, `--limit` e `--json`. |
| `wendkeep session list\|show\|use` | Lista o registry multi-sessão, mostra uma conversa ou muda somente o foco humano de `CURRENT_SESSION.md`. |
| `wendkeep change bind <slug> --session <id>` | Vincula ou transfere uma change para uma conversa canônica sem esconder as demais pendências. |

Session notes use one live `## Agentes, tokens e custos` snapshot. Main-agent and subagent hooks recompose it atomically, with costs, token dimensions, reasoning tokens and effort per model/source.
| `wendkeep lesson add "t" "l"` | Record a project-local lesson (injected at the next SessionStart). |
| `wendkeep sync-defs` | Copy `.brain/agents\|skills` into `.codex/agents`, `.claude/skills`, `.agents/skills`; `--check` detects drift. |
| `wendkeep validate-memory [path]` | Validate `.brain/CORE.md` (cap 25, 3 sections, no secrets/PII). |
| `wendkeep doctor [--vault P]` | Run a vault health check (integrity of sessions, registry, links). |
| `wendkeep --version` / `--help` | Version / usage. |

## Retroactive memory (`import`) — install today, remember yesterday

Install wendkeep into an existing project and it only remembers sessions **from now on**. `wendkeep import` fixes that: one command backfills your project's past **Claude & Codex** sessions into the vault — deduped, dated, with cost — so the graph starts full, not empty. It rebuilds each transcript as a full session note in its **real** date folder — frontmatter (tagged with the transcript's real provider), one iteration block per turn, cost + subagent telemetry, derived decision/bug/learning notes, finalized closing. An offline replay of the live capture flow, so an imported note is indistinguishable from a captured one.

```bash
wendkeep import --vault .myproject-vault --dry-run   # preview what would be imported (both agents)
wendkeep import --vault .myproject-vault             # write the notes
wendkeep import --vault .myproject-vault --source codex   # just Codex
```

- **Both agents by default** (`--source all`). Claude sessions come from `~/.claude/projects/<slug>/`; Codex rollouts from `~/.codex/sessions/**`, scoped to this project by the `cwd` recorded in each session (case- and separator-insensitive, subdirs included). Narrow with `--source claude` / `--source codex`.
- Every note records its **`session_id`** and **`provider`** in frontmatter (live capture and import alike). Backfill older notes with `wendkeep import --stamp-ids` (fills the id from the registry; idempotent).
- **Deduped** by `session_id` against the vault's `SESSION_REGISTRY` **and** existing notes' frontmatter — only sessions not already present are imported, and it never overwrites an existing note. Re-running is a no-op.
- **`--from <dir>`** / **`--codex-from <dir>`** point at the transcript folders explicitly (use if the auto-derived path misses). Also: `--since <date>`, `--limit <n>`, `--json`.
- Once imported, `wendkeep cost` aggregates your entire history — retroactively, across both agents.

## Change lifecycle — the a2 loop (spec‑driven, native)

Beyond capturing sessions, wendkeep is a **harness**: a native, zero‑dependency loop that keeps *intent* (specs), *work* (changes) and *proof* (sensors) together in the vault, wikilinked into the Obsidian graph.

```
explore → propose → apply (TDD) → verify → archive
```

- **Propose** — `wendkeep change new <slug>` scaffolds `08-Mudanças/<slug>/` (`proposta.md`, `design.md`, `tarefas.md`, and a `specs/` delta). It becomes the global *current* change. Multiple changes may remain open; `change use <slug>` changes focus and `change continue <archived> <new>` creates an auditable continuation.
- **Apply** — implement each `tarefas.md` task. Tag a task that needs machine proof with `[sensor:<id>]`.
- **Verify** — `wendkeep verify` records sensor evidence. `verify --deep` builds a self-contained package with complete effective requirements (living contract + this change's delta), so the independent verifier never needs to reconstruct unarchived requirements from `07-Specs`.
- **Archive** — `wendkeep change archive <slug>` **gates** on the evidence (blocks unless every declared critical sensor is green), promotes each capability's spec delta (`ADDED`/`MODIFIED`/`REMOVED`) into the living `07-Specs/<capability>.md`, moves the change to `_arquivo/`, and mints an ADR in `04-Decisões/`.

> The gate blocks unless the scaffold is filled, no task is open, evidence is fresh, and every declared requirement is covered. **`--force` is the human's call — never the agent's.**

`wendkeep init` seeds process skills into `.brain/skills` and delivers identical copies to Claude Code and Codex. Every skill carries source hash/version metadata; `doctor` warns when reseed + agent restart is required.

### The loop in five minutes

```bash
npx wendkeep init --yes                        # vault + hooks + sensors + skills
npx wendkeep change new dark-mode              # proposta/design/tarefas — change is now active
```

Edit `tarefas.md` — tag proof and requirement per task:

```markdown
- [ ] 1.1 toggle persists across sessions [req:UI-1] [sensor:tests]
```

Declare the capability in `proposta.md` (`specs: [ui]`) and author its delta only in
`08-Mudanças/<slug>/specs/ui/spec.md`. `07-Specs` is generated/read-only. Then:

```bash
npx wendkeep change status                     # one screen: tasks / sensors / verdict
npx wendkeep change list                       # all open changes + pending tasks
npx wendkeep change status dark-mode           # one change in detail
npx wendkeep spec effective --change dark-mode # living contract + this change's delta
npx wendkeep change done 1.1                   # tick a task from the CLI
npx wendkeep verify                            # run the declared sensors -> evidencia.json
npx wendkeep verify --deep                     # assemble the verification package
# the wk-verify skill (fresh, read-only pass) writes verdict.json
npx wendkeep change diff                       # preview what will land in 07-Specs
npx wendkeep change archive dark-mode          # gate: sensors + verdict + no open tasks
```

The archive promotes the delta into generated `07-Specs/ui.md`, mints an ADR, and the
Obsidian graph now links *session ↔ change ↔ requirement ↔ decision*. A change that names
no `[req:]` skips the independent verdict — the sensor gate is its proof.

## How it works

```
agent session ──hooks──▶ wendkeep ──▶ Markdown in vault ──▶ .brain index + Obsidian graph
   (Claude/Codex)        (Node)      (02-Sessões/…)        (CORE+DIGEST, backlinks)
```

The agent's settings.json points each hook at `npx wendkeep hook …`. On `Stop`, wendkeep parses the session transcript, appends the turn, updates the token/cost table, and (idempotently) emits any decision/bug/learning notes. On every `SessionStart`, `brain-inject` injects back curated memory (CORE + DIGEST), every open change with its pending tasks, the global current-change marker, project lessons, and a `<wk_process>` router. Claude, Codex, or another agent can therefore resume work started elsewhere without hiding the rest of the backlog.

The archive **gate** blocks unless: the change scaffold is filled (G0), no task is open (G1), every declared critical sensor is green (with fresh evidence), and — when the change declares `[req:]` — an independent `verdict.json` covers them. `--force` is the human escape hatch; the agent is instructed never to use it on its own.

## Notes & roadmap

- **Vault folder names default to Portuguese** (`02-Sessões`, `04-Decisões`, …). Pass `wendkeep init --locale en` for an English vault (`02-Sessions`, `04-Decisions`, English scaffold/skills). The locale is a vault property, locked at init; parsers are bilingual so mixed content never breaks.
- **Search is keyword/frontmatter scoring**, not on‑device embeddings (that's on the roadmap).
- **Transcript formats are agent‑internal** and can change between agent versions; parsing is isolated but may need updates.
- Installer wires **Claude Code** settings + `.mcp.json`. Codex hooks run on the same scripts but are not auto‑wired yet (import already covers past Codex sessions via `--source codex`).

---

## Stop re‑explaining your codebase every morning

```bash
npm i -D wendkeep && npx wendkeep init
```

**[Install from npm](https://www.npmjs.com/package/wendkeep)** · **[Star on GitHub](https://github.com/rogersialves/wendkeep)** — MIT · open‑core · your data never leaves your disk.

## License

MIT
