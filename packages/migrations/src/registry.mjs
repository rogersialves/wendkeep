const clone = (value) => structuredClone(value);

export const CONTROL_PLANE_TARGETS = Object.freeze({
  vault: 2,
  ledger: 2,
  'active-contexts': 3,
  observer: 6,
  portable: 2,
});

const migrationError = (code, message) => Object.assign(new Error(message), { code });

const createStep = (resource, fromVersion) => Object.freeze({
  id: `${resource}:${fromVersion}->${fromVersion + 1}`,
  resource,
  from_version: fromVersion,
  to_version: fromVersion + 1,
  apply(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw migrationError('WENDKEEP_MIGRATION_RESOURCE_INVALID', `${resource} resource must be an object`);
    }
    if (source.format_version !== fromVersion) {
      throw migrationError(
        'WENDKEEP_MIGRATION_STEP_VERSION_MISMATCH',
        `${resource} step expected format_version ${fromVersion}`,
      );
    }
    const next = clone(source);
    next.format_version = fromVersion + 1;
    const history = Array.isArray(next.migration_history) ? [...next.migration_history] : [];
    if (!history.includes(this.id)) history.push(this.id);
    next.migration_history = history;
    return next;
  },
});

export function createControlPlaneMigrationRegistry() {
  return new Map(Object.entries(CONTROL_PLANE_TARGETS).map(([resource, target]) => [
    resource,
    new Map(Array.from({ length: target }, (_, from) => [from, createStep(resource, from)])),
  ]));
}

export function planMigration({ registry, resource, sourceVersion, targetVersion }) {
  if (!Number.isInteger(sourceVersion) || sourceVersion < 0 || !Number.isInteger(targetVersion)) {
    throw migrationError('WENDKEEP_MIGRATION_VERSION_INVALID', 'migration versions must be non-negative integers');
  }
  const resourceSteps = registry?.get(resource);
  if (!resourceSteps || CONTROL_PLANE_TARGETS[resource] === undefined) {
    throw migrationError('WENDKEEP_MIGRATION_RESOURCE_UNKNOWN', `unknown migration resource: ${resource}`);
  }
  if (targetVersion !== CONTROL_PLANE_TARGETS[resource]) {
    throw migrationError(
      'WENDKEEP_MIGRATION_TARGET_UNSUPPORTED',
      `${resource} target ${targetVersion} is not the supported target ${CONTROL_PLANE_TARGETS[resource]}`,
    );
  }
  if (sourceVersion > targetVersion) {
    throw migrationError(
      'WENDKEEP_MIGRATION_FUTURE_VERSION',
      `${resource} format ${sourceVersion} is newer than supported target ${targetVersion}`,
    );
  }
  const steps = [];
  for (let version = sourceVersion; version < targetVersion; version += 1) {
    const step = resourceSteps.get(version);
    if (!step) {
      throw migrationError(
        'WENDKEEP_MIGRATION_PATH_UNSUPPORTED',
        `no ${resource} migration from format ${version} to ${version + 1}`,
      );
    }
    steps.push(step);
  }
  return Object.freeze({
    resource,
    from_version: sourceVersion,
    to_version: targetVersion,
    steps: Object.freeze(steps),
  });
}
