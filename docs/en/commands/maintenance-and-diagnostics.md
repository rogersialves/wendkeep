# Maintenance and diagnostics

**English** · [Português](../../pt-BR/commands/maintenance-and-diagnostics.md)

## Purpose

Inspect vault health and keep definitions, theme, and package version aligned without treating
change commands as global checks.

## When to use

Use after install/update, when hooks emit warnings, or before starting a change.

## When not to use

Do not run `wendkeep verify` when no change is active. It proves a change's tasks; it is not a
replacement for doctor.

## Prerequisites

Run from the project root or provide `--project` and `--vault` explicitly.

## Syntax

```bash
npx wendkeep doctor [--vault <vault>]
npx wendkeep sync-defs [--check|--reseed] --vault <vault> --project <root>
npx wendkeep theme sync --vault <vault>
npx wendkeep --version
npx wendkeep --help
```

## Options and exit codes

- `doctor` is read-only; exit `0` accepts recoverable warnings, while non-zero means failure.
- In v2, `doctor`/`memory status --gate` correlate `last_memory_attempt` (mode, disposition, event
  IDs, and checkpoint) with outbox, ledger, and SHARED; they do not infer health from revision alone.
- `revision: 0` after a valid migration, with no v2 attempt, is healthy. A `degraded` attempt whose
  events remain durable in the outbox/ledger is a recoverable warning.
- An ambiguous attempt, a lost event ID (absent from ledger and outbox), `projected` state found
  only in the outbox, or a mismatched checkpoint is blocking.
- For session observability, `legacy`, `degraded`, `stale`, and `manifest-unproven` require
  reconciliation or more evidence. Only fresh `none` and fresh `complete` are healthy: frontier,
  checkpoint, root stat, and source manifest must agree.
- `doctor` remains read-only. It recommends the targeted dry-run first and only advises repeating
  the command with `--apply` after human review.
- `sync-defs --check` detects drift without writes; `--reseed` restores packaged `wk-*` skills.
- `theme sync` reapplies the CSS snippet and graph groups without recreating the vault.
- `wendkeep --version` prints the running version; `wendkeep --help` lists the public interface.

## Examples

Post-update checklist:

```bash
npx wendkeep --version
npx wendkeep sync-defs --check --vault .MyApp-vault --project .
npx wendkeep doctor --vault .MyApp-vault
npx wendkeep memory status --gate --vault .MyApp-vault
npx wendkeep cost rebuild --session <id> --json
npx wendkeep cost rebuild --session <id> --apply
```

## Expected result

Doctor names sessions, registry, links, notes, prices, derived sections, and memory as healthy or
provides a specific diagnostic/repair command. For memory, it distinguishes a valid initial empty
state, recoverable pending replay, and lost/divergent lifecycle state. It never repairs implicitly
or echoes private projector-error content into its report. For session observability, it separates
fresh `none`/`complete` from legacy, degraded, stale, or manifest-unproven state and gives a
dry-run path before any write.

## Common errors and diagnosis

- `no vault`: run from the bound root or pass `--vault`.
- `defs stale`: confirm the version and run `sync-defs --reseed`.
- Legacy vault: this is a non-blocking warning; plan `memory migrate --apply` separately.
- `degraded` plus an intact outbox: warning; preserve the outbox and allow idempotent replay.
- `ambiguous`, lost publication, or a mismatched checkpoint: blocking; preserve registry, ledger,
  outbox, and SHARED so `last_memory_attempt` can be correlated before repair.
- Corrupt bundle: preserve evidence and run `memory status --gate` before `memory repair`.
- `legacy`/`degraded`/`stale`/`manifest-unproven` observability: run
  `wendkeep cost rebuild --session <id> --json`, review diagnostics, and only then authorize
  `--apply`.

## Next steps

See [installation and first use](getting-started.md), [memory](memory.md), and
[change verification](verify.md).
