import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CONTROL_PLANE_TARGETS,
  createControlPlaneMigrationRegistry,
  createFileMigrationStore,
  createJsonResourceAdapter,
  hashMigrationState,
  repairMigration,
  rollbackMigration,
  runMigration,
} from '../packages/migrations/src/index.mjs';

const sourceFixture = () => JSON.parse(readFileSync(
  new URL('./fixtures/migrations/n-2/active-contexts.json', import.meta.url), 'utf8',
));

test('[req:MIG-3] crash after write resumes idempotently and a truncated journal requires explicit repair', () => {
  const root = mkdtempSync(join(tmpdir(), 'wendkeep-migration-crash-'));
  try {
    const path = join(root, 'active-contexts.json');
    const runtime = join(root, 'runtime');
    writeFileSync(path, `${JSON.stringify(sourceFixture(), null, 2)}\n`);
    const registry = createControlPlaneMigrationRegistry();
    const store = createFileMigrationStore(runtime);
    const adapter = createJsonResourceAdapter(path);
    let crashed = false;
    assert.throws(
      () => runMigration({
        registry, resource: 'active-contexts', targetVersion: CONTROL_PLANE_TARGETS['active-contexts'],
        adapter, store,
        fault(point) {
          if (!crashed && point === 'after-write') {
            crashed = true;
            throw Object.assign(new Error('injected crash'), { code: 'INJECTED_CRASH' });
          }
        },
      }),
      (error) => error.code === 'INJECTED_CRASH',
    );
    const resumed = runMigration({
      registry, resource: 'active-contexts', targetVersion: CONTROL_PLANE_TARGETS['active-contexts'],
      adapter, store,
    });
    assert.equal(resumed.receipt.status, 'completed');
    assert.equal(adapter.read().format_version, CONTROL_PLANE_TARGETS['active-contexts']);

    writeFileSync(path, `${JSON.stringify(sourceFixture(), null, 2)}\n`);
    crashed = false;
    assert.throws(() => runMigration({
      registry, resource: 'active-contexts', targetVersion: CONTROL_PLANE_TARGETS['active-contexts'],
      adapter, store: createFileMigrationStore(join(root, 'repair-runtime')),
      fault(point) {
        if (!crashed && point === 'after-write') {
          crashed = true;
          throw Object.assign(new Error('injected crash'), { code: 'INJECTED_CRASH' });
        }
      },
    }));
    const repairStore = createFileMigrationStore(join(root, 'repair-runtime'));
    writeFileSync(repairStore.paths.journal, '{"schema_version":1');
    assert.throws(
      () => runMigration({
        registry, resource: 'active-contexts', targetVersion: CONTROL_PLANE_TARGETS['active-contexts'],
        adapter, store: repairStore,
      }),
      (error) => error.code === 'WENDKEEP_MIGRATION_JOURNAL_CORRUPT',
    );
    const repaired = repairMigration({
      registry, resource: 'active-contexts', targetVersion: CONTROL_PLANE_TARGETS['active-contexts'],
      adapter, store: repairStore,
    });
    assert.equal(repaired.repaired, true);
    const completed = runMigration({
      registry, resource: 'active-contexts', targetVersion: CONTROL_PLANE_TARGETS['active-contexts'],
      adapter, store: repairStore,
    });
    assert.equal(completed.receipt.status, 'completed');
    assert.equal(completed.receipt.before_sha256, hashMigrationState(sourceFixture()));
    assert.equal(completed.receipt.backup_sha256, hashMigrationState(sourceFixture()));
    const rolledBack = rollbackMigration({ adapter, store: repairStore });
    assert.equal(rolledBack.receipt.status, 'rolled_back');
    assert.deepEqual(rolledBack.state, sourceFixture());
    assert.deepEqual(adapter.read(), sourceFixture());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:MIG-3] checksum and resource preconditions fail closed without overwriting divergent state', () => {
  const root = mkdtempSync(join(tmpdir(), 'wendkeep-migration-divergence-'));
  try {
    const path = join(root, 'active-contexts.json');
    const source = sourceFixture();
    writeFileSync(path, `${JSON.stringify(source, null, 2)}\n`);
    const registry = createControlPlaneMigrationRegistry();
    const store = createFileMigrationStore(join(root, 'runtime'));
    const adapter = createJsonResourceAdapter(path);
    assert.throws(() => runMigration({
      registry, resource: 'active-contexts', targetVersion: CONTROL_PLANE_TARGETS['active-contexts'],
      adapter, store,
      fault(point) {
        if (point === 'after-write') throw Object.assign(new Error('injected crash'), { code: 'INJECTED_CRASH' });
      },
    }), (error) => error.code === 'INJECTED_CRASH');
    const divergent = adapter.read();
    divergent.contexts['injected-context'] = { state: 'active' };
    adapter.write(divergent);
    assert.throws(
      () => runMigration({
        registry, resource: 'active-contexts', targetVersion: CONTROL_PLANE_TARGETS['active-contexts'],
        adapter, store,
      }),
      (error) => error.code === 'WENDKEEP_MIGRATION_STATE_DIVERGED',
    );
    assert.deepEqual(adapter.read(), divergent);

    const wrongPath = join(root, 'wrong-resource.json');
    writeFileSync(wrongPath, `${JSON.stringify({ ...source, resource: 'vault' }, null, 2)}\n`);
    assert.throws(
      () => runMigration({
        registry, resource: 'active-contexts', targetVersion: CONTROL_PLANE_TARGETS['active-contexts'],
        adapter: createJsonResourceAdapter(wrongPath),
        store: createFileMigrationStore(join(root, 'wrong-runtime')),
      }),
      (error) => error.code === 'WENDKEEP_MIGRATION_PRECONDITION_FAILED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:MIG-3] forged closed-contract journal and receipt fields fail before repair or rollback', () => {
  const root = mkdtempSync(join(tmpdir(), 'wendkeep-migration-forged-'));
  try {
    const path = join(root, 'active-contexts.json');
    const registry = createControlPlaneMigrationRegistry();
    const adapter = createJsonResourceAdapter(path);
    const targetVersion = CONTROL_PLANE_TARGETS['active-contexts'];
    writeFileSync(path, `${JSON.stringify(sourceFixture(), null, 2)}\n`);
    const journalStore = createFileMigrationStore(join(root, 'journal-runtime'));
    assert.throws(() => runMigration({
      registry, resource: 'active-contexts', targetVersion, adapter, store: journalStore,
      fault(point) {
        if (point === 'after-write') throw Object.assign(new Error('injected crash'), { code: 'INJECTED_CRASH' });
      },
    }), (error) => error.code === 'INJECTED_CRASH');
    const forgedJournal = journalStore.readJournal();
    forgedJournal.forged = true;
    writeFileSync(journalStore.paths.journal, `${JSON.stringify(forgedJournal)}\n`);
    assert.throws(
      () => runMigration({ registry, resource: 'active-contexts', targetVersion, adapter, store: journalStore }),
      (error) => error.code === 'WENDKEEP_MIGRATION_JOURNAL_INVALID',
    );
    assert.throws(
      () => repairMigration({ registry, resource: 'active-contexts', targetVersion, adapter, store: journalStore }),
      (error) => error.code === 'WENDKEEP_MIGRATION_JOURNAL_INVALID',
    );

    writeFileSync(path, `${JSON.stringify(sourceFixture(), null, 2)}\n`);
    const receiptStore = createFileMigrationStore(join(root, 'receipt-runtime'));
    runMigration({ registry, resource: 'active-contexts', targetVersion, adapter, store: receiptStore });
    const beforeRollback = adapter.read();
    const forgedReceipt = receiptStore.readReceipt();
    forgedReceipt.forged = true;
    writeFileSync(receiptStore.paths.receipt, `${JSON.stringify(forgedReceipt)}\n`);
    assert.throws(
      () => rollbackMigration({ adapter, store: receiptStore }),
      (error) => error.code === 'WENDKEEP_MIGRATION_RECEIPT_INVALID',
    );
    assert.deepEqual(adapter.read(), beforeRollback);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:MIG-3] every resource resumes after faults before/after steps and resource completion', () => {
  const root = mkdtempSync(join(tmpdir(), 'wendkeep-migration-fault-matrix-'));
  try {
    const registry = createControlPlaneMigrationRegistry();
    for (const [resource, targetVersion] of Object.entries(CONTROL_PLANE_TARGETS)) {
      const source = JSON.parse(readFileSync(
        new URL(`./fixtures/migrations/n-2/${resource}.json`, import.meta.url), 'utf8',
      ));
      for (const faultPoint of [
        'before-migration', 'before-step', 'after-write', 'after-step', 'after-migration',
      ]) {
        const caseRoot = join(root, resource, faultPoint);
        const path = join(caseRoot, 'resource.json');
        mkdirSync(caseRoot, { recursive: true });
        writeFileSync(path, `${JSON.stringify(source, null, 2)}\n`);
        const adapter = createJsonResourceAdapter(path);
        const store = createFileMigrationStore(join(caseRoot, 'runtime'));
        let injected = false;
        assert.throws(() => runMigration({
          registry, resource, targetVersion, adapter, store,
          fault(point) {
            if (!injected && point === faultPoint) {
              injected = true;
              throw Object.assign(new Error(`injected ${faultPoint}`), { code: 'INJECTED_CRASH' });
            }
          },
        }), (error) => error.code === 'INJECTED_CRASH');
        assert.equal(injected, true, `${resource}/${faultPoint} was not reached`);
        const resumed = runMigration({ registry, resource, targetVersion, adapter, store });
        assert.equal(resumed.state.format_version, targetVersion);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
