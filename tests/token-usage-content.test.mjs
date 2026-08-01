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
