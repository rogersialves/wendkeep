// End-to-end for the Vendiva incident: Codex truncates the Stop payload (openai/codex#23784)
// so the session note stays empty while the registry says it exists; `import` then refuses to
// touch it; and whatever it does import gets titled with the injected plugin catalogue.
// This drives the whole chain on a Codex-shaped transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImport } from '../hooks/import-sessions.mjs';

const CWD = 'C:\\proj\\vendiva';
const SID = '019f7764-7627-79a3-b609-65abaa36eedd';
const INJECTED = '<recommended_plugins> Here is a list of plugins that are available but not '
  + 'installed. - Box (box@openai-curated-remote) - Figma (figma@openai-curated-remote)';
const REAL = 'Analise os arquivos nas pastas docs e design e vamos planejar o desenvolvimento';

// Turn 1 carries the injected block FIRST and the user's request LAST — the real ordering,
// verified against the Vendiva rollout.
const TRANSCRIPT = [
  { type: 'session_meta', timestamp: '2026-07-18T19:42:00.000Z', payload: { id: SID, timestamp: '2026-07-18T19:42:00.000Z', cwd: CWD, model: 'gpt-5.6-sol', model_provider: 'openai' } },
  { type: 'event_msg', timestamp: '2026-07-18T19:42:01.000Z', payload: { type: 'task_started', turn_id: 'turn-1' } },
  { type: 'event_msg', timestamp: '2026-07-18T19:42:02.000Z', payload: { type: 'user_message', turn_id: 'turn-1', message: INJECTED } },
  { type: 'event_msg', timestamp: '2026-07-18T19:42:03.000Z', payload: { type: 'user_message', turn_id: 'turn-1', message: REAL } },
  { type: 'event_msg', timestamp: '2026-07-18T19:42:04.000Z', payload: { type: 'agent_message', turn_id: 'turn-1', message: 'Analisei os arquivos e a configuração está correta.' } },
  { type: 'event_msg', timestamp: '2026-07-18T19:45:00.000Z', payload: { type: 'task_started', turn_id: 'turn-2' } },
  { type: 'event_msg', timestamp: '2026-07-18T19:45:01.000Z', payload: { type: 'user_message', turn_id: 'turn-2', message: 'Opção C, modo Completo APP e WEB' } },
  { type: 'event_msg', timestamp: '2026-07-18T19:45:02.000Z', payload: { type: 'agent_message', turn_id: 'turn-2', message: 'Seguindo com a opção C.' } },
];

const turnMarkers = (md) => (md.match(/<!-- wk-turn: /g) || []).length;

function walkNotes(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkNotes(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// A vault in exactly the damaged state: session-start wrote the note + registry entry, the
// Stop hook never landed a single turn.
function damagedVault(txPath) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-e2e-vault-'));
  const rel = '02-Sessões/2026/07-JUL/DIA 18/19-42-session.md';
  const abs = join(vault, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  mkdirSync(join(vault, '.brain'), { recursive: true });
  writeFileSync(abs, [
    '---', 'type: session', `session_id: "${SID}"`, 'provider: codex', 'status: active',
    'summary: "session"', 'source: codex-hook', '---', '',
    '# 19:42 - session', '', '## Iterações', '', '### 19:42 - Início da sessão', '',
    'Sessão iniciada automaticamente pelo hook de início (Codex).', '',
    '## Decisões geradas nesta sessão', '', 'Nenhuma decisão registrada ainda.', '',
  ].join('\n'), 'utf-8');
  writeFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), JSON.stringify({
    version: 1,
    sessions: { [SID]: { session_file: rel, status: 'active', provider: 'codex', transcript_path: txPath, transcript_id: SID } },
  }), 'utf-8');
  return { vault, note: abs };
}

function seed() {
  const src = mkdtempSync(join(tmpdir(), 'wk-e2e-src-'));
  const day = join(src, '2026', '07', '18');
  mkdirSync(day, { recursive: true });
  const txPath = join(day, `rollout-2026-07-18T19-41-45-${SID}.jsonl`);
  writeFileSync(txPath, TRANSCRIPT.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  return { src, txPath, ...damagedVault(txPath) };
}

test('recuperação e2e: sessão registrada e vazia recebe os turnos que o Stop perdeu', () => {
  const { src, vault, note } = seed();
  assert.equal(turnMarkers(readFileSync(note, 'utf8')), 0, 'pré-condição: nota vazia');

  const r = runImport(vault, { source: 'codex', projectPath: CWD, codexFrom: src });

  assert.equal(r.repaired, 1, 'a sessão danificada foi completada, não pulada');
  assert.equal(r.skipped, 0);
  const md = readFileSync(note, 'utf8');
  assert.equal(turnMarkers(md), 2, 'os dois turnos entraram');
  assert.ok(md.includes(REAL), 'o pedido real está na nota');
  assert.ok(md.includes('Opção C'), 'o segundo turno também');
  assert.equal(walkNotes(join(vault, '02-Sessões')).length, 1, 'reparou a nota existente, sem criar outra');
});

test('recuperação e2e: sessão nova nasce com título limpo, sem o bloco injetado', () => {
  const { src, txPath } = seed();
  // Vault sem registro nenhum: o import cria a nota do zero e escolhe o título.
  const vault = mkdtempSync(join(tmpdir(), 'wk-e2e-fresh-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  void txPath;

  const r = runImport(vault, { source: 'codex', projectPath: CWD, codexFrom: src });
  assert.equal(r.imported, 1);

  const [notePath] = walkNotes(join(vault, '02-Sessões'));
  assert.ok(!/recommended-plugins/i.test(notePath), `nome do arquivo poluído: ${notePath}`);
  const md = readFileSync(notePath, 'utf8');
  const summary = (md.match(/^summary: "?(.*?)"?$/m) || [])[1] || '';
  assert.ok(summary.includes('Analise os arquivos'), `summary errado: ${summary}`);
  assert.ok(!/recommended_plugins/i.test(summary), 'bloco do harness não pode titular a sessão');
});

test('recuperação e2e: rodar o import de novo não altera nada', () => {
  const { src, vault, note } = seed();
  runImport(vault, { source: 'codex', projectPath: CWD, codexFrom: src });
  const afterRepair = readFileSync(note, 'utf8');

  const second = runImport(vault, { source: 'codex', projectPath: CWD, codexFrom: src });
  assert.equal(second.repaired, 0);
  assert.equal(second.skipped, 1, 'agora está completa');
  assert.equal(readFileSync(note, 'utf8'), afterRepair, 'nota intocada');
});
