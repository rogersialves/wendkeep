import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceForModel, costBreakdown } from '../hooks/token-usage.mjs';

test('GPT-5.6 aliases and standard API prices', () => {
  assert.equal(priceForModel('gpt-5.6').label, 'GPT-5.6 Sol API');
  assert.equal(priceForModel('openai/gpt-5.6-terra').input, 2.5);
  assert.equal(priceForModel('gpt-5-6-luna').output, 6);
  const c = costBreakdown({ input: 1_000_000, cached: 1_000_000, output: 1_000_000 }, priceForModel('gpt-5.6-luna'));
  assert.equal(c.total, 7.1);
});
