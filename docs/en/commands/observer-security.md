# Observer security

**English** · [Português](../../pt-BR/commands/observer-security.md)

## Purpose

The Observer is a local/team read model, never a new authority over the Vault, specs, memory, or
sync. Its threat model assumes a compromised remote host, stolen token, curious operator, copied
database/outbox, adversarial payload, and interrupted purge. Host/Origin validation remains active;
mutations and sensitive reads fail closed, including on loopback.

| Class | Default | Primary risk |
|---|---|---|
| document | `metadata` | full memory/decisions |
| transcript | `metadata` | conversation and tools |
| prompt/response | `redacted` | PII and secrets |
| usage | `aggregate` | cost and operational identity |
| audit/receipt | minimal metadata | deleting the proof itself |

Policy v1 restricts by class, `project_id`, path glob, and `entity_type`. Later rules win only in
the matching project. Redaction covers Bearer values, URL/connection-string credentials, access
keys, email, phone, and safe configurable regular expressions. Its schema is
`schema/observer-policy-v1.schema.json`.
With `transcript_capture: messages`, arrays, JSONL, and the canonical `{messages:[...]}` envelope
retain only `user|assistant|system` messages with string `role`/`content` after redaction; extra
fields, tool records, and malformed entries are dropped or fail closed.
Explicit policy is the publisher's sole capture authority; `WENDKEEP_OBSERVER_CAPTURE_LEVEL` is
only translated into policy for legacy callers that supplied no policy file, and can never elevate
or suppress explicit `none|metadata|messages|full` or `selected` documents.
For document/transcript upserts, `content_hash` always binds the final content after capture and
redaction; metadata/selected capture uses the SHA-256 of empty content. Document deletions remain
effective even when content capture is `none`, preserve their path/revision/operation metadata,
and never carry stale content or content hashes.
Redaction never rewrites validated structural identity fields such as project/event/entity IDs,
logical paths, revisions, or operations. Path privacy is enforced fail-closed by project/path
capture rules; it is not implemented by renaming a storage key through a content-redaction rule.
The per-event structural contract also preserves accepted snake/camel aliases, document/session/
agent/call/transcript/rollup keys, timestamps, roles, status, coverage, model/pricing dimensions,
workflow, and source provenance. `title`, `summary`, `agent_name`, content, prompt/response, and
metadata remain redactable display/content fields.
During incremental publishing, missing or blank turn timestamps inherit the batch's canonical
instant, numeric epoch milliseconds are normalized to ISO 8601, and invalid non-empty values fail
closed before policy/store; the event and payload use the same instant.

## When to use

Use it before enabling Observer for real data, registering or revoking credentials, restricting
capture, protecting SQLite/outbox, defining retention, or deleting data with verifiable proof.

## When not to use

Do not use it as a corporate KMS/secret manager, to publish Vault/runtime data, to replace local
authority, or to delete tables and indexes manually. `full` capture remains opt-in and subject to
policy/redaction.

## Prerequisites

Use Node.js 22.13+, keep the bind on loopback, and inject tokens/keys only through environment
variables. The bootstrap token is registered hash-only with explicit projects and a finite expiry;
it is not a registry-bypassing wildcard admin. For Docker, also set
`WENDKEEP_OBSERVER_BOOTSTRAP_PROJECTS`, `WENDKEEP_OBSERVER_BOOTSTRAP_EXPIRES_AT`, and a 32-byte
hex/base64 `WENDKEEP_OBSERVER_ENCRYPTION_KEY`. The operator owns the key and external receipts.

## Syntax

```bash
npx wendkeep observer serve --token <token> --bootstrap-projects <p1,p2> --bootstrap-expires-at <ISO> [--bootstrap-token-id <id>] [--require-loopback-auth] [--require-encryption]
npx wendkeep observer security token create --project-id <project> --role <role> --scopes <scopes> --token-env <env> --expires-at <ISO>
npx wendkeep observer security token rotate --project-id <project> --token-id <id> --token-env <env> --expires-at <ISO> [--new-token-id <id>]
npx wendkeep observer security token revoke --project-id <project> --token-id <id>
npx wendkeep observer security policy set --project-id <project> --file <policy.json>
npx wendkeep observer security policy show --project-id <project>
npx wendkeep observer security purge --project-id <project> --before <ISO> --classes <classes> [--dry-run]
npx wendkeep observer security retention run --project-id <project> [--dry-run] [--operation-id <id>]
```

## Options and exit codes

- `viewer` reads metadata/aggregates; `auditor` may receive sensitive scopes; `publisher` ingests;
  `admin` manages policy, purge, and recovery. Role, scope, and project must authorize together.
- Tokens persist only as SHA-256; expiry, rotation, and revocation take effect without restart.
- After rotating bootstrap credentials, update both token and token ID in the environment; restart
  never reactivates an expired or revoked predecessor.
- `--token-env` names the variable holding the secret; the command never prints its value.
- `--require-loopback-auth` protects the whole API; sensitive reads require a token without it too.
- `--require-encryption` fails when external key material is missing or invalid.
- `WENDKEEP_OBSERVER_REQUIRE_ENCRYPTION=1` applies the same fail-closed behavior to `status`,
  `security`, `register`, `publish`, and `reconcile`; with a configured key, every first v5 upgrade
  creates only `.bak.enc` plus its manifest before any read/backfill.
- Exit `0` means the operation completed; exit `1` means invalid configuration, authorization,
  policy, key, or operation. The hook retains fail-open exit `0` for the local workflow, but aborts
  before persisting unsafe content.

Audit stores capability, outcome, route, and time, never a Bearer value, prompt, response, or payload.

## Examples

Explicit audited offline recovery:

```powershell
$env:OBSERVER_RECOVERY_TOKEN = '<strong-temporary-secret>'
npx wendkeep observer security token create --data-dir C:\WendKeepObserver `
  --project-id project-a --role admin --scopes '*' --token-env OBSERVER_RECOVERY_TOKEN `
  --expires-at 2026-09-29T12:00:00Z --reason 'offline recovery' --json
npx wendkeep observer security token revoke --data-dir C:\WendKeepObserver `
  --project-id project-a --token-id <id> --reason 'recovery complete' --json
```

Always dry-run purge first. The retention runner is explicit and idempotent (CLI or
`POST /v1/projects/:id/security/retention`), with no hidden timer:

```powershell
npx wendkeep observer security purge --data-dir C:\WendKeepObserver `
  --project-id project-a --before 2026-08-01T00:00:00Z `
  --classes documents,calls,transcripts --dry-run --json
```

```powershell
npx wendkeep observer security retention run --data-dir C:\WendKeepObserver `
  --project-id project-a --operation-id scheduled-2026-08-29 --dry-run --json
```

## Expected result

TTL is independent for documents, calls, and transcripts. Counts, projection/FTS removal, events,
and receipt share one transaction; retry is idempotent and late old data creates new proof.

AES-256-GCM uses project/class/record/field AAD and an external `keyProvider`. The v6 backfill
removes plaintext and derived indexes before reads; a wrong key fails without disclosing content.
Structural migration `006-observer-security.sql` creates a backup, checks checksum, rolls back, and
supports retry. In required at-rest mode the backup is `.bak.enc`, carries a manifest/key ID and
restrictive permissions, fails restore with a wrong key, and leaves no plaintext `.bak` behind.

The hook applies metadata/redacted policy by default; `WENDKEEP_OBSERVER_POLICY_FILE` selects an
explicit policy. `WENDKEEP_OBSERVER_OUTBOX_KEY_ENV` names the outbox key variable and
`WENDKEEP_OBSERVER_OUTBOX_KEY_ID` identifies the key. Compose requires authentication and
encryption. The dashboard keeps Bearer only in memory, exports a sanitized copy, and exposes
Security. MCP requires scopes for calls/full search. Sync carries only `policy_ref`, without
duplicating tokens or authority.

## Common errors and diagnosis

- `observer_token_missing|expired|revoked`: create/rotate a scoped token or use offline recovery.
- `observer_project_forbidden|role_forbidden|scope_forbidden`: check project/role/scope intersection.
- `observer_encryption_key_unavailable|observer_decryption_failed`: check key ID/material; never
  weaken required mode.
- `observer_policy_invalid`: validate fields/captures and remove invalid or explosive regexes.
- v6 migration failure: preserve `.pre-006-*.bak.enc` and its manifest, correct the cause, and retry.

## Next steps

Read [Local Observer](observer.md), dry-run retention, validate revoked/expired tokens, and keep the
receipt outside the database when external proof is required. Never publish the database, backup,
outbox, key, token, or `/data`.
