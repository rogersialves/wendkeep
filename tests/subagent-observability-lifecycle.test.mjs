import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { refreshSubagents } from '../hooks/subagent-stop.mjs';
import { refreshStopObservability } from '../hooks/session-stop.mjs';

function fixture() {
  const vaultBase = mkdtempSync(join(tmpdir(), 'wk-observability-hook-'));
  const sessionRel = join('02-Sessões', 'synthetic-session.md');
  const sessionPath = join(vaultBase, sessionRel);
  mkdirSync(join(vaultBase, '02-Sessões'), { recursive: true });
  writeFileSync(sessionPath, '---\ntype: session\nprovider: codex\n---\n\n# Synthetic session\n');
  return {
    vaultBase,
    sessionRel,
    sessionPath,
    rootA: join(vaultBase, 'root-a.jsonl'),
    rootB: join(vaultBase, 'root-b.jsonl'),
  };
}

function registryEntry(fx, {
  activationId = 'activation-a',
  epoch = 2,
  turnSequence = 7,
} = {}) {
  return {
    provider: 'codex',
    session_file: fx.sessionRel,
    transcript_path: fx.rootA,
    transcript_paths: [fx.rootA, fx.rootB],
    active_activation_id: activationId,
    activation_epoch: epoch,
    last_turn_sequence: turnSequence,
    activations: {
      [activationId]: {
        activation_id: activationId,
        epoch,
        status: 'active',
        last_turn_sequence: turnSequence,
      },
    },
  };
}

function resolved(input, entry) {
  return {
    identity: {
      state: 'resolved',
      provider: 'codex',
      canonicalConversationId: 'wk-fixture-session-alpha',
      transcriptPath: input.transcript_path,
      transcriptId: basename(input.transcript_path, '.jsonl'),
    },
    entry,
  };
}

function registryMutation(entry) {
  const registry = { version: 2, sessions: { 'wk-fixture-session-alpha': entry } };
  return (_vault, mutator) => mutator(registry);
}

function childMeta(path) {
  const id = basename(path, '.jsonl');
  if (id.startsWith('root-')) {
    return {
      ok: true,
      meta: { id, session_id: 'wk-fixture-session-alpha' },
      lineBytes: 96,
    };
  }
  return {
    ok: true,
    meta: {
      id,
      session_id: 'wk-fixture-session-alpha',
      source: {
        subagent: {
          thread_spawn: { parent_thread_id: 'root-a', depth: 1 },
        },
      },
    },
    lineBytes: 128,
  };
}

test('[req:OBS-11] alias agentTranscriptPath resolve o filho sem substituir o root principal', async () => {
  const fx = fixture();
  try {
    const entry = registryEntry(fx);
    const childPath = join(fx.vaultBase, 'child-alias.jsonl');
    let signals = 0;

    const result = await refreshSubagents(fx.vaultBase, {
      provider: 'codex',
      transcript_path: fx.rootA,
      agentTranscriptPath: childPath,
    }, {
      resolveEntry: (_vault, input) => {
        assert.equal(input.transcript_path, childPath);
        return resolved(input, entry);
      },
      readMeta: childMeta,
      mutateRegistry: registryMutation(entry),
      resolveRoots: () => ({ state: 'complete', rootPaths: [fx.rootA], descendantPaths: [] }),
      recordSignal: (_vault, _sessionId, signal) => {
        signals += 1;
        assert.equal(signal.rollout_id, 'child-alias');
        assert.equal(signal.transcript_path, childPath);
        return {
          recorded: true,
          sequence: 1,
          state: { observability_dirty: false, observability_signal_sequence: 1 },
        };
      },
    });

    assert.equal(result, true);
    assert.equal(signals, 1);
    assert.equal(entry.transcript_path, fx.rootA);
  } finally {
    rmSync(fx.vaultBase, { recursive: true, force: true });
  }
});

test('[req:OBS-11] metadado filho inválido ou pai alheio é rejeitado sem escrita', async () => {
  const fx = fixture();
  try {
    const entry = registryEntry(fx);
    const cases = [
      ['source.subagent ausente', (meta) => { delete meta.source; }],
      ['id divergente', (meta) => { meta.id = 'outro-filho'; }],
      ['sessão canônica divergente', (meta) => { meta.session_id = 'wk-fixture-session-other'; }],
      ['parent_thread_id alheio', (meta) => {
        meta.source.subagent.thread_spawn.parent_thread_id = 'root-alheio';
      }],
    ];

    for (const [label, corrupt] of cases) {
      const childPath = join(fx.vaultBase, `child-${label.replace(/\W+/g, '-')}.jsonl`);
      let registryMutations = 0;
      let signals = 0;
      const result = await refreshSubagents(fx.vaultBase, {
        provider: 'codex',
        transcript_path: fx.rootA,
        agent_transcript_path: childPath,
      }, {
        resolveEntry: (_vault, input) => resolved(input, entry),
        readMeta: (path) => {
          const resultMeta = childMeta(path);
          if (path === childPath) corrupt(resultMeta.meta);
          return resultMeta;
        },
        resolveRoots: () => ({ state: 'complete', rootPaths: [fx.rootA], descendantPaths: [] }),
        mutateRegistry: (_vault, mutator) => {
          registryMutations += 1;
          return registryMutation(entry)(_vault, mutator);
        },
        recordSignal: () => {
          signals += 1;
          return { state: { observability_dirty: false }, sequence: 1 };
        },
      });

      assert.equal(result, false, label);
      assert.equal(registryMutations, 0, `${label}: registry permanece intocado`);
      assert.equal(signals, 0, `${label}: nenhum sinal é persistido`);
    }
  } finally {
    rmSync(fx.vaultBase, { recursive: true, force: true });
  }
});

test('[req:OBS-11] rajada de SubagentStop publica uma vez pela maior sequence após 250 ms', async () => {
  const fx = fixture();
  try {
    const entry = registryEntry(fx);
    const events = [];
    const sleepers = [];
    const signals = new Map();
    let sequence = 0;

    const deps = {
      now: () => 1_000,
      sleep: (ms) => new Promise((resolve) => {
        events.push(`sleep:${ms}`);
        sleepers.push(resolve);
      }),
      resolveEntry: (_vault, input) => resolved(input, entry),
      readMeta: childMeta,
      mutateRegistry: registryMutation(entry),
      recordSignal: (_vault, _sessionId, signal) => {
        assert.equal(signal.parent_thread_id, 'root-a');
        assert.equal(signal.kind, 'started');
        events.push(`signal:${signal.rollout_id}`);
        if (!signals.has(signal.rollout_id)) signals.set(signal.rollout_id, ++sequence);
        return {
          recorded: true,
          duplicate: false,
          sequence: signals.get(signal.rollout_id),
          state: { observability_dirty: true, observability_signal_sequence: sequence },
        };
      },
      readStore: () => ({
        observability_dirty: true,
        observability_signal_sequence: sequence,
        signals: [...signals].map(([rollout_id]) => ({ rollout_id })),
        graph_cache: { fixture: 'cached' },
      }),
      acquireLease: (_vault, _sessionId, lease) => {
        events.push(`lease:${lease.signalSequence}`);
        return {
          acquired: true,
          ownerToken: 'lease-owner',
          state: {
            signals: [...signals].map(([rollout_id]) => ({ rollout_id })),
            graph_cache: { fixture: 'cached' },
          },
        };
      },
      releaseLease: () => {
        events.push('release');
        return { released: true };
      },
      resolveRoots: () => ({
        state: 'complete',
        rootPaths: [fx.rootA, fx.rootB],
        descendantPaths: [],
        diagnostics: [],
      }),
      materialize: async (request) => {
        events.push(`publish:${request.signalSequence}`);
        assert.deepEqual(request.rootPaths, [fx.rootA, fx.rootB]);
        assert.equal(request.transcriptPath, fx.rootA, 'o filho nunca vira main');
        assert.equal(request.allowNone, false, 'SubagentStop nunca autoriza publicação none');
        assert.equal(request.deadlineAt, 16_000, 'deadline absoluto nasce na entrada do hook');
        assert.equal(request.frontier.signal_sequence, 3);
        assert.deepEqual(request.signals.map((signal) => signal.rollout_id), [
          'child-a', 'child-b', 'child-c',
        ]);
        assert.deepEqual(request.cache, { fixture: 'cached' });
        assert.equal(request.withPublicationGuard(request.frontier, (guardContext) => {
          assert.equal(guardContext.entry.observability_signal_sequence, 3);
          assert.equal(
            request.readRuntimeFrontier(request.frontier, guardContext).signal_sequence,
            3,
          );
          return true;
        }), true, 'CAS roda sob a guarda do registry');
        return { status: 'published' };
      },
    };

    const pending = ['child-a', 'child-b', 'child-c'].map((id) => (
      refreshSubagents(fx.vaultBase, {
        provider: 'codex',
        transcript_path: fx.rootA,
        agent_transcript_path: join(fx.vaultBase, `${id}.jsonl`),
      }, deps)
    ));
    await Promise.resolve();

    assert.equal(sleepers.length, 3, 'todos os sinais são persistidos antes da janela');
    sleepers.forEach((resolve) => resolve());
    assert.deepEqual(await Promise.all(pending), [true, true, true]);

    assert.deepEqual(events.filter((event) => event.startsWith('signal:')), [
      'signal:child-a',
      'signal:child-b',
      'signal:child-c',
    ]);
    assert.deepEqual(events.filter((event) => event.startsWith('lease:')), ['lease:3']);
    assert.deepEqual(events.filter((event) => event.startsWith('publish:')), ['publish:3']);
    assert.equal(events.filter((event) => event === 'release').length, 1);
  } finally {
    rmSync(fx.vaultBase, { recursive: true, force: true });
  }
});

test('[req:OBS-11] SubagentStop respeita deadline absoluto de 15 s e mantém dirty', async () => {
  const fx = fixture();
  try {
    const entry = registryEntry(fx);
    let nowCalls = 0;
    let materializations = 0;
    let leases = 0;
    const result = await refreshSubagents(fx.vaultBase, {
      provider: 'codex',
      transcript_path: join(fx.vaultBase, 'child-deadline.jsonl'),
    }, {
      now: () => (++nowCalls === 1 ? 10_000 : 25_000),
      sleep: async (ms) => assert.equal(ms, 250),
      resolveEntry: (_vault, input) => resolved(input, entry),
      readMeta: childMeta,
      mutateRegistry: registryMutation(entry),
      recordSignal: () => ({
        recorded: true,
        duplicate: false,
        sequence: 1,
        state: { observability_dirty: true, observability_signal_sequence: 1 },
      }),
      readStore: () => ({ observability_dirty: true, observability_signal_sequence: 1 }),
      acquireLease: () => { leases += 1; return { acquired: true, ownerToken: 'late' }; },
      releaseLease: () => ({ released: true }),
      resolveRoots: () => ({ state: 'complete', rootPaths: [fx.rootA], diagnostics: [] }),
      materialize: () => { materializations += 1; return { status: 'published' }; },
    });

    assert.equal(result, true, 'o sinal foi aceito mesmo quando materialização não coube');
    assert.equal(leases, 0, 'não inicia lease sem orçamento restante');
    assert.equal(materializations, 0);
  } finally {
    rmSync(fx.vaultBase, { recursive: true, force: true });
  }
});

test('[req:OBS-11] activation, turn ou signal mais novo impedem SubagentStop atrasado', async () => {
  const fx = fixture();
  try {
    const original = registryEntry(fx);
    for (const stale of ['activation', 'turn', 'signal']) {
      let resolves = 0;
      let materializations = 0;
      let releases = 0;
      const newer = stale === 'activation'
        ? registryEntry(fx, { activationId: 'activation-b', epoch: 3 })
        : stale === 'turn'
          ? registryEntry(fx, { turnSequence: 8 })
          : original;
      const result = await refreshSubagents(fx.vaultBase, {
        provider: 'codex',
        transcript_path: join(fx.vaultBase, `child-${stale}.jsonl`),
      }, {
        now: () => 1_000,
        sleep: async () => {},
        resolveEntry: (_vault, input) => resolved(input, ++resolves === 1 ? original : newer),
        readMeta: childMeta,
        mutateRegistry: registryMutation(original),
        recordSignal: () => ({
          recorded: true,
          duplicate: false,
          sequence: 1,
          state: { observability_dirty: true, observability_signal_sequence: 1 },
        }),
        readStore: () => ({
          observability_dirty: true,
          observability_signal_sequence: stale === 'signal' ? 2 : 1,
        }),
        acquireLease: () => ({ acquired: true, ownerToken: `owner-${stale}` }),
        releaseLease: () => { releases += 1; return { released: true }; },
        resolveRoots: () => ({ state: 'complete', rootPaths: [fx.rootA], diagnostics: [] }),
        materialize: () => { materializations += 1; return { status: 'published' }; },
      });

      assert.equal(result, true, `${stale}: sinal permanece para convergência posterior`);
      assert.equal(materializations, 0, `${stale}: candidate atrasado não publica`);
      assert.equal(releases, stale === 'signal' ? 0 : 1, `${stale}: lease adquirida é liberada`);
    }
  } finally {
    rmSync(fx.vaultBase, { recursive: true, force: true });
  }
});

test('[req:OBS-12] SessionStop usa gate causal, todos os roots e deadline entry +45 s', async () => {
  const fx = fixture();
  try {
    const entry = registryEntry(fx);
    const requests = [];
    const base = {
      vaultBase: fx.vaultBase,
      input: { provider: 'codex', transcript_path: fx.rootA },
      sessionPath: fx.sessionPath,
      sessionId: 'wk-fixture-session-alpha',
      entry,
      causalStop: {
        canPromoteMemory: true,
        activationId: 'activation-a',
        activation: { epoch: 2 },
      },
      turnSequence: 7,
      hookStartedAt: 2_000,
    };
    const deps = {
      now: () => 3_000,
      resolveEntry: (_vault, input) => resolved(input, entry),
      mutateRegistry: registryMutation(entry),
      readStore: () => ({ observability_signal_sequence: 4 }),
      resolveRoots: () => ({
        state: 'complete', rootPaths: [fx.rootA, fx.rootB], diagnostics: [],
      }),
      materialize: async (request) => {
        requests.push(request);
        assert.equal(request.withPublicationGuard(request.frontier, (guardContext) => {
          assert.equal(guardContext.entry.active_activation_id, 'activation-a');
          return true;
        }), true);
        return { status: 'published' };
      },
    };

    assert.equal(await refreshStopObservability(base, deps), true);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].rootPaths, [fx.rootA, fx.rootB]);
    assert.equal(requests[0].deadlineAt, 47_000);
    assert.equal(requests[0].signalSequence, 4);
    assert.equal(requests[0].frontier.signal_sequence, 4);
    assert.equal(requests[0].allowNone, true, 'Stop causal pode comprovar none');

    requests.length = 0;
    assert.equal(await refreshStopObservability({
      ...base,
      causalStop: { ...base.causalStop, canPromoteMemory: false },
    }, deps), false);
    assert.equal(requests.length, 0, 'gate causal rejeitado impede composição/publicação');
  } finally {
    rmSync(fx.vaultBase, { recursive: true, force: true });
  }
});

test('[req:OBS-12] SessionStop stale ou no limite do deadline não publica', async () => {
  const fx = fixture();
  try {
    const original = registryEntry(fx);
    const base = {
      vaultBase: fx.vaultBase,
      input: { provider: 'codex', transcript_path: fx.rootA },
      sessionPath: fx.sessionPath,
      sessionId: 'wk-fixture-session-alpha',
      entry: original,
      causalStop: {
        canPromoteMemory: true,
        activationId: 'activation-a',
        activation: { epoch: 2 },
      },
      turnSequence: 7,
      hookStartedAt: 5_000,
    };

    for (const stale of ['activation', 'turn', 'signal', 'deadline']) {
      let materializations = 0;
      const freshEntry = stale === 'activation'
        ? registryEntry(fx, { activationId: 'activation-b', epoch: 3 })
        : stale === 'turn'
          ? registryEntry(fx, { turnSequence: 8 })
          : original;
      const result = await refreshStopObservability({
        ...base,
        expectedSignalSequence: 4,
      }, {
        now: () => (stale === 'deadline' ? 50_000 : 6_000),
        resolveEntry: (_vault, input) => resolved(input, freshEntry),
        readStore: () => ({ observability_signal_sequence: stale === 'signal' ? 5 : 4 }),
        resolveRoots: () => ({ state: 'complete', rootPaths: [fx.rootA], diagnostics: [] }),
        materialize: () => { materializations += 1; return { status: 'published' }; },
      });

      assert.equal(result, false, stale);
      assert.equal(materializations, 0, `${stale}: nenhuma publicação`);
    }
  } finally {
    rmSync(fx.vaultBase, { recursive: true, force: true });
  }
});
