const migrationError = (code, message) => Object.assign(new Error(message), { code });

export const NATIVE_CONTROL_PLANE_TARGETS = Object.freeze({
  vault: 2,
  ledger: 2,
  'active-contexts': 3,
  observer: 6,
  portable: 2,
});

export function planNativeControlPlaneMigration(resource, sourceVersion) {
  const target = NATIVE_CONTROL_PLANE_TARGETS[resource];
  if (target === undefined) {
    throw migrationError('WENDKEEP_MIGRATION_RESOURCE_UNKNOWN', `unknown migration resource: ${resource}`);
  }
  if (!Number.isInteger(sourceVersion) || sourceVersion < 0) {
    throw migrationError('WENDKEEP_MIGRATION_VERSION_INVALID', 'migration version must be a non-negative integer');
  }
  if (sourceVersion > target) {
    throw migrationError(
      'WENDKEEP_MIGRATION_FUTURE_VERSION',
      `${resource} format ${sourceVersion} is newer than supported target ${target}`,
    );
  }
  return {
    resource,
    from_version: sourceVersion,
    to_version: target,
    steps: Array.from({ length: target - sourceVersion }, (_, index) => sourceVersion + index),
  };
}

function activeContextGeneration(state) {
  if (state?.active_contexts_schema === 1) return 3;
  if (state?.active_contexts && typeof state.active_contexts === 'object'
    && !Array.isArray(state.active_contexts)) return 2;
  return 1;
}

export function migrateActiveContextRegistryState(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || !source.sessions || typeof source.sessions !== 'object' || Array.isArray(source.sessions)) {
    throw migrationError(
      'WENDKEEP_MIGRATION_PRECONDITION_FAILED',
      'active-contexts migration requires a real SESSION_REGISTRY object',
    );
  }
  const plan = planNativeControlPlaneMigration('active-contexts', activeContextGeneration(source));
  const state = structuredClone(source);
  for (const fromVersion of plan.steps) {
    if (fromVersion === 1) state.active_contexts = {};
    if (fromVersion === 2) {
      state.active_contexts_schema = 1;
      const revision = Number(state.active_contexts_revision);
      state.active_contexts_revision = Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
    }
  }
  return state;
}

function portableGeneration(state) {
  if (state?.schema_version === 1 && state?.kind === 'wendkeep-portable-state') return 2;
  if (Array.isArray(state?.artifacts)) return 1;
  if (Array.isArray(state?.authored)) return 0;
  return -1;
}

export function nativeControlPlaneVersion(resource, state) {
  if (resource === 'active-contexts') return activeContextGeneration(state);
  if (resource === 'portable') return portableGeneration(state);
  throw migrationError(
    'WENDKEEP_MIGRATION_RESOURCE_UNKNOWN',
    `native state version detection is unavailable for ${resource}`,
  );
}

export function migratePortableState(source, { digestArtifacts } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || typeof source.project_id !== 'string' || typeof source.repository_id !== 'string') {
    throw migrationError(
      'WENDKEEP_MIGRATION_PRECONDITION_FAILED',
      'portable migration requires real project and repository identities',
    );
  }
  const generation = portableGeneration(source);
  if (generation < 0) {
    throw migrationError('WENDKEEP_MIGRATION_PRECONDITION_FAILED', 'portable predecessor shape is unsupported');
  }
  const plan = planNativeControlPlaneMigration('portable', generation);
  const state = structuredClone(source);
  for (const fromVersion of plan.steps) {
    if (fromVersion === 0) {
      state.artifacts = state.authored;
      delete state.authored;
      if (!Array.isArray(state.active_work)) state.active_work = [];
    }
    if (fromVersion === 1) {
      if (typeof digestArtifacts !== 'function') {
        throw migrationError(
          'WENDKEEP_MIGRATION_PRECONDITION_FAILED',
          'portable migration requires the canonical artifact digest',
        );
      }
      state.schema_version = 1;
      state.kind = 'wendkeep-portable-state';
      state.authored_sha256 = digestArtifacts(state.artifacts);
    }
  }
  return state;
}

function requireNativeAdapter(adapters, resource) {
  const adapter = adapters?.[resource];
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw migrationError('WENDKEEP_MIGRATION_ADAPTER_MISSING', `production migration adapter is missing for ${resource}`);
  }
  for (const method of ['inspect', 'migrate', 'reopen']) {
    if (typeof adapter[method] !== 'function') {
      throw migrationError('WENDKEEP_MIGRATION_ADAPTER_INVALID', `${resource} adapter requires ${method}()`);
    }
  }
  return adapter;
}

function assertReopenedTarget(resource, reopened, targetVersion) {
  if (!reopened || reopened.version !== targetVersion) {
    throw migrationError(
      'WENDKEEP_MIGRATION_STATE_DIVERGED',
      `${resource} production reader reopened version ${String(reopened?.version)} instead of ${targetVersion}`,
    );
  }
}

/**
 * Owns orchestration only. Production adapters remain responsible for parsing, migration,
 * persistence, backup and reopening of their real store formats.
 */
export function createNativeControlPlaneMigrationHarness(adapters = {}) {
  const resources = Object.freeze(Object.keys(adapters).sort());
  const execute = (resource, options, operation = 'migrate') => {
    const adapter = requireNativeAdapter(adapters, resource);
    const inspected = adapter.inspect(options);
    if (!inspected || !Number.isInteger(inspected.version)) {
      throw migrationError('WENDKEEP_MIGRATION_RESOURCE_INVALID', `${resource} adapter returned no production version`);
    }
    const migrationPlan = planNativeControlPlaneMigration(resource, inspected.version);
    const action = operation === 'repair' ? adapter.repair : adapter.migrate;
    if (typeof action !== 'function') {
      throw migrationError('WENDKEEP_MIGRATION_ADAPTER_INVALID', `${resource} adapter does not support ${operation}`);
    }
    const migration = action({ ...options, migrationPlan, inspected });
    const reopened = adapter.reopen(options);
    assertReopenedTarget(resource, reopened, migrationPlan.to_version);
    return Object.freeze({
      resource,
      source_version: inspected.version,
      target_version: migrationPlan.to_version,
      migration_plan: migrationPlan,
      migration,
      reopened,
    });
  };

  return Object.freeze({
    resources,
    run(resource, options = {}) {
      return execute(resource, options, 'migrate');
    },
    replay(resource, options = {}) {
      return execute(resource, options, 'migrate');
    },
    repair(resource, options = {}) {
      return execute(resource, options, 'repair');
    },
    rollback(resource, options = {}) {
      const adapter = requireNativeAdapter(adapters, resource);
      if (typeof adapter.rollback !== 'function') {
        throw migrationError('WENDKEEP_MIGRATION_ROLLBACK_UNAVAILABLE', `${resource} adapter does not support rollback`);
      }
      const rollback = adapter.rollback(options);
      const reopened = adapter.reopen(options);
      return Object.freeze({ resource, rollback, reopened });
    },
  });
}
