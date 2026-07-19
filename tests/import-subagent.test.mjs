// A Codex subagent rollout (session_meta.source.subagent) is a sibling file of its parent's
// rollout. Import used to treat it as a top-level session: it created a ghost note with the
// parent's whole replayed context while the parent closed with subagents_count: 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCodexTranscripts, runImport } from '../hooks/import-sessions.mjs';
import { readSessionRegistry } from '../hooks/obsidian-common.mjs';

const CWD = 'C:\\proj\\subdemo';
const PARENT = '019f7764-7627-79a3-b609-65abaa36eedd';
const CHILD = '019f77a7-0c9b-76b3-8968-e49c51ae16a7';

const parentEvents = [
  { type: 'session_meta', timestamp: '2026-07-18T19:41:45.000Z', payload: { id: PARENT, timestamp: '2026-07-18T19:41:45.000Z', cwd: CWD, model: 'gpt-5', model_provider: 'openai' } },
  { type: 'event_msg', timestamp: '2026-07-18T19:42:01.000Z', payload: { type: 'task_started', turn_id: 'turn-1' } },
  { type: 'event_msg', timestamp: '2026-07-18T19:42:02.000Z', payload: { type: 'user_message', turn_id: 'turn-1', message: 'Analise os arquivos do projeto' } },
  { type: 'event_msg', timestamp: '2026-07-18T19:42:03.000Z', payload: { type: 'agent_message', turn_id: 'turn-1', message: 'Analisado.' } },
];

// The child replays the parent's turns — that is why the ghost note looked like a duplicate.
const childEvents = [
  { type: 'session_meta', timestamp: '2026-07-18T20:54:29.000Z', payload: { id: CHILD, session_id: PARENT, parent_thread_id: PARENT, forked_from_id: PARENT, timestamp: '2026-07-18T20:54:29.000Z', cwd: CWD, model: 'gpt-5', model_provider: 'openai', source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_nickname: 'Lovelace' } } } } },
  { type: 'event_msg', timestamp: '2026-07-18T20:54:30.000Z', payload: { type: 'task_started', turn_id: 'turn-sub-1' } },
  { type: 'event_msg', timestamp: '2026-07-18T20:54:31.000Z', payload: { type: 'user_message', turn_id: 'turn-sub-1', message: 'Mapeie o repositório' } },
  { type: 'event_msg', timestamp: '2026-07-18T20:54:32.000Z', payload: { type: 'agent_message', turn_id: 'turn-sub-1', message: 'Mapeado.' } },
];

function seedRollouts() {
  const src = mkdtempSync(join(tmpdir(), 'wk-sub-src-'));
  const day = join(src, '2026', '07', '18');
  mkdirSync(day, { recursive: true });
  const write = (name, events) => {
    const p = join(day, name);
    writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
    return p;
  };
  return {
    src,
    parentPath: write(`rollout-2026-07-18T19-41-45-${PARENT}.jsonl`, parentEvents),
    childPath: write(`rollout-2026-07-18T20-54-29-${CHILD}.jsonl`, childEvents),
  };
}

function walkNotes(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkNotes(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// --- IMPORT-4 ----------------------------------------------------------------

test('discoverCodexTranscripts expõe o marcador de subagent do session_meta', () => {
  const { src } = seedRollouts();
  const { transcripts } = discoverCodexTranscripts(CWD, src);
  const parent = transcripts.find((t) => t.sessionId === PARENT);
  const child = transcripts.find((t) => t.sessionId === CHILD);
  assert.ok(parent && child, 'os dois rollouts descobertos');
  assert.equal(parent.subagent, null, 'pai é top-level');
  assert.equal(child.subagent?.parentThreadId, PARENT);
  assert.equal(child.subagent?.nickname, 'Lovelace');
});

test('runImport: subagent nunca vira nota; só o pai produz sessão', () => {
  const { src } = seedRollouts();
  const vault = mkdtempSync(join(tmpdir(), 'wk-sub-vault-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });

  const r = runImport(vault, { source: 'codex', projectPath: CWD, codexFrom: src });
  assert.equal(r.imported, 1, 'só o pai');
  assert.equal(r.subagents, 1, 'subagent contado à parte');
  assert.equal(r.skipped, 0, 'subagent NÃO é skipped — skipped significa sessão coberta');

  const notes = walkNotes(join(vault, '02-Sessões'));
  assert.equal(notes.length, 1, 'uma nota só');
  const md = readFileSync(notes[0], 'utf8');
  assert.match(md, new RegExp(PARENT), 'a nota é a do pai');
  assert.ok(!md.includes(`session_id: "${CHILD}"`), 'nada do subagent como sessão');
  assert.equal(readSessionRegistry(vault).sessions[CHILD], undefined, 'subagent fora do registry');
});

test('runImport: remove a entrada de registry que o bug antigo escreveu pro subagent', () => {
  const { src, childPath } = seedRollouts();
  const vault = mkdtempSync(join(tmpdir(), 'wk-sub-heal-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  // Estado que o import 0.46.0 deixou: entrada top-level pro rollout do subagent.
  writeFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), JSON.stringify({
    version: 1,
    sessions: { [CHILD]: { session_file: '02-Sessões/2026/07-JUL/DIA 18/20-54-fantasma.md', status: 'done', provider: 'codex', transcript_path: childPath, transcript_id: CHILD } },
  }), 'utf-8');

  runImport(vault, { source: 'codex', projectPath: CWD, codexFrom: src });
  assert.equal(readSessionRegistry(vault).sessions[CHILD], undefined, 'entrada errada removida');
});

test('runImport: entrada com o mesmo id mas transcript DIFERENTE é preservada', () => {
  const { src } = seedRollouts();
  const vault = mkdtempSync(join(tmpdir(), 'wk-sub-keep-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  const foreign = { session_file: '02-Sessões/x.md', status: 'done', provider: 'codex', transcript_path: 'C:\\outro\\lugar\\rollout-outro.jsonl', transcript_id: CHILD };
  writeFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), JSON.stringify({ version: 1, sessions: { [CHILD]: foreign } }), 'utf-8');

  runImport(vault, { source: 'codex', projectPath: CWD, codexFrom: src });
  assert.deepEqual(readSessionRegistry(vault).sessions[CHILD], foreign, 'self-healing não vira limpeza genérica');
});
