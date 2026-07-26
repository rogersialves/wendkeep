# Verify and independent verification

**English** · [Português](../../pt-BR/commands/verify.md)

## Purpose

Run the sensors required by a change's tasks, persist fresh evidence, and assemble the
self-contained package consumed by the independent `wk-verify` pass.

## When to use

Run after implementing tasks and again whenever tasks, specs, or tests change.

## When not to use

Do not use it as a post-install health check or when no change exists. Run `wendkeep doctor` and
`wendkeep memory status --gate` instead.

## Prerequisites

- An open change selected through `CURRENT_CHANGE.md` or `--change <slug>`.
- A placeholder-free `tarefas.md` with `[req:]` and `[sensor:]` tags on checkbox lines.
- Sensors declared in `wendkeep.sensors.json`.

## Syntax

```bash
npx wendkeep verify [--change <slug>] [--project <root>] [--vault <vault>]
npx wendkeep verify --deep [--change <slug>]
npx wendkeep change use <slug>
```

## Options and exit codes

- `--change <slug>` targets a change without changing the active pointer.
- `change use <slug>` persists focus for following commands.
- `--project <root>` selects the sensor cwd; `--vault` selects where proof is stored.
- **Exit 0:** all required sensors passed and evidence was written.
- **Exit 1:** the gate ran, but at least one critical sensor was red or a mutant survived.
- **Exit 2:** invalid usage/context, including `no change (--change or active)`, missing vault,
  unknown change, or invalid `wendkeep.sensors.json`.

`verify --deep` writes `verificacao.json`; it does not replace the reviewer. The `wk-verify` skill
must be run by a different author and writes `verdict.json`.

## Examples

Active change:

```bash
npx wendkeep verify
npx wendkeep verify --deep
```

Explicit change:

```bash
npx wendkeep verify --change tenant-login
npx wendkeep verify --deep --change tenant-login
```

Project with no open change:

```bash
npx wendkeep doctor --vault .MyApp-vault
npx wendkeep memory status --gate --vault .MyApp-vault
```

## Expected result

`evidencia.json` contains sensor results and a seal binds proof to the current `tarefas.md` hash.
Deep mode packages requirements, tasks, and evidence for read-only review; the verdict covers every
`[req:]` before archive.

## Common errors and diagnosis

- `no change`: this is exit 2 and a valid idle state; create/use a change or skip verify.
- Zero sensors: inspect same-line tags and `sensors list`.
- Red gate: fix the cause and rerun; never choose `archive --force` on your own.
- Missing/stale verdict: regenerate `--deep` and request a fresh independent pass.
- Surviving mutants: strengthen the discriminating test; after three rounds, review manually.

## Next steps

Return to the [change lifecycle](changes-and-verification.md) for archive, or use
[maintenance](maintenance-and-diagnostics.md) when no change exists.
