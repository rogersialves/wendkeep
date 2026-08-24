# Changes, specs, sensors, and archive

**English** · [Português](../../pt-BR/commands/changes-and-verification.md)

## Purpose

Carry a change from recorded intent to an archived decision, linking requirements, tasks,
sensors, evidence, and verdict in the vault graph.

## When to use

Use for any non-trivial implementation or fix that must leave auditable proof.

## When not to use

Do not create a change merely to inspect health, import sessions, or run read-only maintenance.
For local maintenance eligible for the `FLOW` profile, use the microcontract in
[Operating profiles](operating-profiles.md); under `OFF`, the lifecycle remains available but is
not imposed by Wend Runtime.

## Prerequisites

Initialize the project, keep the vault healthy, and provide a valid `wendkeep.sensors.json`.

## Syntax

```bash
npx wendkeep change new <slug> [--simple|--guide] [--session <id>]
npx wendkeep change status [slug] [--session <id>]
npx wendkeep spec effective [--change <slug>] [--session <id>]
npx wendkeep sensors list
npx wendkeep task list [--change <slug>] [--session <id>] [--json]
npx wendkeep task evaluate <task-id> [--change <slug>] [--session <id>] [--json]
npx wendkeep verify [--deep] [--change <slug>] [--session <id>]
npx wendkeep change archive <slug> [--json] [--session <id>]
npx wendkeep change archive recover <operation-id> --change <slug> [--spec-action rollback|resume] [--json]
```

## Options and exit codes

- `wendkeep change new <slug> [--simple|--guide]` creates a change. `--simple` only skips design,
  is not `FLOW`, and preserves the legacy lifecycle/ADR contract. `--guide` creates the compact
  GUIDE contract (objective, acceptance, areas, tests, and result), with no automatic
  design/spec/ADR when `contract_impact:none`.
- `change use`, `list`, `show`, `status`, `diff`, `done`, and `undone` inspect or update work
  without archiving it.
- `change continue <archived> <new>` starts follow-up work without inheriting stale proof.
- `change bind <slug> --session <id>` attaches an existing session.
- `--session <id>` selects the causal `active_contexts` entry for implicit commands. Without it,
  only one unambiguous active context for the worktree is accepted; ambiguity returns exit `2`.
- `change relink [--apply]` and `change backlink [--apply]` repair graph links; preview is default.
- `change abandon <slug>` drops work without an ADR; `archive --force` needs explicit human choice.
- `task list/show/evaluate` derives read-only contracts from change authorship. `task claim/release`
  controls owner/lease in the causal active context.
- `change archive recover <operation-id> --change <slug> [--spec-action rollback|resume]` inspects a
  pending transaction by default; with `rollback` or `resume`, it converges only the spec
  promotion prepared in the journal, under the operation lock and validation. It never promotes the
  change, deletes the journal, or invents reconciliation.
- `wendkeep spec list|show|effective|migrate|rebase` manages living contracts and deltas.
- `wendkeep sensors list|add` manages executable proof.
- Exit `0` means completion; gates use exit `1` for red proof and exit `2` for invalid
  context/usage.

## Examples

```bash
npx wendkeep change new tenant-login
npx wendkeep change use tenant-login --session <id>
npx wendkeep change new internal-adjustment --guide
npx wendkeep spec effective --change tenant-login
npx wendkeep change done 1.1 --change tenant-login
npx wendkeep verify --change tenant-login
npx wendkeep verify --deep --change tenant-login
npx wendkeep change archive tenant-login
```

Add a sensor:

```bash
npx wendkeep sensors add api-contracts "npm run test:contracts" --severity critical
```

## Expected result

An archived change promotes its delta into the living spec when applicable and preserves proposal,
tasks/proof, and design when present. GOVERN/ASSURE mint an ADR; compact GUIDE with no contract
impact does not mint one automatically. Archive passes only with closed tasks, green required
sensors, and a fresh verdict bound to the same Evidence Envelope v2. V1 evidence is reported as
`legacy-unbound`; `change status <slug>` also diagnoses `bound`, `stale`, and `context-mismatch`.
Archive compares the package/verdict `evidenceEnvelopeId` and complete `evidenceBinding` with the
proven checkout. On a mismatch, return to the correct worktree/session and rerun `verify`,
`verify --deep`, and `wk-verify`. Fields, text/binary normalization, error codes, and recovery are
detailed in the [verify guide](verify.md).

The common gate reclassifies the envelope, package, and verdict as `verified`, `reported`,
`legacy-unbound`, `stale`, `conflict`, or `unproven`; only `verified` permits archive. A block
returns `WENDKEEP_PROVENANCE_GATE_BLOCKED`: stabilize/recover the context, run `verify`, then
`verify --deep`, and request a fresh `wk-verify` pass. `--force` may waive only an open task; for
provenance, integrity, package, and verdict it does **not** change the result or promote a spec/ADR.
Ledger errors are `WENDKEEP_RECEIPT_LEDGER_BUSY`, `WENDKEEP_RECEIPT_LEDGER_CONFLICT`,
`WENDKEEP_RECEIPT_LEDGER_CORRUPT`, and `WENDKEEP_RECEIPT_LEDGER_TRUNCATED`. On a block, use the
sanitized `--json` output (`state`, `reasonCodes`, `diagnostics`, `repair.command`), execute the
indicated recovery, and run `npx --no-install wendkeep verify --deep --json`; preserve and recapture
proof without editing the ledger/checkpoint or exposing stderr, tokens, private URLs, or Vault paths.

### Post-fix archive contract

Before mutation, perform the final recapture with `wendkeep verify --deep --change <slug>`. The
package and verdict must be complete and canonical, bound to the same checkout, change, tasks,
spec, and sensors. Archive first writes an authorization receipt to the separate
`change-archive-receipts-v2` ledger; only after it validates may it promote the spec/ADR or move
the change. `change archive --json` returns the serializable `state`, `reason_codes`,
`diagnostics`, and `repair` fields. Corruption or truncation in the proof or archive ledger fails
closed before any write. `--force` does not bypass provenance or integrity, package/verdict,
corruption, or truncation. The exact recovery is to repeat
`wendkeep verify --deep --change <slug>` in the correct checkout.

The mutation acquires the runtime lock `.brain/runtime/change-archive-operation.lock` and opens a
private ASCII transaction at `.brain/runtime/archive-transactions/<uuid>/{original,authorized}`.
It atomically renames the live change to `original`, checks the digest, and promotes only the
`authorized` copy; the public namespace is never a publication source. On a seal or divergence
failure with `WENDKEEP_ARCHIVE_INPUT_CHANGED` before promotion, the `authorized` snapshot is
removed and `original` is restored without partial promotion. A successful archive keeps the
`completed` journal; the post-release finalizer validates the digests of `original` and the
published destination but retains `original` and the transaction, with no automatic destructive
cleanup.

The archive lock is a `directory lock`: the canonical directory contains a token-specific marker
and lease. Acquisition prepares a sibling `.pending` directory, writes owner/lease, and publishes
it by atomic rename; it uses no hardlink and re-observes collisions for at most 3 topology attempts.
A live owner returns `WENDKEEP_ARCHIVE_BUSY`; a dead owner may be safely reaped without deleting a
successor. Invalid structure or marker returns `WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE`; ownership loss
returns `WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST`.

Each operation keeps an `archive-transaction.json` manifest with phases `prepared` → `isolated` →
`copied` → `sealed` → `published` → `promotion-prepared` → `promotion-applied` → `completed` or
`recovery-required`. A pending journal blocks a new archive for the same slug before the gate. On a
collision or post-publication failure, `original` is retained and the state is
`published-recovery-required`. Use the fail-closed, idempotent inspection
`wendkeep change archive recover <operation-id> --change <slug> [--spec-action rollback|resume] [--json]`;
without `--spec-action` it only returns sanitized actions. `rollback` converges before-images and
`resume` converges after-images for a `promotion-prepared` promotion; both retain the journal for
further reconciliation.

Multi-spec promotion is one atomic unit: it captures before-images/digests for every capability,
rolls back every target (including state/README) on a before- or after-write failure, and permits a
retry only after journal reconciliation and fresh verification. The post-release finalizer validates
the original/destination digests but retains the `completed` journal and `original`; no destructive
cleanup is automatic. Sanitized `operation_id` and
`transaction_phase` fields accompany the diagnostic; `repair.command` points to
`wendkeep change archive recover <operation-id> --change <slug>` when an operation is identified.
Text and --json use the same sanitized diagnostic with code, operation, state, blocker, expected,
observed, recovery, reason_codes, diagnostics, and repair.

## Task Contracts, artifacts, and handoffs

Task Contract v1 is a rebuildable projection whose authorship remains in `tarefas.md`, the
effective spec, and the change's `artifacts.json`. The contract neither copies spec text nor infers
a requirement from chat. Project, active context, HEAD, and tasks/spec/manifest hashes bind the
projection; any mismatch yields `stale`.

```markdown
- [ ] 2.3 produce report [req:REP-1] [sensor:tests] [depends:2.2] [artifact:report]
- [ ] 9.1 review the deep package and archive [req:REP-1] [phase:verify]
```

```powershell
npx wendkeep task list --session <id> [--change <slug>] [--json]
npx wendkeep task show 2.3 --session <id> [--json]
npx wendkeep task evaluate 2.3 --session <id> [--json]
npx wendkeep task claim 2.3 --session <id> [--lease-seconds 900] [--json]
npx wendkeep task release 2.3 --session <id> [--json]
```

`list`, `show`, and `evaluate` do not write. `claim` and `release` use the atomic
`SESSION_REGISTRY` lock, are scoped by repository/worktree/work session/change/task, and reject a
concurrent owner. An expired lease can be recovered; release by a non-owner fails with
`TASK_LEASE_NOT_OWNER`.

An artifact manifest uses `schema_version: 1` and an `artifacts` list; each named entry may use
type `name`, `path`, `glob`, or `file-count`. The `fromFilesystem` fallback is explicit, never reads
content, ignores `.git`, `.worktrees`, `node_modules`, and `dist`, has time/entry limits, and fails
closed on path escape or an external symlink/junction.

A checkbox is an authored signal, not proof. `task evaluate` returns `can_complete`, missing
requirements, sensors, artifacts, dependencies, and `blocking_findings`. In a causal active
context, `verify` may write `evidencia.json`, but it cannot report success or create the deep
package while any default `execute` task is blocked; diagnostics live in `task-evaluation.json`.
Use `[phase:verify]` only for the review/archive task that necessarily runs after the deep package:
it does not participate in the Execute → Verify gate, remains blocked in individual evaluation,
and must still be completed before `change archive`.

SessionStop binds source/target, task, artifacts, Evidence Envelope, decisions, next actions,
blockers, and HEAD/tasks/spec hashes. ASSURE requires a verified Handoff Contract v1; it is optional
in other profiles. Historical summaries remain `legacy-reported`. Shared memory, brain injection,
and Observer consume the same sanitized projection.

Public schemas: `schema/task-contract-v1.schema.json`,
`schema/artifact-manifest-v1.schema.json`, and `schema/handoff-contract-v1.schema.json`.

## Tool-scope fence

`change-guard` is also projected to Codex `PreToolUse`. Before a Git mutation or supported writing
tool runs, it compares the session, project, Git root, remote, branch, and worktree with the lease
recorded in `SESSION_REGISTRY.json`. Missing, ambiguous, concurrent, or cross-project targets are
blocked before the tool.

Implicit change focus comes from `active_contexts`, not `CURRENT_CHANGE.md`. Its key combines
`repository_id`, `worktree_id`, and `work_session_id`; the Markdown pointer remains only a
compatibility projection when there is one unambiguous context.

The [local Observer](observer.md) is a read-only observability projection: the vault and change
remain local authorities. Observer queries do not complete, archive, repair, or promote state in a
vault.

Codex blocks with `permissionDecision: "deny"`; `ask` is not a valid `PreToolUse` decision.
`commit`, `push`, `pull`, `merge`, `publish`, and destructive operations remain separate capabilities,
including when one command contains multiple actions. Switching projects requires a new explicit
selection/lease; never carry authorization from another conversation.

## Common errors and diagnosis

- `no change`: select one with `change use <slug>` or pass `--change`.
- `spec_impact: pending`: choose `required` with a delta or `none` with a real reason.
- Sensor not executed: keep one or more `[sensor:id]` tags on the same checkbox line. Every
  distinct ID on that line is required and runs once, in declaration order.
- Stale evidence: rerun `verify` and `verify --deep` after task/spec edits.
- Evidence from another worktree/session: return to the correct causal context; it cannot satisfy
  the current archive even when every sensor is green.
- Rebase conflict: resolve the delta or use `--accept-current` only when that is the decision.

## Next steps

Read [Operating profiles](operating-profiles.md), the deep [verify guide](verify.md), and
[maintenance and diagnostics](maintenance-and-diagnostics.md).
