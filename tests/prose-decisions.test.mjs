// 0.29.0 — agnostic prose-decision capture: Codex (and any agent without an AskUserQuestion-style
// tool) asks in prose. Conservative pattern: assistant message with >=2 enumerated options ending
// in a question + a SHORT user answer -> the same decision note the Claude hook writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractProseDecisions, captureProseDecisions } from '../hooks/decision-capture.mjs';
import { createLinkedNotes } from '../hooks/linked-notes.mjs';
import { importSession, rescanDecisions } from '../hooks/import-sessions.mjs';

function turnWith(conv) { return { turnId: 't', timestamp: '', userPrompts: [], assistantMessages: [], tools: [], consultedFiles: [], changedFiles: [], conversation: conv, usage: {} }; }

const QUESTION = `Duas rotas possíveis:

1) Painel HTML local — replica o dashboard do terminal.
2) Runner Scalp operacional — dashboard 5m/15m com PnL.

Minha recomendação é a 2. Qual você prefere?`;

test('extractProseDecisions: options + trailing question + short answer', () => {
  const tx = { turns: [
    turnWith([{ role: 'Assistente', text: QUESTION }]),
    turnWith([{ role: 'Usuário', text: 'as duas' }, { role: 'Assistente', text: 'fechado.' }]),
  ] };
  const d = extractProseDecisions(tx);
  assert.equal(d.length, 1);
  assert.match(d[0].question, /Qual você prefere\?/);
  assert.equal(d[0].options.length, 2);
  assert.match(d[0].options[0], /Painel HTML local/);
  assert.equal(d[0].answer, 'as duas');
});

test('extractProseDecisions: conservative — rejects non-decisions', () => {
  const long = 'x'.repeat(300);
  const cases = [
    // no options
    [{ role: 'Assistente', text: 'Tudo pronto. Posso seguir?' }, { role: 'Usuário', text: 'sim' }],
    // options but no question
    [{ role: 'Assistente', text: '1) A\n2) B\nVou seguir com a 1.' }, { role: 'Usuário', text: 'ok' }],
    // long answer = new instruction, not a choice
    [{ role: 'Assistente', text: '1) A\n2) B\nQual prefere?' }, { role: 'Usuário', text: long }],
  ];
  for (const conv of cases) {
    const tx = { turns: [turnWith([conv[0]]), turnWith([conv[1]])] };
    assert.equal(extractProseDecisions(tx).length, 0, JSON.stringify(conv[0].text.slice(0, 30)));
  }
});

test('captureProseDecisions writes the decision note; createLinkedNotes links it', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-prose-'));
  try {
    const tx = { provider: 'codex', turns: [
      turnWith([{ role: 'Assistente', text: QUESTION }]),
      turnWith([{ role: 'Usuário', text: 'as duas' }]),
    ] };
    const linked = createLinkedNotes(vault, '2026-07-09', '02-Sessões/2026/07-JUL/DIA 09/09-00-s.md', tx, { provider: 'codex' });
    assert.equal(linked.decisions.length, 1, 'prose decision linked');
    const note = readFileSync(join(vault, linked.decisions[0]), 'utf8');
    assert.match(note, /^type: decision/m);
    assert.match(note, /subtype: user-choice/);
    assert.match(note, /provider: codex/);
    assert.match(note, /Painel HTML local/);
    assert.match(note, /Runner Scalp operacional/);
    assert.match(note, /\*\*Escolhido:\*\* `as duas`/);
    // idempotent
    const again = createLinkedNotes(vault, '2026-07-09', '02-Sessões/2026/07-JUL/DIA 09/09-00-s.md', tx, { provider: 'codex' });
    assert.equal(again.decisions.length, 0, 'no duplicate on re-run');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('import of a Codex rollout with a prose Q&A captures the decision', async () => {
  const src = mkdtempSync(join(tmpdir(), 'wk-cdx-prose-'));
  const vault = mkdtempSync(join(tmpdir(), 'wk-vault-prose-'));
  try {
    const day = join(src, '2026', '07', '01');
    mkdirSync(day, { recursive: true });
    const ev = [
      { type: 'session_meta', timestamp: '2026-07-01T10:00:00Z', payload: { id: 'cdx-d1', cwd: 'C:\\p', model: 'gpt-5.5' } },
      { type: 'event_msg', timestamp: '2026-07-01T10:00:01Z', payload: { type: 'task_started', turn_id: 'a' } },
      { type: 'event_msg', timestamp: '2026-07-01T10:00:02Z', payload: { type: 'user_message', turn_id: 'a', message: 'monta o painel' } },
      { type: 'event_msg', timestamp: '2026-07-01T10:00:03Z', payload: { type: 'agent_message', turn_id: 'a', message: QUESTION } },
      { type: 'event_msg', timestamp: '2026-07-01T10:05:00Z', payload: { type: 'task_started', turn_id: 'b' } },
      { type: 'event_msg', timestamp: '2026-07-01T10:05:01Z', payload: { type: 'user_message', turn_id: 'b', message: 'as duas' } },
      { type: 'event_msg', timestamp: '2026-07-01T10:05:02Z', payload: { type: 'agent_message', turn_id: 'b', message: 'fechado.' } },
    ];
    writeFileSync(join(day, 'rollout-2026-07-01T10-00-00-cdx-d1.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = importSession(vault, join(day, 'rollout-2026-07-01T10-00-00-cdx-d1.jsonl'));
    assert.ok(r, 'imported');
    // decision note exists under 04-Decisões
    const found = [];
    (function walk(d) { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/^ADR-\d+-/.test(e.name)) found.push(p); } })(join(vault, '04-Decisões'));
    assert.equal(found.length, 1, 'prose decision note created by import');
    assert.match(readFileSync(found[0], 'utf8'), /`as duas`/);

    // --- rescan-decisions: recovers decisions for sessions imported BEFORE 0.29 ---
    // True pre-0.29 state: the registry knows the transcript, but no decision note was ever
    // written. Simulated with a FRESH vault + a hand-written registry entry (no deletion — file
    // deletion is unreliable in this sandbox).
    const { upsertSessionRegistry } = await import('../hooks/obsidian-common.mjs');
    const vaultB = mkdtempSync(join(tmpdir(), 'wk-rescan-'));
    try {
      upsertSessionRegistry(vaultB, 'cdx-d1', {
        session_file: '02-Sessões/2026/07-JUL/DIA 01/07-00-s.md', status: 'done',
        started_at: '2026-07-01T10:00:01', transcript_path: join(day, 'rollout-2026-07-01T10-00-00-cdx-d1.jsonl'),
      });
      const r1 = rescanDecisions(vaultB);
      assert.equal(r1.scanned, 1);
      assert.equal(r1.decisions, 1, 'rescan captured the never-captured decision');
      const r2 = rescanDecisions(vaultB);
      assert.equal(r2.decisions, 0, 'rescan is idempotent (note now exists)');
    } finally { rmSync(vaultB, { recursive: true, force: true }); }
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(vault, { recursive: true, force: true }); }
});
