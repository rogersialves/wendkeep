// Codex subagent telemetry: the discovery used to be Claude-shaped only (a `subagents/`
// directory beside the transcript), so Codex sessions closed with subagents_count: 0 both
// live (SubagentStop hook) and on import. Codex subagents are SIBLING rollouts linked by
// parent_thread_id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectCodexSubagentUsage } from '../hooks/subagent-usage.mjs';
import { updateSessionObservability } from '../hooks/session-observability.mjs';

const PARENT = '019f7764-7627-79a3-b609-65abaa36eedd';
const CHILD = '019f77a7-0c9b-76b3-8968-e49c51ae16a7';

const meta = (id, extra = {}) => ({ type: 'session_meta', timestamp: '2026-07-18T19:41:45.000Z', payload: { id, timestamp: '2026-07-18T19:41:45.000Z', cwd: 'C:\\proj\\x', model: 'gpt-5', model_provider: 'openai', ...extra } });
const subagentMeta = (id, parent, nickname = 'Lovelace') => meta(id, { session_id: parent, parent_thread_id: parent, source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_nickname: nickname } } } });
const usageEvent = (turn, tokens) => ({ type: 'event_msg', timestamp: '2026-07-18T20:55:00.000Z', payload: { type: 'token_count', turn_id: turn, info: { model: 'gpt-5', last_token_usage: { input_tokens: tokens, output_tokens: 100 } } } });
const turnEvents = (turn) => [
  { type: 'event_msg', timestamp: '2026-07-18T20:54:30.000Z', payload: { type: 'task_started', turn_id: turn } },
  { type: 'event_msg', timestamp: '2026-07-18T20:54:31.000Z', payload: { type: 'user_message', turn_id: turn, message: 'faz' } },
  { type: 'event_msg', timestamp: '2026-07-18T20:54:32.000Z', payload: { type: 'agent_message', turn_id: turn, message: 'feito' } },
];

function writeRollout(dayDir, name, events) {
  mkdirSync(dayDir, { recursive: true });
  const p = join(dayDir, name);
  writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  return p;
}

function seed({ childDay = '18', parentId = PARENT } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wk-cxsub-'));
  const parentPath = writeRollout(join(root, '2026', '07', '18'), `rollout-2026-07-18T19-41-45-${PARENT}.jsonl`,
    [meta(PARENT), ...turnEvents('turn-1'), usageEvent('turn-1', 500)]);
  writeRollout(join(root, '2026', '07', childDay), `rollout-2026-07-${childDay}T20-54-29-${CHILD}.jsonl`,
    [subagentMeta(CHILD, parentId), ...turnEvents('turn-sub'), usageEvent('turn-sub', 7000)]);
  return { root, parentPath };
}

// --- OBS-3 -------------------------------------------------------------------

test('collectCodexSubagentUsage: acha o irmão pelo parent_thread_id e soma o usage', () => {
  const { parentPath } = seed();
  const out = collectCodexSubagentUsage(parentPath);
  assert.ok(out, 'descoberta devolve agregado');
  assert.equal(out.aggregate.count, 1);
  assert.ok(out.aggregate.tokens >= 7000, `tokens do subagent somados, veio ${out.aggregate.tokens}`);
  assert.equal(out.subagents[0].agentType, 'Lovelace', 'nickname vira agentType');
});

test('collectCodexSubagentUsage: irmão de OUTRO pai não é somado', () => {
  const { parentPath } = seed({ parentId: '01900000-0000-7000-8000-000000000000' });
  assert.equal(collectCodexSubagentUsage(parentPath), null);
});

test('collectCodexSubagentUsage: subagent na pasta do dia seguinte é descoberto', () => {
  const { parentPath } = seed({ childDay: '19' });
  const out = collectCodexSubagentUsage(parentPath);
  assert.equal(out?.aggregate.count, 1, 'spawn cruzando a meia-noite UTC não some');
});

test('collectCodexSubagentUsage: transcript Claude devolve null — caminho Claude intacto', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-cxsub-claude-'));
  const p = join(dir, 'sid-claude.jsonl');
  writeFileSync(p, JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'sid-claude', message: { role: 'user', content: 'oi' } }) + '\n', 'utf-8');
  assert.equal(collectCodexSubagentUsage(p), null);
});

test('updateSessionObservability: a nota da mãe fecha com subagents_count e tokens do filho', () => {
  const { parentPath } = seed();
  const vault = mkdtempSync(join(tmpdir(), 'wk-cxsub-note-'));
  const notePath = join(vault, 'sessao.md');
  writeFileSync(notePath, ['---', 'type: session', `session_id: "${PARENT}"`, 'provider: codex', '---', '', '# sessão', '', '## Iterações', '', '## Pendências', '', 'Nenhuma.', ''].join('\n'), 'utf-8');

  updateSessionObservability({ sessionPath: notePath, transcriptPath: parentPath });

  const md = readFileSync(notePath, 'utf8');
  assert.match(md, /^subagents_count: 1$/m, 'o filho conta no frontmatter da mãe');
  const total = Number((md.match(/^subagents_tokens_total: (\d+)$/m) || [])[1] || 0);
  assert.ok(total >= 7000, `tokens do subagent no frontmatter, veio ${total}`);
  assert.match(md, /Lovelace/, 'a tabela de subagents nomeia o agente');
});
