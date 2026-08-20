import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { makeDataDir, makeObserverFixture } from './helpers/observer-fixture.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

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
