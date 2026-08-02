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
npx --no-install wendkeep stats [--vault <vault>] [--json]
npx --no-install wendkeep cost [--since <date>] [--top [N]] [--trend day|week|month] [--write] [--json]
npx --no-install wendkeep cost rebuild [--session <id|file>] [--vault <vault>] [--limit N] [--max-graph-nodes N] [--max-fallback-days N] [--max-fallback-candidates N] [--apply] [--json]
```

## Options and exit codes

- `wendkeep stats` emits one shareable line or JSON.
- `wendkeep cost` aggregates total/model/day; `--trend` adds projection and `--write` refreshes
  `00-Custo.md`.
- `wendkeep cost rebuild` is dry-run by default and performs **zero writes**: it acquires no write
  lock, changes no note, registry, or runtime state, and does not create `.brain/COST_REBUILD.json`.
- `--apply` publishes only `complete` or `none` candidates. The `none` state clears the section
  only after a stable offline scan proves that no subagent was started.
- A `degraded` or `stale` candidate returns exit `1` and preserves the note without changes; the
  batch continues so other safe sessions can be processed and the report can expose sanitized
  diagnostic codes.
- The `--max-graph-nodes`, `--max-fallback-days`, and `--max-fallback-candidates` overrides are
  exclusively for a targeted rebuild with `--session`. Using them without `--session` is invalid
  usage and returns exit `2`; hooks, import, and bulk rebuild retain the default limits.
- Exit `0` means a consistent preview/apply; exit `1` means a partial `degraded`/`stale` result;
  exit `2` means invalid syntax or context.

## Examples

```bash
npx --no-install wendkeep stats --vault .MyApp-vault
npx --no-install wendkeep cost --since 2026-07-01 --top 10 --trend week
npx --no-install wendkeep cost rebuild --session 019abc --json --vault .MyApp-vault
npx --no-install wendkeep cost rebuild --session 019abc --max-graph-nodes 8192 --json --vault .MyApp-vault
npx --no-install wendkeep cost rebuild --session 019abc --json --vault .MyApp-vault --apply
```

## Expected result

Totals retain input/output/cache/reasoning dimensions by model and period. Tri-state composition
returns `complete`, `none`, or `degraded`, plus a frontier, manifest, and sanitized diagnostics.
Run and review the dry-run before repeating the same command with `--apply`; a semantically
identical second apply preserves the note, checkpoint, report, and mtime.

## Common errors and diagnosis

- Model without a price: update the table before accepting totals.
- Wrong-provider costs: validate the session identity chain.
- Missing transcript: do not estimate silently; keep the gap visible.
- Duplicated parent/subagent/fork totals: verify registry relationships and deduplication.
- `degraded`/`stale`: preserve the note and inspect diagnostics/frontier before authorizing apply.
- Rejected override: add `--session <id|file>` or remove the three targeted limits.

## Next steps

See [sessions and import](sessions-and-import.md), [retroactive import](retroactive-import.md), and
[maintenance](maintenance-and-diagnostics.md).
