# Managed worktrees

**English** · [Português](../../pt-BR/commands/worktrees.md)

## Purpose

Create isolated linked worktrees that remain bound to the same project and canonical Vault,
without copying private state into versioned files.

## When to use

Use it to start isolated implementation work, list managed checkouts, diagnose a partial create,
or open an already-ready worktree in VS Code.

## When not to use

Do not use it to remove, merge, or self-merge worktrees. Those operations remain outside this
capability.

## Prerequisites

- A Git repository whose project is already bound to its Vault through `.wendkeep.json`.
- Git on `PATH`; opening also requires the VS Code `code` command.

## Syntax

```bash
npx --no-install wendkeep worktree create <slug> [--base <ref>] [--branch <name>] [--open vscode|none] [--json]
npx --no-install wendkeep worktree list [--json]
npx --no-install wendkeep worktree status [<slug>] [--json]
npx --no-install wendkeep worktree open <slug> [--editor vscode] [--json]
```

All commands accept `--project <root>`. By default, create uses `.worktrees/<slug>`, the detected
base, and branch `wk/<slug>`. When configured, `worktrees.root` must be a
non-empty relative path. Git validates slugs and branches; paths escaping the root or crossing a
symlink/junction are rejected before mutation.

## Options and exit codes

The registry lives in the Git common-dir at `wendkeep/worktrees-v1.json`, protected by a
multi-process lock. It stores repository/worktree identity and the canonical binding;
`.wendkeep.json` stays unchanged. `.worktrees/` is added to both the versioned ignore and the
repository-private exclude. JSON `list`/`status` output exposes neither Vault paths nor contents.
For each worktree, human output shows its slug, identity, checkout path, branch, HEAD, state, and
binding health.

`create` is idempotent when slug, path, and branch already match. Collisions fail closed. Failures
after reservation remain `failed`; run `worktree status <slug>` and follow the `recovery` field.
`doctor` also reports this debt under `[worktrees]` without repairing it.

## VS Code and exit codes

`--open vscode` and `worktree open` validate `code --version`, then open a new window with
`code -n`. Use `init --vscode-worktree-tasks` or `sync --vscode-worktree-tasks` to create local
tasks; an existing or tracked `.vscode/tasks.json`, even when deleted in the checkout, is never
overwritten.

Exit `0` means success. Usage, binding, safety, Git, or editor failures return `2` with a stable
`WENDKEEP_WORKTREE_*` code. The command never removes or merges a worktree.

## Examples

```bash
npx --no-install wendkeep worktree create auth --open vscode
npx --no-install wendkeep worktree status auth --json
npx --no-install wendkeep worktree list
```

## Expected result

`create auth` produces `.worktrees/auth` on branch `wk/auth`; the main and linked worktrees resolve
the same `projectId` and Vault, while the main checkout remains clean.

## Common errors and diagnosis

- `WENDKEEP_WORKTREE_SLUG_INVALID`, `WENDKEEP_WORKTREE_BRANCH_INVALID`, or
  `WENDKEEP_WORKTREE_ROOT_INVALID`: correct the input before retrying; no reservation is created.
- `WENDKEEP_WORKTREE_PATH_OUTSIDE_ROOT` or `WENDKEEP_WORKTREE_PATH_SYMLINK_ESCAPE`: use a relative
  root contained in the main worktree, without an intermediate symlink/junction.
- `WENDKEEP_WORKTREE_COLLISION`: the slug, path, or branch represents different state; run `status`.
- `WENDKEEP_WORKTREE_GIT_FAILED` or `WENDKEEP_WORKTREE_BASE_UNRESOLVED`: repair the Git state and
  retry the command shown in `recovery`.
- `WENDKEEP_WORKTREE_REGISTRY_*`, `WENDKEEP_WORKTREE_*_MISMATCH`, or `WENDKEEP_VAULT_*` errors:
  preserve the artifacts and use `doctor` to diagnose the registry/binding.
- `WENDKEEP_WORKTREE_EDITOR_NOT_FOUND` or `WENDKEEP_WORKTREE_EDITOR_OPEN_FAILED`: make `code`
  available on PATH or use `--open none`.
- `failed`/`missing` state: read `recovery` from `status --json` and doctor's `[worktrees]` section.

## Next steps

See [installation and first use](getting-started.md) for local VS Code tasks and
[maintenance and diagnostics](maintenance-and-diagnostics.md) for doctor.
