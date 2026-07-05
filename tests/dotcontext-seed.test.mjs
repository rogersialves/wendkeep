// dotcontext .context/config seeding: one neutral sensor (memory-validation ->
// `npx wendkeep validate-memory`), non-destructive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderSensorsJson,
  seedDotcontext,
  globalHasDotcontext,
  resolveDotcontextSkipMcp,
} from '../src/dotcontext-seed.mjs';

test('renderSensorsJson: valid JSON with the memory-validation sensor', () => {
  const obj = JSON.parse(renderSensorsJson());
  assert.ok(Array.isArray(obj.sensors));
  const mem = obj.sensors.find((s) => s.id === 'memory-validation');
  assert.ok(mem, 'has memory-validation sensor');
  assert.equal(mem.command, 'npx wendkeep validate-memory');
  assert.equal(mem.severity, 'critical');
});

test('renderSensorsJson: adds sensors for detected package.json scripts only', () => {
  const obj = JSON.parse(renderSensorsJson({ test: 'jest', typecheck: 'tsc --noEmit', start: 'node x' }));
  const ids = obj.sensors.map((s) => s.id);
  assert.ok(ids.includes('memory-validation'));
  assert.ok(ids.includes('tests'));
  assert.ok(ids.includes('typecheck'));
  assert.ok(!ids.includes('start'), 'start is not a sensor');
  assert.ok(!ids.includes('lint'), 'no lint script -> no lint sensor');
});

test('globalHasDotcontext: detects a global dotcontext MCP entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-glob-'));
  try {
    const p = join(dir, '.claude.json');
    writeFileSync(p, JSON.stringify({ mcpServers: { dotcontext: { command: 'npx' } } }));
    assert.equal(globalHasDotcontext(p), true);
    writeFileSync(p, JSON.stringify({ mcpServers: { other: {} } }));
    assert.equal(globalHasDotcontext(p), false);
    assert.equal(globalHasDotcontext(join(dir, 'nope.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveDotcontextSkipMcp: none always skips; project never; auto follows global', () => {
  assert.equal(resolveDotcontextSkipMcp('none', false), true);
  assert.equal(resolveDotcontextSkipMcp('project', true), false);
  assert.equal(resolveDotcontextSkipMcp('auto', true), true);
  assert.equal(resolveDotcontextSkipMcp(undefined, false), false);
});

test('seedDotcontext: creates .context/config/sensors.json, non-destructive', () => {
  const project = mkdtempSync(join(tmpdir(), 'wk-dotctx-'));
  try {
    const created = seedDotcontext(project);
    const sensors = join(project, '.context', 'config', 'sensors.json');
    assert.ok(existsSync(sensors), 'sensors.json seeded');
    assert.ok(created.includes(sensors));

    // non-destructive: edit, re-run, content preserved
    writeFileSync(sensors, '{"mine":true}\n');
    const again = seedDotcontext(project);
    assert.equal(readFileSync(sensors, 'utf8'), '{"mine":true}\n');
    assert.equal(again.length, 0, 'nothing re-created');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
