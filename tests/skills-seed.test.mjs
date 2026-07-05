import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WK_SKILLS, seedWkSkills } from '../src/skills-seed.mjs';

test('WK_SKILLS: the 5 process skills, each valid SKILL.md with matching name', () => {
  const names = WK_SKILLS.map((s) => s.name);
  for (const n of ['wk-workflow', 'wk-tdd', 'wk-debugging', 'wk-brainstorming', 'wk-planning']) {
    assert.ok(names.includes(n), `has ${n}`);
  }
  for (const s of WK_SKILLS) {
    assert.match(s.body, new RegExp(`name:\\s*${s.name}\\b`), `${s.name} frontmatter name`);
    assert.match(s.body, /description:/, `${s.name} has description`);
    assert.ok(s.body.length > 200, `${s.name} body non-trivial`);
  }
});

test('wk-workflow references the wendkeep loop commands', () => {
  const wf = WK_SKILLS.find((s) => s.name === 'wk-workflow').body;
  assert.match(wf, /wendkeep change new/);
  assert.match(wf, /wendkeep verify/);
  assert.match(wf, /\[sensor:/);
});

test('seedWkSkills: writes each SKILL.md, non-destructive', () => {
  const brain = mkdtempSync(join(tmpdir(), 'wk-skills-'));
  try {
    const created = seedWkSkills(brain);
    assert.equal(created.length, WK_SKILLS.length);
    assert.ok(existsSync(join(brain, 'skills', 'wk-workflow', 'SKILL.md')));
    const before = readFileSync(join(brain, 'skills', 'wk-tdd', 'SKILL.md'), 'utf8');
    assert.equal(seedWkSkills(brain).length, 0);
    assert.equal(readFileSync(join(brain, 'skills', 'wk-tdd', 'SKILL.md'), 'utf8'), before);
  } finally { rmSync(brain, { recursive: true, force: true }); }
});
