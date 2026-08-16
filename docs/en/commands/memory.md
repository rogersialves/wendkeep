# Shared memory and curation

**English** · [Português](../../pt-BR/commands/memory.md)

## Purpose

Inspect and curate CORE, SHARED, ledger, outbox, attempts, and candidates without confusing
canonical authorship with generated operational state.

`CORE.md` is the only manual, canonical layer: it accepts up to 40 lines, warns from 35,
keeps a 4 KiB ceiling, and caps each line at 320 characters. `SHARED_MEMORY.md` is generated
from the ledger and must not be hand-edited.

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
npx wendkeep memory curate --vault <vault>
npx wendkeep memory candidates [--active] --vault <vault>
npx wendkeep memory repair --vault <vault>
npx wendkeep memory recover-attempt <session> [--apply] --vault <vault>
npx wendkeep memory reconcile <ambiguous-session> --by-session <successor-session> --reason <reason> [--apply] --vault <vault>
npx wendkeep memory promote <candidate-id> [--event <event-id>] --vault <vault>
npx wendkeep memory reject <candidate-id> --vault <vault>
npx wendkeep validate-memory [CORE-path]
npx wendkeep validate-memory --vault <v2-vault>
```

## Options and exit codes

- `memory status` is read-only; `--gate` exits `1` only for blocking state.
- `memory curate` is the recommended human path: in an interactive terminal it groups each
  conflict under a friendly name, shows sanitized previews only, and offers numbered choices,
  `P` to skip, `R` to reject, `D` for technical details, and `Q` to quit. Every promotion or
  rejection asks for confirmation with default `no`: Enter or `N` does not write. Skip or quit
  leaves the remaining work pending; running the command again resumes the active conflicts.
- The assistant accepts only `--vault`: there is no `--yes`, `--apply`, or batch mode. In a
  non-TTY environment it exits `2` without changing bytes and recommends the advanced fallback
  `memory candidates --active`.
- `memory candidates` is read-only and prints deterministic JSON containing only `candidate_id`,
  `reason`, `status`, `memory_key`, and `event_ids`; it does not expose memory values or content and
  does not create a lock or mutate the bundle. `--active` omits terminal candidates (`resolved`,
  `rejected`, and `superseded`). A missing status is normalized to `active`.
- For `memory candidates`, exit `0` means a valid inventory (including empty or conflicted), exit
  `1` means an invalid sidecar/unsafe topology, and exit `2` means a missing `--vault`, unknown or
  duplicate option, extra argument, or an invalid value passed to `--active`.
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
  record backup/audit. The only narrow acknowledgement exception covers `enqueued`/`degraded`
  attempts whose outbox was frozen and whose event IDs that same repair run consumed in full;
  partial coverage does not change the attempt. Repair does not scan or reclassify historical
  attempts and does not accept a tuple, operation, or mirror that cannot be fully re-derived.
- As of 0.66.4, `memory recover-attempt` targets one session and is a dry run by default. The
  session must exist in the registry and its latest attempt must be `v2`, `applied`, and `enqueued`
  or `degraded`, with non-empty, unique `event_ids`. Every event must be present in the ledger and
  belong to the attempt's project/session/activation/epoch/turn; no later event from that session
  or target event still in the outbox may exist, and SHARED/candidates must byte-for-byte reproduce
  the full ledger projection. An already `projected` attempt is accepted only with a valid
  checkpoint and returns `unchanged`.
- With `--apply`, `memory recover-attempt` changes only `SESSION_REGISTRY`: it marks
  `last_memory_attempt`/`memory_status` as `projected` and stores the same checkpoint in the
  attempt and `memory_checkpoint`. Ledger, CORE, SHARED, candidates, outbox, and notes remain
  byte-identical. The command validates all authority again under `MEMORY.lock`, CAS-checks the
  attempt, activation, epoch, turn, and checkpoint, and fails closed if any byte/context changes.
  A busy lock is not reaped; retry after application returns `unchanged` without writing.
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
  use `memory promote <candidate-id> --event <event-id>` with an event that belongs to the
  candidate; date or random ID never picks an implicit winner. `reject` preserves the current
  operational value. A
  `blocked_by_core` candidate can only be rejected: promotion first requires canonical CORE
  curation. If the selected event still belongs to the matching latest `projected` attempt,
  promotion also refreshes its checkpoint and mirror causally; JSON reports
  `checkpointRefreshed`, and a newer concurrent attempt remains untouched. The decision keeps
  the already validated JSON value without string coercion and copies the selected event's
  `canonical_session_id`, activation/epoch, `source_turn_id`, and `turn_sequence`. A later Stop
  from the same session/activation therefore advances the value instead of opening another candidate.
  During replay, a transient candidate is re-evaluated and, when causal supersession is proven,
  re-anchored to the final modern source; explicit promotion uses that new anchor and includes only
  the physical predecessors needed for replay. The same
  session/activation/epoch and a higher turn applies the Stop; a lower turn is superseded. A
  different, incomplete, or ambiguous identity keeps the candidate queued for curation. `memory
  repair` compares the old and current replay and migrates checkpoint+mirror only with exact
  identity, backup, audit, and CAS; it does not reorder, rewrite, or append a ledger event.
- `validate-memory <CORE.md>` checks the hard 40-line cap, warns from 35, enforces 4 KiB and
  320 characters per line, and checks required sections and secrets/PII.
- `validate-memory --vault` also compares semantic ledger coverage with SHARED and prints a code,
  counts, and active/projected/missing keys. An empty v2 bundle is neutral; a missing projectable
  event, exclusive placeholders, or a dead decision link produces a degraded/blocking diagnosis
  without exposing values.
- `validate-memory --vault` requires a complete v2 bundle and is not the legacy-vault gate.
- For `recover-attempt`, exit `0` means a valid dry run/apply, including `unchanged`; exit `1`
  means a precondition, authority, CAS, topology, or lock check failed; exit `2` means a missing
  session/`--vault`, unknown or duplicate option, extra argument, or invalid value.

## Examples

```bash
npx wendkeep memory status --gate --vault .MyApp-vault
npx wendkeep memory curate --vault .MyApp-vault
npx wendkeep memory candidates --active --vault .MyApp-vault
npx wendkeep memory recover-attempt session-123 --vault .MyApp-vault
npx wendkeep memory recover-attempt session-123 --apply --vault .MyApp-vault
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

`memory candidates` returns `status: "ok"` and the sanitized candidate list in stable order; with
`--active`, the list contains only decisions still open for human curation.

## Common errors and diagnosis

- `legacy`: follow the migration guide; this is not corruption.
- `revision: 0` immediately after a valid migration, with no v2 attempt, is healthy; do not run
  repair merely to manufacture the first event.
- `degraded` with every event ID present in either the ledger or an intact outbox is recoverable;
  let idempotent replay finish. An event ID absent from both locations means lost publication.
- Status/doctor reports `projected acknowledgement pending` and suggests
  `memory recover-attempt <session>`: preserve the artifacts, inspect the dry-run JSON first, and
  use `--apply` only when `eligible: true`. `dry-run` confirms eligibility; `applied` updates
  registry/checkpoint; `unchanged` means the recovery was already applied idempotently.
- `recover-attempt` rejects a missing/divergent event, a target still in the outbox, stale
  SHARED/candidates, a historical attempt, mismatched session/causal context, invalid checkpoint,
  or busy lock. Do not bypass the gate by editing files: rerun `memory status --gate`, preserve
  evidence, and resolve the divergent authority.
- An `ambiguous` attempt, an `applied` attempt without event IDs, a `projected` event found only in
  the outbox, or a mismatched checkpoint is blocking: preserve the artifacts and investigate
  before repair. If the ambiguity is demonstrably superseded by a successor session, inspect the
  `memory reconcile` dry run before authorizing `--apply`; the command fails when the ambiguous
  attempt already contains event IDs.
- Ordinary pending candidate: recoverable warning, requiring human choice when appropriate.
- `promote` reports that `--event` is required: inspect the candidate `event_ids`, compare their
  provenance/value, and name the winner explicitly. An ID outside the candidate fails without
  mutating the ledger or projections.
- A promotion made by 0.66.1 followed by a transient candidate: update to 0.66.3, preserve a backup,
  and run `memory repair`. Do not publish or install 0.66.2. Repair migrates the checkpoint only
  when the old replay, attempt identity, and new event match exactly; a real conflict stays blocked
  for a human `promote`/`reject` choice.
- `promote` says that the candidate no longer matches the causal projection: no event was appended.
  Run `memory status`, inspect the current candidate again, and do not force a different lineage.
- Missing `event_cursor` or mismatched v2 hash: preserve the bundle and assess `memory repair`.
- `validate-memory --vault` fails on legacy: validate CORE only or migrate first.

## Next steps

Read [memory migration](memory-migration.md), [maintenance](maintenance-and-diagnostics.md), and
[verify](verify.md).
