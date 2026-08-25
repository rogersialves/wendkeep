# Causal TDD attestation

**English** · [Português](../../pt-BR/commands/tdd.md)

## Purpose

`wendkeep tdd` records auditable proof that a test bound to a task and requirement was observed
RED and then GREEN in the same project, repository, worktree, work session, and change. It
complements coverage, mutation, sensors, and review; it replaces none of them.

## When to use

Use before and after implementing testable behavior bound to a `[tdd]` task.

## When not to use

Do not use it for health checks, already-green tests, or environment failures. Use sensors/doctor
for infrastructure and a human waiver only when the behavior is genuinely not testable.

## Prerequisites

An active change, causal active context, task with `[req:ID]`, project-relative test, and a
deterministic command that can be repeated in RED and GREEN.

## Syntax

```bash
wendkeep tdd red <task-id> --requirement <ID> --test <path> --command "<command>" --session <id>
wendkeep tdd green <task-id> --command "<command>" --session <id>
wendkeep tdd status <task-id> --session <id> [--json]
wendkeep tdd waive <task-id> --requirement <ID> --reason "<reason>" --authority "<human>" --session <id>
```

`--test` is repeatable. Every path is project-relative. `--change <slug>`, `--project <root>`,
`--vault <vault>`, and `--json` follow the other commands' conventions.

## RED → GREEN contract

- Valid RED is a behavioral failure. An already-green test, syntax/import error, missing module,
  invalid configuration, or unknown command yields `invalid`.
- GREEN must preserve the RED causal identity and branch, pass, and observe a production change
  after RED. GREEN from another worktree, task, or requirement cannot close the cycle.
- A changed test path is recorded in `review_flags`. A refactor or commit after GREEN makes proof
  stale until `tdd green` runs again; the previous GREEN remains in `green_history`.
- A waiver requires both a reason and explicit human authority. Silent waivers do not exist.

The `08-Mudanças/<slug>/tdd-attestations.json` store retains SHA-256 digests, a sanitized tail
bounded to 2,000 characters, and relative paths — never full output. The Evidence Envelope,
`verificacao.json`, handoff, and Observer expose the attestation and its ID to reviewers.

## Profile gate

- `OFF` and `FLOW`: optional.
- `GUIDE`: recommended for testable behavior.
- `GOVERN`: required when a task carries `[tdd]`.
- `ASSURE`: required for an executable task with a requirement or sensor, unless explicitly waived.

Mark a task as follows:

```markdown
- [ ] 1.1 persists the preference [req:UI-1] [sensor:tests] [tdd]
```

Stale/invalid proof, a surviving mutant, or a missing GREEN/waiver produces
`TASK_TDD_ATTESTATION_MISSING_OR_INVALID` in the Task Contract and blocks Execute → Verify.

## Examples

```bash
wendkeep tdd red 1.1 --requirement UI-1 --test tests/ui.test.mjs --command "npm test" --session abc
wendkeep tdd green 1.1 --command "npm test" --session abc
wendkeep tdd status 1.1 --session abc --json
```

## Expected result

A causal entry in `tdd-attestations.json`, referenced by the Task Contract and evidence surfaces,
with an auditable current state and revalidation history.

## Options and exit codes

- `0`: the observed state is valid (`red-observed`, `green-observed`, or `waived`; green/waived status).
- `1`: observation ran but is `invalid`, RED has not reached GREEN, or status is stale.
- `2`: invalid usage, context, identity, store, or waiver authority.

## Common errors and diagnosis

- `TDD_RED_ALREADY_GREEN`: first write a discriminating test that fails.
- `TDD_RED_INFRASTRUCTURE_FAILURE`: fix import, syntax, configuration, or command and repeat RED.
- `TDD_GREEN_STALE_AFTER_REFACTOR`: repeat GREEN in the current checkout.
- `TDD_IMPLEMENTATION_NOT_AFTER_RED`: proof observed no production diff after RED.

## Next steps

Run [verify](verify.md), request the independent pass, and continue the
[change lifecycle](changes-and-verification.md).
