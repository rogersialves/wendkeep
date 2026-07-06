import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeProjectSlug,
  discoverTranscripts,
  discoverCodexTranscripts,
  importSession,
  runImport,
} from '../hooks/import-sessions.mjs';
import { readSessionRegistry } from '../hooks/obsidian-common.mjs';

// Two-turn Claude transcript dated 2026-06-13 (NOT today) so we prove date-folder placement.
const TRANSCRIPT = [
  { type: 'user', uuid: 't1', timestamp: '2026-06-13T09:00:00.000Z', sessionId: 'sid-alpha', message: { role: 'user', content: 'Primeira pergunta sobre autenticacao' } },
  { type: 'assistant', uuid: 'a1', timestamp: '2026-06-13T09:00:05.000Z', sessionId: 'sid-alpha', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 0 }, content: [{ type: 'text', text: 'Resposta um' }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/auth.js' } }] } },
  { type: 'user', uuid: 't2', timestamp: '2026-06-13T09:05:00.000Z', sessionId: 'sid-alpha', message: { role: 'user', content: 'Segunda pergunta do usuario' } },
  { type: 'assistant', uuid: 'a2', timestamp: '2026-06-13T09:05:05.000Z', sessionId: 'sid-alpha', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 50, output_tokens: 80 }, content: [{ type: 'text', text: 'Resposta dois' }] } },
];

function writeTranscript(dir, sessionId, events) {
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  return path;
}

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('claudeProjectSlug encodes a Windows path like Claude does', () => {
  assert.equal(claudeProjectSlug('C:\\GitHub\\WendKeep'), 'C--GitHub-WendKeep');
  assert.equal(claudeProjectSlug('/home/me/proj'), '-home-me-proj');
});

test('discoverTranscripts lists jsonl with sessionId from filename (no parse)', () => {
  const src = tmp('wk-src-');
  writeTranscript(src, 'sid-one', TRANSCRIPT);
  writeTranscript(src, 'sid-two', TRANSCRIPT);
  writeFileSync(join(src, 'notes.txt'), 'ignore me', 'utf-8');
  const { transcripts } = discoverTranscripts('C:\\whatever', src);
  const ids = transcripts.map((t) => t.sessionId).sort();
  assert.deepEqual(ids, ['sid-one', 'sid-two']);
});

test('importSession builds a full dated note from a transcript', () => {
  const src = tmp('wk-src-');
  const vault = tmp('wk-vault-');
  const txPath = writeTranscript(src, 'sid-alpha', TRANSCRIPT);

  const r = importSession(vault, txPath);
  assert.equal(r.sessionId, 'sid-alpha');
  assert.equal(r.turns, 2);

  const abs = join(vault, r.relPath);
  assert.ok(existsSync(abs), 'note file exists');
  const note = readFileSync(abs, 'utf-8');

  // Placed in the REAL session date's folder, not today.
  assert.match(note, /^date:\s*2026-06-13\s*$/m);
  assert.match(r.relPath, /2026/);

  // Both turns memorialized (dedup markers present).
  assert.ok(note.includes('<!-- codex-turn: t1 -->'), 'turn 1 marker');
  assert.ok(note.includes('<!-- codex-turn: t2 -->'), 'turn 2 marker');
  assert.ok(note.includes('Primeira pergunta'), 'first prompt captured');
  assert.ok(note.includes('Segunda pergunta'), 'second prompt captured');

  // Finalized: ended_at stamped from the last turn.
  assert.match(note, /^ended_at:\s*\S+/m);

  // Registered so a re-run dedups.
  const reg = readSessionRegistry(vault).sessions['sid-alpha'];
  assert.ok(reg, 'registry entry created');
  assert.equal(reg.status, 'done');
});

test('runImport dedups by session_id and is idempotent', () => {
  const src = tmp('wk-src-');
  const vault = tmp('wk-vault-');
  writeTranscript(src, 'sid-alpha', TRANSCRIPT);

  const first = runImport(vault, { source: 'claude', from: src });
  assert.equal(first.scanned, 1);
  assert.equal(first.imported, 1);
  assert.equal(first.skipped, 0);

  // Second run: already in the registry -> skipped, nothing new written.
  const second = runImport(vault, { source: 'claude', from: src });
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 1);
});

// --- Codex source (0.17.0) --------------------------------------------------

const CODEX_CWD = 'C:\\proj\\demo';
const CODEX_TRANSCRIPT = [
  { type: 'session_meta', timestamp: '2026-05-10T10:00:00.000Z', payload: { id: 'cdx-alpha', timestamp: '2026-05-10T10:00:00.000Z', cwd: CODEX_CWD, model: 'gpt-5', model_provider: 'openai' } },
  { type: 'event_msg', timestamp: '2026-05-10T10:00:01.000Z', payload: { type: 'task_started', turn_id: 'turn-1' } },
  { type: 'event_msg', timestamp: '2026-05-10T10:00:02.000Z', payload: { type: 'user_message', turn_id: 'turn-1', message: 'Primeira pergunta no codex' } },
  { type: 'event_msg', timestamp: '2026-05-10T10:00:03.000Z', payload: { type: 'agent_message', turn_id: 'turn-1', message: 'Resposta codex um' } },
  { type: 'event_msg', timestamp: '2026-05-10T10:00:04.000Z', payload: { type: 'token_count', turn_id: 'turn-1', info: { model: 'gpt-5', last_token_usage: { input_tokens: 100, output_tokens: 50 } } } },
  { type: 'event_msg', timestamp: '2026-05-10T10:05:00.000Z', payload: { type: 'task_started', turn_id: 'turn-2' } },
  { type: 'event_msg', timestamp: '2026-05-10T10:05:01.000Z', payload: { type: 'user_message', turn_id: 'turn-2', message: 'Segunda no codex' } },
  { type: 'event_msg', timestamp: '2026-05-10T10:05:02.000Z', payload: { type: 'agent_message', turn_id: 'turn-2', message: 'Resposta codex dois' } },
];

// Codex names files rollout-<ISO>-<uuid>.jsonl; discovery reads session_meta for id + cwd.
function writeCodexTranscript(dir, name, events, sub = '2026/05/10') {
  const day = join(dir, ...sub.split('/'));
  mkdirSync(day, { recursive: true });
  const path = join(day, name);
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  return path;
}

test('discoverCodexTranscripts filters by the session cwd', () => {
  const src = tmp('wk-cdx-');
  writeCodexTranscript(src, 'rollout-2026-05-10T10-00-00-cdx-alpha.jsonl', CODEX_TRANSCRIPT);

  const hit = discoverCodexTranscripts(CODEX_CWD, src);
  assert.equal(hit.transcripts.length, 1);
  assert.equal(hit.transcripts[0].sessionId, 'cdx-alpha');

  const miss = discoverCodexTranscripts('C:\\other\\project', src);
  assert.equal(miss.transcripts.length, 0);
});

test('importSession tags a Codex note with provider: codex', () => {
  const src = tmp('wk-cdx-');
  const vault = tmp('wk-vault-');
  const txPath = writeCodexTranscript(src, 'rollout-2026-05-10T10-00-00-cdx-alpha.jsonl', CODEX_TRANSCRIPT);

  const r = importSession(vault, txPath);
  assert.equal(r.sessionId, 'cdx-alpha');
  assert.equal(r.turns, 2);

  const note = readFileSync(join(vault, r.relPath), 'utf-8');
  assert.match(note, /^provider:\s*codex\s*$/m);
  assert.match(note, /^\s+- codex\s*$/m); // tag
  assert.match(note, /^date:\s*2026-05-10\s*$/m);
  assert.ok(note.includes('<!-- codex-turn: turn-1 -->'));
  assert.ok(note.includes('<!-- codex-turn: turn-2 -->'));
});

test('runImport source: codex / all combine sources project-scoped', () => {
  const claudeSrc = tmp('wk-src-');
  const codexSrc = tmp('wk-cdx-');
  const vault = tmp('wk-vault-');
  writeTranscript(claudeSrc, 'sid-claude', TRANSCRIPT);
  writeCodexTranscript(codexSrc, 'rollout-2026-05-10T10-00-00-cdx-alpha.jsonl', CODEX_TRANSCRIPT);

  const onlyCodex = runImport(vault, { source: 'codex', projectPath: CODEX_CWD, codexFrom: codexSrc });
  assert.equal(onlyCodex.imported, 1);
  assert.equal(readSessionRegistry(vault).sessions['cdx-alpha'].status, 'done');

  const all = runImport(vault, { source: 'all', projectPath: CODEX_CWD, from: claudeSrc, codexFrom: codexSrc });
  // Codex already imported -> skipped; the Claude one is new -> imported.
  assert.equal(all.imported, 1);
  assert.ok(readSessionRegistry(vault).sessions['sid-claude']);
});

test('runImport --limit and --dry-run', () => {
  const src = tmp('wk-src-');
  const vault = tmp('wk-vault-');
  writeTranscript(src, 'sid-a', TRANSCRIPT);
  writeTranscript(src, 'sid-b', TRANSCRIPT);

  const dry = runImport(vault, { source: 'claude', from: src, dryRun: true });
  assert.equal(dry.imported, 2);
  // dry-run writes nothing to the registry.
  assert.equal(Object.keys(readSessionRegistry(vault).sessions).length, 0);

  const limited = runImport(vault, { source: 'claude', from: src, limit: 1 });
  assert.equal(limited.imported, 1);
});
