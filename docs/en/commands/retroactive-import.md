# Safe retroactive import

**English** · [Português](../../pt-BR/commands/retroactive-import.md)

## Purpose

Import historical Claude and Codex sessions with bounded scope, stable identity, and review before
writes.

## When to use

Use when installing WendKeep in an existing project, recovering a date range, or rescanning
decisions without importing every transcript on the machine.

## When not to use

Do not use `--source all` without dry-run on machines with many projects, forks, or subagent
rollouts. Do not treat imported conversation history as current implementation evidence.

## Prerequisites

Confirm project, vault, provider, source directory, and date window. Back up the registry if it
already contains manual repairs.

## Syntax

```bash
npx wendkeep import --dry-run --json
npx wendkeep import --source claude|codex|all [--since <date>] [--limit <n>]
npx wendkeep import --from <claude-dir> --codex-from <codex-dir>
npx wendkeep import --stamp-ids | --rescan-decisions
```

## Options and exit codes

- `--source` bounds provider; `--since` and `--limit` bound volume.
- `--from`/`--codex-from` override discovered directories.
- `--dry-run` performs zero writes; `--json` emits an auditable report.
- `--stamp-ids` fills IDs in existing notes; `--rescan-decisions` reruns prose extraction.
- Exit `0` means a consistent scan/import; non-zero requires fixing source, parsing, or identity
  before retrying.

## Examples

```bash
npx wendkeep import --source codex --since 2026-07-20 --limit 20 --dry-run --json
# inspect accepted/skipped/forks
npx wendkeep import --source codex --since 2026-07-20 --limit 20
```

## Expected result

Accepted sessions enter once per `session_id` with matching provider/transcript. Canonical
duplicates are skipped; forks/subagents retain origin relationships instead of copying inherited
history into another full independent conversation.

## Common errors and diagnosis

- Cross-project contamination: stop and verify cwd, binding, and filters before cleaning notes.
- Ordinary fork imported as full session: inspect `forked_from_id` and source payload.
- Note without `session_id`: use `--stamp-ids` only after dry-run.
- Missing decisions in an imported note: prefer `--rescan-decisions` over duplicating the session.

## Next steps

Return to [sessions and hooks](sessions-and-import.md), generate [costs](costs-and-observability.md),
and review [derived notes](notes-and-knowledge.md).
