# Launch posts — drafts (divulgação)

Copy/edit and post. Keep it honest: it's a real tool in daily use, open-core, zero-dep, local-first.
Attach the graph screenshot (see `21-graph-screenshot.md`).

---

## Show HN

**Title:** `Show HN: Wendkeep – persistent memory for AI coding agents, in your Obsidian vault`

**Body:**

> I kept losing everything my coding agent (Claude Code / Codex) figured out — every new session started from zero. The pieces to fix that exist but are fragmented, so I packaged them into one thing that lands the memory *inside the Obsidian graph I already use*.
>
> Wendkeep hooks the agent's SessionStart/Stop, captures each session turn-by-turn as local Markdown (token/cost tracking, auto-extracted decisions/bugs/learnings), and injects a curated memory layer back at the start of the next session. On top sits a native, zero-dependency change loop: spec → change → TDD → sensor-gated archive, all wikilinked in one graph.
>
> It's 100% local (plain Markdown on disk), zero runtime dependencies, Node ≥18. `npm i -D wendkeep && npx wendkeep init`. There's also `wendkeep import` to backfill your past Claude + Codex sessions retroactively, and `wendkeep cost` to see what all this has cost you.
>
> Repo: https://github.com/rogersialves/wendkeep — npm: https://www.npmjs.com/package/wendkeep
>
> Happy to answer anything. What would make this fit your workflow?

**First comment (pre-empt the obvious):**
> Why Obsidian and not a DB: the graph *is* the UI — sessions, decisions, bugs and changes are notes that backlink, so you navigate your own history the way you already navigate notes. Nothing to keep in sync, no cloud. If you don't use Obsidian it's still just Markdown you can grep.

---

## r/ObsidianMD

**Title:** `I turned my Obsidian vault into the long-term memory for my AI coding agent`

**Body:**

> My AI coding agent forgets everything between sessions. So I made it write into my Obsidian vault instead: every session becomes a dated note (turn-by-turn, with cost), and it auto-extracts decisions, bugs and learnings into their own notes, all backlinked — so the graph fills up with the real history of a project.
>
> It also generates folder-filtered **Bases** + a Dashboard MOC, and injects a curated memory summary back into the agent at the start of the next session. Plain Markdown, local, zero dependencies.
>
> Screenshot of the graph below. Open-source: https://github.com/rogersialves/wendkeep
>
> Curious what the Obsidian crowd thinks of using the vault as an agent's memory substrate — too much noise, or useful?

---

## X / short

> Your AI coding agent forgets every session. wendkeep makes it remember — captured into your Obsidian vault as Markdown: sessions, decisions, bugs, learnings, cost, all wikilinked. Local, zero-dep. `npx wendkeep init`
>
> [graph screenshot] · github.com/rogersialves/wendkeep

Tip: paste your own `npx wendkeep stats` line for a concrete hook, e.g. *"142 sessions · 4.7k prompts · $4,701 captured across 5 months."*
