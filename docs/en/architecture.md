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

## 0.65 MCP Configuration Kernel

`packages/mcp/src/config.mjs` is the canonical authority for the `wendkeep-vault` key, the
MCPVault transport entry, catalog-described server selection, and immutable MCP configuration
merging. The private `packages/mcp/src/index.mjs` index collects this internal surface without
starting processes, accessing the filesystem, or producing import-time effects.

`src/taxonomy.mjs` continues to own the companion and host catalog, but supplies descriptors as
data to the kernel. `src/init.mjs` continues to own filesystem orchestration and delegates
configuration composition to MCP. This preserves the adapter direction and keeps the kernel from
depending on either the catalog or the installer.

`init` behavior does not change: existing top-level properties and servers are preserved,
`wendkeep-vault` still uses `npx -y @bitbonsai/mcpvault@latest <vault>`, `--no-mcp` still disables
that entry, and invalid JSON remains byte-for-byte intact while the proposal is written to
`.mcp.json.new`. The installed-tarball test exercises this flow in an isolated consumer.

The MCP workspace remains private in this phase. There is no root `wendkeep/mcp` export,
`@wendkeep/mcp` publication, or native MCP server; installation remains the single `wendkeep`
package.

## 0.64 Canonical CLI Runtime

`packages/cli/src/index.mjs` is the canonical authority for help, version reporting, Vault
selection, error presentation, and lazy command dispatch. The public `bin/wendkeep.mjs`
entrypoint keeps only the shebang, imports `runCli`, and invokes it. Composition rules therefore
cannot accumulate again in the executable facade.

The workspace remains private. The `wendkeep` and `wk` aliases are the public CLI surface; the
root package does not declare `wendkeep/cli` as a programmatic API. Command implementations under
`src/` and `hooks/` remain temporary consumers during incremental migration. Pre-Vault help,
messages, streams, exit codes, hooks, and binding precedence do not change. The installed-tarball
test validates the packaged runtime and both aliases outside the checkout.

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
subpaths of the root package, not separate publications. CLI and MCP now have private canonical
implementations: the former remains exposed through the binaries and the latter through `init`
configuration effects. `integrations` and `pi` remain reserved boundaries; the planned migration
sequence is MCP → Integrations → Pi.
