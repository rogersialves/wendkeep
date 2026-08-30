import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProductionMigrationHarness } from '../src/control-plane-migrations.mjs';
import { readReceiptLedger, createFileReceiptStore } from '../src/receipt-ledger.mjs';
import { validateMemoryBundle } from '../src/validate-memory.mjs';
import { renderCoreSkeleton } from '../src/validate-core.mjs';
import { openObserverDatabase } from '../src/observer-sql-store.mjs';
import { renderSharedMemory } from '../hooks/memory-schema.mjs';
import { readSessionRegistry } from '../hooks/obsidian-common.mjs';

const OBSERVER_SCHEMA = new URL('../schema/observer/', import.meta.url);

function vaultFixture({ generation }) {
  const vaultBase = mkdtempSync(join(tmpdir(), `wk-native-vault-${generation}-`));
  const brain = join(vaultBase, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'PROJECT.json'), '{"schemaVersion":1,"projectId":"fixture-project"}\n');
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  if (generation === 1) {
    writeFileSync(
      join(brain, 'SHARED_MEMORY.md'),
      renderSharedMemory().replace('schema_version: 2', 'schema_version: 1')
        .replace('## Estado Entregue\n- (vazio)', '## Estado Entregue\n- contrato 84 preservado'),
    );
  }
  writeFileSync(join(brain, 'TASK_CONTRACTS.json'), '{"tasks":[{"id":"84.4","authority":"canonical"}]}\n');
  writeFileSync(join(brain, 'EVIDENCE_ENVELOPE.json'), '{"schema_version":2,"evidence_id":"fixture-envelope"}\n');
  return vaultBase;
}

function stageObserverVersion5(dataDir) {
  const db = openObserverDatabase(dataDir);
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (let version = 1; version <= 5; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const name = readdirSync(OBSERVER_SCHEMA).find((file) => file.startsWith(`${prefix}-`));
    db.exec(readFileSync(new URL(name, OBSERVER_SCHEMA), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
      .run(version, name, '2026-08-30T00:00:00.000Z');
  }
  db.prepare("INSERT INTO projects(project_id, project_name, registered_at, updated_at) VALUES ('fixture-project', 'Fixture', '2026-08-30', '2026-08-30')").run();
  db.prepare("INSERT INTO documents(document_id, project_id, logical_path, entity_type, content, captured_at) VALUES ('doc-84', 'fixture-project', 'safe.md', 'document', '# preserved', '2026-08-30')").run();
  db.close();
}

test('[req:MIG-2] Vault N-2/N-1 runs through the production adapter and reopens with memory/contracts/evidence preserved', () => {
  const harness = createProductionMigrationHarness();
  for (const generation of [0, 1]) {
    const vaultBase = vaultFixture({ generation });
    try {
      const contracts = readFileSync(join(vaultBase, '.brain', 'TASK_CONTRACTS.json'));
      const evidence = readFileSync(join(vaultBase, '.brain', 'EVIDENCE_ENVELOPE.json'));
      const result = harness.run('vault', { vaultBase });
      assert.equal(result.source_version, generation);
      assert.equal(result.target_version, 2);
      assert.deepEqual(result.migration.migration_plan, result.migration_plan);
      assert.equal(result.reopened.version, 2);
      assert.equal(result.reopened.validation.ok, true);
      assert.equal(validateMemoryBundle(vaultBase).ok, true);
      assert.deepEqual(readFileSync(join(vaultBase, '.brain', 'TASK_CONTRACTS.json')), contracts);
      assert.deepEqual(readFileSync(join(vaultBase, '.brain', 'EVIDENCE_ENVELOPE.json')), evidence);
      if (generation === 1) {
        assert.match(readFileSync(join(vaultBase, '.brain', 'MEMORY_CANDIDATES.jsonl'), 'utf8'), /contrato 84 preservado/);
        assert.equal(existsSync(result.migration.backupPath), true);
      }
    } finally {
      rmSync(vaultBase, { recursive: true, force: true });
    }
  }
});

test('[req:MIG-2] ledger v1 is formally migrated by the harness and reopened by the production chain reader', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-native-ledger-'));
  const ledgerPath = join(root, 'receipts.jsonl');
  const draft = {
    schema_version: 1,
    kind: 'commit',
    subject: { sha: 'a'.repeat(40) },
    claims: { contracts: ['84.4'] },
    observations: { evidence: ['fixture-envelope'] },
    recorded_at: '2026-08-30T00:00:00.000Z',
  };
  try {
    writeFileSync(ledgerPath, `${JSON.stringify(draft)}\n`);
    const result = createProductionMigrationHarness().run('ledger', { ledgerPath });
    assert.equal(result.source_version, 1);
    assert.deepEqual(result.migration_plan.steps, [1]);
    assert.equal(result.reopened.version, 2);
    assert.equal(result.reopened.state.records[0].claims.contracts[0], '84.4');
    assert.equal(result.reopened.state.records[0].observations.evidence[0], 'fixture-envelope');
    assert.equal(result.reopened.state.checkpoint_status, 'current');
    assert.match(result.reopened.state.last_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(readReceiptLedger({ store: createFileReceiptStore({ ledgerPath }) }).records.length, 1);
    assert.match(readFileSync(`${ledgerPath}.legacy.jsonl`, 'utf8'), /"schema_version":1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:MIG-2] Observer v5 uses the SQL migrator with backup, replay, rollback and repair over a real database', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wk-native-observer-'));
  const harness = createProductionMigrationHarness();
  try {
    stageObserverVersion5(dataDir);
    const migrated = harness.run('observer', { dataDir });
    assert.equal(migrated.source_version, 5);
    assert.deepEqual(migrated.migration_plan.steps, [5]);
    assert.equal(migrated.reopened.version, 6);
    assert.match(migrated.migration.backups[0], /pre-006-\d+\.bak$/);
    assert.equal(existsSync(migrated.migration.backups[0]), true);
    assert.equal(migrated.reopened.state.documents[0].content, '# preserved');
    assert.equal(migrated.reopened.state.security_table_count, 4);

    const replay = harness.replay('observer', { dataDir });
    assert.deepEqual(replay.migration_plan.steps, []);
    assert.equal(replay.migration.backups.length, 0);

    const rolledBack = harness.rollback('observer', { dataDir });
    assert.equal(rolledBack.reopened.version, 5);
    assert.equal(rolledBack.reopened.state.documents[0].content, '# preserved');

    const repaired = harness.repair('observer', { dataDir });
    assert.equal(repaired.source_version, 5);
    assert.equal(repaired.reopened.version, 6);
    assert.equal(repaired.reopened.state.documents[0].content, '# preserved');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:MIG-2] production harness registers exactly five resources and persists active-contexts through its adapter', () => {
  const vaultBase = mkdtempSync(join(tmpdir(), 'wk-native-active-contexts-'));
  const brain = join(vaultBase, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'SESSION_REGISTRY.json'), `${JSON.stringify({
    version: 2,
    sessions: { 'session-84': { status: 'active', project_id: 'fixture-project' } },
    active_contexts: { 'fixture:repository:worktree:session-84': { state: 'active', revision: 4 } },
    contracts: { tasks: ['84.4'] },
    evidence: { envelopes: ['fixture-envelope'] },
  }, null, 2)}\n`);
  try {
    const harness = createProductionMigrationHarness();
    assert.deepEqual(harness.resources, ['active-contexts', 'ledger', 'observer', 'portable', 'vault']);
    const result = harness.run('active-contexts', { vaultBase });
    assert.equal(result.source_version, 2);
    assert.equal(result.reopened.version, 3);
    const persisted = readSessionRegistry(vaultBase);
    assert.equal(persisted.active_contexts_schema, 1);
    assert.equal(persisted.active_contexts_revision, 0);
    assert.deepEqual(persisted.contracts, { tasks: ['84.4'] });
    assert.deepEqual(persisted.evidence, { envelopes: ['fixture-envelope'] });
  } finally {
    rmSync(vaultBase, { recursive: true, force: true });
  }
});

test('[req:MIG-2] portable N-2/N-1 files run through the same harness and reopen through the production upgrader', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-native-portable-'));
  try {
    for (const generation of [0, 1]) {
      const portablePath = join(root, `portable-${generation}.json`);
      const artifact = {
        path: '07-Specs/fixture.md', category: 'spec', content: '# fixture\n', content_sha256: 'sha256:legacy',
      };
      const legacy = generation === 0
        ? {
          project_id: 'fixture-project', repository_id: 'fixture-repository', authored: [artifact],
          active_work: [{ schema_version: 1, active_work_id: '0123456789abcdef01234567', evidence_refs: ['fixture-envelope'], completed: ['84.4'] }],
        }
        : {
          project_id: 'fixture-project', repository_id: 'fixture-repository', artifacts: [artifact], active_work: [],
        };
      writeFileSync(portablePath, `${JSON.stringify(legacy, null, 2)}\n`);
      const result = createProductionMigrationHarness().run('portable', { portablePath });
      assert.equal(result.source_version, generation);
      assert.equal(result.reopened.version, 2);
      assert.equal(result.reopened.state.schema_version, 1);
      assert.equal(result.reopened.state.kind, 'wendkeep-portable-state');
      assert.deepEqual(result.reopened.state.artifacts, [artifact]);
      assert.deepEqual(result.reopened.state.active_work, legacy.active_work);
      assert.deepEqual(JSON.parse(readFileSync(portablePath, 'utf8')), result.reopened.state);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
