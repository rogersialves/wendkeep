import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSessionActivation, writeControl } from '../hooks/obsidian-common.mjs';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function activeRegistry() {
  return {
    version: 2,
    sessions: {
      'wk-fixture-session': {
        status: 'active',
        session_file: 'sessions/wk-fixture-session.md',
        active_activation_id: 'wk-fixture-activation',
        last_turn_id: 'wk-fixture-turn-7',
        last_turn_sequence: 7,
        activations: {
          'wk-fixture-activation': {
            activation_id: 'wk-fixture-activation',
            epoch: 2,
            status: 'active',
            last_turn_sequence: 7,
            last_stop_turn_id: 'wk-fixture-turn-7',
          },
        },
      },
    },
  };
}

test('[req:OBS-15] final Stop fecha registry e activation sem apagar o histórico', () => {
  const result = closeSessionActivation(activeRegistry(), {
    session_id: 'wk-fixture-session',
    activation_id: 'wk-fixture-activation',
    turn_id: 'wk-fixture-turn-7',
    ended_at: '2026-08-14T12:00:00.000Z',
  });

  assert.equal(result.stopDisposition, 'finalized');
  const session = result.registry.sessions['wk-fixture-session'];
  assert.equal(session.status, 'done');
  assert.equal(session.active_activation_id, '');
  assert.equal(session.ended_at, '2026-08-14T12:00:00.000Z');
  assert.equal(session.last_turn_id, 'wk-fixture-turn-7');
  assert.equal(session.activations['wk-fixture-activation'].status, 'done');
  assert.equal(session.activations['wk-fixture-activation'].ended_at, '2026-08-14T12:00:00.000Z');
});

test('[req:OBS-15] CURRENT_SESSION derivado não lista uma sessão já finalizada', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-fixture-session-view-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    writeFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), `${JSON.stringify({
      ...closeSessionActivation(activeRegistry(), {
        session_id: 'wk-fixture-session',
        activation_id: 'wk-fixture-activation',
        turn_id: 'wk-fixture-turn-7',
        ended_at: '2026-08-14T12:00:00.000Z',
      }).registry,
    }, null, 2)}\n`);
    writeControl(vault, {
      status: 'inactive',
      session_file: '',
      last_session_file: 'sessions/wk-fixture-session.md',
      session_id: 'wk-fixture-session',
    });
    const dashboard = readFileSync(join(vault, '.brain', 'CURRENT_SESSION.md'), 'utf8');
    assert.match(dashboard, /Sessões ativas \(0\)/);
    assert.doesNotMatch(dashboard, /wk-fixture-session \|/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
