import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTokenUsageFromContent,
  parseTokenUsageFromTranscript,
  summarizeTokenUsage,
} from '../hooks/token-usage.mjs';

const SUBAGENT_MESSAGE = '<subagent_notification>[wk-fixture] conteúdo interno</subagent_notification>';
const REAL_PROMPT = '[wk-fixture] prompt real';

test('[req:OBS-3] parsing an already-read rollout is identical to parsing the file wrapper', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-usage-content-'));
  try {
    const transcriptPath = join(root, 'synthetic.jsonl');
    const content = [
      { type: 'session_meta', payload: { id: 'synthetic', session_id: 'synthetic', model: 'gpt-5.6-sol', model_provider: 'openai' } },
      { type: 'turn_context', payload: { model: 'gpt-5.6-sol', model_provider: 'openai', effort: 'high' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'synthetic request' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { model: 'gpt-5.6-sol', last_token_usage: { input_tokens: 123, cached_input_tokens: 23, output_tokens: 7 } } } },
    ].map(JSON.stringify).join('\n') + '\n';
    writeFileSync(transcriptPath, content);

    const fromContent = summarizeTokenUsage(parseTokenUsageFromContent(content, { transcriptPath }));
    const fromFile = summarizeTokenUsage(parseTokenUsageFromTranscript(transcriptPath));
    assert.deepEqual(fromContent, fromFile);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:PARSER-1] [req:PARSER-2] token usage compartilha filtro sintético e não duplica custom tool output', () => {
  const content = [
    { type: 'session_meta', payload: { id: 'synthetic', model: 'gpt-5.6-sol', model_provider: 'openai' } },
    {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: SUBAGENT_MESSAGE,
      },
    },
    { type: 'event_msg', payload: { type: 'user_message', message: REAL_PROMPT } },
    {
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'browser.inspect', arguments: '{"path":"src/app.mjs"}' },
    },
    {
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', name: 'browser.inspect', output: 'saída interna' },
    },
    {
      type: 'event_msg',
      payload: { type: 'token_count', info: { model: 'gpt-5.6-sol', last_token_usage: { input_tokens: 1, output_tokens: 2 } } },
    },
  ].map(JSON.stringify).join('\n');

  const parsed = parseTokenUsageFromContent(content);
  assert.deepEqual(parsed.userPrompts, [REAL_PROMPT]);
  assert.deepEqual(parsed.tools, ['browser.inspect']);
  assert.equal(parsed.toolCalls, 1);
});
