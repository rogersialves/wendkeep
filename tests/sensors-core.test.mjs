import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSensors, requiredSensors, runSensors, evaluateGate, parseMutationReport } from '../hooks/sensors-core.mjs';

test('parseMutationReport: only Survived/NoCoverage as file/line/mutator', () => {
  const json = { files: {
    'src/a.js': { mutants: [
      { mutatorName: 'ArithmeticOperator', status: 'Survived', location: { start: { line: 10 } } },
      { mutatorName: 'X', status: 'Killed', location: { start: { line: 2 } } },
    ] },
    'src/b.js': { mutants: [{ mutatorName: 'BooleanLiteral', status: 'NoCoverage', location: { start: { line: 5 } } }] },
  } };
  const s = parseMutationReport(json);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0], { file: 'src/a.js', line: 10, mutator: 'ArithmeticOperator' });
  assert.deepEqual(s[1], { file: 'src/b.js', line: 5, mutator: 'BooleanLiteral' });
  assert.deepEqual(parseMutationReport({}), []);
});

test('runSensors: type mutation attaches survivors from the report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-mut-'));
  try {
    writeFileSync(join(dir, 'rep.json'), JSON.stringify({ files: { 'a.js': { mutants: [{ mutatorName: 'M', status: 'Survived', location: { start: { line: 3 } } }] } } }));
    const sensors = [{ id: 'mut', type: 'mutation', command: 'run', report: 'rep.json' }];
    const ev = runSensors(sensors, ['mut'], { spawn: () => ({ status: 0 }), cwd: dir, now: 'T' });
    assert.equal(ev[0].survivors.length, 1);
    assert.deepEqual(ev[0].survivors[0], { file: 'a.js', line: 3, mutator: 'M' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('requiredSensors: distinct sensor ids from tasks', () => {
  assert.deepEqual(
    requiredSensors([{ sensor: 'tests' }, { sensor: 'tests' }, { sensor: 'lint' }, {}]),
    ['tests', 'lint'],
  );
});

test('loadSensors: reads wendkeep.sensors.json; [] when absent/bad', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-sen-'));
  try {
    writeFileSync(join(dir, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'tests', command: 'x' }] }));
    assert.equal(loadSensors(dir)[0].id, 'tests');
    assert.deepEqual(loadSensors(join(dir, 'nope')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runSensors: green/red by exit code; carries severity (undefined sensor = critical)', () => {
  const sensors = [{ id: 'ok', command: 'run-true', severity: 'critical' }, { id: 'bad', command: 'run-false', severity: 'warning' }];
  const spawn = (cmd) => ({ status: cmd.includes('true') ? 0 : 1 });
  const ev = runSensors(sensors, ['ok', 'bad', 'ghost'], { spawn, now: '2026-07-05T00:00:00Z' });
  const status = Object.fromEntries(ev.map((e) => [e.id, e.status]));
  const sev = Object.fromEntries(ev.map((e) => [e.id, e.severity]));
  assert.equal(status.ok, 'green');
  assert.equal(status.bad, 'red');
  assert.equal(status.ghost, 'red');
  assert.equal(sev.ok, 'critical');
  assert.equal(sev.bad, 'warning');
  assert.equal(sev.ghost, 'critical'); // undefined sensor defaults to critical
  assert.equal(ev[0].ts, '2026-07-05T00:00:00Z');
});

test('evaluateGate: ok when all required green; failing lists missing/red', () => {
  const ev = [{ id: 'tests', status: 'green' }, { id: 'lint', status: 'red' }];
  assert.deepEqual(evaluateGate(ev, ['tests']), { ok: true, failing: [] });
  assert.deepEqual(evaluateGate(ev, ['tests', 'lint', 'typecheck']), { ok: false, failing: ['lint', 'typecheck'] });
  assert.deepEqual(evaluateGate(ev, []), { ok: true, failing: [] });
});

test('evaluateGate: red warning does not block; red critical + missing do', () => {
  const ev = [
    { id: 'lint', status: 'red', severity: 'warning' },
    { id: 'tests', status: 'red', severity: 'critical' },
    { id: 'types', status: 'green', severity: 'critical' },
  ];
  assert.deepEqual(evaluateGate(ev, ['lint']), { ok: true, failing: [] }); // warning red passes
  assert.deepEqual(evaluateGate(ev, ['lint', 'types']), { ok: true, failing: [] });
  assert.deepEqual(evaluateGate(ev, ['tests']), { ok: false, failing: ['tests'] }); // critical red blocks
  assert.deepEqual(evaluateGate(ev, ['ghost']), { ok: false, failing: ['ghost'] }); // never verified blocks
});
