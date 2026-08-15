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
npx wendkeep hook session-backfill --session <id> [--write]
npx wendkeep import [options]
```

## Options and exit codes

- `wendkeep hook <name>` reads the agent payload from stdin; valid names are listed by `--help`.
- `SessionStart` opens an activation: an epoch that remains active across multiple `Stop` events;
  only a new `SessionStart` supersedes the previous epoch.
- Main-agent `UserPromptSubmit` advances the active activation's native turn. A Codex rollout
  prompt with `source.subagent` only registers its path for observability: it does not advance the
  sequence, enter `turn_sequences`, or replace the main transcript. If a main prompt finds a
  legacy registry with a closed epoch, it opens exactly one recovery activation; replaying the
  same prompt does not open another one.
- On Codex, `session_id` and the native `turn_id` are enough to resolve the turn. Stop proves the
  ID in the transcript and prefers `SESSION_REGISTRY.turn_sequences[turn_id]`; local transcript
  order is the legacy-registry fallback. Interleaved subagent turns therefore cannot make the
  parent's Stop artificially `stale_turn`. Hook payloads need no invented `activation_id` or
  `turn_sequence` fields.
- `Stop` accepts only a transcript-proven turn from the compatible active activation. Duplicates
  are no-ops; stale/superseded Stops neither publish memory nor overwrite a newer epoch's
  checkpoint.
- `Stop` receives an absolute **45 s** deadline from hook entry. Reads check the clock between
  rollouts and on every chunk; reaching the limit returns `degraded` before the host timeout.
- `SubagentStop` receives an absolute **15 s** deadline and resolves the child rollout from Codex's
  official `agent_transcript_path` field (`agentTranscriptPath` is also accepted);
  `transcript_path` continues to identify the parent session. Before any write, `source.subagent`,
  ID, canonical session, and `parent_thread_id` are validated; the parent must match a proven
  session root. Signals arriving within the **250 ms** window are coalesced: only the highest
  sequence recomposes/publishes, without losing the last child.
- Observability is tri-state: `complete` publishes the full snapshot; `none` means zero proven by
  a causal Stop or stable offline scan; `degraded` preserves the previous snapshot and allowlisted
  diagnostics. An isolated `SubagentStop` never publishes `none`.
- Every terminal `Stop`/`SubagentStop` attempt leaves a sanitized receipt in
  `.brain/SESSION_ITERATION_OUTCOMES.jsonl`, keyed by session, `turn_id`, and stage. States
  distinguish `inserted`, `duplicate`, `skipped`, `aborted`, `busy`, `failed`, and observability
  statuses; the cursor advances only after the note is confirmed. The ledger is local, append-only,
  idempotent, and never persists prompts, payloads, raw arguments, or raw errors.
- In Codex, `subagent_notification` remains synthetic, `turn_aborted` is an explicit terminal
  state, and `custom_tool_call_output` closes the existing call without counting a second tool.
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
- On definitive close, Stop marks the activation and session `done` in `SESSION_REGISTRY.json`
  only after memory/observability publication; `CURRENT_SESSION.md` is a derived view and no
  longer lists the finalized session. Hooks resolve identity from the registry and transcript,
  never from the global pointer.
- `hook session-backfill` recovers missing `wk-turn` markers for the selected session. Without
  `--write`, it only reports. On Codex, `missingTurns` contains only turns with `task_complete`;
  open turns appear under `incompleteTurns` and are never written. `--write` applies only completed
  candidates, and a second run is idempotent.
- Exit `0` means consistent processing; non-zero reports invalid source/config/write instead of
  presenting silent partial success.

## Examples

```bash
npx wendkeep session list
npx wendkeep session show 019abc-session-id
npx wendkeep hook session-backfill --session 019abc-session-id
npx wendkeep hook session-backfill --session 019abc-session-id --write
npx wendkeep import --source codex --since 2026-07-01 --dry-run --json
```

## Expected result

Each canonical session points to the matching provider, transcript, note file, and costs. The
registry keeps one `SessionStart` epoch per activation plus the latest native turn; multiple
`Stop` events may acknowledge turns in that epoch without closing it. Repeated imports of the
same `session_id` deduplicate; human focus does not close or re-identify live hooks. Every
automatic iteration remains valid Markdown even when a message must be truncated. Complete or
truncated trailing internal metadata is removed only from assistant messages; a reproduction
written by the user remains in the transcript. In the note, XML-like tags are encoded as visible
text — including placeholders such as `<session>` — without changing `<https://...>` autolinks.
Reimport and `SessionStop` share the same idempotent normalizer; when an older note is finalized,
only recognized generated fields under `Iterações` and `Encerramento` are migrated, without rewriting
authored prose.
Duplicate/stale hooks converge on the same frontier, and imports may refresh only observability
without creating a new turn block.
The per-attempt receipt in `SESSION_ITERATION_OUTCOMES.jsonl` distinguishes a confirmed duplicate
from a busy lock or skipped path without reopening the original session.

## Common errors and diagnosis

- Missing session: verify provider, transcript path, and registry before importing again.
- `Stop ambiguous`: the transcript did not prove the `turn_id`, or no compatible active activation
  was found; the attempt remains observable but does not publish memory.
- A late Stop reports `stale_turn`/`superseded`: the newer epoch and checkpoint are preserved; do
  not force the old payload to apply.
- `session-backfill` lists `incompleteTurns`: wait for that turn's `task_complete`/Stop and retry;
  do not edit the note or force the partial turn. Once that turn receives `task_complete`, the next
  run may treat it as eligible. Claude transcripts preserve their historical contract and do not
  require this Codex event.
- Fork duplicates: bound source/date and inspect `forked_from_id`/`source.subagent`.
- Codex does not capture: approve hooks and start a new session after `sync`.
- Contaminated cost: validate `session_id → session_file → transcript_path → provider`.
- `degraded` observability: preserve the note and run a targeted rebuild dry-run; never force a
  partial snapshot over the last `complete` one.
- Missing or `busy` outcome ledger: preserve the transcript and note, inspect the Vault lock, and
  retry the bounded hook/replay path; never mark the turn projected by hand.

## Next steps

Read [Operating profiles](operating-profiles.md), [retroactive import](retroactive-import.md),
[costs and observability](costs-and-observability.md), and [notes](notes-and-knowledge.md).
