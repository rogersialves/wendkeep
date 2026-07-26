# Costs and observability

**English** · [Português](../../pt-BR/commands/costs-and-observability.md)

## Purpose

Measure sessions, prompts, models, and AI spend, and rebuild historical costs from canonical
transcripts when required.

## When to use

Use `stats` for a quick view, `cost` for analysis, and `cost rebuild` when older notes lack
trustworthy costs.

## When not to use

Do not apply rebuild before validating each session's provider and transcript. Do not compare
projects whose registries are mixed.

## Prerequisites

A consistent registry, complete price table, and transcript access for rebuilt sessions.

## Syntax

```bash
npx wendkeep stats [--vault <vault>] [--json]
npx wendkeep cost [--since <date>] [--top [N]] [--trend day|week|month] [--write] [--json]
npx wendkeep cost rebuild [--session <id|file>] [--limit N] [--apply] [--json]
```

## Options and exit codes

- `wendkeep stats` emits one shareable line or JSON.
- `wendkeep cost` aggregates total/model/day; `--trend` adds projection and `--write` refreshes
  `00-Custo.md`.
- `wendkeep cost rebuild` is dry-run by default; `--apply` writes notes and
  `.brain/COST_REBUILD.json`.
- Exit `0` means a consistent calculation; non-zero reports insufficient registry, price,
  transcript, or parsing state.

## Examples

```bash
npx wendkeep stats --vault .MyApp-vault
npx wendkeep cost --since 2026-07-01 --top 10 --trend week
npx wendkeep cost rebuild --session 019abc --json
```

## Expected result

Totals retain input/output/cache/reasoning dimensions by model and period. Rebuild shows a preview
before changing notes and leaves a reproducible report when applied.

## Common errors and diagnosis

- Model without a price: update the table before accepting totals.
- Wrong-provider costs: validate the session identity chain.
- Missing transcript: do not estimate silently; keep the gap visible.
- Duplicated parent/subagent/fork totals: verify registry relationships and deduplication.

## Next steps

See [sessions and import](sessions-and-import.md), [retroactive import](retroactive-import.md), and
[maintenance](maintenance-and-diagnostics.md).
