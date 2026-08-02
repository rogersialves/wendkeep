import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  advanceActivationTurn,
  applyStopActivation,
  openActivation,
  readSessionRegistry,
  resolveStopActivation,
} from '../hooks/obsidian-common.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function emptyRegistry() {
  return { version: 2, sessions: {} };
}

function session(sessionId, activationId, turnSequence = 0) {
  return {
    session_id: sessionId,
    activation_id: activationId,
    started_at: '2026-07-26T03:20:47Z',
    turn_sequence: turnSequence,
  };
}

function runHook(script, vault, input) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_THREAD_ID;
  return spawnSync(process.execPath, [script], {
    cwd: ROOT,
    env,
    input: JSON.stringify({ obsidian_vault_path: vault, cwd: vault, ...input }),
    encoding: 'utf8',
  });
}

test('[req:MEM-HYB-4] [req:MEM-STOP-4] late stop cannot close or promote over a newer activation', () => {
  const first = openActivation(emptyRegistry(), session('s1', 'act-1', 4));
  const second = openActivation(first, session('s1', 'act-2', 0));

  const result = applyStopActivation(second, {
    session_id: 's1',
    activation_id: 'act-1',
    turn_id: 'turn-4',
    turn_sequence: 4,
    ended_at: '2026-07-26T03:30:00Z',
  });

  assert.equal(result.sessions.s1.active_activation_id, 'act-2');
  assert.equal(result.sessions.s1.activations['act-1'].status, 'superseded');
  assert.equal(result.sessions.s1.activations['act-2'].status, 'active');
  assert.equal(result.sessions.s1.ended_at, undefined);
  assert.equal(result.stopDisposition, 'superseded');
  assert.equal(result.canPromoteMemory, false);
});

test('[req:MEM-HYB-4] [req:MEM-STOP-4] current activation rejects a stop older than its last observed turn', () => {
  const opened = openActivation(emptyRegistry(), session('s1', 'act-1', 3));
  const advanced = advanceActivationTurn(opened, {
    session_id: 's1', activation_id: 'act-1', turn_sequence: 7,
  });

  const result = applyStopActivation(advanced, {
    session_id: 's1', activation_id: 'act-1', turn_id: 'turn-6', turn_sequence: 6,
  });

  assert.equal(result.sessions.s1.active_activation_id, 'act-1');
  assert.equal(result.sessions.s1.last_turn_sequence, 7);
  assert.equal(result.stopDisposition, 'stale_turn');
  assert.equal(result.canPromoteMemory, false);
});

test('[req:MEM-STOP-2] non-consecutive native prompt replay is a causal no-op', () => {
  const opened = openActivation(emptyRegistry(), session('s1', 'act-1'));
  const first = advanceActivationTurn(opened, {
    session_id: 's1', turn_id: 'turn-a',
  });
  const second = advanceActivationTurn(first, {
    session_id: 's1', turn_id: 'turn-b',
  });
  const replay = advanceActivationTurn(second, {
    session_id: 's1', turn_id: 'turn-a',
  });

  assert.equal(replay.sessions.s1.last_turn_sequence, 2);
  assert.equal(replay.sessions.s1.last_prompt_turn_id, 'turn-b');
  assert.deepEqual(replay.sessions.s1.turn_sequences, { 'turn-a': 1, 'turn-b': 2 });
  assert.equal(replay.sessions.s1.activations['act-1'].last_turn_sequence, 2);
  assert.equal(replay.sessions.s1.activations['act-1'].last_prompt_turn_id, 'turn-b');

  const stop = applyStopActivation(replay, {
    session_id: 's1', activation_id: 'act-1', turn_id: 'turn-b', turn_sequence: 2,
  });
  assert.equal(stop.stopDisposition, 'applied');
  assert.equal(stop.canPromoteMemory, true);
});

test('[req:MEM-STOP-2] pre-patch registry deduplicates its last native turn before recovery', () => {
  const prePatch = openActivation(emptyRegistry(), {
    ...session('s1', 'legacy-act', 1), transcript_id: 'rollout-1', transcript_path: 'one.jsonl',
  });
  const legacyEntry = prePatch.sessions.s1;
  legacyEntry.last_turn_id = 'turn-a';
  legacyEntry.last_turn_sequence = 1;
  legacyEntry.active_activation_id = '';
  legacyEntry.activations['legacy-act'].status = 'done';
  delete legacyEntry.last_prompt_turn_id;
  delete legacyEntry.turn_sequences;

  const replay = advanceActivationTurn(prePatch, {
    session_id: 's1',
    turn_id: 'turn-a',
    recovery_activation_id: 'must-not-open',
    transcript_id: 'rollout-1',
    transcript_path: 'one.jsonl',
  });
  assert.equal(replay.sessions.s1.last_turn_sequence, 1);
  assert.equal(replay.sessions.s1.active_activation_id, '');
  assert.equal(replay.sessions.s1.activations['must-not-open'], undefined);

  const nextTurn = advanceActivationTurn(replay, {
    session_id: 's1',
    turn_id: 'turn-b',
    recovery_activation_id: 'recovery-act',
    transcript_id: 'rollout-1',
    transcript_path: 'one.jsonl',
  });
  assert.equal(nextTurn.sessions.s1.last_turn_sequence, 2);
  assert.equal(nextTurn.sessions.s1.active_activation_id, 'recovery-act');
  const stop = applyStopActivation(nextTurn, {
    session_id: 's1', activation_id: 'recovery-act', turn_id: 'turn-b', turn_sequence: 2,
  });
  assert.equal(stop.stopDisposition, 'applied');
});

test('[req:HOOK-MEM-1] [req:MEM-STOP-2] matching turn is acknowledged without closing its SessionStart epoch', () => {
  const opened = openActivation(emptyRegistry(), session('s1', 'act-1', 3));
  const result = applyStopActivation(opened, {
    session_id: 's1',
    activation_id: 'act-1',
    turn_id: 'turn-4',
    turn_sequence: 4,
    ended_at: '2026-07-26T03:30:00Z',
  });

  assert.equal(result.sessions.s1.active_activation_id, 'act-1');
  assert.equal(result.sessions.s1.activations['act-1'].status, 'active');
  assert.equal(result.sessions.s1.activations['act-1'].last_turn_sequence, 4);
  assert.equal(result.sessions.s1.activations['act-1'].last_stop_turn_id, 'turn-4');
  assert.equal(result.stopDisposition, 'applied');
  assert.equal(result.canPromoteMemory, true);
});

test('[req:HOOK-MEM-1] [req:MEM-STOP-4] implicit Stop resolves only the active transcript-compatible activation', () => {
  const first = openActivation(emptyRegistry(), {
    ...session('s1', 'act-1', 4), transcript_id: 'rollout-1', transcript_path: 'one.jsonl',
  });
  const second = openActivation(first, {
    ...session('s1', 'act-2', 0), transcript_id: 'rollout-2', transcript_path: 'two.jsonl',
  });

  assert.equal(resolveStopActivation(second, {
    session_id: 's1', transcript_id: 'rollout-1', transcript_path: 'one.jsonl',
  }), '');
  assert.equal(resolveStopActivation(second, {
    session_id: 's1', transcript_id: 'rollout-2', transcript_path: 'two.jsonl',
  }), 'act-2');
  assert.equal(resolveStopActivation(second, {
    session_id: 's1', transcript_id: 'unknown', transcript_path: 'unknown.jsonl',
  }), '');

  const ambiguous = openActivation(first, {
    ...session('s1', 'act-2', 0), transcript_id: 'rollout-1', transcript_path: 'one.jsonl',
  });
  assert.equal(resolveStopActivation(ambiguous, {
    session_id: 's1', transcript_id: 'rollout-1', transcript_path: 'one.jsonl',
  }), 'act-2');
});

test('[req:MEM-STOP-3] repeated Stop for the same native turn is an explicit duplicate', () => {
  const opened = openActivation(emptyRegistry(), {
    ...session('s1', 'act-1', 2), transcript_id: 'rollout-1', transcript_path: 'one.jsonl',
  });
  const first = applyStopActivation(opened, {
    session_id: 's1', activation_id: 'act-1', turn_id: 'turn-2', turn_sequence: 2,
  });
  const duplicate = applyStopActivation(first, {
    session_id: 's1', activation_id: 'act-1', turn_id: 'turn-2', turn_sequence: 2,
  });

  assert.equal(first.stopDisposition, 'applied');
  assert.equal(duplicate.stopDisposition, 'duplicate');
  assert.equal(duplicate.canPromoteMemory, false);
  assert.equal(duplicate.sessions.s1.active_activation_id, 'act-1');
});

test('[req:MEM-STOP-2] recovery activation opens exactly once when a prompt finds a closed legacy epoch', () => {
  const legacy = openActivation(emptyRegistry(), {
    ...session('s1', 'legacy-act', 1), transcript_id: 'rollout-1', transcript_path: 'one.jsonl',
  });
  legacy.sessions.s1.activations['legacy-act'].status = 'done';
  legacy.sessions.s1.active_activation_id = '';
  legacy.sessions.s1.last_turn_id = 'turn-1';

  const recovered = advanceActivationTurn(legacy, {
    session_id: 's1',
    turn_id: 'turn-2',
    turn_sequence: 2,
    recovery_activation_id: 'recovery-act-1',
    transcript_id: 'rollout-1',
    transcript_path: 'one.jsonl',
  });
  const duplicatePrompt = advanceActivationTurn(recovered, {
    session_id: 's1',
    turn_id: 'turn-2',
    turn_sequence: 2,
    recovery_activation_id: 'recovery-act-2',
    transcript_id: 'rollout-1',
    transcript_path: 'one.jsonl',
  });

  assert.equal(recovered.sessions.s1.active_activation_id, 'recovery-act-1');
  assert.equal(duplicatePrompt.sessions.s1.active_activation_id, 'recovery-act-1');
  assert.equal(duplicatePrompt.sessions.s1.activation_epoch, 2);
  assert.equal(duplicatePrompt.sessions.s1.activations['recovery-act-2'], undefined);
});

test('[req:MEM-STOP-4] Stop from before the active epoch floor is superseded without an external activation id', () => {
  const first = openActivation(emptyRegistry(), {
    ...session('s1', 'act-1', 4), transcript_id: 'rollout-1', transcript_path: 'one.jsonl',
  });
  first.sessions.s1.last_turn_id = 'turn-4';
  const second = openActivation(first, {
    ...session('s1', 'act-2', 5), transcript_id: 'rollout-1', transcript_path: 'one.jsonl',
  });
  const activeId = resolveStopActivation(second, {
    session_id: 's1', transcript_id: 'rollout-1', transcript_path: 'one.jsonl',
  });
  const late = applyStopActivation(second, {
    session_id: 's1', activation_id: activeId, turn_id: 'turn-4', turn_sequence: 4,
  });

  assert.equal(activeId, 'act-2');
  assert.equal(late.stopDisposition, 'superseded');
  assert.equal(late.sessions.s1.active_activation_id, 'act-2');
});

test('[req:MEM-HYB-4] registry v2 without activation fields remains readable', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-activation-v2-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    writeFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), `${JSON.stringify({
      version: 2,
      sessions: {
        legacy: {
          status: 'active',
          session_file: '02-Sessões/legacy.md',
          transcript_path: 'legacy.jsonl',
        },
      },
    })}\n`);

    const registry = readSessionRegistry(vault);
    assert.equal(registry.version, 2);
    assert.equal(registry.sessions.legacy.session_file, '02-Sessões/legacy.md');
    assert.equal(registry.sessions.legacy.active_activation_id, undefined);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:HOOK-MEM-1] SessionStart opens epochs and UserPromptSubmit only advances the active turn', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-activation-hooks-'));
  const sessionId = '019f56c7-d594-7460-be9b-d246606e3135';
  const transcript = join(vault, 'rollout.jsonl');
  try {
    writeFileSync(transcript, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: 'rollout-activation', session_id: sessionId, model_provider: 'openai' },
    })}\n`);

    const start1 = runHook('hooks/session-start.mjs', vault, {
      session_id: sessionId, transcript_path: transcript, activation_id: 'act-1',
    });
    assert.equal(start1.status, 0, start1.stderr);
    assert.doesNotThrow(() => JSON.parse(start1.stdout));

    const ensure3 = runHook('hooks/session-ensure.mjs', vault, {
      session_id: sessionId,
      transcript_path: transcript,
      activation_id: 'ignored-by-ensure',
      turn_sequence: 3,
      prompt: 'terceiro turno',
    });
    assert.equal(ensure3.status, 0, ensure3.stderr);

    const ensure2 = runHook('hooks/session-ensure.mjs', vault, {
      session_id: sessionId,
      transcript_path: transcript,
      activation_id: 'also-ignored',
      turn_sequence: 2,
      prompt: 'evento atrasado',
    });
    assert.equal(ensure2.status, 0, ensure2.stderr);

    const start2 = runHook('hooks/session-start.mjs', vault, {
      session_id: sessionId, transcript_path: transcript, activation_id: 'act-2',
    });
    assert.equal(start2.status, 0, start2.stderr);

    const registry = JSON.parse(readFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), 'utf8'));
    const entry = registry.sessions[sessionId];
    assert.equal(entry.activation_epoch, 2);
    assert.equal(entry.active_activation_id, 'act-2');
    assert.equal(entry.last_turn_sequence, 3);
    assert.equal(entry.activations['act-1'].last_turn_sequence, 3);
    assert.equal(entry.activations['act-1'].status, 'superseded');
    assert.equal(entry.activations['act-2'].status, 'active');
    assert.equal(entry.activations['ignored-by-ensure'], undefined);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-STOP-2] UserPromptSubmit de subagent registra o path sem avançar o turno principal', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-subagent-prompt-causality-'));
  const sessionId = 'wk-fixture-session-subagent-causality';
  const parentTranscript = join(vault, 'wk-fixture-parent-rollout.jsonl');
  const childTranscript = join(vault, 'wk-fixture-child-rollout.jsonl');
  try {
    writeFileSync(parentTranscript, `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'wk-fixture-parent-rollout', session_id: sessionId, model_provider: 'openai',
      },
    })}\n`);
    writeFileSync(childTranscript, `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'wk-fixture-child-rollout',
        session_id: sessionId,
        parent_thread_id: 'wk-fixture-parent-rollout',
        model_provider: 'openai',
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: 'wk-fixture-parent-rollout', depth: 1 },
          },
        },
      },
    })}\n`);

    const start = runHook('hooks/session-start.mjs', vault, {
      session_id: sessionId,
      transcript_path: parentTranscript,
      activation_id: 'parent-activation',
    });
    assert.equal(start.status, 0, start.stderr);

    const parentPrompt = runHook('hooks/session-ensure.mjs', vault, {
      session_id: sessionId,
      transcript_path: parentTranscript,
      turn_id: 'parent-turn-1',
      prompt: '[wk-fixture] Prompt principal sintético.',
    });
    assert.equal(parentPrompt.status, 0, parentPrompt.stderr);

    const childPrompt = runHook('hooks/session-ensure.mjs', vault, {
      session_id: sessionId,
      transcript_path: childTranscript,
      turn_id: 'child-turn-1',
      prompt: '[wk-fixture] Prompt filho sintético.',
    });
    assert.equal(childPrompt.status, 0, childPrompt.stderr);

    const entry = readSessionRegistry(vault).sessions[sessionId];
    assert.equal(entry.last_turn_sequence, 1);
    assert.equal(entry.turn_sequences['parent-turn-1'], 1);
    assert.equal(entry.turn_sequences['child-turn-1'], undefined);
    assert.equal(entry.transcript_path, parentTranscript);
    assert.deepEqual(new Set(entry.transcript_paths), new Set([parentTranscript, childTranscript]));
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
