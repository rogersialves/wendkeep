// [req:MEM-HYB-3] [req:MEM-HYB-7] [req:MEM-HYB-9]
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalMemoryJson, deriveMemoryProjection, hashMemoryValue, prepareMemoryProjection,
  reduceMemoryEvents,
} from '../hooks/memory-store.mjs';
import { renderSharedMemory } from '../hooks/memory-schema.mjs';
import { renderCoreSkeleton } from '../src/validate-core.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function fixture() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-cli-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'PROJECT.json'), '{"schemaVersion":1,"projectId":"project-a"}\n');
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), '# Shared legacy\n\n## Estado\n- backend entregue\n\n## Próximo\n- revisão UI\n');
  return vault;
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

function memoryEvent(eventId, value, turnSequence) {
  return {
    v: 1,
    project_id: 'project-a',
    event_id: eventId,
    memory_key: 'handoff.latest',
    operation: 'assert',
    value,
    authority: 'reported',
    canonical_session_id: 'current-session',
    activation_id: 'current-activation',
    activation_epoch: 1,
    turn_sequence: turnSequence,
    source_turn_id: `turn-${turnSequence}`,
    observed_at: `2026-07-26T12:0${turnSequence}:00.000Z`,
    evidence: [`turn:${turnSequence}`],
  };
}

function legacyPromotionEvent(eventId, candidate, selected, observedAt, overrides = {}) {
  const eventIds = [...candidate.event_ids].sort();
  return {
    v: 1,
    event_id: eventId,
    project_id: selected.project_id,
    memory_key: selected.memory_key,
    operation: 'replace',
    value: selected.value,
    authority: 'verified',
    activation_id: selected.activation_id,
    activation_epoch: selected.activation_epoch,
    turn_sequence: selected.turn_sequence,
    observed_at: observedAt,
    evidence: [`candidate:${candidate.candidate_id}`],
    candidate_decision: {
      candidate_id: candidate.candidate_id,
      action: 'promote',
      event_ids: eventIds,
      selected_event_id: selected.event_id,
    },
    supersedes: eventIds,
    ...overrides,
  };
}

function seedOutOfOrderPromotionBridge(vault, {
  currentOverrides = {}, selectedOverrides = {}, mutateCurrentPromotion = null,
  selectedBeforeCurrent = false,
} = {}) {
  const base = {
    ...memoryEvent('mem-bridge-base', 'bridge base', 0),
    canonical_session_id: 'bridge-session',
    activation_id: 'bridge-activation',
    source_turn_id: 'bridge-turn-base',
    observed_at: '2026-07-26T12:00:00.000Z',
  };
  const competing = {
    ...base,
    event_id: 'mem-bridge-competing',
    value: 'bridge competing',
    canonical_session_id: 'bridge-competing-session',
    activation_id: 'bridge-competing-activation',
    source_turn_id: 'bridge-competing-turn',
    observed_at: '2026-07-26T12:01:00.000Z',
  };
  writeMemoryProjection(vault, [base, competing]);
  const initial = readCandidates(vault).find((item) => item.event_ids.includes(base.event_id));
  const firstPromotion = legacyPromotionEvent(
    'mem-bridge-first-promotion', initial, base, '2026-07-26T12:02:00.000Z',
  );
  const prior = {
    ...base,
    event_id: 'mem-bridge-prior',
    value: 'bridge prior',
    turn_sequence: 1,
    source_turn_id: 'bridge-turn-prior',
    observed_at: '2026-07-26T12:03:00.000Z',
  };
  const prefix = [base, competing, firstPromotion, prior];
  writeMemoryProjection(vault, prefix);
  const priorCandidate = readCandidates(vault)
    .find((item) => item.event_ids.includes(prior.event_id));
  const prefixProjection = deriveMemoryProjection(vault, prefix);
  let currentPromotion = legacyPromotionEvent(
    'mem-bridge-current-promotion',
    priorCandidate,
    prior,
    '2026-07-26T12:05:00.000Z',
    currentOverrides,
  );
  const selected = {
    ...base,
    event_id: 'mem-bridge-selected',
    value: 'bridge selected',
    turn_sequence: 2,
    source_turn_id: 'bridge-turn-selected',
    observed_at: '2026-07-26T12:04:00.000Z',
    ...selectedOverrides,
  };
  if (mutateCurrentPromotion) {
    currentPromotion = mutateCurrentPromotion({
      currentPromotion, prefixProjection, prior, priorCandidate,
    });
  }
  const suffix = selectedBeforeCurrent
    ? [selected, currentPromotion]
    : [currentPromotion, selected];
  writeMemoryProjection(vault, [...prefix, ...suffix]);
  const candidate = readCandidates(vault)
    .find((item) => item.event_ids.includes(selected.event_id));
  return { candidate, currentPromotion, selected };
}

function checkpoint(reduced) {
  return {
    revision: reduced.revision,
    event_cursor: reduced.eventCursor,
    state_hash: reduced.stateHash,
  };
}

function writeMemoryProjection(vault, events) {
  const brain = join(vault, '.brain');
  const projection = prepareMemoryProjection(vault, events);
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), `${events.map(canonicalMemoryJson).join('\n')}\n`);
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), projection.candidatesContent);
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), projection.sharedContent);
  return projection;
}

function readCandidates(vault) {
  const content = readFileSync(join(vault, '.brain', 'MEMORY_CANDIDATES.jsonl'), 'utf8').trim();
  return content ? content.split('\n').map(JSON.parse) : [];
}

function projectedAttempt(sessionId, event, checkpointValue = null, overrides = {}) {
  return {
    v: 1,
    memory_mode: 'v2',
    canonical_session_id: sessionId,
    activation_id: event.activation_id,
    activation_epoch: event.activation_epoch,
    turn_id: event.source_turn_id,
    turn_sequence: event.turn_sequence,
    disposition: 'applied',
    state: 'projected',
    event_ids: [event.event_id],
    checkpoint: checkpointValue,
    ...overrides,
  };
}

function legacyAssertCheckpoint(events) {
  const seenAssertKeys = new Set();
  const legacyApplied = events.filter((event) => {
    if (event.operation !== 'assert') return true;
    if (seenAssertKeys.has(event.memory_key)) return false;
    seenAssertKeys.add(event.memory_key);
    return true;
  });
  const legacy = reduceMemoryEvents(legacyApplied);
  const causal = reduceMemoryEvents(events);
  return {
    revision: legacy.revision,
    event_cursor: causal.eventCursor,
    state_hash: legacy.stateHash,
  };
}

function historicalLegacyCheckpointFixture({
  tamperHash = false,
  nonAssert = false,
  divergentIdentity = false,
  nonIncreasingTurn = false,
  divergentMirror = false,
} = {}) {
  const vault = fixture();
  const brain = join(vault, '.brain');
  const first = memoryEvent('mem-historical-t1', 'handoff t1', 1);
  const second = memoryEvent('mem-historical-t2', 'handoff t2', 2);
  if (nonAssert) second.operation = 'add';
  if (divergentIdentity) second.activation_id = 'other-activation';
  if (nonIncreasingTurn) second.turn_sequence = first.turn_sequence;
  const git = {
    ...memoryEvent('mem-historical-git', { commit: 'abc123' }, 3),
    memory_key: 'git.local-head',
  };
  const fourth = memoryEvent('mem-historical-t4', 'handoff t4', 4);
  const attempted = memoryEvent('mem-historical-t6', 'handoff t6', 6);
  const appendedLate = memoryEvent('mem-historical-t5-late', 'handoff t5', 5);
  const physicalLedger = [first, second, git, fourth, attempted, appendedLate];
  const attemptPrefix = physicalLedger.slice(0, 5);
  const legacyCheckpoint = legacyAssertCheckpoint(attemptPrefix);
  if (tamperHash) {
    legacyCheckpoint.state_hash = `${legacyCheckpoint.state_hash.slice(0, -1)}${legacyCheckpoint.state_hash.endsWith('0') ? '1' : '0'}`;
  }

  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), `${physicalLedger.map(canonicalMemoryJson).join('\n')}\n`);
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
  const current = deriveMemoryProjection(vault, physicalLedger);
  const memoryCheckpoint = divergentMirror ? current.checkpoint : legacyCheckpoint;
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory({
    revision: current.revision,
    eventCursor: current.ledgerCursor,
    stateHash: current.stateHash,
    events: current.activeEvents,
    updatedAt: attempted.observed_at,
  }));
  const registryPath = join(brain, 'SESSION_REGISTRY.json');
  writeFileSync(registryPath, `${JSON.stringify({ version: 2, sessions: {
    'current-session': {
      memory_checkpoint: memoryCheckpoint,
      last_memory_attempt: projectedAttempt('current-session', attempted, legacyCheckpoint),
    },
  } }, null, 2)}\n`);
  return {
    vault, brain, physicalLedger, attemptPrefix, legacyCheckpoint, registryPath,
    currentCheckpoint: current.checkpoint,
  };
}

function startCheckpointMirrorRace({ vault, registryPath: registryFile, checkpointValue }) {
  const safetyUrl = new URL('../packages/vault/src/vault-path-safety.mjs', import.meta.url).href;
  const registryUrl = new URL('../hooks/obsidian-common.mjs', import.meta.url).href;
  const code = [
    "import { existsSync } from 'node:fs';",
    `import { withVaultPathLock } from ${JSON.stringify(safetyUrl)};`,
    `import { readSessionRegistry, writeSessionRegistry } from ${JSON.stringify(registryUrl)};`,
    'const signal = new Int32Array(new SharedArrayBuffer(4));',
    'withVaultPathLock(process.env.WK_RACE_VAULT, process.env.WK_RACE_REGISTRY, () => {',
    "  process.stdout.write('ready\\n');",
    '  const deadline = Date.now() + 5000;',
    '  while (!existsSync(process.env.WK_RACE_MEMORY_LOCK)) {',
    "    if (Date.now() >= deadline) throw new Error('memory lock was not observed');",
    '    Atomics.wait(signal, 0, 0, 10);',
    '  }',
    '  Atomics.wait(signal, 0, 0, 250);',
    '  const registry = readSessionRegistry(process.env.WK_RACE_VAULT);',
    "  registry.sessions['current-session'].memory_checkpoint = JSON.parse(process.env.WK_RACE_CHECKPOINT);",
    '  writeSessionRegistry(process.env.WK_RACE_VAULT, registry);',
    "  process.stdout.write('mutated\\n');",
    '}, { timeoutMs: 2000 });',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: {
      ...process.env,
      WK_RACE_VAULT: vault,
      WK_RACE_REGISTRY: registryFile,
      WK_RACE_MEMORY_LOCK: join(vault, '.brain', 'MEMORY.lock'),
      WK_RACE_CHECKPOINT: JSON.stringify(checkpointValue),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.includes('ready\n')) readyResolve();
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', readyReject);
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (codeValue) => {
      if (!stdout.includes('ready\n')) readyReject(new Error(stderr || `race writer exited ${codeValue}`));
      resolve({ code: codeValue, stdout, stderr });
    });
  });
  return { ready, closed };
}

function reconciliationArtifacts(vault) {
  const brain = join(vault, '.brain');
  const backups = readdirSync(brain)
    .filter((name) => name.includes('.reconcile-') && name.endsWith('.bak'))
    .sort()
    .map((name) => ({ name, content: readFileSync(join(brain, name), 'utf8') }));
  return {
    registry: readFileSync(join(brain, 'SESSION_REGISTRY.json'), 'utf8'),
    shared: readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8'),
    backups,
  };
}

test('memory migrate é dry-run por padrão e não toca nenhum byte', async () => {
  const vault = fixture();
  const before = readFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), 'utf8');
  try {
    const { migrateMemory } = await import('../src/memory.mjs');
    const result = migrateMemory(vault);
    assert.equal(result.status, 'dry-run');
    assert.equal(readFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), 'utf8'), before);
    assert.equal(existsSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl')), false);
    assert.equal(existsSync(result.backupPath), false);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:OP-10] seed rejeita raiz .brain por junction antes de criar artefatos externos', async (t) => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-seed-junction-'));
  const outside = mkdtempSync(join(tmpdir(), 'wk-memory-seed-junction-outside-'));
  try {
    writeFileSync(join(outside, 'sentinel.txt'), 'external seed sentinel\n');
    const before = readdirSync(outside).sort();
    const brain = join(vault, '.brain');
    if (!createAlias(t, outside, brain, 'junction')) return;
    const { seedMemoryV2 } = await import('../src/memory.mjs');

    assert.throws(
      () => seedMemoryV2(vault),
      /link simbólico|junction|reparse|Vault/i,
    );
    assert.deepEqual(readdirSync(outside).sort(), before);
    assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'external seed sentinel\n');
    assert.equal(lstatSync(brain).isSymbolicLink(), true);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-10] migrate rejeita SHARED legado por hardlink antes de backup ou publicação', async (t) => {
  const vault = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-memory-migrate-hardlink-outside-'));
  const brain = join(vault, '.brain');
  try {
    const shared = join(brain, 'SHARED_MEMORY.md');
    const source = join(outside, 'legacy-shared.md');
    writeFileSync(source, readFileSync(shared));
    rmSync(shared);
    if (!createAlias(t, source, shared)) return;
    const outsideBefore = readFileSync(source);
    const brainBefore = readdirSync(brain).sort();
    const { migrateMemory } = await import('../src/memory.mjs');

    assert.throws(
      () => migrateMemory(vault, { apply: true }),
      /hardlink|nlink|Vault/i,
    );
    assert.deepEqual(readFileSync(source), outsideBefore);
    assert.deepEqual(readdirSync(brain).sort(), brainBefore, 'nenhum backup ou sidecar parcial é criado');
    assert.equal(existsSync(join(brain, 'MEMORY_EVENTS.jsonl')), false);
    assert.equal(existsSync(join(brain, 'MEMORY_CANDIDATES.jsonl')), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('memory migrate --apply em vault sem SHARED apenas cria bundle v2 vazio', async () => {
  const vault = fixture();
  rmSync(join(vault, '.brain', 'SHARED_MEMORY.md'));
  try {
    const { migrateMemory } = await import('../src/memory.mjs');
    const { checkMemoryBundle } = await import('../hooks/vault-health.mjs');
    const result = migrateMemory(vault, { apply: true });
    assert.equal(result.status, 'migrated');
    assert.equal(result.backupPath, null);
    assert.ok(existsSync(join(vault, '.brain', 'SHARED_MEMORY.md')));
    assert.equal(checkMemoryBundle(vault).status, 'healthy', 'migrate vazio e gate devem usar o mesmo state_hash canônico');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('memory migrate --apply preserva CORE, cria backup e bundle v2 válido com candidates', async () => {
  const vault = fixture();
  const core = readFileSync(join(vault, '.brain', 'CORE.md'), 'utf8');
  try {
    const { migrateMemory } = await import('../src/memory.mjs');
    const { validateMemoryBundle } = await import('../src/validate-memory.mjs');
    const result = migrateMemory(vault, { apply: true });
    assert.equal(result.status, 'migrated');
    assert.ok(existsSync(result.backupPath));
    assert.match(readFileSync(result.backupPath, 'utf8'), /backend entregue/);
    assert.equal(readFileSync(join(vault, '.brain', 'CORE.md'), 'utf8'), core);
    assert.match(readFileSync(join(vault, '.brain', 'MEMORY_CANDIDATES.jsonl'), 'utf8'), /backend entregue/);
    assert.equal(validateMemoryBundle(vault).ok, true);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('cada conteúdo legado distinto recebe seu próprio backup antes do apply', async () => {
  const vault = fixture();
  try {
    const { migrateMemory } = await import('../src/memory.mjs');
    const first = migrateMemory(vault, { apply: true });
    writeFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), '# outro legado\n\n- decisão B\n');
    const second = migrateMemory(vault, { apply: true });
    assert.notEqual(second.backupPath, first.backupPath);
    assert.match(readFileSync(second.backupPath, 'utf8'), /decisão B/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('migrate --apply reverte toda publicação quando a validação final falha', async () => {
  const vault = fixture();
  const brain = join(vault, '.brain');
  const legacy = readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8');
  try {
    const { migrateMemory } = await import('../src/memory.mjs');
    assert.throws(
      () => migrateMemory(vault, {
        apply: true,
        validateBundle: () => ({ ok: false, errors: ['falha final injetada'] }),
      }),
      /falha final injetada/,
    );
    assert.equal(readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8'), legacy);
    assert.equal(existsSync(join(brain, 'MEMORY_EVENTS.jsonl')), false);
    assert.equal(existsSync(join(brain, 'MEMORY_CANDIDATES.jsonl')), false);
    const backups = readdirSync(brain).filter((name) => name.includes('.legacy-') && name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(brain, backups[0]), 'utf8'), legacy);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('migrate valida bundle completo em staging antes de tocar nos paths finais', async () => {
  const vault = fixture();
  const brain = join(vault, '.brain');
  const legacy = readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8');
  let staging = '';
  try {
    const { migrateMemory } = await import('../src/memory.mjs');
    const { validateMemoryBundle } = await import('../src/validate-memory.mjs');
    const result = migrateMemory(vault, {
      apply: true,
      validateBundle: (candidateVault) => {
        staging = candidateVault;
        assert.notEqual(candidateVault, vault, 'validação recebe um vault de staging');
        assert.equal(readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8'), legacy, 'SHARED final ainda é legado');
        assert.equal(existsSync(join(brain, 'MEMORY_EVENTS.jsonl')), false, 'ledger final ainda não foi criado');
        assert.equal(existsSync(join(brain, 'MEMORY_CANDIDATES.jsonl')), false, 'candidates final ainda não foi criado');
        const stagedBrain = join(candidateVault, '.brain');
        assert.equal(readFileSync(join(stagedBrain, 'CORE.md'), 'utf8'), readFileSync(join(brain, 'CORE.md'), 'utf8'));
        assert.equal(readFileSync(join(stagedBrain, 'PROJECT.json'), 'utf8'), readFileSync(join(brain, 'PROJECT.json'), 'utf8'));
        assert.match(readFileSync(join(stagedBrain, 'SHARED_MEMORY.md'), 'utf8'), /schema_version: 2/);
        assert.match(readFileSync(join(stagedBrain, 'MEMORY_CANDIDATES.jsonl'), 'utf8'), /backend entregue/);
        return validateMemoryBundle(candidateVault);
      },
    });
    assert.equal(result.status, 'migrated');
    assert.ok(staging);
    assert.equal(existsSync(staging), false, 'staging removido após validação/publicação');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('falha durante publish restaura todos os paths finais e mantém backup', async () => {
  const vault = fixture();
  const brain = join(vault, '.brain');
  const legacy = readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8');
  try {
    const { migrateMemory } = await import('../src/memory.mjs');
    const { writeFileAtomic } = await import('../hooks/session-note-io.mjs');
    let writes = 0;
    assert.throws(() => migrateMemory(vault, {
      apply: true,
      publishArtifact: (path, content) => {
        writes += 1;
        if (writes === 2) throw new Error('publish injetado');
        writeFileAtomic(path, content);
      },
    }), /publish injetado/);
    assert.equal(readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8'), legacy);
    assert.equal(existsSync(join(brain, 'MEMORY_EVENTS.jsonl')), false);
    assert.equal(existsSync(join(brain, 'MEMORY_CANDIDATES.jsonl')), false);
    const backups = readdirSync(brain).filter((name) => name.includes('.legacy-') && name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(brain, backups[0]), 'utf8'), legacy);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-CUR-1] [req:MEM-CUR-2] [req:MEM-CUR-3] decisões sobre candidates sobrepostos sobrevivem a repair e retry', async () => {
  const vault = fixture();
  try {
    const { decideMemoryCandidate, repairMemory } = await import('../src/memory.mjs');
    const base = { ...memoryEvent('mem-base', 'base handoff', 1), activation_id: 'activation-base' };
    const discarded = { ...memoryEvent('mem-discarded', 'discarded handoff', 2), activation_id: 'activation-a' };
    const winner = {
      ...memoryEvent('mem-winner', 'winning handoff', 3),
      activation_id: 'activation-b',
      canonical_session_id: 'current',
    };
    writeMemoryProjection(vault, [base, discarded, winner]);
    const historicalLedger = readFileSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl'), 'utf8');
    const staleCheckpoint = { revision: 0, event_cursor: winner.event_id, state_hash: 'stale' };
    const newerCheckpoint = { revision: 9, event_cursor: 'mem-newer', state_hash: 'newer' };
    const newerAttemptEvent = {
      ...memoryEvent('mem-newer', 'newer handoff', 4),
      activation_id: 'activation-newer',
      canonical_session_id: 'newer',
    };
    writeFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), `${JSON.stringify({
      version: 2,
      sessions: {
        current: {
          memory_status: 'projected',
          memory_checkpoint: staleCheckpoint,
          last_memory_attempt: projectedAttempt('current', winner, staleCheckpoint),
        },
        newer: {
          memory_status: 'projected',
          memory_checkpoint: newerCheckpoint,
          last_memory_attempt: projectedAttempt('newer', newerAttemptEvent, newerCheckpoint),
        },
      },
    }, null, 2)}\n`);
    const candidates = readCandidates(vault);
    const rejected = candidates.find((item) => item.event_ids.includes(discarded.event_id));
    const promoted = candidates.find((item) => item.event_ids.includes(winner.event_id));
    assert.ok(rejected);
    assert.ok(promoted);

    assert.equal(decideMemoryCandidate(vault, {
      action: 'reject', candidateId: rejected.candidate_id,
    }).status, 'rejected');
    assert.deepEqual(readCandidates(vault).map((item) => item.candidate_id), [promoted.candidate_id]);

    const promotedResult = decideMemoryCandidate(vault, {
      action: 'promote',
      candidateId: promoted.candidate_id,
      eventId: winner.event_id,
      value: 'override que não pode vencer o evento escolhido',
    });
    assert.equal(promotedResult.status, 'promoted');
    assert.deepEqual(readCandidates(vault), []);
    const refreshed = JSON.parse(readFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), 'utf8'))
      .sessions.current;
    assert.deepEqual(refreshed.last_memory_attempt.checkpoint, promotedResult.projection.checkpoint);
    assert.deepEqual(refreshed.memory_checkpoint, promotedResult.projection.checkpoint);
    assert.equal(refreshed.memory_candidate_decisions.length, 1);
    const concurrent = JSON.parse(readFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), 'utf8'))
      .sessions.newer;
    assert.deepEqual(concurrent.last_memory_attempt.checkpoint, newerCheckpoint);
    assert.deepEqual(concurrent.memory_checkpoint, newerCheckpoint);

    repairMemory(vault);
    assert.deepEqual(readCandidates(vault), [], 'repair/replay não recria decisões concluídas');
    const ledgerPath = join(vault, '.brain', 'MEMORY_EVENTS.jsonl');
    const ledgerAfterDecisions = readFileSync(ledgerPath, 'utf8');
    assert.ok(ledgerAfterDecisions.startsWith(historicalLedger), 'decisões somente acrescentam ao ledger histórico');
    const ledger = ledgerAfterDecisions.trim().split('\n').map(JSON.parse);
    assert.deepEqual(
      ledger.filter((event) => event.candidate_decision).map((event) => event.candidate_decision.action).sort(),
      ['promote', 'reject'],
      'promote e reject permanecem auditáveis no ledger',
    );
    const reduced = reduceMemoryEvents(ledger);
    assert.equal(reduced.state['handoff.latest'], winner.value);
    assert.equal(Object.keys(reduced.state).some((key) => key.startsWith('candidate.')), false);
    assert.equal(reduced.records['handoff.latest'].source.candidate_decision.selected_event_id, winner.event_id);
    assert.equal(reduced.records['handoff.latest'].source.activation_id, winner.activation_id);
    assert.ok(reduced.records['handoff.latest'].source.supersedes.includes(winner.event_id));

    const beforeRetry = readFileSync(ledgerPath, 'utf8');
    const sharedBeforeRetry = readFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), 'utf8');
    const retry = decideMemoryCandidate(vault, {
      action: 'promote', candidateId: promoted.candidate_id, eventId: winner.event_id,
    });
    assert.equal(retry.status, 'promoted');
    assert.equal(retry.alreadyApplied, true);
    assert.equal(readFileSync(ledgerPath, 'utf8'), beforeRetry, 'retry não duplica evento');
    assert.equal(readFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), 'utf8'), sharedBeforeRetry);
    assert.equal(retry.projection.revision, promotedResult.projection.revision);
    assert.equal(retry.projection.stateHash, promotedResult.projection.stateHash);
    assert.throws(() => decideMemoryCandidate(vault, {
      action: 'reject', candidateId: promoted.candidate_id,
    }), /decisão incompatível|already.*promot|já.*promov/i);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-CUR-2] promoção preserva valor JSON e identidade causal do evento escolhido', async () => {
  const vault = fixture();
  try {
    const { decideMemoryCandidate } = await import('../src/memory.mjs');
    const selected = {
      ...memoryEvent('mem-typed-selected', { branch: 'main', commit: 'abc123' }, 2),
      memory_key: 'git.local-head',
      canonical_session_id: 'selected-session',
      activation_id: 'selected-activation',
      source_turn_id: 'selected-turn',
    };
    const competing = {
      ...memoryEvent('mem-typed-competing', { branch: 'feature', commit: 'def456' }, 2),
      memory_key: 'git.local-head',
      canonical_session_id: 'competing-session',
      activation_id: 'competing-activation',
      source_turn_id: 'competing-turn',
    };
    writeMemoryProjection(vault, [selected, competing]);
    const candidate = readCandidates(vault).find((item) => item.event_ids.includes(selected.event_id));
    assert.ok(candidate);

    const result = decideMemoryCandidate(vault, {
      action: 'promote', candidateId: candidate.candidate_id, eventId: selected.event_id,
    });
    const ledger = readFileSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    const decision = ledger.find((event) => event.event_id === result.eventId);

    assert.deepEqual(decision.value, selected.value);
    assert.equal(decision.canonical_session_id, selected.canonical_session_id);
    assert.equal(decision.activation_id, selected.activation_id);
    assert.equal(decision.activation_epoch, selected.activation_epoch);
    assert.equal(decision.source_turn_id, selected.source_turn_id);
    assert.equal(decision.turn_sequence, selected.turn_sequence);

    const later = {
      ...selected,
      event_id: 'mem-typed-later',
      value: { branch: 'main', commit: 'fedcba' },
      turn_sequence: selected.turn_sequence + 1,
      source_turn_id: 'selected-turn-later',
      observed_at: new Date(Date.parse(decision.observed_at) + 1_000).toISOString(),
    };
    const reduced = reduceMemoryEvents([...ledger, later]);
    assert.equal(reduced.candidates.length, 0, JSON.stringify(reduced.candidates));
    assert.deepEqual(reduced.state['git.local-head'], later.value);
    assert.equal(reduced.records['git.local-head'].source.event_id, later.event_id);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-CUR-2] bridge temporal exige todas as provas legadas e causais', async () => {
  const { decideMemoryCandidate } = await import('../src/memory.mjs');
  const scenarios = [
    {
      name: 'promoção atual já possui identidade moderna',
      options: {
        currentOverrides: {
          canonical_session_id: 'bridge-session',
          source_turn_id: 'bridge-turn-prior',
        },
      },
    },
    {
      name: 'evento escolhido pertence a outra linhagem causal',
      options: {
        selectedOverrides: {
          canonical_session_id: 'bridge-other-session',
          activation_id: 'bridge-other-activation',
          source_turn_id: 'bridge-other-turn',
        },
      },
    },
    {
      name: 'supersedes diverge dos membros auditados pela decisão legada',
      options: {
        mutateCurrentPromotion: ({ currentPromotion }) => ({
          ...currentPromotion,
          candidate_decision: {
            ...currentPromotion.candidate_decision,
            event_ids: [...currentPromotion.candidate_decision.event_ids, 'mem-bridge-base'].sort(),
          },
        }),
      },
    },
    {
      name: 'promoção atual não compartilha ancestral com o candidate posterior',
      options: {
        mutateCurrentPromotion: ({ currentPromotion, prefixProjection, prior }) => {
          const current = prefixProjection.records['handoff.latest'];
          return {
            ...currentPromotion,
            supersedes: [prior.event_id],
            base_revision: current.revision,
            base_value_hash: hashMemoryValue(current.value),
            candidate_decision: {
              ...currentPromotion.candidate_decision,
              event_ids: [prior.event_id],
            },
          };
        },
      },
    },
    {
      name: 'evento escolhido não possui turno maior',
      options: { selectedOverrides: { turn_sequence: 1 } },
    },
    {
      name: 'evento escolhido não foi anexado depois da promoção atual',
      options: { selectedBeforeCurrent: true },
    },
    {
      name: 'observed_at não está invertido em relação à ordem física',
      options: {
        selectedOverrides: { observed_at: '2026-07-26T12:06:00.000Z' },
        mutateCurrentPromotion: ({ currentPromotion, prefixProjection }) => {
          const current = prefixProjection.records['handoff.latest'];
          return {
            ...currentPromotion,
            base_revision: current.revision,
            base_value_hash: hashMemoryValue(current.value),
          };
        },
      },
    },
  ];

  for (const scenario of scenarios) {
    const vault = fixture();
    try {
      const { candidate, selected } = seedOutOfOrderPromotionBridge(vault, scenario.options);
      assert.ok(candidate, scenario.name);
      const ledgerPath = join(vault, '.brain', 'MEMORY_EVENTS.jsonl');
      const ledgerBefore = readFileSync(ledgerPath, 'utf8');
      assert.throws(() => decideMemoryCandidate(vault, {
        action: 'promote', candidateId: candidate.candidate_id, eventId: selected.event_id,
      }), /não corresponde mais à projeção causal atual/i, scenario.name);
      assert.equal(readFileSync(ledgerPath, 'utf8'), ledgerBefore, `${scenario.name}: ledger imutável`);
    } finally { rmSync(vault, { recursive: true, force: true }); }
  }
});

test('[req:MEM-CUR-2] CAS não atualiza attempt novo que ainda contém o evento promovido', async () => {
  const vault = fixture();
  try {
    const { decideMemoryCandidate } = await import('../src/memory.mjs');
    const base = { ...memoryEvent('mem-cas-base', 'base', 1), activation_id: 'activation-base' };
    const winner = {
      ...memoryEvent('mem-cas-winner', 'winner', 2),
      activation_id: 'activation-winner',
      canonical_session_id: 'current',
    };
    writeMemoryProjection(vault, [base, winner]);
    const [candidate] = readCandidates(vault);
    const staleCheckpoint = { revision: 0, event_cursor: winner.event_id, state_hash: 'stale' };
    const newerCheckpoint = { revision: 77, event_cursor: 'mem-same-turn-newer', state_hash: 'newer' };
    const registryPath = join(vault, '.brain', 'SESSION_REGISTRY.json');
    writeFileSync(registryPath, `${JSON.stringify({
      version: 2,
      sessions: {
        current: {
          memory_status: 'projected',
          memory_checkpoint: staleCheckpoint,
          last_memory_attempt: projectedAttempt('current', winner, staleCheckpoint),
        },
      },
    }, null, 2)}\n`);

    const result = decideMemoryCandidate(vault, {
      action: 'promote',
      candidateId: candidate.candidate_id,
      eventId: winner.event_id,
      beforeCheckpointRefresh: () => {
        const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
        registry.sessions.current.last_memory_attempt = {
          ...registry.sessions.current.last_memory_attempt,
          event_ids: [winner.event_id, 'mem-same-turn-newer'],
          checkpoint: newerCheckpoint,
        };
        registry.sessions.current.memory_checkpoint = newerCheckpoint;
        writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      },
    });

    assert.equal(result.status, 'promoted');
    assert.equal(result.checkpointRefreshed, 0);
    const current = JSON.parse(readFileSync(registryPath, 'utf8')).sessions.current;
    assert.deepEqual(current.last_memory_attempt.checkpoint, newerCheckpoint);
    assert.deepEqual(current.memory_checkpoint, newerCheckpoint);
    assert.deepEqual(current.last_memory_attempt.event_ids, [winner.event_id, 'mem-same-turn-newer']);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-CUR-2] promoção de conflito exige event_id pertencente ao candidate', async () => {
  const vault = fixture();
  try {
    const { decideMemoryCandidate } = await import('../src/memory.mjs');
    const base = { ...memoryEvent('mem-choice-base', 'base', 1), activation_id: 'activation-base' };
    const proposal = { ...memoryEvent('mem-choice-proposal', 'proposal', 2), activation_id: 'activation-proposal' };
    writeMemoryProjection(vault, [base, proposal]);
    const [candidate] = readCandidates(vault);
    const ledgerBefore = readFileSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl'), 'utf8');

    assert.throws(() => decideMemoryCandidate(vault, {
      action: 'promote', candidateId: candidate.candidate_id,
    }), /event_id|eventId|--event/i);
    assert.throws(() => decideMemoryCandidate(vault, {
      action: 'promote', candidateId: candidate.candidate_id, eventId: 'mem-not-a-member',
    }), /não pertence|not.*candidate/i);
    assert.equal(readFileSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl'), 'utf8'), ledgerBefore);
    assert.equal(readCandidates(vault).length, 1);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-CUR-2] CLI promote encaminha --event e falha fechado sem a escolha', () => {
  const vault = fixture();
  try {
    const base = { ...memoryEvent('mem-cli-choice-base', 'base', 1), activation_id: 'activation-base' };
    const proposal = { ...memoryEvent('mem-cli-choice-proposal', 'proposal', 2), activation_id: 'activation-proposal' };
    writeMemoryProjection(vault, [base, proposal]);
    const [candidate] = readCandidates(vault);
    const args = ['memory', 'promote', candidate.candidate_id, '--vault', vault];

    const missing = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--event|eventId/i);

    const applied = spawnSync(process.execPath, [BIN, ...args, '--event', proposal.event_id], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).status, 'promoted');
    assert.deepEqual(readCandidates(vault), []);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-CUR-2] blocked_by_core não pode ser promovido e pode ser rejeitado durablemente', async () => {
  const vault = fixture();
  try {
    const { decideMemoryCandidate, repairMemory } = await import('../src/memory.mjs');
    const corePath = join(vault, '.brain', 'CORE.md');
    writeFileSync(corePath, `${readFileSync(corePath, 'utf8')}\n<!-- wk-memory: release.push="manual-only" -->\n`);
    const proposal = {
      ...memoryEvent('mem-core-conflict', 'automatic', 1),
      memory_key: 'release.push',
    };
    writeMemoryProjection(vault, [proposal]);
    const [candidate] = readCandidates(vault);
    assert.equal(candidate.reason, 'blocked_by_core');
    assert.throws(() => decideMemoryCandidate(vault, {
      action: 'promote', candidateId: candidate.candidate_id, eventId: proposal.event_id,
    }), /CORE|blocked_by_core/i);
    assert.equal(decideMemoryCandidate(vault, {
      action: 'reject', candidateId: candidate.candidate_id,
    }).status, 'rejected');
    repairMemory(vault);
    assert.deepEqual(readCandidates(vault), []);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('memory repair preserva bytes corrompidos em backup antes de reconstruir', async () => {
  const vault = fixture();
  try {
    const { migrateMemory, repairMemory } = await import('../src/memory.mjs');
    migrateMemory(vault, { apply: true });
    const ledgerPath = join(vault, '.brain', 'MEMORY_EVENTS.jsonl');
    writeFileSync(ledgerPath, '{parcial');
    const result = repairMemory(vault);
    assert.equal(result.status, 'repaired');
    assert.ok(existsSync(result.repaired.backupPath));
    assert.equal(readFileSync(result.repaired.backupPath, 'utf8'), '{parcial');
    assert.equal(readFileSync(ledgerPath, 'utf8'), '');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:OP-10] memory reconcile replays physical ledger, refreshes only the successor and audits explicit supersession', async () => {
  const vault = fixture();
  const brain = join(vault, '.brain');
  const notePath = join(vault, '02-Sessões', 'old.md');
  const events = [
    memoryEvent('mem-reconcile-1', 'handoff one', 1),
    memoryEvent('mem-reconcile-2', 'handoff two', 2),
    memoryEvent('mem-reconcile-3', 'handoff three', 3),
  ];
  const physicalLedger = [events[2], events[0], events[1]];
  const oldCheckpoint = checkpoint(reduceMemoryEvents([events[2]]));
  const reduced = reduceMemoryEvents(events);
  const expectedCheckpoint = {
    revision: reduced.revision,
    event_cursor: physicalLedger.at(-1).event_id,
    state_hash: reduced.stateHash,
    causal_event_cursor: reduced.eventCursor,
  };
  const ambiguousAttempt = {
    v: 1,
    memory_mode: 'v2',
    activation_id: '',
    activation_epoch: 0,
    turn_id: 'old-turn',
    turn_sequence: 23,
    disposition: 'ambiguous',
    state: 'skipped',
    event_ids: [],
    checkpoint: null,
    observed_at: '2026-07-26T12:00:00.000Z',
  };
  mkdirSync(dirname(notePath), { recursive: true });
  writeFileSync(notePath, '# old session\n\n## Iterações\n\nunchanged\n');
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), `${physicalLedger.map(canonicalMemoryJson).join('\n')}\n`);
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), `${JSON.stringify({ candidate_id: 'stale' })}\n`);
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory());
  writeFileSync(join(brain, 'SESSION_REGISTRY.json'), `${JSON.stringify({
    version: 2,
    sessions: {
      'old-session': {
        status: 'active',
        session_file: '02-Sessões/old.md',
        last_memory_attempt: ambiguousAttempt,
      },
      'current-session': {
        status: 'active',
        memory_checkpoint: oldCheckpoint,
        last_memory_attempt: projectedAttempt('current-session', events[2], oldCheckpoint),
      },
      'unrelated-session': {
        status: 'active',
        memory_checkpoint: oldCheckpoint,
        last_memory_attempt: {
          memory_mode: 'legacy',
          checkpoint: oldCheckpoint,
        },
      },
    },
  }, null, 2)}\n`);
  const ledgerBefore = readFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), 'utf8');
  const coreBefore = readFileSync(join(brain, 'CORE.md'), 'utf8');
  const noteBefore = readFileSync(notePath, 'utf8');
  try {
    const { reconcileMemory } = await import('../src/memory.mjs');
    const dryRunRegistry = readFileSync(join(brain, 'SESSION_REGISTRY.json'), 'utf8');
    const dryRun = reconcileMemory(vault, {
      sessionId: 'old-session',
      bySessionId: 'current-session',
      reason: 'Implementation delivered and continued by the current session.',
      now: '2026-07-26T18:00:00.000Z',
    });
    assert.equal(dryRun.status, 'dry-run');
    assert.equal(readFileSync(join(brain, 'SESSION_REGISTRY.json'), 'utf8'), dryRunRegistry);

    const result = reconcileMemory(vault, {
      sessionId: 'old-session',
      bySessionId: 'current-session',
      reason: 'Implementation delivered and continued by the current session.',
      apply: true,
      now: '2026-07-26T18:00:00.000Z',
    });
    assert.equal(result.projection.revision, 3);
    assert.equal(result.projection.candidates, 0);
    assert.ok(existsSync(result.registry.backupPath), 'exact registry backup exists');

    const registry = JSON.parse(readFileSync(join(brain, 'SESSION_REGISTRY.json'), 'utf8'));
    const old = registry.sessions['old-session'];
    const current = registry.sessions['current-session'];
    const unrelated = registry.sessions['unrelated-session'];
    assert.equal(old.last_memory_attempt.state, 'skipped');
    assert.equal(old.last_memory_attempt.disposition, 'superseded');
    assert.equal(old.last_memory_attempt.reconciled_by_session_id, 'current-session');
    assert.deepEqual(old.memory_reconciliations[0].original_attempt, ambiguousAttempt);
    assert.deepEqual(old.memory_reconciliations[0].causal_proof.required_event_ids, ['mem-reconcile-3']);
    assert.equal(old.memory_reconciliations[0].causal_proof.registry_session_id, 'current-session');
    assert.equal(old.memory_reconciliations[0].causal_proof.activation_id, 'current-activation');
    assert.equal(old.memory_reconciliations[0].causal_proof.activation_epoch, 1);
    assert.equal(old.memory_reconciliations[0].causal_proof.turn_id, 'turn-3');
    assert.equal(old.memory_reconciliations[0].causal_proof.turn_sequence, 3);
    assert.match(old.memory_reconciliations[0].causal_proof.expected_ledger_sha256, /^[a-f0-9]{64}$/);
    assert.match(old.memory_reconciliations[0].causal_proof.expected_core_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(current.last_memory_attempt.checkpoint, expectedCheckpoint);
    assert.deepEqual(current.memory_checkpoint, expectedCheckpoint);
    assert.equal(current.memory_reconciliations[0].type, 'checkpoint_refreshed');
    assert.deepEqual(unrelated.last_memory_attempt.checkpoint, oldCheckpoint, 'sessão não autorizada não é reconciliada');
    assert.deepEqual(unrelated.memory_checkpoint, oldCheckpoint);

    const health = (await import('../hooks/vault-health.mjs')).checkMemoryBundle(vault);
    assert.equal(health.ok, true, health.failures.join('\n'));
    assert.notEqual(health.status, 'blocked');

    const reconciledRegistry = readFileSync(join(brain, 'SESSION_REGISTRY.json'), 'utf8');
    const retry = reconcileMemory(vault, {
      sessionId: 'old-session',
      bySessionId: 'current-session',
      reason: 'Implementation delivered and continued by the current session.',
      apply: true,
      now: '2026-07-26T18:00:00.000Z',
    });
    assert.equal(retry.status, 'unchanged');
    assert.equal(readFileSync(join(brain, 'SESSION_REGISTRY.json'), 'utf8'), reconciledRegistry);

    assert.equal(readFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), 'utf8'), ledgerBefore);
    assert.equal(readFileSync(join(brain, 'CORE.md'), 'utf8'), coreBefore);
    assert.equal(readFileSync(notePath, 'utf8'), noteBefore);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:OP-10] supersession fails closed for a non-ambiguous attempt and leaves registry untouched', async () => {
  const vault = fixture();
  const brain = join(vault, '.brain');
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), '');
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory());
  writeFileSync(join(brain, 'SESSION_REGISTRY.json'), `${JSON.stringify({
    version: 2,
    sessions: {
      'old-session': { last_memory_attempt: { memory_mode: 'v2', state: 'projected', disposition: 'applied' } },
      'current-session': { status: 'active' },
    },
  }, null, 2)}\n`);
  const registryPath = join(brain, 'SESSION_REGISTRY.json');
  const before = readFileSync(registryPath, 'utf8');
  try {
    const { reconcileMemory } = await import('../src/memory.mjs');
    assert.throws(() => reconcileMemory(vault, {
      sessionId: 'old-session',
      bySessionId: 'current-session',
      reason: 'Must not reinterpret a projected attempt.',
      apply: true,
    }), /não está ambiguous/i);
    assert.equal(readFileSync(registryPath, 'utf8'), before);
    assert.equal(readdirSync(brain).some((name) => name.includes('reconcile-') && name.endsWith('.bak')), false);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:OP-10] reconciliação incompleta falha antes da reprojeção e preserva registry, SHARED e backups', async (t) => {
  const event = { ...memoryEvent('mem-negative-proof', 'causal proof', 1), canonical_session_id: 'current' };
  const validTarget = {
    last_memory_attempt: {
      memory_mode: 'v2', state: 'skipped', disposition: 'ambiguous', event_ids: [],
    },
  };
  const validSuccessor = {
    last_memory_attempt: projectedAttempt('current', event),
  };
  const cases = [
    {
      name: 'target inexistente',
      sessions: { current: validSuccessor },
      reason: 'target must exist',
      error: /sessão não encontrada/i,
    },
    {
      name: 'sucessora inexistente',
      sessions: { old: validTarget },
      reason: 'successor must exist',
      error: /sessão reconciliadora não encontrada/i,
    },
    {
      name: 'reason ausente',
      sessions: { old: validTarget, current: validSuccessor },
      reason: undefined,
      error: /reason é obrigatório/i,
    },
    {
      name: 'sucessora sem event_ids',
      sessions: {
        old: validTarget,
        current: {
          last_memory_attempt: projectedAttempt('current', event, null, { event_ids: [] }),
        },
      },
      reason: 'successor needs causal evidence',
      error: /não possui event_ids/i,
    },
    {
      name: 'sucessora referencia event_id ausente do ledger',
      sessions: {
        old: validTarget,
        current: {
          last_memory_attempt: projectedAttempt('current', event, null, { event_ids: ['mem-not-in-ledger'] }),
        },
      },
      reason: 'successor evidence must exist in ledger',
      error: /event_ids ausentes do ledger/i,
    },
  ];

  const { reconcileMemory } = await import('../src/memory.mjs');
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const vault = fixture();
      const brain = join(vault, '.brain');
      try {
        writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), `${canonicalMemoryJson(event)}\n`);
        writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), 'stale projection sentinel\n');
        writeFileSync(join(brain, 'SHARED_MEMORY.md'), '# SHARED byte sentinel\n');
        writeFileSync(join(brain, 'SESSION_REGISTRY.json'), `${JSON.stringify({
          version: 2,
          sessions: scenario.sessions,
        }, null, 2)}\n`);
        writeFileSync(join(brain, 'SESSION_REGISTRY.json.reconcile-existing.bak'), 'existing backup sentinel\n');
        const before = reconciliationArtifacts(vault);

        assert.throws(() => reconcileMemory(vault, {
          sessionId: 'old',
          bySessionId: 'current',
          reason: scenario.reason,
          apply: true,
        }), scenario.error);

        assert.deepEqual(reconciliationArtifacts(vault), before);
      } finally { rmSync(vault, { recursive: true, force: true }); }
    });
  }
});

test('[req:OP-10] memory repair estrutural não reescreve o registry', async () => {
  const vault = fixture();
  const brain = join(vault, '.brain');
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), '');
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory());
  const registryPath = join(brain, 'SESSION_REGISTRY.json');
  writeFileSync(registryPath, '{\n  "version": 2,\n  "sessions": {}\n}\n');
  const before = readFileSync(registryPath, 'utf8');
  try {
    const { repairMemory } = await import('../src/memory.mjs');
    repairMemory(vault);
    assert.equal(readFileSync(registryPath, 'utf8'), before);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:OP-10] memory repair migra checkpoint causal pré-upgrade para boundary físico com CAS', async () => {
  const vault = fixture();
  const brain = join(vault, '.brain');
  const newer = {
    ...memoryEvent('mem-pre-upgrade-newer', 'new epoch state', 1),
    memory_key: 'handoff.newer',
    activation_id: 'activation-epoch-2',
    activation_epoch: 2,
    source_turn_id: 'turn-epoch-2',
    observed_at: '2026-07-26T12:02:00.000Z',
  };
  const olderLate = {
    ...memoryEvent('mem-pre-upgrade-older-late', 'old epoch appended late', 1),
    memory_key: 'handoff.older',
    activation_id: 'activation-epoch-1',
    activation_epoch: 1,
    source_turn_id: 'turn-epoch-1',
    observed_at: '2026-07-26T12:01:00.000Z',
  };
  const physicalLedger = [newer, olderLate];
  const causal = reduceMemoryEvents(physicalLedger);
  assert.equal(causal.eventCursor, newer.event_id);
  const legacyCheckpoint = {
    revision: causal.revision,
    event_cursor: causal.eventCursor,
    state_hash: causal.stateHash,
  };
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), `${physicalLedger.map(canonicalMemoryJson).join('\n')}\n`);
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory({
    revision: causal.revision,
    eventCursor: causal.eventCursor,
    stateHash: causal.stateHash,
    events: causal.activeEvents,
    updatedAt: newer.observed_at,
  }));
  const legacyAttempt = projectedAttempt('current-session', newer, legacyCheckpoint);
  const registryPath = join(brain, 'SESSION_REGISTRY.json');
  writeFileSync(registryPath, `${JSON.stringify({ version: 2, sessions: {
    'current-session': {
      memory_checkpoint: legacyCheckpoint,
      last_memory_attempt: legacyAttempt,
    },
  } }, null, 2)}\n`);
  const ledgerBefore = readFileSync(join(brain, 'MEMORY_EVENTS.jsonl'));
  const coreBefore = readFileSync(join(brain, 'CORE.md'));

  try {
    const beforeGate = spawnSync(process.execPath, [BIN, 'memory', 'status', '--gate', '--vault', vault], { encoding: 'utf8' });
    assert.equal(beforeGate.status, 1, beforeGate.stderr || beforeGate.stdout);
    assert.match(beforeGate.stdout, /stale|checkpoint|prefixo|cursor/i);

    const { repairMemory } = await import('../src/memory.mjs');
    const repaired = repairMemory(vault, { now: '2026-07-26T18:30:00.000Z' });
    assert.equal(repaired.checkpointMigration.status, 'migrated');
    assert.equal(repaired.checkpointMigration.migrated, 1);
    assert.deepEqual(readFileSync(join(brain, 'MEMORY_EVENTS.jsonl')), ledgerBefore);
    assert.deepEqual(readFileSync(join(brain, 'CORE.md')), coreBefore);

    const expected = deriveMemoryProjection(vault, physicalLedger).checkpoint;
    const migratedRegistry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const migrated = migratedRegistry.sessions['current-session'];
    assert.deepEqual(migrated.last_memory_attempt.checkpoint, expected);
    assert.deepEqual(migrated.memory_checkpoint, expected);
    assert.equal(migrated.memory_reconciliations.at(-1).type, 'legacy_causal_checkpoint_migrated');
    assert.deepEqual(migrated.memory_reconciliations.at(-1).original_checkpoint, legacyCheckpoint);
    assert.match(migrated.memory_reconciliations.at(-1).causal_proof.expected_ledger_sha256, /^[a-f0-9]{64}$/);
    assert.ok(existsSync(repaired.checkpointMigration.backupPath));

    const afterGate = spawnSync(process.execPath, [BIN, 'memory', 'status', '--gate', '--vault', vault], { encoding: 'utf8' });
    assert.equal(afterGate.status, 0, afterGate.stderr || afterGate.stdout);
    assert.notEqual(JSON.parse(afterGate.stdout).status, 'blocked');

    const registryAfterMigration = readFileSync(registryPath, 'utf8');
    const retry = repairMemory(vault, { now: '2026-07-26T18:31:00.000Z' });
    assert.equal(retry.checkpointMigration.status, 'unchanged');
    assert.equal(readFileSync(registryPath, 'utf8'), registryAfterMigration);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MOD-7] memory repair migra checkpoint assert-only pré-0.59 no prefixo histórico exato', async () => {
  const {
    vault, brain, physicalLedger, attemptPrefix, legacyCheckpoint, registryPath,
  } = historicalLegacyCheckpointFixture();
  const ledgerBefore = readFileSync(join(brain, 'MEMORY_EVENTS.jsonl'));
  const coreBefore = readFileSync(join(brain, 'CORE.md'));
  try {
    const beforeGate = spawnSync(process.execPath, [BIN, 'memory', 'status', '--gate', '--vault', vault], { encoding: 'utf8' });
    assert.equal(beforeGate.status, 1, beforeGate.stderr || beforeGate.stdout);
    assert.match(beforeGate.stdout, /checkpoint|prefixo/i);

    const { repairMemory } = await import('../src/memory.mjs');
    const repaired = repairMemory(vault, { now: '2026-07-28T12:30:00.000Z' });
    assert.equal(repaired.checkpointMigration.status, 'migrated');
    assert.equal(repaired.checkpointMigration.migrated, 1);
    assert.deepEqual(readFileSync(join(brain, 'MEMORY_EVENTS.jsonl')), ledgerBefore);
    assert.deepEqual(readFileSync(join(brain, 'CORE.md')), coreBefore);

    const expectedPrefix = deriveMemoryProjection(vault, attemptPrefix).checkpoint;
    const fullCheckpoint = deriveMemoryProjection(vault, physicalLedger).checkpoint;
    const migratedRegistry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const migrated = migratedRegistry.sessions['current-session'];
    assert.deepEqual(migrated.last_memory_attempt.checkpoint, expectedPrefix);
    assert.deepEqual(migrated.memory_checkpoint, expectedPrefix);
    assert.notDeepEqual(expectedPrefix, fullCheckpoint, 'historical attempt must not absorb later ledger events');
    assert.deepEqual(migrated.memory_reconciliations.at(-1).original_checkpoint, legacyCheckpoint);
    assert.ok(existsSync(repaired.checkpointMigration.backupPath));

    const afterGate = spawnSync(process.execPath, [BIN, 'memory', 'status', '--gate', '--vault', vault], { encoding: 'utf8' });
    assert.equal(afterGate.status, 0, afterGate.stderr || afterGate.stdout);
    const registryAfterMigration = readFileSync(registryPath, 'utf8');
    const retry = repairMemory(vault, { now: '2026-07-28T12:31:00.000Z' });
    assert.equal(retry.checkpointMigration.status, 'unchanged');
    assert.equal(readFileSync(registryPath, 'utf8'), registryAfterMigration);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

for (const scenario of [
  { name: 'hash legado adulterado', options: { tamperHash: true } },
  { name: 'operação não-assert no prefixo', options: { nonAssert: true } },
  { name: 'identidade de ativação divergente', options: { divergentIdentity: true } },
  { name: 'turn_sequence não crescente', options: { nonIncreasingTurn: true } },
  { name: 'espelho memory_checkpoint divergente', options: { divergentMirror: true } },
]) {
  test(`[req:MOD-7] memory repair falha fechado para ${scenario.name}`, async () => {
    const {
      vault, brain, registryPath,
    } = historicalLegacyCheckpointFixture(scenario.options);
    const registryBefore = readFileSync(registryPath, 'utf8');
    const ledgerBefore = readFileSync(join(brain, 'MEMORY_EVENTS.jsonl'));
    const coreBefore = readFileSync(join(brain, 'CORE.md'));
    try {
      const { repairMemory } = await import('../src/memory.mjs');
      const repaired = repairMemory(vault, { now: '2026-07-28T12:32:00.000Z' });
      assert.equal(repaired.checkpointMigration.status, 'unchanged');
      assert.equal(repaired.checkpointMigration.backupPath, null);
      assert.equal(readFileSync(registryPath, 'utf8'), registryBefore);
      assert.deepEqual(readFileSync(join(brain, 'MEMORY_EVENTS.jsonl')), ledgerBefore);
      assert.deepEqual(readFileSync(join(brain, 'CORE.md')), coreBefore);
      const gate = spawnSync(process.execPath, [BIN, 'memory', 'status', '--gate', '--vault', vault], { encoding: 'utf8' });
      assert.equal(gate.status, 1, gate.stderr || gate.stdout);
    } finally { rmSync(vault, { recursive: true, force: true }); }
  });
}

test('[req:MOD-7] migração faz CAS do espelho memory_checkpoint antes de criar backup', async () => {
  const {
    vault, brain, registryPath, currentCheckpoint,
  } = historicalLegacyCheckpointFixture();
  const registryBefore = JSON.parse(readFileSync(registryPath, 'utf8'));
  const ledgerBefore = readFileSync(join(brain, 'MEMORY_EVENTS.jsonl'));
  const coreBefore = readFileSync(join(brain, 'CORE.md'));
  const race = startCheckpointMirrorRace({
    vault, registryPath, checkpointValue: currentCheckpoint,
  });
  try {
    await race.ready;
    const { migrateLegacyMemoryCheckpoints } = await import('../src/memory.mjs');
    assert.throws(
      () => migrateLegacyMemoryCheckpoints(vault, { now: '2026-07-28T12:33:00.000Z' }),
      /CAS perdido: memory_checkpoint/i,
    );
    const outcome = await race.closed;
    assert.equal(outcome.code, 0, outcome.stderr || outcome.stdout);

    registryBefore.sessions['current-session'].memory_checkpoint = currentCheckpoint;
    assert.deepEqual(JSON.parse(readFileSync(registryPath, 'utf8')), registryBefore);
    assert.deepEqual(readFileSync(join(brain, 'MEMORY_EVENTS.jsonl')), ledgerBefore);
    assert.deepEqual(readFileSync(join(brain, 'CORE.md')), coreBefore);
    assert.equal(
      readdirSync(brain).some((name) => name.includes('.checkpoint-migrate-') && name.endsWith('.bak')),
      false,
    );
  } finally {
    await race.closed.catch(() => {});
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-10] ambiguous com event_ids falha antes de reprojetar ou criar backup', async () => {
  const vault = fixture();
  const brain = join(vault, '.brain');
  const existingEvent = { ...memoryEvent('mem-existing', 'existing', 1), canonical_session_id: 'current' };
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), `${canonicalMemoryJson(existingEvent)}\n`);
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), 'stale\n');
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory());
  const registryPath = join(brain, 'SESSION_REGISTRY.json');
  writeFileSync(registryPath, `${JSON.stringify({ version: 2, sessions: {
    old: { last_memory_attempt: { memory_mode: 'v2', state: 'skipped', disposition: 'ambiguous', event_ids: ['mem-existing'] } },
    current: { last_memory_attempt: projectedAttempt('current', existingEvent, checkpoint(reduceMemoryEvents([existingEvent]))) },
  } }, null, 2)}\n`);
  const sharedBefore = readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8');
  try {
    const { reconcileMemory } = await import('../src/memory.mjs');
    assert.throws(() => reconcileMemory(vault, {
      sessionId: 'old', bySessionId: 'current', reason: 'must fail', apply: true,
    }), /event_ids/i);
    assert.equal(readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8'), sharedBefore);
    assert.equal(readdirSync(brain).some((name) => name.includes('reconcile-') && name.endsWith('.bak')), false);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:OP-10] CAS impede superseder outro attempt ambíguo criado durante a reconciliação', async () => {
  const vault = fixture();
  const brain = join(vault, '.brain');
  const event = { ...memoryEvent('mem-race', 'current', 1), canonical_session_id: 'current' };
  const currentCheckpoint = checkpoint(reduceMemoryEvents([event]));
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), `${canonicalMemoryJson(event)}\n`);
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory());
  const registryPath = join(brain, 'SESSION_REGISTRY.json');
  const firstAttempt = { memory_mode: 'v2', state: 'skipped', disposition: 'ambiguous', event_ids: [], turn_id: 'first' };
  const successorAttempt = {
    ...projectedAttempt('current', event, currentCheckpoint),
  };
  writeFileSync(registryPath, `${JSON.stringify({ version: 2, sessions: {
    old: { last_memory_attempt: firstAttempt },
    current: { memory_checkpoint: currentCheckpoint, last_memory_attempt: successorAttempt },
  } }, null, 2)}\n`);
  try {
    const { reconcileMemory } = await import('../src/memory.mjs');
    assert.throws(() => reconcileMemory(vault, {
      sessionId: 'old',
      bySessionId: 'current',
      reason: 'race proof',
      apply: true,
      beforeRegistryMutation: () => {
        const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
        registry.sessions.old.last_memory_attempt = { ...firstAttempt, turn_id: 'second' };
        writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      },
    }), /mudou|CAS/i);
    const after = JSON.parse(readFileSync(registryPath, 'utf8'));
    assert.equal(after.sessions.old.last_memory_attempt.turn_id, 'second');
    assert.equal(after.sessions.old.last_memory_attempt.disposition, 'ambiguous');
    assert.equal(readdirSync(brain).some((name) => name.includes('reconcile-') && name.endsWith('.bak')), false);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:OP-10] memory status rejects an explicit missing vault instead of reporting healthy legacy mode', () => {
  const missing = join(tmpdir(), `wk-missing-vault-${process.pid}-${Date.now()}`);
  const result = spawnSync(process.execPath, [BIN, 'memory', 'status', '--gate', '--vault', missing], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not found/i);
  assert.doesNotMatch(result.stdout, /legacy/);
});

test('wendkeep memory roteia migrate dry-run/apply e expõe o comando no help', () => {
  const vault = fixture();
  try {
    const dry = spawnSync(process.execPath, [BIN, 'memory', 'migrate', '--vault', vault], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /dry-run/);
    assert.equal(existsSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl')), false);
    const apply = spawnSync(process.execPath, [BIN, 'memory', 'migrate', '--apply', '--vault', vault], { encoding: 'utf8' });
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /migrated/);
    const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    assert.match(help.stdout, /wendkeep memory/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:OP-10] CLI reconcile é dry-run por padrão e só aplica com autorização completa', () => {
  const vault = fixture();
  const brain = join(vault, '.brain');
  const event = { ...memoryEvent('mem-cli-reconcile', 'continued', 1), canonical_session_id: 'current' };
  const currentCheckpoint = checkpoint(reduceMemoryEvents([event]));
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), `${canonicalMemoryJson(event)}\n`);
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory());
  const registryPath = join(brain, 'SESSION_REGISTRY.json');
  writeFileSync(registryPath, `${JSON.stringify({ version: 2, sessions: {
    old: { last_memory_attempt: { memory_mode: 'v2', state: 'skipped', disposition: 'ambiguous', event_ids: [] } },
    current: {
      memory_checkpoint: currentCheckpoint,
      last_memory_attempt: projectedAttempt('current', event, currentCheckpoint),
    },
  } }, null, 2)}\n`);
  const before = readFileSync(registryPath, 'utf8');
  const args = ['memory', 'reconcile', 'old', '--by-session', 'current', '--reason', 'continued delivery', '--vault', vault];
  try {
    const dry = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /dry-run/);
    assert.equal(readFileSync(registryPath, 'utf8'), before);

    const apply = spawnSync(process.execPath, [BIN, ...args, '--apply'], { encoding: 'utf8' });
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /reconciled/);
    assert.equal(JSON.parse(readFileSync(registryPath, 'utf8')).sessions.old.last_memory_attempt.disposition, 'superseded');

    const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    assert.match(help.stdout, /reconcile <session>/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
