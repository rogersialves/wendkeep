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
} from '../hooks/change-core.mjs';

test('renderChangeScaffold: frontmatter + session wikilink + task line', () => {
  const { proposta, design, tarefas, specDelta } = renderChangeScaffold({
    slug: 'dark-mode', sessionRel: '02-Sessões/2026/07-JUL/DIA 05/10-00-x', dateStr: '2026-07-05',
  });
  assert.match(specDelta, /ADDED Requirements/);
  assert.match(proposta, /type: change/);
  assert.match(proposta, /status: active/);
  assert.match(proposta, /topic-change/);
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
    writeFileSync(join(vault, '08-Mudanças', 'dark-mode', 'proposta.md'), '---\ntype: change\n---\n# dark-mode\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: dark-mode\n');
    const r = archiveChange(vault, 'dark-mode', { dateStr: '2026-07-05', adrNum: 20 });
    assert.equal(r.ok, true);
    assert.ok(existsSync(join(vault, '08-Mudanças', '_arquivo', '2026-07-05-dark-mode', 'proposta.md')));
    assert.ok(!existsSync(join(vault, '08-Mudanças', 'dark-mode')), 'original moved');
    assert.match(readFileSync(join(vault, r.adrRel), 'utf8'), /dark-mode/);
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
