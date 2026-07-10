import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VAULT_FOLDERS, HOOK_FILES } from '../src/taxonomy.mjs';

test('taxonomy: change/spec folders + change-core lib registered', () => {
  assert.ok(VAULT_FOLDERS.includes('07-Specs'));
  assert.ok(VAULT_FOLDERS.includes('08-Mudanças'));
  assert.ok(HOOK_FILES.includes('change-core.mjs'));
  assert.ok(HOOK_FILES.includes('sensors-core.mjs'));
});

test('parseTasks: extracts [sensor:id] hint, strips it from text', () => {
  const t = parseTasks('- [ ] 1.1 wire toggle [sensor:tests]\n- [ ] 1.2 plain\n');
  assert.equal(t[0].sensor, 'tests');
  assert.equal(t[0].text, 'wire toggle');
  assert.equal(t[1].sensor, undefined);
});

test('parseTasks: extracts [req:ID] alongside [sensor:]', () => {
  const t = parseTasks('- [ ] 3.2 faz [req:GATE-1] [sensor:tests]\n');
  assert.equal(t[0].req, 'GATE-1');
  assert.equal(t[0].sensor, 'tests');
  assert.equal(t[0].text, 'faz');
});

import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderChangeScaffold,
  newChange,
  activeChange,
  parseTasks,
  listChanges,
  buildActiveChangeInjection,
  archiveChange,
  activeChangeLink,
  appendFixTasks,
  setTaskDone,
} from '../hooks/change-core.mjs';

test('setTaskDone: toggles the exact task id; false when id missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-done-'));
  try {
    writeFileSync(join(dir, 'tarefas.md'), '- [ ] 1.1 faz algo\n- [ ] 1.10 outra\n');
    assert.equal(setTaskDone(dir, '1.1', true), true);
    const md = readFileSync(join(dir, 'tarefas.md'), 'utf8');
    assert.match(md, /- \[x\] 1\.1 faz algo/);
    assert.match(md, /- \[ \] 1\.10 outra/, '1.10 untouched (anchored id)');
    assert.equal(setTaskDone(dir, '1.1', false), true, 'undone');
    assert.match(readFileSync(join(dir, 'tarefas.md'), 'utf8'), /- \[ \] 1\.1 faz algo/);
    assert.equal(setTaskDone(dir, '9.9', true), false, 'missing id');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendFixTasks: appends numbered fix tasks, dedups by file:line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-fix-'));
  try {
    writeFileSync(join(dir, 'tarefas.md'), '- [ ] 1.1 base\n');
    assert.equal(appendFixTasks(dir, [{ file: 'a.js', line: 3, mutator: 'M' }, { file: 'b.js', line: 5, mutator: 'N' }], 'mut'), 2);
    const md = readFileSync(join(dir, 'tarefas.md'), 'utf8');
    assert.match(md, /- \[ \] M\.1 mata mutante a\.js:3 \(M\) \[sensor:mut\]/);
    assert.match(md, /M\.2 mata mutante b\.js:5/);
    assert.equal(appendFixTasks(dir, [{ file: 'a.js', line: 3, mutator: 'M' }, { file: 'c.js', line: 9, mutator: 'O' }], 'mut'), 1);
    assert.match(readFileSync(join(dir, 'tarefas.md'), 'utf8'), /M\.3 mata mutante c\.js:9/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('newChange --simple: only proposta + tarefas, no design/specs (auto-sizing)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-simple-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  try {
    newChange(vault, 's', { dateStr: '2026-07-05', simple: true });
    const dir = join(vault, '08-Mudanças', 's');
    assert.ok(existsSync(join(dir, 'proposta.md')));
    assert.ok(existsSync(join(dir, 'tarefas.md')));
    assert.ok(!existsSync(join(dir, 'design.md')), 'no design.md');
    assert.ok(!existsSync(join(dir, 'specs')), 'no specs scaffold');
    const proposta = readFileSync(join(dir, 'proposta.md'), 'utf8');
    assert.match(proposta, /spec_impact: none/);
    assert.match(proposta, /spec_impact_reason: ".+"/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('renderChangeScaffold: frontmatter + session wikilink + task line', () => {
  const { proposta, design, tarefas, specDelta } = renderChangeScaffold({
    slug: 'dark-mode', sessionRel: '02-Sessões/2026/07-JUL/DIA 05/10-00-x', dateStr: '2026-07-05',
  });
  assert.match(specDelta, /ADDED Requirements/);
  assert.match(proposta, /type: change/);
  assert.match(proposta, /status: active/);
  assert.match(proposta, /topic-change/);
  assert.match(proposta, /spec_impact: pending/);
  assert.match(proposta, /\[\[02-Sessões\/2026\/07-JUL\/DIA 05\/10-00-x\]\]/);
  assert.match(design, /# dark-mode/);
  assert.match(tarefas, /- \[ \] 1\.1/);
});

test('newChange: creates the 3 files + active pointer, non-destructive', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-chg-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  try {
    const r = newChange(vault, 'dark-mode', { sessionRel: '02-Sessões/x', dateStr: '2026-07-05' });
    assert.equal(r.created, true);
    for (const f of ['proposta.md', 'design.md', 'tarefas.md']) {
      assert.ok(existsSync(join(vault, '08-Mudanças', 'dark-mode', f)), `${f} created`);
    }
    assert.equal(activeChange(vault), 'dark-mode');
    assert.ok(existsSync(join(vault, '08-Mudanças', 'dark-mode', '.spec-impact-v1')));
    const again = newChange(vault, 'dark-mode', { sessionRel: '02-Sessões/x', dateStr: '2026-07-05' });
    assert.equal(again.created, false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('parseTasks: numbered checklist with done state', () => {
  const md = '# t\n\n- [ ] 1.1 do thing\n- [x] 1.2 done thing\nnot a task\n';
  const t = parseTasks(md);
  assert.equal(t.length, 2);
  assert.deepEqual(t[0], { id: '1.1', text: 'do thing', done: false });
  assert.equal(t[1].done, true);
});

test('listChanges: separates active dirs from _arquivo', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-list-'));
  try {
    mkdirSync(join(vault, '08-Mudanças', 'a'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'a', 'proposta.md'), 'x');
    mkdirSync(join(vault, '08-Mudanças', '_arquivo', '2026-07-05-b'), { recursive: true });
    const l = listChanges(vault);
    assert.deepEqual(l.active, ['a']);
    assert.deepEqual(l.archived, ['2026-07-05-b']);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('buildActiveChangeInjection: block with open tasks when active; empty otherwise', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-inj-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', 'dark-mode'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'dark-mode', 'tarefas.md'), '- [x] 1.1 done\n- [ ] 1.2 open one\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: dark-mode\n');
    const out = buildActiveChangeInjection(vault);
    assert.match(out, /<active_change>/);
    assert.match(out, /dark-mode/);
    assert.match(out, /1\.2 open one/);
    assert.doesNotMatch(out, /1\.1 done/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
  const empty = mkdtempSync(join(tmpdir(), 'wk-noinj-'));
  try { assert.equal(buildActiveChangeInjection(empty), ''); }
  finally { rmSync(empty, { recursive: true, force: true }); }
});

test('archiveChange: moves to _arquivo, mints ADR, clears active (gate ok); gate red blocks', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-arch-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    mkdirSync(join(vault, '08-Mudanças', 'dark-mode'), { recursive: true });
    const sessionRel = '02-Sessões/2026/07-JUL/DIA 05/sessao.md';
    mkdirSync(join(vault, '02-Sessões', '2026', '07-JUL', 'DIA 05'), { recursive: true });
    writeFileSync(join(vault, sessionRel), '# Sessão\n\n## Mudanças\n\n- [[08-Mudanças/dark-mode/proposta]]\n');
    writeFileSync(join(vault, '08-Mudanças', 'dark-mode', 'proposta.md'), `---\ntype: change\nsource:\n  - "[[${sessionRel.replaceAll('\\\\', '/').replace(/\.md$/, '')}]]"\n---\n# dark-mode\n`);
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: dark-mode\n');
    const r = archiveChange(vault, 'dark-mode', { dateStr: '2026-07-05', adrNum: 20 });
    assert.equal(r.ok, true);
    assert.ok(existsSync(join(vault, '08-Mudanças', '_arquivo', '2026-07-05-dark-mode', 'proposta.md')));
    assert.ok(!existsSync(join(vault, '08-Mudanças', 'dark-mode')), 'original moved');
    assert.match(readFileSync(join(vault, r.adrRel), 'utf8'), /dark-mode/);
    const session = readFileSync(join(vault, sessionRel), 'utf8');
    assert.match(session, /08-Mudanças\/_arquivo\/2026-07-05-dark-mode\/proposta/);
    assert.doesNotMatch(session, /\[\[08-Mudanças\/dark-mode\/proposta\]\]/);
    assert.equal(activeChange(vault), '');

    mkdirSync(join(vault, '08-Mudanças', 'x'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), '# x\n');
    const red = archiveChange(vault, 'x', { dateStr: '2026-07-05', adrNum: 1, gate: () => ({ ok: false, failing: ['tests'] }) });
    assert.equal(red.ok, false);
    assert.ok(existsSync(join(vault, '08-Mudanças', 'x')), 'not moved when gate red');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('activeChangeLink: wikilink to active change proposta, empty when none', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-link-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    assert.equal(activeChangeLink(vault), '');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: dark-mode\n');
    assert.match(activeChangeLink(vault), /\[\[08-Mudanças\/dark-mode\/proposta\]\]/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
