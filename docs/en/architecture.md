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

Host adapters (`cli`, `mcp`, `integrations`, and `pi`) compose the runtime through `harness`, which
in turn uses `vault`. The allowed direction is:

```text
adapters (cli/mcp/integrations/pi) -> Harness -> Vault
```

`vault` is the independent base and never depends on `harness`. The `harness` workspace
canonically owns Operating Profile resolution/policy and the sensor engine under
`packages/harness/src/`; `vault` continues to own binding/resolution, physical path safety, and the
memory kernel under `packages/vault/src/`.

## 0.63 Harness FLOW Store

In this phase, canonical locale and taxonomy live in `packages/vault/src/locale.mjs`; the canonical
durable FLOW store lives in `packages/harness/src/flow-store.mjs`. Harness consumes only Vault's
public index (`packages/vault/src/index.mjs`), and Vault never depends on Harness.

`hooks/locale.mjs` and `hooks/vault-runtime-store.mjs` remain thin facades and re-export the same
bindings by identity. The extraction changes neither persisted paths, schemas, nor lock discipline,
so it requires no migration. Publication also remains unfragmented: a single tarball from the root
`wendkeep` package contains the modular surfaces.

A public lock or owner/lease metadata may legitimately disappear during release. Vault retries
only operations explicitly scoped to the public lock and only for `ENOENT`, with short backoff, a
global budget, and the acquisition's original deadline. Final cleanup uses an independent short
budget so owner/lease state is not left behind. Retry never applies to `.pending`, junctions,
symlinks, reparse points, `EACCES`, unexpected types, or persistently unresolvable state, which
continue to fail closed.

The `OFF` profile disables only automatic Wend Runtime governance activation — router, skill gate,
FLOW, and automatic gates. Keep Core, Vault, sessions, and memory remain active, and explicit
WendKeep commands remain available as a deliberate opt-in.

The kernel brings together `memory-schema`, `memory-mode`, `memory-handoff`, `memory-store`,
`validate-core`, and `validate-memory`. This boundary owns schema v2, the append-only ledger,
projection, handoff, and validation; session capture and harness orchestration remain outside it.

Programmatic consumers import the supported surfaces through root package subpaths:

```js
import {
  resolveOperatingProfile,
  runSensors,
  evaluateGate,
} from 'wendkeep/harness';

import {
  resolveProjectVault,
  validateSharedMemory,
  readMemoryLedger,
} from 'wendkeep/vault';
```

The historical `src/operating-profile.mjs` and `hooks/sensors-core.mjs` paths remain thin facades
for `harness`; the other historical paths under `hooks/` and `src/` preserve `vault`
compatibility. The exports map also keeps installed bare specifiers. Therefore, the extraction
changes neither profiles, sensor contracts, schema v2, ledger, projection, nor session data: there
is no data migration.

All six workspaces remain private and internal to the monorepo; they are not independent npm
packages. Installation remains `wendkeep`; `wendkeep/harness` and `wendkeep/vault` are public
subpaths of the root package, not separate publications. The other workspaces are reserved
boundaries and will gain public surfaces only after their implementations are migrated.
