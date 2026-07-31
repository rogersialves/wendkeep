import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalMemoryJson,
  prepareMemoryProjection,
  reduceMemoryEvents,
} from '../hooks/memory-store.mjs';
import { recoverProjectedAttempt } from '../src/memory.mjs';
import { renderCoreSkeleton } from '../src/validate-core.mjs';

const PROJECT_ID = 'synthetic-topology-project';
const SESSION_ID = 'synthetic-topology-session';
const ACTIVATION_ID = 'synthetic-topology-activation';
const TURN_ID = 'synthetic-topology-turn';
const EVENT_ID = 'synthetic-topology-event';
const OBSERVED_AT = '2026-07-30T15:00:00.000Z';
const UNSAFE_TOPOLOGY = /hardlink|nlink|link simbólico|junction|reparse|redirecion/i;
const LINK_UNAVAILABLE = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV']);

function checkpointFor(events) {
  const reduced = reduceMemoryEvents(events);
  return {
    revision: reduced.revision,
    event_cursor: reduced.eventCursor,
    state_hash: reduced.stateHash,
  };
}

function createFixture() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-recover-topology-vault-'));
  const outside = mkdtempSync(join(tmpdir(), 'wk-recover-topology-outside-'));
  const brain = join(vault, '.brain');
  const outbox = join(brain, 'memory-outbox');
  mkdirSync(outbox, { recursive: true });

  const event = {
    v: 1,
    project_id: PROJECT_ID,
    event_id: EVENT_ID,
    memory_key: 'handoff.latest',
    operation: 'assert',
    value: 'synthetic topology handoff',
    authority: 'reported',
    canonical_session_id: SESSION_ID,
    activation_id: ACTIVATION_ID,
    activation_epoch: 1,
    turn_sequence: 1,
    source_turn_id: TURN_ID,
    observed_at: OBSERVED_AT,
    evidence: ['synthetic-topology-evidence'],
  };
  const projection = prepareMemoryProjection(vault, [event]);
  const paths = {
    project: join(brain, 'PROJECT.json'),
    core: join(brain, 'CORE.md'),
    ledger: join(brain, 'MEMORY_EVENTS.jsonl'),
    shared: join(brain, 'SHARED_MEMORY.md'),
    candidates: join(brain, 'MEMORY_CANDIDATES.jsonl'),
    registry: join(brain, 'SESSION_REGISTRY.json'),
    outbox,
  };
  writeFileSync(paths.project, `${JSON.stringify({
    schemaVersion: 2,
    projectId: PROJECT_ID,
  })}\n`);
  writeFileSync(paths.core, renderCoreSkeleton());
  writeFileSync(paths.ledger, `${canonicalMemoryJson(event)}\n`);
  writeFileSync(paths.shared, projection.sharedContent);
  writeFileSync(paths.candidates, projection.candidatesContent);
  writeFileSync(paths.registry, `${JSON.stringify({
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
        memory_status: 'enqueued',
        memory_activation_id: ACTIVATION_ID,
        memory_checkpoint: checkpointFor([]),
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
          state: 'enqueued',
          event_ids: [EVENT_ID],
          checkpoint: null,
        },
      },
    },
  }, null, 2)}\n`);

  return { vault, outside, brain, paths };
}

function snapshotAuthority(fixture) {
  const files = {};
  for (const [name, path] of Object.entries(fixture.paths)) {
    if (name === 'outbox') continue;
    files[name] = readFileSync(path);
  }
  return {
    files,
    outboxEntries: readdirSync(fixture.paths.outbox).sort(),
  };
}

function assertNoWrite(before, fixture, outsidePath, outsideBytes) {
  const after = snapshotAuthority(fixture);
  assert.deepEqual(after.files.registry, before.files.registry, 'registry fica byte-idêntico');
  assert.deepEqual(after, before, 'nenhum artefato de autoridade é alterado');
  assert.equal(existsSync(outsidePath), true, 'origem externa continua existindo');
  assert.deepEqual(readFileSync(outsidePath), outsideBytes, 'origem externa fica byte-idêntica');
}

function replaceFileWithLink(fixture, name, kind) {
  const target = fixture.paths[name];
  const bytes = readFileSync(target);
  const outsidePath = join(fixture.outside, `${kind}-${name}`);
  writeFileSync(outsidePath, bytes);
  unlinkSync(target);
  if (kind === 'hardlink') linkSync(outsidePath, target);
  else symlinkSync(outsidePath, target, 'file');
  return { outsidePath, outsideBytes: bytes };
}

function rejectApplyWithoutWrites(fixture, outsidePath, outsideBytes) {
  const before = snapshotAuthority(fixture);
  let thrown;
  try {
    recoverProjectedAttempt(fixture.vault, {
      sessionId: SESSION_ID,
      apply: true,
    });
  } catch (error) {
    thrown = error;
  }
  assertNoWrite(before, fixture, outsidePath, outsideBytes);
  assert.ok(thrown, 'apply deve falhar fechado em topologia insegura');
  assert.match(String(thrown?.message || thrown), UNSAFE_TOPOLOGY);
}

test('[req:MEM-ACK-3] [sensor:memory-recovery] recover-attempt rejeita hardlinks em toda autoridade baseada em arquivo', async (t) => {
  for (const name of ['ledger', 'shared', 'candidates', 'registry']) {
    await t.test(name, (subtest) => {
      const fixture = createFixture();
      try {
        let linked;
        try {
          linked = replaceFileWithLink(fixture, name, 'hardlink');
        } catch (error) {
          if (LINK_UNAVAILABLE.has(error?.code)) {
            subtest.skip(`hardlink indisponível neste filesystem: ${error.code}`);
            return;
          }
          throw error;
        }
        rejectApplyWithoutWrites(
          fixture, linked.outsidePath, linked.outsideBytes,
        );
      } finally {
        rmSync(fixture.vault, { recursive: true, force: true });
        rmSync(fixture.outside, { recursive: true, force: true });
      }
    });
  }
});

test('[req:MEM-ACK-3] [sensor:memory-recovery] recover-attempt rejeita symlinks em toda autoridade baseada em arquivo', async (t) => {
  for (const name of ['ledger', 'shared', 'candidates', 'registry']) {
    await t.test(name, (subtest) => {
      const fixture = createFixture();
      try {
        let linked;
        try {
          linked = replaceFileWithLink(fixture, name, 'symlink');
        } catch (error) {
          if (LINK_UNAVAILABLE.has(error?.code)) {
            subtest.skip(`symlink indisponível neste filesystem: ${error.code}`);
            return;
          }
          throw error;
        }
        rejectApplyWithoutWrites(
          fixture, linked.outsidePath, linked.outsideBytes,
        );
      } finally {
        rmSync(fixture.vault, { recursive: true, force: true });
        rmSync(fixture.outside, { recursive: true, force: true });
      }
    });
  }
});

test('[req:MEM-ACK-3] [sensor:memory-recovery] recover-attempt rejeita outbox redirecionada por junction', (t) => {
  const fixture = createFixture();
  try {
    const outsidePath = join(fixture.outside, 'sentinel.json');
    const outsideBytes = Buffer.from('{"synthetic":"outside-outbox"}\n');
    writeFileSync(outsidePath, outsideBytes);
    rmSync(fixture.paths.outbox, { recursive: true, force: true });
    try {
      symlinkSync(
        fixture.outside,
        fixture.paths.outbox,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (LINK_UNAVAILABLE.has(error?.code)) {
        t.skip(`junction/symlink de diretório indisponível neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    rejectApplyWithoutWrites(fixture, outsidePath, outsideBytes);
  } finally {
    rmSync(fixture.vault, { recursive: true, force: true });
    rmSync(fixture.outside, { recursive: true, force: true });
  }
});

test('[req:MEM-ACK-3] [sensor:memory-recovery] recover-attempt rejeita membro hardlinked no namespace físico da outbox', (t) => {
  const fixture = createFixture();
  try {
    const outsidePath = join(fixture.outside, 'other-attempt.json');
    const outsideBytes = Buffer.from('{"synthetic":"other-attempt"}\n');
    writeFileSync(outsidePath, outsideBytes);
    try {
      linkSync(outsidePath, join(fixture.paths.outbox, 'synthetic-other-event.json'));
    } catch (error) {
      if (LINK_UNAVAILABLE.has(error?.code)) {
        t.skip(`hardlink indisponível neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    rejectApplyWithoutWrites(fixture, outsidePath, outsideBytes);
  } finally {
    rmSync(fixture.vault, { recursive: true, force: true });
    rmSync(fixture.outside, { recursive: true, force: true });
  }
});
