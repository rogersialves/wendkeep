# Operating profiles and FLOW

**English** · [Português](../../pt-BR/commands/operating-profiles.md)

## Purpose

Choose how much Wend Runtime governance an execution needs without disabling **Keep Core**.
Keep Core is always active: the Vault, session, identity, CORE/SHARED, lessons, costs, and
persistence integrations continue working under every profile.

The `OFF` profile disables automatic governance activation, not the CLI: explicit commands such as
`profile`, `flow`, `change`, `verify`, and `sensors` remain available. Invoking one is a deliberate
opt-in and runs that command's own validations and gates.

## When to use

Use `profile` to inspect or explicitly select an Operating Profile. Use `FLOW` for local,
reversible `spec_impact:none` maintenance that fits an Execute → Validate microcontract without a
change.

## When not to use

Do not select `OFF` to bypass policy: it hands execution to the LLM's native harness and can only
be selected explicitly. Do not finish public-contract, security/auth, migration/schema,
dependency, CI/release, spec, or WendKeep gate/policy changes in FLOW; promote the work to a
change.

## Prerequisites

- An initialized project whose `.wendkeep.json` is bound to the correct Vault.
- For a session override, one unambiguous session in `SESSION_REGISTRY.json`.
- For FLOW, a Git repository, a path allowlist, a reason, and at least one existing sensor in
  `wendkeep.sensors.json`.

## Syntax

```bash
npx wendkeep profile status [--project <path>] [--vault <path>] [--session <id>] [--json]
npx wendkeep profile use <profile> [--project <path>] [--vault <path>] [--session <id>] [--json]
npx wendkeep flow start <slug> --allow <path> [--allow <path>...] --sensor <id> [--sensor <id>...] --reason <text> [--session <id>]
npx wendkeep flow status [<id>]
npx wendkeep flow show <id> [--session <id>]
npx wendkeep flow finish <id> [--session <id>]
npx wendkeep flow promote <id> [--change-slug <slug>] [--session <id>]
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
| `GUIDE` | P → E → V | Compact change; policy recognized for compatible evolution. |
| `GOVERN` | P → R → E → V | Current a2 loop and conservative fallback. |
| `ASSURE` | P → R → E → V → C | Governance plus confirmation and handoff. |

- Resolution is explicit session override → project `harness.profile` → `GOVERN`. Heuristics,
  diff size, prompt text, environment variables, or read failures never select `OFF`.
- `profile status` prints the effective profile and source; `--json` emits structured output. When
  an explicit Vault preserves the selection despite a corrupt binding, output includes
  `binding_error` and the diagnostic is also written to stderr.
- `profile use` validates names and flags strictly; a duplicate/incomplete singleton option or a
  value beginning with `--` fails before I/O. Without `--session`, it atomically changes the
  project binding; with `--session`, it records override, source, and timestamp without changing
  session identity.
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
- Exit `0` means a successful query or transition; exit `1` means a policy/red-sensor block; exit
  `2` means invalid profile, session, flow, or arguments, with no partial mutation.

## Examples

Inspect the effective default and apply an override only to the current session:

```bash
npx wendkeep profile status
npx wendkeep profile use OFF --session 019abc-session-id --json
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

## Expected result

Changing profile neither creates a new session nor interrupts the Vault. In `OFF`, memory and
lessons are still injected and Stop still persists the session/memory lifecycle, while automatic
router, skill gate, change context/warn/nag/guard, and plan capture are inactive. Explicit commands
remain available and run their own contracts. A completed FLOW leaves a durable, inspectable
receipt; a promoted FLOW enters the normal change lifecycle.

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

## Next steps

Read [changes and verification](changes-and-verification.md), the deep
[verify guide](verify.md), and [sessions and import](sessions-and-import.md).
