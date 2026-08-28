import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCALE_MEMORY_KEY,
  createSyntheticMemoryEvents,
  runMemoryReplayScaleBenchmark,
} from '../scripts/benchmark-memory-replay.mjs';

const CI_SCALE_EVENTS = 25_000;

test('[req:MEM-SCALE-1] synthetic memory ledger is deterministic and causally monotonic', () => {
  const first = createSyntheticMemoryEvents(500);
  const second = createSyntheticMemoryEvents(500);
  assert.deepEqual(second, first);
  assert.equal(first.length, 500);
  assert.equal(first[0].memory_key, SCALE_MEMORY_KEY);
  assert.equal(first[0].turn_sequence, 1);
  assert.equal(first.at(-1).turn_sequence, 500);
  assert.equal(new Set(first.map((event) => event.event_id)).size, first.length);
  assert.ok(first.every((event, index) => (
    index === 0 || event.observed_at > first[index - 1].observed_at
  )));
});

test('[req:MEM-SCALE-2] large snapshot replay reads only the tail after the first projection', {
  timeout: 180_000,
}, () => {
  const result = runMemoryReplayScaleBenchmark({ events: CI_SCALE_EVENTS });

  assert.equal(result.events, CI_SCALE_EVENTS);
  assert.equal(result.full.replay_mode, 'full');
  assert.equal(result.full.replayed_events, CI_SCALE_EVENTS);
  assert.equal(result.full.snapshot_status, 'written');

  assert.equal(result.warm.replay_mode, 'snapshot-tail');
  assert.equal(result.warm.replayed_events, 0);
  assert.equal(result.tail.replay_mode, 'snapshot-tail');
  assert.equal(result.tail.replayed_events, 1);

  assert.equal(result.advanced.replay_mode, 'snapshot-tail');
  assert.equal(result.advanced.replayed_events, 1);
  assert.equal(result.advanced.snapshot_status, 'written');
  assert.equal(result.advanced.snapshot_event_count, CI_SCALE_EVENTS + 1);

  assert.equal(result.final_warm.replay_mode, 'snapshot-tail');
  assert.equal(result.final_warm.replayed_events, 0);
  assert.deepEqual(result.contracts, {
    full_replay_complete: true,
    warm_replay_zero: true,
    one_event_tail_only: true,
    snapshot_advanced: true,
    final_warm_replay_zero: true,
    projection_stable: true,
  });

  assert.equal(result.snapshot.status, 'ok');
  assert.equal(result.snapshot.event_count, CI_SCALE_EVENTS + 1);
  assert.equal(result.snapshot.tail_events, 0);
  assert.match(result.snapshot.through_event_id, /mem-scale-0025000$/);
  assert.ok(result.bytes.initial_ledger > 0);
  assert.ok(result.bytes.snapshot > 0);
  assert.ok(result.bytes.shared_projection > 0);
});
