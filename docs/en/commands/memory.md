# Shared memory and curation

**English** · [Português](../../pt-BR/commands/memory.md)

## Purpose

Inspect and curate CORE, SHARED, ledger, outbox, and candidates without confusing canonical
authorship with generated operational state.

## When to use

Use in CI, before verify/archive, after doctor warnings, or when deciding candidates.

## When not to use

Do not hand-edit `SHARED_MEMORY.md` or `MEMORY_EVENTS.jsonl`. Do not repair a healthy legacy vault
that merely awaits migration.

## Prerequisites

Pass the vault explicitly in automation. Preserve backups and evidence before repair.

## Syntax

```bash
npx wendkeep memory status [--gate] --vault <vault>
npx wendkeep memory repair --vault <vault>
npx wendkeep memory promote <candidate> --vault <vault>
npx wendkeep memory reject <candidate> --vault <vault>
npx wendkeep validate-memory [CORE-path]
npx wendkeep validate-memory --vault <v2-vault>
```

## Options and exit codes

- `memory status` is read-only; `--gate` exits `1` only for blocking state.
- A valid legacy vault warns and exits `0`; corruption, lag/hash mismatch, or active blocking
  conflict exits `1`.
- `memory repair` locks, writes a `.bak`, retains valid events, and reprojects state.
- `promote`/`reject` append auditable decisions and never rewrite the ledger in place.
- `validate-memory <CORE.md>` checks the 25-line cap, required sections, and secrets.
- `validate-memory --vault` requires a complete v2 bundle and is not the legacy-vault gate.

## Examples

```bash
npx wendkeep memory status --gate --vault .MyApp-vault
npx wendkeep validate-memory .MyApp-vault/.brain/CORE.md
npx wendkeep memory promote candidate-123 --vault .MyApp-vault
```

## Expected result

Status prints schema, revision, cursor, hash, events, outbox, candidates, and conflicts. CORE stays
hand-curated and canonical; SHARED stays a verifiable operational projection.

## Common errors and diagnosis

- `legacy`: follow the migration guide; this is not corruption.
- Ordinary pending candidate: recoverable warning, requiring human choice when appropriate.
- Missing `event_cursor` or mismatched v2 hash: preserve the bundle and assess `memory repair`.
- `validate-memory --vault` fails on legacy: validate CORE only or migrate first.

## Next steps

Read [memory migration](memory-migration.md), [maintenance](maintenance-and-diagnostics.md), and
[verify](verify.md).
