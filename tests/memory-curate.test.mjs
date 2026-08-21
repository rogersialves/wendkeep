import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import { canonicalMemoryJson, prepareMemoryProjection } from '../hooks/memory-store.mjs';
import { listMemoryCandidatesForCuration } from '../src/memory.mjs';
import { renderCoreSkeleton } from '../src/validate-core.mjs';
import {
  parseMemoryCurateArgs,
  renderMemoryConflict,
  runGuidedMemoryCuration,
  runMemoryCurateCli,
} from '../src/memory-curate.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'wendkeep.mjs');

function fixture(candidates, { sessions } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-curate-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(
    join(brain, 'MEMORY_CANDIDATES.jsonl'),
    `${candidates.map((candidate) => JSON.stringify(candidate)).join('\n')}\n`,
  );
  if (sessions) {
    writeFileSync(
      join(brain, 'SESSION_REGISTRY.json'),
      `${JSON.stringify({ version: 2, sessions })}\n`,
    );
  }
  return vault;
}

function durableFixture() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-curate-durable-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'PROJECT.json'), '{"schemaVersion":1,"projectId":"project-a"}\n');
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  const event = (eventId, memoryKey, value, session, turn) => ({
    v: 1,
    project_id: 'project-a',
    event_id: eventId,
    memory_key: memoryKey,
    operation: 'assert',
    value,
    authority: 'reported',
    canonical_session_id: session,
    activation_id: `activation-${session}`,
    activation_epoch: 1,
    turn_sequence: turn,
    source_turn_id: `turn-${eventId}`,
    observed_at: `2026-08-02T1${turn}:00:00.000Z`,
    evidence: [`turn:${turn}`],
  });
  const events = [
    event('mem-handoff-a', 'handoff.latest', 'handoff A', 'session-a', 1),
    event('mem-handoff-b', 'handoff.latest', 'handoff B', 'session-b', 2),
    event('mem-verdict-a', 'quality.latest-verdict', 'verdict A', 'session-c', 3),
    event('mem-verdict-b', 'quality.latest-verdict', 'verdict B', 'session-d', 4),
  ];
  const projection = prepareMemoryProjection(vault, events);
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), `${events.map(canonicalMemoryJson).join('\n')}\n`);
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), projection.candidatesContent);
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), projection.sharedContent);
  return vault;
}

test('[req:MEM-CUR-5] curation view exposes two interpretable choices without raw memory', () => {
  const vault = fixture([
    {
      candidate_id: 'memcand-guided',
      reason: 'conflict',
      status: 'active',
      memory_key: 'handoff.latest',
      event_ids: ['mem-b', 'mem-a'],
      values: ['raw-a', 'raw-b'],
      events: [
        {
          event_id: 'mem-b',
          value: `TOKEN=super-private-token ${'x'.repeat(220)}`,
          observed_at: '2026-08-02T17:00:00.000Z',
          canonical_session_id: 'session-b',
        },
        {
          event_id: 'mem-a',
          value: 'handoff for private@company.dev\nfrom\tC:\\Users\\private\\transcript.jsonl',
          observed_at: '2026-08-02T16:00:00.000Z',
          source_turn_id: 'turn-a',
        },
      ],
    },
    {
      candidate_id: 'memcand-done',
      reason: 'conflict',
      status: 'resolved',
      memory_key: 'handoff.latest',
      event_ids: ['mem-done'],
      events: [{ event_id: 'mem-done', value: 'must-not-render' }],
    },
    {
      candidate_id: 'memcand-core',
      reason: 'blocked_by_core',
      status: 'blocked_by_core',
      memory_key: 'release.push',
      event_ids: ['mem-core'],
      events: [{ event_id: 'mem-core', value: 'must-not-render-either' }],
    },
  ]);

  try {
    const candidates = listMemoryCandidatesForCuration(vault);
    assert.equal(candidates.length, 1);
    const [candidate] = candidates;
    assert.deepEqual(
      Object.keys(candidate).sort(),
      ['candidate_id', 'classification', 'events', 'memory_key', 'reason', 'status'],
    );
    assert.equal(candidate.classification, 'unknown');
    assert.deepEqual(candidate.events.map((event) => event.event_id), ['mem-a', 'mem-b']);
    assert.deepEqual(candidate.events.map((event) => event.source), ['turn', 'session']);
    assert.deepEqual(
      Object.keys(candidate.events[0]).sort(),
      ['event_id', 'observed_at', 'preview', 'source'],
    );
    assert.match(candidate.events[0].preview, /REDACTED_EMAIL|REDACTED_LOCAL_PATH/);
    assert.doesNotMatch(candidate.events[0].preview, /[\r\n\t]/);
    assert.match(candidate.events[1].preview, /TOKEN=\[REDACTED_SECRET\]/);
    assert.ok(candidate.events[1].preview.length <= 161);
    assert.match(candidate.events[1].preview, /…$/);

    const rendered = JSON.stringify(candidates);
    assert.doesNotMatch(
      rendered,
      /super-private-token|private@company\.dev|C:\\\\Users\\\\private|raw-a|raw-b|must-not-render/,
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-HANDOFF-2] terminal handoffs are historical while active or unproven sessions stay actionable', () => {
  const candidate = {
    candidate_id: 'memcand-historical',
    reason: 'conflict',
    status: 'active',
    memory_key: 'handoff.latest',
    event_ids: ['mem-a', 'mem-b'],
    events: [
      { event_id: 'mem-a', value: 'done A', canonical_session_id: 'session-a' },
      { event_id: 'mem-b', value: 'done B', canonical_session_id: 'session-b' },
    ],
  };
  const terminal = fixture([candidate], {
    sessions: {
      'session-a': { status: 'done', change_slug: 'change-a' },
      'session-b': { status: 'superseded', change_slug: 'change-b' },
    },
  });
  const active = fixture([candidate], {
    sessions: {
      'session-a': { status: 'done' },
      'session-b': { status: 'active' },
    },
  });
  const unknown = fixture([candidate], { sessions: { 'session-a': { status: 'done' } } });
  try {
    assert.deepEqual(listMemoryCandidatesForCuration(terminal), []);
    const [historical] = listMemoryCandidatesForCuration(terminal, { includeHistorical: true });
    assert.equal(historical.classification, 'historical');
    assert.equal(historical.recommended_action, 'reject');
    assert.deepEqual(historical.events.map((item) => item.session_status), ['done', 'superseded']);
    assert.deepEqual(historical.events.map((item) => item.change_slug), ['change-a', 'change-b']);

    const [actionable] = listMemoryCandidatesForCuration(active);
    assert.equal(actionable.classification, 'actionable');
    assert.equal(actionable.recommended_action, undefined);

    const [unproven] = listMemoryCandidatesForCuration(unknown);
    assert.equal(unproven.classification, 'unknown');
    assert.equal(unproven.recommended_action, undefined);
  } finally {
    rmSync(terminal, { recursive: true, force: true });
    rmSync(active, { recursive: true, force: true });
    rmSync(unknown, { recursive: true, force: true });
  }
});

function guidedCandidate(id = 'c1', key = 'handoff.latest') {
  return {
    candidate_id: id,
    reason: 'conflict',
    status: 'active',
    memory_key: key,
    events: [
      {
        event_id: `${id}-e1`, observed_at: '2026-08-02T16:00:00.000Z',
        source: 'session', preview: 'first safe preview',
      },
      {
        event_id: `${id}-e2`, observed_at: '2026-08-02T17:00:00.000Z',
        source: 'session', preview: 'second safe preview',
      },
    ],
  };
}

function historicalCandidate(id) {
  return {
    ...guidedCandidate(id),
    classification: 'historical',
    recommended_action: 'reject',
    events: guidedCandidate(id).events.map((item) => ({ ...item, session_status: 'done' })),
  };
}

async function drive(answers, initial = [guidedCandidate()], { decisionError, decisionResult } = {}) {
  const queue = [...answers];
  const writes = [];
  const applied = [];
  let candidates = [...initial];
  let loads = 0;
  const result = await runGuidedMemoryCuration('C:\\safe-vault', {
    locale: 'pt-BR',
    ask: async () => queue.shift() ?? 'q',
    write: (text) => writes.push(String(text)),
    loadCandidates: () => {
      loads += 1;
      return candidates;
    },
    decide: (_vault, decision) => {
      applied.push(decision);
      if (decisionError) throw decisionError;
      if (decisionResult) return decisionResult;
      candidates = candidates.filter((candidate) => candidate.candidate_id !== decision.candidateId);
      return { status: decision.action === 'promote' ? 'promoted' : 'rejected' };
    },
  });
  return { result, writes: writes.join(''), applied, loads };
}

test('[req:MEM-CUR-6] default-no never mutates and affirmative promotion selects the numbered event', async () => {
  const declined = await drive(['1', '', 'q']);
  assert.equal(declined.result.decisions, 0);
  assert.deepEqual(declined.applied, []);

  const confirmed = await drive(['2', 's']);
  assert.equal(confirmed.result.decisions, 1);
  assert.deepEqual(confirmed.applied, [{
    action: 'promote', candidateId: 'c1', eventId: 'c1-e2',
  }]);
  assert.ok(confirmed.loads >= 2, 'reloads after a confirmed decision');
});

test('[req:MEM-CUR-5] [req:MEM-CUR-6] skip, reject, details and quit have explicit effects', async () => {
  const skipped = await drive(['p']);
  assert.equal(skipped.result.skipped, 1);
  assert.deepEqual(skipped.applied, []);

  const rejected = await drive(['r', 's']);
  assert.deepEqual(rejected.applied, [{ action: 'reject', candidateId: 'c1' }]);

  const detailed = await drive(['d', 'q']);
  assert.match(detailed.writes, /c1/);
  assert.match(detailed.writes, /c1-e1/);
  assert.equal(detailed.result.decisions, 0);

  const ordinary = await drive(['q']);
  assert.match(ordinary.writes, /origem: sessão capturada/i);
  assert.match(ordinary.writes, /first safe preview/);
  assert.match(ordinary.writes, /second safe preview/);
  assert.match(ordinary.writes, /\[1\][\s\S]*2026-08-02T16:00:00\.000Z/);
  assert.match(ordinary.writes, /\[2\][\s\S]*2026-08-02T17:00:00\.000Z/);
  assert.doesNotMatch(ordinary.writes, /\[(?:x|\*)\]|pré-selecionad|selecionad[ao]/i);
  assert.doesNotMatch(ordinary.writes, /session-one|session-two|c1-e1|candidate: c1/);
});

test('[req:MEM-HANDOFF-3] historical batch requires confirmation and rejects only safe recommendations', async () => {
  const candidates = [
    historicalCandidate('history-a'),
    guidedCandidate('active-a'),
    historicalCandidate('history-b'),
    { ...historicalCandidate('history-unproven'), recommended_action: undefined },
  ];
  const declined = await drive(['h', '', 'q'], candidates);
  assert.equal(declined.result.decisions, 0);
  assert.deepEqual(declined.applied, []);

  const confirmed = await drive(['h', 's', 'q'], candidates);
  assert.deepEqual(confirmed.applied, [
    { action: 'reject', candidateId: 'history-a' },
    { action: 'reject', candidateId: 'history-b' },
  ]);
  assert.equal(confirmed.result.decisions, 2);
  assert.ok(confirmed.loads >= 4, 'reloads authority before every historical decision');
  assert.match(confirmed.writes, /2 handoff\(s\) histórico\(s\)/i);
  assert.match(confirmed.writes, /Conflito 3 de 4/);
});

test('[req:MEM-HANDOFF-3] historical rendering explains terminal context and safe recommendation', () => {
  const rendered = renderMemoryConflict(historicalCandidate('history-a'));
  assert.match(rendered, /sessão encerrada/i);
  assert.match(rendered, /recomendação segura/i);
  assert.match(rendered, /encerrar sem vencedor/i);
  assert.match(rendered, /\[H\].*históricos/i);
});

test('[req:MEM-CUR-5] progress advances across skipped conflicts without restarting', async () => {
  const guided = await drive(
    ['p', 'q'],
    [guidedCandidate('c1'), guidedCandidate('c2', 'quality.latest-verdict')],
  );
  assert.match(guided.writes, /Conflito 1 de 2[\s\S]*Conflito 2 de 2/);
  assert.equal(guided.result.skipped, 1);
});

test('[req:MEM-CUR-5] pending conflicts are grouped and counted by human purpose', async () => {
  const grouped = await drive(
    ['q'],
    [
      guidedCandidate('c1', 'handoff.latest'),
      guidedCandidate('c2', 'handoff.latest'),
      guidedCandidate('c3', 'quality.latest-sensors'),
    ],
  );
  assert.match(grouped.writes, /Categorias pendentes:[\s\S]*Próximo handoff: 2/);
  assert.match(grouped.writes, /Categorias pendentes:[\s\S]*Sensores de qualidade: 1/);
  assert.doesNotMatch(grouped.writes, /handoff\.latest|quality\.latest-sensors/);
});

test('[req:MEM-CUR-5] malformed conflicts fail closed without exposing technical IDs', async () => {
  const vault = fixture([{
    candidate_id: 'candidate-private-id', reason: 'conflict', status: 'active',
    memory_key: 'handoff.latest', event_ids: [], events: [],
  }]);
  try {
    assert.throws(
      () => listMemoryCandidatesForCuration(vault),
      (error) => {
        assert.doesNotMatch(error.message, /candidate-private-id/);
        return /sem eventos|inválid/i.test(error.message);
      },
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }

  const writes = [];
  const result = await runGuidedMemoryCuration('C:\\safe-vault', {
    locale: 'pt-BR',
    ask: async () => assert.fail('estado inválido não deve abrir prompt'),
    write: (text) => writes.push(String(text)),
    loadCandidates: () => { throw new Error('evento technical-secret-id ausente'); },
  });
  assert.equal(result.status, 'blocked');
  assert.doesNotMatch(writes.join(''), /technical-secret-id/);
});

test('[req:MEM-CUR-6] confirmed decisions are durable and a later run resumes remaining conflicts', async () => {
  const vault = durableFixture();
  try {
    const firstAnswers = ['1', 's', 'q'];
    const firstWrites = [];
    const first = await runGuidedMemoryCuration(vault, {
      locale: 'pt-BR',
      ask: async () => firstAnswers.shift() ?? 'q',
      write: (text) => firstWrites.push(String(text)),
    });
    assert.equal(first.decisions, 1);
    assert.equal(first.status, 'quit');
    assert.equal(listMemoryCandidatesForCuration(vault).length, 1);
    const decisions = readFileSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse).filter((event) => event.candidate_decision);
    assert.equal(decisions.length, 1, 'one confirmation appends exactly one audited decision');
    assert.equal(decisions[0].candidate_decision.action, 'promote');
    assert.equal(decisions[0].candidate_decision.selected_event_id, 'mem-handoff-a');

    const secondWrites = [];
    const second = await runGuidedMemoryCuration(vault, {
      locale: 'pt-BR',
      ask: async () => 'q',
      write: (text) => secondWrites.push(String(text)),
    });
    assert.equal(second.status, 'quit');
    assert.match(secondWrites.join(''), /1 conflito\(s\)/);
    assert.doesNotMatch(secondWrites.join(''), /2 conflito\(s\)/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-CUR-6] skipping a real candidate preserves the complete bundle byte for byte', async () => {
  const vault = durableFixture();
  try {
    const brain = join(vault, '.brain');
    const snapshot = () => readdirSync(brain).sort().map((name) => [
      name, readFileSync(join(brain, name)),
    ]);
    const before = snapshot();
    const answers = ['p', 'q'];
    const result = await runGuidedMemoryCuration(vault, {
      locale: 'pt-BR',
      ask: async () => answers.shift() ?? 'q',
      write: () => {},
    });
    assert.equal(result.status, 'quit');
    assert.equal(result.skipped, 1);
    assert.equal(result.decisions, 0);
    assert.equal(listMemoryCandidatesForCuration(vault).length, 2);
    assert.deepEqual(snapshot(), before);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-CUR-6] stale, incompatible and concurrent outcomes stop before another candidate', async () => {
  for (const message of ['candidate stale', 'decisão incompatível']) {
    const blocked = await drive(
      ['1', 's'],
      [guidedCandidate('c1'), guidedCandidate('c2', 'quality.latest-verdict')],
      { decisionError: new Error(message) },
    );
    assert.equal(blocked.result.status, 'blocked');
    assert.equal(blocked.applied.length, 1);
    assert.doesNotMatch(blocked.writes, new RegExp(message, 'i'));
    assert.match(blocked.writes, /execute memory curate novamente/i);
  }

  const changed = await drive(
    ['1', 's'],
    [guidedCandidate('c1'), guidedCandidate('c2', 'quality.latest-verdict')],
    { decisionResult: { status: 'promoted' } },
  );
  assert.equal(changed.result.status, 'blocked');
  assert.equal(changed.applied.length, 1);
  assert.equal(changed.applied[0].candidateId, 'c1');
  assert.match(changed.writes, /execute memory curate novamente/i);
});

test('[req:MEM-CUR-6] interactive prompts never hold MEMORY.lock while awaiting input', async () => {
  const vault = durableFixture();
  try {
    const answers = ['1', 'n', 'q'];
    let prompts = 0;
    const result = await runGuidedMemoryCuration(vault, {
      locale: 'pt-BR',
      ask: async () => {
        prompts += 1;
        assert.equal(existsSync(join(vault, '.brain', 'MEMORY.lock')), false);
        return answers.shift() ?? 'q';
      },
      write: () => {},
    });
    assert.equal(result.status, 'quit');
    assert.equal(result.decisions, 0);
    assert.equal(prompts, 3);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-CUR-6] busy decision stops before applying a choice to the next candidate', async () => {
  const blocked = await drive(
    ['1', 's'],
    [guidedCandidate('c1'), guidedCandidate('c2', 'quality.latest-verdict')],
    { decisionResult: { status: 'busy' } },
  );
  assert.equal(blocked.result.status, 'blocked');
  assert.equal(blocked.applied.length, 1);
  assert.equal(blocked.applied[0].candidateId, 'c1');
  assert.match(blocked.writes, /execute memory curate novamente/i);
  assert.doesNotMatch(blocked.writes, /second safe preview[\s\S]*second safe preview/);
});

test('[req:MEM-CUR-5] English vault gets English guidance without changing the choices', async () => {
  const writes = [];
  const result = await runGuidedMemoryCuration('C:\\safe-vault', {
    locale: 'en',
    ask: async () => 'q',
    write: (text) => writes.push(String(text)),
    loadCandidates: () => [guidedCandidate()],
    decide: () => assert.fail('quit must not decide'),
  });
  const output = writes.join('');
  assert.equal(result.status, 'quit');
  assert.match(output, /Guided memory curation/);
  assert.match(output, /Next handoff/);
  assert.match(output, /first safe preview/);
  assert.match(output, /second safe preview/);
  assert.doesNotMatch(output, /Curadoria guiada|Próximo handoff/);
});

test('[req:MEM-CUR-6] parser has no batch or implicit-confirmation escape hatch', () => {
  assert.deepEqual(parseMemoryCurateArgs(['--vault', 'C:\\vault']), { vault: 'C:\\vault' });
  assert.deepEqual(parseMemoryCurateArgs(['--vault=C:\\vault']), { vault: 'C:\\vault' });
  assert.deepEqual(
    parseMemoryCurateArgs(['--all', '--vault', 'C:\\vault']),
    { vault: 'C:\\vault', includeHistorical: true },
  );
  for (const args of [['--yes'], ['--apply'], ['candidate-id'], ['--all', '--all'], ['--vault', 'C:\\one', '--vault', 'C:\\two']]) {
    assert.throws(() => parseMemoryCurateArgs(args), /desconhecida|inesperado|duplicado/i);
  }
});

test('[req:MEM-CUR-5] [req:MEM-CUR-6] CLI refuses non-TTY without touching or transiently locking the bundle', async () => {
  const vault = fixture([{
    candidate_id: 'memcand-cli', reason: 'conflict', status: 'active',
    memory_key: 'git.local-head', event_ids: ['e1', 'e2'],
    events: [
      { event_id: 'e1', value: 'one' },
      { event_id: 'e2', value: 'two' },
    ],
  }]);
  try {
    const brain = join(vault, '.brain');
    const before = readdirSync(brain).sort().map((name) => [name, readFileSync(join(brain, name))]);
    const lockEvents = [];
    const watcher = watch(brain, (_eventType, filename) => {
      if (/MEMORY\.lock/i.test(String(filename || ''))) lockEvents.push(String(filename));
    });
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [BIN, 'memory', 'curate', '--vault', vault], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    } finally {
      watcher.close();
    }
    assert.equal(result.status, 2);
    assert.match(result.stderr, /TTY|terminal interativo/i);
    assert.match(result.stderr, /memory candidates --active/i);
    assert.deepEqual(
      readdirSync(brain).sort().map((name) => [name, readFileSync(join(brain, name))]),
      before,
    );
    assert.deepEqual(lockEvents, [], 'non-TTY path never creates even a transient MEMORY.lock');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-CUR-5] either missing TTY side triggers the same read-only fallback', async () => {
  const vault = fixture([]);
  try {
    for (const [inputTTY, outputTTY] of [[true, false], [false, true]]) {
      const stderr = [];
      const status = await runMemoryCurateCli(['--vault', vault], {
        input: { isTTY: inputTTY },
        output: { isTTY: outputTTY, write: () => {} },
        error: { write: (text) => stderr.push(String(text)) },
        env: {},
      });
      assert.equal(status, 2);
      assert.match(stderr.join(''), /memory candidates --active/i);
    }
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-CUR-5] top-level help advertises the guided command', () => {
  const result = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /memory curate/i);
});
