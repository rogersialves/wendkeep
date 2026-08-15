import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendIterationOutcome,
  iterationOutcomePath,
  normalizeIterationOutcome,
  readIterationOutcomes,
} from '../hooks/session-iteration-outcome.mjs';
import { withVaultPathLock } from '../packages/vault/src/vault-path-safety.mjs';

const SESSION_ID = 'wk-fixture-session-1';
const TRANSCRIPT_ID = 'wk-fixture-transcript-1';
const SECOND_SESSION_ID = 'wk-fixture-session-2';

function tempVault() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-outcome-ledger-'));
  mkdirSync(join(vault, '.brain'));
  return vault;
}

test('[req:OUTCOME-1] normaliza somente campos do ledger e remove conteúdo de conversa', () => {
  const outcome = normalizeIterationOutcome({
    session_id: SESSION_ID,
    transcript_id: TRANSCRIPT_ID,
    turn_id: 'turn-1',
    turn_sequence: '4',
    hook: 'Stop',
    stage: 'iteration',
    result: 'inserted',
    lock_status: 'acquired',
    duration_ms: '12',
    occurred_at: '2026-08-14T00:00:00.000Z',
    reason: 'marker confirmed',
    prompt: '[wk-fixture] não persistir esta pergunta',
    payload: { secret: '[wk-fixture] não persistir' },
    error: '[wk-fixture] erro bruto não persistir',
  });

  assert.deepEqual(outcome, {
    schema_version: 1,
    outcome_id: `${SESSION_ID}:turn-1:iteration`,
    session_id: SESSION_ID,
    transcript_id: TRANSCRIPT_ID,
    turn_id: 'turn-1',
    turn_sequence: 4,
    hook: 'Stop',
    stage: 'iteration',
    result: 'inserted',
    lock_status: 'acquired',
    duration_ms: 12,
    occurred_at: '2026-08-14T00:00:00.000Z',
    reason: 'marker confirmed',
  });
  assert.doesNotMatch(JSON.stringify(outcome), /não persistir|secret|bruto/);
});

test('[req:OUTCOME-3] append é atômico e idempotente por sessão, turno e estágio', () => {
  const vault = tempVault();
  try {
    const input = {
      session_id: SESSION_ID,
      transcript_id: TRANSCRIPT_ID,
      turn_id: 'turn-1',
      turn_sequence: 1,
      hook: 'Stop',
      stage: 'iteration',
      result: 'inserted',
      lock_status: 'acquired',
      duration_ms: 3,
      occurred_at: '2026-08-14T00:00:00.000Z',
      reason: 'marker confirmed',
    };

    const first = appendIterationOutcome(vault, input);
    const second = appendIterationOutcome(vault, { ...input, reason: 'retry' });

    assert.equal(first.written, true);
    assert.equal(first.result, 'inserted');
    assert.equal(second.written, false);
    assert.equal(second.result, 'duplicate');
    assert.deepEqual(readIterationOutcomes(vault), [normalizeIterationOutcome(input)]);
    assert.equal(readFileSync(iterationOutcomePath(vault), 'utf8').split('\n').filter(Boolean).length, 1);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OUTCOME-3] lock ocupado não é convertido em sucesso nem cria uma linha', () => {
  const vault = tempVault();
  try {
    const input = {
      session_id: SECOND_SESSION_ID,
      turn_id: 'turn-busy',
      hook: 'Stop',
      stage: 'iteration',
      result: 'inserted',
      reason: 'should remain pending',
    };
    const result = withVaultPathLock(
      vault,
      iterationOutcomePath(vault),
      () => appendIterationOutcome(vault, input, { timeoutMs: 0, retries: 0 }),
      { timeoutMs: 100 },
    );

    assert.equal(result.written, false);
    assert.equal(result.result, 'busy');
    assert.deepEqual(readIterationOutcomes(vault), []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
