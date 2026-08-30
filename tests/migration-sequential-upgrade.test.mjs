import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CONTROL_PLANE_TARGETS,
  createControlPlaneMigrationRegistry,
  createFileMigrationStore,
  createJsonResourceAdapter,
  rollbackMigration,
  runMigration,
} from '../packages/migrations/src/index.mjs';

const fixture = (generation, resource) => JSON.parse(readFileSync(
  new URL(`./fixtures/migrations/${generation}/${resource}.json`, import.meta.url), 'utf8',
));

test('[req:MIG-2] sequential N-2/N-1 upgrades preserve authority and emit verified receipts', () => {
  const root = mkdtempSync(join(tmpdir(), 'wendkeep-migration-sequential-'));
  try {
    const registry = createControlPlaneMigrationRegistry();
    for (const [resource, targetVersion] of Object.entries(CONTROL_PLANE_TARGETS)) {
      for (const generation of ['n-2', 'n-1']) {
        const source = fixture(generation, resource);
        source.memory = { decisions: ['sanitized-decision'], lessons: ['sanitized-lesson'] };
        source.contracts = { tasks: ['fixture-task'], handoffs: ['fixture-handoff'] };
        source.evidence = { envelopes: ['sha256:fixture'], receipts: ['fixture-receipt'] };
        const path = join(root, `${resource}-${generation}.json`);
        writeFileSync(path, `${JSON.stringify(source, null, 2)}\n`);
        const result = runMigration({
          registry,
          resource,
          targetVersion,
          adapter: createJsonResourceAdapter(path),
          store: createFileMigrationStore(join(root, 'runtime', `${resource}-${generation}`)),
        });
        const migrated = JSON.parse(readFileSync(path, 'utf8'));
        assert.equal(migrated.format_version, targetVersion);
        assert.deepEqual(migrated.authority, source.authority);
        assert.deepEqual(migrated.memory, source.memory);
        assert.deepEqual(migrated.contracts, source.contracts);
        assert.deepEqual(migrated.evidence, source.evidence);
        assert.equal(result.receipt.status, 'completed');
        assert.equal(result.receipt.from_version, source.format_version);
        assert.equal(result.receipt.to_version, targetVersion);
        assert.match(result.receipt.before_sha256, /^sha256:[a-f0-9]{64}$/);
        assert.match(result.receipt.after_sha256, /^sha256:[a-f0-9]{64}$/);
        assert.equal(result.receipt.backup_sha256, result.receipt.before_sha256);
        assert.equal(result.receipt.backup_file, 'migration-source.backup.json');
        assert.equal(existsSync(result.backup_path), true);
        assert.deepEqual(JSON.parse(readFileSync(result.backup_path, 'utf8')), source);
        assert.equal(result.receipt.steps.length, targetVersion - source.format_version);

        const rolledBack = rollbackMigration({ adapter: createJsonResourceAdapter(path), store: result.store });
        assert.equal(rolledBack.receipt.status, 'rolled_back');
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), source);
        assert.equal(rolledBack.receipt.restored_sha256, result.receipt.before_sha256);
        assert.throws(
          () => rollbackMigration({ adapter: createJsonResourceAdapter(path), store: result.store }),
          (error) => error.code === 'WENDKEEP_MIGRATION_ROLLBACK_UNAVAILABLE',
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
