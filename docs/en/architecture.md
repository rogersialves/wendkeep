# Modular architecture

The installable package remains `wendkeep`. Internally, the repository separates responsibilities
into private workspaces so migration can be incremental and dependency direction can be tested.

| Surface | Responsibility |
|---|---|
| `cli` | Command parsing, presentation, and composition. |
| `harness` | Profiles, policies, changes, sensors, and verification. |
| `vault` | Keep Core, project binding, memory kernel, and safe local I/O. |
| `mcp` | MCP transport and configuration. |
| `integrations` | Pure host-integration rules for hooks, envelopes, transcripts, and identity. |
| `pi` | Pi-specific extension and hooks. |
| `commit` | Universal message, proof set, and commit-range gate. |
| `contracts` | Derived task, TDD, and verdict contracts without parallel authority. |
| `evidence` | Evidence Envelope, provenance gate, and append-only receipt ledger. |
| `migrations` | Upgrade registry, journal, backup, repair, rollback, and receipts. |
| `observer` | Policy, RBAC, redaction, encryption, retention, and purge. |
| `sync` | Local-first protocol, outbox, and adapters. |
| `worktrees` | Safe worktree lifecycle and cleanup. |

## 0.90 Public graph and composition roots

The root tarball exposes exactly `wendkeep/commit`, `wendkeep/contracts`, `wendkeep/evidence`,
`wendkeep/harness`, `wendkeep/mcp`, `wendkeep/migrations`, `wendkeep/observer`, `wendkeep/sync`,
`wendkeep/vault`, and `wendkeep/worktrees`. `cli`, `pi`, and `integrations` remain private
composition roots or adapters: they compose effects but do not become programmatic APIs. No
`@wendkeep/*` package is published independently.

The boundary test computes the import graph and requires it to remain acyclic. Domain kernels do
not read ambient environment, stdin, or incidental filesystem state; imports into the legacy layer
are confined to versioned composition roots with an exact file-and-target allowlist. Facades under
`src/` and `hooks/` re-export canonical bindings
throughout 0.x without duplicating authority. Incremental `sync` and `worktrees` extraction
preserves identity.

## Dependency direction

Host adapters (`cli`, `mcp`, `integrations`, and `pi`) compose the runtime through `harness`, which
in turn uses `vault`. The allowed direction is:

```text
composition roots (cli/mcp/pi) -> domain adapters -> Harness -> Vault
```

`vault` is the independent base and never depends on `harness`. The `harness` workspace
canonically owns Operating Profile resolution/policy and the sensor engine under
`packages/harness/src/`; `vault` continues to own binding/resolution, physical path safety, and the
memory kernel under `packages/vault/src/`.

## 0.66 Integrations Kernel

The private `@wendkeep/integrations` workspace under `packages/integrations/src/` is the canonical
authority for pure rules shared by Claude Code and Codex: the hook catalog and projection;
envelope parsing, provider detection, and metadata; content filters and extraction; usage
normalization; transcript parsing and matching; and session/turn identity resolution.

This boundary performs no stdin/stdout, ambient environment, filesystem, Vault, or registry
effects. Those effects remain in the historical facades under
`hooks/` and `src/`, which re-export the same bindings and inject host data into the pure kernel.
Claude/Codex hooks and sessions therefore remain semantically equivalent, with no Vault,
configuration, path, or schema migration.

MCP and Integrations are sibling adapters with no dependency between them. Both follow
`cli/mcp/integrations/pi → Harness → Vault`, and boundary tests reject cycles or ambient access
inside the kernel. Integrations remains internal to the root tarball: there is neither a separate
`@wendkeep/integrations` npm publication nor a public `wendkeep/integrations` subpath. Consumers use
the supported historical facades.

## Native semantic MCP

`packages/mcp/src/config.mjs` remains the pure configuration-merge authority. The explicit runtime
is split into an effect catalog, JSON-RPC server, stdio transport, semantic executor, auditor, and
CLI. The catalog has SHA-256 integrity, declared aliases, and versioned schema references. The
guard resolves that catalog: a known read is not a mutation; a write, destructive operation,
unknown tool, or invalid manifest fails closed.

Core MCP works on Node 18. The Observer tool imports the SQL adapter only when called and declares
itself unavailable below Node 22.13. Reads resolve explicit project and worktree bindings and do
not expose arbitrary filesystem reads. Writes carry a capability, actor, session, active context,
lease, and reason; the executor revalidates the active context and invokes the same causal CLI
commands/gates. Delivery, merge, push, tag, publication, and deletion are absent from the default
surface.

The transport enforces pagination, request/response byte budgets, timeout, cancellation, and typed
errors. Paths and secrets are redacted. The local append-only audit records only tool, effect,
capability, outcome, code, and duration—never the payload. `wendkeep mcp config` renders snippets
for Claude, Codex, Cursor, and generic clients.

`init` preserves existing properties and servers, writes `.mcp.json.new` when current JSON is
invalid, and configures `npx --no-install wendkeep mcp serve --vault <vault>`. There is no managed
`@latest` dependency. The workspace remains private inside the single `wendkeep` package.

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

All thirteen workspaces remain private and internal to the monorepo; they are not independent npm
packages. Installation remains `wendkeep`; `wendkeep/harness` and `wendkeep/vault` are public
subpaths of the root package, not separate publications. CLI remains exposed through the binaries
and MCP retains its public subpath. Integrations and `pi` remain private boundaries whose effects
are controlled by composition roots.
