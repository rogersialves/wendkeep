import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createNativeControlPlaneMigrationHarness,
  migrateActiveContextRegistryState,
  migratePortableState,
  planNativeControlPlaneMigration,
} from '../packages/migrations/src/index.mjs';
import { createFileReceiptStore, readReceiptLedger } from '../src/receipt-ledger.mjs';
import { upgradePortableState } from '../src/portable.mjs';

const preserved = Object.freeze({
  contracts: { tasks: [{ id: '84.2', authority: 'canonical' }] },
  evidence: { envelopes: [{ evidence_id: 'fixture-envelope' }] },
});

test('[req:MIG-2] real active-context registry generations migrate without synthetic envelope fields', () => {
  const n2 = {
    version: 2,
    sessions: { 'session-1': { status: 'active', project_id: 'fixture-project' } },
    ...structuredClone(preserved),
  };
  const migrated = migrateActiveContextRegistryState(n2);
  assert.equal(migrated.active_contexts_schema, 1);
  assert.equal(migrated.active_contexts_revision, 0);
  assert.deepEqual(migrated.active_contexts, {});
  assert.deepEqual(migrated.sessions, n2.sessions);
  assert.deepEqual(migrated.contracts, preserved.contracts);
  assert.deepEqual(migrated.evidence, preserved.evidence);
  assert.equal(Object.hasOwn(migrated, 'format_version'), false);
  assert.equal(Object.hasOwn(migrated, 'migration_history'), false);

  const n1 = { ...n2, active_contexts: { 'repo:wt:session': { state: 'active', revision: 1 } } };
  const fromN1 = migrateActiveContextRegistryState(n1);
  assert.deepEqual(fromN1.active_contexts, n1.active_contexts);
  assert.equal(fromN1.active_contexts_schema, 1);
});

test('[req:MIG-2] real portable predecessor is upgraded to the public schema with authored evidence intact', () => {
  const content = '# sanitized fixture\n';
  const legacy = {
    project_id: 'fixture-project',
    repository_id: 'fixture-repository',
    authored: [{
      path: '07-Specs/fixture.md',
      category: 'spec',
      content,
      content_sha256: 'sha256:placeholder',
    }],
    active_work: [{
      schema_version: 1,
      active_work_id: '0123456789abcdef01234567',
      evidence_refs: ['fixture-envelope'],
      completed: ['84.2'],
    }],
  };
  const migrated = migratePortableState(legacy, {
    digestArtifacts: () => 'a'.repeat(64),
  });
  assert.equal(migrated.schema_version, 1);
  assert.equal(migrated.kind, 'wendkeep-portable-state');
  assert.equal(migrated.authored_sha256, 'a'.repeat(64));
  assert.deepEqual(migrated.artifacts, legacy.authored);
  assert.deepEqual(migrated.active_work, legacy.active_work);
  assert.equal(Object.hasOwn(migrated, 'format_version'), false);
  assert.equal(Object.hasOwn(migrated, 'migration_history'), false);
  assert.deepEqual(upgradePortableState(legacy), migratePortableState(legacy, {
    digestArtifacts: () => upgradePortableState(legacy).authored_sha256,
  }));
});

test('[req:MIG-2] real receipt JSONL v1 migrates through the production store and remains chain-verifiable', () => {
  const root = mkdtempSync(join(tmpdir(), 'wendkeep-ledger-migration-'));
  const ledgerPath = join(root, 'receipts.jsonl');
  try {
    const drafts = [
      {
        schema_version: 1,
        kind: 'commit',
        subject: { sha: 'a'.repeat(40) },
        claims: { contracts: ['fixture-task'] },
        observations: { evidence: ['fixture-envelope'] },
        recorded_at: '2026-08-30T00:00:00.000Z',
      },
      {
        schema_version: 1,
        kind: 'release',
        subject: { version: '0.90.0' },
        claims: { authority: 'fixture' },
        observations: { integrity: 'sha512-fixture' },
        recorded_at: '2026-08-30T00:01:00.000Z',
      },
    ];
    writeFileSync(ledgerPath, drafts.map((record) => `${JSON.stringify(record)}\n`).join(''));
    const result = readReceiptLedger({ store: createFileReceiptStore({ ledgerPath }) });
    assert.deepEqual(result.migration_plan, {
      resource: 'ledger', from_version: 1, to_version: 2, steps: [1],
    });
    assert.equal(result.records.length, 2);
    assert.equal(result.records.every((record) => record.schema_version === 2), true);
    assert.equal(result.checkpoint_status, 'current');
    assert.match(readFileSync(`${ledgerPath}.legacy.jsonl`, 'utf8'), /"schema_version":1/);
    assert.doesNotThrow(() => readReceiptLedger({ store: createFileReceiptStore({ ledgerPath }) }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:MIG-2] native plans match the published Vault, ledger and Observer schema versions', () => {
  assert.deepEqual(planNativeControlPlaneMigration('vault', 0), {
    resource: 'vault', from_version: 0, to_version: 2, steps: [0, 1],
  });
  assert.deepEqual(planNativeControlPlaneMigration('ledger', 1), {
    resource: 'ledger', from_version: 1, to_version: 2, steps: [1],
  });
  assert.deepEqual(planNativeControlPlaneMigration('observer', 4), {
    resource: 'observer', from_version: 4, to_version: 6, steps: [4, 5],
  });
  assert.throws(
    () => planNativeControlPlaneMigration('observer', 7),
    (error) => error.code === 'WENDKEEP_MIGRATION_FUTURE_VERSION',
  );
});

test('[req:MIG-2] native production harness rejects missing adapters and divergent reopen state', () => {
  const missing = createNativeControlPlaneMigrationHarness();
  assert.throws(
    () => missing.run('observer'),
    (error) => error.code === 'WENDKEEP_MIGRATION_ADAPTER_MISSING',
  );

  const divergent = createNativeControlPlaneMigrationHarness({
    portable: {
      inspect: () => ({ version: 1 }),
      migrate: () => ({ persisted: true }),
      reopen: () => ({ version: 1 }),
    },
  });
  assert.throws(
    () => divergent.run('portable'),
    (error) => error.code === 'WENDKEEP_MIGRATION_STATE_DIVERGED',
  );
});
