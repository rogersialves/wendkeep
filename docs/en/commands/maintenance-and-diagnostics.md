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
```

## Expected result

Doctor names sessions, registry, links, notes, prices, derived sections, and memory as healthy or
provides a specific diagnostic/repair command. It never repairs implicitly.

## Common errors and diagnosis

- `no vault`: run from the bound root or pass `--vault`.
- `defs stale`: confirm the version and run `sync-defs --reseed`.
- Legacy vault: this is a non-blocking warning; plan `memory migrate --apply` separately.
- Corrupt bundle: preserve evidence and run `memory status --gate` before `memory repair`.

## Next steps

See [installation and first use](getting-started.md), [memory](memory.md), and
[change verification](verify.md).
