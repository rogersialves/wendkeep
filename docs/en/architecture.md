# Modular architecture

The installable package remains `wendkeep`. Internally, the repository separates responsibilities
into private workspaces so migration can be incremental and dependency direction can be tested.

| Surface | Responsibility |
|---|---|
| `cli` | Command parsing, presentation, and composition. |
| `harness` | Profiles, policies, changes, sensors, and verification. |
| `vault` | Keep Core, project binding, and safe local I/O. |
| `mcp` | MCP transport and configuration. |
| `integrations` | Agent-host event adapters. |
| `pi` | Pi-specific extension and hooks. |

## Dependency direction

`vault` is the independent base and never depends on `harness`. Profiles such as `OFF` disable
only Wend Runtime governance; Vault, sessions, and memory remain active. In this first stage,
binding/resolution and physical path safety already live in `packages/vault`, while historical
paths remain compatibility facades.

Programmatic consumers can import the extracted surface:

```js
import { resolveProjectVault, assertVaultPathSafe } from 'wendkeep/vault';
```

The other workspaces are reserved boundaries and will gain public APIs only after their
implementations are migrated.
