# Changes, specs, sensors, and archive

**English** · [Português](../../pt-BR/commands/changes-and-verification.md)

## Purpose

Carry a change from recorded intent to an archived decision, linking requirements, tasks,
sensors, evidence, and verdict in the vault graph.

## When to use

Use for any non-trivial implementation or fix that must leave auditable proof.

## When not to use

Do not create a change merely to inspect health, import sessions, or run read-only maintenance.

## Prerequisites

Initialize the project, keep the vault healthy, and provide a valid `wendkeep.sensors.json`.

## Syntax

```bash
npx wendkeep change new <slug>
npx wendkeep change status [slug]
npx wendkeep spec effective --change <slug>
npx wendkeep sensors list
npx wendkeep verify [--deep] [--change <slug>]
npx wendkeep change archive <slug>
```

## Options and exit codes

- `wendkeep change new <slug> [--simple]` creates proposal, design, tasks, and active pointer.
- `change use`, `list`, `show`, `status`, `diff`, `done`, and `undone` inspect or update work
  without archiving it.
- `change continue <archived> <new>` starts follow-up work without inheriting stale proof.
- `change bind <slug> --session <id>` attaches an existing session.
- `change relink [--apply]` and `change backlink [--apply]` repair graph links; preview is default.
- `change abandon <slug>` drops work without an ADR; `archive --force` needs explicit human choice.
- `wendkeep spec list|show|effective|migrate|rebase` manages living contracts and deltas.
- `wendkeep sensors list|add` manages executable proof.
- Exit `0` means completion; gates use exit `1` for red proof and exit `2` for invalid
  context/usage.

## Examples

```bash
npx wendkeep change new tenant-login
npx wendkeep spec effective --change tenant-login
npx wendkeep change done 1.1 --change tenant-login
npx wendkeep verify --change tenant-login
npx wendkeep verify --deep --change tenant-login
npx wendkeep change archive tenant-login
```

Add a sensor:

```bash
npx wendkeep sensors add api-contracts "npm run test:contracts" --severity critical
```

## Expected result

An archived change promotes its delta into the living spec, preserves proposal/design/tasks/proof,
and mints an ADR. Archive passes only with closed tasks, green required sensors, and a fresh verdict.

## Common errors and diagnosis

- `no change`: select one with `change use <slug>` or pass `--change`.
- `spec_impact: pending`: choose `required` with a delta or `none` with a real reason.
- Sensor not executed: keep `[sensor:id]` on the same checkbox line as the task.
- Stale evidence: rerun `verify` and `verify --deep` after task/spec edits.
- Rebase conflict: resolve the delta or use `--accept-current` only when that is the decision.

## Next steps

Read the deep [verify guide](verify.md) and [maintenance and diagnostics](maintenance-and-diagnostics.md).
