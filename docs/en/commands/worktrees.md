# Managed worktrees

**English** · [Português](../../pt-BR/commands/worktrees.md)

## Purpose

Create and finish isolated linked worktrees that remain bound to the same project and canonical
Vault, without copying private state into versioned files or discarding local work.

## When to use

Use it to start isolated implementation work, list managed checkouts, diagnose a partial operation,
open a worktree in VS Code, or clean it up after a provably merged PR.

## When not to use

Do not use it to merge the PR, discard a dirty/untracked checkout, or delete a remote branch without
explicit authorization. `finish` consumes an existing merge; it does not self-merge.

## Prerequisites

- A Git repository whose project is already bound to its Vault through `.wendkeep.json`.
- Git on `PATH`; `finish` also requires authenticated `gh` access to query GitHub.
- Opening also requires the VS Code `code` command.

## Syntax

```bash
npx --no-install wendkeep worktree create <slug> [--base <ref>] [--branch <name>] [--open vscode|none] [--json]
npx --no-install wendkeep worktree list [--json]
npx --no-install wendkeep worktree status [<slug>] [--json]
npx --no-install wendkeep worktree open <slug> [--editor vscode] [--json]
npx --no-install wendkeep worktree finish <slug> [--pr <number|url>] [--delete-remote] [--open-main] [--json]
npx --no-install wendkeep worktree cleanup --merged [--dry-run|--apply] [--json]
npx --no-install wendkeep worktree remove <slug> --reason <text> [--json]
npx --no-install wendkeep worktree prune [--dry-run|--apply] [--json]
```

All commands accept `--project <root>`. By default, create uses `.worktrees/<slug>`, the detected
base, and branch `wk/<slug>`. When configured, `worktrees.root` must be a non-empty relative path.
Git validates slugs and branches; paths escaping the root or crossing a symlink/junction are rejected
before mutation.

## Safe finish

When `origin` exists, `finish` runs `git fetch --prune`, queries the PR through the GitHub adapter,
and requires `MERGED`, a matching branch, and a merge commit reachable from the local base. The
number/URL is associated with the registry. Before removal, preflight fails closed on dirty or
untracked files, an active session, active delivery, memory outbox, or pending handoff.

After reserving under lock, the command removes the linked worktree, closes only its active
contexts, prunes, deletes the local ref with CAS, and appends a JSONL receipt in the Git common-dir.
This accepts merge commits, squash, and rebase without `git branch -D`. Re-running the same proof is
idempotent; when the directory vanished between steps, the interrupted reservation resumes.
`doctor` reports interrupted/failed cleanup with an objective recovery command.

`--delete-remote` is the only authorization to delete the remote branch. The branch must remain at
the proven head; divergence or an unavailable network blocks the operation. An already-absent branch
is idempotent success. `--open-main` opens the main worktree only after completion.

### Post-fix cleanup: crash-safe resume

Cleanup is **crash-safe** and resumable before the receipt, after the receipt and before
finalize, and after finalize: a crash at any boundary preserves operation/state and lets the same
proof be retried without duplicating removal or a receipt. Every operation subject includes all
active contexts, actor, pr, head, and merge. The canonical PR authority is the PR resolved by the
GitHub adapter; caller-provided text cannot replace that authority.

HEAD is re-derived before finalize from the checkout and compared with the proven head/merge. The
reason is sanitized and receives a digest for audit, without storing private paths, tokens, or
stderr. An absent or invalid checkpoint is WENDKEEP_RECEIPT_LEDGER_TRUNCATED. V1 remains
legacy-unbound and never authorizes cleanup.

Text and --json always expose operation, state, blocker, recovery, and the stable codes
WENDKEEP_WORKTREE_CLEANUP_BUSY, WENDKEEP_RECEIPT_LEDGER_CORRUPT, and
WENDKEEP_RECEIPT_LEDGER_TRUNCATED; recovery resumes the reservation or names the objective repair.

The common cleanup gate classifies the operation and blocks before mutation, including finish,
remove, and cleanup --apply. After append, the receipt is classified by the same gate before
finalize; a provenance failure neither finalizes nor reports success. A cleaned state without a v2
receipt is blocked as unproven; a v1 receipt never authorizes and remains legacy-unbound.

Text and --json blockers keep the same sanitized diagnostic: code, operation, state, blocker,
expected, observed, recovery, reason_codes, diagnostics, and repair.

## Cleanup, remove, and prune

`cleanup --merged` and `prune` are dry-run by default. `--dry-run` makes that intent explicit; only
`--apply` permits mutation. Plans are slug-sorted and do not change Git, registry, contexts, or
receipts. `cleanup --merged` acts only on entries with an associated PR whose merge is revalidated.
`remove --reason` is the auditable escape hatch for explicit abandonment: it waives merge proof but
keeps every preflight and preserves both local and remote branches.

## Options and exit codes

The registry lives in the Git common-dir at `wendkeep/worktrees-v1.json`, protected by a
multi-process lock. It stores repository/worktree identity, canonical binding, PR, and transient
cleanup state; `.wendkeep.json` stays unchanged. New receipts live at
`wendkeep/worktree-cleanup-receipts-v2.jsonl`: every line carries `previous_hash` and
`receipt_hash`, while a separate checkpoint fixes the last validated sequence/hash/byte length.
V1 remains readable as `legacy-unbound`, with no silent append or rewrite.
`WENDKEEP_RECEIPT_LEDGER_CORRUPT` reports tampering/partial JSON and
`WENDKEEP_RECEIPT_LEDGER_TRUNCATED` reports a removed tail. Both block before removal and require
diagnosing the store, never inventing a receipt. `.worktrees/` is added to the versioned ignore and
repository-private exclude; JSON `list`/`status` exposes neither Vault paths nor contents.
Cleanup uses the `verified`, `reported`, `legacy-unbound`, `stale`, `conflict`, and `unproven` states;
`WENDKEEP_PROVENANCE_GATE_BLOCKED` and `WENDKEEP_RECEIPT_LEDGER_BUSY`,
`WENDKEEP_RECEIPT_LEDGER_CONFLICT`, `WENDKEEP_RECEIPT_LEDGER_CORRUPT`, and
`WENDKEEP_RECEIPT_LEDGER_TRUNCATED` fail closed. Objective recovery reads sanitized
`worktree status <slug> --json`, executes `repair.command` when present, and recaptures proof; never
edit the ledger/checkpoint or expose stderr, tokens, private URLs, or Vault paths.

`create` is idempotent when slug, path, and branch already match. Collisions fail closed. Failures
after reservation remain `failed`; run `worktree status <slug>` and follow `recovery`. `doctor`
also reports create or cleanup debt under `[worktrees]` without repairing it.

## VS Code

`--open vscode` and `worktree open` validate `code --version`, then open a new window with `code -n`.
Use `init --vscode-worktree-tasks` or `sync --vscode-worktree-tasks` to create local tasks, including
**WendKeep: Finish merged worktree**; an existing or tracked `.vscode/tasks.json`, even when deleted
in the checkout, is never overwritten.

Exit `0` means success. Usage, binding, safety, proof, Git, or editor failures return `2` with a
stable `WENDKEEP_WORKTREE_*` code. No command merges or uses force to discard a checkout.

## Examples

PowerShell:

```powershell
npx --no-install wendkeep worktree create auth --open vscode
npx --no-install wendkeep worktree finish auth --pr 72 --open-main
npx --no-install wendkeep worktree cleanup --merged --dry-run --json
```

POSIX:

```bash
npx --no-install wendkeep worktree cleanup --merged --apply
npx --no-install wendkeep worktree remove spike --reason "PR cancelled"
npx --no-install wendkeep worktree prune --dry-run
```

## Expected result

`create auth` produces `.worktrees/auth` on branch `wk/auth`. After a proven merge, `finish` removes
the checkout and local ref, closes only its active context, and preserves the Vault, sessions,
evidence, and receipt.

## Common errors and diagnosis

- `WENDKEEP_WORKTREE_SLUG_INVALID`, `WENDKEEP_WORKTREE_BRANCH_INVALID`, or
  `WENDKEEP_WORKTREE_ROOT_INVALID`: correct the input before retrying; no reservation is created.
- `WENDKEEP_WORKTREE_PATH_OUTSIDE_ROOT` or `WENDKEEP_WORKTREE_PATH_SYMLINK_ESCAPE`: use a relative
  root contained in the main worktree, without an intermediate symlink/junction.
- `WENDKEEP_WORKTREE_COLLISION`: the slug, path, or branch represents different state; run `status`.
- `WENDKEEP_WORKTREE_PR_INVALID`, `WENDKEEP_WORKTREE_PR_NOT_MERGED`,
  `WENDKEEP_WORKTREE_PR_MISMATCH`, or `WENDKEEP_WORKTREE_PR_MERGE_UNREACHABLE`: correct/associate
  the PR, update the local base, and retry without manually removing the worktree.
- `WENDKEEP_WORKTREE_DIRTY`, `WENDKEEP_WORKTREE_ACTIVE_SESSION`,
  `WENDKEEP_WORKTREE_ACTIVE_DELIVERY`, `WENDKEEP_WORKTREE_OUTBOX_PENDING`, or
  `WENDKEEP_WORKTREE_HANDOFF_PENDING`: complete the recovery named by the blocker.
- `WENDKEEP_WORKTREE_CLEANUP_BUSY`: another operation owns the reservation; if the directory is
  already gone, retry the same command/proof to resume. Use `doctor` for failed/incomplete state.
- `WENDKEEP_WORKTREE_REMOTE_UNAVAILABLE` or `WENDKEEP_WORKTREE_REMOTE_DIVERGED`: the local branch is
  preserved; recover the network or review the divergence before authorizing again.
- `WENDKEEP_WORKTREE_REGISTRY_*`, `WENDKEEP_WORKTREE_*_MISMATCH`, or `WENDKEEP_VAULT_*` errors:
  preserve the artifacts and use `doctor` to diagnose the registry/binding.
- `WENDKEEP_WORKTREE_EDITOR_NOT_FOUND` or `WENDKEEP_WORKTREE_EDITOR_OPEN_FAILED`: make `code`
  available on PATH or use `--open none`.

## Next steps

See [installation and first use](getting-started.md) for local VS Code tasks and
[maintenance and diagnostics](maintenance-and-diagnostics.md) for doctor.
