# Sessions, hooks, and import

**English** · [Português](../../pt-BR/commands/sessions-and-import.md)

## Purpose

Understand how hooks capture live sessions, how activation/turn state preserves causality in the
registry, and when to use retroactive import. Under `OFF`, the Vault remains active: session,
identity, memory, cost, and persistence hooks belong to Keep Core, not Wend Runtime.

## When to use

Use `session` to inspect/focus a conversation and `import` to recover sessions from before setup or
outside the current registry.

## When not to use

Do not invoke hooks manually without their expected JSON envelope. Do not run broad imports before
a preview when forks/subagents may duplicate history.

## Prerequisites

Installed hooks for live capture; for imports, local access to Claude/Codex transcript directories
and a vault bound to the correct project.

## Syntax

```bash
npx wendkeep hook <name>
npx wendkeep session list
npx wendkeep session show <id>
npx wendkeep session use <id>
npx wendkeep import [options]
```

## Options and exit codes

- `wendkeep hook <name>` reads the agent payload from stdin; valid names are listed by `--help`.
- `SessionStart` opens an activation: an epoch that remains active across multiple `Stop` events;
  only a new `SessionStart` supersedes the previous epoch.
- `UserPromptSubmit` advances the active activation's native turn. If it finds a legacy registry
  with a closed epoch, it opens exactly one recovery activation; replaying the same prompt does
  not open another one.
- On Codex, `session_id`, the native `turn_id`, and observed transcript order are enough to resolve
  the turn. Hook payloads do not need invented `activation_id` or `turn_sequence` fields.
- `Stop` accepts only a transcript-proven turn from the compatible active activation. Duplicates
  are no-ops; stale/superseded Stops neither publish memory nor overwrite a newer epoch's
  checkpoint.
- `Stop` receives an absolute **45 s** deadline from hook entry. Reads check the clock between
  rollouts and on every chunk; reaching the limit returns `degraded` before the host timeout.
- `SubagentStop` receives an absolute **15 s** deadline. Signals arriving within the **250 ms**
  window are coalesced: only the highest sequence recomposes/publishes, without losing the last
  child.
- Observability is tri-state: `complete` publishes the full snapshot; `none` means zero proven by
  a causal Stop or stable offline scan; `degraded` preserves the previous snapshot and allowlisted
  diagnostics. An isolated `SubagentStop` never publishes `none`.
- When compacting conversations into `## Iterações`, the hook escapes code delimiters cut by the
  size limit; inline backticks and fences never remain open and consume the following line.
- `session list` reads `SESSION_REGISTRY`; `show` displays one session and `use` only changes human
  focus in `CURRENT_SESSION.md`.
- `import --source all|claude|codex`, `--since`, `--limit`, `--from`, and `--codex-from` bound scope.
- `--dry-run`/`--json` support audit before writes; `--stamp-ids` and `--rescan-decisions` address
  specific historical gaps.
- `import` reconciles observability even when no `wk-turn` is missing: a legacy schema, stale
  frontier, or unproven manifest triggers recomposition without duplicating iterations. A fresh
  checkpoint remains byte-identical; `degraded` is reported and does not change the note.
- Exit `0` means consistent processing; non-zero reports invalid source/config/write instead of
  presenting silent partial success.

## Examples

```bash
npx wendkeep session list
npx wendkeep session show 019abc-session-id
npx wendkeep import --source codex --since 2026-07-01 --dry-run --json
```

## Expected result

Each canonical session points to the matching provider, transcript, note file, and costs. The
registry keeps one `SessionStart` epoch per activation plus the latest native turn; multiple
`Stop` events may acknowledge turns in that epoch without closing it. Repeated imports of the
same `session_id` deduplicate; human focus does not close or re-identify live hooks. Every
automatic iteration remains valid Markdown even when a message must be truncated.
Duplicate/stale hooks converge on the same frontier, and imports may refresh only observability
without creating a new turn block.

## Common errors and diagnosis

- Missing session: verify provider, transcript path, and registry before importing again.
- `Stop ambiguous`: the transcript did not prove the `turn_id`, or no compatible active activation
  was found; the attempt remains observable but does not publish memory.
- A late Stop reports `stale_turn`/`superseded`: the newer epoch and checkpoint are preserved; do
  not force the old payload to apply.
- Fork duplicates: bound source/date and inspect `forked_from_id`/`source.subagent`.
- Codex does not capture: approve hooks and start a new session after `sync`.
- Contaminated cost: validate `session_id → session_file → transcript_path → provider`.
- `degraded` observability: preserve the note and run a targeted rebuild dry-run; never force a
  partial snapshot over the last `complete` one.

## Next steps

Read [Operating profiles](operating-profiles.md), [retroactive import](retroactive-import.md),
[costs and observability](costs-and-observability.md), and [notes](notes-and-knowledge.md).
