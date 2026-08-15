import test from 'node:test';
import assert from 'node:assert/strict';
import {
  abortedCodexTurnIdsContent,
  parseCodexTranscriptContent,
} from '../packages/integrations/src/transcripts.mjs';

const jsonl = (events) => events.map((event) => JSON.stringify(event)).join('\n');
const SUBAGENT_MESSAGE = '<subagent_notification>[wk-fixture] resultado interno do subagente</subagent_notification>';
const REAL_PROMPT = '[wk-fixture] pergunta real';
const FIXTURE_SOURCE_PATH = 'src/app.mjs';
const PRIVATE_TOOL_TOKEN = '[wk-fixture] não persistir';
const PRIVATE_TOOL_OUTPUT = '[wk-fixture] saída privada não deve virar mensagem';

test('[req:PARSER-1] subagent_notification não vira prompt humano', () => {
  const parsed = parseCodexTranscriptContent(jsonl([
    {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        turn_id: 'turn-synthetic',
        message: SUBAGENT_MESSAGE,
      },
    },
    {
      type: 'event_msg',
      payload: { type: 'user_message', turn_id: 'turn-synthetic', message: REAL_PROMPT },
    },
  ]));

  assert.deepEqual(parsed.userPrompts, [REAL_PROMPT]);
  assert.equal(parsed.latestUserPrompt, REAL_PROMPT);
  assert.doesNotMatch(parsed.rawTextForDetection, /resultado interno/);
});
test('[req:PARSER-2] marca turn_aborted e não duplica custom tool output', () => {
  const content = jsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-custom' } },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        turn_id: 'turn-custom',
        name: 'browser.inspect',
        arguments: JSON.stringify({ path: FIXTURE_SOURCE_PATH, token: PRIVATE_TOOL_TOKEN }),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        turn_id: 'turn-custom',
        name: 'browser.inspect',
        output: PRIVATE_TOOL_OUTPUT,
      },
    },
    {
      type: 'event_msg',
      payload: { type: 'turn_aborted', turn_id: 'turn-aborted' },
    },
  ]);

  const parsed = parseCodexTranscriptContent(content);
  const custom = parsed.turns.find((turn) => turn.turnId === 'turn-custom');
  const aborted = parsed.turns.find((turn) => turn.turnId === 'turn-aborted');

  assert.deepEqual(custom.tools, ['browser.inspect']);
  assert.deepEqual(custom.consultedFiles, [FIXTURE_SOURCE_PATH]);
  assert.equal(custom.assistantMessages.length, 0);
  assert.equal(aborted.status, 'aborted');
  assert.deepEqual([...abortedCodexTurnIdsContent(content)], ['turn-aborted']);
});
