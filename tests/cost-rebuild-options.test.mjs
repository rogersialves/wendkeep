import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRebuildOptions } from '../src/cost.mjs';

test('[req:OBS-13] targeted rebuild accepts audited positive limit overrides', () => {
  assert.deepEqual(parseRebuildOptions([
    'rebuild', '--session', 'synthetic-session', '--max-graph-nodes', '99',
    '--max-fallback-days', '7', '--max-fallback-candidates', '123', '--apply',
  ]), {
    ok: true,
    options: {
      apply: true,
      session: 'synthetic-session',
      limit: 0,
      limits: { maxGraphNodes: 99, maxFallbackDays: 7, maxFallbackCandidates: 123 },
      overrides: { maxGraphNodes: 99, maxFallbackDays: 7, maxFallbackCandidates: 123 },
    },
  });
});

test('[req:OBS-13] graph/fallback overrides are rejected for bulk rebuild', () => {
  const result = parseRebuildOptions(['rebuild', '--max-graph-nodes', '99']);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.code, 'TARGET_REQUIRED_FOR_LIMIT_OVERRIDE');
});

test('[req:OBS-13] invalid or non-positive overrides are usage errors', () => {
  for (const value of ['0', '-1', '1.5', 'nope', '']) {
    const argv = ['rebuild', '--session', 'synthetic-session', '--max-fallback-days'];
    if (value) argv.push(value);
    const result = parseRebuildOptions(argv);
    assert.equal(result.ok, false, value || 'missing');
    assert.equal(result.exitCode, 2, value || 'missing');
    assert.equal(result.code, 'INVALID_LIMIT_OVERRIDE', value || 'missing');
  }
});
