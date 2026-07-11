// Definitions layer: .brain/agents + .brain/skills are the versioned source of
// truth; `wendkeep sync-defs` copies them into the project's agent-readable dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSyncDefs, syncDefs, seedDefinitions } from '../src/sync-defs.mjs';

function tempVaultWithDefs() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-defs-'));
  mkdirSync(join(vault, '.brain', 'agents'), { recursive: true });
  mkdirSync(join(vault, '.brain', 'skills', 'bar'), { recursive: true });
  writeFileSync(join(vault, '.brain', 'agents', 'foo.toml'), 'name = "foo"\n');
  writeFileSync(join(vault, '.brain', 'agents', 'README.md'), '# docs (not a def)\n');
  writeFileSync(join(vault, '.brain', 'skills', 'bar', 'SKILL.md'), '---\nname: bar\n---\nbody\n');
  return vault;
}

test('syncDefs: writes the managed AGENTS.md section, idempotent, user content preserved (0.8.0)', () => {
  const vault = tempVaultWithDefs();
  const project = mkdtempSync(join(tmpdir(), 'wk-agmd-'));
  try {
    writeFileSync(join(vault, '.brain', 'skills', 'bar', 'SKILL.md'), '---\nname: bar\ndescription: does bar things\n---\nbody\n');
    writeFileSync(join(project, 'AGENTS.md'), '# My project\n\nuser notes stay.\n');
    syncDefs(vault, project);
    const md = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    assert.match(md, /user notes stay\./, 'user content preserved');
    assert.match(md, /<!-- wendkeep:skills:start -->/);
    assert.match(md, /bar.*does bar things/, 'skill listed with description');
    assert.match(md, /wendkeep change new|wendkeep verify/, 'loop commands present');
    // idempotente: re-run = 1 seção só
    syncDefs(vault, project);
    const md2 = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    assert.equal((md2.match(/wendkeep:skills:start/g) || []).length, 1, 'single section');
    // sem AGENTS.md: cria
    const p2 = mkdtempSync(join(tmpdir(), 'wk-agmd2-'));
    try {
      syncDefs(vault, p2);
      assert.ok(existsSync(join(p2, 'AGENTS.md')), 'created when absent');
    } finally { rmSync(p2, { recursive: true, force: true }); }
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
});

test('syncDefs: agents -> Codex, skills -> Claude + Codex project dirs', () => {
  const vault = tempVaultWithDefs();
  const project = mkdtempSync(join(tmpdir(), 'wk-proj-'));
  try {
    const r = syncDefs(vault, project);
    assert.deepEqual(r.agents, ['foo.toml']);
    assert.deepEqual(r.skills, ['bar']);
    assert.ok(existsSync(join(project, '.codex', 'agents', 'foo.toml')), 'agent copied to .codex/agents');
    assert.ok(existsSync(join(project, '.claude', 'skills', 'bar', 'SKILL.md')), 'skill copied to .claude/skills');
    assert.ok(existsSync(join(project, '.agents', 'skills', 'bar', 'SKILL.md')), 'skill copied to .agents/skills');
    assert.ok(existsSync(join(project, '.agents', 'skills', 'bar', '.wendkeep-meta.json')), 'version/hash metadata copied');
    assert.equal(checkSyncDefs(vault, project).ok, true);
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
    assert.deepEqual(syncDefs(vault, project), { agents: [], skills: [], codexSkills: [], agentsMd: false });
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('checkSyncDefs detects stale skill copies without writing', () => {
  const vault = tempVaultWithDefs();
  const project = mkdtempSync(join(tmpdir(), 'wk-drift-'));
  try {
    syncDefs(vault, project);
    writeFileSync(join(project, '.agents', 'skills', 'bar', 'SKILL.md'), 'stale\n');
    const check = checkSyncDefs(vault, project);
    assert.equal(check.ok, false);
    assert.ok(check.issues.some((issue) => issue.includes('.agents') && issue.includes('divergiu')));
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
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
