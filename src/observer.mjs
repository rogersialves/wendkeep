import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { readObserverIndexSource } from './observer-store.mjs';
import { buildProjectSnapshot } from './observer-snapshot.mjs';
import { compareMemoryParity } from './observer-memory-publish.mjs';
import { publishObserverSql } from './observer-sql-publish.mjs';
import { migrateObserverData } from './observer-sql-migrate.mjs';
import { startObserverServer } from './observer-server.mjs';
import { ensureObserverDatabase, listSqlProjects, readSqlProject, registerSqlProject, upsertSqlProjectSnapshot, OBSERVER_SQL_FILE, OBSERVER_SQL_SCHEMA_VERSION } from './observer-sql-store.mjs';
import { resolveProjectVault } from '../packages/vault/src/project-vault.mjs';
import { observerAuthHeaders, resolveObserverToken } from './observer-auth.mjs';
import { recordObserverAudit } from '../packages/observer/src/authz.mjs';
import { readObserverPolicy, saveObserverPolicy } from '../packages/observer/src/policy.mjs';
import { purgeObserverData } from '../packages/observer/src/purge.mjs';
import { runObserverRetention } from '../packages/observer/src/retention.mjs';
import { registerObserverToken, revokeObserverToken, rotateObserverToken } from '../packages/observer/src/token-registry.mjs';
import { observerEncryptionFromEnvironment } from '../packages/observer/src/encryption.mjs';

export const OBSERVER_HELP = `wendkeep observer — Observer local multi-projeto

Uso:
  wendkeep observer serve [--data-dir P] [--host 127.0.0.1] [--port 8787]
                          [--allow-non-loopback] [--require-loopback-auth] [--require-encryption] [--token TOKEN]
                          [--bootstrap-token-id ID] [--bootstrap-role ROLE]
                          [--bootstrap-projects P1,P2] [--bootstrap-scopes S1,S2] --bootstrap-expires-at ISO
  wendkeep observer register --project P [--vault V] [--data-dir D] [--json]
  wendkeep observer publish --project P [--vault V] [--data-dir D] [--json]
  wendkeep observer reconcile --project P [--vault V] [--data-dir D] [--url U]
                              [--capture-level metadata|messages|full-transcript] [--json]
  wendkeep observer memory import --project P [--vault V] [--url U] [--token TOKEN]
                                    [--capture-level metadata|messages|full-transcript] [--json]
  wendkeep observer status [--data-dir D] [--json]
  wendkeep observer security token create --project-id P --role R --scopes S
                          --token-env ENV --expires-at ISO [--token-id ID] [--reason TEXT] [--json]
  wendkeep observer security token rotate --project-id P --token-id ID --token-env ENV
                          --expires-at ISO [--new-token-id ID] [--reason TEXT] [--json]
  wendkeep observer security token revoke --project-id P --token-id ID [--reason TEXT] [--json]
  wendkeep observer security policy set --project-id P --file policy.json [--json]
  wendkeep observer security purge --project-id P --before ISO --classes C [--dry-run] [--operation-id ID] [--json]
  wendkeep observer security retention run --project-id P [--dry-run] [--operation-id ID] [--observed-at ISO] [--json]

O Observer local pode manter snapshots operacionais e uma cópia completa da memória em volume
Docker. O comando memory import faz a primeira migração de um vault para o container.
Hooks apenas enfileiram/drenam alterações incrementais; reconcile é a varredura integral explícita.
`;

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || '';
  return argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
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

function databaseSummary(dir, security) {
  const db = ensureObserverDatabase(dir, { security });
  try {
    return {
      engine: 'sqlite',
      file: OBSERVER_SQL_FILE,
      schema_version: OBSERVER_SQL_SCHEMA_VERSION,
      migrations: Number(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count),
      projects: listSqlProjects(db).length,
      ready: true,
    };
  } finally { db.close(); }
}

function sqlProjectsSummary(dir, security) {
  const db = ensureObserverDatabase(dir, { security });
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
  const databaseSecurity = {
    encryption: observerEncryptionFromEnvironment({
      required: argv.includes('--require-encryption') || process.env.WENDKEEP_OBSERVER_REQUIRE_ENCRYPTION === '1',
    }),
  };

  if (sub === 'security') {
    const domain = argv[1] || '';
    const action = argv[2] || '';
    const projectId = optionValue(argv, '--project-id');
    if (!projectId) throw new Error('observer security: --project-id é obrigatório.');
    const db = ensureObserverDatabase(dir, { security: databaseSecurity });
    try {
      readSqlProject(db, projectId);
      if (domain === 'token' && action === 'create') {
        const envName = optionValue(argv, '--token-env');
        const rawToken = envName ? String(process.env[envName] || '') : '';
        if (!envName || !rawToken) throw new Error('observer security token create: --token-env deve apontar para um segredo não vazio.');
        const created = registerObserverToken(db, {
          tokenId: optionValue(argv, '--token-id') || randomBytes(12).toString('hex'),
          token: rawToken,
          role: optionValue(argv, '--role'),
          projectIds: [projectId],
          scopes: optionValue(argv, '--scopes').split(',').map((item) => item.trim()).filter(Boolean),
          expiresAt: optionValue(argv, '--expires-at'),
        });
        recordObserverAudit(db, {
          projectId, tokenId: created.token_id, capability: 'security:recovery', outcome: 'created',
          metadata: { route: 'offline-cli', method: 'LOCAL', reason: optionValue(argv, '--reason') || 'token create' },
        });
        print(created, asJson, write);
        return 0;
      }
      if (domain === 'token' && action === 'revoke') {
        const tokenId = optionValue(argv, '--token-id');
        const revoked = revokeObserverToken(db, { tokenId });
        recordObserverAudit(db, {
          projectId, tokenId, capability: 'security:recovery', outcome: revoked.revoked ? 'revoked' : 'not-found',
          metadata: { route: 'offline-cli', method: 'LOCAL', reason: optionValue(argv, '--reason') || 'token revoke' },
        });
        print(revoked, asJson, write);
        return revoked.revoked ? 0 : 1;
      }
      if (domain === 'token' && action === 'rotate') {
        const envName = optionValue(argv, '--token-env');
        const rawToken = envName ? String(process.env[envName] || '') : '';
        if (!envName || !rawToken) throw new Error('observer security token rotate: --token-env deve apontar para um segredo não vazio.');
        const rotated = rotateObserverToken(db, {
          tokenId: optionValue(argv, '--token-id'),
          newTokenId: optionValue(argv, '--new-token-id') || randomBytes(12).toString('hex'),
          newToken: rawToken,
          expiresAt: optionValue(argv, '--expires-at'),
        });
        recordObserverAudit(db, {
          projectId, tokenId: rotated.token_id, capability: 'security:recovery', outcome: 'rotated',
          metadata: { route: 'offline-cli', method: 'LOCAL', reason: optionValue(argv, '--reason') || 'token rotate' },
        });
        print(rotated, asJson, write);
        return 0;
      }
      if (domain === 'policy' && action === 'set') {
        const path = optionValue(argv, '--file');
        if (!path) throw new Error('observer security policy set: --file é obrigatório.');
        const policy = saveObserverPolicy(db, projectId, JSON.parse(readFileSync(resolve(path), 'utf8')));
        print({ schema_version: 1, project_id: projectId, policy }, asJson, write);
        return 0;
      }
      if (domain === 'policy' && action === 'show') {
        print({ schema_version: 1, project_id: projectId, policy: readObserverPolicy(db, projectId) }, asJson, write);
        return 0;
      }
      if (domain === 'purge') {
        const result = purgeObserverData(db, {
          projectId,
          before: optionValue(argv, '--before'),
          classes: optionValue(argv, '--classes').split(',').map((item) => item.trim()).filter(Boolean),
          operationId: optionValue(argv, '--operation-id'),
          dryRun: argv.includes('--dry-run'),
        });
        print(result, asJson, write);
        return 0;
      }
      if (domain === 'retention' && action === 'run') {
        const policy = readObserverPolicy(db, projectId);
        const observedAt = optionValue(argv, '--observed-at');
        const result = runObserverRetention(db, {
          projectId,
          policy: policy.retention,
          clock: () => observedAt ? new Date(observedAt) : new Date(),
          operationId: optionValue(argv, '--operation-id'),
          dryRun: argv.includes('--dry-run'),
        });
        print(result, asJson, write);
        return 0;
      }
      throw new Error(`observer security: operação desconhecida: ${domain} ${action}`.trim());
    } finally { db.close(); }
  }

  if (sub === 'status') {
    const legacy = summary(readObserverIndexSource(dir));
    print({ ...legacy, projects: sqlProjectsSummary(dir, databaseSecurity), legacy_projects: legacy.projects, database: databaseSummary(dir, databaseSecurity) }, asJson, write);
    return 0;
  }

  if (sub === 'serve') {
    const host = optionValue(argv, '--host') || '127.0.0.1';
    const encryption = databaseSecurity.encryption;
    const secureMode = argv.includes('--require-loopback-auth') || Boolean(encryption);
    const server = await startObserverServer({
      dataDir: dir,
      host,
      port: Number(optionValue(argv, '--port') || 8787),
      allowNonLoopback: argv.includes('--allow-non-loopback'),
      token,
      bootstrap: {
        tokenId: optionValue(argv, '--bootstrap-token-id') || process.env.WENDKEEP_OBSERVER_BOOTSTRAP_TOKEN_ID || '',
        role: optionValue(argv, '--bootstrap-role') || process.env.WENDKEEP_OBSERVER_BOOTSTRAP_ROLE || 'admin',
        projectIds: csv(optionValue(argv, '--bootstrap-projects') || process.env.WENDKEEP_OBSERVER_BOOTSTRAP_PROJECTS),
        scopes: csv(optionValue(argv, '--bootstrap-scopes') || process.env.WENDKEEP_OBSERVER_BOOTSTRAP_SCOPES || '*'),
        expiresAt: optionValue(argv, '--bootstrap-expires-at') || process.env.WENDKEEP_OBSERVER_BOOTSTRAP_EXPIRES_AT || '',
      },
      security: {
        enabled: secureMode,
        requireLoopbackAuth: argv.includes('--require-loopback-auth'),
        encryption,
      },
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
      const db = ensureObserverDatabase(dir, { security: databaseSecurity });
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
    const db = ensureObserverDatabase(dir, { security: databaseSecurity });
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

  const db = ensureObserverDatabase(dir, { security: databaseSecurity });
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
