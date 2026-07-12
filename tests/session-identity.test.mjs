import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectTranscriptIdentity, resolveSessionIdentity } from '../hooks/session-identity.mjs';
import { readSessionRegistry, upsertSessionRegistry, writeControl } from '../hooks/obsidian-common.mjs';

function temp() { return mkdtempSync(join(tmpdir(), 'wk-identity-')); }

test('Codex usa session_id canônico e mantém id do rollout separado', () => {
  const vault = temp();
  try {
    const tx = join(vault, 'rollout.jsonl');
    writeFileSync(tx, `${JSON.stringify({ type: 'session_meta', payload: { id: 'rollout-2', session_id: 'conversation-1', model_provider: 'openai', parent_thread_id: 'parent-1' } })}\n`);
    const inspected = inspectTranscriptIdentity(tx);
    assert.equal(inspected.canonicalConversationId, 'conversation-1');
    assert.equal(inspected.transcriptId, 'rollout-2');
    assert.equal(inspected.parentConversationId, 'parent-1');
    const resolved = resolveSessionIdentity(vault, { transcript_path: tx, session_id: 'ephemeral' }, 'codex');
    assert.equal(resolved.state, 'resolved');
    assert.equal(resolved.canonicalConversationId, 'conversation-1');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('Claude resolve pelo sessionId embutido e cross-provider é deferred sem mutação', () => {
  const vault = temp();
  try {
    const tx = join(vault, 'claude.jsonl');
    writeFileSync(tx, `${JSON.stringify({ type: 'user', sessionId: 'claude-conversation', message: { content: 'oi' } })}\n`);
    assert.equal(resolveSessionIdentity(vault, { transcript_path: tx }, 'claude').canonicalConversationId, 'claude-conversation');
    const before = JSON.stringify(readSessionRegistry(vault));
    const blocked = resolveSessionIdentity(vault, { transcript_path: tx }, 'codex');
    assert.equal(blocked.state, 'deferred');
    assert.equal(JSON.stringify(readSessionRegistry(vault)), before);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('Claude: sessão nova sem transcript materializado resolve pelo hookId (não adia 1º turno)', () => {
  const vault = temp();
  try {
    // transcript_path presente, mas arquivo ainda não existe em disco (race do 1º turno)
    const tx = join(vault, 'nao-materializado.jsonl');
    const resolved = resolveSessionIdentity(vault, { transcript_path: tx, session_id: '5647583f-33eb-4845-a4e4-72b8e5da7fce' }, 'claude');
    assert.equal(resolved.state, 'resolved');
    assert.equal(resolved.canonicalConversationId, '5647583f-33eb-4845-a4e4-72b8e5da7fce');
    assert.equal(resolved.transcriptId, 'nao-materializado');
    // Codex no mesmo estado NÃO pode resolver pelo id efêmero do hook — barreira do incidente 2026-07-11
    const codex = resolveSessionIdentity(vault, { transcript_path: join(vault, 'rollout-inexistente.jsonl'), session_id: 'ephemeral-resume' }, 'codex');
    assert.equal(codex.state, 'deferred');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('registry v2 preserva campos válidos, múltiplos transcripts e dashboard lista sessões', () => {
  const vault = temp();
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    upsertSessionRegistry(vault, 'a', { status: 'done', provider: 'codex', session_file: '02-Sessões/a.md', transcript_path: 'A.jsonl', change_slug: 'feature-a', ended_at: '2026-07-12T10:00:00' });
    upsertSessionRegistry(vault, 'a', { status: 'active', ended_at: '' });
    upsertSessionRegistry(vault, 'a', { transcript_path: '', transcript_id: 'rollout-a2' });
    upsertSessionRegistry(vault, 'a', { transcript_path: 'A2.jsonl' });
    upsertSessionRegistry(vault, 'b', { status: 'active', provider: 'claude', session_file: '02-Sessões/b.md', transcript_path: 'B.jsonl', change_slug: 'feature-b' });
    writeControl(vault, { status: 'active', session_id: 'a', session_file: '02-Sessões/a.md' });
    const registry = readSessionRegistry(vault);
    assert.equal(registry.version, 2);
    assert.equal(registry.sessions.a.transcript_path, 'A2.jsonl');
    assert.equal(registry.sessions.a.ended_at, '');
    assert.deepEqual(registry.sessions.a.transcript_paths, ['A.jsonl', 'A2.jsonl']);
    const dashboard = readFileSync(join(vault, '.brain', 'CURRENT_SESSION.md'), 'utf8');
    assert.match(dashboard, /Sessões ativas \(2\)/);
    assert.match(dashboard, /feature-a/);
    assert.match(dashboard, /feature-b/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
