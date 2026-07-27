// [req:OP-10]
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalMemoryJson } from '../hooks/memory-store.mjs';
import { renderSharedMemory } from '../hooks/memory-schema.mjs';
import { LOCK_OWNER_FILE } from '../hooks/session-note-io.mjs';
import { renderCoreSkeleton } from '../src/validate-core.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function fixture() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-reconcile-hardening-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'PROJECT.json'), '{"schemaVersion":1,"projectId":"project-a"}\n');
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '{"candidate_id":"projection-sentinel"}\n');
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory());
  return vault;
}

function memoryEvent(eventId, canonicalSessionId, overrides = {}) {
  return {
    v: 1,
    project_id: 'project-a',
    event_id: eventId,
    memory_key: 'handoff.latest',
    operation: 'assert',
    value: 'causal proof',
    authority: 'reported',
    canonical_session_id: canonicalSessionId,
    activation_id: 'activation-current',
    activation_epoch: 1,
    turn_sequence: 1,
    source_turn_id: 'turn-current-1',
    observed_at: '2026-07-26T12:01:00.000Z',
    evidence: ['turn:1'],
    ...overrides,
  };
}

function validReconciliationFixture() {
  const vault = fixture();
  const brain = join(vault, '.brain');
  const event = memoryEvent('mem-current-proof', 'current');
  const successorAttempt = {
    v: 1,
    memory_mode: 'v2',
    canonical_session_id: 'current',
    activation_id: event.activation_id,
    activation_epoch: event.activation_epoch,
    turn_id: event.source_turn_id,
    turn_sequence: event.turn_sequence,
    state: 'projected',
    disposition: 'applied',
    event_ids: [event.event_id],
    checkpoint: null,
  };
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), `${canonicalMemoryJson(event)}\n`);
  writeFileSync(join(brain, 'SESSION_REGISTRY.json'), `${JSON.stringify({
    version: 2,
    sessions: {
      old: {
        last_memory_attempt: {
          v: 1,
          memory_mode: 'v2',
          state: 'skipped',
          disposition: 'ambiguous',
          event_ids: [],
        },
      },
      current: { last_memory_attempt: successorAttempt },
    },
  }, null, 2)}\n`);
  return { vault, brain, event, successorAttempt };
}

function brainSnapshot(vault, { exclude = [] } = {}) {
  const brain = join(vault, '.brain');
  const ignored = new Set(exclude);
  return Object.fromEntries(readdirSync(brain, { withFileTypes: true })
    .filter((entry) => !ignored.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => [entry.name, entry.isDirectory()
      ? '<directory>'
      : readFileSync(join(brain, entry.name)).toString('base64')]));
}

function reconciliationBytes(vault) {
  const brain = join(vault, '.brain');
  const read = (name) => readFileSync(join(brain, name), 'utf8');
  return {
    registry: read('SESSION_REGISTRY.json'),
    ledger: read('MEMORY_EVENTS.jsonl'),
    shared: read('SHARED_MEMORY.md'),
    candidates: read('MEMORY_CANDIDATES.jsonl'),
    core: read('CORE.md'),
    backups: readdirSync(brain).filter((name) => name.includes('.reconcile-')).sort(),
  };
}

function malformedCli(args) {
  const missingVault = join(tmpdir(), `wk-memory-reconcile-missing-${process.pid}-${Date.now()}`);
  rmSync(missingVault, { recursive: true, force: true });
  return spawnSync(process.execPath, [BIN, 'memory', 'reconcile', ...args, '--vault', missingVault], {
    encoding: 'utf8',
  });
}

test('[req:OP-10] reconcile rejeita event_ids de outra sessão e preserva todos os artefatos byte a byte', async () => {
  const vault = fixture();
  const brain = join(vault, '.brain');
  const event = memoryEvent('mem-borrowed-proof', 'other-session');
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), `${canonicalMemoryJson(event)}\n`);
  writeFileSync(join(brain, 'SESSION_REGISTRY.json'), `${JSON.stringify({
    version: 2,
    sessions: {
      old: {
        last_memory_attempt: {
          memory_mode: 'v2', state: 'skipped', disposition: 'ambiguous', event_ids: [],
        },
      },
      current: {
        last_memory_attempt: {
          memory_mode: 'v2', state: 'projected', disposition: 'applied', event_ids: [event.event_id],
        },
      },
    },
  }, null, 2)}\n`);
  const before = reconciliationBytes(vault);

  try {
    const { reconcileMemory } = await import('../src/memory.mjs');
    assert.throws(() => reconcileMemory(vault, {
      sessionId: 'old',
      bySessionId: 'current',
      reason: 'The current session must own its causal proof.',
      apply: true,
    }), /canonical_session_id|outra sess[aã]o|sess[aã]o reconciliadora/i);
    assert.deepEqual(reconciliationBytes(vault), before);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-10] apply exige PROJECT, CORE e ledger compatíveis antes de qualquer mutação', async (t) => {
  const { reconcileMemory } = await import('../src/memory.mjs');
  const cases = [
    {
      name: 'PROJECT ausente',
      mutate: ({ brain }) => rmSync(join(brain, 'PROJECT.json')),
      error: /PROJECT\.json.*ausente|PROJECT.*obrigat/i,
    },
    {
      name: 'CORE inválido',
      mutate: ({ brain }) => writeFileSync(join(brain, 'CORE.md'), '# CORE incompleto\n'),
      error: /CORE.*inv[aá]lid|se[cç][aã]o obrigat[oó]ria/i,
    },
    {
      name: 'ledger de outro projeto',
      mutate: ({ brain, event }) => writeFileSync(
        join(brain, 'MEMORY_EVENTS.jsonl'),
        `${canonicalMemoryJson({ ...event, project_id: 'project-b' })}\n`,
      ),
      error: /ledger.*inv[aá]lid|project_id|project-a/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const context = validReconciliationFixture();
      try {
        scenario.mutate(context);
        const before = brainSnapshot(context.vault);
        assert.throws(() => reconcileMemory(context.vault, {
          sessionId: 'old', bySessionId: 'current', reason: 'mandatory authority preflight', apply: true,
        }), scenario.error);
        assert.deepEqual(brainSnapshot(context.vault), before);
        assert.equal(existsSync(join(context.brain, 'MEMORY.lock')), false);
      } finally {
        rmSync(context.vault, { recursive: true, force: true });
      }
    });
  }
});

test('[req:OP-10] reconciliação rejeita autoridade por hardlink antes de sidecars, registry ou backup', async (t) => {
  const { reconcileMemory } = await import('../src/memory.mjs');
  for (const name of ['PROJECT.json', 'MEMORY_EVENTS.jsonl']) {
    await t.test(name, (subtest) => {
      const context = validReconciliationFixture();
      const outside = mkdtempSync(join(tmpdir(), 'wk-memory-reconcile-hardlink-outside-'));
      try {
        const target = join(context.brain, name);
        const source = join(outside, name);
        writeFileSync(source, readFileSync(target));
        rmSync(target);
        try {
          linkSync(source, target);
        } catch (error) {
          if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
            subtest.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
            return;
          }
          throw error;
        }
        const externalBefore = readFileSync(source);
        const before = brainSnapshot(context.vault);

        assert.throws(() => reconcileMemory(context.vault, {
          sessionId: 'old',
          bySessionId: 'current',
          reason: 'physical authority must belong exclusively to this Vault',
          apply: true,
        }), /hardlink|nlink|Vault/i);
        assert.deepEqual(readFileSync(source), externalBefore);
        assert.deepEqual(brainSnapshot(context.vault), before);
        assert.equal(readdirSync(context.brain).some((entry) => entry.includes('.reconcile-')), false);
      } finally {
        rmSync(context.vault, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }
});

test('[req:OP-10] proof exige identidade causal exata do successor attempt e de cada evento', async (t) => {
  const { reconcileMemory } = await import('../src/memory.mjs');
  const cases = [
    ['canonical_session_id do attempt', ({ successorAttempt }) => { successorAttempt.canonical_session_id = 'borrowed'; }],
    ['activation_id', ({ successorAttempt }) => { successorAttempt.activation_id = 'activation-borrowed'; }],
    ['activation_epoch', ({ successorAttempt }) => { successorAttempt.activation_epoch = 2; }],
    ['turn_id', ({ successorAttempt }) => { successorAttempt.turn_id = 'turn-borrowed'; }],
    ['turn_sequence', ({ successorAttempt }) => { successorAttempt.turn_sequence = 2; }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const context = validReconciliationFixture();
      try {
        mutate(context);
        writeFileSync(join(context.brain, 'SESSION_REGISTRY.json'), `${JSON.stringify({
          version: 2,
          sessions: {
            old: { last_memory_attempt: { memory_mode: 'v2', state: 'skipped', disposition: 'ambiguous', event_ids: [] } },
            current: { last_memory_attempt: context.successorAttempt },
          },
        }, null, 2)}\n`);
        const before = brainSnapshot(context.vault);
        assert.throws(() => reconcileMemory(context.vault, {
          sessionId: 'old', bySessionId: 'current', reason: 'exact causal identity', apply: true,
        }), /identidade causal|canonical_session_id|activation_|turn_/i);
        assert.deepEqual(brainSnapshot(context.vault), before);
      } finally {
        rmSync(context.vault, { recursive: true, force: true });
      }
    });
  }
});

test('[req:OP-10] ledger trocado depois do preflight aborta antes de registry, projeções e backup', async () => {
  const context = validReconciliationFixture();
  try {
    const { reconcileMemory } = await import('../src/memory.mjs');
    const registryBefore = readFileSync(join(context.brain, 'SESSION_REGISTRY.json'));
    const sharedBefore = readFileSync(join(context.brain, 'SHARED_MEMORY.md'));
    const candidatesBefore = readFileSync(join(context.brain, 'MEMORY_CANDIDATES.jsonl'));
    let swappedLedger;
    assert.throws(() => reconcileMemory(context.vault, {
      sessionId: 'old',
      bySessionId: 'current',
      reason: 'ledger snapshot binding',
      apply: true,
      beforeRegistryMutation: () => {
        swappedLedger = `${canonicalMemoryJson({ ...context.event, value: 'valid bytes swapped after preflight' })}\n`;
        writeFileSync(join(context.brain, 'MEMORY_EVENTS.jsonl'), swappedLedger);
      },
    }), /ledger.*mudou|snapshot.*ledger|TOCTOU|autoridade.*mudou/i);
    assert.equal(readFileSync(join(context.brain, 'MEMORY_EVENTS.jsonl'), 'utf8'), swappedLedger);
    assert.deepEqual(readFileSync(join(context.brain, 'SESSION_REGISTRY.json')), registryBefore);
    assert.deepEqual(readFileSync(join(context.brain, 'SHARED_MEMORY.md')), sharedBefore);
    assert.deepEqual(readFileSync(join(context.brain, 'MEMORY_CANDIDATES.jsonl')), candidatesBefore);
    assert.equal(readdirSync(context.brain).some((name) => name.includes('.reconcile-')), false);
  } finally {
    rmSync(context.vault, { recursive: true, force: true });
  }
});

test('[req:OP-10] CORE trocado depois do preflight invalida a prova vinculada ao hash', async () => {
  const context = validReconciliationFixture();
  try {
    const { reconcileMemory } = await import('../src/memory.mjs');
    const registryBefore = readFileSync(join(context.brain, 'SESSION_REGISTRY.json'));
    const ledgerBefore = readFileSync(join(context.brain, 'MEMORY_EVENTS.jsonl'));
    const sharedBefore = readFileSync(join(context.brain, 'SHARED_MEMORY.md'));
    const candidatesBefore = readFileSync(join(context.brain, 'MEMORY_CANDIDATES.jsonl'));
    let swappedCore;
    assert.throws(() => reconcileMemory(context.vault, {
      sessionId: 'old',
      bySessionId: 'current',
      reason: 'CORE snapshot binding',
      apply: true,
      beforeRegistryMutation: () => {
        swappedCore = `${renderCoreSkeleton().trimEnd()}\n<!-- valid CORE changed after authorization -->\n`;
        writeFileSync(join(context.brain, 'CORE.md'), swappedCore);
      },
    }), /CORE.*mudou|snapshot.*CORE|autoridade.*mudou/i);
    assert.equal(readFileSync(join(context.brain, 'CORE.md'), 'utf8'), swappedCore);
    assert.deepEqual(readFileSync(join(context.brain, 'SESSION_REGISTRY.json')), registryBefore);
    assert.deepEqual(readFileSync(join(context.brain, 'MEMORY_EVENTS.jsonl')), ledgerBefore);
    assert.deepEqual(readFileSync(join(context.brain, 'SHARED_MEMORY.md')), sharedBefore);
    assert.deepEqual(readFileSync(join(context.brain, 'MEMORY_CANDIDATES.jsonl')), candidatesBefore);
    assert.equal(readdirSync(context.brain).some((name) => name.includes('.reconcile-')), false);
  } finally {
    rmSync(context.vault, { recursive: true, force: true });
  }
});

test('[req:OP-10] CAS perdido não deixa sidecars reprojetados nem backup', async () => {
  const context = validReconciliationFixture();
  try {
    const { reconcileMemory } = await import('../src/memory.mjs');
    const sharedBefore = readFileSync(join(context.brain, 'SHARED_MEMORY.md'));
    const candidatesBefore = readFileSync(join(context.brain, 'MEMORY_CANDIDATES.jsonl'));
    assert.throws(() => reconcileMemory(context.vault, {
      sessionId: 'old', bySessionId: 'current', reason: 'CAS must precede projection', apply: true,
      beforeRegistryMutation: () => {
        const path = join(context.brain, 'SESSION_REGISTRY.json');
        const registry = JSON.parse(readFileSync(path, 'utf8'));
        registry.sessions.old.last_memory_attempt.turn_id = 'new-ambiguous-attempt';
        writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
      },
    }), /CAS|mudou/i);
    assert.deepEqual(readFileSync(join(context.brain, 'SHARED_MEMORY.md')), sharedBefore);
    assert.deepEqual(readFileSync(join(context.brain, 'MEMORY_CANDIDATES.jsonl')), candidatesBefore);
    assert.equal(readdirSync(context.brain).some((name) => name.includes('.reconcile-')), false);
  } finally {
    rmSync(context.vault, { recursive: true, force: true });
  }
});

test('[req:OP-10] MEMORY.lock ocupado faz CLI --apply falhar sem perder ambiguidade', () => {
  const context = validReconciliationFixture();
  const lock = join(context.brain, 'MEMORY.lock');
  try {
    mkdirSync(lock);
    const before = brainSnapshot(context.vault, { exclude: ['MEMORY.lock'] });
    const result = spawnSync(process.execPath, [
      BIN, 'memory', 'reconcile', 'old', '--by-session', 'current',
      '--reason', 'busy lock must fail closed', '--apply', '--vault', context.vault,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /MEMORY.*lock|ocupad|busy|indispon[ií]vel/i);
    assert.deepEqual(brainSnapshot(context.vault, { exclude: ['MEMORY.lock'] }), before);
    const registry = JSON.parse(readFileSync(join(context.brain, 'SESSION_REGISTRY.json'), 'utf8'));
    assert.equal(registry.sessions.old.last_memory_attempt.disposition, 'ambiguous');
  } finally {
    rmSync(context.vault, { recursive: true, force: true });
  }
});

test('[req:OP-10] MEMORY.lock antigo de PID ainda vivo não é roubado após staleMs', () => {
  const context = validReconciliationFixture();
  const lock = join(context.brain, 'MEMORY.lock');
  try {
    mkdirSync(lock);
    writeFileSync(join(lock, LOCK_OWNER_FILE), `${JSON.stringify({
      v: 1,
      pid: process.pid,
      token: 'live-memory-owner',
      created_at: '2000-01-01T00:00:00.000Z',
    })}\n`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(lock, LOCK_OWNER_FILE), old, old);
    utimesSync(lock, old, old);
    const before = brainSnapshot(context.vault, { exclude: ['MEMORY.lock'] });

    const result = spawnSync(process.execPath, [
      BIN, 'memory', 'reconcile', 'old', '--by-session', 'current',
      '--reason', 'live owner beats stale mtime', '--apply', '--vault', context.vault,
    ], { encoding: 'utf8' });

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /MEMORY.*lock|ocupad|indispon[ií]vel/i);
    assert.equal(JSON.parse(readFileSync(join(lock, LOCK_OWNER_FILE), 'utf8')).token, 'live-memory-owner');
    assert.deepEqual(brainSnapshot(context.vault, { exclude: ['MEMORY.lock'] }), before);
  } finally { rmSync(context.vault, { recursive: true, force: true }); }
});

test('[req:OP-10] MEMORY.lock por junction com owner stale é rejeitado sem entrar nem apagar bytes externos', (t) => {
  const context = validReconciliationFixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-memory-lock-junction-outside-'));
  const lock = join(context.brain, 'MEMORY.lock');
  const ownerPath = join(outside, LOCK_OWNER_FILE);
  try {
    const owner = `${JSON.stringify({
      v: 1,
      pid: 2_147_483_647,
      token: 'external-stale-owner',
      created_at: '2000-01-01T00:00:00.000Z',
    })}\n`;
    writeFileSync(ownerPath, owner);
    const old = new Date(Date.now() - 120_000);
    utimesSync(ownerPath, old, old);
    utimesSync(outside, old, old);
    try {
      symlinkSync(outside, lock, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`junctions indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    const before = brainSnapshot(context.vault, { exclude: ['MEMORY.lock'] });

    const result = spawnSync(process.execPath, [
      BIN, 'memory', 'reconcile', 'old', '--by-session', 'current',
      '--reason', 'external lock aliases cannot authorize reconciliation', '--apply', '--vault', context.vault,
    ], { encoding: 'utf8' });

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /link simbólico|junction|reparse|Vault/i);
    assert.equal(readFileSync(ownerPath, 'utf8'), owner, 'owner externo permanece byte a byte');
    assert.equal(lstatSync(lock).isSymbolicLink(), true, 'junction externo não é removido nem substituído');
    assert.deepEqual(brainSnapshot(context.vault, { exclude: ['MEMORY.lock'] }), before);
    const registry = JSON.parse(readFileSync(join(context.brain, 'SESSION_REGISTRY.json'), 'utf8'));
    assert.equal(registry.sessions.old.last_memory_attempt.disposition, 'ambiguous');
  } finally {
    rmSync(context.vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-10] retry idempotente ainda valida ledger, health e MEMORY.lock', async (t) => {
  const { reconcileMemory } = await import('../src/memory.mjs');
  const reason = 'idempotence is not a preflight bypass';

  async function appliedFixture() {
    const context = validReconciliationFixture();
    reconcileMemory(context.vault, {
      sessionId: 'old', bySessionId: 'current', reason, apply: true,
    });
    return context;
  }

  await t.test('ledger corrompido', async () => {
    const context = await appliedFixture();
    try {
      writeFileSync(join(context.brain, 'MEMORY_EVENTS.jsonl'), '{partial');
      const before = brainSnapshot(context.vault);
      assert.throws(() => reconcileMemory(context.vault, {
        sessionId: 'old', bySessionId: 'current', reason, apply: true,
      }), /ledger.*inv[aá]lid|JSON inv[aá]lido|parcial/i);
      assert.deepEqual(brainSnapshot(context.vault), before);
    } finally { rmSync(context.vault, { recursive: true, force: true }); }
  });

  await t.test('health bloqueado', async () => {
    const context = await appliedFixture();
    try {
      writeFileSync(join(context.brain, 'SHARED_MEMORY.md'), '# projection corrupt\n');
      const before = brainSnapshot(context.vault);
      assert.throws(() => reconcileMemory(context.vault, {
        sessionId: 'old', bySessionId: 'current', reason, apply: true,
      }), /health|bundle|bloquead|SHARED/i);
      assert.deepEqual(brainSnapshot(context.vault), before);
    } finally { rmSync(context.vault, { recursive: true, force: true }); }
  });

  await t.test('audit matching sem causal_proof', async () => {
    const context = await appliedFixture();
    try {
      const registryPath = join(context.brain, 'SESSION_REGISTRY.json');
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      delete registry.sessions.old.memory_reconciliations[0].causal_proof;
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      const before = brainSnapshot(context.vault);
      assert.throws(() => reconcileMemory(context.vault, {
        sessionId: 'old', bySessionId: 'current', reason, apply: true,
      }), /causal_proof|prova causal.*ausente|audit.*inv[aá]lid/i);
      assert.deepEqual(brainSnapshot(context.vault), before);
    } finally { rmSync(context.vault, { recursive: true, force: true }); }
  });

  await t.test('ledger avançou e o health continua íntegro', async () => {
    const context = await appliedFixture();
    try {
      const later = memoryEvent('mem-later-proof', 'later-session', {
        activation_id: 'activation-later',
        activation_epoch: 2,
        source_turn_id: 'turn-later-1',
        turn_sequence: 1,
        observed_at: '2026-07-26T12:02:00.000Z',
      });
      const ledgerPath = join(context.brain, 'MEMORY_EVENTS.jsonl');
      writeFileSync(ledgerPath, `${readFileSync(ledgerPath, 'utf8')}${canonicalMemoryJson(later)}\n`);
      const { reprojectMemoryLedger } = await import('../hooks/memory-store.mjs');
      reprojectMemoryLedger(context.vault);
      const before = brainSnapshot(context.vault);
      const retry = reconcileMemory(context.vault, {
        sessionId: 'old', bySessionId: 'current', reason, apply: true,
      });
      assert.equal(retry.status, 'unchanged');
      assert.deepEqual(brainSnapshot(context.vault), before);
    } finally { rmSync(context.vault, { recursive: true, force: true }); }
  });

  await t.test('lock ocupado', async () => {
    const context = await appliedFixture();
    try {
      mkdirSync(join(context.brain, 'MEMORY.lock'));
      const before = brainSnapshot(context.vault, { exclude: ['MEMORY.lock'] });
      const result = spawnSync(process.execPath, [
        BIN, 'memory', 'reconcile', 'old', '--by-session', 'current',
        '--reason', reason, '--apply', '--vault', context.vault,
      ], { encoding: 'utf8' });
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(brainSnapshot(context.vault, { exclude: ['MEMORY.lock'] }), before);
    } finally { rmSync(context.vault, { recursive: true, force: true }); }
  });
});

test('[req:OP-10] CLI rejeita --reason seguido de outra flag antes de consultar o Vault', () => {
  const result = malformedCli(['old', '--by-session', 'current', '--reason', '--apply']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--reason.*valor|valor.*--reason/i);
  assert.doesNotMatch(result.stderr, /not found/i);
});

test('[req:OP-10] CLI rejeita opção duplicada antes de consultar o Vault', () => {
  const result = malformedCli([
    'old', '--by-session', 'current', '--reason', 'first', '--reason=second',
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /duplicad.*--reason|--reason.*duplicad/i);
  assert.doesNotMatch(result.stderr, /not found/i);
});

test('[req:OP-10] CLI rejeita opção desconhecida antes de consultar o Vault', () => {
  const result = malformedCli([
    'old', '--by-session', 'current', '--reason', 'valid reason', '--unknown', 'value',
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /op[cç][aã]o desconhecida.*--unknown/i);
  assert.doesNotMatch(result.stderr, /not found/i);
});

test('[req:OP-10] CLI rejeita argumento posicional extra antes de consultar o Vault', () => {
  const result = malformedCli([
    'old', 'extra', '--by-session', 'current', '--reason', 'valid reason',
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /posicional extra.*extra/i);
  assert.doesNotMatch(result.stderr, /not found/i);
});
