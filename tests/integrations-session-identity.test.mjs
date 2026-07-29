import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectTranscriptIdentityContent,
  resolveSessionIdentitySnapshot,
  transcriptsMatch,
} from '../packages/integrations/src/session-identity.mjs';

const CODEX_CANONICAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CODEX_OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TRANSCRIPT_PATH = 'C:\\Users\\tester\\.codex\\sessions\\rollout-current.jsonl';
const jsonl = (events) => events.map((event) => (
  typeof event === 'string' ? event : JSON.stringify(event)
)).join('\n');

function inspectedCodex(overrides = {}) {
  return {
    transcriptProvider: 'openai',
    provider: 'codex',
    canonicalConversationId: CODEX_CANONICAL,
    transcriptId: 'rollout-current',
    parentConversationId: '',
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    input: { session_id: 'hook-ephemeral' },
    provider: 'codex',
    codexThreadId: '',
    transcriptPath: TRANSCRIPT_PATH,
    inspected: inspectedCodex(),
    registry: { version: 2, sessions: {} },
    ...overrides,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

test('[req:MOD-21] inspectTranscriptIdentityContent ignora JSONL inválido e separa conversa, rollout e parent', () => {
  const content = jsonl([
    'linha invalida antes do meta',
    {
      type: 'session_meta',
      payload: {
        id: 'rollout-child',
        session_id: CODEX_CANONICAL,
        parent_thread_id: 'parent-preferido',
        forked_from_id: 'fork-secundario',
        model_provider: 'openai',
      },
    },
  ]);

  assert.deepEqual(inspectTranscriptIdentityContent(content, { fallbackTranscriptId: 'fallback' }), {
    transcriptProvider: 'openai',
    provider: 'codex',
    canonicalConversationId: CODEX_CANONICAL,
    transcriptId: 'rollout-child',
    parentConversationId: 'parent-preferido',
  });
});

test('[req:MOD-21] inspeção Codex preserva precedência session_id > id e parent_thread_id > forked_from_id', () => {
  const preferred = inspectTranscriptIdentityContent(jsonl([{
    type: 'session_meta',
    payload: {
      session_id: 'conversation', id: 'rollout',
      parent_thread_id: 'parent', forked_from_id: 'fork',
    },
  }]), { fallbackTranscriptId: 'fallback' });
  assert.equal(preferred.canonicalConversationId, 'conversation');
  assert.equal(preferred.transcriptId, 'rollout');
  assert.equal(preferred.parentConversationId, 'parent');

  const fallbacks = inspectTranscriptIdentityContent(jsonl([{
    type: 'session_meta', payload: { id: 'rollout-only', forked_from_id: 'fork-only' },
  }]), { fallbackTranscriptId: 'filename-id' });
  assert.equal(fallbacks.canonicalConversationId, 'rollout-only');
  assert.equal(fallbacks.transcriptId, 'rollout-only');
  assert.equal(fallbacks.parentConversationId, 'fork-only');
});

test('[req:MOD-21] inspeção Claude usa sessionId embutido e fallback explícito do transcript', () => {
  const content = jsonl([
    '{quebrada',
    { type: 'user', sessionId: 'claude-session', message: { role: 'user', content: 'oi' } },
  ]);
  assert.deepEqual(inspectTranscriptIdentityContent(content, { fallbackTranscriptId: 'claude-file' }), {
    transcriptProvider: 'anthropic',
    provider: 'claude',
    canonicalConversationId: 'claude-session',
    transcriptId: 'claude-file',
    parentConversationId: '',
  });
});

test('[req:MOD-21] inspeção vazia ou desconhecida falha fechada sem inventar identidade', () => {
  const expected = {
    transcriptProvider: 'unknown',
    provider: 'unknown',
    canonicalConversationId: '',
    transcriptId: '',
    parentConversationId: '',
  };
  assert.deepEqual(inspectTranscriptIdentityContent(''), expected);
  assert.deepEqual(inspectTranscriptIdentityContent('inválida\n{"type":"progress"}'), expected);
});

test('[req:MOD-21] resolveSessionIdentitySnapshot bloqueia conflito entre CODEX_THREAD_ID e session_id do transcript', () => {
  const resolved = resolveSessionIdentitySnapshot(snapshot({ codexThreadId: CODEX_OTHER }));
  assert.equal(resolved.state, 'deferred');
  assert.equal(resolved.provider, 'codex');
  assert.equal(resolved.transcriptPath, TRANSCRIPT_PATH);
  assert.match(resolved.diagnostics.join(' '), /diverge/i);
});

test('[req:MOD-21] Codex sem transcript resolve somente por thread canônico válido', () => {
  const noTranscript = {
    input: { sessionId: 'hook-camel' },
    provider: 'codex',
    transcriptPath: '',
    inspected: inspectedCodex({
      transcriptProvider: 'unknown', provider: 'unknown', canonicalConversationId: '',
      transcriptId: '', parentConversationId: '',
    }),
    registry: { version: 2, sessions: {} },
  };
  const resolved = resolveSessionIdentitySnapshot({ ...noTranscript, codexThreadId: CODEX_CANONICAL });
  assert.deepEqual(resolved, {
    state: 'resolved',
    provider: 'codex',
    canonicalConversationId: CODEX_CANONICAL,
    hookSessionId: 'hook-camel',
    transcriptPath: '',
    transcriptId: CODEX_CANONICAL,
    parentConversationId: '',
    diagnostics: [],
  });
  assert.equal(resolveSessionIdentitySnapshot({
    ...noTranscript, codexThreadId: 'resume-efemero-invalido',
  }).state, 'deferred');
});

test('[req:MOD-21] aliases snake_case e camelCase do payload mantêm a mesma identidade', () => {
  const common = snapshot({ input: {} });
  const snake = resolveSessionIdentitySnapshot({
    ...common,
    input: { session_id: 'hook-alias', transcript_path: 'C:\\ignorado\\snake.jsonl' },
  });
  const camel = resolveSessionIdentitySnapshot({
    ...common,
    input: { sessionId: 'hook-alias', transcriptPath: 'C:\\ignorado\\camel.jsonl' },
  });
  assert.deepEqual(camel, snake);
  assert.equal(camel.hookSessionId, 'hook-alias');
  assert.equal(camel.transcriptPath, TRANSCRIPT_PATH, 'transcriptPath explícito prevalece sobre aliases do input');
});

test('[req:MOD-21] Claude novo sem transcript materializado resolve pelo sessionId do hook', () => {
  const resolved = resolveSessionIdentitySnapshot({
    input: { sessionId: 'claude-new-session' },
    provider: 'claude',
    codexThreadId: '',
    transcriptPath: 'C:\\logs\\claude-new-session.jsonl',
    inspected: {
      transcriptProvider: 'unknown', provider: 'unknown', canonicalConversationId: '',
      transcriptId: '', parentConversationId: '',
    },
    registry: { version: 2, sessions: {} },
  });
  assert.deepEqual(resolved, {
    state: 'resolved',
    provider: 'claude',
    canonicalConversationId: 'claude-new-session',
    hookSessionId: 'claude-new-session',
    transcriptPath: 'C:\\logs\\claude-new-session.jsonl',
    transcriptId: 'claude-new-session',
    parentConversationId: '',
    diagnostics: [],
  });
});

test('[req:MOD-21] fallback pelo session_id consulta somente entrada do mesmo provider', () => {
  const registryEntry = {
    provider: 'codex',
    transcript_path: 'C:\\logs\\known-rollout.jsonl',
    transcript_id: 'known-rollout',
  };
  const base = {
    input: { session_id: CODEX_CANONICAL },
    provider: 'codex',
    codexThreadId: '',
    transcriptPath: '',
    inspected: {
      transcriptProvider: 'unknown', provider: 'unknown', canonicalConversationId: '',
      transcriptId: '', parentConversationId: '',
    },
  };
  const resolved = resolveSessionIdentitySnapshot({
    ...base,
    registry: { version: 2, sessions: { [CODEX_CANONICAL]: registryEntry } },
  });
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.transcriptPath, registryEntry.transcript_path);
  assert.equal(resolved.transcriptId, registryEntry.transcript_id);

  const mismatch = resolveSessionIdentitySnapshot({
    ...base,
    registry: {
      version: 2,
      sessions: { [CODEX_CANONICAL]: { ...registryEntry, provider: 'claude' } },
    },
  });
  assert.equal(mismatch.state, 'deferred');
});

test('[req:MOD-21] transcript de provider incompatível permanece deferred', () => {
  const resolved = resolveSessionIdentitySnapshot(snapshot({
    inspected: {
      transcriptProvider: 'anthropic',
      provider: 'claude',
      canonicalConversationId: 'claude-session',
      transcriptId: 'claude-rollout',
      parentConversationId: '',
    },
  }));
  assert.equal(resolved.state, 'deferred');
  assert.match(resolved.diagnostics.join(' '), /incompatível|incompativel/i);
});

test('[req:MOD-21] lookup registry por transcript ignora entrada de outro provider', () => {
  const resolved = resolveSessionIdentitySnapshot(snapshot({
    registry: {
      version: 2,
      sessions: {
        'claude-nao-pode-roubar': {
          provider: 'claude',
          transcript_path: TRANSCRIPT_PATH,
          transcript_paths: [TRANSCRIPT_PATH],
        },
      },
    },
  }));
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.canonicalConversationId, CODEX_CANONICAL);
  assert.notEqual(resolved.canonicalConversationId, 'claude-nao-pode-roubar');
});

test('[req:MOD-21] lookup registry por transcript reconecta somente entrada compatível', () => {
  const resolved = resolveSessionIdentitySnapshot(snapshot({
    registry: {
      version: 2,
      sessions: {
        'conversa-ja-registrada': {
          provider: 'codex',
          transcript_paths: ['c:/users/tester/.codex/sessions/ROLLOUT-CURRENT.JSONL'],
        },
      },
    },
  }));
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.canonicalConversationId, 'conversa-ja-registrada');
});

test('[req:MOD-21] transcriptsMatch normaliza separador/caixa, aceita basename e rejeita vazios', () => {
  assert.equal(transcriptsMatch(
    'C:\\Users\\Me\\.claude\\projects\\A\\SESSION.JSONL',
    'c:/users/me/.claude/projects/a/session.jsonl',
  ), true);
  assert.equal(transcriptsMatch('/mnt/c/elsewhere/session.jsonl', 'C:\\logs\\SESSION.JSONL'), true);
  assert.equal(transcriptsMatch('/a/one.jsonl', '/a/two.jsonl'), false);
  assert.equal(transcriptsMatch('', '/a/two.jsonl'), false);
  assert.equal(transcriptsMatch('/a/two.jsonl', null), false);
});

test('[req:MOD-20] [req:MOD-21] resolução é determinística e não muta input, inspeção ou registry', () => {
  const argumentsSnapshot = deepFreeze(snapshot({
    input: { session_id: 'hook-immutable', transcript_path: TRANSCRIPT_PATH },
    registry: {
      version: 2,
      sessions: {
        [CODEX_CANONICAL]: {
          provider: 'codex',
          transcript_path: TRANSCRIPT_PATH,
          transcript_paths: [TRANSCRIPT_PATH],
        },
      },
    },
  }));
  const before = JSON.stringify(argumentsSnapshot);
  const first = resolveSessionIdentitySnapshot(argumentsSnapshot);
  const second = resolveSessionIdentitySnapshot(argumentsSnapshot);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(argumentsSnapshot), before);
});
