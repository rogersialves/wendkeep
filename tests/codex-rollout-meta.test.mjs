import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCodexRolloutMeta,
  readFirstJsonlLine,
} from '../hooks/codex-rollout-meta.mjs';
import { inspectTranscriptIdentity } from '../hooks/session-identity.mjs';

const FOUR_MIB = 4 * 1024 * 1024;

function withRollout(content, run) {
  const dir = mkdtempSync(join(tmpdir(), 'wk-codex-meta-'));
  const path = join(dir, 'rollout-synthetic.jsonl');
  try {
    writeFileSync(path, content);
    return run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('[req:OBS-3] lê session_meta pequeno mesmo quando o corpo total supera 4 MiB', () => {
  const event = {
    type: 'session_meta',
    payload: {
      id: 'rollout-alpha',
      session_id: 'session-alpha',
      cwd: 'C:\\synthetic\\project',
      model_provider: 'openai',
    },
  };
  const firstLine = JSON.stringify(event);
  const largeBody = `${JSON.stringify({ type: 'event_msg', payload: { text: 'x'.repeat(FOUR_MIB + 1024) } })}\n`;

  withRollout(`${firstLine}\n${largeBody}`, (path) => {
    assert.ok(statSync(path).size > FOUR_MIB, 'fixture discrimina o mutante que mede o arquivo total');

    assert.deepEqual(readFirstJsonlLine(path), {
      ok: true,
      line: firstLine,
      lineBytes: Buffer.byteLength(firstLine),
    });
    assert.deepEqual(readCodexRolloutMeta(path), {
      ok: true,
      meta: event.payload,
      lineBytes: Buffer.byteLength(firstLine),
    });
  });
});

test('[req:OBS-3] rejeita primeira linha maior que o limite sem medir o corpo', () => {
  const firstLine = JSON.stringify({
    type: 'session_meta',
    payload: { id: 'rollout-beta', instructions: 'x'.repeat(256) },
  });

  withRollout(`${firstLine}\n`, (path) => {
    assert.deepEqual(readFirstJsonlLine(path, { maxBytes: 128 }), {
      ok: false,
      reason: 'LINE_TOO_LONG',
    });
    assert.deepEqual(readCodexRolloutMeta(path, { maxLineBytes: 128 }), {
      ok: false,
      reason: 'LINE_TOO_LONG',
    });
  });
});

test('[req:OBS-3] retorna razão tipada para JSON inválido', () => {
  withRollout('{"type":"session_meta"\n', (path) => {
    assert.deepEqual(readCodexRolloutMeta(path), {
      ok: false,
      reason: 'INVALID_JSON',
    });
  });
});

test('[req:OBS-3] retorna razão tipada quando o primeiro evento não é session_meta', () => {
  withRollout(`${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`, (path) => {
    assert.deepEqual(readCodexRolloutMeta(path), {
      ok: false,
      reason: 'NOT_SESSION_META',
    });
  });
});

test('[req:OBS-3] rejeita session_meta sem payload objeto', () => {
  withRollout(`${JSON.stringify({ type: 'session_meta', payload: null })}\n`, (path) => {
    assert.deepEqual(readCodexRolloutMeta(path), {
      ok: false,
      reason: 'INVALID_META',
    });
  });
});

test('[req:OBS-3] identidade Codex aceita session_meta somente na primeira linha física', () => {
  const misplacedMeta = JSON.stringify({
    type: 'session_meta',
    payload: {
      id: 'rollout-misplaced',
      session_id: 'session-misplaced',
      model_provider: 'openai',
    },
  });
  const firstEvent = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } });

  withRollout(`${firstEvent}\n${misplacedMeta}\n`, (path) => {
    assert.deepEqual(inspectTranscriptIdentity(path), {
      transcriptProvider: 'unknown',
      provider: 'unknown',
      canonicalConversationId: '',
      transcriptId: '',
      parentConversationId: '',
    });
  });
});

test('[req:OBS-3] identidade Codex não carrega o corpo total para validar metadata inicial', () => {
  const event = {
    type: 'session_meta',
    payload: {
      id: 'rollout-identity',
      session_id: 'session-identity',
      parent_thread_id: 'parent-identity',
      model_provider: 'openai',
    },
  };
  const body = JSON.stringify({ type: 'event_msg', payload: { text: 'x'.repeat(FOUR_MIB + 1024) } });

  withRollout(`${JSON.stringify(event)}\n${body}\n`, (path) => {
    assert.deepEqual(inspectTranscriptIdentity(path), {
      transcriptProvider: 'openai',
      provider: 'codex',
      canonicalConversationId: 'session-identity',
      transcriptId: 'rollout-identity',
      parentConversationId: 'parent-identity',
    });
  });
});

test('[req:OBS-3] integração incremental preserva inspeção Claude', () => {
  const claudeEvent = {
    type: 'user',
    sessionId: 'claude-synthetic',
    message: { role: 'user', content: 'conteúdo sintético' },
  };

  withRollout(`${JSON.stringify(claudeEvent)}\n`, (path) => {
    assert.deepEqual(inspectTranscriptIdentity(path), {
      transcriptProvider: 'anthropic',
      provider: 'claude',
      canonicalConversationId: 'claude-synthetic',
      transcriptId: 'rollout-synthetic',
      parentConversationId: '',
    });
  });
});
