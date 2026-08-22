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
npx wendkeep verify [--deep] [--change <slug>] [--session <id>]
npx wendkeep change archive <slug> [--session <id>]
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
