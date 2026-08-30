#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const COVERAGE_SCOPES = Object.freeze([
  Object.freeze({
    id: 'contracts', package: '@wendkeep/contracts',
    rationale: 'canonical task and verdict contracts are shared authority, not a composition root',
    include: ['packages/contracts/src/task-parser.mjs'],
    tests: ['tests/task-contracts.test.mjs'],
    thresholds: { lines: 95, branches: 85, functions: 100 },
  }),
  Object.freeze({
    id: 'evidence', package: '@wendkeep/evidence',
    rationale: 'provenance binding is the fail-closed evidence authority',
    include: ['packages/evidence/src/provenance-gate.mjs'],
    tests: ['tests/provenance-gate.test.mjs', 'tests/provenance-integration.test.mjs'],
    thresholds: { lines: 88, branches: 71, functions: 100 },
  }),
  Object.freeze({
    id: 'migrations', package: '@wendkeep/migrations',
    rationale: 'state upgrades and rollback are persistence-critical',
    include: ['packages/migrations/src/*.mjs'],
    tests: [
      'tests/migration-harness.test.mjs',
      'tests/migration-sequential-upgrade.test.mjs',
      'tests/migration-crash-repair.test.mjs',
      'tests/migration-production-integration.test.mjs',
      'tests/migration-composition-adapters.test.mjs',
    ],
    thresholds: { lines: 87, branches: 80, functions: 100 },
  }),
  Object.freeze({
    id: 'observer', package: '@wendkeep/observer',
    rationale: 'Observer policy and authorization protect persisted telemetry',
    include: [
      'packages/observer/src/policy.mjs',
      'packages/observer/src/authz.mjs',
    ],
    tests: ['tests/observer-policy.test.mjs', 'tests/observer-authz.test.mjs'],
    thresholds: { lines: 95, branches: 80, functions: 90 },
  }),
  Object.freeze({
    id: 'integrations', package: '@wendkeep/integrations',
    rationale: 'bridge contracts are the public adapter trust boundary',
    include: ['packages/integrations/src/bridge-contract.mjs'],
    tests: [
      'tests/ecosystem-bridge-contract.test.mjs',
      'tests/ecosystem-bridge-evidence.test.mjs',
      'tests/ecosystem-bridge-e2e.test.mjs',
    ],
    thresholds: { lines: 89, branches: 62, functions: 100 },
  }),
  Object.freeze({
    id: 'commit', package: '@wendkeep/commit',
    rationale: 'the canonical commit message is a release authority boundary',
    include: ['packages/commit/src/commit-message.mjs'],
    tests: ['tests/commit-message.test.mjs'],
    thresholds: { lines: 95, branches: 85, functions: 100 },
  }),
  Object.freeze({
    id: 'sync', package: '@wendkeep/sync',
    rationale: 'portable synchronization validates encrypted and causal state',
    include: ['packages/sync/src/sync-protocol.mjs'],
    tests: ['tests/sync-protocol.test.mjs'],
    thresholds: { lines: 90, branches: 75, functions: 95 },
  }),
  Object.freeze({
    id: 'vault', package: '@wendkeep/vault',
    rationale: 'curated memory validation is the Vault privacy and bounded-state boundary',
    include: ['packages/vault/src/core-validator.mjs'],
    tests: ['tests/validate-core.test.mjs'],
    thresholds: { lines: 90, branches: 75, functions: 90 },
  }),
  Object.freeze({
    id: 'harness', package: '@wendkeep/harness',
    rationale: 'operating-profile routing is the canonical runtime policy',
    include: ['packages/harness/src/operating-profile.mjs'],
    tests: ['tests/operating-profile.test.mjs'],
    thresholds: { lines: 90, branches: 80, functions: 100 },
  }),
  Object.freeze({
    id: 'mcp', package: '@wendkeep/mcp',
    rationale: 'MCP client configuration is a public composition boundary',
    include: ['packages/mcp/src/config.mjs'],
    tests: ['tests/mcp-config-boundary.test.mjs'],
    thresholds: { lines: 95, branches: 85, functions: 100 },
  }),
  Object.freeze({
    id: 'worktrees', package: '@wendkeep/worktrees',
    rationale: 'managed cleanup controls destructive repository operations',
    include: ['packages/worktrees/src/worktree-cleanup.mjs'],
    tests: [
      'tests/worktree-cleanup.test.mjs',
      'tests/worktree-cleanup-branches.test.mjs',
    ],
    thresholds: { lines: 87, branches: 70, functions: 90 },
  }),
]);

export function coverageArguments(scope) {
  return [
    '--test',
    '--experimental-test-coverage',
    ...scope.include.map((pattern) => `--test-coverage-include=${pattern}`),
    `--test-coverage-lines=${scope.thresholds.lines}`,
    `--test-coverage-branches=${scope.thresholds.branches}`,
    `--test-coverage-functions=${scope.thresholds.functions}`,
    ...scope.tests,
  ];
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--list')) {
    process.stdout.write(`${JSON.stringify(COVERAGE_SCOPES, null, 2)}\n`);
    process.exit(0);
  }
  const requested = process.argv.includes('--scope')
    ? process.argv[process.argv.indexOf('--scope') + 1]
    : '';
  const scopes = requested ? COVERAGE_SCOPES.filter((scope) => scope.id === requested) : COVERAGE_SCOPES;
  if (!scopes.length) {
    process.stderr.write(`unknown coverage scope: ${requested}\n`);
    process.exit(2);
  }
  for (const scope of scopes) {
    const result = spawnSync(process.execPath, coverageArguments(scope), { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
