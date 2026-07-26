import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commitSessionMemory } from '../hooks/session-stop.mjs';

function fixture() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-stop-memory-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  writeFileSync(join(vault, '.brain', 'PROJECT.json'), `${JSON.stringify({ schemaVersion: 2, projectId: 'vendiva' })}\n`);
  return vault;
}

const handoff = {
  projectId: 'vendiva',
  identity: { canonicalConversationId: 'session-1', provider: 'codex' },
  activation: { id: 'activation-1', epoch: 1 },
  turn: { id: 'turn-9', sequence: 9 },
  noteRel: '02-Sessões/2026/07-JUL/DIA 25/22-22-session.md',
  observedAt: '2026-07-26T03:20:47Z',
  summary: 'Concluído. Próxima change será a interface de revisão.',
  evidence: {},
};

test('[req:MEM-HYB-1] [req:HOOK-MEM-1] finalized handoff reaches ledger and SHARED with a checkpoint', () => {
  const vault = fixture();
  const result = commitSessionMemory(vault, handoff);

  assert.equal(result.status, 'projected');
  assert.equal(result.eventCount, 1);
  assert.equal(result.checkpoint.revision, 1);
  assert.match(result.checkpoint.state_hash, /^[a-f0-9]{64}$/);
  assert.match(readFileSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl'), 'utf8'), /handoff\.latest/);
  assert.match(readFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), 'utf8'), /interface de revisão/);
});

test('[req:MEM-HYB-7] projector failure is degraded and preserves the outbox for replay', () => {
  const vault = fixture();
  const result = commitSessionMemory(vault, handoff, { projectOptions: { faultAt: 'after-ledger' } });

  assert.equal(result.status, 'degraded');
  assert.match(result.error, /after-ledger/);
  assert.ok(existsSync(join(vault, '.brain', 'memory-outbox', `${result.eventIds[0]}.json`)));
});
