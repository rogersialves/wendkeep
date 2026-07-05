// `wendkeep validate-memory` CLI + the CORE.md seeding done by `wendkeep init`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

test('init seeds .brain/CORE.md + protocol doc, and validate-memory passes on it', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-mem-'));
  const projectDir = join(parent, 'MemProj');
  mkdirSync(projectDir);
  try {
    const init = spawnSync(
      process.execPath,
      [BIN, 'init', '--project', projectDir, '--no-mcp', '--no-companions', '--no-colors', '--yes'],
      { encoding: 'utf8' },
    );
    assert.equal(init.status, 0, `init exit 0; stderr=\n${init.stderr}`);

    const brain = join(projectDir, '.MemProj-vault', '.brain');
    assert.ok(existsSync(join(brain, 'CORE.md')), 'CORE.md seeded');
    assert.ok(existsSync(join(brain, 'COMPACTION_PROTOCOL.md')), 'protocol doc seeded');

    const val = spawnSync(process.execPath, [BIN, 'validate-memory', join(brain, 'CORE.md')], {
      encoding: 'utf8',
    });
    assert.equal(val.status, 0, `validate-memory exit 0; stderr=\n${val.stderr}`);
    assert.match(val.stdout, /OK/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('init seeds the definitions layer; sync-defs copies it to agent dirs', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-defs-e2e-'));
  const projectDir = join(parent, 'DefProj');
  mkdirSync(projectDir);
  try {
    const init = spawnSync(
      process.execPath,
      [BIN, 'init', '--project', projectDir, '--no-mcp', '--no-companions', '--no-colors', '--yes'],
      { encoding: 'utf8' },
    );
    assert.equal(init.status, 0, init.stderr);

    const vault = join(projectDir, '.DefProj-vault');
    assert.ok(existsSync(join(vault, '.brain', 'agents', 'example-agent.toml')), 'agents seeded');
    assert.ok(existsSync(join(vault, '.brain', 'skills', 'example-skill', 'SKILL.md')), 'skills seeded');

    const sync = spawnSync(
      process.execPath,
      [BIN, 'sync-defs', '--vault', vault, '--project', projectDir],
      { encoding: 'utf8' },
    );
    assert.equal(sync.status, 0, sync.stderr);
    assert.ok(existsSync(join(projectDir, '.codex', 'agents', 'example-agent.toml')), 'agent synced to .codex');
    assert.ok(existsSync(join(projectDir, '.claude', 'skills', 'example-skill', 'SKILL.md')), 'skill synced to .claude');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('init --companions dotcontext wires MCP + hooks + .context, sensor passes', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-dotctx-e2e-'));
  const projectDir = join(parent, 'DotProj');
  mkdirSync(projectDir);
  try {
    const init = spawnSync(
      process.execPath,
      // force project MCP placement so the assertion is independent of any global dotcontext
      [BIN, 'init', '--project', projectDir, '--no-mcp', '--companions', 'dotcontext', '--dotcontext-mcp', 'project', '--no-colors', '--yes'],
      { encoding: 'utf8' },
    );
    assert.equal(init.status, 0, `init exit 0; stderr=\n${init.stderr}`);

    const settings = JSON.parse(readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8'));
    const ss = (settings.hooks.SessionStart || []).flatMap((g) => (g.hooks || []).map((h) => h.command));
    assert.ok(ss.some((c) => /@dotcontext\/cli@1\.1\.1 hook dispatch/.test(c)), 'dotcontext SessionStart hook');
    assert.ok((settings.hooks.PostToolUse || []).some((g) => g.matcher === 'Write|Edit|Bash'), 'PostToolUse hook');
    assert.ok(!('undefined@dotcontext' in (settings.enabledPlugins || {})), 'no phantom plugin');

    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers.dotcontext, 'dotcontext MCP server');

    const sensors = JSON.parse(readFileSync(join(projectDir, '.context', 'config', 'sensors.json'), 'utf8'));
    assert.ok(sensors.sensors.some((s) => s.id === 'memory-validation'), 'sensor seeded');

    // the sensor's command closes the loop: validate the seeded CORE.md
    const val = spawnSync(
      process.execPath,
      [BIN, 'validate-memory', join(projectDir, '.DotProj-vault', '.brain', 'CORE.md')],
      { encoding: 'utf8' },
    );
    assert.equal(val.status, 0, `sensor command exits 0; stderr=\n${val.stderr}`);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('validate-memory exits 1 on a CORE missing a required section', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-badcore-'));
  try {
    const bad = join(dir, 'CORE.md');
    writeFileSync(bad, '# CORE\n## Preferências do Usuário\n- a\n');
    const r = spawnSync(process.execPath, [BIN, 'validate-memory', bad], { encoding: 'utf8' });
    assert.equal(r.status, 1, 'invalid CORE exits 1');
    assert.match(r.stderr, /Seção obrigatória|viola/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init seeds wendkeep.sensors.json at project root', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-sensinit-'));
  const projectDir = join(parent, 'Proj');
  mkdirSync(projectDir);
  try {
    const r = spawnSync(process.execPath, [BIN, 'init', '--project', projectDir, '--no-mcp', '--no-companions', '--no-colors', '--yes'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(readFileSync(join(projectDir, 'wendkeep.sensors.json'), 'utf8'));
    assert.ok(s.sensors.some((x) => x.id === 'memory-validation'), 'native sensor config seeded');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('init auto-delivers wk process skills to .claude/skills (no manual sync-defs)', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-skillsync-'));
  const projectDir = join(parent, 'SkProj');
  mkdirSync(projectDir);
  try {
    const init = spawnSync(process.execPath, [BIN, 'init', '--project', projectDir, '--no-mcp', '--no-companions', '--no-colors', '--yes'], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const vault = join(projectDir, '.SkProj-vault');
    assert.ok(existsSync(join(vault, '.brain', 'skills', 'wk-workflow', 'SKILL.md')), 'skill seeded in vault');
    // init runs sync-defs itself — no manual step needed.
    assert.ok(existsSync(join(projectDir, '.claude', 'skills', 'wk-workflow', 'SKILL.md')), 'skill auto-synced to .claude');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
