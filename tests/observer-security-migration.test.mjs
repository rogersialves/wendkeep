import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  migrateObserverDatabase,
  openObserverDatabase,
  restoreObserverEncryptedBackup,
} from '../src/observer-sql-store.mjs';
import { createObserverEncryption } from '../packages/observer/src/encryption.mjs';
import { startObserverServer } from '../src/observer-server.mjs';
import { makeDataDir } from './helpers/observer-fixture.mjs';

const SCHEMA = new URL('../schema/observer/', import.meta.url);

function stageVersion5(db) {
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (let version = 1; version <= 5; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const name = readdirSync(SCHEMA).find((file) => file.startsWith(`${prefix}-`));
    db.exec(readFileSync(new URL(name, SCHEMA), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(version, name, '2026-08-28T00:00:00.000Z');
  }
  db.prepare("INSERT INTO projects(project_id, project_name, registered_at, updated_at) VALUES ('project-a', 'Project A', '2026-08-28', '2026-08-28')").run();
  db.prepare("INSERT INTO documents(document_id, project_id, logical_path, entity_type, content, captured_at) VALUES ('d-1', 'project-a', 'safe.md', 'document', '# Preserved', '2026-08-28')").run();
}

test('[req:OBS-SEC-MIGRATE] v5 database upgrades to security schema with backup, preserved data and idempotent replay', () => {
  const dataDir = makeDataDir();
  const db = openObserverDatabase(dataDir);
  try {
    stageVersion5(db);

    const result = migrateObserverDatabase(db);
    assert.equal(result.version, 6);
    assert.equal(result.backups.some((path) => /pre-006-\d+\.bak$/.test(path)), true);
    assert.equal(db.prepare("SELECT content FROM documents WHERE project_id = 'project-a'").get().content, '# Preserved');
    for (const table of ['observer_tokens', 'observer_access_audit', 'observer_purge_receipts', 'observer_retention_policies']) {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count, 1, table);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('llm_calls') WHERE name IN ('prompt_envelope', 'response_envelope')").get().count, 2);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const replay = migrateObserverDatabase(db);
    assert.equal(replay.version, 6);
    assert.equal(replay.backups.length, 0);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-MIGRATE] failed v6 upgrade rolls back atomically, leaves a valid backup and can retry', () => {
  const dataDir = makeDataDir();
  const db = openObserverDatabase(dataDir);
  try {
    stageVersion5(db);
    db.exec('CREATE TABLE observer_tokens(dummy TEXT)');
    assert.throws(() => migrateObserverDatabase(db));
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 5);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('documents') WHERE name = 'content_envelope'").get().count, 0);
    assert.equal(db.prepare("SELECT content FROM documents WHERE document_id = 'd-1'").get().content, '# Preserved');

    const backupName = readdirSync(dataDir).find((name) => /observer\.sqlite\.pre-006-\d+\.bak$/.test(name));
    assert.ok(backupName, 'structural migration backup must exist before applying v6');
    const backup = new DatabaseSync(join(dataDir, backupName));
    try {
      assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      assert.equal(backup.prepare("SELECT content FROM documents WHERE document_id = 'd-1'").get().content, '# Preserved');
    } finally {
      backup.close();
    }

    db.exec('DROP TABLE observer_tokens');
    const retry = migrateObserverDatabase(db);
    assert.equal(retry.version, 6);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('documents') WHERE name = 'content_envelope'").get().count, 1);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-MIGRATE] required at-rest mode leaves only an encrypted restorable structural backup', () => {
  const dataDir = makeDataDir();
  const db = openObserverDatabase(dataDir);
  const encryption = createObserverEncryption({ required: true, keyId: 'backup-key', keyProvider: () => Buffer.alloc(32, 7) });
  const wrongEncryption = createObserverEncryption({ required: true, keyId: 'backup-key', keyProvider: () => Buffer.alloc(32, 8) });
  const restoredPath = join(dataDir, 'restored.sqlite');
  try {
    stageVersion5(db);
    const migrated = migrateObserverDatabase(db, { backupEncryption: encryption, requireEncryptedBackup: true });
    assert.equal(migrated.backups.length, 1);
    const backupPath = migrated.backups[0];
    assert.match(backupPath, /\.bak\.enc$/);
    assert.equal(readdirSync(dataDir).some((name) => name.endsWith('.bak') || name.endsWith('.tmp')), false);
    assert.equal(readFileSync(backupPath, 'utf8').includes('# Preserved'), false);
    assert.equal(existsSync(`${backupPath}.manifest.json`), true);
    assert.throws(
      () => restoreObserverEncryptedBackup({ backupPath, destinationPath: restoredPath, encryption: wrongEncryption }),
      (error) => error.code === 'observer_decryption_failed',
    );
    assert.equal(existsSync(restoredPath), false);
    restoreObserverEncryptedBackup({ backupPath, destinationPath: restoredPath, encryption });
    const restored = new DatabaseSync(restoredPath);
    try {
      assert.equal(restored.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      assert.equal(restored.prepare("SELECT content FROM documents WHERE document_id = 'd-1'").get().content, '# Preserved');
    } finally { restored.close(); }
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-MIGRATE] server bootstrap encrypts the v5 backup before migration and reads', async () => {
  const dataDir = makeDataDir();
  const staged = openObserverDatabase(dataDir);
  stageVersion5(staged);
  staged.close();
  const encryption = createObserverEncryption({ required: true, keyId: 'server-key', keyProvider: () => Buffer.alloc(32, 5) });
  const server = await startObserverServer({ host: '127.0.0.1', port: 0, dataDir, security: { encryption } });
  try {
    const health = await (await fetch(`http://127.0.0.1:${server.address().port}/healthz`)).json();
    assert.equal(health.database.schema_version, 6);
    const files = readdirSync(dataDir);
    assert.equal(files.some((name) => /\.pre-006-\d+\.bak\.enc$/.test(name)), true);
    assert.equal(files.some((name) => /\.bak$|\.bak\.tmp$/.test(name)), false);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
