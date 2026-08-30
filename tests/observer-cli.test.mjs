import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { makeDataDir, makeObserverFixture } from './helpers/observer-fixture.mjs';
import { openObserverDatabase } from '../src/observer-sql-store.mjs';

const OBSERVER_SCHEMA = new URL('../schema/observer/', import.meta.url);

function stageObserverVersion5(dataDir) {
  const db = openObserverDatabase(dataDir);
  try {
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (let version = 1; version <= 5; version += 1) {
      const prefix = String(version).padStart(3, '0');
      const name = readdirSync(OBSERVER_SCHEMA).find((file) => file.startsWith(`${prefix}-`));
      db.exec(readFileSync(new URL(name, OBSERVER_SCHEMA), 'utf8'));
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
        .run(version, name, '2026-08-28T00:00:00.000Z');
    }
    db.prepare("INSERT INTO projects(project_id, project_name, registered_at, updated_at) VALUES ('project-a', 'Project A', '2026-08-28', '2026-08-28')").run();
  } finally { db.close(); }
}

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');
const {
  WENDKEEP_OBSERVER_URL: _observerUrl,
  WENDKEEP_OBSERVER_TOKEN: _observerToken,
  ...OBSERVER_TEST_ENV
} = process.env;
const run = (args) => spawnSync(process.execPath, [BIN, ...args], {
  encoding: 'utf8',
  env: OBSERVER_TEST_ENV,
});
const runWithEnv = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], {
  encoding: 'utf8',
  env: { ...OBSERVER_TEST_ENV, ...env },
});

test('[req:OBS-LOCAL-2] [req:OBS-LOCAL-3] CLI observer expõe status, register, publish e mantém loopback', () => {
  const dataDir = makeDataDir();
  const fixture = makeObserverFixture();
  try {
    const empty = run(['observer', 'status', '--data-dir', dataDir, '--json']);
    assert.equal(empty.status, 0, empty.stderr);
    assert.deepEqual(JSON.parse(empty.stdout).projects, []);

    const registered = run(['observer', 'register', '--data-dir', dataDir, '--project', fixture.projectRoot, '--vault', fixture.vaultBase, '--json']);
    assert.equal(registered.status, 0, registered.stderr);
    const published = run(['observer', 'publish', '--data-dir', dataDir, '--project', fixture.projectRoot, '--vault', fixture.vaultBase, '--json']);
    assert.equal(published.status, 0, published.stderr);
    assert.equal(JSON.parse(published.stdout).authority, 'sqlite');
    const reconciled = run(['observer', 'reconcile', '--data-dir', dataDir, '--project', fixture.projectRoot, '--vault', fixture.vaultBase, '--json']);
    assert.equal(reconciled.status, 0, reconciled.stderr);
    assert.equal(JSON.parse(reconciled.stdout).mode, 'local-sqlite');
    const status = run(['observer', 'status', '--data-dir', dataDir, '--json']);
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).projects.map((p) => p.projectId), ['project-a']);

    const denied = run(['observer', 'serve', '--data-dir', dataDir, '--host', '0.0.0.0', '--port', '0']);
    assert.notEqual(denied.status, 0);
    assert.match(`${denied.stdout}\n${denied.stderr}`, /loopback/i);
  } finally {
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-RECOVERY] CLI manages offline admin recovery, policy and purge without putting token values in argv/output', () => {
  const dataDir = makeDataDir();
  const fixture = makeObserverFixture();
  const policyPath = join(dataDir, 'policy.json');
  try {
    const registered = run(['observer', 'register', '--data-dir', dataDir, '--project', fixture.projectRoot, '--vault', fixture.vaultBase, '--json']);
    assert.equal(registered.status, 0, registered.stderr);
    const created = runWithEnv([
      'observer', 'security', 'token', 'create', '--data-dir', dataDir, '--project-id', 'project-a',
      '--role', 'admin', '--scopes', '*', '--token-env', 'OBSERVER_RECOVERY_TOKEN',
      '--expires-at', '2026-09-29T12:00:00.000Z', '--reason', 'offline recovery', '--json',
    ], { OBSERVER_RECOVERY_TOKEN: 'offline-recovery-secret' });
    assert.equal(created.status, 0, created.stderr);
    const token = JSON.parse(created.stdout);
    assert.equal(token.role, 'admin');
    assert.equal(created.stdout.includes('offline-recovery-secret'), false);

    const rotated = runWithEnv([
      'observer', 'security', 'token', 'rotate', '--data-dir', dataDir, '--project-id', 'project-a',
      '--token-id', token.token_id, '--new-token-id', 'recovery-rotated',
      '--token-env', 'OBSERVER_ROTATED_TOKEN', '--expires-at', '2026-10-29T12:00:00.000Z',
      '--reason', 'scheduled rotation', '--json',
    ], { OBSERVER_ROTATED_TOKEN: 'offline-rotated-secret' });
    assert.equal(rotated.status, 0, rotated.stderr);
    const rotatedToken = JSON.parse(rotated.stdout);
    assert.equal(rotatedToken.rotated_from, token.token_id);
    assert.equal(rotated.stdout.includes('offline-rotated-secret'), false);

    writeFileSync(policyPath, JSON.stringify({
      document_capture: 'metadata', require_loopback_auth: true,
      retention: { documents: 30, calls: 14, transcripts: 7 },
    }));
    const policy = run(['observer', 'security', 'policy', 'set', '--data-dir', dataDir, '--project-id', 'project-a', '--file', policyPath, '--json']);
    assert.equal(policy.status, 0, policy.stderr);
    assert.equal(JSON.parse(policy.stdout).policy.require_loopback_auth, true);
    const purge = run(['observer', 'security', 'purge', '--data-dir', dataDir, '--project-id', 'project-a', '--before', '2026-08-01T00:00:00.000Z', '--classes', 'calls,transcripts', '--dry-run', '--json']);
    assert.equal(purge.status, 0, purge.stderr);
    assert.equal(JSON.parse(purge.stdout).dry_run, true);
    const retention = run([
      'observer', 'security', 'retention', 'run', '--data-dir', dataDir, '--project-id', 'project-a',
      '--operation-id', 'scheduled-2026-08-29', '--observed-at', '2026-08-29T12:00:00.000Z', '--dry-run', '--json',
    ]);
    assert.equal(retention.status, 0, retention.stderr);
    assert.deepEqual(Object.keys(JSON.parse(retention.stdout).cutoffs).sort(), ['calls', 'documents', 'transcripts']);
    const revoked = run(['observer', 'security', 'token', 'revoke', '--data-dir', dataDir, '--project-id', 'project-a', '--token-id', rotatedToken.token_id, '--reason', 'recovery complete', '--json']);
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.equal(JSON.parse(revoked.stdout).revoked, true);
  } finally {
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-MIGRATE] CLI DB entrypoints encrypt a v5 backup and required mode fails before plaintext backup', () => {
  const fixture = makeObserverFixture();
  const keyEnv = {
    WENDKEEP_OBSERVER_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString('base64'),
    WENDKEEP_OBSERVER_ENCRYPTION_KEY_ID: 'cli-migration-key',
  };
  const commands = [
    ['observer', 'status'],
    ['observer', 'security', 'policy', 'show', '--project-id', 'project-a'],
    ['observer', 'register', '--project', fixture.projectRoot, '--vault', fixture.vaultBase],
    ['observer', 'publish', '--project', fixture.projectRoot, '--vault', fixture.vaultBase],
  ];
  const dataDirs = [];
  try {
    for (const command of commands) {
      const dataDir = makeDataDir();
      dataDirs.push(dataDir);
      stageObserverVersion5(dataDir);
      const result = runWithEnv([...command, '--data-dir', dataDir, '--json'], keyEnv);
      assert.equal(result.status, 0, `${command.join(' ')}: ${result.stderr}`);
      const files = readdirSync(dataDir);
      assert.equal(files.some((name) => /\.pre-006-\d+\.bak\.enc$/.test(name)), true, command.join(' '));
      assert.equal(files.some((name) => /\.bak\.enc\.manifest\.json$/.test(name)), true, command.join(' '));
      assert.equal(files.some((name) => /\.bak$|\.bak\.tmp$/.test(name)), false, command.join(' '));
    }

    const requiredDir = makeDataDir();
    dataDirs.push(requiredDir);
    stageObserverVersion5(requiredDir);
    const denied = runWithEnv(['observer', 'status', '--data-dir', requiredDir, '--json'], {
      WENDKEEP_OBSERVER_REQUIRE_ENCRYPTION: '1',
    });
    assert.notEqual(denied.status, 0);
    assert.match(`${denied.stdout}\n${denied.stderr}`, /chave|key|encryption/i);
    assert.equal(readdirSync(requiredDir).some((name) => /\.bak(?:\.|$)/.test(name)), false);
    const db = openObserverDatabase(requiredDir);
    try { assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 5); }
    finally { db.close(); }
  } finally {
    fixture.cleanup();
    for (const dataDir of dataDirs) rmSync(dataDir, { recursive: true, force: true });
  }
});
