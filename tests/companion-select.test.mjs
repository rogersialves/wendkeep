// Pure state machine behind the interactive companion checkbox selector.
// The raw-TTY glue is a thin shell over these; here we test the logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialCompanionMenu,
  reduceCompanionMenu,
  renderCompanionMenu,
  mapKey,
} from '../src/companion-select.mjs';
import { COMPANIONS } from '../src/taxonomy.mjs';

test('renderCompanionMenu: localized hint/header when labels passed; pt default', () => {
  const s = initialCompanionMenu(COMPANIONS);
  assert.match(renderCompanionMenu(s), /Espaço marca/, 'pt default');
  const en = renderCompanionMenu(s, { hint: 'Space toggles', header: 'Companions' });
  assert.match(en, /Space toggles/);
  assert.doesNotMatch(en, /Espaço/);
});

test('initialCompanionMenu: defaults are pre-checked, cursor at top', () => {
  const s = initialCompanionMenu(COMPANIONS);
  assert.equal(s.cursor, 0);
  const checked = s.items.filter((i) => i.checked).map((i) => i.id);
  assert.deepEqual(checked, ['context-mode', 'dotcontext']);
});

test('reduceCompanionMenu: up/down move the cursor and wrap', () => {
  const s0 = initialCompanionMenu(COMPANIONS);
  const n = s0.items.length;
  assert.equal(reduceCompanionMenu(s0, 'down').cursor, 1);
  assert.equal(reduceCompanionMenu(s0, 'up').cursor, n - 1); // wraps
});

test('reduceCompanionMenu: space toggles the item under the cursor', () => {
  let s = initialCompanionMenu(COMPANIONS);
  s = reduceCompanionMenu(s, 'space'); // toggle context-mode off
  assert.equal(s.items[0].checked, false);
  s = reduceCompanionMenu(s, 'down');
  s = reduceCompanionMenu(s, 'space'); // toggle item 1 on
  assert.equal(s.items[1].checked, true);
});

test('reduceCompanionMenu: all/none check or clear everything', () => {
  const s0 = initialCompanionMenu(COMPANIONS);
  assert.ok(reduceCompanionMenu(s0, 'all').items.every((i) => i.checked));
  assert.ok(reduceCompanionMenu(s0, 'none').items.every((i) => !i.checked));
});

test('reduceCompanionMenu: enter finishes with selected ids in registry order', () => {
  const done = reduceCompanionMenu(initialCompanionMenu(COMPANIONS), 'enter');
  assert.equal(done.done, true);
  assert.deepEqual(done.selected, ['context-mode', 'dotcontext']);
  const all = reduceCompanionMenu(reduceCompanionMenu(initialCompanionMenu(COMPANIONS), 'all'), 'enter');
  assert.deepEqual(all.selected, COMPANIONS.map((c) => c.id));
});

test('renderCompanionMenu: shows checkboxes, cursor and key hints', () => {
  const out = renderCompanionMenu(initialCompanionMenu(COMPANIONS));
  assert.match(out, /\[x\]/);
  assert.match(out, /\[ \]/);
  assert.match(out, /Espaço/);
  assert.match(out, /Enter/);
  assert.ok(out.split('\n').some((l) => l.startsWith('>')), 'cursor marker present');
});

test('mapKey: arrows, space, enter, a/n map to reducer actions', () => {
  assert.equal(mapKey(' ', { name: 'space' }), 'space');
  assert.equal(mapKey('', { name: 'up' }), 'up');
  assert.equal(mapKey('', { name: 'down' }), 'down');
  assert.equal(mapKey('', { name: 'return' }), 'enter');
  assert.equal(mapKey('a', { name: 'a' }), 'all');
  assert.equal(mapKey('n', { name: 'n' }), 'none');
  assert.equal(mapKey('z', { name: 'z' }), null);
});
