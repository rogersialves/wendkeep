import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backfillSessions } from '../hooks/session-backfill.mjs';

const SESSION_ID = 'wk-fixture-session-backfill';
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function fixture() {
  const vaultBase = mkdtempSync(join(tmpdir(), 'wk-session-backfill-complete-'));
  const brain = join(vaultBase, '.brain');
  const sessionRel = '03-Sessões/wk-fixture-session-backfill.md';
  const sessionPath = join(vaultBase, ...sessionRel.split('/'));
  const transcriptPath = join(vaultBase, 'wk-fixture-rollout.jsonl');
  mkdirSync(brain, { recursive: true });
  mkdirSync(join(sessionPath, '..'), { recursive: true });
  writeFileSync(sessionPath, [
    '---',
    'type: session',
    `session_id: "${SESSION_ID}"`,
    'provider: codex',
    'status: active',
    '---',
    '',
    '# Synthetic session',
    '',
    '## Iterações',
    '',
    '## Pendências',
    '',
    'Nenhuma pendência identificada automaticamente.',
    '',
  ].join('\n'));
  const events = [
    { type: 'session_meta', payload: { id: 'wk-fixture-rollout', session_id: SESSION_ID } },
    { type: 'event_msg', timestamp: '2026-08-02T10:00:00.000Z', payload: { type: 'task_started', turn_id: 'turn-completo' } },
    { type: 'event_msg', timestamp: '2026-08-02T10:00:01.000Z', payload: { type: 'user_message', turn_id: 'turn-completo', message: '[wk-fixture] Pedido completo.' } },
    { type: 'event_msg', timestamp: '2026-08-02T10:00:02.000Z', payload: { type: 'agent_message', turn_id: 'turn-completo', message: '[wk-fixture] Resposta completa.' } },
    { type: 'event_msg', timestamp: '2026-08-02T10:00:03.000Z', payload: { type: 'task_complete', turn_id: 'turn-completo' } },
    { type: 'event_msg', timestamp: '2026-08-02T10:01:00.000Z', payload: { type: 'task_started', turn_id: 'turn-em-execucao' } },
    { type: 'event_msg', timestamp: '2026-08-02T10:01:01.000Z', payload: { type: 'user_message', turn_id: 'turn-em-execucao', message: '[wk-fixture] Pedido ainda ativo.' } },
    { type: 'event_msg', timestamp: '2026-08-02T10:01:02.000Z', payload: { type: 'agent_message', turn_id: 'turn-em-execucao', message: '[wk-fixture] Resposta parcial.' } },
  ];
  writeFileSync(transcriptPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  writeFileSync(join(brain, 'SESSION_REGISTRY.json'), `${JSON.stringify({
    version: 2,
    sessions: {
      [SESSION_ID]: {
        session_file: sessionRel,
        transcript_path: transcriptPath,
        transcript_id: 'wk-fixture-rollout',
        provider: 'codex',
        status: 'active',
      },
    },
  }, null, 2)}\n`);
  return { vaultBase, sessionPath, transcriptPath };
}

test('[req:IMPORT-7] CLI encaminha flags do hook session-backfill até o script', () => {
  const fx = fixture();
  try {
    const run = spawnSync(process.execPath, [
      BIN,
      'hook',
      'session-backfill',
      '--session',
      SESSION_ID,
      '--vault',
      fx.vaultBase,
      '--write',
    ], {
      cwd: fx.vaultBase,
      env: { ...process.env, OBSIDIAN_VAULT_PATH: fx.vaultBase },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.mode, 'write');
    assert.equal(report.inserted, 1);
    assert.match(readFileSync(fx.sessionPath, 'utf8'), /<!-- wk-turn: turn-completo -->/);
    assert.doesNotMatch(readFileSync(fx.sessionPath, 'utf8'), /<!-- wk-turn: turn-em-execucao -->/);
  } finally {
    rmSync(fx.vaultBase, { recursive: true, force: true });
  }
});

test('[req:IMPORT-7] session-backfill insere concluído e apenas reporta turno Codex ativo', () => {
  const fx = fixture();
  try {
    const dry = backfillSessions({ vaultBase: fx.vaultBase, session: SESSION_ID });
    assert.equal(dry.candidates, 1);
    assert.deepEqual(dry.sessions[0].missingTurns, ['turn-completo']);
    assert.deepEqual(dry.sessions[0].incompleteTurns, ['turn-em-execucao']);
    assert.doesNotMatch(readFileSync(fx.sessionPath, 'utf8'), /wk-turn:/);

    const applied = backfillSessions({ vaultBase: fx.vaultBase, session: SESSION_ID, write: true });
    assert.equal(applied.inserted, 1);
    const content = readFileSync(fx.sessionPath, 'utf8');
    assert.match(content, /<!-- wk-turn: turn-completo -->/);
    assert.doesNotMatch(content, /<!-- wk-turn: turn-em-execucao -->/);

    const again = backfillSessions({ vaultBase: fx.vaultBase, session: SESSION_ID, write: true });
    assert.equal(again.inserted, 0);
    assert.deepEqual(again.sessions[0].incompleteTurns, ['turn-em-execucao']);

    appendFileSync(fx.transcriptPath, `${JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-02T10:01:03.000Z',
      payload: { type: 'task_complete', turn_id: 'turn-em-execucao' },
    })}\n`);
    const completedLater = backfillSessions({
      vaultBase: fx.vaultBase,
      session: SESSION_ID,
      write: true,
    });
    assert.equal(completedLater.inserted, 1);
    assert.deepEqual(completedLater.sessions[0].missingTurns, ['turn-em-execucao']);
    assert.deepEqual(completedLater.sessions[0].incompleteTurns, []);
    assert.match(
      readFileSync(fx.sessionPath, 'utf8'),
      /<!-- wk-turn: turn-em-execucao -->/,
    );
  } finally {
    rmSync(fx.vaultBase, { recursive: true, force: true });
  }
});

test('[req:IMPORT-7] session-backfill preserva elegibilidade histórica de transcript Claude', () => {
  const fx = fixture();
  try {
    const claudeEvents = [
      {
        type: 'user',
        uuid: 'claude-turn-sem-task-complete',
        timestamp: '2026-08-02T11:00:00.000Z',
        sessionId: SESSION_ID,
        message: { role: 'user', content: 'Pedido Claude histórico.' },
      },
      {
        type: 'assistant',
        uuid: 'claude-answer',
        timestamp: '2026-08-02T11:00:01.000Z',
        sessionId: SESSION_ID,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'Resposta Claude histórica.' }],
        },
      },
    ];
    writeFileSync(
      fx.transcriptPath,
      `${claudeEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
    const registryPath = join(fx.vaultBase, '.brain', 'SESSION_REGISTRY.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.sessions[SESSION_ID].provider = 'claude';
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const applied = backfillSessions({ vaultBase: fx.vaultBase, session: SESSION_ID, write: true });
    assert.equal(applied.inserted, 1);
    assert.equal(applied.incomplete, 0);
    assert.match(
      readFileSync(fx.sessionPath, 'utf8'),
      /<!-- wk-turn: claude-turn-sem-task-complete -->/,
    );
  } finally {
    rmSync(fx.vaultBase, { recursive: true, force: true });
  }
});
