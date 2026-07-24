import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSessionUsage } from '../hooks/token-usage.mjs';
import { updateSessionObservability } from '../hooks/session-observability.mjs';
import { upsertSubagentUsage } from '../hooks/subagent-usage.mjs';

// Nota lida no meio de um writeFileSync de outro hook: o topo veio truncado. Antes, quem
// lesse isso prependava um frontmatter novo e empilhava blocos na nota.
const TRUNCADO = 'ility_caller: "subagent-stop"\nprompts: 3\n---\n\n# Sessão\n\n## Pendências\n\nNenhuma.\n';
const INTEGRO = '---\ntype: session\nprovider: codex\n---\n\n# Sessão\n\n## Pendências\n\nNenhuma.\n';

function codexTranscript({ id, model, effort, input, cached, output, reasoning }) {
  return [
    { type: 'session_meta', payload: { id, model, model_provider: 'openai' } },
    { type: 'turn_context', payload: { model, model_provider: 'openai', effort } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'implementar' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { model, model_provider: 'openai', last_token_usage: {
      input_tokens: input + cached, cached_input_tokens: cached, output_tokens: output,
      reasoning_output_tokens: reasoning, total_tokens: input + cached + output,
    } } } },
  ].map(JSON.stringify).join('\n');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wk-failclosed-'));
  const transcript = join(root, 'main.jsonl');
  writeFileSync(transcript, codexTranscript({ id: 'main', model: 'gpt-5.6-sol', effort: 'high', input: 100, cached: 50, output: 40, reasoning: 20 }));
  const subDir = join(root, 'main', 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-child.jsonl'), codexTranscript({ id: 'child', model: 'gpt-5.6-luna', effort: 'low', input: 30, cached: 10, output: 8, reasoning: 4 }));
  return { root, transcript };
}

// Conta blocos de frontmatter empilhados no topo — a assinatura exata do bug.
function leadingFrontmatterBlocks(content) {
  let rest = content;
  let blocks = 0;
  while (/^---\n/.test(rest)) {
    const close = rest.indexOf('\n---', 4);
    if (close < 0) break;
    blocks += 1;
    rest = rest.slice(close + 4).trimStart();
  }
  return blocks;
}

test('collectSessionUsage devolve null quando o conteúdo lido não tem frontmatter íntegro', () => {
  const { root, transcript } = fixture();
  try {
    assert.equal(collectSessionUsage({ sessionContent: TRUNCADO, transcriptPath: transcript }), null,
      'sem frontmatter é corrupção, não bootstrap — nunca prependar');
    assert.notEqual(collectSessionUsage({ sessionContent: INTEGRO, transcriptPath: transcript }), null,
      'nota íntegra segue sendo processada');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('updateSessionObservability não grava numa nota sem frontmatter íntegro', () => {
  const { root, transcript } = fixture();
  try {
    const note = join(root, 'session.md');
    writeFileSync(note, TRUNCADO);

    assert.equal(updateSessionObservability({ sessionPath: note, transcriptPath: transcript }), null);
    assert.equal(readFileSync(note, 'utf8'), TRUNCADO, 'arquivo byte-idêntico');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upsertSubagentUsage não grava numa nota sem frontmatter íntegro', () => {
  const { root, transcript } = fixture();
  try {
    const note = join(root, 'session.md');
    writeFileSync(note, TRUNCADO);

    assert.equal(upsertSubagentUsage(note, transcript), false);
    assert.equal(readFileSync(note, 'utf8'), TRUNCADO, 'arquivo byte-idêntico');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('os escritores da nota passam pelo lock: lock fresco faz ambos desistirem', () => {
  const { root, transcript } = fixture();
  try {
    const note = join(root, 'session.md');
    writeFileSync(note, INTEGRO);
    mkdirSync(`${note}.lock`);

    assert.equal(updateSessionObservability({ sessionPath: note, transcriptPath: transcript, lockTimeoutMs: 40 }), null);
    assert.equal(upsertSubagentUsage(note, transcript, { lockTimeoutMs: 40 }), false);
    assert.equal(readFileSync(note, 'utf8'), INTEGRO, 'nenhum escritor grava sem o lock');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('os escritores da nota gravam atomicamente: sem .tmp e sem lock residual', () => {
  const { root, transcript } = fixture();
  try {
    const note = join(root, 'session.md');
    writeFileSync(note, INTEGRO);

    updateSessionObservability({ sessionPath: note, transcriptPath: transcript });
    upsertSubagentUsage(note, transcript);

    assert.equal(existsSync(`${note}.lock`), false, 'lock liberado');
    assert.deepEqual(readdirSync(root).filter((f) => f.endsWith('.tmp')), [], 'nenhum temporário sobra');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nota íntegra termina com exatamente um bloco de frontmatter após os dois escritores', () => {
  const { root, transcript } = fixture();
  try {
    const note = join(root, 'session.md');
    writeFileSync(note, INTEGRO);

    assert.notEqual(updateSessionObservability({ sessionPath: note, transcriptPath: transcript }), null);
    assert.equal(upsertSubagentUsage(note, transcript), true);

    const content = readFileSync(note, 'utf8');
    assert.equal(leadingFrontmatterBlocks(content), 1, 'um único frontmatter no topo');
    assert.match(content, /^---\ntype: session\n/, 'as chaves-base da nota sobrevivem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
