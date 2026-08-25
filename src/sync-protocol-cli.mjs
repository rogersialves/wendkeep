import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { resolveProjectVault } from './project-vault.mjs';
import { importPortableState } from './portable.mjs';
import {
  createFilesystemSyncAdapter, createHttpSyncAdapter, pullSyncEvents, pushSyncEvents,
} from './sync-adapters.mjs';
import {
  applySyncEvent, canonicalRecordKey, createSyncEvent, syncSha256,
} from './sync-protocol.mjs';
import {
  ackSyncEvent, enqueueSyncEvent, inspectSyncOutbox, readLocalSyncState,
  readPendingSyncEvents, readSyncCursor, writeLocalSyncState, writeSyncCursor,
} from './sync-outbox.mjs';

const SUBCOMMANDS = new Set(['status', 'push', 'pull', 'conflicts', 'resolve']);

function cliError(code, message) {
  return Object.assign(new Error(message), { code });
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || '';
  return argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function requiredOption(argv, name) {
  const value = option(argv, name);
  if (!value || value.startsWith('--')) throw cliError('WENDKEEP_SYNC_ARGUMENT_REQUIRED', `${name} is required`);
  return value;
}

function readPortable(path) {
  if (!existsSync(path)) throw cliError('WENDKEEP_SYNC_PORTABLE_MISSING', `portable state not found: ${path}`);
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (state?.schema_version !== 1 || state?.kind !== 'wendkeep-portable-state'
      || !Array.isArray(state.artifacts) || !Array.isArray(state.active_work)
      || !state.project_id || !state.repository_id || !state.authored_sha256) throw new Error('schema mismatch');
    return state;
  } catch (error) {
    throw cliError('WENDKEEP_SYNC_PORTABLE_INVALID', `portable state is invalid: ${error.message}`);
  }
}

function branchForArtifact(state, path) {
  const match = String(path).match(/^08-(?:Mudanças|Changes)\/([^/]+)\//);
  if (!match) return '';
  return state.active_work.find((item) => item.change_slug === match[1])?.branch || '';
}

function desiredRecords(state) {
  const records = [{
    namespace: 'portable-manifest', key: 'state', scope: 'project', branch: '',
    payload: {
      kind: 'manifest', project_id: state.project_id, repository_id: state.repository_id,
      authored_sha256: state.authored_sha256,
    },
  }];
  for (const artifact of state.artifacts) {
    const branch = branchForArtifact(state, artifact.path);
    records.push({
      namespace: 'authored', key: artifact.path, scope: branch ? 'branch' : 'project', branch,
      payload: { kind: 'artifact', value: artifact },
    });
  }
  for (const activeWork of state.active_work) records.push({
    namespace: 'active-work', key: activeWork.active_work_id, scope: 'branch', branch: activeWork.branch,
    payload: { kind: 'active-work', value: activeWork },
  });
  return records;
}

export function portableStateToSyncEvents(state, localState, {
  actorId, deviceId, observedAt = new Date().toISOString(),
} = {}) {
  const events = [];
  for (const desired of desiredRecords(state)) {
    const recordKey = canonicalRecordKey({
      projectId: state.project_id,
      repositoryId: state.repository_id,
      namespace: desired.namespace,
      key: desired.key,
      branch: desired.branch,
      scope: desired.scope,
    });
    const current = localState.records[recordKey];
    if (current?.content_hash === syncSha256(desired.payload) && !current.tombstone) continue;
    const baseRevision = Number(current?.revision || 0);
    events.push(createSyncEvent({
      projectId: state.project_id,
      recordKey,
      revision: baseRevision + 1,
      baseRevision,
      payload: desired.payload,
      causalParentIds: current?.event_id ? [current.event_id] : [],
      actorId,
      deviceId,
      observedAt,
      operation: 'put',
    }));
  }
  return events;
}

export function syncStateToPortableState(state) {
  const open = Object.values(state.conflicts || {}).filter((item) => item.status === 'open');
  if (open.length) throw cliError('WENDKEEP_SYNC_CONFLICT_OPEN', `${open.length} conflict(s) require explicit resolution`);
  let manifest = null;
  const artifacts = [];
  const active_work = [];
  for (const record of Object.values(state.records || {})) {
    if (record.tombstone || record.conflicted) continue;
    if (record.payload?.kind === 'manifest') manifest = record.payload;
    else if (record.payload?.kind === 'artifact') artifacts.push(record.payload.value);
    else if (record.payload?.kind === 'active-work') active_work.push(record.payload.value);
  }
  if (!manifest) throw cliError('WENDKEEP_SYNC_MANIFEST_MISSING', 'remote state has no portable manifest');
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  active_work.sort((left, right) => left.active_work_id.localeCompare(right.active_work_id));
  return {
    schema_version: 1,
    kind: 'wendkeep-portable-state',
    project_id: manifest.project_id,
    repository_id: manifest.repository_id,
    authored_sha256: manifest.authored_sha256,
    artifacts,
    active_work,
  };
}

function adapterFrom(argv, projectRoot) {
  const remote = option(argv, '--remote');
  const url = option(argv, '--url');
  if (remote && url) throw cliError('WENDKEEP_SYNC_BACKEND_AMBIGUOUS', 'choose --remote or --url');
  if (remote) {
    const path = isAbsolute(remote) ? resolve(remote) : resolve(projectRoot, remote);
    return createFilesystemSyncAdapter(path);
  }
  if (url) {
    const tokenEnv = option(argv, '--token-env');
    const token = tokenEnv ? process.env[tokenEnv] : '';
    return createHttpSyncAdapter({
      url,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
  }
  throw cliError('WENDKEEP_SYNC_BACKEND_REQUIRED', '--remote <path> or --url <https-url> is required');
}

function runtime(argv) {
  const projectRoot = resolve(option(argv, '--project') || process.cwd());
  const vaultBase = resolveProjectVault({
    startDir: projectRoot,
    explicitVault: option(argv, '--vault'),
    validateIdentity: !option(argv, '--vault'),
  }).base;
  let projectId;
  try { projectId = JSON.parse(readFileSync(join(vaultBase, '.brain', 'PROJECT.json'), 'utf8')).projectId; }
  catch { throw cliError('WENDKEEP_SYNC_IDENTITY_UNAVAILABLE', 'PROJECT.json is unavailable'); }
  return { projectRoot, vaultBase, projectId };
}

function openConflicts(state) {
  return Object.values(state.conflicts || {}).filter((item) => item.status === 'open');
}

export const SYNC_PROTOCOL_HELP = `wendkeep sync <status|push|pull|conflicts|resolve> [options]

  --remote <path>       filesystem backend (reference/local testing)
  --url <https-url>     HTTP backend
  --token-env <name>    read HTTP bearer token from an environment variable
  --actor <id>          audited actor for push/resolve
  --device <id>         audited device for push/resolve
  --input <path>        portable state (default: .wendkeep/portable/state.json)
  --select <event-id>   conflict candidate selected by resolve
  --record <key>        canonical conflict record key
  --reason <text>       audited resolution reason
  --no-import           pull protocol state without importing authored files
  --json                structured result
`;

export function isSyncProtocolCommand(argv = []) {
  return SUBCOMMANDS.has(argv[0]);
}

export async function runSyncProtocol(argv = []) {
  const sub = argv[0];
  const json = argv.includes('--json');
  try {
    if (!SUBCOMMANDS.has(sub)) throw cliError('WENDKEEP_SYNC_SUBCOMMAND_INVALID', 'unknown sync protocol subcommand');
    const { projectRoot, vaultBase, projectId } = runtime(argv);
    let localState = readLocalSyncState(vaultBase, projectId);
    let result;
    if (sub === 'status') {
      const outbox = inspectSyncOutbox(vaultBase);
      result = { ok: true, enabled: outbox.status !== 'disabled', outbox, conflicts: openConflicts(localState).length };
    } else if (sub === 'conflicts') {
      result = { ok: true, conflicts: openConflicts(localState) };
    } else if (sub === 'push') {
      if (openConflicts(localState).length) {
        throw cliError('WENDKEEP_SYNC_CONFLICT_OPEN', 'resolve local conflicts before pushing new revisions');
      }
      const adapter = adapterFrom(argv, projectRoot);
      const input = resolve(option(argv, '--input') || join(projectRoot, '.wendkeep', 'portable', 'state.json'));
      const portable = readPortable(input);
      if (portable.project_id !== projectId) throw cliError('WENDKEEP_SYNC_PROJECT_MISMATCH', 'portable state belongs to another project');
      const fresh = portableStateToSyncEvents(portable, localState, {
        actorId: requiredOption(argv, '--actor'), deviceId: requiredOption(argv, '--device'),
      });
      for (const item of fresh) enqueueSyncEvent(vaultBase, item);
      const pending = readPendingSyncEvents(vaultBase);
      const pushed = await pushSyncEvents({
        adapter, events: pending,
        onAcknowledged: async (item) => { ackSyncEvent(vaultBase, item.event_id, { backend: adapter.id }); },
      });
      const cursor = readSyncCursor(vaultBase);
      const pulled = await pullSyncEvents({ adapter, cursor, projectId });
      if (pulled.state?.project_id && pulled.state.project_id !== projectId) {
        throw cliError('WENDKEEP_SYNC_PROJECT_MISMATCH', 'remote state belongs to another project');
      }
      if (pulled.state) localState = pulled.state;
      else for (const item of pulled.events || pending) applySyncEvent(localState, item);
      writeLocalSyncState(vaultBase, localState);
      writeSyncCursor(vaultBase, Number(pulled.cursor || cursor));
      result = {
        ok: true, generated: fresh.length, pushed: pushed.length, results: pushed,
        conflicts: openConflicts(localState).length,
      };
    } else if (sub === 'pull') {
      const adapter = adapterFrom(argv, projectRoot);
      const cursor = readSyncCursor(vaultBase);
      const pulled = await pullSyncEvents({ adapter, cursor, projectId });
      if (pulled.state?.project_id && pulled.state.project_id !== projectId) {
        throw cliError('WENDKEEP_SYNC_PROJECT_MISMATCH', 'remote state belongs to another project');
      }
      if (pulled.state) localState = pulled.state;
      else for (const item of pulled.events || []) applySyncEvent(localState, item);
      writeLocalSyncState(vaultBase, localState);
      writeSyncCursor(vaultBase, Number(pulled.cursor || cursor));
      let imported = null;
      if (!argv.includes('--no-import') && Object.keys(localState.records || {}).length) {
        imported = importPortableState({
          vaultBase, projectRoot, state: syncStateToPortableState(localState),
        });
      }
      result = { ok: true, received: (pulled.events || []).length, cursor: pulled.cursor, imported, conflicts: openConflicts(localState).length };
    } else {
      const adapter = adapterFrom(argv, projectRoot);
      const resolution = await adapter.resolve({
        projectId,
        recordKey: requiredOption(argv, '--record'),
        selectedEventId: requiredOption(argv, '--select'),
        actorId: requiredOption(argv, '--actor'),
        deviceId: requiredOption(argv, '--device'),
        reason: requiredOption(argv, '--reason'),
      });
      const pulled = await pullSyncEvents({ adapter, cursor: 0, projectId });
      if (pulled.state) writeLocalSyncState(vaultBase, pulled.state);
      writeSyncCursor(vaultBase, Number(pulled.cursor || 0));
      result = { ok: true, resolution: resolution.decision || resolution };
    }
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else if (sub === 'status') process.stdout.write(`sync protocol: ${result.enabled ? 'enabled' : 'disabled'} · pending ${result.outbox.pending} · conflicts ${result.conflicts}\n`);
    else if (sub === 'conflicts') process.stdout.write(`sync conflicts: ${result.conflicts.length}\n`);
    else if (sub === 'push') process.stdout.write(`sync push: ${result.pushed} event(s) acknowledged\n`);
    else if (sub === 'pull') process.stdout.write(`sync pull: ${result.received} event(s), ${result.conflicts} conflict(s)\n`);
    else process.stdout.write('sync conflict resolved\n');
    return 0;
  } catch (error) {
    const payload = { ok: false, code: error?.code || 'WENDKEEP_SYNC_FAILED', error: String(error?.message || error) };
    process.stderr.write(json ? `${JSON.stringify(payload)}\n` : `wendkeep sync: ${payload.code}: ${payload.error}\n`);
    return payload.code === 'WENDKEEP_SYNC_BACKEND_UNAVAILABLE' ? 1 : 2;
  }
}
