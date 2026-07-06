import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addLesson, buildLessonsInjection } from '../hooks/lessons-core.mjs';

test('addLesson writes .brain/lessons/<slug>.md; injection surfaces the lesson body', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-les-'));
  try {
    const p = addLesson(vault, { trigger: 'Gate falso verde', lesson: 'Sensor sem report não prova nada.', sourceChange: 'x', dateStr: '2026-07-05' });
    assert.ok(existsSync(p));
    assert.ok(p.endsWith(join('.brain', 'lessons', '2026-07-05-gate-falso-verde.md')));
    const inj = buildLessonsInjection(vault);
    assert.match(inj, /<lessons>/);
    assert.match(inj, /Sensor sem report/);
    assert.equal(buildLessonsInjection(join(vault, 'nope')), '');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('buildLessonsInjection caps at max, newest first', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-les2-'));
  try {
    for (const d of ['2026-07-01', '2026-07-02', '2026-07-03']) addLesson(vault, { trigger: `t-${d}`, lesson: `licao ${d}`, dateStr: d });
    const inj = buildLessonsInjection(vault, { max: 2 });
    assert.match(inj, /licao 2026-07-03/);
    assert.doesNotMatch(inj, /licao 2026-07-01/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
