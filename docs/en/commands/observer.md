# Local Observer

**English** · [Português](../../pt-BR/commands/observer.md)

## Purpose

The Observer consolidates observability for multiple WendKeep projects in a local service. The
Docker volume keeps `/data/observer.sqlite` as the single authority for documents, sessions,
agents, usage, calls, and complete transcripts. The content can be browsed and searched in the
container without depending on Obsidian for queries.

## When to use

Use it to query changes, sessions, decisions, bugs, learnings, specs, brain documents, per-agent
and per-model consumption, and health across projects through one local memory. During the
transition, the vault and legacy Markdown files remain a recovery copy; the Observer is
authoritative for queries made through its container.

## When not to use

Do not use the Observer to edit, complete, or archive changes, curate memory, automatically export
the authority back to Markdown, or expose the service to the network. Edits still go through local
WendKeep hooks.

## Prerequisites

Initialize projects with WendKeep and explicitly register each project before starting the HTTP
server. The default local mode has no token to configure.

## Syntax

```bash
npx wendkeep observer status --data-dir <directory> --json
npx wendkeep observer register --project <project> --vault <vault> --data-dir <directory>
npx wendkeep observer publish --project <project> --vault <vault> --data-dir <directory>
npx wendkeep observer memory import --project <project> --vault <vault> --url http://127.0.0.1:8787 --json
npx wendkeep observer serve --host 127.0.0.1 --port 8787 --data-dir <directory>
```

## Options and exit codes

- `--data-dir` selects the local event and index directory; the default is
  `WENDKEEP_OBSERVER_DATA_DIR` or `~/.wendkeep-observer`.
- `--project` and `--vault` identify a project for `register`, `publish`, and `memory import`.
- `--host` accepts only `127.0.0.1`, `localhost`, or `::1`; other hosts are rejected before
  listening.
- `/v1` is open in the default local mode; keep `--host 127.0.0.1` and do not publish the port on
  a network address.
- Exit `0` means success; exit `1` means configuration or operation failure; the publisher hook
  also returns `0` when the Observer is unavailable.

## Examples

```powershell
npx wendkeep observer register --project C:\GitHub\WendKeep --vault C:\GitHub\WendKeep\.WendKeep-vault --data-dir C:\WendKeepObserver
npx wendkeep observer serve --host 127.0.0.1 --port 8787 --data-dir C:\WendKeepObserver
$env:WENDKEEP_OBSERVER_URL = 'http://127.0.0.1:8787'
```

For local Docker:

```powershell
docker compose -f docker/wendkeep-observer/compose.yaml up -d --build
```

## Local web dashboard

With the server running, open [http://127.0.0.1:8787/](http://127.0.0.1:8787/) in a browser. The
dashboard is served by the same process and opens directly, without a form or token. Keep the port
bound to the computer loopback; do not expose this address on a network interface.

The dashboard shows the multi-project list, version, health, latest session, active change, change
count, and last capture time. Opening a project exposes Overview, Consumption, Sessions, Memory,
Changes, and Sync screens. Consumption shows total cost, token categories, primary agents,
subagents, providers, models, daily trend, historical coverage, and calls with prompt, response,
and complete transcript. Loading, empty, unavailable-server, conflict, no-pricing, and stale-data
states are visible, with manual refresh and an automatic 15-second refresh.

If the browser shows the shell but the list fails, check the service health at
`http://127.0.0.1:8787/healthz` and confirm that the container is running.

## Expected result

`register` stores `project_id`, name, version, and registration time. `publish` reads the local
vault, produces the snapshot, and sends idempotent events to SQLite containing the complete content
of sessions, decisions, bugs, learnings, specs, changes, CORE, DIGEST, SHARED_MEMORY, brain state,
agent sessions, cost rollups, calls, and transcripts. The container stores everything in
`/data/observer.sqlite`; it does not mount `C:\GitHub` or any `.WendKeep-vault`. Markdown is only
the text held in SQL and is recreated as files only by an explicit read-only export.
`memory import` performs the initial load and returns file/hash parity. During migration, the
cost/token total recorded in frontmatter is preserved through an explicit reconciliation row when
the detailed ledger does not add up; that row does not invent calls. Historical sessions sharing
one `session_id` receive a canonical per-file identity so one rollup cannot overwrite the other.

`init` projects `observer-publish` into `SessionStart`, `Stop`, and `SubagentStop` after the primary
hooks. When the server is unavailable, it writes snapshots to `.brain/observer-outbox/` and SQL
events to `.brain/observer-sql-outbox/` without blocking the session; a later run retries the
batches. SQL batches use gzip so complete transcripts larger than 64 MB as plain JSON remain within
the transport limit; the Observer decompresses and validates the body before ingesting it. The
outbox is temporary transport, not authority.

## Common errors and diagnosis

- `project_not_registered`: run `observer register` before publishing.
- `host loopback`: replace `0.0.0.0` or a LAN address with `127.0.0.1`.
- Pending outbox: the service was unavailable; preserve `.brain/observer-outbox/` and
  `.brain/observer-sql-outbox/`, then rerun the publisher. Do not delete events manually.
- If memory or usage is incomplete, check the Sync screen, preserve the outbox, and run
  `observer memory import` to rebuild the load from the vault.

## Next steps

Read the `local-observer` change for the `OBS-1` through `OBS-8` contract. Do not remove the Docker
volume with `docker compose down -v` during normal operation because it deletes the local
projection.

## Data authority

The container SQLite database is canonical for Observer queries and stores the complete published
content. The vault and any legacy `/data/memory` remain preserved during migration as a transition
and recovery copy; hooks do not update container Markdown after cutover. Observer screens do not
complete, archive, repair, or promote state.

## Minimal API

- `GET /healthz` — availability, SQLite migration version, and legacy migration state.
- `GET /v1/projects` — projects registered in SQLite, with a snapshot when available.
- `GET /v1/projects/:project_id` — the latest project snapshot.
- `GET /v1/projects/:project_id/changes` — change summary from the snapshot.
- `PUT /v1/projects/:project_id` — explicit local registration.
- `POST /v1/projects/:project_id/snapshot` — idempotent local ingestion.
- `POST /v1/projects/:project_id/ingest` — idempotent batches of documents, sessions, agents,
  rollups, calls, and transcripts.
- `GET /v1/projects/:project_id/memory/tree` — document tree and metadata.
- `GET /v1/projects/:project_id/memory/document?path=...` — complete Markdown content.
- `GET /v1/projects/:project_id/memory/search?q=...` — path and body search.
- `GET /v1/projects/:project_id/sync` — mode, counts, conflicts, and latest event.
- `PUT /v1/projects/:project_id/sync` — compatibility configuration; SQL remains authoritative.
- `GET /v1/projects/:project_id/memory/export` — read-only export with complete content.
- `POST /v1/projects/:project_id/memory/events` — idempotent batch ingestion.
- `GET /v1/projects/:project_id/usage/summary` — filterable totals by period, change, session,
  agent, provider, model, and role.
- `GET /v1/projects/:project_id/usage/breakdown` — agent, subagent, and model hierarchy.
- `GET /v1/projects/:project_id/usage/calls` — individual calls with prompt and response.
- `GET /v1/projects/:project_id/transcripts/:transcript_id` — compressed transcript validated by hash.

The `/v1` routes reject transported or expanded bodies above their limits and validate project,
path, revision, hash, idempotency, and isolation before writing to SQLite. Use `memory/export` for
a Markdown copy; it does not alter SQL authority.
