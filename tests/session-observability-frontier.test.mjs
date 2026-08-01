import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OBSERVABILITY_SCHEMA,
  buildObservabilityFrontier,
  compareObservabilityFrontiers,
  parseObservabilityCheckpoint,
  readObservabilityCheckpoint,
  renderObservabilityCheckpoint,
  renderObservabilityCheckpointLines,
  sanitizeObservabilityDiagnostics,
} from '../hooks/session-observability-state.mjs';

function frontier(overrides = {}) {
  return buildObservabilityFrontier({
    canonical_session_id: 'session-synthetic',
    activation_id: 'activation-synthetic',
    activation_epoch: 4,
    turn_sequence: 8,
    signal_sequence: 12,
    roots_stat_hash: 'roots-a',
    graph_cursor: 'graph-a',
    source_manifest_hash: 'manifest-a',
    ...overrides,
  });
}

test('[req:OBS-12] frontier comparison is monotonic by activation, turn and signal authority', () => {
  const current = frontier();

  assert.equal(compareObservabilityFrontiers(current, frontier({ activation_epoch: 3 })), 'stale');
  assert.equal(compareObservabilityFrontiers(current, frontier({ turn_sequence: 7 })), 'stale');
  assert.equal(compareObservabilityFrontiers(current, frontier({ signal_sequence: 11 })), 'stale');
  assert.equal(compareObservabilityFrontiers(current, frontier({ activation_epoch: 5 })), 'newer');
  assert.equal(compareObservabilityFrontiers(current, frontier({ turn_sequence: 9 })), 'newer');
  assert.equal(compareObservabilityFrontiers(current, frontier({ signal_sequence: 13 })), 'newer');
  assert.equal(compareObservabilityFrontiers(current, frontier()), 'same');
});

test('[req:OBS-12] equal authority with divergent identity or source hashes is conflict', () => {
  const current = frontier();

  assert.equal(compareObservabilityFrontiers(
    current,
    frontier({ source_manifest_hash: 'manifest-b' }),
  ), 'conflict');
  assert.equal(compareObservabilityFrontiers(
    current,
    frontier({ activation_id: 'activation-other' }),
  ), 'conflict');
  assert.equal(compareObservabilityFrontiers(
    current,
    frontier({ canonical_session_id: 'session-other' }),
  ), 'conflict');
  assert.equal(compareObservabilityFrontiers(null, current), 'newer');
});

test('[req:OBS-12] equal authority with a divergent roots stat hash is conflict', () => {
  const current = frontier();
  assert.equal(compareObservabilityFrontiers(
    current,
    frontier({ roots_stat_hash: 'roots-b' }),
  ), 'conflict');
});

test('[req:OBS-12] equal authority with a divergent graph cursor is conflict', () => {
  const current = frontier();
  assert.equal(compareObservabilityFrontiers(
    current,
    frontier({ graph_cursor: 'graph-b' }),
  ), 'conflict');
});

test('[req:OBS-12] schema 2 checkpoint renders and parses without losing the frontier', () => {
  const source = frontier();
  const diagnostics = [
    { code: 'CHILD_MISSING', count: 2 },
    { code: 'CACHE_INVALID', count: 1 },
    { code: 'CHILD_MISSING', count: 3 },
  ];
  const fields = renderObservabilityCheckpoint(source, { state: 'degraded', diagnostics });

  assert.equal(fields.observability_schema, OBSERVABILITY_SCHEMA);
  assert.equal(fields.subagents_observability_state, 'degraded');
  assert.equal(fields.subagents_diagnostics_json, JSON.stringify([
    { code: 'CACHE_INVALID', count: 1 },
    { code: 'CHILD_MISSING', count: 5 },
  ]));

  const parsed = parseObservabilityCheckpoint(fields);
  assert.deepEqual(parsed, {
    schema: OBSERVABILITY_SCHEMA,
    state: 'degraded',
    frontier: source,
    diagnostics: [
      { code: 'CACHE_INVALID', count: 1 },
      { code: 'CHILD_MISSING', count: 5 },
    ],
  });
  assert.deepEqual(readObservabilityCheckpoint(renderObservabilityCheckpointLines(
    source,
    { state: 'degraded', diagnostics },
  )), parsed);
});

test('[req:OBS-12] legacy or incomplete schema does not masquerade as a current checkpoint', () => {
  assert.equal(parseObservabilityCheckpoint({ observability_schema: 1 }), null);
  assert.equal(parseObservabilityCheckpoint({
    ...renderObservabilityCheckpoint(frontier(), { state: 'complete' }),
    observability_graph_cursor: '',
  }), null);
});

test('[req:OBS-14] diagnostics accept only allowlisted {code,count} objects', () => {
  assert.deepEqual(sanitizeObservabilityDiagnostics([
    { code: 'MAIN_TRANSCRIPT_UNRESOLVED', count: 1 },
  ]), [{ code: 'MAIN_TRANSCRIPT_UNRESOLVED', count: 1 }]);

  const sensitive = 'synthetic-private-marker';
  for (const diagnostics of [
    [{ code: 'NOT_ALLOWLISTED', count: 1 }],
    [{ code: 'CHILD_MISSING', count: 1, path: sensitive }],
    [{ code: 'CHILD_MISSING', count: 0 }],
    [{ code: 'CHILD_MISSING', count: 1.5 }],
  ]) {
    assert.throws(
      () => sanitizeObservabilityDiagnostics(diagnostics),
      (error) => error?.code === 'OBSERVABILITY_DIAGNOSTIC_INVALID'
        && !String(error.message).includes(sensitive),
    );
  }
});
