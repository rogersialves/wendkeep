import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalMemoryJson,
  prepareMemoryProjection,
  reduceMemoryEvents,
} from '../hooks/memory-store.mjs';
import { renderCoreSkeleton } from '../src/validate-core.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');
const PROJECT_ID = 'synthetic-project-1';
const SESSION_ID = 'synthetic-session-1';
const ACTIVATION_ID = 'synthetic-activation-1';
const TURN_ID = 'synthetic-turn-1';
const EVENT_ID = 'synthetic-event-1';
const OBSERVED_AT = '2026-07-30T12:00:00.000Z';

function checkpointFor(events) {
  const reduced = reduceMemoryEvents(events);
  return {
    revision: reduced.revision,
    event_cursor: reduced.eventCursor,
    state_hash: reduced.stateHash,
  };
}

function createFixture({ state = 'enqueued' } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-synthetic-attempt-recovery-'));
  const brain = join(vault, '.brain');
  const outbox = join(brain, 'memory-outbox');
  mkdirSync(outbox, { recursive: true });
  writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({
    schemaVersion: 2,
    projectId: PROJECT_ID,
  })}\n`);
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());

  const event = {
    v: 1,
    project_id: PROJECT_ID,
    event_id: EVENT_ID,
    memory_key: 'handoff.latest',
    operation: 'assert',
    value: 'synthetic projected handoff',
    authority: 'reported',
    canonical_session_id: SESSION_ID,
    activation_id: ACTIVATION_ID,
    activation_epoch: 1,
    turn_sequence: 1,
    source_turn_id: TURN_ID,
    observed_at: OBSERVED_AT,
    evidence: ['synthetic-evidence-1'],
  };
  const projection = prepareMemoryProjection(vault, [event]);
  const previousCheckpoint = checkpointFor([]);
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), `${canonicalMemoryJson(event)}\n`);
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), projection.sharedContent);
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), projection.candidatesContent);
  writeFileSync(join(brain, 'SESSION_REGISTRY.json'), `${JSON.stringify({
    version: 2,
    sessions: {
      [SESSION_ID]: {
        status: 'active',
        activation_id: ACTIVATION_ID,
        active_activation_id: ACTIVATION_ID,
        activation_epoch: 1,
        last_turn_id: TURN_ID,
        last_turn_sequence: 1,
        last_prompt_turn_id: TURN_ID,
        turn_sequences: { [TURN_ID]: 1 },
        activations: {
          [ACTIVATION_ID]: {
            activation_id: ACTIVATION_ID,
            epoch: 1,
            status: 'active',
            last_turn_sequence: 1,
            last_prompt_turn_id: TURN_ID,
            last_stop_turn_id: TURN_ID,
            last_stop_turn_sequence: 1,
          },
        },
        memory_status: state,
        memory_activation_id: ACTIVATION_ID,
        memory_checkpoint: previousCheckpoint,
        last_memory_attempt: {
          v: 1,
          memory_mode: 'v2',
          canonical_session_id: SESSION_ID,
          activation_id: ACTIVATION_ID,
          activation_epoch: 1,
          turn_id: TURN_ID,
          turn_sequence: 1,
          observed_at: OBSERVED_AT,
          disposition: 'applied',
          state,
          event_ids: [EVENT_ID],
          checkpoint: null,
        },
      },
    },
  }, null, 2)}\n`);

  return {
    vault,
    brain,
    outbox,
    checkpoint: projection.checkpoint,
    event,
    paths: {
      registry: join(brain, 'SESSION_REGISTRY.json'),
      ledger: join(brain, 'MEMORY_EVENTS.jsonl'),
      core: join(brain, 'CORE.md'),
      shared: join(brain, 'SHARED_MEMORY.md'),
      candidates: join(brain, 'MEMORY_CANDIDATES.jsonl'),
      project: join(brain, 'PROJECT.json'),
    },
  };
}

function snapshotDirectory(path) {
  if (!existsSync(path)) return null;
  const snapshot = {};
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = null;
        visit(target, relative);
      } else {
        snapshot[relative] = readFileSync(target);
      }
    }
  }
  visit(path);
  return snapshot;
}

function snapshotFixture(fixture, { includeLock = false } = {}) {
  return {
    registry: readFileSync(fixture.paths.registry),
    ledger: readFileSync(fixture.paths.ledger),
    core: readFileSync(fixture.paths.core),
    shared: readFileSync(fixture.paths.shared),
    candidates: readFileSync(fixture.paths.candidates),
    project: readFileSync(fixture.paths.project),
    outbox: snapshotDirectory(fixture.outbox),
    ...(includeLock ? { lock: snapshotDirectory(join(fixture.brain, 'MEMORY.lock')) } : {}),
  };
}

function readRegistry(fixture) {
  return JSON.parse(readFileSync(fixture.paths.registry, 'utf8'));
}

function writeRegistry(fixture, registry) {
  writeFileSync(fixture.paths.registry, `${JSON.stringify(registry, null, 2)}\n`);
}

function writeLedgerAndProjection(fixture, events, ledgerContent) {
  const projection = prepareMemoryProjection(fixture.vault, events);
  writeFileSync(
    fixture.paths.ledger,
    ledgerContent ?? `${events.map(canonicalMemoryJson).join('\n')}${events.length ? '\n' : ''}`,
  );
  writeFileSync(fixture.paths.shared, projection.sharedContent);
  writeFileSync(fixture.paths.candidates, projection.candidatesContent);
  return projection;
}

function assertRejectedWithoutWrites(fixture, action, error, message) {
  const before = snapshotFixture(fixture);
  let thrown;
  try {
    action();
  } catch (caught) {
    thrown = caught;
  }
  assert.deepEqual(snapshotFixture(fixture), before, message);
  assert.ok(thrown, `${message}: expected recovery to reject`);
  assert.match(String(thrown?.message || thrown), error);
}

function runRecoverAttempt(args) {
  return spawnSync(process.execPath, [BIN, 'memory', 'recover-attempt', ...args], {
    encoding: 'utf8',
  });
}

test('[req:MEM-ACK-2] [req:MEM-ACK-3] [sensor:memory-recovery] recover-attempt repairs an already projected 0.66.3 attempt', async () => {
  const {
    inspectProjectedAttemptRecovery,
    recoverProjectedAttempt,
  } = await import('../src/memory.mjs');
  const fixture = createFixture();
  try {
    const before = snapshotFixture(fixture);

    const inspection = inspectProjectedAttemptRecovery(fixture.vault, {
      sessionId: SESSION_ID,
    });
    assert.equal(inspection.status, 'eligible');
    assert.equal(inspection.eligible, true);
    assert.deepEqual(inspection.checkpoint, fixture.checkpoint);
    assert.deepEqual(snapshotFixture(fixture), before, 'inspect must not change any byte');

    const dryRun = recoverProjectedAttempt(fixture.vault, {
      sessionId: SESSION_ID,
    });
    assert.equal(dryRun.status, 'dry-run');
    assert.equal(dryRun.eligible, true);
    assert.deepEqual(dryRun.checkpoint, fixture.checkpoint);
    assert.deepEqual(snapshotFixture(fixture), before, 'dry-run must not change any byte');

    const applied = recoverProjectedAttempt(fixture.vault, {
      sessionId: SESSION_ID,
      apply: true,
    });
    assert.equal(applied.status, 'applied');
    assert.deepEqual(applied.checkpoint, fixture.checkpoint);

    const afterApply = snapshotFixture(fixture);
    assert.notDeepEqual(afterApply.registry, before.registry, 'apply must update the registry');
    assert.deepEqual(afterApply.ledger, before.ledger, 'ledger stays byte-identical');
    assert.deepEqual(afterApply.core, before.core, 'CORE stays byte-identical');
    assert.deepEqual(afterApply.shared, before.shared, 'SHARED stays byte-identical');
    assert.deepEqual(afterApply.candidates, before.candidates, 'candidates stay byte-identical');
    assert.deepEqual(afterApply.project, before.project, 'project authority stays byte-identical');
    assert.deepEqual(afterApply.outbox, before.outbox, 'empty outbox stays byte-identical');

    const registry = JSON.parse(afterApply.registry.toString('utf8'));
    const recovered = registry.sessions[SESSION_ID];
    assert.equal(recovered.memory_status, 'projected');
    assert.equal(recovered.last_memory_attempt.state, 'projected');
    assert.deepEqual(recovered.last_memory_attempt.checkpoint, fixture.checkpoint);
    assert.deepEqual(recovered.memory_checkpoint, fixture.checkpoint);

    const beforeRetry = snapshotFixture(fixture);
    const retry = recoverProjectedAttempt(fixture.vault, {
      sessionId: SESSION_ID,
      apply: true,
    });
    assert.equal(retry.status, 'unchanged');
    assert.deepEqual(snapshotFixture(fixture), beforeRetry, 'second apply must be byte-idempotent');
  } finally {
    rmSync(fixture.vault, { recursive: true, force: true });
  }
});

test('[req:MEM-ACK-2] [req:MEM-ACK-3] [sensor:memory-recovery] recover-attempt repairs a degraded projected attempt and changes only registry', async () => {
  const { recoverProjectedAttempt } = await import('../src/memory.mjs');
  const fixture = createFixture({ state: 'degraded' });
  try {
    const before = snapshotFixture(fixture);
    const recovered = recoverProjectedAttempt(fixture.vault, {
      sessionId: SESSION_ID,
      apply: true,
    });
    const after = snapshotFixture(fixture);

    assert.equal(recovered.status, 'applied');
    assert.deepEqual(recovered.checkpoint, fixture.checkpoint);
    assert.notDeepEqual(after.registry, before.registry);
    assert.deepEqual(
      { ...after, registry: before.registry },
      before,
      'degraded recovery must not change any artifact outside SESSION_REGISTRY',
    );
    const entry = readRegistry(fixture).sessions[SESSION_ID];
    assert.equal(entry.memory_status, 'projected');
    assert.equal(entry.last_memory_attempt.state, 'projected');
    assert.deepEqual(entry.memory_checkpoint, fixture.checkpoint);
    assert.deepEqual(entry.last_memory_attempt.checkpoint, fixture.checkpoint);
  } finally {
    rmSync(fixture.vault, { recursive: true, force: true });
  }
});

test('[req:MEM-ACK-2] [req:MEM-ACK-3] [sensor:memory-recovery] recover-attempt rejects incomplete or non-unique ledger proof with zero writes', async (t) => {
  const { recoverProjectedAttempt } = await import('../src/memory.mjs');
  const cases = [
    {
      name: 'attempt event id absent from ledger',
      arrange(fixture) {
        const registry = readRegistry(fixture);
        registry.sessions[SESSION_ID].last_memory_attempt.event_ids = ['synthetic-event-missing'];
        writeRegistry(fixture, registry);
      },
      error: /event_ids?.*ausent|ausent.*ledger/i,
    },
    {
      name: 'physically duplicated identical event id',
      arrange(fixture) {
        const line = canonicalMemoryJson(fixture.event);
        writeFileSync(fixture.paths.ledger, `${line}\n${line}\n`);
      },
      error: /duplicad.*event_id|event_id.*duplicad/i,
    },
    {
      name: 'divergent event id collision',
      arrange(fixture) {
        const collision = {
          ...fixture.event,
          value: 'synthetic divergent collision payload',
        };
        writeFileSync(
          fixture.paths.ledger,
          `${canonicalMemoryJson(fixture.event)}\n${canonicalMemoryJson(collision)}\n`,
        );
      },
      error: /collision|colis[aã]o|duplicad/i,
    },
    {
      name: 'partial ledger tail',
      arrange(fixture) {
        writeFileSync(
          fixture.paths.ledger,
          `${canonicalMemoryJson(fixture.event)}\n{"v":1,"event_id":"synthetic-partial-tail"`,
        );
      },
      error: /ledger.*inv[aá]lid|JSON|parcial|partial/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const fixture = createFixture();
      try {
        scenario.arrange(fixture);
        assertRejectedWithoutWrites(
          fixture,
          () => recoverProjectedAttempt(fixture.vault, {
            sessionId: SESSION_ID,
            apply: true,
          }),
          scenario.error,
          `${scenario.name} must leave every artifact byte-identical`,
        );
      } finally {
        rmSync(fixture.vault, { recursive: true, force: true });
      }
    });
  }
});

test('[req:MEM-ACK-2] [req:MEM-ACK-3] [sensor:memory-recovery] recover-attempt isolates each divergent causal identity field with zero writes', async (t) => {
  const { recoverProjectedAttempt } = await import('../src/memory.mjs');
  const cases = [
    ['project_id', 'synthetic-project-divergent'],
    ['canonical_session_id', 'synthetic-session-divergent'],
    ['activation_id', 'synthetic-activation-divergent'],
    ['activation_epoch', 2],
    ['source_turn_id', 'synthetic-turn-divergent'],
    ['turn_sequence', 2],
  ];

  for (const [field, divergentValue] of cases) {
    await t.test(field, () => {
      const fixture = createFixture();
      try {
        const divergentEvent = { ...fixture.event, [field]: divergentValue };
        writeLedgerAndProjection(fixture, [divergentEvent]);
        assertRejectedWithoutWrites(
          fixture,
          () => recoverProjectedAttempt(fixture.vault, {
            sessionId: SESSION_ID,
            apply: true,
          }),
          /projeto|project|identidade causal|contexto causal/i,
          `${field} divergence must leave every artifact byte-identical`,
        );
      } finally {
        rmSync(fixture.vault, { recursive: true, force: true });
      }
    });
  }
});

test('[req:MEM-ACK-2] [req:MEM-ACK-3] [sensor:memory-recovery] recover-attempt rejects stale deriveds and target outbox ownership with zero writes', async (t) => {
  const { recoverProjectedAttempt } = await import('../src/memory.mjs');
  const cases = [
    {
      name: 'SHARED stale',
      arrange(fixture) {
        writeFileSync(fixture.paths.shared, `${readFileSync(fixture.paths.shared, 'utf8')}synthetic stale SHARED\n`);
      },
      error: /SHARED.*diverg|SHARED.*autoridade/i,
    },
    {
      name: 'candidates stale',
      arrange(fixture) {
        writeFileSync(fixture.paths.candidates, '{"synthetic":"stale-candidates"}\n');
      },
      error: /candidates.*diverg|candidates.*autoridade/i,
    },
    {
      name: 'target event remains in outbox',
      arrange(fixture) {
        writeFileSync(
          join(fixture.outbox, `${EVENT_ID}.json`),
          `${canonicalMemoryJson(fixture.event)}\n`,
        );
      },
      error: /outbox.*evento alvo|evento alvo.*outbox/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const fixture = createFixture();
      try {
        scenario.arrange(fixture);
        assertRejectedWithoutWrites(
          fixture,
          () => recoverProjectedAttempt(fixture.vault, {
            sessionId: SESSION_ID,
            apply: true,
          }),
          scenario.error,
          `${scenario.name} must leave every artifact byte-identical`,
        );
      } finally {
        rmSync(fixture.vault, { recursive: true, force: true });
      }
    });
  }
});

test('[req:MEM-ACK-3] [sensor:memory-recovery] recover-attempt rejects a target event stored under a non-canonical safe outbox name with zero writes', async () => {
  const { recoverProjectedAttempt } = await import('../src/memory.mjs');
  const fixture = createFixture();
  try {
    writeFileSync(
      join(fixture.outbox, 'misnamed.json'),
      `${canonicalMemoryJson(fixture.event)}\n`,
    );

    assertRejectedWithoutWrites(
      fixture,
      () => recoverProjectedAttempt(fixture.vault, {
        sessionId: SESSION_ID,
        apply: true,
      }),
      /outbox.*evento alvo|evento alvo.*outbox/i,
      'misnamed target outbox event must leave registry, ledger, SHARED, candidates, and outbox byte-identical',
    );
  } finally {
    rmSync(fixture.vault, { recursive: true, force: true });
  }
});

test('[req:MEM-ACK-3] [sensor:memory-recovery] recover-attempt loses CAS for each newer registry dimension and preserves the injected bytes', async (t) => {
  const { recoverProjectedAttempt } = await import('../src/memory.mjs');
  const newerCheckpoint = {
    revision: 41,
    event_cursor: 'synthetic-event-newer-checkpoint',
    causal_event_cursor: 'synthetic-event-newer-checkpoint',
    state_hash: 'synthetic-state-newer-checkpoint',
  };
  const cases = [
    {
      name: 'newer activation',
      mutate(entry) {
        entry.active_activation_id = 'synthetic-activation-newer';
        entry.activation_epoch = 2;
        entry.activations['synthetic-activation-newer'] = {
          activation_id: 'synthetic-activation-newer',
          epoch: 2,
          status: 'active',
          last_turn_sequence: 0,
        };
      },
    },
    {
      name: 'newer epoch',
      mutate(entry) {
        entry.activation_epoch = 2;
        entry.activations[ACTIVATION_ID].epoch = 2;
      },
    },
    {
      name: 'newer turn',
      mutate(entry) {
        entry.last_turn_id = 'synthetic-turn-newer';
        entry.last_turn_sequence = 2;
        entry.turn_sequences['synthetic-turn-newer'] = 2;
        entry.activations[ACTIVATION_ID].last_turn_sequence = 2;
        entry.activations[ACTIVATION_ID].last_stop_turn_id = 'synthetic-turn-newer';
        entry.activations[ACTIVATION_ID].last_stop_turn_sequence = 2;
      },
    },
    {
      name: 'newer attempt',
      mutate(entry) {
        entry.last_memory_attempt = {
          ...entry.last_memory_attempt,
          observed_at: '2026-07-30T12:01:00.000Z',
        };
      },
    },
    {
      name: 'newer checkpoint',
      mutate(entry) {
        entry.memory_checkpoint = newerCheckpoint;
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const fixture = createFixture();
      let injectedSnapshot;
      let thrown;
      try {
        try {
          recoverProjectedAttempt(fixture.vault, {
            sessionId: SESSION_ID,
            apply: true,
            beforeRegistryMutation() {
              const registry = readRegistry(fixture);
              scenario.mutate(registry.sessions[SESSION_ID]);
              writeRegistry(fixture, registry);
              injectedSnapshot = snapshotFixture(fixture);
            },
          });
        } catch (caught) {
          thrown = caught;
        }

        assert.ok(injectedSnapshot, `${scenario.name} must execute the deterministic race hook`);
        assert.deepEqual(
          snapshotFixture(fixture),
          injectedSnapshot,
          `${scenario.name} must not be overwritten or supplemented by recovery`,
        );
        assert.ok(thrown, `${scenario.name} must reject the lost CAS`);
        assert.match(String(thrown.message || thrown), /CAS|contexto causal|attempt|checkpoint|mudou/i);
      } finally {
        rmSync(fixture.vault, { recursive: true, force: true });
      }
    });
  }
});

test('[req:MEM-ACK-3] [sensor:memory-recovery] recover-attempt detects an exact A-B-A registry race with zero recovery writes', async () => {
  const { recoverProjectedAttempt } = await import('../src/memory.mjs');
  const fixture = createFixture();
  let restoredSnapshot;
  let thrown;
  try {
    try {
      recoverProjectedAttempt(fixture.vault, {
        sessionId: SESSION_ID,
        apply: true,
        beforeRegistryMutation() {
          const original = readFileSync(fixture.paths.registry);
          const registry = JSON.parse(original.toString('utf8'));
          registry.sessions[SESSION_ID].activation_id = 'synthetic-activation-b';
          writeRegistry(fixture, registry);
          writeFileSync(fixture.paths.registry, original);
          restoredSnapshot = snapshotFixture(fixture);
        },
      });
    } catch (caught) {
      thrown = caught;
    }

    assert.ok(restoredSnapshot, 'A-B-A hook must execute');
    const after = snapshotFixture(fixture);
    assert.deepEqual(
      { ...after, registry: restoredSnapshot.registry },
      restoredSnapshot,
      'exact A-B-A must leave every non-registry artifact byte-identical',
    );
    assert.equal(
      after.registry.equals(restoredSnapshot.registry),
      true,
      'exact A-B-A must not be followed by a recovery registry write',
    );
    assert.ok(thrown, 'exact A-B-A must reject the lost CAS');
    assert.match(String(thrown.message || thrown), /CAS|A-B-A|mudou/i);
  } finally {
    rmSync(fixture.vault, { recursive: true, force: true });
  }
});

test('[req:MEM-ACK-3] [sensor:memory-recovery] MEMORY.lock busy rejects recover-attempt and preserves every artifact including the lock', async () => {
  const { recoverProjectedAttempt } = await import('../src/memory.mjs');
  const fixture = createFixture();
  const lock = join(fixture.brain, 'MEMORY.lock');
  try {
    mkdirSync(lock);
    const before = snapshotFixture(fixture, { includeLock: true });
    let thrown;
    try {
      recoverProjectedAttempt(fixture.vault, {
        sessionId: SESSION_ID,
        apply: true,
        memoryLock: { timeoutMs: 20, staleMs: 60_000 },
      });
    } catch (caught) {
      thrown = caught;
    }

    assert.deepEqual(
      snapshotFixture(fixture, { includeLock: true }),
      before,
      'busy MEMORY.lock and every memory artifact must remain byte-identical',
    );
    assert.ok(thrown, 'busy MEMORY.lock must reject recovery');
    assert.equal(thrown.code, 'WENDKEEP_MEMORY_LOCK_BUSY');
    assert.match(thrown.message, /MEMORY\.lock.*indispon[ií]vel|lock.*ocupad/i);
  } finally {
    rmSync(fixture.vault, { recursive: true, force: true });
  }
});

test('[req:MEM-ACK-3] [sensor:memory-recovery] projected retry keeps its valid historical checkpoint instead of refreshing to the ledger tip', async () => {
  const {
    inspectProjectedAttemptRecovery,
    recoverProjectedAttempt,
  } = await import('../src/memory.mjs');
  const fixture = createFixture();
  try {
    const laterEvent = {
      ...fixture.event,
      event_id: 'synthetic-event-later-other-session',
      memory_key: 'handoff.other.latest',
      value: 'synthetic later handoff from another session',
      canonical_session_id: 'synthetic-session-other',
      activation_id: 'synthetic-activation-other',
      source_turn_id: 'synthetic-turn-other',
      observed_at: '2026-07-30T12:02:00.000Z',
    };
    const latestProjection = writeLedgerAndProjection(fixture, [fixture.event, laterEvent]);
    assert.notDeepEqual(latestProjection.checkpoint, fixture.checkpoint);

    const registry = readRegistry(fixture);
    const entry = registry.sessions[SESSION_ID];
    entry.memory_status = 'projected';
    entry.memory_checkpoint = fixture.checkpoint;
    entry.last_memory_attempt.state = 'projected';
    entry.last_memory_attempt.checkpoint = fixture.checkpoint;
    writeRegistry(fixture, registry);
    const before = snapshotFixture(fixture);

    const inspection = inspectProjectedAttemptRecovery(fixture.vault, {
      sessionId: SESSION_ID,
    });
    assert.equal(inspection.status, 'unchanged');
    assert.deepEqual(inspection.checkpoint, fixture.checkpoint);
    assert.deepEqual(snapshotFixture(fixture), before);

    const retry = recoverProjectedAttempt(fixture.vault, {
      sessionId: SESSION_ID,
      apply: true,
    });
    assert.equal(retry.status, 'unchanged');
    assert.deepEqual(retry.checkpoint, fixture.checkpoint);
    assert.notDeepEqual(retry.checkpoint, latestProjection.checkpoint);
    assert.deepEqual(
      snapshotFixture(fixture),
      before,
      'projected retry must preserve every byte and the historical checkpoint',
    );
  } finally {
    rmSync(fixture.vault, { recursive: true, force: true });
  }
});

test('[req:MEM-ACK-2] [sensor:memory-recovery] CLI recover-attempt dry-run reports status without changing Vault bytes', () => {
  const fixture = createFixture();
  try {
    const before = snapshotFixture(fixture);
    const result = runRecoverAttempt([SESSION_ID, '--vault', fixture.vault]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'dry-run');
    assert.deepEqual(snapshotFixture(fixture), before, 'CLI dry-run must not change any byte');
  } finally {
    rmSync(fixture.vault, { recursive: true, force: true });
  }
});

test('[req:MEM-ACK-2] [req:MEM-ACK-3] [sensor:memory-recovery] CLI recover-attempt apply reports applied and retry is byte-idempotent', () => {
  const fixture = createFixture();
  try {
    const applied = runRecoverAttempt([SESSION_ID, '--apply', '--vault', fixture.vault]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).status, 'applied');

    const beforeRetry = snapshotFixture(fixture);
    const retry = runRecoverAttempt([SESSION_ID, '--apply', '--vault', fixture.vault]);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(JSON.parse(retry.stdout).status, 'unchanged');
    assert.deepEqual(snapshotFixture(fixture), beforeRetry, 'CLI retry must not change any byte');
  } finally {
    rmSync(fixture.vault, { recursive: true, force: true });
  }
});

test('[req:MEM-ACK-2] [sensor:memory-recovery] CLI recover-attempt rejects malformed arguments before touching the Vault', async (t) => {
  const missingVault = join(tmpdir(), `wk-missing-attempt-recovery-${process.pid}-${Date.now()}`);
  const cases = [
    {
      name: 'missing session',
      args: ['--vault', missingVault],
      error: /recover-attempt.*sess[aã]o|sess[aã]o.*obrigat[oó]ri/i,
    },
    {
      name: 'extra positional',
      args: [SESSION_ID, 'synthetic-extra', '--vault', missingVault],
      error: /posicional extra.*synthetic-extra/i,
    },
    {
      name: 'duplicate --apply',
      args: [SESSION_ID, '--apply', '--apply', '--vault', missingVault],
      error: /duplicad.*--apply|--apply.*duplicad/i,
    },
    {
      name: 'duplicate --vault',
      args: [SESSION_ID, '--vault', missingVault, '--vault', missingVault],
      error: /duplicad.*--vault|--vault.*duplicad/i,
    },
    {
      name: 'unknown flag',
      args: [SESSION_ID, '--synthetic-unknown', '--vault', missingVault],
      error: /op[cç][aã]o desconhecida.*--synthetic-unknown/i,
    },
    {
      name: 'flag value starts with --',
      args: [SESSION_ID, '--vault', '--apply'],
      error: /--vault.*valor|valor.*--vault/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const result = runRecoverAttempt(scenario.args);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, scenario.error);
      assert.doesNotMatch(result.stderr, /not found/i);
    });
  }
});
