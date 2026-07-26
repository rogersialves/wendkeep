import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSessionMemoryEvents } from '../hooks/memory-handoff.mjs';
import { renderSharedMemory } from '../hooks/memory-schema.mjs';
import { readMemoryLedger } from '../hooks/memory-store.mjs';
import {
  projectStopMemoryAttempt,
  recordStopMemoryOutcome,
  stageStopMemoryAttempt,
} from '../hooks/session-memory-lifecycle.mjs';

const SESSION_ID = 'example-session-1';
const ACTIVATION_ID = 'example-activation-1';
const TURN_ID = 'example-turn-1';

function registryEntry({
  activationId = ACTIVATION_ID,
  epoch = 1,
  turnId = TURN_ID,
  turnSequence = 1,
} = {}) {
  return {
    status: 'active',
    active_activation_id: activationId,
    activation_id: activationId,
    activation_epoch: epoch,
    last_turn_id: turnId,
    last_turn_sequence: turnSequence,
    activations: {
      [activationId]: {
        activation_id: activationId,
        epoch,
        status: 'active',
        last_turn_sequence: turnSequence,
        last_stop_turn_id: turnId,
        last_stop_turn_sequence: turnSequence,
      },
    },
  };
}

function context({
  activationId = ACTIVATION_ID,
  epoch = 1,
  turnId = TURN_ID,
  turnSequence = 1,
  observedAt = '2026-01-01T00:00:01.000Z',
  summary = 'example handoff one',
  evidence = {},
} = {}) {
  return {
    sessionId: SESSION_ID,
    disposition: 'applied',
    projectId: 'example-project',
    identity: { canonicalConversationId: SESSION_ID, provider: 'codex' },
    activation: { id: activationId, epoch },
    turn: { id: turnId, sequence: turnSequence },
    noteRel: 'example-sessions/example-session.md',
    observedAt,
    summary,
    evidence,
  };
}

function fixture({ legacy = false } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'example-memory-lifecycle-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({
    schemaVersion: 2,
    projectId: 'example-project',
  })}\n`);
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), legacy
    ? '# Example legacy memory\n\n- example legacy fact\n'
    : renderSharedMemory());
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), '');
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
  writeFileSync(join(brain, 'SESSION_REGISTRY.json'), `${JSON.stringify({
    version: 2,
    sessions: { [SESSION_ID]: registryEntry() },
  }, null, 2)}\n`);
  return { vault, brain, registryPath: join(brain, 'SESSION_REGISTRY.json') };
}

function readRegistry(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeRegistry(path, registry) {
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
}

test('[req:MEM-STOP-5] [sensor:session-memory-lifecycle] outbox is durable before the registry acknowledges enqueued', () => {
  const calls = [];
  let durable = false;
  const registry = { version: 2, sessions: { [SESSION_ID]: registryEntry() } };
  const fakeEvent = { event_id: 'example-event-1' };

  const attempt = stageStopMemoryAttempt('example-vault', context(), {
    detectMemoryMode: () => ({ mode: 'v2', reason: 'example-v2' }),
    buildSessionMemoryEvents: () => [fakeEvent],
    enqueueMemoryEvent: (_vault, event) => {
      calls.push(`enqueue:${event.event_id}`);
      durable = true;
      return { status: 'enqueued', eventId: event.event_id };
    },
    mutateSessionRegistry: (_vault, mutator) => {
      const result = mutator(registry);
      assert.equal(durable, true, 'registry cannot acknowledge an event before its durable enqueue');
      calls.push(`persist:${registry.sessions[SESSION_ID].last_memory_attempt.state}`);
      return result;
    },
  });

  assert.deepEqual(calls, ['enqueue:example-event-1', 'persist:enqueued']);
  assert.equal(attempt.state, 'enqueued');
  assert.deepEqual(registry.sessions[SESSION_ID].last_memory_attempt.event_ids, ['example-event-1']);
});

test('[req:MEM-STOP-3] [req:MEM-STOP-5] [sensor:session-memory-lifecycle] retry reuses the frozen attempt when clock and evidence change', () => {
  const { vault, brain, registryPath } = fixture();
  let builds = 0;
  const deps = {
    buildSessionMemoryEvents: (handoff) => {
      builds += 1;
      return buildSessionMemoryEvents(handoff);
    },
  };

  try {
    const first = stageStopMemoryAttempt(vault, context(), deps);
    const outboxPath = join(brain, 'memory-outbox', `${first.event_ids[0]}.json`);
    const frozenPayload = readFileSync(outboxPath);
    const degraded = projectStopMemoryAttempt(vault, first, {
      projectMemoryOutbox: () => { throw new Error('example projector failure'); },
    });
    recordStopMemoryOutcome(vault, first, degraded);

    const retry = stageStopMemoryAttempt(vault, context({
      observedAt: '2026-01-01T00:09:59.000Z',
      summary: 'example handoff changed after staging',
      evidence: { nextAction: { id: 'example-next', summary: 'example next changed' } },
    }), deps);

    assert.equal(builds, 1, 'retry must not rebuild a payload that is already frozen in the outbox');
    assert.deepEqual(retry.event_ids, first.event_ids);
    assert.deepEqual(readFileSync(outboxPath), frozenPayload);
    assert.equal(readRegistry(registryPath).sessions[SESSION_ID].last_memory_attempt.state, 'degraded');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-STOP-3] [req:MEM-STOP-5] [sensor:session-memory-lifecycle] degraded busy attempt replays exactly once', () => {
  const { vault, brain, registryPath } = fixture();
  try {
    const staged = stageStopMemoryAttempt(vault, context());
    const busy = projectStopMemoryAttempt(vault, staged, {
      projectMemoryOutbox: () => ({ status: 'busy', pending: staged.event_ids.length }),
    });
    const recordedBusy = recordStopMemoryOutcome(vault, staged, busy);

    assert.equal(recordedBusy.persisted, true);
    assert.equal(readRegistry(registryPath).sessions[SESSION_ID].last_memory_attempt.state, 'degraded');
    assert.ok(existsSync(join(brain, 'memory-outbox', `${staged.event_ids[0]}.json`)));

    const retry = stageStopMemoryAttempt(vault, context({
      observedAt: '2026-01-01T00:01:00.000Z',
      summary: 'example retry must not replace the frozen handoff',
    }));
    const projected = projectStopMemoryAttempt(vault, retry);
    const recorded = recordStopMemoryOutcome(vault, retry, projected);
    const registry = readRegistry(registryPath);

    assert.equal(recorded.persisted, true);
    assert.equal(projected.state, 'projected');
    assert.deepEqual(retry.event_ids, staged.event_ids);
    assert.deepEqual(readMemoryLedger(vault).events.map((event) => event.event_id), staged.event_ids);
    assert.equal(registry.sessions[SESSION_ID].memory_status, 'projected');
    assert.equal(registry.sessions[SESSION_ID].memory_checkpoint.revision, 1);
    assert.equal(readdirSync(join(brain, 'memory-outbox')).length, 0);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-STOP-3] [sensor:session-memory-lifecycle] projected turn becomes a byte-stable duplicate', () => {
  const { vault, brain, registryPath } = fixture();
  try {
    const staged = stageStopMemoryAttempt(vault, context());
    const projected = projectStopMemoryAttempt(vault, staged);
    recordStopMemoryOutcome(vault, staged, projected);
    const ledgerBefore = readFileSync(join(brain, 'MEMORY_EVENTS.jsonl'));
    const sharedBefore = readFileSync(join(brain, 'SHARED_MEMORY.md'));
    const registryBefore = readFileSync(registryPath);

    const duplicate = stageStopMemoryAttempt(vault, context({
      observedAt: '2026-01-01T23:59:59.000Z',
      summary: 'example duplicate with different transient inputs',
    }));
    const duplicateOutcome = projectStopMemoryAttempt(vault, duplicate, {
      projectMemoryOutbox: () => { throw new Error('duplicate must not invoke the projector'); },
    });
    const recorded = recordStopMemoryOutcome(vault, duplicate, duplicateOutcome);

    assert.equal(duplicate.state, 'duplicate');
    assert.deepEqual(duplicate.event_ids, staged.event_ids);
    assert.equal(recorded.persisted, false);
    assert.deepEqual(readFileSync(join(brain, 'MEMORY_EVENTS.jsonl')), ledgerBefore);
    assert.deepEqual(readFileSync(join(brain, 'SHARED_MEMORY.md')), sharedBefore);
    assert.deepEqual(readFileSync(registryPath), registryBefore);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-STOP-4] [sensor:session-memory-lifecycle] stale outcome cannot overwrite a newer activation checkpoint', () => {
  const { vault, registryPath } = fixture();
  try {
    const staged = stageStopMemoryAttempt(vault, context());
    const projected = projectStopMemoryAttempt(vault, staged);
    const registry = readRegistry(registryPath);
    const newerCheckpoint = {
      revision: 99,
      event_cursor: 'example-newer-cursor',
      state_hash: 'a'.repeat(64),
    };
    registry.sessions[SESSION_ID] = {
      ...registry.sessions[SESSION_ID],
      ...registryEntry({
        activationId: 'example-activation-2',
        epoch: 2,
        turnId: 'example-turn-2',
        turnSequence: 2,
      }),
      memory_status: 'projected',
      memory_activation_id: 'example-activation-2',
      memory_checkpoint: newerCheckpoint,
      last_memory_attempt: {
        v: 1,
        memory_mode: 'v2',
        canonical_session_id: SESSION_ID,
        activation_id: 'example-activation-2',
        activation_epoch: 2,
        turn_id: 'example-turn-2',
        turn_sequence: 2,
        disposition: 'applied',
        state: 'projected',
        event_ids: ['example-newer-event'],
        observed_at: '2026-01-01T00:00:02.000Z',
        checkpoint: newerCheckpoint,
      },
    };
    writeRegistry(registryPath, registry);
    const registryBefore = readFileSync(registryPath);

    const recorded = recordStopMemoryOutcome(vault, staged, projected);

    assert.equal(recorded.persisted, false);
    assert.equal(recorded.reason, 'stale-causal-context');
    assert.deepEqual(readFileSync(registryPath), registryBefore);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-STOP-5] [req:MEM-STOP-6] [sensor:session-memory-lifecycle] ambiguous v2 skip is persisted for diagnostics', () => {
  const { vault, brain, registryPath } = fixture();
  try {
    const registry = readRegistry(registryPath);
    registry.sessions[SESSION_ID].active_activation_id = '';
    registry.sessions[SESSION_ID].activations[ACTIVATION_ID].status = 'done';
    registry.sessions[SESSION_ID].memory_status = 'legacy';
    writeRegistry(registryPath, registry);

    const skipped = stageStopMemoryAttempt(vault, {
      ...context(),
      disposition: 'ambiguous',
    });
    const recorded = readRegistry(registryPath).sessions[SESSION_ID];

    assert.equal(skipped.state, 'skipped');
    assert.equal(skipped.disposition, 'ambiguous');
    assert.equal(recorded.last_memory_attempt.memory_mode, 'v2');
    assert.equal(recorded.last_memory_attempt.state, 'skipped');
    assert.equal(recorded.last_memory_attempt.disposition, 'ambiguous');
    assert.equal(recorded.memory_status, 'skipped', 'a v2 Stop cannot leave the flat view as legacy');
    assert.equal(existsSync(join(brain, 'memory-outbox')), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-STOP-4] [req:MEM-STOP-6] [sensor:session-memory-lifecycle] older ambiguous skip preserves a newer attempt', () => {
  const { vault, registryPath } = fixture();
  try {
    const registry = readRegistry(registryPath);
    const newerCheckpoint = {
      revision: 2,
      event_cursor: 'example-newer-cursor',
      state_hash: 'b'.repeat(64),
    };
    registry.sessions[SESSION_ID] = {
      ...registry.sessions[SESSION_ID],
      ...registryEntry({
        activationId: 'example-activation-2',
        epoch: 2,
        turnId: 'example-turn-2',
        turnSequence: 2,
      }),
      memory_status: 'projected',
      memory_activation_id: 'example-activation-2',
      memory_checkpoint: newerCheckpoint,
      last_memory_attempt: {
        v: 1,
        memory_mode: 'v2',
        canonical_session_id: SESSION_ID,
        activation_id: 'example-activation-2',
        activation_epoch: 2,
        turn_id: 'example-turn-2',
        turn_sequence: 2,
        disposition: 'applied',
        state: 'projected',
        event_ids: ['example-newer-event'],
        observed_at: '2026-01-01T00:00:02.000Z',
        checkpoint: newerCheckpoint,
      },
    };
    writeRegistry(registryPath, registry);
    const registryBefore = readFileSync(registryPath);

    const skipped = stageStopMemoryAttempt(vault, {
      ...context(),
      disposition: 'ambiguous',
    });

    assert.equal(skipped.state, 'skipped');
    assert.equal(skipped.disposition, 'ambiguous');
    assert.deepEqual(readFileSync(registryPath), registryBefore);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-STOP-5] [sensor:session-memory-lifecycle] legacy mode is inert across all phases', () => {
  const { vault, registryPath } = fixture({ legacy: true });
  try {
    const registryBefore = readFileSync(registryPath);
    const inert = stageStopMemoryAttempt(vault, context(), {
      buildSessionMemoryEvents: () => { throw new Error('legacy cannot build events'); },
      enqueueMemoryEvent: () => { throw new Error('legacy cannot enqueue events'); },
      mutateSessionRegistry: () => { throw new Error('legacy cannot mutate registry'); },
    });
    const outcome = projectStopMemoryAttempt(vault, inert, {
      projectMemoryOutbox: () => { throw new Error('legacy cannot project'); },
    });
    const recorded = recordStopMemoryOutcome(vault, inert, outcome, {
      mutateSessionRegistry: () => { throw new Error('legacy cannot record'); },
    });

    assert.equal(inert.memory_mode, 'legacy');
    assert.equal(inert.state, 'skipped');
    assert.equal(outcome.status, 'legacy');
    assert.equal(recorded.persisted, false);
    assert.deepEqual(readFileSync(registryPath), registryBefore);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
