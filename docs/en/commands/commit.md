# Evidence-based commits

**English** · [Português](../../pt-BR/commands/commit.md)

## Purpose

Produce the same auditable message from Codex, Claude Code, or another Git client using typed input,
public references, and a staged-index summary only. The deterministic kernel does not read the
Vault, `.brain`, session registries, or the network.

## When to use

Use before `feat`, `fix`, `refactor`, or `perf` implementation commits that must record causal
authority, tasks, tests, scope, and verifiable evidence consistently across harnesses.

## When not to use

Do not use it to invent proof, publish private content, rewrite history, or automate pushes.
`docs`, `test`, and `chore` commits need no context only when every changed file is objectively
documentation/test material. Product changes require the governed body regardless of type.

## Prerequisites

Run inside a Git repository with WendKeep installed locally and the selected product files already
present in the staged index.

## Syntax

```bash
npx --no-install wendkeep commit context --input <json|-> [--json]
npx --no-install wendkeep commit context --clear [--json]
npx --no-install wendkeep commit render --input <json|->
npx --no-install wendkeep commit prepare --message-file <path> [--source <source>]
npx --no-install wendkeep commit validate --message-file <path> [--json]
```

## Options and exit codes

- Exit `0`: context written/cleared or message valid.
- Exit `1`: invalid governed message.
- Exit `2`: invalid argument, JSON, Git state, privacy boundary, or stale context.
- `--consume-context` is reserved for the `commit-msg` wrapper and removes context after validation.

## Opt-in installation

The default `init` does not enable Git hooks. To copy the portable wrappers and set
`core.hooksPath=.githooks` for this repository only:

```bash
npx --no-install wendkeep init --git-commit-hooks --yes
```

Custom hooks are never overwritten silently. When `init` finds a conflict it preserves the file.
Review it and rerun with `--force` only when replacement is intended; the previous file is retained
as `.bak`.
A custom `core.hooksPath` is also a conflict and remains untouched without `--force`.

## Examples

### Prepare a commit

Create JSON matching `schema/commit-message-v1.schema.json`. Declare authority and evidence
references, but do not provide `tasks`, `tests`, `fresh`, or `verified`. Runtime derives tasks from
completed canonical Task Contracts. Tests come only from `[sensor:<id>]` sensors executed by the
collector; `[phase:verify]` alone is never a result. Sensors
declared in an Envelope must exactly match the canonical reexecution in IDs, configuration,
command, severity, and result; only that reexecution emits a `Tests` line. The remote gate
re-executes each sensor in the checkout for that exact commit SHA. Every
published reference gets a re-derived SHA-256 digest. ADR/design validate artifact ID and path;
tasks containing `[req:]` require a versioned, sanitized `spec` reference that defines every
requirement. Evidence Envelope, Verdict, receipt, and TDD attestation may participate in local
validation, but are omitted from remote Evidence: worktree/session/branch IDs are not published,
and self-contained consistency is not promoted to proof. A message claiming them as
`fresh`/`verified` is rejected with `WENDKEEP_COMMIT_REMOTE_PROOF_UNAVAILABLE`. The fixed trailers
`Remote-Proof-Scope: git,authority,tasks,spec,sensors` and `Local-Causal-Proof: unpublished` make
that boundary explicit. Range re-derives authority/artifacts, task/spec, Git `Scope`, and
config/sensors from the SHA, and only canonical reexecution emits `Tests`. `Co-Authored-By` is
omitted until a trusted identity registry can resolve it.

The normal authority is the causal ADR:

```json
{ "authority": { "kind": "adr", "adr": "ADR-1234", "ref": "docs/ADR-1234.md", "issue": "#123" } }
```

Only when no causal change/ADR exists may the native harness declare the fallback below. `issue`
must be `#NNN` and `design` must be versioned in the same commit under
`docs/superpowers/specs/` or `plans/`:

```json
{
  "authority": {
    "kind": "native",
    "issue": "#40",
    "design": "docs/superpowers/specs/approved-design.md"
  }
}
```

Runtime observes effective profile `OFF`, no causal context/change/lease or ADR, and the issue in the
design. This mode emits unique `Authority: native-no-causal-change`, `Issue`, and `Design` trailers. Free text, unversioned
design, stale/unverified proof, or a missing body/tests fail closed.

```bash
git add <product-files>
npx --no-install wendkeep commit context --input commit-input.json
git commit -m "feat(scope): draft"
```

`commit context` calculates the staged diff SHA-256 and stores the sanitized context at
`.git/wendkeep-commit-input.json`, outside the working tree. `prepare-commit-msg` replaces the draft
with the canonical message; `commit-msg` validates it and consumes the context. If the index changes,
the context becomes stale and must be recreated.
`commit-msg` rereads context, compares the complete message and staged hash/files, and consumes
context only after success. Merge, squash, and amend clear incompatible context so it cannot leak
to the next commit. `--message-file` stays inside the repository or Git directory.
Derived tasks use the same canonical ordering in the message and remote range validation; IDs such
as `84.2` and `84.10` do not depend on incidental checklist order.

Other commands:

```bash
npx --no-install wendkeep commit render --input commit-input.json
npx --no-install wendkeep commit validate --message-file .git/COMMIT_EDITMSG
npx --no-install wendkeep commit context --clear
```

Objectively trivial commits remain unchanged. Implementation
commits (`feat`, `fix`, `refactor`, and `perf`) require a Conventional Commit subject with an ADR or
the restricted native fallback above, Capability, Evidence, Tasks, Tests, and Scope sections, the
staged hash, and a `WendKeep-Commit: v1` trailer. Amend, merge, and squash never receive duplicate or
invented proof.

## Privacy and fail-closed behavior

- Embedded absolute paths, any configured/default Vault, `.brain`, session registries, PII, and secrets are rejected
  before persistence.
- `reported`, `legacy-unbound`, `stale`, and `unproven` evidence cannot be presented as proof.
- Context holds sanitized references and diff metadata, never private Vault content.
- `--no-verify` is not accepted: CI validates every new commit, including merges and novel resolutions.

## Expected result

A deterministic, self-contained message with no private material, the hash of the committed index,
and coherent causal trailers.

## Common errors and diagnosis

`wendkeep doctor` reports `[commit-hooks] healthy`, `disabled`, `missing`, or `drift` and remains
read-only. After review, recover missing or divergent files with:

```bash
npx --no-install wendkeep init --git-commit-hooks --force --yes
```

When abandoning a commit, remove only its transient context with
`wendkeep commit context --clear`. No command rewrites history or pushes automatically.

## Next steps

Review the generated message, commit it, and let the PR range gate detect any local bypass.
