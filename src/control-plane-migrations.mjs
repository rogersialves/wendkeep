import {
  copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import {
  createNativeControlPlaneMigrationHarness,
  migrateActiveContextRegistryState,
  nativeControlPlaneVersion,
} from '../packages/migrations/src/index.mjs';
import { parseSharedMemory, validateSharedMemory } from '../packages/vault/src/memory-schema.mjs';
import { validateMemoryBundle } from '../packages/vault/src/validate-memory.mjs';
import { createFileReceiptStore, readReceiptLedger } from '../packages/evidence/src/receipt-ledger.mjs';
import { memoryStatus, migrateMemory } from './memory.mjs';
import { upgradePortableState } from './portable.mjs';
import { mutateSessionRegistry, readSessionRegistry } from '../hooks/obsidian-common.mjs';
import {
  OBSERVER_SQL_FILE,
  migrateObserverDatabase,
  openObserverDatabase,
} from './observer-sql-store.mjs';

const compositionError = (code, message, cause) => Object.assign(new Error(message, { cause }), { code });

function vaultVersion(vaultBase) {
  const sharedPath = join(resolve(vaultBase), '.brain', 'SHARED_MEMORY.md');
  if (!existsSync(sharedPath)) return 0;
  const shared = readFileSync(sharedPath, 'utf8');
  if (validateSharedMemory(shared).ok) return 2;
  const parsed = parseSharedMemory(shared);
  return parsed.ok && parsed.metadata.schema_version === 1 ? 1 : 0;
}

function vaultReopen({ vaultBase }) {
  const validation = validateMemoryBundle(vaultBase);
  if (!validation.ok) {
    throw compositionError(
      'WENDKEEP_MIGRATION_STATE_DIVERGED',
      `Vault production reader rejected migrated bundle: ${(validation.errors || []).join(' ')}`,
    );
  }
  return { version: vaultVersion(vaultBase), validation, state: memoryStatus(vaultBase) };
}

function ledgerVersion(ledgerPath) {
  const store = createFileReceiptStore({ ledgerPath });
  if (!store.fs.existsSync(store.ledgerPath)) return 2;
  const first = store.fs.readFileSync(store.ledgerPath, 'utf8').split(/\r?\n/).find((line) => line.trim());
  if (!first) return 2;
  let record;
  try { record = JSON.parse(first); }
  catch (error) {
    throw compositionError('WENDKEEP_MIGRATION_RESOURCE_CORRUPT', 'receipt ledger contains invalid JSON', error);
  }
  if (![1, 2].includes(record?.schema_version)) {
    throw compositionError('WENDKEEP_MIGRATION_VERSION_INVALID', 'receipt ledger schema_version is unsupported');
  }
  return record.schema_version;
}

function ledgerReopen({ ledgerPath }) {
  const store = createFileReceiptStore({ ledgerPath });
  const state = readReceiptLedger({ store });
  return { version: ledgerVersion(ledgerPath), state };
}

function observerVersion(dataDir) {
  const db = openObserverDatabase(dataDir);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!table) return 0;
    return Number(db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version || 0);
  } finally {
    db.close();
  }
}

function observerReopen({ dataDir }) {
  const db = openObserverDatabase(dataDir);
  try {
    const version = Number(db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version || 0);
    const documentsTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents'",
    ).get();
    const documents = documentsTable
      ? db.prepare('SELECT document_id, project_id, logical_path, content FROM documents ORDER BY project_id, logical_path').all()
      : [];
    const securityTables = [
      'observer_tokens', 'observer_access_audit', 'observer_purge_receipts', 'observer_retention_policies',
    ];
    const securityTableCount = securityTables.filter((name) => db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name)).length;
    const quickCheck = db.prepare('PRAGMA quick_check').get().quick_check;
    if (quickCheck !== 'ok') {
      throw compositionError('WENDKEEP_MIGRATION_STATE_DIVERGED', `Observer quick_check failed: ${quickCheck}`);
    }
    return { version, state: { documents, security_table_count: securityTableCount, quick_check: quickCheck } };
  } finally {
    db.close();
  }
}

function latestObserverBackup(dataDir) {
  return readdirSync(dataDir)
    .filter((name) => /^observer\.sqlite\.pre-\d{3}-\d+\.bak$/.test(name))
    .sort()
    .at(-1);
}

function migrateObserverStore({ dataDir }) {
  const db = openObserverDatabase(dataDir);
  try {
    return migrateObserverDatabase(db);
  } finally {
    db.close();
  }
}

function activeContextReopen({ vaultBase }) {
  const state = readSessionRegistry(vaultBase);
  return { version: nativeControlPlaneVersion('active-contexts', state), state };
}

function migrateActiveContextStore({ vaultBase }) {
  let migrated;
  mutateSessionRegistry(vaultBase, (registry) => {
    migrated = migrateActiveContextRegistryState(registry);
    for (const key of Object.keys(registry)) {
      if (!Object.hasOwn(migrated, key)) delete registry[key];
    }
    Object.assign(registry, migrated);
  });
  return migrated;
}

function readPortableFile(portablePath) {
  try {
    return JSON.parse(readFileSync(resolve(portablePath), 'utf8'));
  } catch (error) {
    throw compositionError('WENDKEEP_MIGRATION_RESOURCE_CORRUPT', 'portable state is missing or corrupt', error);
  }
}

function writePortableFile(portablePath, state) {
  const path = resolve(portablePath);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function portableReopen({ portablePath }) {
  const state = upgradePortableState(readPortableFile(portablePath));
  return { version: nativeControlPlaneVersion('portable', state), state };
}

function migratePortableStore({ portablePath }) {
  const migrated = upgradePortableState(readPortableFile(portablePath));
  writePortableFile(portablePath, migrated);
  return migrated;
}

const productionAdapters = Object.freeze({
  'active-contexts': Object.freeze({
    inspect: ({ vaultBase }) => {
      const state = readSessionRegistry(vaultBase);
      return { version: nativeControlPlaneVersion('active-contexts', state), state };
    },
    migrate: migrateActiveContextStore,
    reopen: activeContextReopen,
  }),
  vault: Object.freeze({
    inspect: ({ vaultBase }) => ({ version: vaultVersion(vaultBase) }),
    migrate: ({ vaultBase }) => migrateMemory(vaultBase, { apply: true }),
    reopen: vaultReopen,
  }),
  ledger: Object.freeze({
    inspect: ({ ledgerPath }) => ({ version: ledgerVersion(ledgerPath) }),
    migrate: ({ ledgerPath }) => readReceiptLedger({ store: createFileReceiptStore({ ledgerPath }) }),
    reopen: ledgerReopen,
  }),
  observer: Object.freeze({
    inspect: ({ dataDir }) => ({ version: observerVersion(dataDir) }),
    migrate: migrateObserverStore,
    reopen: observerReopen,
    rollback({ dataDir }) {
      const backupName = latestObserverBackup(dataDir);
      if (!backupName) {
        throw compositionError('WENDKEEP_MIGRATION_ROLLBACK_UNAVAILABLE', 'Observer structural backup is missing');
      }
      const databasePath = join(resolve(dataDir), OBSERVER_SQL_FILE);
      rmSync(`${databasePath}-wal`, { force: true });
      rmSync(`${databasePath}-shm`, { force: true });
      copyFileSync(join(resolve(dataDir), backupName), databasePath);
      return { restored: true, backup_file: backupName };
    },
    repair: migrateObserverStore,
  }),
  portable: Object.freeze({
    inspect: ({ portablePath }) => {
      const state = readPortableFile(portablePath);
      return { version: nativeControlPlaneVersion('portable', state), state };
    },
    migrate: migratePortableStore,
    reopen: portableReopen,
  }),
});

export function createProductionMigrationHarness() {
  return createNativeControlPlaneMigrationHarness(productionAdapters);
}
