// 0.28.0 — three new hooks: decision capture (PostToolUse/AskUserQuestion), subagent-stop
// (live telemetry), task-log (TaskCompleted plan progress).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAnswers, buildDecisionCaptureNote, captureDecision } from '../hooks/decision-capture.mjs';
import { taskText, appendProgress, logTask } from '../hooks/task-log.mjs';
import { writeControl } from '../hooks/obsidian-common.mjs';
import { mergeSettings } from '../src/init.mjs';
import { SESSION_HOOKS } from '../src/taxonomy.mjs';

function vaultWithSession() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-hooks-'));
  const rel = '02-Sessões/2026/07-JUL/DIA 09/10-00-demo.md';
  mkdirSync(join(vault, '02-Sessões', '2026', '07-JUL', 'DIA 09'), { recursive: true });
  writeFileSync(join(vault, rel), '---\ntype: session\n---\n\n# demo\n\n## Iterações\n\n## Encerramento\n\nEm andamento.\n');
  writeControl(vault, { status: 'active', session_file: rel, session_id: 's1' });
  return { vault, rel };
}

// --- decision capture -------------------------------------------------------
test('parseAnswers extracts the "Q"="answer" pairs', () => {
  const a = parseAnswers('Your questions have been answered: "What next?"="Option A,Option B"  "Scope?"="Just X"');
  assert.equal(a['What next?'], 'Option A,Option B');
  assert.equal(a['Scope?'], 'Just X');
});

test('buildDecisionCaptureNote lists every option and marks the chosen one', () => {
  const note = buildDecisionCaptureNote({
    questions: [{ question: 'What next?', multiSelect: true, options: [{ label: 'Option A', description: 'do A' }, { label: 'Option B', description: 'do B' }] }],
    answers: { 'What next?': 'Option A' },
    dateStr: '2026-07-09', startedAt: '2026-07-09T10:00:00', sessionRel: '02-Sessões/2026/07-JUL/DIA 09/10-00-demo.md',
    provider: { id: 'claude' }, localeId: 'pt-BR',
  });
  assert.match(note, /^type: decision/m);
  assert.match(note, /subtype: user-choice/);
  assert.match(note, /Option A.*do A/s);
  assert.match(note, /Option B.*do B/s);
  assert.match(note, /✅ \| Option A/);          // chosen marked
  assert.doesNotMatch(note, /✅ \| Option B/);   // not chosen
  assert.match(note, /\*\*Escolhido:\*\* `Option A`/);
  assert.match(note, /\[\[02-Sessões\/2026\/07-JUL\/DIA 09\/10-00-demo\]\]/); // session link
});

test('captureDecision writes a decision note to 04-Decisões', () => {
  const { vault } = vaultWithSession();
  try {
    const r = captureDecision(vault, {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Deploy agora?', options: [{ label: 'Sim', description: 'sobe' }, { label: 'Não', description: 'espera' }] }] },
      tool_output: 'Your questions have been answered: "Deploy agora?"="Sim"',
    });
    assert.ok(r && !r.skipped, 'note written');
    const path = join(vault, r.rel);
    assert.ok(existsSync(path));
    const c = readFileSync(path, 'utf8');
    assert.match(c, /Deploy agora\?/);
    assert.match(c, /✅ \| Sim/);
    // idempotent same day+question
    const again = captureDecision(vault, { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Deploy agora?', options: [] }] }, tool_output: '"Deploy agora?"="Sim"' });
    assert.ok(again.skipped, 'second capture same day is a no-op');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// --- task-log ---------------------------------------------------------------
test('taskText pulls the task text from varied payload shapes', () => {
  assert.equal(taskText({ task: { content: 'Implement X' } }), 'Implement X');
  assert.equal(taskText({ description: 'Fix Y' }), 'Fix Y');
  assert.equal(taskText({ tool_input: { title: 'Ship Z' } }), 'Ship Z');
  assert.equal(taskText({}), '');
});

test('appendProgress inserts before ## Encerramento and dedups', () => {
  const base = '# s\n\n## Iterações\n\n## Encerramento\n\nfim\n';
  const one = appendProgress(base, '- [x] 10:00 fez A', 'Progresso do plano');
  assert.match(one, /## Progresso do plano\n\n- \[x\] 10:00 fez A/);
  assert.ok(one.indexOf('Progresso do plano') < one.indexOf('## Encerramento'), 'before Encerramento');
  const two = appendProgress(one, '- [x] 10:00 fez A', 'Progresso do plano');
  assert.equal(two, one, 'dedup: same line not added twice');
  const three = appendProgress(one, '- [x] 10:05 fez B', 'Progresso do plano');
  assert.match(three, /fez A[\s\S]*fez B/);
});

test('logTask writes plan progress into the active session note', () => {
  const { vault, rel } = vaultWithSession();
  try {
    assert.ok(logTask(vault, { task: { content: 'Concluí a tela home' } }));
    const c = readFileSync(join(vault, rel), 'utf8');
    assert.match(c, /## Progresso do plano/);
    assert.match(c, /Concluí a tela home/);
    assert.ok(c.indexOf('Progresso do plano') < c.indexOf('## Encerramento'));
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// --- wiring -----------------------------------------------------------------
test('the 3 hooks are wired by mergeSettings on their events', () => {
  const cmds = (settings, ev) => (settings.hooks[ev] || []).flatMap((g) => (g.hooks || []).map((h) => h.command));
  const { settings } = mergeSettings(null, { vaultPath: '/v', withMcp: false, companions: [] });
  assert.ok(cmds(settings, 'PostToolUse').includes('npx wendkeep hook decision-capture'));
  assert.ok(cmds(settings, 'SubagentStop').includes('npx wendkeep hook subagent-stop'));
  assert.ok(cmds(settings, 'TaskCompleted').includes('npx wendkeep hook task-log'));
  // decision-capture is scoped to the AskUserQuestion tool
  const g = (settings.hooks.PostToolUse || []).find((x) => (x.hooks || []).some((h) => h.command.includes('decision-capture')));
  assert.equal(g.matcher, 'AskUserQuestion');
  // and it's in the canonical SESSION_HOOKS list
  assert.ok(SESSION_HOOKS.some((h) => h.name === 'decision-capture' && h.event === 'PostToolUse'));
});
