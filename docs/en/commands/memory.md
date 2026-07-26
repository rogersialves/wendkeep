# Shared memory and curation

**English** · [Português](../../pt-BR/commands/memory.md)

## Purpose

Inspect and curate CORE, SHARED, ledger, outbox, attempts, and candidates without confusing
canonical authorship with generated operational state.

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
- `Stop` writes events to the outbox before acknowledging `last_memory_attempt: enqueued`, then the
  projector runs outside the registry lock. Retrying the same attempt reuses its frozen event IDs
  and can project them at most once.
- A busy/failed projector persists `degraded`, preserves the outbox, and reports replay. A later
  Stop/retry reuses that attempt instead of rebuilding its handoff from new transient data.
- The outcome updates `memory_status`/checkpoint only while activation, epoch, turn, and attempt
  still match exactly. A stale/superseded result cannot clear or overwrite a newer checkpoint.
- A valid legacy vault warns and exits `0`. For v2, status correlates `last_memory_attempt`,
  disposition, outbox, ledger, SHARED, and checkpoint: an ambiguous attempt, lost publication, or
  mismatched checkpoint blocks; `degraded` with an intact outbox is a warning.
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

Status prints schema, revision, cursor, hash, events, outbox, candidates, conflicts, and the causal
state of the last attempt. CORE stays hand-curated and canonical; SHARED stays a verifiable
operational projection. After successful projection, an attempt checkpoint may be a valid prefix
of a global projection that has already advanced with concurrent events.

## Common errors and diagnosis

- `legacy`: follow the migration guide; this is not corruption.
- `revision: 0` immediately after a valid migration, with no v2 attempt, is healthy; do not run
  repair merely to manufacture the first event.
- `degraded` with every event ID present in either the ledger or an intact outbox is recoverable;
  let idempotent replay finish. An event ID absent from both locations means lost publication.
- An `ambiguous` attempt, an `applied` attempt without event IDs, a `projected` event found only in
  the outbox, or a mismatched checkpoint is blocking: preserve the artifacts and investigate
  before repair.
- Ordinary pending candidate: recoverable warning, requiring human choice when appropriate.
- Missing `event_cursor` or mismatched v2 hash: preserve the bundle and assess `memory repair`.
- `validate-memory --vault` fails on legacy: validate CORE only or migrate first.

## Next steps

Read [memory migration](memory-migration.md), [maintenance](maintenance-and-diagnostics.md), and
[verify](verify.md).
