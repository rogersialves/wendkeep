# Control-plane migrations

The `wendkeep/migrations` subpath provides the shared harness for N-2 and N-1 upgrades of Vault,
ledger, active contexts, Observer, and portable state. The registry declares sequential,
idempotent steps; the runner does not replace each store's authority validation.

## Durable contract

The flow is `plan → precondition → backup → journal → write → checksum → receipt`. Every step
records input and output hashes before advancing. Authority, memory, contracts, and evidence remain
canonical data; a migration only adds the versioned evolution.

A post-write crash resumes only when the checksum matches the journal. Divergence fails closed
without overwriting. The original backup is verifiable, and rollback is deterministic only while
the current state still matches the final receipt. A truncated journal requires explicit repair;
repair archives the corrupt journal, re-derives the plan from intact state, and never invents authority.

The public receipt follows `schema/migration-receipt-v1.schema.json`. A future version, wrong
resource, missing authority, divergent checksum, or tampered backup blocks the operation.

Real composition roots invoke the plan before incompatible reads or writes: the active-context
registry, portable-state import/diff, Vault memory lifecycle, JSONL receipt ledger, and Observer SQL
migration. The v1 ledger preserves historical bytes under a legacy prefix before publishing its v2
checkpoint; these flows do not rely only on N-2/N-1 fixtures. The closed journal follows
`schema/migration-journal-v1.schema.json`.

`src/control-plane-migrations.mjs` is the thin composition root: it registers adapters with the
`wendkeep/migrations` harness while delegating parsing and writes to the production authorities.
Vault is reopened by the memory-bundle validator, the ledger by the chain/checkpoint verifier, and
Observer by the SQLite migrator. Observer replay is idempotent, and rollback/repair use the real
structural backup.
The same registry enumerates exactly five resources; active contexts persists through the
session store, and portable state reopens through the canonical upgrader, with no side-channel calls
outside the harness.
