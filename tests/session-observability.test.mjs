import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composeRegisteredSessionObservability,
  composeSessionObservability,
  updateSessionObservability,
} from '../hooks/session-observability.mjs';
import { sameUsageData } from '../hooks/token-usage.mjs';

// Preservação de `atualizado_em`: o dado é "o mesmo" independente da ORDEM das chaves.
// A entrada vinda do parse do note (transcript_id, modelos, tools, provider, …) tem ordem
// diferente da recém-computada (transcript_id, provider, modelos, …). O compare antigo
// (JSON.stringify) dava false p/ dado idêntico → atualizado_em re-stampado → teste flaky.
test('sameUsageData: identical usage with different key order compares equal', () => {
  const built = { transcript_id: 'main', provider: 'openai', modelos: ['x'], pensamento: 'high', input: 100, cache_write: 0, cache_read: 50, output: 40, reasoning: 20, total: 190, custo_usd: 0.0017, prompts: 1, tool_calls: 0, chamadas_llm: 1, tools: [], atualizado_em: '2026-07-18T00:19:39' };
  const parsed = { transcript_id: 'main', modelos: ['x'], tools: [], provider: 'openai', pensamento: 'high', input: 100, cache_write: 0, cache_read: 50, output: 40, reasoning: 20, total: 190, custo_usd: 0.0017, prompts: 1, tool_calls: 0, chamadas_llm: 1, atualizado_em: '2026-07-18T00:19:41' };
  assert.equal(sameUsageData(built, parsed), true, 'ordem de chaves e atualizado_em não contam');
});

test('sameUsageData: any changed usage number compares unequal', () => {
  const a = { provider: 'openai', modelos: ['x'], input: 100, output: 40, total: 190, custo_usd: 0.0017, tools: [] };
  assert.equal(sameUsageData(a, { ...a, output: 41 }), false, 'output mudou → re-stampa');
  assert.equal(sameUsageData(a, { ...a, modelos: ['x', 'y'] }), false, 'modelos mudou → re-stampa');
  assert.equal(sameUsageData(a, { ...a, tools: ['Read'] }), false, 'tools mudou → re-stampa');
});

test('sameUsageData: null/undefined side is never equal', () => {
  assert.equal(sameUsageData(null, {}), false);
  assert.equal(sameUsageData({}, undefined), false);
});

function codexTranscript({ id, model, effort, input, cached, output, reasoning }) {
  return [
    { type: 'session_meta', payload: { id, model, model_provider: 'openai' } },
    { type: 'turn_context', payload: { model, model_provider: 'openai', effort } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'implementar observabilidade' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { model, model_provider: 'openai', last_token_usage: {
      input_tokens: input + cached, cached_input_tokens: cached, output_tokens: output,
      reasoning_output_tokens: reasoning, total_tokens: input + cached + output,
    } } } },
  ].map(JSON.stringify).join('\n');
}

test('single writer merges main + subagent reasoning/effort and migrates legacy headings', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-observe-'));
  try {
    const transcript = join(root, 'main.jsonl');
    writeFileSync(transcript, codexTranscript({ id: 'main', model: 'gpt-5.6-sol', effort: 'high', input: 100, cached: 50, output: 40, reasoning: 20 }));
    const subDir = join(root, 'main', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-child.jsonl'), codexTranscript({ id: 'child', model: 'gpt-5.6-luna', effort: 'low', input: 30, cached: 10, output: 8, reasoning: 4 }));
    const note = join(root, 'session.md');
    writeFileSync(note, '---\ntype: session\n---\n\n# Sessão\n\n## Iterações\n\ntexto\n\n## Subagents & Workflows\n\nvelho sub\n\n## Uso de tokens e custos\n\nvelho main\n\n## Pendências\n\nNenhuma.\n');

    const snapshot = updateSessionObservability({ sessionPath: note, transcriptPath: transcript });
    assert.equal(snapshot.ledger.length, 2);
    const content = readFileSync(note, 'utf8');
    assert.equal((content.match(/## Agentes, tokens e custos/g) || []).length, 1);
    assert.doesNotMatch(content, /## Uso de tokens e custos|## Subagents & Workflows/);
    assert.match(content, /gpt-5\.6-sol \| openai \| main \| high/);
    assert.match(content, /gpt-5\.6-luna \| openai \| subagent \| low/);
    assert.match(content, /\| Reasoning tokens \| 20 \| 4 \| 24 \|/);
    assert.match(content, /observability_schema: 2/);
    assert.match(content, /subagents_observability_state: 'complete'/);
    assert.match(content, /"reasoning":20/);
    assert.match(content, /"effort":"low"/);

    updateSessionObservability({ sessionPath: note, transcriptPath: transcript });
    assert.equal(readFileSync(note, 'utf8'), content, 'same sources produce byte-identical markdown');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('[req:OBS-11] changing only the caller preserves note bytes and mtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-observe-caller-'));
  try {
    const transcript = join(root, 'main.jsonl');
    writeFileSync(transcript, codexTranscript({ id: 'main', model: 'gpt-5.6-sol', effort: 'high', input: 10, cached: 0, output: 5, reasoning: 2 }));
    const note = join(root, 'session.md');
    writeFileSync(note, '---\ntype: session\n---\n\n# Sessão\n');

    updateSessionObservability({ sessionPath: note, transcriptPath: transcript, caller: 'stop' });
    const before = readFileSync(note, 'utf8');
    const stableTime = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(note, stableTime, stableTime);
    const beforeMtime = statSync(note).mtimeMs;

    updateSessionObservability({ sessionPath: note, transcriptPath: transcript, caller: 'cost-rebuild' });

    assert.equal(readFileSync(note, 'utf8'), before);
    assert.equal(statSync(note).mtimeMs, beforeMtime);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('session without subagents still receives unified observability', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-observe-main-'));
  try {
    const transcript = join(root, 'main.jsonl');
    writeFileSync(transcript, codexTranscript({ id: 'main', model: 'gpt-5.6-terra', effort: 'medium', input: 10, cached: 0, output: 5, reasoning: 2 }));
    const note = join(root, 'session.md');
    writeFileSync(note, '---\ntype: session\n---\n\n# Sessão\n\n## Pendências\n\nNenhuma.\n');
    updateSessionObservability({ sessionPath: note, transcriptPath: transcript });
    const content = readFileSync(note, 'utf8');
    assert.match(content, /## Agentes, tokens e custos/);
    assert.match(content, /Nenhum subagent registrado/);
    assert.match(content, /subagents_count: 0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration preserves a legacy orphan iteration nested under the old usage section', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-observe-orphan-'));
  try {
    const transcript = join(root, 'main.jsonl');
    writeFileSync(transcript, codexTranscript({ id: 'main', model: 'gpt-5.6-sol', effort: 'xhigh', input: 10, cached: 0, output: 5, reasoning: 2 }));
    const note = join(root, 'session.md');
    writeFileSync(note, '---\ntype: session\n---\n\n# Sessão\n\n## Uso de tokens e custos\n\nvelho\n\n### 19:22 - turno preservado\n\nconteúdo importante\n\n## Pendências\n\nNenhuma.\n');
    updateSessionObservability({ sessionPath: note, transcriptPath: transcript });
    const content = readFileSync(note, 'utf8');
    assert.match(content, /### 19:22 - turno preservado[\s\S]*conteúdo importante/);
    assert.equal((content.match(/turno preservado/g) || []).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Claude thinking is attributed to the correct model as observational reasoning', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-observe-thinking-'));
  try {
    const transcript = join(root, 'main.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', requestId: 'r1', message: {
      id: 'r1', model: 'claude-fable-5', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'thinking', thinking: 'x'.repeat(350), signature: 'sig' }],
    } }));
    const note = join(root, 'session.md');
    writeFileSync(note, '---\ntype: session\n---\n\n# Sessão\n\n## Pendências\n\nNenhuma.\n');
    const snapshot = updateSessionObservability({ sessionPath: note, transcriptPath: transcript });
    assert.equal(snapshot.ledger[0].reasoning, 100, 'reasoning is a floor estimate from surviving thinking text');
    assert.equal(snapshot.ledger[0].effort, 'thinking', 'effort is a binary presence label, not a token count');
    assert.equal(snapshot.ledger[0].total, 30, 'reasoning remains included in output, never double-counted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Claude effort comes from thinking presence even when the thinking text is redacted', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-observe-redacted-'));
  try {
    // Real Claude Code main transcripts redact the thinking text (thinking: '') but keep the
    // signature — extended thinking WAS active. Effort must still read 'thinking'; the char/3.5
    // estimate is 0 because there is no text to measure.
    const transcript = join(root, 'main.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', requestId: 'r1', message: {
      id: 'r1', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'thinking', thinking: '', signature: 's'.repeat(2000) }, { type: 'text', text: 'ok' }],
    } }));
    const note = join(root, 'session.md');
    writeFileSync(note, '---\ntype: session\n---\n\n# Sessão\n\n## Pendências\n\nNenhuma.\n');
    const snapshot = updateSessionObservability({ sessionPath: note, transcriptPath: transcript });
    assert.equal(snapshot.ledger[0].effort, 'thinking', 'redacted thinking still counts as thinking active');
    assert.equal(snapshot.ledger[0].reasoning, 0, 'no surviving text -> reasoning floor is 0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Claude with no thinking blocks reports effort none, not unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-observe-nothink-'));
  try {
    const transcript = join(root, 'main.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', requestId: 'r1', message: {
      id: 'r1', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: 'resposta direta sem pensamento' }],
    } }));
    const note = join(root, 'session.md');
    writeFileSync(note, '---\ntype: session\n---\n\n# Sessão\n\n## Pendências\n\nNenhuma.\n');
    const snapshot = updateSessionObservability({ sessionPath: note, transcriptPath: transcript });
    assert.equal(snapshot.ledger[0].effort, 'none', 'Claude thinking off is deterministic -> none, never unknown');
    assert.equal(snapshot.ledger[0].reasoning, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function composeClaudeFilesystemState(root) {
  const transcript = join(root, 'main.jsonl');
  writeFileSync(transcript, JSON.stringify({
    type: 'assistant', uuid: 'answer-synthetic', sessionId: 'session-synthetic', requestId: 'request-synthetic',
    message: {
      id: 'message-synthetic', role: 'assistant', model: 'claude-opus-4-8',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: 'synthetic response' }],
    },
  }));
  return composeRegisteredSessionObservability({
    sessionContent: '---\ntype: session\nprovider: claude\n---\n\n# Synthetic\n',
    sessionEntry: {
      provider: 'claude', transcript_path: transcript,
      active_activation_id: 'activation-synthetic', activation_epoch: 1, last_turn_sequence: 1,
    },
    canonicalConversationId: 'session-synthetic',
    mode: 'offline',
  });
}

test('[req:OBS-12] Claude absent or confirmed-empty subagent directory materializes none', () => {
  for (const layout of ['absent', 'empty']) {
    const root = mkdtempSync(join(tmpdir(), `wk-observe-claude-${layout}-`));
    try {
      if (layout === 'empty') mkdirSync(join(root, 'main', 'subagents'), { recursive: true });
      const result = composeClaudeFilesystemState(root);
      assert.equal(result.state, 'none', layout);
      assert.deepEqual(result.diagnostics, [], layout);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('[req:OBS-12] Claude filesystem errors or malformed agent transcripts degrade safely', () => {
  for (const layout of ['error', 'malformed']) {
    const root = mkdtempSync(join(tmpdir(), `wk-observe-claude-${layout}-`));
    try {
      const sessionDir = join(root, 'main');
      mkdirSync(sessionDir, { recursive: true });
      const subagents = join(sessionDir, 'subagents');
      if (layout === 'error') {
        writeFileSync(subagents, 'not a directory');
      } else {
        mkdirSync(subagents);
        writeFileSync(join(subagents, 'agent-malformed.jsonl'), '{not-json}\n');
      }
      const result = composeClaudeFilesystemState(root);
      assert.equal(result.state, 'degraded', layout);
      assert.deepEqual(result.diagnostics, [{ code: 'CHILD_META_INVALID', count: 1 }], layout);
      assert.doesNotMatch(JSON.stringify(result.diagnostics), /not a directory|not-json|wk-observe/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

function frontier(overrides = {}) {
  return {
    canonical_session_id: 'session-synthetic',
    activation_id: 'activation-synthetic',
    activation_epoch: 3,
    turn_sequence: 7,
    signal_sequence: 11,
    roots_stat_hash: 'roots-synthetic',
    graph_cursor: 'graph-synthetic',
    source_manifest_hash: 'manifest-synthetic',
    ...overrides,
  };
}

function syntheticMain(content) {
  return {
    state: 'complete',
    diagnostics: [],
    summary: {
      pensamento: 'high',
      modelRows: [{
        provider: 'openai', model: 'model-main', calls: 1,
        usage: { input: 100, cached: 0, cacheWrite: 0, output: 20, reasoning: 5, total: 120 },
        costs: { model: 0.01 },
      }],
    },
    aggregate: { calls: 1, input: 100, cached: 0, cacheWrite: 0, output: 20, reasoning: 5, total: 120, custo: 0.01 },
    entries: [{ transcript_id: 'root-a', modelos: ['model-main'], pensamento: 'high', input: 100, cache_write: 0, cache_read: 0, output: 20, reasoning: 5, total: 120, custo_usd: 0.01 }],
    content,
  };
}

function syntheticSubagents() {
  return {
    state: 'complete',
    diagnostics: [],
    aggregate: {
      count: 1, calls: 1, tokens: 50, cost: 0.005, wasted: 0, tools: ['Read'],
      usage: { input: 40, cached: 0, cacheWrite: 0, output: 10, reasoning: 2 },
      modelRows: [{ provider: 'openai', model: 'model-child', effort: 'low', calls: 1, usage: { input: 40, cached: 0, cacheWrite: 0, output: 10, reasoning: 2, total: 50 }, cost: 0.005 }],
    },
    subagents: [{ id: 'child-a', agentType: 'worker', workflow: '', model: 'model-child', effort: 'low', tools: 1, tokens: 50, cost: 0.005 }],
    workflows: [],
  };
}

test('[req:OBS-11] [req:OBS-12] compose materializes schema 2 with exclusive main and subagent buckets', () => {
  const sessionContent = '---\ntype: session\nprovider: codex\n---\n\n# Synthetic\n\n## Pendências\n\nNenhuma.\n';
  const seen = {};
  const result = composeSessionObservability({
    sessionContent,
    frontier: frontier(),
    roots: { rootPaths: ['root-a.jsonl'], descendantIds: ['child-a'] },
    allowNone: true,
  }, {
    collectMain(input) {
      seen.main = input;
      return syntheticMain(input.sessionContent);
    },
    collectSubagents(input) {
      seen.subagents = input;
      return syntheticSubagents();
    },
  });

  assert.equal(result.state, 'complete');
  assert.equal(result.snapshot.version, 2);
  assert.deepEqual(result.snapshot.main.entries.map((entry) => entry.transcript_id), ['root-a']);
  assert.deepEqual(result.snapshot.subagents.subagents.map((entry) => entry.id), ['child-a']);
  assert.deepEqual(seen.main.rootPaths, ['root-a.jsonl']);
  assert.deepEqual(seen.subagents.descendantIds, ['child-a']);
  assert.match(result.content, /^observability_schema: 2$/m);
  assert.match(result.content, /^subagents_observability_state: 'complete'$/m);
  assert.match(result.content, /^observability_signal_sequence: 11$/m);
  assert.match(result.content, /^subagents_diagnostics_json: '\[\]'$/m);
  assert.match(result.content, /\| Total tokens \| 120 \| 50 \| 170 \|/);
});

test('[req:OBS-12] stable zero-agent scan materializes none while an isolated signal degrades', () => {
  const sessionContent = '---\ntype: session\nprovider: codex\nsubagents_count: 9\n---\n\n# Synthetic\n\n## Pendências\n\nNenhuma.\n';
  const deps = {
    collectMain: ({ sessionContent: content }) => syntheticMain(content),
    collectSubagents: () => ({ state: 'none', diagnostics: [], aggregate: { count: 0, calls: 0, tokens: 0, cost: 0, wasted: 0, tools: [], usage: {}, modelRows: [] }, subagents: [], workflows: [], sourceManifest: [{ path: 'synthetic', rolloutId: 'root', size: 1, mtimeMs: 1 }], cache: { version: 1, entries: {} } }),
  };

  const stable = composeSessionObservability({ sessionContent, frontier: frontier(), roots: {}, allowNone: true }, deps);
  assert.equal(stable.state, 'none');
  assert.equal(stable.snapshot.subagents.sourceManifest.length, 1, 'none still carries freshness proof to the runtime store');
  assert.match(stable.content, /^subagents_count: 0$/m);
  assert.match(stable.content, /Nenhum subagent registrado/);

  const isolated = composeSessionObservability({ sessionContent, frontier: frontier(), roots: {}, allowNone: false }, deps);
  assert.equal(isolated.state, 'degraded');
  assert.equal(isolated.content, sessionContent, 'an isolated SubagentStop cannot erase the previous snapshot');
});

test('[req:OBS-12] degraded composition sanitizes diagnostics and preserves the prior note byte-for-byte', () => {
  const previous = '---\ntype: session\nprovider: codex\nobservability_schema: 2\nsubagents_observability_state: \'complete\'\nsubagents_count: 4\n---\n\n# Synthetic\n\n## Agentes, tokens e custos\n\nprevious snapshot\n';
  const result = composeSessionObservability({
    sessionContent: previous,
    frontier: frontier({ signal_sequence: 12 }),
    roots: {},
    previousSnapshot: { version: 2, marker: 'previous' },
  }, {
    collectMain: ({ sessionContent }) => syntheticMain(sessionContent),
    collectSubagents: () => ({ state: 'degraded', diagnostics: [{ code: 'CHILD_MISSING', count: 1 }] }),
  });

  assert.equal(result.state, 'degraded');
  assert.deepEqual(result.diagnostics, [{ code: 'CHILD_MISSING', count: 1 }]);
  assert.deepEqual(result.snapshot, { version: 2, marker: 'previous' });
  assert.equal(result.content, previous);
});

test('[req:OBS-12] degraded without a prior snapshot preserves numeric fields and never invents none', () => {
  const original = [
    '---',
    'type: session',
    'provider: codex',
    'observability_schema: 2',
    "subagents_observability_state: 'complete'",
    'subagents_count: 7',
    'subagents_tokens_total: 321',
    'subagents_custo_usd: 4.5',
    'tokens_total_incl_subagents: 654',
    'custo_total_incl_subagents_usd: 7.25',
    '---',
    '',
    '# Synthetic',
    '',
    '## Agentes, tokens e custos',
    '',
    'last proven totals',
    '',
  ].join('\n');
  const result = composeSessionObservability({
    sessionContent: original,
    frontier: frontier({ signal_sequence: 13 }),
    roots: {},
  }, {
    collectMain: ({ sessionContent }) => syntheticMain(sessionContent),
    collectSubagents: () => ({
      state: 'degraded',
      diagnostics: [{ code: 'CHILD_MISSING', count: 1 }],
    }),
  });

  assert.equal(result.state, 'degraded');
  assert.equal(result.snapshot, null);
  assert.equal(result.content, original);
  assert.match(result.content, /^subagents_count: 7$/m);
  assert.match(result.content, /^subagents_tokens_total: 321$/m);
  assert.match(result.content, /^subagents_custo_usd: 4\.5$/m);
  assert.doesNotMatch(result.content, /Nenhum subagent registrado/);
});

test('[req:OBS-13] registered offline composition reads registry roots without any writer side effect', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-observe-offline-'));
  try {
    const transcript = join(root, 'root.jsonl');
    writeFileSync(transcript, codexTranscript({ id: 'root', model: 'model-main', effort: 'medium', input: 10, cached: 0, output: 5, reasoning: 1 }));
    const note = join(root, 'session.md');
    const original = '---\ntype: session\nprovider: codex\n---\n\n# Synthetic\n\n## Pendências\n\nNenhuma.\n';
    writeFileSync(note, original);

    const candidate = composeRegisteredSessionObservability({
      sessionContent: original,
      sessionEntry: {
        session_id: 'session-synthetic',
        provider: 'codex',
        transcript_path: transcript,
        active_activation_id: 'activation-synthetic',
        activation_epoch: 1,
        last_turn_sequence: 2,
      },
      canonicalConversationId: 'session-synthetic',
      runtimeState: { observability_signal_sequence: 0, signals: [], graph_cache: null },
      mode: 'offline',
    });

    assert.equal(candidate.state, 'none');
    assert.match(candidate.content, /^observability_schema: 2$/m);
    assert.equal(readFileSync(note, 'utf8'), original, 'pure preview must not write the session note');
    assert.equal(existsSync(join(root, '.brain')), false, 'pure preview must not create runtime state');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
