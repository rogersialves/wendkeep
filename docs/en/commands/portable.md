# Portable state

**English** · [Português](../../pt-BR/commands/portable.md)

## Purpose

Publish the reviewable Vault subset and a compact `active-work` snapshot to
`.wendkeep/portable/state.json` without turning private runtime into Git data. The command never
runs `git add`, commit, or push.

## When to use

Use `portable export` before a PR that shares specs/decisions or before moving machines;
`portable status`/`diff` to review drift; and `portable import` after creating and binding the Vault
of a clean clone.

## When not to use

Do not use it as real-time remote sync, transcript backup, secret transport, or a replacement for
`context switch`. Import restores a resume hint but never invents a session ID, active context, or
lease.

## Prerequisites

- A Git project bound to its Vault through `.wendkeep.json`.
- Valid `PROJECT.json`; a worktree registry when generating new identity.
- Human review of the JSON before adding it to Git.

## Syntax

```bash
npx --no-install wendkeep portable status [--project <root>] [--vault <vault>] [--input <file>] [--json]
npx --no-install wendkeep portable export [--project <root>] [--vault <vault>] [--output <file>] [--json]
npx --no-install wendkeep portable import [--project <root>] [--vault <vault>] [--input <file>] [--json]
npx --no-install wendkeep portable diff [--project <root>] [--vault <vault>] [--input <file>] [--json]
```

## Options and exit codes

- `--input`/`--output`: override the default `.wendkeep/portable/state.json` path.
- `--project`/`--vault`: select the binding; `--json` emits structured results.
- Exit `0`: valid status/export/import or equal diff. Exit `1`: different diff. Exit `2`: invalid
  schema, project, integrity, path, or argument.
- `status` returns `not_configured`, `current`, `diverged`, or `invalid`.

## Examples

```bash
npx --no-install wendkeep portable export
npx --no-install wendkeep portable diff
git diff -- .wendkeep/portable/state.json
git add -- .wendkeep/portable/state.json
```

`.gitattributes` fixes LF for `/.wendkeep/portable/*.json`. Projects may ignore this directory and
retain the complete local Keep Core.

## Expected result

The inventory classifies `.brain/CORE.md`, ADRs, proposal/design/tasks, and `specs/` deltas as
`authored`; `07-Specs`, evidence/verification/verdict, and archives as `derived`; registries, leases,
locks, outboxes, and full receipts as `runtime`; transcripts, prompts/responses, tokens/costs,
secrets, and environment as `secret`. Only authored data and `07-Specs` enter the bundle. Export
normalizes LF, excludes symlinks/hardlinks, and removes Windows/POSIX absolute paths, known token
shapes, and values of `Authorization`, `token`, `password`, `secret`, and `api_key`.

Each `active-work` contains `project_id`, `repository_id`, `change_slug`, `task_id`, branch/SHAs,
hashes, completed/next work, blockers, references, timestamp, and revision. It never contains
`work_session_id`, `worktree_id`, local paths, or tokens. Import stores the private hint in
`.brain/runtime/PORTABLE_ACTIVE_WORK.json`; export/import append metadata and hashes only to
`.brain/runtime/PORTABLE_PROVENANCE.jsonl`.

## Common errors and diagnosis

- `WENDKEEP_PORTABLE_STALE`: incoming revision is older than local state.
- `WENDKEEP_PORTABLE_CONFLICT`: the same revision carries a different hash.
- `WENDKEEP_PORTABLE_PATH_UNSAFE`: traversal, non-allowlisted path, or symlink.
- `WENDKEEP_PORTABLE_INTEGRITY`: content/hash was tampered with.

All fail before the first write. `doctor` reports `[portable] diverged` and recommends diff/export;
`not_configured` is a valid opt-out. Schemas: `schema/portable-state-v1.schema.json` and
`schema/portable-active-work-v1.schema.json`.

## Next steps

Review the small human-readable diff, add only the confirmed snapshot, and open the PR. In the
destination clone, run `init`, `portable import`, inspect `portable status`, and start a new causal
session.
