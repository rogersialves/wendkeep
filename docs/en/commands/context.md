# Active context

**English** · [Português](../../pt-BR/commands/context.md)

## Purpose

Inspect and move the same session's causal scope with proof of the current checkout: during a
normal branch transition or when explicitly recovering a divergence already under quarantine.

## When to use

Use `context switch` to create or select another branch in the same worktree. If the registry
already records `project_scope_conflict`, use `context status` to inventory `reserved` and
`observed` without local paths; recover only through `context recover` and an explicit human choice.

## When not to use

Do not use it to move to another worktree, hand-edit the registry, or replace `worktree create`.
Recovery never selects a candidate automatically or accepts a scope that no longer matches HEAD.

## Prerequisites

- A Git project bound to a Vault through `.wendkeep.json`.
- An active session with a complete `project_scope` matching the current worktree.
- Git on `PATH` and a branch accepted by `git check-ref-format --branch`.

## Syntax

```bash
npx --no-install wendkeep context switch <branch> [--create] [--session <id>] [--project <root>] [--vault <vault>] [--json]
npx --no-install wendkeep context status --session <id> [--project <root>] [--vault <vault>] [--json]
npx --no-install wendkeep context recover --session <id> --select <reserved|observed> --revision <n> --reason <text> [--project <root>] [--vault <vault>] [--json]
```

Without `--session`, exactly one active session must fully match the current scope. `--create`
uses `git switch -c`; without it, the command follows `git switch` semantics.

## Options and exit codes

- `--create`: create the branch from the current HEAD.
- `--session <id>`: select the causal session explicitly; recommended whenever selection is unclear.
- `--select <reserved|observed>`: select exactly one quarantined candidate; required for recovery.
- `--revision <n>`: CAS against the revision returned by `context status`; required for recovery.
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

## Next steps

See [managed worktrees](worktrees.md) to create isolated checkouts and
[changes and verification](changes-and-verification.md) to continue the lifecycle on the new branch.
