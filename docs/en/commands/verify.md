# Verify and independent verification

**English** · [Português](../../pt-BR/commands/verify.md)

## Purpose

Run the sensors required by a change's tasks, persist fresh evidence, and assemble the
self-contained package consumed by the independent `wk-verify` pass.

## When to use

Run after implementing tasks and again whenever tasks, specs, or tests change.

## When not to use

Do not use it as a post-install health check or when no change exists. Run `wendkeep doctor` and
`wendkeep memory status --gate` instead. In `FLOW`, validation and the receipt belong to
`flow finish`; under `OFF`, `verify` remains available only when the user chooses to run the
lifecycle manually.

## Prerequisites

- An open change selected through `CURRENT_CHANGE.md` or `--change <slug>`.
- A placeholder-free `tarefas.md` with `[req:]` and one or more `[sensor:]` tags on checkbox lines;
  every distinct sensor ID is required once, in declaration order.
- Sensors declared in `wendkeep.sensors.json`.

## Syntax

```bash
npx wendkeep verify [--change <slug>] [--project <root>] [--vault <vault>]
npx wendkeep verify --deep [--change <slug>]
npx wendkeep change use <slug>
```

## Options and exit codes

- `--change <slug>` targets a change without changing the active pointer.
- `change use <slug>` persists focus for following commands.
- `--project <root>` selects the sensor cwd; `--vault` selects where proof is stored and is passed
  to sensors as `OBSIDIAN_VAULT_PATH`, including `memory-health`.
- **Exit 0:** all required sensors passed and evidence was written.
- **Exit 1:** the gate ran, but at least one critical sensor was red or a mutant survived.
- **Exit 2:** invalid usage/context, including `no change (--change or active)`, missing vault,
  unknown change, a project outside a Git repository, invalid `wendkeep.sensors.json`, or
  `WENDKEEP_EVIDENCE_HEAD_CHANGED`.

`verify --deep` writes `verificacao.json`; it does not replace the reviewer. The `wk-verify` skill
must be run by a different author and writes `verdict.json`.

## Examples

Active change:

```bash
npx wendkeep verify
npx wendkeep verify --deep
```

Explicit change:

```bash
npx wendkeep verify --change tenant-login
npx wendkeep verify --deep --change tenant-login
```

Project with no open change:

```bash
npx wendkeep doctor --vault .MyApp-vault
npx wendkeep memory status --gate --vault .MyApp-vault
```

## Expected result

`evidencia.json` follows the [public v2 schema](../../../schema/wendkeep.evidence-envelope-v2.schema.json).
The envelope binds `project_id`, `repository_id`, `worktree_id`, `work_session_id`, change, and
branch to `base_sha`, `head_sha`, `index_tree_sha`, `worktree_digest`, tasks, effective spec, and
sensor configuration with complete SHA-256 digests. The worktree digest covers staged, unstaged,
untracked, rename, and delete state; paths use `/`, text normalizes CRLF/CR to LF, and binaries keep
their bytes. Binary classification honors Git `binary`/`-text` attributes and known binary
extensions (including `.bin`); ignored files are excluded.

Each sensor records its sanitized command and hash, start/end, duration, exit code, output digest,
and a sanitized tail bounded to 2,000 characters. Authority artifacts publish through a path-safe
temporary in the same directory and an atomic rename. In deep mode, `verificacao.json` and
`verdict.json` carry the same `evidenceEnvelopeId` and complete `evidenceBinding`; the independent
reviewer must preserve both.

V1 evidence remains readable as `legacy-unbound`, never as equivalent authority. Run
`wendkeep change status <slug>` to inspect `bound`, `stale`, or `context-mismatch`.

The provenance gate normalizes that legacy view into one taxonomy: `verified` when every required
proof is fresh and bound; `reported` for a recorded claim without an authoritative observation;
`legacy-unbound` for v1; `stale` for an earlier snapshot; `conflict` for incompatible identity or
content; and `unproven` for missing or insufficient proof. Precedence is `conflict` > `stale` >
`legacy-unbound` > `unproven` > `reported` > `verified`, and only `verified` closes the gate.

For post-fix archive, the final pass is `wendkeep verify --deep --change <slug>`. It must leave a
complete and canonical package and verdict bound to the same checkout, change, tasks, spec, and
sensors. Archive writes the authorization receipt before mutation to the separate
`change-archive-receipts-v2` ledger. Its `change archive --json` output is serializable and
exposes `state`, `reason_codes`, `diagnostics`, and `repair`; ledger corruption or truncation
fails closed. `--force` does not bypass provenance or integrity. The exact recovery is to repeat
`wendkeep verify --deep --change <slug>` after stabilizing the context.

Archive uses a `directory lock` with a token-specific marker and lease. Acquisition prepares a
sibling `.pending` directory and publishes it by atomic rename, uses no hardlink, and allows at most
3 topology attempts. A live owner produces `WENDKEEP_ARCHIVE_BUSY`; a dead owner is reaped only
after safe observation; invalid marker/structure produces `WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE`;
ownership loss produces `WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST`. The `archive-transaction.json`
manifest records `prepared` → `isolated` → `copied` → `sealed` → `published` → `promotion-prepared` →
`promotion-applied` → `completed` or `recovery-required`. A pending journal blocks a new archive for
the same slug before the gate. On a
collision or post-publication failure, `original` is retained and the
`published-recovery-required` state blocks destructive retry. `operation_id` and `transaction_phase`
are sanitized fields. Inspect it with
`wendkeep change archive recover <operation-id> --change <slug> [--spec-action rollback|resume] [--json]`:
without `--spec-action`, this is a read-only, fail-closed, idempotent operation with no promotion,
deletion, or invented reconciliation. `rollback` restores before-images and `resume` converges
after-images for a `promotion-prepared` promotion while retaining the journal for reconciliation.
When an operation ID exists, `repair.command` points to `wendkeep change archive recover <operation-id>
--change <slug>`; do not treat `command:null` as the normal flow.

Multi-spec promotion is one atomic unit: it captures before-images/digests for every capability,
rolls back every target (including state/README) on a before- or after-write failure, and permits a
retry only after journal reconciliation and fresh verification. The post-release finalizer validates
original/destination digests, but the `completed` journal keeps the `original` retained; no
destructive cleanup is automatic. A failure retains `published-recovery-required`.

## Common errors and diagnosis

- `no change`: this is exit 2 and a valid idle state; create/use a change or skip verify.
- Zero/missing sensors: inspect every same-line tag and `sensors list`; multiple tags on one task
  are valid and all of them enter the gate.
- Red gate: inspect the bounded `note` field on the `evidencia.json` entry, fix the cause, and
  rerun; never choose `archive --force` on your own.
- Missing/stale verdict: regenerate `--deep` and request a fresh independent pass.
- `WENDKEEP_EVIDENCE_HEAD_CHANGED`: HEAD moved while sensors ran; stabilize the checkout and rerun.
  The previous evidence was not replaced.
- `legacy-unbound`, `stale`, or `context-mismatch`: return to the correct worktree/session, recover
  the context when needed, and rerun `verify` plus `verify --deep`.
- `WENDKEEP_PROVENANCE_GATE_BLOCKED`: inspect `state`, `reasonCodes`, and `repair`; do not reuse
  proof from another branch/worktree/session. Run the proposed command and recapture the envelope.
- `WENDKEEP_RECEIPT_LEDGER_BUSY`, `WENDKEEP_RECEIPT_LEDGER_CONFLICT`,
  `WENDKEEP_RECEIPT_LEDGER_CORRUPT`, and `WENDKEEP_RECEIPT_LEDGER_TRUNCATED` require preserving
  the ledger/checkpoint and executing the objective recovery in `repair.command` (or
  `npx --no-install wendkeep verify --deep --json` for fresh proof); text/JSON output remains
  sanitized and contains no raw stderr, tokens, private URLs, or Vault paths.
- Surviving mutants: strengthen the discriminating test; after three rounds, review manually.

## Next steps

Return to the [change lifecycle](changes-and-verification.md) for archive, review
[Operating profiles](operating-profiles.md), or use [maintenance](maintenance-and-diagnostics.md)
when no change exists.
# Task Contract gate

After running sensors and writing the current Evidence Envelope, `verify` evaluates Task Contracts
for the causal active context. An open checkbox, missing requirement/sensor/artifact, open
dependency, or stale binding returns exit `1`, preserves `evidencia.json`, writes
`task-evaluation.json`, and does not create the deep package. Tasks explicitly authored with
`[phase:verify]` are excluded only from this transition because they depend on the deep package;
they remain open for the archive gate. See
[Changes and verification](changes-and-verification.md).
