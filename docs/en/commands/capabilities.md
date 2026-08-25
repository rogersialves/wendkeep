# Host capabilities

[Português (Brasil)](../../pt-BR/commands/capabilities.md)

## Purpose

Show the versioned matrix of the 17 lifecycle/effect capabilities each host actually provides as
`native`, `adapted`, `polled`, `manual`, or `unavailable`.

## When to use

Use it before depending on session hooks, tool use, task completion, subagents, transcript, or
usage; and when diagnosing differences across Claude Code, Codex, Pi, and generic MCP/CLI clients.

## When not to use

Do not treat the matrix as proof that a manual event happened. `manual` has `reported` authority;
only native/adapted/polled events can be `verified`.

## Prerequisites

Node.js 18+ and WendKeep installed. The command is pure and needs no Vault. Session coverage uses
the detected host and may receive its version through `WENDKEEP_HOST_VERSION`.

## Syntax

```text
wendkeep capabilities [--host <claude|codex|pi|generic-mcp>] [--host-version <v>] [--json]
```

Without `--host`, all manifests are listed. An unknown host explicitly degrades to `generic-mcp`;
an out-of-range version is marked `HOST_VERSION_UNPROVEN`.

## Options and exit codes

- `--host <id>` selects a host; unknown ids are never silently promoted.
- `--host-version <v>` compares the observed major with the manifest.
- `--json` emits the `host-coverage-v1` contract.
- exit `0`: matrix emitted; exit `2`: invalid argument.

`wendkeep.sensors.json` may declare `requires_host_capabilities` and explicit human waivers under
`host_capability_waivers`. `verify` exits `1` when a required capability is manual/unavailable
without `authority: human`, `approved_by`, and `reason`. ASSURE applies the same handoff rule.

## Examples

```powershell
wendkeep capabilities --host codex --host-version 1.2.0
wendkeep capabilities --host generic-mcp --json
```

```json
{
  "requires_host_capabilities": ["task.completed"],
  "host_capability_waivers": [{
    "capability": "task.completed",
    "authority": "human",
    "approved_by": "maintainer",
    "reason": "manual confirmation"
  }]
}
```

## Expected result

Coverage flows into the session registry, active context, handoff, evidence envelope, and Observer
summary. Gaps are injected at session start before the agent assumes nonexistent parity. MCP effects
come from the signed manifest: known reads skip the mutation gate; writes/destructive remain gated;
an unknown effect fails closed.

## Common errors and diagnosis

- `HOST_UNKNOWN`: use MCP/CLI fallback or publish an isolated adapter.
- `HOST_VERSION_UNPROVEN`: update the manifest or operate in degraded mode.
- `HOST_CAPABILITY_UNAVAILABLE`: remove the dependency or obtain an explicit human waiver.
- `HOST_ENVELOPE_UNKNOWN`: an unknown version/event never becomes verified evidence.
- A suggestive tool name does not define its effect; inspect the signed catalog with `wendkeep mcp inspect`.

## Next steps

See [Native MCP](mcp.md), [sessions and import](sessions-and-import.md),
[changes and verification](changes-and-verification.md), and [Observer](observer.md).
