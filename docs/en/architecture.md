# Modular architecture

The installable package remains `wendkeep`. Internally, the repository separates responsibilities
into private workspaces so migration can be incremental and dependency direction can be tested.

| Surface | Responsibility |
|---|---|
| `cli` | Command parsing, presentation, and composition. |
| `harness` | Profiles, policies, changes, sensors, and verification. |
| `vault` | Keep Core, project binding, memory kernel, and safe local I/O. |
| `mcp` | MCP transport and configuration. |
| `integrations` | Agent-host event adapters. |
| `pi` | Pi-specific extension and hooks. |

## Dependency direction

`vault` is the independent base and never depends on `harness`. Profiles such as `OFF` disable
only Wend Runtime governance; Vault, sessions, and memory remain active. Binding/resolution,
physical path safety, and the memory kernel now canonically live in `packages/vault/src/`.

The kernel brings together `memory-schema`, `memory-mode`, `memory-handoff`, `memory-store`,
`validate-core`, and `validate-memory`. This boundary owns schema v2, the append-only ledger,
projection, handoff, and validation; session capture and harness orchestration remain outside it.

Programmatic consumers import the supported surface through the root package subpath:

```js
import {
  resolveProjectVault,
  validateSharedMemory,
  readMemoryLedger,
} from 'wendkeep/vault';
```

Historical paths under `hooks/` and `src/` remain thin re-export facades for compatibility; the
exports map also preserves installed bare specifiers such as `wendkeep/hooks/memory-store.mjs`.
Therefore, the extraction neither changes schema v2 nor rewrites the ledger, projection, or
session data: there is no data migration.

All six workspaces remain private and internal to the monorepo; they are not independent npm
packages. Installation remains `wendkeep`, and `wendkeep/vault` is the only new public entry point
in this phase. The other workspaces are reserved boundaries and will gain public surfaces only
after their implementations are migrated.
