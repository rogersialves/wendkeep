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
`wendkeep_evidence_recall`, `wendkeep_memory_conflicts`, `wendkeep_change_list`,
`wendkeep_change_show`, `wendkeep_change_status`, `wendkeep_spec_effective`,
`wendkeep_task_show`, `wendkeep_task_evaluate`, `wendkeep_handoff_current`,
`wendkeep_evidence_latest`, and `wendkeep_observer_query`.

Writes: `wendkeep_memory_assert`, `wendkeep_checkpoint_create`, `wendkeep_context_select`,
`wendkeep_task_claim`, `wendkeep_task_complete`, and `wendkeep_handoff_publish`.

## Paged indexed evidence recall

`wendkeep_evidence_recall` is the bounded surface for retrieving Vault evidence. It selects
candidates through the persistent lexical sidecar or optional SQLite/FTS5, reranks them with the
canonical scorer, and returns a compact page. `wendkeep_memory_recall` remains available as the
legacy API and does not silently inherit the new contract.

Main input:

- `project_root` and `query` are required;
- `limit` accepts 1 through 100 results per page;
- `cursor` is opaque and is valid only for the same query, filters, and logical index;
- `max_bytes` accepts 2 through 524288 and exactly bounds the serialized JSON in `results`; the
  default is 64 KiB;
- `candidate_limit` accepts 1 through 4096 candidates;
- `posting_budget` accepts 1 through 1048576 visited postings;
- `backend` accepts `auto`, `sqlite`, or `lexical`;
- `filters` supports exact matches for `authority`, `validity`, `entity_type`, `project_id`,
  `change_slug`, `session_id`, `work_session_id`, and `logical_path`, plus
  `logical_path_prefix`. Each filter may be a string or a string list.

Example call:

```json
{
  "name": "wendkeep_evidence_recall",
  "arguments": {
    "project_root": "<project>",
    "query": "authentication contract",
    "limit": 5,
    "max_bytes": 65536,
    "candidate_limit": 512,
    "posting_budget": 65536,
    "backend": "auto",
    "filters": {
      "authority": "verified",
      "validity": "active",
      "logical_path_prefix": "04-Decisions/"
    }
  }
}
```

The response contains `results`, `next_cursor`, `has_more`, `as_of`, and page counts/bytes. Each
result omits `content`, reports `content_bytes`, retains a bounded `excerpt`, and replaces
`logical_path` with `logical_ref`, a Vault-relative reference—never an absolute path. The
`candidates` block exposes backend, count, postings, rebuild, and fallback metadata. When the
candidate budget did not cover every possible match, `complete_candidate_set` is `false`; this
prevents a consumer from treating a truncated selection as exhaustive.

## Expected result

The handshake and `tools/list` return valid JSON-RPC. Every tool declares a versioned
effect/capability and schemas. Known reads skip the mutation gate while retaining explicit
project/worktree binding, cursor pagination, budgets, redaction, timeout, and cancellation.
Observer is declared unavailable below Node 22.13 without blocking Core on Node 18. Indexed recall
also works on Node 18 through the lexical fallback; SQLite/FTS5 remains optional.

Writes require `project_root`, `session_id`, `active_context_id`, `actor`, `reason`, the exact
capability, and `lease.id`/`lease.expires_at`; the executor revalidates causal authorization and CLI
gates. The local `.brain/runtime/MCP_AUDIT.jsonl` audit stores only tool, effect, capability,
outcome, code, and duration—never arguments or payloads.

## Common errors and diagnosis

- `MCP_TOOL_UNKNOWN`: the tool/alias is absent from the verified catalog; update client or package.
- `MCP_CAPABILITY_REQUIRED` / `MCP_SCOPE_AUTH_REQUIRED`: capability missing or unauthorized.
- `MCP_LEASE_EXPIRED`: obtain a new authorization/lease; do not hand-edit its timestamp.
- `MCP_PROJECT_SCOPE_MISMATCH`: `project_root` and `worktree_root` use different bindings.
- `MCP_REQUEST_TOO_LARGE` / `MCP_RESPONSE_TOO_LARGE`: reduce budgets and continue with the cursor.
- `MCP_RUNTIME_UNSUPPORTED`: use Node 22.13+ for Observer; Core remains available.
- `MCP_EVIDENCE_QUERY_REQUIRED`: provide a non-empty query.
- `MCP_EVIDENCE_CURSOR_INVALID`: the cursor was altered, became stale, or was reused with a
  different query/filter set.
- `MCP_EVIDENCE_BUDGET_TOO_SMALL`: even the next result's minimum metadata cannot fit
  `max_bytes`.
- `MCP_EVIDENCE_BACKEND_UNAVAILABLE`: SQLite was required but FTS5 is unavailable; use `auto` or
  `lexical`.
- `MCP_EVIDENCE_ARTIFACT_UNSAFE`: a derived artifact violated the Vault's physical boundary.
- `MCP_EVIDENCE_RECALL_INVALID`: a filter, backend, or limit is outside the contract.

## Next steps

Run `wendkeep mcp config --client <client> --vault <vault>`, install the snippet in the client, and
perform `initialize` → `tools/list` → a known read. See [Context](context.md) for causal identity and
[Observer](observer.md) for the optional SQL backend.
