# Verify and independent verification

**English** · [Português](../../pt-BR/commands/verify.md)

## Purpose

Run the sensors required by a change's tasks, persist fresh evidence, and assemble the
self-contained package consumed by the independent `wk-verify` pass.

## When to use

Run after implementing tasks and again whenever tasks, specs, or tests change.

## When not to use

Do not use it as a post-install health check or when no change exists. Run `wendkeep doctor` and
`wendkeep memory status --gate` instead. In `FLOW`, validation and the receipt belong to
`flow finish`; under `OFF`, `verify` remains available only when the user chooses to run the
lifecycle manually.

## Prerequisites

- An open change selected through `CURRENT_CHANGE.md` or `--change <slug>`.
- A placeholder-free `tarefas.md` with `[req:]` and one or more `[sensor:]` tags on checkbox lines;
  every distinct sensor ID is required once, in declaration order.
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
- `--project <root>` selects the sensor cwd; `--vault` selects where proof is stored and is passed
  to sensors as `OBSIDIAN_VAULT_PATH`, including `memory-health`.
- **Exit 0:** all required sensors passed and evidence was written.
- **Exit 1:** the gate ran, but at least one critical sensor was red or a mutant survived.
- **Exit 2:** invalid usage/context, including `no change (--change or active)`, missing vault,
  unknown change, a project outside a Git repository, invalid `wendkeep.sensors.json`, or
  `WENDKEEP_EVIDENCE_HEAD_CHANGED`.

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

`evidencia.json` follows the [public v2 schema](../../../schema/wendkeep.evidence-envelope-v2.schema.json).
The envelope binds `project_id`, `repository_id`, `worktree_id`, `work_session_id`, change, and
branch to `base_sha`, `head_sha`, `index_tree_sha`, `worktree_digest`, tasks, effective spec, and
sensor configuration with complete SHA-256 digests. The worktree digest covers staged, unstaged,
untracked, rename, and delete state; paths use `/`, text normalizes CRLF/CR to LF, and binaries keep
their bytes. Binary classification honors Git `binary`/`-text` attributes and known binary
extensions (including `.bin`); ignored files are excluded.

Each sensor records its sanitized command and hash, start/end, duration, exit code, output digest,
and a sanitized tail bounded to 2,000 characters. Authority artifacts publish through a path-safe
temporary in the same directory and an atomic rename. In deep mode, `verificacao.json` and
`verdict.json` carry the same `evidenceEnvelopeId` and complete `evidenceBinding`; the independent
reviewer must preserve both.

V1 evidence remains readable as `legacy-unbound`, never as equivalent authority. Run
`wendkeep change status <slug>` to inspect `bound`, `stale`, or `context-mismatch`.

## Common errors and diagnosis

- `no change`: this is exit 2 and a valid idle state; create/use a change or skip verify.
- Zero/missing sensors: inspect every same-line tag and `sensors list`; multiple tags on one task
  are valid and all of them enter the gate.
- Red gate: inspect the bounded `note` field on the `evidencia.json` entry, fix the cause, and
  rerun; never choose `archive --force` on your own.
- Missing/stale verdict: regenerate `--deep` and request a fresh independent pass.
- `WENDKEEP_EVIDENCE_HEAD_CHANGED`: HEAD moved while sensors ran; stabilize the checkout and rerun.
  The previous evidence was not replaced.
- `legacy-unbound`, `stale`, or `context-mismatch`: return to the correct worktree/session, recover
  the context when needed, and rerun `verify` plus `verify --deep`.
- Surviving mutants: strengthen the discriminating test; after three rounds, review manually.

## Next steps

Return to the [change lifecycle](changes-and-verification.md) for archive, review
[Operating profiles](operating-profiles.md), or use [maintenance](maintenance-and-diagnostics.md)
when no change exists.
