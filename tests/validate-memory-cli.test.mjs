// [req:MEM-HYB-7] [req:MEM-HYB-9]
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCoreSkeleton } from '../src/validate-core.mjs';
import { renderSharedMemory } from '../hooks/memory-schema.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

test('init seeds .brain/CORE.md + protocol doc, and validate-memory passes on it', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-mem-'));
  const projectDir = join(parent, 'MemProj');
  mkdirSync(projectDir);
  try {
    const init = spawnSync(process.execPath, [BIN, 'init', '--project', projectDir, '--no-mcp', '--no-companions', '--no-colors', '--yes'], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const brain = join(projectDir, '.MemProj-vault', '.brain');
    assert.ok(existsSync(join(brain, 'CORE.md')));
    assert.ok(existsSync(join(brain, 'COMPACTION_PROTOCOL.md')));
    const val = run(['validate-memory', join(brain, 'CORE.md')]);
    assert.equal(val.status, 0, val.stderr);
    assert.match(val.stdout, /OK/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('init seeds the definitions layer; sync-defs copies it to agent dirs', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-defs-e2e-'));
  const projectDir = join(parent, 'DefProj');
  mkdirSync(projectDir);
  try {
    const init = spawnSync(process.execPath, [BIN, 'init', '--project', projectDir, '--no-mcp', '--no-companions', '--no-colors', '--yes'], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const vault = join(projectDir, '.DefProj-vault');
    assert.ok(existsSync(join(vault, '.brain', 'agents', 'example-agent.toml')));
    assert.ok(existsSync(join(vault, '.brain', 'skills', 'example-skill', 'SKILL.md')));
    const sync = spawnSync(process.execPath, [BIN, 'sync-defs', '--vault', vault, '--project', projectDir], { encoding: 'utf8' });
    assert.equal(sync.status, 0, sync.stderr);
    assert.ok(existsSync(join(projectDir, '.codex', 'agents', 'example-agent.toml')));
    assert.ok(existsSync(join(projectDir, '.claude', 'skills', 'example-skill', 'SKILL.md')));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('init --companions dotcontext wires MCP + hooks + .context, sensor passes', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-dotctx-e2e-'));
  const projectDir = join(parent, 'DotProj');
  mkdirSync(projectDir);
  try {
    const init = spawnSync(process.execPath, [BIN, 'init', '--project', projectDir, '--no-mcp', '--companions', 'dotcontext', '--dotcontext-mcp', 'project', '--no-colors', '--yes'], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const settings = JSON.parse(readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8'));
    const ss = (settings.hooks.SessionStart || []).flatMap((group) => (group.hooks || []).map((hook) => hook.command));
    assert.ok(ss.some((command) => /@dotcontext\/cli@1\.1\.1 hook dispatch/.test(command)));
    assert.ok((settings.hooks.PostToolUse || []).some((group) => group.matcher === 'Write|Edit|Bash'));
    assert.ok(!('undefined@dotcontext' in (settings.enabledPlugins || {})));
    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers.dotcontext);
    const sensors = JSON.parse(readFileSync(join(projectDir, '.context', 'config', 'sensors.json'), 'utf8'));
    assert.ok(sensors.sensors.some((sensor) => sensor.id === 'memory-validation'));
    assert.equal(run(['validate-memory', join(projectDir, '.DotProj-vault', '.brain', 'CORE.md')]).status, 0);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('validate-memory exits 1 on a CORE missing a required section', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-badcore-'));
  try {
    const bad = join(dir, 'CORE.md');
    writeFileSync(bad, '# CORE\n## Preferências do Usuário\n- a\n');
    const result = run(['validate-memory', bad]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Seção obrigatória|viola/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('init seeds wendkeep.sensors.json at project root', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-sensinit-'));
  const projectDir = join(parent, 'Proj');
  mkdirSync(projectDir);
  try {
    const result = spawnSync(process.execPath, [BIN, 'init', '--project', projectDir, '--no-mcp', '--no-companions', '--no-colors', '--yes'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const sensors = JSON.parse(readFileSync(join(projectDir, 'wendkeep.sensors.json'), 'utf8'));
    assert.ok(sensors.sensors.some((sensor) => sensor.id === 'memory-validation'));
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
    assert.ok(existsSync(join(vault, '.brain', 'skills', 'wk-workflow', 'SKILL.md')));
    assert.ok(existsSync(join(projectDir, '.claude', 'skills', 'wk-workflow', 'SKILL.md')));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('validate-memory <path> preserva contrato CORE e códigos 0/1/2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-validate-cli-'));
  try {
    const good = join(dir, 'CORE.md');
    const bad = join(dir, 'BAD.md');
    writeFileSync(good, renderCoreSkeleton());
    writeFileSync(bad, '# sem contrato\n');
    assert.equal(run(['validate-memory', good]).status, 0);
    assert.equal(run(['validate-memory', bad]).status, 1);
    assert.equal(run(['validate-memory', join(dir, 'missing.md')]).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validate-memory --vault valida o bundle v2 completo', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-validate-bundle-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  try {
    writeFileSync(join(brain, 'PROJECT.json'), '{"projectId":"p1"}\n');
    writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
    writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), '');
    writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory());
    writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
    const green = run(['validate-memory', '--vault', vault]);
    assert.equal(green.status, 0, green.stderr);
    assert.match(green.stdout, /bundle/i);
    writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), '{parcial');
    assert.equal(run(['validate-memory', '--vault', vault]).status, 1);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
