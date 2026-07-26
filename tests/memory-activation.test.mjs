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

test('[req:MEM-HYB-4] [req:HOOK-MEM-1] late stop cannot close or promote over a newer activation', () => {
  const first = openActivation(emptyRegistry(), session('s1', 'act-1', 4));
  const second = openActivation(first, session('s1', 'act-2', 0));

  const result = applyStopActivation(second, {
    session_id: 's1',
    activation_id: 'act-1',
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

test('[req:MEM-HYB-4] current activation rejects a stop older than its last observed turn', () => {
  const opened = openActivation(emptyRegistry(), session('s1', 'act-1', 3));
  const advanced = advanceActivationTurn(opened, {
    session_id: 's1', activation_id: 'act-1', turn_sequence: 7,
  });

  const result = applyStopActivation(advanced, {
    session_id: 's1', activation_id: 'act-1', turn_sequence: 6,
  });

  assert.equal(result.sessions.s1.active_activation_id, 'act-1');
  assert.equal(result.sessions.s1.last_turn_sequence, 7);
  assert.equal(result.stopDisposition, 'stale_turn');
  assert.equal(result.canPromoteMemory, false);
});

test('[req:HOOK-MEM-1] matching activation and non-older turn closes exactly that activation', () => {
  const opened = openActivation(emptyRegistry(), session('s1', 'act-1', 3));
  const result = applyStopActivation(opened, {
    session_id: 's1',
    activation_id: 'act-1',
    turn_sequence: 4,
    ended_at: '2026-07-26T03:30:00Z',
  });

  assert.equal(result.sessions.s1.active_activation_id, '');
  assert.equal(result.sessions.s1.activations['act-1'].status, 'done');
  assert.equal(result.sessions.s1.activations['act-1'].last_turn_sequence, 4);
  assert.equal(result.stopDisposition, 'applied');
  assert.equal(result.canPromoteMemory, true);
});

test('[req:HOOK-MEM-1] Stop resolves only the activation proven by its transcript identity', () => {
  const first = openActivation(emptyRegistry(), {
    ...session('s1', 'act-1', 4), transcript_id: 'rollout-1', transcript_path: 'one.jsonl',
  });
  const second = openActivation(first, {
    ...session('s1', 'act-2', 0), transcript_id: 'rollout-2', transcript_path: 'two.jsonl',
  });

  assert.equal(resolveStopActivation(second, {
    session_id: 's1', transcript_id: 'rollout-1', transcript_path: 'one.jsonl',
  }), 'act-1');
  assert.equal(resolveStopActivation(second, {
    session_id: 's1', transcript_id: 'unknown', transcript_path: 'unknown.jsonl',
  }), '');

  const ambiguous = openActivation(first, {
    ...session('s1', 'act-2', 0), transcript_id: 'rollout-1', transcript_path: 'one.jsonl',
  });
  assert.equal(resolveStopActivation(ambiguous, {
    session_id: 's1', transcript_id: 'rollout-1', transcript_path: 'one.jsonl',
  }), '');
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
    assert.equal(entry.last_turn_sequence, 0);
    assert.equal(entry.activations['act-1'].last_turn_sequence, 3);
    assert.equal(entry.activations['act-1'].status, 'superseded');
    assert.equal(entry.activations['act-2'].status, 'active');
    assert.equal(entry.activations['ignored-by-ensure'], undefined);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
