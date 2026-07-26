# Legacy-to-v2 memory migration

**English** · [Português](../../pt-BR/commands/memory-migration.md)

## Purpose

Convert a legacy `SHARED_MEMORY.md` into an auditable v2 bundle without overwriting CORE or
silently promoting old reports.

## When to use

Use when `memory status` reports `legacy` and the team is ready to curate converted content.

## When not to use

Do not migrate automatically during `init`, `sync`, SessionStop, or merely to silence a warning.
Do not apply until the backup and expected state are understood.

## Prerequisites

- Valid CORE and preserved legacy bytes.
- No partially corrupt v2 bundle.
- Human review of the candidates that will be created.

## Syntax

```bash
npx wendkeep memory status --gate --vault <vault>
npx wendkeep memory migrate --vault <vault>
npx wendkeep memory migrate --apply --vault <vault>
```

## Options and exit codes

- Without `--apply`, `wendkeep memory migrate` is a zero-write dry run.
- `--apply` creates a backup, converts legacy content into candidates, and publishes valid v2.
- Exit `0` means a consistent preview/application; non-zero preserves original state and reports
  the failure.

## Examples

```bash
npx wendkeep memory migrate --vault .MyApp-vault
# review the preview
npx wendkeep memory migrate --apply --vault .MyApp-vault
npx wendkeep memory status --gate --vault .MyApp-vault
```

## Expected result

The vault receives a coherent v2 ledger/projection, a backup of legacy SHARED, and candidates for
unsupported facts. CORE is untouched and unverified content is not activated automatically.

## Common errors and diagnosis

- Dry run says already v2: do not apply again.
- Partial/corrupt v2 bundle: use status and repair; migration is not a corruption tool.
- Many candidates: curate gradually with `memory promote`/`memory reject`.
- Legacy warning remains after apply: verify the selected vault and project binding.

## Next steps

Return to [memory and curation](memory.md) and run
[maintenance and diagnostics](maintenance-and-diagnostics.md).
