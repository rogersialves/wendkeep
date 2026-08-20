import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { readObserverIndexSource } from './observer-store.mjs';
import { buildProjectSnapshot } from './observer-snapshot.mjs';
import { compareMemoryParity } from './observer-memory-publish.mjs';
import { publishObserverSql } from './observer-sql-publish.mjs';
import { migrateObserverData } from './observer-sql-migrate.mjs';
import { startObserverServer } from './observer-server.mjs';
import { ensureObserverDatabase, migrateObserverDatabase, listSqlProjects, registerSqlProject, upsertSqlProjectSnapshot, OBSERVER_SQL_FILE, OBSERVER_SQL_SCHEMA_VERSION } from './observer-sql-store.mjs';
import { resolveProjectVault } from '../packages/vault/src/project-vault.mjs';
import { observerAuthHeaders, resolveObserverToken } from './observer-auth.mjs';

export const OBSERVER_HELP = `wendkeep observer — Observer local multi-projeto

Uso:
  wendkeep observer serve [--data-dir P] [--host 127.0.0.1] [--port 8787]
                          [--allow-non-loopback] [--token TOKEN]
  wendkeep observer register --project P [--vault V] [--data-dir D] [--json]
  wendkeep observer publish --project P [--vault V] [--data-dir D] [--json]
  wendkeep observer reconcile --project P [--vault V] [--data-dir D] [--url U]
                              [--capture-level metadata|messages|full-transcript] [--json]
  wendkeep observer memory import --project P [--vault V] [--url U] [--token TOKEN]
                                    [--capture-level metadata|messages|full-transcript] [--json]
  wendkeep observer status [--data-dir D] [--json]

O Observer local pode manter snapshots operacionais e uma cópia completa da memória em volume
Docker. O comando memory import faz a primeira migração de um vault para o container.
Hooks apenas enfileiram/drenam alterações incrementais; reconcile é a varredura integral explícita.
`;

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || '';
  return argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function dataDir(argv) {
  return resolve(optionValue(argv, '--data-dir')
    || process.env.WENDKEEP_OBSERVER_DATA_DIR
    || `${homedir()}/.wendkeep-observer`);
}

function projectRoot(argv) {
  const value = optionValue(argv, '--project') || process.cwd();
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

function vaultBase(argv, root) {
  const explicit = optionValue(argv, '--vault');
  if (explicit) return isAbsolute(explicit) ? resolve(explicit) : resolve(root, explicit);
  return resolveProjectVault({ startDir: root }).base;
}

function print(value, asJson, write = (chunk) => process.stdout.write(chunk)) {
  write((asJson ? JSON.stringify(value, null, 2) : String(value)) + '\n');
}

function summary(index) {
  return {
    schema_version: index.schema_version,
    projects: index.projects.map(({ snapshot, ...item }) => item),
  };
}

function databaseSummary(dir) {
  const db = ensureObserverDatabase(dir);
  try {
    const migrations = migrateObserverDatabase(db);
    return {
      engine: 'sqlite',
      file: OBSERVER_SQL_FILE,
      schema_version: OBSERVER_SQL_SCHEMA_VERSION,
      migrations: migrations.applied.length,
      projects: listSqlProjects(db).length,
      ready: true,
    };
  } finally { db.close(); }
}

function sqlProjectsSummary(dir) {
  const db = ensureObserverDatabase(dir);
  try {
    return listSqlProjects(db).map((project) => ({
      projectId: project.project_id,
      projectName: project.project_name,
      wendkeepVersion: project.wendkeep_version,
      updatedAt: project.updated_at,
      authority: 'sqlite',
    }));
  } finally { db.close(); }
}

export async function runObserver(argv = [], { write = (chunk) => process.stdout.write(chunk) } = {}) {
  const [sub] = argv;
  const asJson = argv.includes('--json');
  if (!sub || sub === 'help') {
    process.stdout.write(OBSERVER_HELP);
    return 0;
  }
  const dir = dataDir(argv);
  const token = resolveObserverToken(optionValue(argv, '--token'));

  if (sub === 'status') {
    const legacy = summary(readObserverIndexSource(dir));
    print({ ...legacy, projects: sqlProjectsSummary(dir), legacy_projects: legacy.projects, database: databaseSummary(dir) }, asJson, write);
    return 0;
  }

  if (sub === 'serve') {
    const host = optionValue(argv, '--host') || '127.0.0.1';
    const server = await startObserverServer({
      dataDir: dir,
      host,
      port: Number(optionValue(argv, '--port') || 8787),
      allowNonLoopback: argv.includes('--allow-non-loopback'),
      token,
    });
    const address = server.address();
    process.stdout.write(`wendkeep observer listening: http://${address.address}:${address.port}\n`);
    return 0;
  }

  if (sub === 'memory') {
    const action = argv[1] || '';
    if (action !== 'import') throw new Error('observer memory: use memory import.');
    const root = projectRoot(argv);
    const vault = vaultBase(argv, root);
    const snapshot = buildProjectSnapshot({ vaultBase: vault, projectRoot: root });
    const url = optionValue(argv, '--url') || process.env.WENDKEEP_OBSERVER_URL || '';
    if (!url) throw new Error('observer memory import: --url ou WENDKEEP_OBSERVER_URL é obrigatório.');
    const headers = observerAuthHeaders(token, { 'content-type': 'application/json', accept: 'application/json' });
    const registration = await fetch(
      String(url).replace(/\/$/, '') + '/v1/projects/' + encodeURIComponent(snapshot.project_id),
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          project_id: snapshot.project_id,
          project_name: snapshot.project_name,
          wendkeep_version: snapshot.wendkeep_version,
        }),
      },
    );
    if (!registration.ok) throw new Error('Observer não registrou o projeto: HTTP ' + registration.status + '.');
    const sql = await publishObserverSql({
      vaultBase: vault,
      projectId: snapshot.project_id,
      url,
      token,
      forceFull: true,
      captureLevel: optionValue(argv, '--capture-level') || process.env.WENDKEEP_OBSERVER_CAPTURE_LEVEL || 'metadata',
    });
    const snapshotResponse = await fetch(`${String(url).replace(/\/$/, '')}/v1/projects/${encodeURIComponent(snapshot.project_id)}/snapshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify(snapshot),
    });
    if (!snapshotResponse.ok) throw new Error(`Observer não importou o snapshot: HTTP ${snapshotResponse.status}.`);
    const parity = await compareMemoryParity({
      vaultBase: vault,
      projectId: snapshot.project_id,
      url,
      token,
    });
    const result = {
      ok: sql.ok && parity.missing === 0 && parity.mismatched === 0,
      project_id: snapshot.project_id,
      sql,
      memory: { ...sql, authority: 'sqlite' },
      parity,
    };
    print(result, asJson, write);
    return result.ok ? 0 : 1;
  }

  if (sub === 'reconcile') {
    const root = projectRoot(argv);
    const vault = vaultBase(argv, root);
    const snapshot = buildProjectSnapshot({ vaultBase: vault, projectRoot: root });
    const url = optionValue(argv, '--url') || process.env.WENDKEEP_OBSERVER_URL || '';
    if (!url) {
      const db = ensureObserverDatabase(dir);
      let migration;
      try {
        migration = migrateObserverData({
          dataDir: dir,
          vaultBase: vault,
          projectId: snapshot.project_id,
          projectName: snapshot.project_name,
          database: db,
        });
        upsertSqlProjectSnapshot(db, snapshot);
      } finally { db.close(); }
      const result = { ok: migration.rejected === 0 && migration.conflicts === 0, project_id: snapshot.project_id, mode: 'local-sqlite', migration };
      print(result, asJson, write);
      return result.ok ? 0 : 1;
    }
    const registration = await fetch(`${String(url).replace(/\/$/, '')}/v1/projects/${encodeURIComponent(snapshot.project_id)}`, {
      method: 'PUT',
      headers: observerAuthHeaders(token, { 'content-type': 'application/json', accept: 'application/json' }),
      body: JSON.stringify({
        project_id: snapshot.project_id,
        project_name: snapshot.project_name,
        wendkeep_version: snapshot.wendkeep_version,
      }),
    });
    if (!registration.ok) throw new Error(`Observer não registrou o projeto: HTTP ${registration.status}.`);
    const sql = await publishObserverSql({
      vaultBase: vault,
      projectId: snapshot.project_id,
      url,
      token,
      forceFull: true,
      captureLevel: optionValue(argv, '--capture-level') || process.env.WENDKEEP_OBSERVER_CAPTURE_LEVEL || 'metadata',
    });
    const snapshotResponse = await fetch(`${String(url).replace(/\/$/, '')}/v1/projects/${encodeURIComponent(snapshot.project_id)}/snapshot`, {
      method: 'POST',
      headers: observerAuthHeaders(token, { 'content-type': 'application/json', accept: 'application/json' }),
      body: JSON.stringify(snapshot),
    });
    if (!snapshotResponse.ok) throw new Error(`Observer não reconciliou o snapshot: HTTP ${snapshotResponse.status}.`);
    const parity = await compareMemoryParity({ vaultBase: vault, projectId: snapshot.project_id, url, token });
    const result = { ok: sql.ok && parity.missing === 0 && parity.mismatched === 0, project_id: snapshot.project_id, mode: 'remote-sqlite', sql, parity };
    print(result, asJson, write);
    return result.ok ? 0 : 1;
  }

  if (!['register', 'publish'].includes(sub)) throw new Error('observer: subcomando desconhecido: ' + sub);
  const root = projectRoot(argv);
  const vault = vaultBase(argv, root);
  const snapshot = buildProjectSnapshot({ vaultBase: vault, projectRoot: root });

  if (sub === 'register') {
    const db = ensureObserverDatabase(dir);
    let sql;
    try {
      sql = registerSqlProject(db, {
        projectId: snapshot.project_id,
        projectName: snapshot.project_name,
        wendkeepVersion: snapshot.wendkeep_version,
      });
    } finally { db.close(); }
    if (!sql.registered) throw new Error(sql.errors.join(' '));
    print({ ...sql, authority: 'sqlite' }, asJson, write);
    return 0;
  }

  const db = ensureObserverDatabase(dir);
  let migration;
  try {
    migration = migrateObserverData({
      dataDir: dir,
      vaultBase: vault,
      projectId: snapshot.project_id,
      projectName: snapshot.project_name,
      database: db,
    });
    upsertSqlProjectSnapshot(db, snapshot);
  } finally { db.close(); }
  const result = { ok: migration.rejected === 0 && migration.conflicts === 0, authority: 'sqlite', migration };
  print(result, asJson, write);
  return result.ok ? 0 : 1;
}
