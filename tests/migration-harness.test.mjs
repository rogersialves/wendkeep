import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CONTROL_PLANE_TARGETS,
  createControlPlaneMigrationRegistry,
  planMigration,
} from '../packages/migrations/src/index.mjs';

const fixture = (generation, resource) => JSON.parse(readFileSync(
  new URL(`./fixtures/migrations/${generation}/${resource}.json`, import.meta.url), 'utf8',
));

test('[req:MIG-1] registry plans every N-2/N-1 control-plane upgrade without mutating source state', () => {
  const registry = createControlPlaneMigrationRegistry();
  for (const [resource, targetVersion] of Object.entries(CONTROL_PLANE_TARGETS)) {
    for (const [generation, expectedSteps] of [['n-2', 2], ['n-1', 1]]) {
      const source = fixture(generation, resource);
      const before = structuredClone(source);
      const plan = planMigration({
        registry, resource, sourceVersion: source.format_version, targetVersion,
      });
      assert.equal(plan.resource, resource);
      assert.equal(plan.steps.length, expectedSteps);
      assert.equal(plan.from_version, source.format_version);
      assert.equal(plan.to_version, targetVersion);
      assert.deepEqual(source, before, `${resource}/${generation} plan mutated its fixture`);
    }
    assert.throws(
      () => planMigration({ registry, resource, sourceVersion: targetVersion + 1, targetVersion }),
      (error) => error.code === 'WENDKEEP_MIGRATION_FUTURE_VERSION',
    );
  }
});

test('[req:MIG-1] migration receipt schema is public, closed and versioned', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/migration-receipt-v1.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$id, 'https://wendkeep.dev/schema/migration-receipt-v1.schema.json');
  assert.equal(schema.additionalProperties, false);
  for (const key of [
    'schema_version', 'resource', 'status', 'from_version', 'to_version',
    'before_sha256', 'after_sha256', 'backup_sha256', 'backup_file', 'steps',
  ]) assert.ok(schema.required.includes(key), `receipt schema misses ${key}`);
  assert.deepEqual(schema.properties.status.enum, ['completed', 'rolled_back']);
  assert.equal(schema.properties.steps.items.additionalProperties, false);
});

test('[req:MIG-1] migration journal schema is public and rejects unknown control fields', () => {
  const schema = JSON.parse(readFileSync(
    new URL('../schema/migration-journal-v1.schema.json', import.meta.url), 'utf8',
  ));
  assert.equal(schema.$id, 'https://wendkeep.dev/schema/migration-journal-v1.schema.json');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.steps.items.additionalProperties, false);
  assert.deepEqual(schema.properties.status, { const: 'running' });
  assert.deepEqual(schema.properties.steps.items.properties.status.enum, [
    'pending', 'writing', 'completed',
  ]);
});
