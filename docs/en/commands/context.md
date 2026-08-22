# Active context

**English** · [Português](../../pt-BR/commands/context.md)

## Purpose

Inspect and move the same session's causal scope with proof of the current checkout, recover a
quarantined divergence, or explicitly repair operational authority that `doctor` proved orphaned,
bound to a removed worktree, or carrying an expired lease.

## When to use

Use `context switch` to create or select another branch in the same worktree. If the registry
already records `project_scope_conflict`, use `context status` to inventory `reserved` and
`observed` without local paths; recover only through `context recover` and an explicit human choice.
Use `doctor` to obtain the key/revision for `active_contexts` debt; run `context repair` only after
reviewing that diagnosis and providing an active actor session and explicit reason.

## When not to use

Do not use it to move to another worktree, hand-edit the registry, or replace `worktree create`.
Recovery never selects a candidate automatically or accepts a scope that no longer matches HEAD.
`context repair` is not a healthy-context close command, an age-based cleanup, or history deletion.

## Prerequisites

- A Git project bound to a Vault through `.wendkeep.json`.
- An active session with a complete `project_scope` matching the current worktree.
- Git on `PATH` and a branch accepted by `git check-ref-format --branch`.

## Syntax

```bash
npx --no-install wendkeep context switch <branch> [--create] [--session <id>] [--project <root>] [--vault <vault>] [--json]
npx --no-install wendkeep context status --session <id> [--project <root>] [--vault <vault>] [--json]
npx --no-install wendkeep context recover --session <id> --select <reserved|observed> --revision <n> --reason <text> [--project <root>] [--vault <vault>] [--json]
npx --no-install wendkeep context repair --key <repository:worktree:work-session> --revision <n> --reason <text> --session <id> [--project <root>] [--vault <vault>] [--json]
```

Without `--session`, exactly one active session must fully match the current scope. `--create`
uses `git switch -c`; without it, the command follows `git switch` semantics.

## Options and exit codes

- `--create`: create the branch from the current HEAD.
- `--session <id>`: select the causal session or, for repair, the active auditable actor session.
- `--key <repository:worktree:work-session>`: select exactly the diagnosed active context.
- `--select <reserved|observed>`: select exactly one quarantined candidate; required for recovery.
- `--revision <n>`: CAS against the revision returned by `context status` or `doctor`; required for
  recovery and repair.
- `--reason <text>`: auditable reason, sanitized and limited to 240 characters.
- `--project <root>` and `--vault <vault>`: select the binding and paths for manual use.
- `--json`: emit status, session id, branch, HEAD, revision, and event without exposing the Vault.

Exit `0` means the transition completed or the target was already active. Invalid usage,
ambiguity, scope mismatch, conflict, Git failure, or rollback returns `2` with a
`WENDKEEP_CONTEXT_*` code.

## Examples

```bash
npx --no-install wendkeep context switch wk/auth --create
npx --no-install wendkeep context switch main --session 019abc-session-id
npx --no-install wendkeep context switch wk/auth --session 019abc-session-id --json
npx --no-install wendkeep context status --session 019abc-session-id --json
npx --no-install wendkeep context recover --session 019abc-session-id --select observed --revision 7 --reason "checkout confirmed"
npx --no-install wendkeep context repair --key "repo:tree:work" --revision 4 --reason "worktree removed after merge" --session 019abc-session-id
```

Do not replace it with the raw command below while the harness is active:

```bash
git switch -c wk/auth
```

The guard returns `WENDKEEP_CONTEXT_SWITCH_REQUIRED` before Git runs, preventing the next mutation
from failing with a scope mismatch.

## Expected result

The command validates the initial scope under lock, switches branch, proves project, repository,
remote, worktree, provider, and session id stayed unchanged, increments `context_revision`, and
appends a `from/to` event to `context_transitions`. The active change, task lease, and existing
authorizations are preserved.

If validation or persistence fails after the switch, rollback restores the previous branch or
detached HEAD; a branch created by the failed attempt is removed as well.

During recovery, both candidates must be complete and retain the same causal identity. The selected
candidate must fully match the current project, repository, remote, worktree, branch, and HEAD.
Under the registry lock, the command revalidates the revision, increments `context_revision`,
preserves the change/lease/authorizations, clears only the quarantine, and appends a sanitized
receipt to `context_recoveries`. Any failure leaves the registry and quarantine byte-identical.
This is fail-closed: no candidate, receipt, or partial scope is published after a failed check.

For repair, the command rereads the target under lock, validates revision and actor session, proves
the Git topology again, and reapplies the diagnosis. A context without an active session or with a
removed worktree becomes `state=closed`, while its record and historical bindings remain; an
isolated expired lease becomes `expired` and the context stays active. The append-only
`active_context_repairs` receipt records actor, reason, diagnostics, and effect. Only after the
authoritative write are `CURRENT_CHANGE.md` and `CURRENT_DELIVERY` reprojected; the ledger,
evidence index, notes, and historical memory remain unchanged.

### Multi-context change registry

`SESSION_REGISTRY.json` keeps `active_contexts` with its own schema and revision. Each entry is
identified by `repository_id` + `worktree_id` + `work_session_id`; branch, HEAD, and `change_slug`
belong to that entry. Two worktrees can therefore select different changes without overwriting
each other's operational focus.

With an explicit causal session, change, spec, and verify resolve only the matching entry. Without
a session, only one active entry for the worktree is accepted; two sessions produce ambiguity and
the operation must fail closed without silently selecting a change.

`CURRENT_CHANGE.md` is only a derived projection: it contains a change when there is one single,
unambiguous active context. With zero or multiple contexts it stays empty. Migration is conservative
and never invents a worktree or session identity. The legacy pointer becomes a context only
when one active session, a complete scope, and worktree metadata prove one identity.

The `brain-inject` (`SessionStart`) and `change-context` (`UserPromptSubmit`) hooks resolve the same
causal identity before marking a change as `CURRENT` or computing the sentinel hash. The backlog
remains global and lists every other change as `OPEN`, but a divergent `CURRENT_CHANGE.md` never
turns a sibling change into the session focus. The presence of `active_contexts`, its schema, or its
revision — including `active_contexts: {}` — disables legacy fallback: a missing or ambiguous
context fails closed without reviving the pointer. Fallback exists only before contextual-store
initialization.

## Common errors and diagnosis

- `WENDKEEP_CONTEXT_AMBIGUOUS`: pass `--session <id>`; no candidate is selected silently.
- `WENDKEEP_CONTEXT_SCOPE_MISMATCH`: the selected candidate does not prove the current checkout/HEAD;
  run `context status` again and select only a candidate with `matches_actual: true`.
- `WENDKEEP_CONTEXT_SCOPE_CONFLICT`: the session is not quarantined or a candidate is missing.
- `WENDKEEP_CONTEXT_CAS_MISMATCH`: the revision changed; discard the stale decision and rerun status.
- `WENDKEEP_CONTEXT_IDENTITY_CHANGED`: candidates belong to different causal identities; preserve
  quarantine and diagnose the registry.
- `WENDKEEP_CONTEXT_CONFLICT`: another active context occupies the target; use another
  branch/worktree or close the competing context correctly.
- `WENDKEEP_CONTEXT_GIT`: fix the branch, conflicting dirty state, or Git error and retry.
- `WENDKEEP_CONTEXT_ROLLBACK_FAILED`: preserve Git and registry state and diagnose manually before
  any new mutation.
- `WENDKEEP_CONTEXT_SWITCH_REQUIRED`: replace the raw Git command with `wendkeep context switch`.
- `WENDKEEP_ACTIVE_CONTEXT_CAS_MISMATCH`: the target revision changed; rerun `doctor`.
- `WENDKEEP_ACTIVE_CONTEXT_HEALTHY`: the condition disappeared or was never repairable; do not force it.
- `WENDKEEP_ACTIVE_CONTEXT_TOPOLOGY_UNPROVEN`: Git/registry could not prove worktrees; repair the
  topology before any context repair.
- `WENDKEEP_ACTIVE_CONTEXT_ACTOR_MISMATCH`: the actor session does not belong to the target's proven project.
- `WENDKEEP_ACTIVE_CONTEXT_SESSION_ORPHAN`, `WENDKEEP_ACTIVE_CONTEXT_WORKTREE_REMOVED`, and
  `WENDKEEP_ACTIVE_CONTEXT_LEASE_EXPIRED`: read-only diagnostics emitted by `doctor`.

## Next steps

See [managed worktrees](worktrees.md) to create isolated checkouts and
[changes and verification](changes-and-verification.md) to continue the lifecycle on the new branch.
