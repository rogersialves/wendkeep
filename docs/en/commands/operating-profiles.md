# Operating profiles, work kind, FLOW, and delivery

**English** · [Português](../../pt-BR/commands/operating-profiles.md)

## Purpose

Choose how much Wend Runtime governance an execution needs without disabling **Keep Core**.
Keep Core is always active: the Vault, session, identity, CORE/SHARED, lessons, costs, and
persistence integrations continue working under every profile.

The `OFF` profile disables automatic governance activation, not the CLI: explicit commands such as
`profile`, `flow`, `change`, `verify`, and `sensors` remain available. Invoking one is a deliberate
opt-in and runs that command's own validations and gates.

## When to use

Use `profile use` for a persistent human selection and `profile route` for the harness to record
the temporary route for the current implementation. Use `FLOW` for local, reversible
`spec_impact:none` maintenance that fits an Execute → Validate microcontract without a change.
Use `delivery` for merge, push, tag, and publication of already-approved behavior: operational
risk needs authorization and a receipt, not a new change or spec.

## When not to use

Do not select `OFF` to bypass policy: it hands execution to the LLM's native harness and can only
be selected explicitly. Do not finish public-contract, security/auth, migration/schema,
dependency, CI/release, spec, or WendKeep gate/policy changes in FLOW; promote the work to a
change.

## Prerequisites

- An initialized project whose `.wendkeep.json` is bound to the correct Vault.
- For an override or temporary route, one unambiguous session in `SESSION_REGISTRY.json`; `route`
  also requires the current prompt to have a recorded causal frontier.
- For FLOW, a Git repository, a path allowlist, a reason, and at least one existing sensor in
  `wendkeep.sensors.json`.

### Tool scope and Git authorization

Under `GOVERN`/`ASSURE`, Codex `PreToolUse` and the equivalent Claude gate validate the project lease
before mutations. The lease includes the session, `project_id`, project root, Git root, remote,
branch/worktree, and provider. `commit`, `push`, `pull`, `merge`, `publish`, and destructive operations
are independent capabilities, including in compound commands; authorization never crosses projects or
branches.

If the host does not expose the effective directory, or the session is conflicted, the mutation is
denied with a sanitized diagnostic. Read-only inspection may continue for investigation.

## Syntax

```bash
npx wendkeep profile status [--project <path>] [--vault <path>] [--session <id>] [--json]
npx wendkeep profile use <profile> [--project <path>] [--vault <path>] [--session <id>] [--json]
npx wendkeep profile route <FLOW|GUIDE|GOVERN|ASSURE> --session <id> --reason <text> [--project <path>] [--vault <path>] [--json]
npx wendkeep flow start <slug> --allow <path> [--allow <path>...] --sensor <id> [--sensor <id>...] --reason <text> [--session <id>]
npx wendkeep flow status [<id>]
npx wendkeep flow show <id> [--session <id>]
npx wendkeep flow finish <id> [--session <id>]
npx wendkeep flow promote <id> [--change-slug <slug>] [--session <id>]
npx wendkeep delivery start [id] --allow <capability> [--source-change <slug>] [--source-commit <sha>]
npx wendkeep delivery status [id]
npx wendkeep delivery finish [id] [--target <ref>] [--ci-url <url>] [--version <x.y.z>] [--npm-integrity <sha512>] [--release-url <url>]
npx wendkeep delivery abandon [id] --reason <text>
```

Every FLOW subcommand also accepts `--project <path>`, `--vault <path>`, and `--json`. When
provided, `--session` scopes ID-based reads and mutations to the session that owns the FLOW; an
ID from another session fails without mutation.

## Ownership and programmatic surface

The private `packages/harness` workspace canonically owns Operating Profile resolution/policy and
the sensor engine. Programmatic consumers use the public root-package subpath:

```js
import {
  resolveOperatingProfile,
  runSensors,
  evaluateGate,
} from 'wendkeep/harness';
```

`src/operating-profile.mjs` and `hooks/sensors-core.mjs` are compatibility facades only. Dependency
direction is `adapters (cli/mcp/integrations/pi) -> Harness -> Vault`; Vault never depends on
Harness. The workspaces remain private and are not published as independent npm packages.

## Options and exit codes

| Profile | Route | Contract |
|---|---|---|
| `OFF` | LLM-native harness | Automatic governance off; Keep Core and explicit commands available. |
| `FLOW` | E → V | Microcontract with Git baseline, allowlist, sensors, and receipt, without a change. |
| `GUIDE` | P → E → V | `change new --guide`; objective, acceptance, areas, tests, and result; no automatic design/spec/ADR for `contract_impact:none`. |
| `GOVERN` | P → R → E → V | Current a2 loop and conservative fallback. |
| `ASSURE` | P → R → E → V → C | Governance plus confirmation and handoff. |

### Route legend

The letters are work stages, not individual commands:

- `P` = **Plan/Propose** — understand the request, bound the scope, and record the approach.
- `R` = **Review** — inspect the proposal/design before execution; this is the formal a2-loop review.
- `E` = **Execute** — edit the permitted paths and artifacts.
- `V` = **Validate** — run tests, sensors, and checks and record evidence.
- `C` = **Confirm/hand off** — obtain explicit confirmation and complete the handoff.

So, `P → R → E → V` means “plan/propose, review, execute, and validate”. `FLOW` starts at the
execution/validation microcontract; `OFF` imposes no automatic Wend route and returns process
ownership to the native LLM harness.

- The LLM harness semantically classifies the request and records `profile route`; Wend Runtime
  does not classify text, diff size, heuristics, or environment variables. It validates and applies
  the deterministic lease.
- For a local, reversible fix with no contract/spec change, choose `FLOW`. For a compact behavior
  change that needs a change but no formal review, choose `GUIDE`. For uncertainty, risk, security,
  public contracts, dependencies, CI/release, or policy, choose `GOVERN`. Use `ASSURE` when
  confirmation and handoff are part of the contract.
- `OFF` can never be an adaptive route; only a human persists it explicitly through
  `profile use OFF`. An `OFF` base may still receive a temporary elevation to a Wend route.

- Resolution is active prompt lease → persistent session override → project
  `harness.profile` → `GOVERN`. Invalid/expired leases and read failures never select `OFF`.
- `profile status` prints the effective profile and source. With `--session`, human output adds
  `base=<profile>/<source>` and `lease=<state>`; `--json` emits the same data structurally. When an
  explicit Vault preserves the selection despite a corrupt binding, output includes
  `binding_error` and the diagnostic is also written to stderr.
- `profile use` validates names and flags strictly; a duplicate/incomplete singleton option or a
  value beginning with `--` fails before I/O. Without `--session`, it atomically changes the
  project binding; with `--session`, it records override, source, and timestamp without changing
  session identity.
- `profile route` requires `--session` and `--reason`, accepts only the four adaptive profiles,
  and records lease id, reason, turn/sequence, and timestamp without touching persistent profiles.
- `.wendkeep.json` stays on `schemaVersion: 1`; the additive field is, for example,
  `"harness": { "profile": "GOVERN" }`. A legacy binding without it also resolves to `GOVERN`.
- A corrupt binding never means `OFF`. When the payload or legacy integration identifies one
  unambiguous Vault, Keep Core remains active under `GOVERN` and the hook exposes a diagnostic;
  mutation guards fail closed until the binding is repaired. Invalid local configuration, a
  missing marker, or a mismatched identity never silently inherits a parent/global Vault.
- `harness.flow.protectedRoots` accepts an array of project-relative roots, without globs or `..`
  escapes. Each root extends FLOW's protected surfaces; any change below it requires
  `flow promote`.

```json
{
  "harness": {
    "profile": "FLOW",
    "flow": {
      "protectedRoots": ["src/internal-api", "infra/releases"]
    }
  }
}
```

- `flow start` captures HEAD, pre-existing Git state, allowlist, sensors, reason, and session under
  `.brain/runtime/flows/`; it creates no `08-Mudanças`, ADR, verdict, spec, or
  `CURRENT_CHANGE.md`.
- `flow finish` compares the real diff with the Git baseline and allowlist, including submodule
  changes, Git metadata/config/hidden flags, and ignored protected surfaces. The projectRoot is
  frozen and sensors run in that cwd. A bounded, no-follow physical discovery keeps empty or
  ignored protected aliases visible without entering `.git`, the effective Vault, or local caches;
  ambiguity or a limit breach blocks. It rejects symlink/junction/reparse/hardlink paths in both
  the worktree and Vault destinations, revalidates before/after sensors, and recaptures the snapshot
  immediately before the receipt, blocking any sensor that mutates the repository. A terminal
  receipt and idempotent
  session iteration count as success only together; a temporarily
  busy projection exits `1` and can be retried safely.
- `flow promote` creates a normal change while preserving session, reason, paths, sensors, and
  evidence. A cross-process owner+lease slug lock, reservation, and durable `promoting` state elect
  one owner; contract, reservation, attempts, receipt, and origin remain semantically bound. The
  loser remains active and can retry with `--change-slug`. Retries idempotently resume the same
  promotion instead of creating another change.
  No FLOW command accepts `--force`.
- Work kind (`inspection`, `maintenance`, `implementation`, `delivery`, `recovery`), profile,
  `contract_impact`, and `operation_risk` are independent dimensions. `delivery start` captures
  repo, branch/worktree, SHA, source change, and capabilities in `.brain/runtime/deliveries/`;
  it creates no `08-Changes` folder, delta, spec, or ADR.
- `delivery finish` requires a clean worktree, proves that the target contains the source commit,
  and for `publish` requires CI, version, npm integrity, and GitHub Release evidence. Receipts are
  append-only in `.brain/runtime/delivery-receipts.jsonl`. If code/config must change, delivery
  stops with `WENDKEEP_DELIVERY_IMPLEMENTATION_REQUIRED` and work returns to implementation.
- Exit `0` means a successful query or transition; exit `1` means a policy/red-sensor block; exit
  `2` means invalid profile, session, flow, or arguments, with no partial mutation.

### Selection scope

Without `--session`, `profile use` writes `harness.profile` to `.wendkeep.json` and changes the
project default for conversations/hooks that have no session override. With `--session <id>`, it
writes an override only to that session's `SESSION_REGISTRY.json` and leaves the project default
unchanged. Therefore, `profile use OFF` without `--session` is not an isolated test; if
`.wendkeep.json` is committed, that choice is shared with other checkouts as well.

`profile route` creates a lease only for the current request. An accepted `Stop` consumes it by
CAS; if cleanup does not run, the next `UserPromptSubmit` advances the sequence and the lease is no
longer effective. A blocked Stop preserves it for a retry of the same request. There is no
wall-clock TTL that can interrupt long work. A session with no causal prompt recorded yet (missing
turn, zero sequence, or missing/mismatched causal map entry) is rejected before any mutation.
`status --session` includes the base profile and lease state in both human and `--json` output; in
JSON the fields are `base_profile`, `base_source`, and `task_lease.state` (`active`, `consumed`,
`expired`, `invalid`, or `absent`).

```bash
npx wendkeep profile status                       # project default
npx wendkeep profile use GUIDE                   # change the project default
npx wendkeep profile use FLOW --session <id>     # one session only
npx wendkeep profile route FLOW --session <id> --reason "local adjustment"  # current request
npx wendkeep profile status --session <id>       # session-effective profile
```

## Examples

Inspect the effective default and route only the current implementation:

```bash
npx wendkeep profile status
npx wendkeep profile route FLOW --session 019abc-session-id --reason "fix local typo" --json
npx wendkeep profile status --session 019abc-session-id --json
```

Run FLOW maintenance while capturing the `flow_id` returned by `start`:

```powershell
$flow = npx wendkeep flow start fix-copy --allow README.md --sensor docs-bilingual --reason "Fix copy without changing the contract" --json | ConvertFrom-Json
$flowId = $flow.contract.flow_id
npx wendkeep flow status $flowId
```

If the work remains local and inside the microcontract, finish it with the returned ID:

```powershell
npx wendkeep flow finish $flowId
```

If the scope grows before `finish`, promote instead of finishing:

```powershell
npx wendkeep flow promote $flowId
```

If another session already claimed the original slug, the FLOW stays active and can be promoted
again with an explicit destination:

```powershell
npx wendkeep flow promote $flowId --change-slug another-slug
```

Deliver an approved version without manufacturing another change:

```bash
npx wendkeep delivery start release-0-73-0 --source-change proportional-governance --allow git:merge --allow git:push --allow publish
npx wendkeep delivery status release-0-73-0
npx wendkeep delivery finish release-0-74-0 --target v0.74.0 --ci-url <run> --version 0.74.0 --npm-integrity <sha512> --release-url <release>
```

## Expected result

Changing profile neither creates a new session nor interrupts the Vault. In `OFF`, memory and
lessons are still injected and Stop still persists the session/memory lifecycle, while automatic
router, skill gate, change context/warn/nag/guard, and plan capture are inactive. Explicit commands
remain available and run their own contracts. A completed FLOW leaves a durable, inspectable
receipt; a promoted FLOW enters the normal change lifecycle. Completed delivery leaves a receipt
without an ADR; compact GUIDE archives its result without artificial spec/design/ADR.

## Common errors and diagnosis

- Unknown profile: use exactly `OFF`, `FLOW`, `GUIDE`, `GOVERN`, or `ASSURE`.
- `OFF` appeared without explicit selection: treat it as an error; missing/invalid reads must fall
  back to `GOVERN`.
- Missing or ambiguous session: inspect `session list` and pass `--session <id>` without retrying
  against a different target.
- FLOW without allowlist, reason, or sensor: complete the microcontract before editing.
- Out-of-scope path, protected surface, or red sensor: fix/abandon the FLOW or use
  `flow promote`; there is no bypass.
- A sensor changed the repository, the allowlist crosses a symlink/junction, or a sensitive
  ignored surface changed: restore the state and promote when the change is not strictly local.
  FLOW sensors must be read-only.
- Session projection is `missing`, `invalid-frontmatter`, or `busy`: restore/unlock the note and
  retry `flow finish` or `flow promote`; the idempotent marker prevents duplication.
- Pre-existing dirt appeared in the diff: it must match the initial fingerprint and must never be
  silently attributed to the FLOW.
- Delivery without `--allow`, with a dirty worktree, or with incomplete publish evidence: resume
  the real implementation or provide the receipts; do not create a change only to publish.

## Next steps

Read [changes and verification](changes-and-verification.md), the deep
[verify guide](verify.md), and [sessions and import](sessions-and-import.md).
