# Native MCP

[Português](../../pt-BR/commands/mcp.md)

## Purpose

Expose local semantic project, context, memory, change, task, evidence, and Observer state without
arbitrary filesystem reads or a dynamic `@latest` dependency.

## When to use

Use it when an MCP client must discover and query WendKeep or execute a causal write explicitly
authorized by capability, active context, and lease.

## When not to use

Do not use it for delivery, merge, push, tag, publication, deletion, or generic file access. Those
operations remain outside the default surface and use the appropriate CLI/ASSURE workflows.

## Prerequisites

- `wendkeep` installed in the project or available through its binary;
- a valid project↔Vault binding;
- Node.js 18+ for Core; Node.js 22.13+ only for Observer SQL;
- for writes: a current causal session, active context, and authorization.

## Syntax

```powershell
wendkeep mcp serve --vault <vault>
wendkeep mcp serve --vault <vault> --timeout-ms <n>
wendkeep mcp config --client generic --vault <vault>
wendkeep mcp config --client claude --vault <vault>
wendkeep mcp config --client codex --vault <vault>
wendkeep mcp config --client cursor --vault <vault>
```

## Options and exit codes

- `--vault <path>` selects the Vault; it is required by `config` and optional for `serve`. Without
  it, stdio starts independently of the process checkout and lazily resolves each call's binding
  and audit ledger from the declared `project_root`; one project never reuses another's auditor.
- `--timeout-ms <n>` accepts 1 through 120000; the per-call default is 10000.
- `--client` accepts `generic`, `claude`, `codex`, or `cursor`.
- Exit 0: transport/configuration completed; Exit 2: invalid subcommand, client, or option.
- Tool errors use an MCP `isError` result with `schema_version: 1`, an `MCP_*` code, sanitized
  message, and `retryable`; they do not terminate the server.

## Examples

`init` generates this reproducible generic entry:

```json
{
  "mcpServers": {
    "wendkeep-vault": {
      "type": "stdio",
      "command": "npx",
      "args": ["--no-install", "wendkeep", "mcp", "serve", "--vault", "<vault>"]
    }
  }
}
```

Reads: `wendkeep_project_status`, `wendkeep_context_status`, `wendkeep_memory_recall`,
`wendkeep_memory_conflicts`, `wendkeep_change_list`, `wendkeep_change_show`,
`wendkeep_change_status`, `wendkeep_spec_effective`, `wendkeep_task_show`,
`wendkeep_task_evaluate`, `wendkeep_handoff_current`, `wendkeep_evidence_latest`, and
`wendkeep_observer_query`.

Writes: `wendkeep_memory_assert`, `wendkeep_checkpoint_create`, `wendkeep_context_select`,
`wendkeep_task_claim`, `wendkeep_task_complete`, and `wendkeep_handoff_publish`.

## Expected result

The handshake and `tools/list` return valid JSON-RPC. Every tool declares a versioned
effect/capability and schemas. Known reads skip the mutation gate while retaining explicit
project/worktree binding, cursor pagination, a 1 MiB default budget, redaction, timeout, and
cancellation. Observer is declared unavailable below Node 22.13 without blocking Core on Node 18.

Writes require `project_root`, `session_id`, `active_context_id`, `actor`, `reason`, the exact
capability, and `lease.id`/`lease.expires_at`; the executor revalidates causal authorization and CLI
gates. The local `.brain/runtime/MCP_AUDIT.jsonl` audit stores only tool, effect, capability,
outcome, code, and duration—never arguments or payloads.

## Common errors and diagnosis

- `MCP_TOOL_UNKNOWN`: the tool/alias is absent from the verified catalog; update client or package.
- `MCP_CAPABILITY_REQUIRED` / `MCP_SCOPE_AUTH_REQUIRED`: capability missing or unauthorized.
- `MCP_LEASE_EXPIRED`: obtain a new authorization/lease; do not hand-edit its timestamp.
- `MCP_PROJECT_SCOPE_MISMATCH`: `project_root` and `worktree_root` use different bindings.
- `MCP_REQUEST_TOO_LARGE` / `MCP_RESPONSE_TOO_LARGE`: use `limit` and the returned cursor.
- `MCP_RUNTIME_UNSUPPORTED`: use Node 22.13+ for Observer; Core remains available.

## Next steps

Run `wendkeep mcp config --client <client> --vault <vault>`, install the snippet in the client, and
perform `initialize` → `tools/list` → a known read. See [Context](context.md) for causal identity and
[Observer](observer.md) for the optional SQL backend.
