// mergeCodexHooks projects the shared hook specs into <project>/.codex/hooks.json.
// The Codex harness differs from Claude in three ways that silently break if got wrong:
// the timeout key is `timeoutSec`, there is no ${CLAUDE_PROJECT_DIR}, and only hooks whose
// payload shape is compatible may be wired at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeCodexHooks } from '../src/init.mjs';

const WIRED = [
  ['SessionStart', 'brain-inject'],
  ['SessionStart', 'session-start'],
  ['UserPromptSubmit', 'session-ensure'],
  ['UserPromptSubmit', 'change-context'],
  ['Stop', 'session-stop'],
  ['Stop', 'change-nag'],
  ['SubagentStop', 'subagent-stop'],
];

const OMITTED = ['change-guard', 'change-warn', 'plan-capture', 'decision-capture', 'task-log'];

const entriesOf = (file, ev) => (file.hooks[ev] || []).flatMap((g) => g.hooks || []);
const cmdsOf = (file, ev) => entriesOf(file, ev).map((h) => h.command);
const allEntries = (file) => Object.keys(file.hooks).flatMap((ev) => entriesOf(file, ev));
const groupFor = (file, ev, name) =>
  (file.hooks[ev] || []).find((g) => (g.hooks || []).some((h) => h.command.includes(name)));

// --- CODEX-1: os 7 hooks nos eventos certos, chaves PascalCase -----------------

test('mergeCodexHooks: wira os 7 hooks de sessão nos eventos do Codex', () => {
  const file = mergeCodexHooks(null, {});
  for (const [event, name] of WIRED) {
    assert.ok(cmdsOf(file, event).some((c) => c.includes(name)), `${name} em ${event}`);
  }
});

test('mergeCodexHooks: chaves de evento são PascalCase — snake_case parseia pra zero hooks', () => {
  const file = mergeCodexHooks(null, {});
  assert.deepEqual(
    Object.keys(file.hooks).sort(),
    ['SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit'],
  );
});

// --- CODEX-2: timeoutSec, nunca timeout ----------------------------------------

test('mergeCodexHooks: timeout vai em timeoutSec com o valor do spec', () => {
  const file = mergeCodexHooks(null, {});
  const brain = entriesOf(file, 'SessionStart').find((h) => h.command.includes('brain-inject'));
  assert.equal(brain.timeoutSec, 45);
  const stop = entriesOf(file, 'Stop').find((h) => h.command.includes('session-stop'));
  assert.equal(stop.timeoutSec, 60);
});

test('mergeCodexHooks: nunca emite a chave `timeout` (o Codex a ignora e usa 600s)', () => {
  const file = mergeCodexHooks(null, {});
  for (const h of allEntries(file)) {
    assert.ok(!('timeout' in h), `${h.command} não pode ter a chave timeout`);
    assert.equal(typeof h.timeoutSec, 'number', `${h.command} precisa de timeoutSec`);
  }
});

// --- CODEX-3: comando portátil, sem variável do Claude -------------------------

test('mergeCodexHooks: comando é sempre npx, mesmo com wendkeep instalado localmente', () => {
  const proj = mkdtempSync(join(tmpdir(), 'wk-codex-local-'));
  try {
    mkdirSync(join(proj, 'node_modules', 'wendkeep', 'hooks'), { recursive: true });
    for (const n of ['change-context', 'change-nag', 'brain-inject']) {
      writeFileSync(join(proj, 'node_modules', 'wendkeep', 'hooks', `${n}.mjs`), '// stub');
    }
    const file = mergeCodexHooks(null, { projectPath: proj });
    const ctx = entriesOf(file, 'UserPromptSubmit').find((h) => h.command.includes('change-context'));
    assert.equal(ctx.command, 'npx wendkeep hook change-context', 'preferLocal é ignorado no Codex');
    assert.equal(ctx.args, undefined, 'sem args — o Codex só lê a string do comando');
    for (const h of allEntries(file)) {
      assert.ok(!h.command.includes('CLAUDE_PROJECT_DIR'), `${h.command} vaza variável do Claude`);
      assert.equal(h.type, 'command');
    }
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

// --- CODEX-4: só hooks com payload compatível ---------------------------------

test('mergeCodexHooks: omite hooks de tool cujo payload não existe no Codex', () => {
  const file = mergeCodexHooks(null, {});
  const wire = JSON.stringify(file);
  for (const name of OMITTED) {
    assert.ok(!wire.includes(name), `${name} não pode ser wirado no Codex`);
  }
  assert.equal(file.hooks.PreToolUse, undefined, 'sem PreToolUse — tool_input incompatível');
  assert.equal(file.hooks.PostToolUse, undefined, 'sem PostToolUse — tool_input incompatível');
  assert.equal(file.hooks.TaskCompleted, undefined, 'TaskCompleted não existe no Codex');
});

// --- CODEX-5: matcher só onde o Codex o honra ---------------------------------

test('mergeCodexHooks: SessionStart preserva o matcher do spec verbatim', () => {
  const file = mergeCodexHooks(null, {});
  assert.equal(groupFor(file, 'SessionStart', 'brain-inject').matcher, 'startup|clear|compact');
  assert.equal(groupFor(file, 'SessionStart', 'session-start').matcher, 'startup');
});

test('mergeCodexHooks: UserPromptSubmit/Stop/SubagentStop não emitem matcher', () => {
  const file = mergeCodexHooks(null, {});
  for (const ev of ['UserPromptSubmit', 'Stop', 'SubagentStop']) {
    for (const g of file.hooks[ev]) {
      assert.ok(!('matcher' in g), `${ev} não deve carregar matcher`);
    }
  }
});

// --- CODEX-6: merge não-destrutivo -------------------------------------------

test('mergeCodexHooks: idempotente — re-init não duplica grupo', () => {
  const one = mergeCodexHooks(null, {});
  const two = mergeCodexHooks(one, {});
  for (const [event, name] of WIRED) {
    const groups = (two.hooks[event] || []).filter((g) => (g.hooks || []).some((h) => h.command.includes(name)));
    assert.equal(groups.length, 1, `${name} aparece uma vez só`);
  }
});

test('mergeCodexHooks: preserva hooks de terceiros já presentes', () => {
  const existing = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo alheio', timeoutSec: 5 }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo guard-do-usuario' }] }],
    },
  };
  const file = mergeCodexHooks(existing, {});
  assert.ok(cmdsOf(file, 'SessionStart').includes('echo alheio'), 'hook alheio sobrevive');
  assert.ok(cmdsOf(file, 'PreToolUse').includes('echo guard-do-usuario'), 'evento alheio sobrevive');
});

test('mergeCodexHooks: --force atualiza a entrada gerenciada in-place, sem duplicar', () => {
  const existing = {
    hooks: {
      Stop: [{ hooks: [
        { type: 'command', command: 'npx wendkeep hook session-stop', timeoutSec: 5 },
        { type: 'command', command: 'echo irmao-do-usuario' },
      ] }],
    },
  };
  const file = mergeCodexHooks(existing, { force: true });
  const groups = file.hooks.Stop.filter((g) => g.hooks.some((h) => h.command.includes('session-stop')));
  assert.equal(groups.length, 1, 'sem grupo duplicado');
  assert.equal(groups[0].hooks[0].timeoutSec, 60, 'force refresca o timeoutSec');
  assert.ok(groups[0].hooks.some((h) => h.command === 'echo irmao-do-usuario'), 'irmão agrupado intacto');
});

test('mergeCodexHooks: migra a chave legada `timeout` para `timeoutSec` sem duplicar', () => {
  const existing = {
    hooks: {
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'npx wendkeep hook session-start', timeout: 30 }] }],
    },
  };
  const file = mergeCodexHooks(existing, {});
  const groups = file.hooks.SessionStart.filter((g) => g.hooks.some((h) => h.command.includes('session-start')));
  assert.equal(groups.length, 1, 'grupo legado foi migrado, não duplicado');
  const hook = groups[0].hooks[0];
  assert.equal(hook.timeoutSec, 30, 'valor declarado preservado na chave certa');
  assert.ok(!('timeout' in hook), 'chave legada removida');
});
