# Active context

**English** · [Português](../../pt-BR/commands/context.md)

## Purpose

Switch the Git branch and the same session's causal scope together inside the current worktree,
without opening a new session or weakening the guard.

## When to use

Use `context switch` when an active session must create or select another branch in the same
worktree and continue mutating the repository after the transition.

## When not to use

Do not use it to move to another worktree, adopt an already-divergent scope, repair the registry,
or replace `worktree create`. Those cases require a separate physical context or explicit diagnosis.

## Prerequisites

- A Git project bound to a Vault through `.wendkeep.json`.
- An active session with a complete `project_scope` matching the current worktree.
- Git on `PATH` and a branch accepted by `git check-ref-format --branch`.

## Syntax

```bash
npx --no-install wendkeep context switch <branch> [--create] [--session <id>] [--project <root>] [--vault <vault>] [--json]
```

Without `--session`, exactly one active session must fully match the current scope. `--create`
uses `git switch -c`; without it, the command follows `git switch` semantics.

## Options and exit codes

- `--create`: create the branch from the current HEAD.
- `--session <id>`: select the causal session explicitly; recommended whenever selection is unclear.
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

## Common errors and diagnosis

- `WENDKEEP_CONTEXT_AMBIGUOUS`: pass `--session <id>`; no candidate is selected silently.
- `WENDKEEP_CONTEXT_SCOPE_MISMATCH` or `WENDKEEP_CONTEXT_SCOPE_CONFLICT`: return to the reserved
  checkout or diagnose the session; the command never adopts a post-hoc divergence.
- `WENDKEEP_CONTEXT_CONFLICT`: another active context occupies the target; use another
  branch/worktree or close the competing context correctly.
- `WENDKEEP_CONTEXT_GIT`: fix the branch, conflicting dirty state, or Git error and retry.
- `WENDKEEP_CONTEXT_ROLLBACK_FAILED`: preserve Git and registry state and diagnose manually before
  any new mutation.
- `WENDKEEP_CONTEXT_SWITCH_REQUIRED`: replace the raw Git command with `wendkeep context switch`.

## Next steps

See [managed worktrees](worktrees.md) to create isolated checkouts and
[changes and verification](changes-and-verification.md) to continue the lifecycle on the new branch.
