import { hashMigrationState } from './file-store.mjs';
import { planMigration } from './registry.mjs';

const migrationError = (code, message) => Object.assign(new Error(message), { code });
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RESOURCES = new Set(['vault', 'ledger', 'active-contexts', 'observer', 'portable']);
const JOURNAL_KEYS = new Set([
  'schema_version', 'resource', 'status', 'from_version', 'to_version',
  'before_sha256', 'backup_sha256', 'steps',
]);
const JOURNAL_STEP_KEYS = new Set([
  'id', 'from_version', 'to_version', 'status', 'before_sha256',
  'expected_after_sha256', 'after_sha256', 'recovered_after_write',
]);
const RECEIPT_KEYS = new Set([
  'schema_version', 'resource', 'status', 'from_version', 'to_version',
  'before_sha256', 'after_sha256', 'backup_sha256', 'backup_file', 'steps',
]);
const RECEIPT_STEP_KEYS = new Set([
  'id', 'from_version', 'to_version', 'before_sha256', 'after_sha256',
]);

const hasExactKeys = (value, allowed, required = allowed) => value
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).every((key) => allowed.has(key))
  && [...required].every((key) => Object.hasOwn(value, key));

const validVersion = (value) => Number.isInteger(value) && value >= 0;
const validHash = (value) => typeof value === 'string' && SHA256.test(value);

const assertJournal = (journal, { resource, targetVersion, plan }) => {
  if (
    !hasExactKeys(journal, JOURNAL_KEYS)
    || journal.schema_version !== 1
    || journal.resource !== resource
    || journal.status !== 'running'
    || !validVersion(journal.from_version)
    || !validVersion(journal.to_version)
    || journal.to_version !== targetVersion
    || !validHash(journal.before_sha256)
    || journal.backup_sha256 !== journal.before_sha256
    || !Array.isArray(journal.steps)
    || journal.steps.length !== plan.steps.length
  ) {
    throw migrationError('WENDKEEP_MIGRATION_JOURNAL_INVALID', 'migration journal does not match the closed operation contract');
  }
  let priorStatus = 'completed';
  let priorHash = journal.before_sha256;
  for (const [index, step] of journal.steps.entries()) {
    const expected = plan.steps[index];
    const status = step?.status;
    const statusOrderValid = status === 'completed'
      ? priorStatus === 'completed'
      : status === 'writing'
        ? priorStatus === 'completed'
        : status === 'pending';
    if (!hasExactKeys(step, JOURNAL_STEP_KEYS, new Set(['id', 'from_version', 'to_version', 'status']))
      || !['pending', 'writing', 'completed'].includes(status)
      || !statusOrderValid
      || step.id !== expected.id
      || step.from_version !== expected.from_version
      || step.to_version !== expected.to_version
      || (step.before_sha256 !== undefined && !validHash(step.before_sha256))
      || (step.expected_after_sha256 !== undefined && !validHash(step.expected_after_sha256))
      || (step.after_sha256 !== undefined && !validHash(step.after_sha256))
      || (step.recovered_after_write !== undefined && step.recovered_after_write !== true)
      || (status === 'pending' && (
        step.before_sha256 !== undefined || step.expected_after_sha256 !== undefined
        || step.after_sha256 !== undefined || step.recovered_after_write !== undefined
      ))
      || (status !== 'pending' && step.before_sha256 !== priorHash)
      || (status === 'completed' && (
        !validHash(step.after_sha256) || step.expected_after_sha256 !== step.after_sha256
      ))) {
      throw migrationError('WENDKEEP_MIGRATION_JOURNAL_INVALID', `migration journal step ${index + 1} is invalid`);
    }
    if (status === 'completed') priorHash = step.after_sha256;
    priorStatus = status;
  }
};

const assertReceipt = (receipt) => {
  const allowed = new Set(RECEIPT_KEYS);
  if (receipt?.status === 'rolled_back') allowed.add('restored_sha256');
  if (!hasExactKeys(receipt, allowed, RECEIPT_KEYS)
    || receipt.schema_version !== 1
    || !RESOURCES.has(receipt.resource)
    || !['completed', 'rolled_back'].includes(receipt.status)
    || !validVersion(receipt.from_version)
    || !validVersion(receipt.to_version)
    || receipt.from_version > receipt.to_version
    || !validHash(receipt.before_sha256)
    || !validHash(receipt.after_sha256)
    || receipt.backup_sha256 !== receipt.before_sha256
    || receipt.backup_file !== 'migration-source.backup.json'
    || !Array.isArray(receipt.steps)
    || receipt.steps.length !== receipt.to_version - receipt.from_version
    || (receipt.status === 'rolled_back' && !validHash(receipt.restored_sha256))) {
    throw migrationError('WENDKEEP_MIGRATION_RECEIPT_INVALID', 'migration receipt violates the closed public contract');
  }
  let priorHash = receipt.before_sha256;
  for (const [index, step] of receipt.steps.entries()) {
    const fromVersion = receipt.from_version + index;
    if (!hasExactKeys(step, RECEIPT_STEP_KEYS)
      || step.id !== `${receipt.resource}:${fromVersion}->${fromVersion + 1}`
      || step.from_version !== fromVersion
      || step.to_version !== fromVersion + 1
      || step.before_sha256 !== priorHash
      || !validHash(step.after_sha256)) {
      throw migrationError('WENDKEEP_MIGRATION_RECEIPT_INVALID', `migration receipt step ${index + 1} is invalid`);
    }
    priorHash = step.after_sha256;
  }
  if (priorHash !== receipt.after_sha256) {
    throw migrationError('WENDKEEP_MIGRATION_RECEIPT_INVALID', 'migration receipt final hash is not bound to its steps');
  }
};

const assertResourcePreconditions = (state, resource) => {
  if (state?.resource !== resource) {
    throw migrationError(
      'WENDKEEP_MIGRATION_PRECONDITION_FAILED',
      `${resource} migration cannot consume resource ${String(state?.resource || 'unknown')}`,
    );
  }
  if (!state.authority || typeof state.authority !== 'object' || Array.isArray(state.authority)) {
    throw migrationError('WENDKEEP_MIGRATION_PRECONDITION_FAILED', `${resource} authority is required`);
  }
};

const createJournal = ({ plan, beforeHash }) => ({
  schema_version: 1,
  resource: plan.resource,
  status: 'running',
  from_version: plan.from_version,
  to_version: plan.to_version,
  before_sha256: beforeHash,
  backup_sha256: beforeHash,
  steps: plan.steps.map((step) => ({
    id: step.id,
    from_version: step.from_version,
    to_version: step.to_version,
    status: 'pending',
  })),
});

const rebuildJournalFromBackup = ({ plan, backup, state }) => {
  const beforeHash = hashMigrationState(backup);
  const journal = createJournal({ plan, beforeHash });
  const expectedByVersion = new Map([[backup.format_version, structuredClone(backup)]]);
  let projected = structuredClone(backup);
  for (const [index, step] of plan.steps.entries()) {
    const beforeStepHash = hashMigrationState(projected);
    projected = step.apply(projected);
    const afterStepHash = hashMigrationState(projected);
    expectedByVersion.set(step.to_version, structuredClone(projected));
    if (step.to_version <= state.format_version) {
      Object.assign(journal.steps[index], {
        before_sha256: beforeStepHash,
        expected_after_sha256: afterStepHash,
        status: 'completed',
        after_sha256: afterStepHash,
        recovered_after_write: true,
      });
    }
  }
  const expectedCurrent = expectedByVersion.get(state.format_version);
  if (!expectedCurrent || hashMigrationState(expectedCurrent) !== hashMigrationState(state)) {
    throw migrationError(
      'WENDKEEP_MIGRATION_STATE_DIVERGED',
      `${plan.resource} state cannot be rebound to the immutable migration backup`,
    );
  }
  return journal;
};

const buildReceipt = (journal, finalState) => ({
  schema_version: 1,
  resource: journal.resource,
  status: 'completed',
  from_version: journal.from_version,
  to_version: journal.to_version,
  before_sha256: journal.before_sha256,
  after_sha256: hashMigrationState(finalState),
  backup_sha256: journal.backup_sha256,
  backup_file: 'migration-source.backup.json',
  steps: journal.steps.map(({ id, from_version, to_version, before_sha256, after_sha256 }) => ({
    id, from_version, to_version, before_sha256, after_sha256,
  })),
});

export function runMigration({ registry, resource, targetVersion, adapter, store, fault = () => {} }) {
  let state = adapter.read();
  if (!Number.isInteger(state.format_version)) {
    throw migrationError('WENDKEEP_MIGRATION_RESOURCE_INVALID', `${resource} format_version must be an integer`);
  }
  assertResourcePreconditions(state, resource);

  let journal;
  if (store.hasJournal()) {
    journal = store.readJournal();
    const resumedPlan = planMigration({
      registry, resource, sourceVersion: journal.from_version, targetVersion,
    });
    assertJournal(journal, { resource, targetVersion, plan: resumedPlan });
  } else {
    const plan = planMigration({
      registry,
      resource,
      sourceVersion: state.format_version,
      targetVersion,
    });
    store.backup(adapter.path);
    journal = createJournal({ plan, beforeHash: hashMigrationState(state) });
    store.writeJournal(journal);
  }

  const plan = planMigration({
    registry,
    resource,
    sourceVersion: journal.from_version,
    targetVersion,
  });
  const stepsById = new Map(plan.steps.map((step) => [step.id, step]));
  fault('before-migration', { resource, from_version: plan.from_version, to_version: plan.to_version });

  for (const journalStep of journal.steps) {
    if (journalStep.status === 'completed') continue;
    const step = stepsById.get(journalStep.id);
    if (!step) {
      throw migrationError('WENDKEEP_MIGRATION_JOURNAL_MISMATCH', `unknown journal step ${journalStep.id}`);
    }
    fault('before-step', { resource, step: step.id, state: structuredClone(state) });
    if (state.format_version === step.to_version) {
      if (!journalStep.expected_after_sha256
        || hashMigrationState(state) !== journalStep.expected_after_sha256) {
        throw migrationError(
          'WENDKEEP_MIGRATION_STATE_DIVERGED',
          `${resource} state checksum diverged after ${step.id}`,
        );
      }
      journalStep.status = 'completed';
      journalStep.recovered_after_write = true;
      journalStep.after_sha256 = hashMigrationState(state);
      store.writeJournal(journal);
      fault('after-step', { resource, step: step.id, state: structuredClone(state) });
      continue;
    }
    if (state.format_version !== step.from_version) {
      throw migrationError(
        'WENDKEEP_MIGRATION_STATE_DIVERGED',
        `${resource} state ${state.format_version} diverged from journal step ${step.from_version}`,
      );
    }
    journalStep.before_sha256 = hashMigrationState(state);
    journalStep.status = 'writing';
    store.writeJournal(journal);
    const migrated = step.apply(state);
    journalStep.expected_after_sha256 = hashMigrationState(migrated);
    store.writeJournal(journal);
    adapter.write(migrated);
    state = migrated;
    fault('after-write', { resource, step: step.id, state: structuredClone(state) });
    journalStep.after_sha256 = hashMigrationState(state);
    journalStep.status = 'completed';
    store.writeJournal(journal);
    fault('after-step', { resource, step: step.id, state: structuredClone(state) });
  }

  if (state.format_version !== targetVersion) {
    throw migrationError('WENDKEEP_MIGRATION_INCOMPLETE', `${resource} did not reach target ${targetVersion}`);
  }
  journal.status = 'completed';
  fault('after-migration', { resource, from_version: plan.from_version, to_version: plan.to_version });
  const receipt = buildReceipt(journal, state);
  store.writeReceipt(receipt);
  store.removeJournal();
  return {
    receipt,
    state: structuredClone(state),
    backup_path: store.paths.backup,
    store,
  };
}

export function repairMigration({ registry, resource, targetVersion, adapter, store }) {
  try {
    if (store.hasJournal()) {
      const journal = store.readJournal();
      const plan = planMigration({
        registry, resource, sourceVersion: journal.from_version, targetVersion,
      });
      assertJournal(journal, { resource, targetVersion, plan });
    }
  } catch (error) {
    if (error.code !== 'WENDKEEP_MIGRATION_JOURNAL_CORRUPT') throw error;
    store.archiveCorruptJournal();
    const state = adapter.read();
    const backup = store.readBackup();
    if (!Number.isInteger(backup.format_version)) {
      throw migrationError('WENDKEEP_MIGRATION_BACKUP_CORRUPT', `${resource} backup format_version must be an integer`);
    }
    assertResourcePreconditions(backup, resource);
    const plan = planMigration({
      registry,
      resource,
      sourceVersion: backup.format_version,
      targetVersion,
    });
    store.writeJournal(rebuildJournalFromBackup({ plan, backup, state }));
    return { repaired: true, source_version: backup.format_version, target_version: targetVersion };
  }
  throw migrationError(
    'WENDKEEP_MIGRATION_REPAIR_NOT_REQUIRED',
    'migration journal is valid; explicit repair is not required',
  );
}

export function rollbackMigration({ adapter, store }) {
  const receipt = store.readReceipt();
  assertReceipt(receipt);
  if (receipt.status !== 'completed') {
    throw migrationError('WENDKEEP_MIGRATION_ROLLBACK_UNAVAILABLE', 'only a completed migration can roll back');
  }
  const current = adapter.read();
  if (hashMigrationState(current) !== receipt.after_sha256) {
    throw migrationError(
      'WENDKEEP_MIGRATION_ROLLBACK_STATE_DIVERGED',
      'resource changed after migration; deterministic rollback is unsafe',
    );
  }
  const backup = store.readBackup();
  const backupHash = hashMigrationState(backup);
  if (backupHash !== receipt.backup_sha256 || backupHash !== receipt.before_sha256) {
    throw migrationError(
      'WENDKEEP_MIGRATION_BACKUP_CHECKSUM_MISMATCH',
      'migration backup does not match the completed receipt',
    );
  }
  adapter.write(backup);
  const rollbackReceipt = {
    ...receipt,
    status: 'rolled_back',
    restored_sha256: hashMigrationState(adapter.read()),
  };
  store.writeReceipt(rollbackReceipt);
  return { receipt: rollbackReceipt, state: structuredClone(backup) };
}
