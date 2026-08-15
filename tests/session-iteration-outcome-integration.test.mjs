import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readIterationOutcomes,
} from '../hooks/session-iteration-outcome.mjs';
import {
  recordStopOutcome,
  refreshStopObservability,
} from '../hooks/session-stop.mjs';

const SESSION_ID = 'wk-fixture-session-observability';
const TRANSCRIPT_ID = 'wk-fixture-transcript-observability';

test('[req:OBS-1] refreshStopObservability expõe status detalhado sem quebrar o booleano legado', async () => {
  const details = await refreshStopObservability({
    causalStop: { canPromoteMemory: false },
    hookStartedAt: 0,
  }, {
    now: () => 100,
    returnDetails: true,
  });
  assert.deepEqual(details, {
    ok: false,
    status: 'skipped',
    reason: 'causal-stop-not-promotable',
  });

  const legacy = await refreshStopObservability({
    causalStop: { canPromoteMemory: false },
    hookStartedAt: 0,
  }, { now: () => 100 });
  assert.equal(legacy, false);
});
test('[req:OBS-1] status de observabilidade é persistido como estágio separado', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-outcome-observability-'));
  mkdirSync(join(vault, '.brain'));
  try {
    const result = recordStopOutcome(vault, {
      sessionId: SESSION_ID,
      transcriptId: TRANSCRIPT_ID,
      turnId: 'turn-7',
      turnSequence: 7,
      stage: 'observability',
      result: 'degraded',
      reason: 'checkpoint not published',
    });
    assert.equal(result.written, true);
    assert.deepEqual(readIterationOutcomes(vault).map(({ stage, result: state }) => ({ stage, result: state })), [
      { stage: 'observability', result: 'degraded' },
    ]);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
