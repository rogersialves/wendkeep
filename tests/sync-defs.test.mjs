// Definitions layer: .brain/agents + .brain/skills are the versioned source of
// truth; `wendkeep sync-defs` copies them into the project's agent-readable dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncDefs, seedDefinitions } from '../src/sync-defs.mjs';

function tempVaultWithDefs() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-defs-'));
  mkdirSync(join(vault, '.brain', 'agents'), { recursive: true });
  mkdirSync(join(vault, '.brain', 'skills', 'bar'), { recursive: true });
  writeFileSync(join(vault, '.brain', 'agents', 'foo.toml'), 'name = "foo"\n');
  writeFileSync(join(vault, '.brain', 'agents', 'README.md'), '# docs (not a def)\n');
  writeFileSync(join(vault, '.brain', 'skills', 'bar', 'SKILL.md'), '---\nname: bar\n---\nbody\n');
  return vault;
}

test('syncDefs: agents .toml -> .codex/agents, skills dir -> .claude/skills', () => {
  const vault = tempVaultWithDefs();
  const project = mkdtempSync(join(tmpdir(), 'wk-proj-'));
  try {
    const r = syncDefs(vault, project);
    assert.deepEqual(r.agents, ['foo.toml']);
    assert.deepEqual(r.skills, ['bar']);
    assert.ok(existsSync(join(project, '.codex', 'agents', 'foo.toml')), 'agent copied to .codex/agents');
    assert.ok(existsSync(join(project, '.claude', 'skills', 'bar', 'SKILL.md')), 'skill copied to .claude/skills');
    // README.md in agents/ is docs, not a def — not synced.
    assert.equal(existsSync(join(project, '.codex', 'agents', 'README.md')), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('syncDefs: no .brain defs -> empty result, no crash', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-empty-'));
  const project = mkdtempSync(join(tmpdir(), 'wk-proj2-'));
  try {
    assert.deepEqual(syncDefs(vault, project), { agents: [], skills: [] });
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('seedDefinitions: creates README + example agent/skill, idempotent + non-destructive', () => {
  const brain = mkdtempSync(join(tmpdir(), 'wk-seed-'));
  try {
    const created = seedDefinitions(brain);
    assert.ok(existsSync(join(brain, 'agents', 'README.md')));
    assert.ok(existsSync(join(brain, 'agents', 'example-agent.toml')));
    assert.ok(existsSync(join(brain, 'skills', 'README.md')));
    assert.ok(existsSync(join(brain, 'skills', 'example-skill', 'SKILL.md')));
    assert.ok(created.length >= 4);

    // non-destructive: edit, re-run, content preserved
    const edited = join(brain, 'agents', 'example-agent.toml');
    writeFileSync(edited, 'name = "mine"\n');
    const again = seedDefinitions(brain);
    assert.equal(readFileSync(edited, 'utf8'), 'name = "mine"\n', 'does not clobber existing');
    assert.equal(again.length, 0, 'nothing re-created on second run');
  } finally {
    rmSync(brain, { recursive: true, force: true });
  }
});
