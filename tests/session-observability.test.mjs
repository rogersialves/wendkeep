import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateSessionObservability } from '../hooks/session-observability.mjs';
import { refreshSubagents } from '../hooks/subagent-stop.mjs';
import { upsertSessionRegistry, writeControl } from '../hooks/obsidian-common.mjs';

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
    assert.match(content, /observability_schema: 1/);
    assert.match(content, /"reasoning":20/);
    assert.match(content, /"effort":"low"/);

    updateSessionObservability({ sessionPath: note, transcriptPath: transcript });
    assert.equal(readFileSync(note, 'utf8'), content, 'same sources produce byte-identical markdown');
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

test('SubagentStop hook recomposes main usage instead of updating a competing section', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-observe-hook-'));
  try {
    const rel = '02-Sessões/session.md';
    const note = join(vault, rel);
    mkdirSync(join(vault, '02-Sessões'), { recursive: true });
    writeFileSync(note, '---\ntype: session\n---\n\n# Sessão\n\n## Pendências\n\nNenhuma.\n');
    const transcript = join(vault, 'main.jsonl');
    writeFileSync(transcript, codexTranscript({ id: 'main', model: 'gpt-5.6-sol', effort: 'high', input: 10, cached: 0, output: 5, reasoning: 2 }));
    writeControl(vault, { status: 'active', session_file: rel, session_id: 'main' });
    upsertSessionRegistry(vault, 'main', { status: 'active', provider: 'codex', session_file: rel, transcript_path: transcript });
    assert.equal(refreshSubagents(vault, { transcript_path: transcript, provider: 'codex' }), true);
    const content = readFileSync(note, 'utf8');
    assert.match(content, /## Agentes, tokens e custos/);
    assert.match(content, /\| Reasoning tokens \| 2 \| 0 \| 2 \|/);
    assert.doesNotMatch(content, /## Uso de tokens e custos|## Subagents & Workflows/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
