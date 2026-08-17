# Local Observer

**English** · [Português](../../pt-BR/commands/observer.md)

## Purpose

The Observer consolidates observability for multiple WendKeep projects in a local service and
stores a complete copy of the memory published by hooks in the Docker volume. The content can be
browsed and searched in the container without depending on Obsidian for queries.

## When to use

Use it to query changes, sessions, decisions, bugs, learnings, specs, brain documents, and health
across projects through one local memory. During the transition, the vault is preserved as a
recovery copy; the Observer is authoritative for queries made through its container.

## When not to use

Do not use the Observer to edit, complete, or archive changes, curate memory, store transcripts,
or expose the service to the network. Edits still go through local WendKeep hooks.

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
count, and last capture time. Opening a project exposes Overview, Sessions, Memory, Changes, and
Sync screens. Each list opens the complete Markdown document in a read-only reader, with local
filtering, body search, and a source toggle. Loading, empty, unavailable-server, conflict, and
stale-data states are visible, with manual refresh and an automatic 15-second refresh.

If the browser shows the shell but the list fails, check the service health at
`http://127.0.0.1:8787/healthz` and confirm that the container is running.

## Expected result

`register` stores `project_id`, name, version, and registration time. `publish` reads the local
vault, produces the snapshot, and also sends idempotent events containing the complete content of
sessions, decisions, bugs, learnings, specs, changes, CORE, DIGEST, SHARED_MEMORY, and brain
state. The container stores Markdown under `/data/memory` plus `MEMORY_EVENTS.jsonl` and
`MEMORY_INDEX.json` in the `observer-data` volume; it does not mount `C:\GitHub` or any
`.WendKeep-vault`. `memory import` performs the initial load and returns file/hash parity.

`init` projects `observer-publish` into `SessionStart` and `Stop` after the primary hooks. Without
`WENDKEEP_OBSERVER_URL`, the hook is a no-op. When the server is stopped, it writes snapshots to
`.brain/observer-outbox/` and complete memory to `.brain/observer-memory-outbox/` without blocking
the session; a later run retries both event types.

## Common errors and diagnosis

- `project_not_registered`: run `observer register` before publishing.
- `host loopback`: replace `0.0.0.0` or a LAN address with `127.0.0.1`.
- Pending outbox: the service was unavailable; preserve `.brain/observer-outbox/` and rerun the
  publisher. Do not delete events manually.
- If memory is incomplete, check the Sync screen, preserve the outbox, and run
  `observer memory import` to rebuild the copy from the vault.

## Next steps

Read the `local-observer` change for the `OBS-1` through `OBS-8` contract. Do not remove the Docker
volume with `docker compose down -v` during normal operation because it deletes the local
projection.

## Data authority

The container is canonical for Observer queries and stores the complete published content. The
vault remains preserved locally during migration as a transition and recovery copy; Observer
screens do not complete, archive, repair, or promote state.

## Minimal API

- `GET /healthz` — availability without project data.
- `GET /v1/projects` — projects with an accepted snapshot.
- `GET /v1/projects/:project_id` — the latest project snapshot.
- `GET /v1/projects/:project_id/changes` — change summary from the snapshot.
- `PUT /v1/projects/:project_id` — explicit local registration.
- `POST /v1/projects/:project_id/snapshot` — idempotent local ingestion.
- `GET /v1/projects/:project_id/memory/tree` — document tree and metadata.
- `GET /v1/projects/:project_id/memory/document?path=...` — complete Markdown content.
- `GET /v1/projects/:project_id/memory/search?q=...` — path and body search.
- `GET /v1/projects/:project_id/sync` — mode, counts, conflicts, and latest event.
- `PUT /v1/projects/:project_id/sync` — explicitly changes the local mode.
- `GET /v1/projects/:project_id/memory/export` — read-only export with complete content.
- `POST /v1/projects/:project_id/memory/events` — idempotent batch ingestion.

The `/v1` routes reject oversized bodies and validate project, path, revision, hash, and
isolation before writing content to the volume.
