// Derived notes (decisions/bugs/learnings) are filed by YEAR/MONTH, not by day.
// Sessions keep their day-level folder — verified here for contrast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  monthFolderRelFromDateStr,
  datedFolderRelFromDateStr,
} from '../hooks/obsidian-common.mjs';

test('monthFolderRelFromDateStr: <folder>/<year>/<MM-MON>, no DIA', () => {
  assert.equal(monthFolderRelFromDateStr('05-Bugs', '2026-06-29'), join('05-Bugs', '2026', '06-JUN'));
  assert.equal(monthFolderRelFromDateStr('04-Decisões', '2026-01-05'), join('04-Decisões', '2026', '01-JAN'));
  assert.doesNotMatch(monthFolderRelFromDateStr('06-Aprendizados', '2026-06-29'), /DIA/);
});

test('datedFolderRelFromDateStr: sessions still include DIA (unchanged)', () => {
  assert.match(datedFolderRelFromDateStr('02-Sessões', '2026-06-29'), /DIA 29/);
});
