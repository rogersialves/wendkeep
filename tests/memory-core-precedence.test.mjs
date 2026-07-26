import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enqueueMemoryEvent,
  projectMemoryOutbox,
} from '../hooks/memory-store.mjs';

const PROJECT_ID = 'project-core-precedence';

function memoryEvent(eventId, memoryKey, value) {
  return {
    v: 1,
    project_id: PROJECT_ID,
    event_id: eventId,
    memory_key: memoryKey,
    operation: 'assert',
    value,
    authority: 'verified',
    canonical_session_id: 'session-core-precedence',
    activation_id: 'activation-core-precedence',
    turn_sequence: 1,
    observed_at: '2026-07-26T12:00:00.000Z',
    evidence: ['CORE.md'],
  };
}

test('[req:MEM-HYB-3] projector blocks an operational contradiction against an explicit CORE invariant', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-core-precedence-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({ projectId: PROJECT_ID })}\n`);

  const core = [
    '# CORE',
    '',
    '## Invariantes can\u00f4nicas',
    '- Releases nunca fazem push autom\u00e1tico.',
    '<!-- wk-memory: release.push="manual-only" -->',
    '',
  ].join('\n');
  const corePath = join(brain, 'CORE.md');
  writeFileSync(corePath, core);

  try {
    enqueueMemoryEvent(vault, memoryEvent('mem-contradiction', 'release.push', 'automatic'));
    enqueueMemoryEvent(vault, memoryEvent('mem-independent', 'next.ui', 'review-interface'));

    const projected = projectMemoryOutbox(vault);
    const shared = readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8');
    const candidates = readFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.equal(readFileSync(corePath, 'utf8'), core, 'projector must not rewrite CORE bytes');
    assert.match(shared, /review-interface/, 'independent operational state remains projectable');
    assert.doesNotMatch(shared, /automatic|release\.push/, 'contradiction is not promoted to SHARED');
    assert.equal(projected.candidates, 1);
    assert.deepEqual(candidates, [{
      v: 1,
      candidate_id: candidates[0].candidate_id,
      reason: 'blocked_by_core',
      status: 'blocked_by_core',
      memory_key: 'release.push',
      event_ids: ['mem-contradiction'],
      proposed_value: 'automatic',
      core_value: 'manual-only',
      provenance: {
        authority: 'core',
        source: '.brain/CORE.md',
        core_value_hash: candidates[0].provenance.core_value_hash,
      },
      events: [memoryEvent('mem-contradiction', 'release.push', 'automatic')],
    }]);
    assert.match(candidates[0].provenance.core_value_hash, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
