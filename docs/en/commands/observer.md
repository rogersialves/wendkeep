# Local Observer

**English** · [Português](../../pt-BR/commands/observer.md)

## Purpose

The Observer consolidates observability for multiple WendKeep projects in a local service without
copying or taking ownership of their vaults.

## When to use

Use it to query summarized changes, sessions, tasks, and health across projects through one local
projection while each vault remains authoritative.

## When not to use

Do not use the Observer to edit, complete, or archive changes, curate memory, store transcripts,
or replace local hooks. Do not expose it to the network in this version.

## Prerequisites

Initialize projects with WendKeep, explicitly register each project, and set a local token before
starting the HTTP server.

## Syntax

```bash
npx wendkeep observer status --data-dir <directory> --json
npx wendkeep observer register --project <project> --vault <vault> --data-dir <directory>
npx wendkeep observer publish --project <project> --vault <vault> --data-dir <directory>
npx wendkeep observer serve --host 127.0.0.1 --port 8787 --data-dir <directory>
```

## Options and exit codes

- `--data-dir` selects the local event and index directory; the default is
  `WENDKEEP_OBSERVER_DATA_DIR` or `~/.wendkeep-observer`.
- `--project` and `--vault` identify a project only for `register` and `publish`.
- `--host` accepts only `127.0.0.1`, `localhost`, or `::1`; other hosts are rejected before
  listening.
- `--token` or `WENDKEEP_OBSERVER_TOKEN` protects `/v1`; `GET /healthz` exposes no project data.
- Exit `0` means success; exit `1` means configuration or operation failure; the publisher hook
  also returns `0` when the Observer is unavailable.

## Examples

```powershell
$env:WENDKEEP_OBSERVER_TOKEN = '<local-token>'
npx wendkeep observer register --project C:\GitHub\WendKeep --vault C:\GitHub\WendKeep\.WendKeep-vault --data-dir C:\WendKeepObserver
npx wendkeep observer serve --host 127.0.0.1 --port 8787 --data-dir C:\WendKeepObserver
$env:WENDKEEP_OBSERVER_URL = 'http://127.0.0.1:8787'
```

For local Docker:

```powershell
$env:WENDKEEP_OBSERVER_TOKEN = '<local-token>'
docker compose -f docker/wendkeep-observer/compose.yaml up -d --build
```

## Expected result

`register` stores only `project_id`, name, version, and registration time. `publish` reads the
local vault, produces a sanitized snapshot, and sends an idempotent event. The container stores
only `EVENTS.jsonl` and `INDEX.json` in the `observer-data` volume; it does not mount `C:\GitHub`
or any `.WendKeep-vault`.

`init` projects `observer-publish` into `SessionStart` and `Stop` after the primary hooks. Without
`WENDKEEP_OBSERVER_URL`, the hook is a no-op. When the server is stopped, it writes to
`.brain/observer-outbox/` and does not block the session; a later run retries pending events.

## Common errors and diagnosis

- `project_not_registered`: run `observer register` before publishing.
- `unauthorized`: check `Authorization: Bearer <token>` and `WENDKEEP_OBSERVER_TOKEN`.
- `host loopback`: replace `0.0.0.0` or a LAN address with `127.0.0.1`.
- Pending outbox: the service was unavailable; preserve `.brain/observer-outbox/` and rerun the
  publisher. Do not delete events manually.
- The Observer does not read raw content, paths, transcripts, or memory; such rejections are
  expected and should be investigated at the snapshot source.

## Next steps

Read the `local-observer` change for the `OBS-1` through `OBS-8` contract. Do not remove the Docker
volume with `docker compose down -v` during normal operation because it deletes the local
projection.

## Data authority

Each project vault remains authoritative for sessions, changes, tasks, memory, and evidence. The
Observer is a read-only, rebuildable projection; its queries do not complete, archive, repair, or
promote state in a vault.

## Minimal API

- `GET /healthz` — availability without project data.
- `GET /v1/projects` — projects with an accepted snapshot.
- `GET /v1/projects/:project_id` — the latest project snapshot.
- `GET /v1/projects/:project_id/changes` — change summary from the snapshot.
- `PUT /v1/projects/:project_id` — authenticated explicit registration.
- `POST /v1/projects/:project_id/snapshot` — authenticated idempotent ingestion.

The `/v1` routes reject oversized bodies and never accept vault paths, transcripts, secrets, or raw
memory content.
