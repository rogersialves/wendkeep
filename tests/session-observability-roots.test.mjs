import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  collectSessionUsage,
  collectSessionUsageForRoots,
} from '../hooks/token-usage.mjs';

const CONVERSATION = '11111111-1111-7111-8111-111111111111';

function rollout(id, tokens, extra = {}) {
  return [
    { type: 'session_meta', payload: { id, session_id: CONVERSATION, model: 'gpt-5.6-sol', model_provider: 'openai', ...extra } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-sol', model_provider: 'openai', effort: 'high' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'synthetic request' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { model: 'gpt-5.6-sol', last_token_usage: { input_tokens: tokens, output_tokens: 10 } } } },
  ].map(JSON.stringify).join('\n') + '\n';
}

function note() {
  return '---\ntype: session\nprovider: codex\n---\n\n# Synthetic session\n\n## Pendências\n\nNenhuma.\n';
}

function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'wk-observe-roots-'));
  const a = join(dir, 'root-a.jsonl');
  const b = join(dir, 'root-b.jsonl');
  const c = join(dir, 'child-c.jsonl');
  writeFileSync(a, rollout('root-a', 100));
  writeFileSync(b, rollout('root-b', 200));
  writeFileSync(c, rollout('child-c', 300, {
    parent_thread_id: 'root-a',
    source: { subagent: { thread_spawn: { parent_thread_id: 'root-a', depth: 1, agent_nickname: 'synthetic-child' } } },
  }));
  return { dir, a, b, c };
}

test('[req:OBS-11] roots A+B remain main while descendant C is removed from main history', () => {
  const fx = seed();
  try {
    let content = collectSessionUsage({ sessionContent: note(), transcriptPath: fx.a }).content;
    content = collectSessionUsage({ sessionContent: content, transcriptPath: fx.b }).content;
    content = collectSessionUsage({ sessionContent: content, transcriptPath: fx.c }).content;

    const result = collectSessionUsageForRoots({
      sessionContent: content,
      rootPaths: [fx.a, fx.b],
      descendantIds: [basename(fx.c, '.jsonl'), 'child-c'],
    });

    assert.equal(result.state, 'complete');
    assert.deepEqual(result.entries.map((entry) => entry.transcript_id).sort(), ['root-a', 'root-b']);
    assert.equal(result.aggregate.total, 320, 'main is exactly A+B, without child C');
    assert.doesNotMatch(result.content, /transcript_id: "child-c"/);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('[req:OBS-11] registry roots reject a source.subagent path instead of treating it as main', async () => {
  const fx = seed();
  try {
    const { resolveObservabilityRoots } = await import('../hooks/session-observability-lifecycle.mjs');
    const roots = resolveObservabilityRoots({
      provider: 'codex',
      transcript_path: fx.c,
      transcript_paths: [fx.a, fx.c, fx.b],
      activations: {
        older: { transcript_path: fx.a },
        current: { transcript_path: fx.b },
      },
    });

    assert.equal(roots.state, 'complete');
    assert.deepEqual(roots.rootPaths, [fx.a, fx.b].sort());
    assert.deepEqual(roots.descendantPaths, [fx.c]);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('[req:OBS-11] unresolved historical main entry degrades and preserves original content', () => {
  const fx = seed();
  try {
    const unknown = join(fx.dir, 'root-unknown.jsonl');
    writeFileSync(unknown, rollout('root-unknown', 400));
    let content = collectSessionUsage({ sessionContent: note(), transcriptPath: fx.a }).content;
    content = collectSessionUsage({ sessionContent: content, transcriptPath: unknown }).content;

    const result = collectSessionUsageForRoots({
      sessionContent: content,
      rootPaths: [fx.a],
      descendantIds: [],
    });

    assert.equal(result.state, 'degraded');
    assert.deepEqual(result.diagnostics, [{ code: 'MAIN_TRANSCRIPT_UNRESOLVED', count: 1 }]);
    assert.equal(result.content, content, 'fail closed: unknown main history is not deleted');
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
