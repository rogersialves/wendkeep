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
npx wendkeep memory reconcile <ambiguous-session> --by-session <successor-session> --reason <reason> [--apply] --vault <vault>
npx wendkeep memory promote <candidate> [--event <event-id>] --vault <vault>
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
- `memory repair` is structural only: it uses PID/token-owned locks, writes a `.bak`, retains
  valid events, and reprojects state. When it recognizes a valid pre-0.59 checkpoint whose cursor
  is causal, it CAS-migrates it to the physical boundary. It also recognizes an assert-only
  historical prefix only when revision, cursor, hash, identity, turns, and the
  `memory_checkpoint` mirror exactly reproduce the old semantics; the target is the current replay
  of that prefix, without absorbing later events. Both paths CAS-check the attempt and mirror and
  record backup/audit. Repair never reclassifies registry attempts or accepts a tuple, operation,
  or mirror that cannot be fully re-derived.
- `memory reconcile` is a dry run by default. `--apply` requires two named sessions plus a reason,
  CAS-checks the exact attempt, backs up the registry, and limits mutation to the ambiguous attempt
  and its successor. Replay is CORE-aware, checkpoints use the physical ledger cursor, and the
  command neither rewrites ledger/CORE/notes nor consumes the outbox. Retrying the same applied
  decision is idempotent.
- Every memory path validates the physical topology of `.brain`, ledger, outbox, CORE, SHARED,
  candidates, registry, notes, backups, temporary files, and sidecars before reading or writing.
  Junctions, symlinks, reparse points, or hardlinks fail closed without touching external bytes.
  Locks publish owner and lease atomically, never reap a live PID by age alone, and release only
  the lease they acquired.
- `promote`/`reject` append an auditable, idempotent decision to the ledger. Replay and repair
  preserve that decision and do not recreate the resolved candidate. For a `conflict` candidate,
  `promote` requires an `--event <event-id>` that belongs to the candidate; date or random ID
  never picks an implicit winner. `reject` preserves the current operational value. A
  `blocked_by_core` candidate can only be rejected: promotion first requires canonical CORE
  curation. If the selected event still belongs to the matching latest `projected` attempt,
  promotion also refreshes its checkpoint and mirror causally; JSON reports
  `checkpointRefreshed`, and a newer concurrent attempt remains untouched. The decision keeps
  the already validated JSON value without string coercion and copies the selected event's
  `canonical_session_id`, activation/epoch, `source_turn_id`, and `turn_sequence`. A later Stop
  from the same session/activation therefore advances the value instead of opening another candidate.
  When physical append order and `observed_at` leave a projected 0.66.1 promotion outside the
  candidate, it is added to `supersedes` only if it has the exact legacy shape, shares a candidate
  ancestor, and the selected event proves the same session/activation/epoch, a later turn, and the
  temporal inversion. `candidate_decision.event_ids` remains exactly the choice shown to the
  operator; a modern source, different lineage, or incomplete proof fails before appending an event.
- `validate-memory <CORE.md>` checks the 25-line cap, required sections, and secrets.
- `validate-memory --vault` requires a complete v2 bundle and is not the legacy-vault gate.

## Examples

```bash
npx wendkeep memory status --gate --vault .MyApp-vault
npx wendkeep memory reconcile old --by-session current --reason "delivery continued" --vault .MyApp-vault
npx wendkeep memory reconcile old --by-session current --reason "delivery continued" --apply --vault .MyApp-vault
npx wendkeep validate-memory .MyApp-vault/.brain/CORE.md
npx wendkeep memory promote candidate-123 --event mem-selected --vault .MyApp-vault
npx wendkeep memory reject candidate-456 --vault .MyApp-vault
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
  before repair. If the ambiguity is demonstrably superseded by a successor session, inspect the
  `memory reconcile` dry run before authorizing `--apply`; the command fails when the ambiguous
  attempt already contains event IDs.
- Ordinary pending candidate: recoverable warning, requiring human choice when appropriate.
- `promote` reports that `--event` is required: inspect the candidate `event_ids`, compare their
  provenance/value, and name the winner explicitly. An ID outside the candidate fails without
  mutating the ledger or projections.
- A promotion made by 0.66.1 followed by a new candidate: update to 0.66.2 or newer, inspect the
  provenance, and explicitly promote the current event once. The old ledger is not reinterpreted;
  `memory repair` and `memory reconcile` do not replace that human choice.
- `promote` says that the candidate no longer matches the causal projection: no event was appended.
  Run `memory status`, inspect the current candidate again, and do not force a different lineage.
- Missing `event_cursor` or mismatched v2 hash: preserve the bundle and assess `memory repair`.
- `validate-memory --vault` fails on legacy: validate CORE only or migrate first.

## Next steps

Read [memory migration](memory-migration.md), [maintenance](maintenance-and-diagnostics.md), and
[verify](verify.md).
