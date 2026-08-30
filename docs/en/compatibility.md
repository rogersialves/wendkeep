# 0.x compatibility

WendKeep 0.90 remains an intermediate release: it does not claim 1.0 stability. Installation stays
a single, local-first `wendkeep` package with zero runtime dependencies.

## Supported matrix

| Surface | Node.js | CI-tested systems | SQLite |
|---|---|---|---|
| Keep Core, CLI, Vault, Harness, sync, and MCP Core | Node.js 18 and Node.js 20 | Linux | Not required |
| Full Observer | Node.js 22.13 and Node.js 24 | Linux, Windows, and macOS | `node:sqlite` required |

Newer Node releases may work, but only the lines above belong to the required gate. Observer fails
closed below 22.13; Keep Core remains available without loading SQLite.

## APIs and facades

Public subpaths are `wendkeep/commit`, `harness`, `vault`, `worktrees`, `observer`, `sync`,
`integrations`, `mcp`, and `migrations`. The `@wendkeep/*` workspaces remain private and are not
published separately. `wendkeep/cli` is not a programmatic API: use the `wendkeep`/`wk` binaries.

Versioned historical facades under `src/*` and `hooks/*` preserve identity throughout the 0.x
line. A deprecation must remain in the CHANGELOG and documentation for at least two minor releases;
removal will not happen before 1.0. Deep imports through `wendkeep/packages/*` were never a contract.

## Deprecation policy

Before removing or changing a public facade, the project publishes a replacement, migration
example, actionable diagnostic, and the minimum window. Authority, persisted-data, or security
changes still require a migration/receipt; a physical extraction with no contract change does not.

See the [architecture](architecture.md), [migrations](migrations.md), and
[support policy](support-policy.md).
