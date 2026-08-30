# Optional ecosystem bridges

> [Versão em português](../../pt-BR/commands/ecosystem-bridges.md)

## Purpose

Integrate Spec Kit and Superpowers without creating a second authority for specs, plans, tasks,
or evidence. WendKeep keeps canonical contracts; adapters only create versioned projections and
are disabled by default.

## When to use

- when a feature started in Spec Kit files and must preserve the same IDs and hashes;
- when Superpowers will execute a canonical WendKeep Task Contract;
- when external artifacts, reviews, or commits must enter as `reported` before proof.

## When not to use

- to replace `tarefas.md`, Task Contracts, or the Evidence Envelope;
- for unrestricted bidirectional synchronization;
- to execute commands, scripts, or text found in external artifacts.

## Prerequisites

- Node.js 18 or newer;
- a local `.wendkeep/ecosystem-bridges.json` config with each adapter explicitly enabled;
- a compatible version and an adapter root that resolves to a real directory inside the project;
  regular files, external paths, and symlinks that escape the project fail closed in status and dispatch;
- for governed import/dispatch, a bound Vault, causal change, and sealed Spec Kit baseline;
- for dispatch, a causal session and canonically rederivable Task Contract.

```json
{
  "schema_version": 1,
  "adapters": {
    "spec-kit": { "enabled": true, "version": "1.1.0", "root": ".specify" },
    "superpowers": { "enabled": true, "version": "1.2.0", "root": ".superpowers" }
  }
}
```

Without that file, both adapters are disabled and native Core keeps working.

## Syntax

```text
wendkeep bridge status [--project <path>] [--config <path>] [--json]
wendkeep bridge import-spec-kit --change <slug> [--accept-baseline] [--json]
wendkeep bridge export-status --spec-projection <projection.json> [--task-contract <task.json>] [--input <artifacts.json>] [--json]
wendkeep bridge dispatch-superpowers --task-id <id> --change <slug> [--task-contract <task.json>] [--session <id>] --spec-projection <projection.json> [--json]
wendkeep bridge verify-artifacts --input <artifacts.json> --proofs <proofs.json> --change <slug> [--session <id>] [--json]
```

`import-spec-kit` reads Markdown under `memory/` and `specs/`, classifies constitution/spec/plan/task,
preserves IDs and SHA-256 hashes, creates explicit
`story|requirement → capability → change → task` mappings, and never writes to the source.
Repeated IDs across different files block the projection.
The first import requires `--accept-baseline` and anchors the green projection in the Vault change;
later imports rederive the source and compare path, kind, hash, and mapping against that immutable baseline.
`dispatch-superpowers` contains only minimal
structural context derived from the Task Contract; transcripts, private content, and external
ownership are excluded.
Dispatch rederives the contract and active context from the Vault/checkout; submitted JSON is only
a comparison copy and never validates its own `binding`.
With Spec Kit active, the baseline and `--spec-projection` are mandatory and the source is
reimported before dispatch.
The `spec-projection` contract belongs exclusively to the `spec-kit` adapter: an incompatible
version, out-of-schema kind, or projection resealed by another adapter is rejected before producing `spec_refs`.
An `ok: false` decision requires at least one blocking diagnostic, while `ok: true` cannot coexist
with a blocking diagnostic; any inconsistency blocks dispatch without exposing references.
`export-status` recomputes and validates `projection_id`, returns a `reported` projection only, and
does not write to Spec Kit files.

## Options and exit codes

| Option | Effect |
|---|---|
| `--project <path>` | Selects the consumer root. |
| `--config <path>` | Overrides `.wendkeep/ecosystem-bridges.json`. |
| `--change <slug>` | Selects the change holding canonical baseline and Evidence Envelope. |
| `--accept-baseline` | Anchors only the first green Spec Kit baseline; never overwrites drift. |
| `--task-id <id>` | Selects the causal task and rederives its canonical contract. |
| `--task-contract <path>` | Optional copy that must match the rederived contract. |
| `--spec-projection <path>` | Links Spec Kit refs to dispatch without copying content. |
| `--input` / `--proofs` | Classifies external artifacts and their Git/CI/Envelope proofs. |
| `--json` | Emits the typed contract as one JSON line. |

- `0`: valid operation; optional disabled adapters are healthy too;
- `1`: enabled adapter blocked, drift, incompatibility, or missing proof;
- `2`: invalid argument, configuration, or input file.

## Examples

Small flow without adapters:

```powershell
node ./bin/wendkeep.mjs bridge status --json
```

Medium read-only Spec Kit flow:

```powershell
node ./bin/wendkeep.mjs bridge import-spec-kit --change ecosystem-bridges --accept-baseline --json > spec-projection.json
node ./bin/wendkeep.mjs bridge dispatch-superpowers --task-id 3.1 --change ecosystem-bridges --session "$env:CODEX_THREAD_ID" --spec-projection spec-projection.json --json
node ./bin/wendkeep.mjs bridge export-status --spec-projection spec-projection.json --task-contract task-contract.json --json
```

Large flow with external report and proof ingestion:

```powershell
node ./bin/wendkeep.mjs verify --change ecosystem-bridges
node ./bin/wendkeep.mjs bridge verify-artifacts --input artifacts.json --proofs ci-proofs.json --change ecosystem-bridges --json
```

Before `verify`, commit the artifact and `.wendkeep/bridge-artifacts.json` to the Git index. The v1
manifest binds each item to `source`, `external_id`, `kind`, `path`, `sensor_id`, and `task_id`. The
matching sensor in `wendkeep.sensors.json` declares v1 `artifact_results` with `external_id`, `path`,
and `algorithm: sha256`; the runner computes the byte digest, including binary files, only after a
green run. This explicit result contains no artifact content, transcript, or artifact output tail.
The collector checks the index first and then requires the identical copy to exist in the worktree;
deleting or changing only the working copy fails closed, while absence from both index and worktree
still means that the optional bridge declared no artifacts.

Each `ci-proofs.json` reference contains only
`{"type":"evidence-envelope","external_id":"review-1"}`. Path, task, sensor, digests, and Git
blobs are rederived from the canonical manifest and Envelope; self-declared state, SHA, or authority
are ignored for promotion. `artifacts.json` remains only the external report to compare.

An artifact starts as `reported`. External JSON that merely declares `state: verified` remains
`reported`. Promotion to `verified` jointly requires a project-contained file equal to its Git
index blob, a green CI sensor with an explicit `artifact_results.digest`, a canonical Evidence
Envelope v2 bound to the checkout, and a matching Envelope `external_artifacts` entry.
`output_sha256` does not prove artifacts. The result
exposes a sealed proof bound to `evidence_envelope_id` without copying transcript or Vault content.

## Expected result

- Spec Kit remains a read-only external source;
- canonical plan, task, and evidence remain owned by WendKeep;
- Superpowers receives minimal dispatch without permission to rewrite scope;
- worktree creation/reuse and finishing remain delegated to the `wendkeep worktree` argv derived in dispatch;
- post-merge cleanup uses `wendkeep worktree finish <slug> --pr <number-or-url>`;
- drift and competing ownership block before execution;
- removing or disabling an adapter does not degrade Core.

## Common errors and diagnosis

| Code | Diagnosis |
|---|---|
| `BRIDGE_ADAPTER_DISABLED` | Normal optional state; enable explicitly when needed. |
| `BRIDGE_ADAPTER_MISSING` | Adapter is enabled, but its root is absent. |
| `BRIDGE_VERSION_INCOMPATIBLE` | Version falls outside the published compatibility range. |
| `BRIDGE_OWNERSHIP_CONFLICT` | External tool tried to own plan/task/evidence. |
| `BRIDGE_SOURCE_DRIFT` | Hash changed, a plan became stale, or a reference appeared/disappeared. |
| `BRIDGE_SOURCE_ID_DUPLICATE` | The same story/requirement ID appears in different files. |
| `BRIDGE_BASELINE_MISSING` | Spec Kit is active without canonical baseline or required projection. |
| `BRIDGE_BASELINE_STALE` | Source/projection diverged from the sealed Vault baseline. |
| `BRIDGE_PROJECTION_INVALID` | Content and `projection_id` differ or schema fields are incomplete. |
| `BRIDGE_SCHEMA_INVALID` | Runtime envelope does not satisfy the published contract. |
| `BRIDGE_ARTIFACT_MANIFEST_UNTRACKED` | Bridge manifest exists on only one side or differs between index and worktree. |
| `BRIDGE_ARTIFACT_FORGED` | Artifact path/bytes do not match the versioned file. |
| `BRIDGE_ARTIFACT_RESULT_MISSING` | A green sensor did not produce the explicit digest bound by the manifest. |
| `BRIDGE_PROOF_MISSING` | External report has no bound independent proof yet. |
| `BRIDGE_PROOF_UNVERIFIED` | Self-declared proof was retained as `reported`. |

`wendkeep doctor` renders a `[bridges]` section without importing, dispatching, or writing.

## Next steps

Review the projection before dispatch, keep generated files outside canonical control, and verify
artifacts through CI or an Evidence Envelope. See [Changes and verification](changes-and-verification.md)
and [Managed worktrees](worktrees.md) as well.
