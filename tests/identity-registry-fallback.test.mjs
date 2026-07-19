// The registry already maps session_id -> transcript_path, but the lookup sat BELOW the
// transcript gate in resolveSessionIdentity — unreachable exactly when the payload arrives
// without a transcript_path, which is the case it would have solved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionIdentity } from '../hooks/session-identity.mjs';

const SID = '019f7764-7627-79a3-b609-65abaa36eedd';
const TX = join(tmpdir(), 'wk-fallback-rollout.jsonl');

function vaultWith(sessions) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-ident-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  writeFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), JSON.stringify({ version: 1, sessions }), 'utf-8');
  return vault;
}

const codexEntry = {
  session_file: '02-Sessões/2026/07-JUL/DIA 18/19-42-sessao.md',
  status: 'active',
  provider: 'codex',
  transcript_path: TX,
  transcript_id: SID,
};

// --- CODEX-10 ----------------------------------------------------------------

test('resolveSessionIdentity: resolve pelo registry quando o payload não traz transcript_path', () => {
  const vault = vaultWith({ [SID]: codexEntry });
  const r = resolveSessionIdentity(vault, { session_id: SID, hook_event_name: 'Stop' }, 'codex');
  assert.equal(r.state, 'resolved', `esperava resolved, veio ${r.state}: ${r.diagnostics?.join('; ')}`);
  assert.equal(r.canonicalConversationId, SID);
  assert.equal(r.transcriptPath, TX, 'o transcript vem da entrada do registry');
});

test('resolveSessionIdentity: session_id fora do registry continua deferred', () => {
  const vault = vaultWith({ [SID]: codexEntry });
  const r = resolveSessionIdentity(vault, { session_id: 'id-que-nunca-existiu' }, 'codex');
  assert.equal(r.state, 'deferred', 'não pode inventar identidade');
});

test('resolveSessionIdentity: entrada de outro provider não serve de fallback', () => {
  // Invariante do incidente 2026-07-11 (contaminação cross-provider).
  const vault = vaultWith({ [SID]: { ...codexEntry, provider: 'claude' } });
  const r = resolveSessionIdentity(vault, { session_id: SID }, 'codex');
  assert.equal(r.state, 'deferred');
});

test('resolveSessionIdentity: entrada sem transcript_path não resolve', () => {
  const vault = vaultWith({ [SID]: { ...codexEntry, transcript_path: '' } });
  const r = resolveSessionIdentity(vault, { session_id: SID }, 'codex');
  assert.equal(r.state, 'deferred');
});

test('resolveSessionIdentity: sem session_id nenhum, segue deferred', () => {
  const vault = vaultWith({ [SID]: codexEntry });
  assert.equal(resolveSessionIdentity(vault, {}, 'codex').state, 'deferred');
});
