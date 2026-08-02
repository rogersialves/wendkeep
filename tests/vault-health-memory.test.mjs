import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMemoryBundle } from '../hooks/vault-health.mjs';
import { renderSharedMemory } from '../hooks/memory-schema.mjs';
import { reduceMemoryEvents } from '../hooks/memory-store.mjs';
import { renderCoreSkeleton } from '../src/validate-core.mjs';

const PROJECT_ID = 'project-health';

function event(eventId = 'mem-health-1', extra = {}) {
  return {
    v: 1,
    project_id: PROJECT_ID,
    event_id: eventId,
    memory_key: 'next.ui',
    operation: 'assert',
    value: 'review',
    authority: 'verified',
    canonical_session_id: 'example-session-health',
    activation_id: 'example-activation-health',
    activation_epoch: 1,
    turn_sequence: 1,
    source_turn_id: 'example-turn-health',
    observed_at: '2026-07-26T04:00:00Z',
    evidence: ['tests/vault-health-memory.test.mjs'],
    ...extra,
  };
}

function createBundle(events = [event()]) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-health-memory-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  const reduced = reduceMemoryEvents(events);
  writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID })}\n`);
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  writeFileSync(
    join(brain, 'MEMORY_EVENTS.jsonl'),
    events.length ? `${events.map((item) => JSON.stringify(item)).join('\n')}\n` : '',
  );
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory({
    revision: reduced.revision,
    eventCursor: reduced.eventCursor,
    stateHash: reduced.stateHash,
    events: reduced.activeEvents,
    updatedAt: '2026-07-26T04:00:00Z',
    reviewAfter: '2026-08-02T04:00:00Z',
  }));
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
  return vault;
}

function byteSnapshot(vault) {
  const brain = join(vault, '.brain');
  const entries = [];
  const walk = (dir, rel = '') => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const itemRel = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, itemRel);
      else entries.push([itemRel, readFileSync(path, 'utf8')]);
    }
  };
  walk(brain);
  return entries;
}

function writeLastMemoryAttempt(
  vault,
  attempt,
  sessionId = 'example-session-health',
  entryOverrides = {},
) {
  writeFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), `${JSON.stringify({
    version: 2,
    sessions: {
      [sessionId]: {
        status: 'done',
        session_file: '02-Sessions/example-session.md',
        ...entryOverrides,
        last_memory_attempt: attempt,
      },
    },
  })}\n`);
}

function memoryAttempt(overrides = {}) {
  return {
    v: 1,
    memory_mode: 'v2',
    canonical_session_id: 'example-session-health',
    activation_id: 'example-activation-health',
    activation_epoch: 1,
    turn_id: 'example-turn-health',
    turn_sequence: 1,
    disposition: 'applied',
    state: 'enqueued',
    event_ids: ['mem-health-1'],
    observed_at: '2000-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function checkpointFor(events) {
  const reduced = reduceMemoryEvents(events);
  return {
    revision: reduced.revision,
    event_cursor: reduced.eventCursor,
    state_hash: reduced.stateHash,
  };
}

function createAlias(t, source, target, type = 'hardlink') {
  try {
    if (type === 'hardlink') linkSync(source, target);
    else symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
      t.skip(`${type}s indisponíveis neste filesystem: ${error.code}`);
      return false;
    }
    throw error;
  }
}

test('[req:DIAG-8] doctor names a healthy bundle and reports schema/revision/cursor/hash', () => {
  const vault = createBundle();
  try {
    const before = byteSnapshot(vault);
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, true, result.failures.join('; '));
    assert.equal(result.status, 'healthy');
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.metrics.schemaVersion, 2);
    assert.equal(result.metrics.revision, 1);
    assert.equal(result.metrics.eventCursor, 'mem-health-1');
    assert.match(result.metrics.stateHash, /^[a-f0-9]{64}$/);
    assert.equal(result.metrics.ledgerEvents, 1);
    assert.deepEqual(byteSnapshot(vault), before, 'doctor must be byte-for-byte read-only');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:OP-10] memory health bloqueia .brain junction antes de diagnosticar conteúdo externo', (t) => {
  const sourceVault = createBundle();
  const vault = mkdtempSync(join(tmpdir(), 'wk-health-memory-junction-'));
  const sourceBrain = join(sourceVault, '.brain');
  const brain = join(vault, '.brain');
  try {
    const before = byteSnapshot(sourceVault);
    if (!createAlias(t, sourceBrain, brain, 'junction')) return;

    const result = checkMemoryBundle(vault);

    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.failures.join('\n'), /link simbólico|junction|reparse|Vault/i);
    assert.deepEqual(byteSnapshot(sourceVault), before);
    assert.equal(lstatSync(brain).isSymbolicLink(), true);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(sourceVault, { recursive: true, force: true });
  }
});

test('[req:OP-10] memory health bloqueia hardlinks de candidates e outbox sem ocultá-los como estado válido', async (t) => {
  for (const artifact of ['MEMORY_CANDIDATES.jsonl', 'memory-outbox/event.json']) {
    await t.test(artifact, (subtest) => {
      const vault = createBundle();
      const outside = mkdtempSync(join(tmpdir(), 'wk-health-memory-hardlink-outside-'));
      const brain = join(vault, '.brain');
      try {
        const source = join(outside, 'source');
        const target = join(brain, ...artifact.split('/'));
        if (artifact.startsWith('memory-outbox/')) {
          mkdirSync(join(brain, 'memory-outbox'));
          writeFileSync(source, `${JSON.stringify(event('mem-health-hardlink-outbox'))}\n`);
        } else {
          rmSync(target);
          writeFileSync(source, '');
        }
        const before = readFileSync(source);
        if (!createAlias(subtest, source, target)) return;

        const result = checkMemoryBundle(vault);

        assert.equal(result.ok, false);
        assert.equal(result.status, 'blocked');
        assert.match(result.failures.join('\n'), /hardlink|nlink|Vault/i);
        assert.deepEqual(readFileSync(source), before);
      } finally {
        rmSync(vault, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }
});

test('[req:MEM-STOP-6] [sensor:memory-health] valid revision 0 stays healthy with no attempt or a legacy pre-upgrade attempt', () => {
  const vault = createBundle([]);
  try {
    const absent = checkMemoryBundle(vault);
    assert.equal(absent.ok, true, absent.failures.join('; '));
    assert.equal(absent.status, 'healthy');

    writeLastMemoryAttempt(vault, {
      memory_mode: 'legacy',
      state: 'skipped',
      event_ids: [],
    });
    const legacy = checkMemoryBundle(vault);
    assert.equal(legacy.ok, true, legacy.failures.join('; '));
    assert.equal(legacy.status, 'healthy');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-STOP-6] [sensor:memory-health] ambiguous v2 skip is blocking', () => {
  const vault = createBundle([]);
  try {
    writeLastMemoryAttempt(vault, memoryAttempt({
      disposition: 'ambiguous',
      state: 'skipped',
      event_ids: [],
    }));
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.failures.join('\n'), /amb[ií]gu|lifecycle/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-STOP-5] [req:MEM-STOP-6] [sensor:memory-health] degraded attempt split across ledger and valid outbox is recoverable', () => {
  const projected = event('mem-example-projected', {
    memory_key: 'example.projected', value: 'synthetic projected state',
  });
  const pending = event('mem-example-pending', {
    memory_key: 'example.pending', value: 'synthetic pending state',
  });
  const vault = createBundle([projected]);
  try {
    const outbox = join(vault, '.brain', 'memory-outbox');
    mkdirSync(outbox);
    writeFileSync(join(outbox, `${pending.event_id}.json`), `${JSON.stringify(pending)}\n`);
    writeLastMemoryAttempt(vault, memoryAttempt({
      state: 'degraded',
      event_ids: [projected.event_id, pending.event_id],
      error: 'example-private-payload-must-not-be-rendered',
    }));

    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, true, result.failures.join('; '));
    assert.equal(result.status, 'warning');
    assert.match(result.warnings.join('\n'), /recuper|attempt/i);
    assert.doesNotMatch(JSON.stringify(result), /example-private-payload-must-not-be-rendered/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-ACK-2] [sensor:memory-recovery] health identifies projected acknowledgement pending', () => {
  const previous = event('mem-example-previous-checkpoint', {
    memory_key: 'example.previous', value: 'synthetic previous checkpoint', turn_sequence: 0,
  });
  const projected = event('mem-example-projected-ack-pending', {
    memory_key: 'example.projected-ack', value: 'synthetic projected acknowledgement',
  });
  const vault = createBundle([previous, projected]);
  const brain = join(vault, '.brain');
  const outbox = join(brain, 'memory-outbox');
  try {
    mkdirSync(outbox);
    writeLastMemoryAttempt(vault, memoryAttempt({
      event_ids: [projected.event_id],
      checkpoint: null,
    }), 'example-session-health', {
      memory_status: 'enqueued',
      memory_checkpoint: checkpointFor([previous]),
    });
    const snapshot = () => ({
      registry: readFileSync(join(brain, 'SESSION_REGISTRY.json')),
      ledger: readFileSync(join(brain, 'MEMORY_EVENTS.jsonl')),
      shared: readFileSync(join(brain, 'SHARED_MEMORY.md')),
      outbox: readdirSync(outbox),
    });
    const before = snapshot();

    const result = checkMemoryBundle(vault);

    assert.equal(result.ok, true, result.failures.join('; '));
    assert.equal(result.status, 'warning');
    assert.deepEqual(result.failures, []);
    assert.match(result.warnings.join('\n'), /acknowledgement projetado pendente/i);
    assert.match(result.warnings.join('\n'), /memory recover-attempt example-session-health/i);
    assert.deepEqual(snapshot(), before, 'health must not change registry, ledger, SHARED, or outbox');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:OP-10] [sensor:memory-health] projected attempt fails on registry or event causal identity mismatch', async (t) => {
  const cases = [
    {
      name: 'registry key',
      sessionId: 'borrowed-session-health',
      override: {},
      error: /canonical_session_id|identidade causal/i,
    },
    {
      name: 'activation',
      sessionId: 'example-session-health',
      override: { activation_id: 'borrowed-activation' },
      error: /activation_id|identidade causal/i,
    },
    {
      name: 'epoch',
      sessionId: 'example-session-health',
      override: { activation_epoch: 2 },
      error: /activation_epoch|identidade causal/i,
    },
    {
      name: 'turn',
      sessionId: 'example-session-health',
      override: { turn_id: 'borrowed-turn' },
      error: /source_turn_id|identidade causal/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const item = event();
      const vault = createBundle([item]);
      try {
        writeLastMemoryAttempt(vault, memoryAttempt({
          state: 'projected',
          checkpoint: checkpointFor([item]),
          ...scenario.override,
        }), scenario.sessionId);
        const result = checkMemoryBundle(vault);
        assert.equal(result.status, 'blocked');
        assert.match(result.failures.join('\n'), scenario.error);
      } finally { rmSync(vault, { recursive: true, force: true }); }
    });
  }
});

test('[req:MEM-STOP-6] [sensor:memory-health] applied v2 attempt with no event ids is blocking', () => {
  const vault = createBundle([]);
  try {
    writeLastMemoryAttempt(vault, memoryAttempt({ event_ids: [] }));
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /event_ids|publica[cç][aã]o perdida/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-STOP-6] [sensor:memory-health] attempt event absent from both ledger and outbox is blocking', () => {
  const vault = createBundle([]);
  try {
    writeLastMemoryAttempt(vault, memoryAttempt({ event_ids: ['mem-example-missing'] }));
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /ausente|ledger.*outbox|publica[cç][aã]o perdida/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-STOP-6] [sensor:memory-health] projected checkpoint remains valid when the current projection is newer', () => {
  const attemptEvent = event('mem-example-prefix', {
    memory_key: 'example.prefix', value: 'synthetic prefix state',
  });
  const concurrentCursor = event('mem-example-concurrent-cursor', {
    memory_key: 'example.concurrent', value: 'synthetic concurrent state', turn_sequence: 2,
  });
  const later = event('mem-example-later', {
    memory_key: 'example.later', value: 'synthetic later state', turn_sequence: 3,
  });
  const vault = createBundle([attemptEvent, concurrentCursor, later]);
  try {
    writeLastMemoryAttempt(vault, memoryAttempt({
      state: 'projected',
      event_ids: [attemptEvent.event_id],
      checkpoint: checkpointFor([attemptEvent, concurrentCursor]),
    }));
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, true, result.failures.join('; '));
    assert.equal(result.status, 'healthy');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-STOP-5] [req:MEM-STOP-6] [sensor:memory-health] projected attempt requires its events in the ledger, not only the outbox', () => {
  const pending = event('mem-example-projected-outbox-only', {
    memory_key: 'example.outbox-only', value: 'synthetic outbox-only state',
  });
  const vault = createBundle([]);
  try {
    const outbox = join(vault, '.brain', 'memory-outbox');
    mkdirSync(outbox);
    writeFileSync(join(outbox, `${pending.event_id}.json`), `${JSON.stringify(pending)}\n`);
    writeLastMemoryAttempt(vault, memoryAttempt({
      state: 'projected',
      event_ids: [pending.event_id],
      checkpoint: checkpointFor([pending]),
    }));

    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /projetado.*ledger|ledger.*projetado/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-STOP-6] [sensor:memory-health] projected checkpoint mismatch is blocking', () => {
  const first = event('mem-example-checkpoint', {
    memory_key: 'example.checkpoint', value: 'synthetic checkpoint state',
  });
  const vault = createBundle([first]);
  try {
    writeLastMemoryAttempt(vault, memoryAttempt({
      state: 'projected',
      event_ids: [first.event_id],
      checkpoint: { ...checkpointFor([first]), state_hash: '0'.repeat(64) },
    }));
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /checkpoint|proje[cç][aã]o/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-STOP-6] [sensor:memory-health] stale or superseded skip is non-blocking without emitted events', () => {
  const vault = createBundle([]);
  try {
    writeLastMemoryAttempt(vault, memoryAttempt({
      disposition: 'superseded',
      state: 'skipped',
      event_ids: [],
    }));
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, true, result.failures.join('; '));
    assert.doesNotMatch(result.failures.join('\n'), /publica[cç][aã]o perdida|ausente|checkpoint/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-STOP-5] [req:MEM-STOP-6] [sensor:memory-health] rejected stale attempt with emitted ids is blocking', () => {
  const emitted = event('mem-example-causal-leak', {
    memory_key: 'example.causal-leak', value: 'synthetic rejected state',
  });
  const vault = createBundle([emitted]);
  try {
    writeLastMemoryAttempt(vault, memoryAttempt({
      disposition: 'stale_turn',
      state: 'skipped',
      event_ids: [emitted.event_id],
    }));
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /stale|superseded|causal/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:DIAG-8] [req:MEM-HYB-9] legacy SHARED points to resolved migration and remains read-only', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-health-legacy-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID })}\n`);
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), '# SHARED legado\n\n## Estado\n- private-legacy-content\n');
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), '');
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
  try {
    const before = byteSnapshot(vault);
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, true, result.failures.join('; '));
    assert.equal(result.status, 'legacy');
    assert.deepEqual(result.failures, []);
    const warning = result.warnings.join('\n');
    assert.match(warning, /legado|migra/i);
    assert.ok(warning.includes(`npx --no-install wendkeep memory migrate --apply --vault "${vault}"`));
    assert.doesNotMatch(warning, /<vault>|<cofre>|private-legacy-content/i);
    assert.deepEqual(byteSnapshot(vault), before, 'compatibility diagnosis is read-only');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-HYB-7] a damaged SHARED carrying a v2 signature stays blocking', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-health-v2-signature-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID })}\n`);
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), '---\nschema_version: 2\nstate_hash: broken\n---\n# SHARED incompleto\n');
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), '');
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
  try {
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.failures.join('\n'), /SHARED|revision|event_cursor|se[cç][oõ]es/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-HYB-7] non-empty v2 operational evidence prevents legacy fallback', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-health-v2-evidence-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID })}\n`);
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), '# forma legada incompatível com ledger ativo\n');
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), `${JSON.stringify(event())}\n`);
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
  try {
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.failures.join('\n'), /SHARED|schema_version|proje[cç][aã]o/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-HYB-7] unreadable SHARED is blocking instead of being downgraded to legacy', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-health-shared-unreadable-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID })}\n`);
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  mkdirSync(join(brain, 'SHARED_MEMORY.md'));
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), '');
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
  try {
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.failures.join('\n'), /SHARED_MEMORY\.md ileg[ií]vel/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-HYB-7] unreadable candidates sidecar is reported as blocking, never thrown or ignored', () => {
  const vault = createBundle([]);
  const candidatesPath = join(vault, '.brain', 'MEMORY_CANDIDATES.jsonl');
  rmSync(candidatesPath);
  mkdirSync(candidatesPath);
  try {
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.failures.join('\n'), /MEMORY_CANDIDATES\.jsonl ileg[ií]vel/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:DIAG-8] pending outbox and an ordinary candidate are warnings, not failures', () => {
  const vault = createBundle();
  try {
    const outbox = join(vault, '.brain', 'memory-outbox');
    mkdirSync(outbox);
    writeFileSync(join(outbox, 'mem-pending.json'), `${JSON.stringify(event('mem-pending'))}\n`);
    writeFileSync(join(vault, '.brain', 'MEMORY_CANDIDATES.jsonl'), `${JSON.stringify({
      candidate_id: 'candidate-review', reason: 'reported', memory_key: 'next.ui', status: 'pending',
      value: 'private-candidate-value',
      events: [{ event_id: 'private-candidate-event', value: 'private-candidate-event-value' }],
    })}\n`);

    const before = byteSnapshot(vault);
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, true, result.failures.join('; '));
    assert.equal(result.status, 'warning');
    assert.equal(result.metrics.pendingOutbox, 1);
    assert.equal(result.metrics.candidates, 1);
    const warnings = result.warnings.join('\n');
    assert.match(warnings, /outbox/i);
    assert.match(warnings, /candidate/i);
    assert.doesNotMatch(
      warnings,
      /<vault>|<cofre>|private-candidate-value|private-candidate-event|private-candidate-event-value/i,
    );
    assert.deepEqual(byteSnapshot(vault), before);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:DIAG-8] corrupt/partial ledger is blocking and points to safe repair', () => {
  const vault = createBundle();
  try {
    writeFileSync(
      join(vault, '.brain', 'MEMORY_EVENTS.jsonl'),
      `${JSON.stringify(event())}\n{"v":1,"value":"private-corrupt-payload"`,
    );
    const before = byteSnapshot(vault);
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    const failures = result.failures.join('\n');
    assert.match(failures, /linha 2|partial|parcial/i);
    assert.ok(failures.includes(`npx --no-install wendkeep memory repair --vault "${vault}"`));
    assert.doesNotMatch(failures, /<vault>|<cofre>|private-corrupt-payload/i);
    assert.deepEqual(byteSnapshot(vault), before);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:DIAG-8] ledger/projection lag and hash divergence are blocking', () => {
  const vault = createBundle();
  try {
    const second = event('mem-health-2', {
      memory_key: 'blocker.e2e', value: 'private-lag-payload', turn_sequence: 2,
    });
    writeFileSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl'), `${JSON.stringify(event())}\n${JSON.stringify(second)}\n`);
    const lagBefore = byteSnapshot(vault);
    const lag = checkMemoryBundle(vault);
    assert.equal(lag.ok, false);
    const lagFailures = lag.failures.join('\n');
    assert.match(lagFailures, /proje[cç][aã]o|cursor|revision|hash/i);
    assert.ok(lag.failures.some((failure) => (
      failure.includes(`npx --no-install wendkeep memory status --gate --vault "${vault}"`)
    )));
    assert.doesNotMatch(lagFailures, /<vault>|<cofre>|private-lag-payload/i);
    assert.deepEqual(byteSnapshot(vault), lagBefore);

    const sharedPath = join(vault, '.brain', 'SHARED_MEMORY.md');
    const reduced = reduceMemoryEvents([event(), second]);
    writeFileSync(sharedPath, renderSharedMemory({
      revision: reduced.revision,
      eventCursor: reduced.eventCursor,
      stateHash: '0'.repeat(64),
      events: reduced.activeEvents,
      updatedAt: '2026-07-26T04:00:00Z',
      reviewAfter: '2026-08-02T04:00:00Z',
    }));
    const hashBefore = byteSnapshot(vault);
    const hash = checkMemoryBundle(vault);
    assert.equal(hash.ok, false);
    const hashFailures = hash.failures.join('\n');
    assert.match(hashFailures, /state_hash|hash/i);
    assert.ok(hash.failures.some((failure) => (
      failure.includes(`npx --no-install wendkeep memory status --gate --vault "${vault}"`)
    )));
    assert.doesNotMatch(hashFailures, /<vault>|<cofre>|private-lag-payload/i);
    assert.deepEqual(byteSnapshot(vault), hashBefore);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:DIAG-8] active semantic conflicts explain safe human curation without leaking or mutating', () => {
  const vault = createBundle();
  try {
    writeFileSync(join(vault, '.brain', 'MEMORY_CANDIDATES.jsonl'), [
      {
        candidate_id: 'conflict-next-ui', reason: 'conflict', memory_key: 'next.ui', status: 'active',
        event_ids: ['mem-health-1', 'mem-competing'], values: ['private-review', 'private-discard'],
        events: [{ event_id: 'private-full-event', value: 'private-event-payload' }],
      },
      {
        candidate_id: 'conflict-next-ui-later', reason: 'conflict', memory_key: 'next.ui',
        event_ids: ['mem-later', 'mem-competing'], values: ['private-later', 'private-discard'],
      },
    ].map((item) => JSON.stringify(item)).join('\n') + '\n');
    const before = byteSnapshot(vault);
    const result = checkMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.equal(result.metrics.activeConflicts, 2);
    const failure = result.failures.find((item) => /conflitos? ativos?/i.test(item));
    assert.ok(failure);
    assert.match(failure, /conflito semântico.*curadoria humana/i);
    assert.match(failure, /memory repair.*não escolhe vencedor/i);
    assert.match(failure, /memory promote <candidate-id> --event <event-id>/i);
    assert.match(failure, /memory reject <candidate-id>/i);
    assert.ok(failure.includes(`npx --no-install wendkeep memory candidates --active --vault "${vault}"`));
    assert.equal((failure.match(/next\.ui/g) || []).length, 1, 'doctor deduplicates repeated keys');
    assert.doesNotMatch(
      failure,
      /<vault>|<cofre>|private-review|private-discard|private-later|private-full-event|private-event-payload/,
    );
    assert.deepEqual(byteSnapshot(vault), before);
    assert.equal(existsSync(join(vault, '.brain', 'MEMORY.lock')), false, 'doctor does not acquire a mutation lock');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
