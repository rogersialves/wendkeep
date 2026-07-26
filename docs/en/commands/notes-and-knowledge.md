# Derived notes and knowledge graph

**English** · [Português](../../pt-BR/commands/notes-and-knowledge.md)

## Purpose

Create, repair, number, and navigate decisions, bugs, and learnings while preserving provenance
and wikilinks.

## When to use

Use to record durable knowledge or repair historical notes diagnosed by doctor.

## When not to use

Do not hand-edit numbering or wikilinks in bulk. Do not use `--apply` before reviewing the preview.

## Prerequisites

A bound vault, identifiable source session, and backup before broad renumbering.

## Syntax

```bash
npx wendkeep dashboard [--force]
npx wendkeep note new --type bug|learning "<title>"
npx wendkeep note relink [--apply]
npx wendkeep note repair-frontmatter [--apply]
npx wendkeep note repair-sections [--apply]
npx wendkeep renumber-decisions [--apply]
npx wendkeep renumber-bugs [--apply]
npx wendkeep renumber-learnings [--apply]
npx wendkeep lesson add "<title>" "<lesson>"
```

## Options and exit codes

- `note new` creates a monthly `BUG-NNNN` or `APR-NNNN` and accepts `--date`.
- `note relink`, `repair-frontmatter`, `repair-sections`, and `renumber-*` default to dry-run;
  `--apply` writes and `--json` supports audit.
- `dashboard --force` regenerates Bases/MOC when required.
- `lesson add` accepts `--change <slug>` and `--vault` to bind local learning.
- Exit `0` means a consistent preview/application; non-zero makes incomplete repair explicit.

## Examples

```bash
npx wendkeep note new --type bug "refresh expires during upload"
npx wendkeep note relink --json
npx wendkeep renumber-decisions --json
# review before repeating with --apply
npx wendkeep dashboard --force
```

## Expected result

Derived notes live in the month folder, use global per-type numbering, and link back to the source
session. Repairs preserve valid frontmatter and rewrite wikilinks when files move.

## Common errors and diagnosis

- Orphan note without a modal source: `note relink` reports it and does not invent provenance.
- Stacked frontmatter: repair under the same lock used by hooks.
- Grey links after renumber/archive: preview relink and inspect ambiguities.
- Sensitive title: remove secrets/PII before persistence.

## Next steps

See [sessions and import](sessions-and-import.md), [costs and observability](costs-and-observability.md),
and [maintenance](maintenance-and-diagnostics.md).
