import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeProjectSlug,
  discoverTranscripts,
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

  const first = runImport(vault, { from: src });
  assert.equal(first.scanned, 1);
  assert.equal(first.imported, 1);
  assert.equal(first.skipped, 0);

  // Second run: already in the registry -> skipped, nothing new written.
  const second = runImport(vault, { from: src });
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 1);
});

test('runImport --limit and --dry-run', () => {
  const src = tmp('wk-src-');
  const vault = tmp('wk-vault-');
  writeTranscript(src, 'sid-a', TRANSCRIPT);
  writeTranscript(src, 'sid-b', TRANSCRIPT);

  const dry = runImport(vault, { from: src, dryRun: true });
  assert.equal(dry.imported, 2);
  // dry-run writes nothing to the registry.
  assert.equal(Object.keys(readSessionRegistry(vault).sessions).length, 0);

  const limited = runImport(vault, { from: src, limit: 1 });
  assert.equal(limited.imported, 1);
});
