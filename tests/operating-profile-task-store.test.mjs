import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSessionRegistry } from '../hooks/obsidian-common.mjs';
import {
  consumeSessionTaskOperatingProfile,
  setSessionTaskOperatingProfile,
} from '../hooks/operating-profile-task-store.mjs';

function fixture() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-task-profile-store-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  const note = join(vault, 'session.md');
  writeFileSync(note, '# bytes imutáveis\n', 'utf8');
  writeFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), `${JSON.stringify({
    version: 2,
    sessions: {
      'session-1': {
        status: 'active',
        provider: 'codex',
        session_file: 'session.md',
        operating_profile: 'OFF',
        operating_profile_source: 'explicit-cli',
        last_prompt_turn_id: 'turn-5',
        last_turn_sequence: 5,
        turn_sequences: { 'turn-5': 5 },
      },
    },
  }, null, 2)}\n`, 'utf8');
  return { vault, note };
}

test('[req:OP-11] store cria lease no prompt atual sem alterar perfil persistente, identidade ou nota', () => {
  const f = fixture();
  try {
    const noteBefore = readFileSync(f.note);
    const lease = setSessionTaskOperatingProfile(f.vault, 'session-1', 'FLOW', {
      reason: 'ajuste local reversível',
      leaseId: 'lease-flow-1',
      now: '2026-08-01T17:00:00.000Z',
    });
    assert.equal(lease.profile, 'FLOW');
    assert.equal(lease.request_turn_id, 'turn-5');
    assert.equal(lease.request_turn_sequence, 5);

    const entry = readSessionRegistry(f.vault).sessions['session-1'];
    assert.equal(entry.operating_profile, 'OFF');
    assert.equal(entry.operating_profile_source, 'explicit-cli');
    assert.deepEqual(entry.operating_profile_task, lease);
    assert.equal(entry.session_file, 'session.md');
    assert.deepEqual(readFileSync(f.note), noteBefore);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:OP-11] [req:OP-12] leases reais recebem ids distintos, substituem e usam CAS por lease_id', () => {
  const f = fixture();
  try {
    const first = setSessionTaskOperatingProfile(f.vault, 'session-1', 'FLOW', {
      reason: 'primeira rota', now: '2026-08-01T17:00:00.000Z',
    });
    const second = setSessionTaskOperatingProfile(f.vault, 'session-1', 'GOVERN', {
      reason: 'risco descoberto', now: '2026-08-01T17:01:00.000Z',
    });
    assert.match(first.lease_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(second.lease_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(first.lease_id, second.lease_id);
    assert.equal(consumeSessionTaskOperatingProfile(
      f.vault, 'session-1', first.lease_id, { now: '2026-08-01T17:02:00.000Z' },
    ), false);
    assert.equal(readSessionRegistry(f.vault).sessions['session-1'].operating_profile_task.state, 'active');
    assert.equal(consumeSessionTaskOperatingProfile(
      f.vault, 'session-1', second.lease_id, { now: '2026-08-01T17:03:00.000Z' },
    ), true);
    const consumed = readSessionRegistry(f.vault).sessions['session-1'].operating_profile_task;
    assert.equal(consumed.state, 'consumed');
    assert.equal(consumed.consumed_at, '2026-08-01T17:03:00.000Z');
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:OP-11] store rejeita sessão sem prompt causal sem criar estado parcial', () => {
  const f = fixture();
  try {
    const path = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    const registry = JSON.parse(readFileSync(path, 'utf8'));
    delete registry.sessions['session-1'].last_turn_sequence;
    writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    const before = readFileSync(path, 'utf8');
    assert.throws(
      () => setSessionTaskOperatingProfile(f.vault, 'session-1', 'FLOW', {
        reason: 'sem prompt', leaseId: 'lease-invalid', now: '2026-08-01T17:00:00.000Z',
      }),
      (error) => error?.code === 'WENDKEEP_TASK_PROFILE_CONTEXT_INVALID',
    );
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});
