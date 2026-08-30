import assert from 'node:assert/strict';
import test from 'node:test';

import { COVERAGE_SCOPES, coverageArguments } from '../scripts/coverage-gate.mjs';
import { CRITICAL_MUTANTS } from '../scripts/mutation-kernels.mjs';

const requiredDomains = [
  'contracts', 'evidence', 'migrations', 'observer', 'integrations',
  'commit', 'sync', 'vault', 'harness', 'mcp', 'worktrees',
];

test('[req:CI-QUALITY-1] critical packages have non-regressing native coverage thresholds', () => {
  assert.deepEqual(COVERAGE_SCOPES.map((scope) => scope.id), requiredDomains);
  for (const scope of COVERAGE_SCOPES) {
    assert.ok(scope.thresholds.lines >= 87);
    assert.ok(scope.thresholds.branches >= 60);
    assert.ok(scope.thresholds.functions >= 90);
    assert.match(scope.package, /^@wendkeep\/[a-z-]+$/);
    assert.ok(scope.rationale.length >= 30);
    const args = coverageArguments(scope).join(' ');
    assert.match(args, /--experimental-test-coverage/);
    assert.match(args, /--test-coverage-include=/);
    assert.ok(scope.tests.length >= 1);
  }
});

test('[req:CI-QUALITY-1] migrations coverage exercises every production composition adapter', () => {
  const migrations = COVERAGE_SCOPES.find((scope) => scope.id === 'migrations');
  assert.ok(migrations);
  assert.ok(migrations.tests.includes('tests/migration-production-integration.test.mjs'));
  assert.ok(migrations.tests.includes('tests/migration-composition-adapters.test.mjs'));
});

test('[req:CI-QUALITY-1] worktree coverage includes focused fail-closed and recovery branches', () => {
  const worktrees = COVERAGE_SCOPES.find((scope) => scope.id === 'worktrees');
  assert.ok(worktrees);
  assert.ok(worktrees.tests.includes('tests/worktree-cleanup-branches.test.mjs'));
});

test('[req:CI-QUALITY-2] one discriminating fail-closed mutant guards each critical kernel', () => {
  assert.deepEqual(CRITICAL_MUTANTS.map((mutant) => mutant.domain), requiredDomains);
  for (const mutant of CRITICAL_MUTANTS) {
    assert.ok(mutant.search.length > mutant.replacement.length);
    assert.ok(mutant.tests.every((path) => path.endsWith('.test.mjs')));
    assert.match(mutant.file, /^packages\/[a-z-]+\/src\/[a-z0-9.-]+\.mjs$/);
    assert.doesNotMatch(mutant.file, /\.brain|SESSION_REGISTRY|MEMORY_EVENTS|^[A-Za-z]:|^\//i);
  }
});

test('[req:CI-QUALITY-3] quality policy is package-coherent, not a hand-picked domain alias', () => {
  assert.equal(new Set(COVERAGE_SCOPES.map((scope) => scope.package)).size, requiredDomains.length);
  assert.deepEqual(CRITICAL_MUTANTS.map((mutant) => mutant.package),
    COVERAGE_SCOPES.map((scope) => scope.package));
});
