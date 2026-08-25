import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseTasks } from '../hooks/change-core.mjs';
import {
  deriveTaskContracts,
  evaluateArtifactSpecs,
  evaluateTaskContract,
} from '../src/task-contracts.mjs';

test('[req:TC-1] [req:TC-2] [req:TDD-1] task metadata derives from tarefas.md without becoming title text', () => {
  const [task] = parseTasks('- [ ] 2.3 produzir relatório [req:TC-1] [sensor:tests] [depends:2.2] [artifact:report] [phase:verify] [tdd]\n');

  assert.deepEqual(task, {
    id: '2.3',
    text: 'produzir relatório',
    done: false,
    sensor: 'tests',
    sensors: ['tests'],
    req: 'TC-1',
    reqs: ['TC-1'],
    dependencies: ['2.2'],
    artifacts: ['report'],
    phase: 'verify',
    tdd: true,
  });
});

test('[req:TDD-1] [req:TDD-6] a required TDD task stays blocked until a valid or waived attestation exists', () => {
  const input = {
    projectId: 'project-1',
    changeSlug: 'tdd-attestation',
    activeContextId: 'context-1',
    headSha: 'a'.repeat(40),
    tasksSha256: '1'.repeat(64),
    effectiveSpecSha256: '2'.repeat(64),
    artifactManifestSha256: '3'.repeat(64),
    profile: 'GOVERN',
    tasks: [{
      id: '1.1', text: 'implement behavior', done: true, reqs: ['TDD-1'], sensors: ['tests'], tdd: true,
    }],
  };

  const [missing] = deriveTaskContracts(input);
  assert.equal(missing.tdd_required, true);
  assert.equal(missing.tdd_attestation_id, null);
  const blocked = evaluateTaskContract(missing, {
    currentBinding: missing.binding,
    availableRequirementIds: ['TDD-1'],
    sensorResults: [{ id: 'tests', status: 'green' }],
  });
  assert.equal(blocked.can_complete, false);
  assert.deepEqual(blocked.blocking_findings.map((finding) => finding.code), [
    'TASK_TDD_ATTESTATION_MISSING_OR_INVALID',
  ]);

  const [waived] = deriveTaskContracts({
    ...input,
    tddAttestations: [{
      attestation_id: 'b'.repeat(64), task_id: '1.1', requirement_id: 'TDD-1', state: 'waived',
    }],
  });
  assert.equal(waived.tdd_attestation_id, 'b'.repeat(64));
  assert.equal(evaluateTaskContract(waived, {
    currentBinding: waived.binding,
    availableRequirementIds: ['TDD-1'],
    sensorResults: [{ id: 'tests', status: 'green' }],
  }).can_complete, true);
});

test('[req:TC-1] [req:TC-2] rebuild preserves contract identity and authored changes become stale', () => {
  const input = {
    projectId: 'project-1',
    changeSlug: 'typed-contracts',
    activeContextId: 'context-1',
    headSha: 'a'.repeat(40),
    tasksSha256: '1'.repeat(64),
    effectiveSpecSha256: '2'.repeat(64),
    artifactManifestSha256: '3'.repeat(64),
    tasks: [{ id: '1.1', text: 'derive contract', done: false, reqs: ['TC-1'], sensors: ['tests'] }],
  };

  const first = deriveTaskContracts(input);
  const rebuilt = deriveTaskContracts(input);
  assert.deepEqual(rebuilt, first);
  assert.match(first[0].contract_id, /^[a-f0-9]{64}$/);
  assert.equal(first[0].binding.project_id, 'project-1');
  assert.equal(first[0].status, 'ready');

  const evaluation = evaluateTaskContract(first[0], {
    currentBinding: { ...first[0].binding, tasks_sha256: '9'.repeat(64) },
    availableRequirementIds: ['TC-1'],
    sensorResults: [{ id: 'tests', status: 'green' }],
  });
  assert.equal(evaluation.can_complete, false);
  assert.deepEqual(evaluation.blocking_findings.map((finding) => finding.code), [
    'TASK_CONTRACT_STALE_TASKS',
    'TASK_CHECKBOX_OPEN',
  ]);
});

test('[req:TC-3] artifact gates support registered name, path, glob and bounded file-count', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-task-artifacts-'));
  try {
    mkdirSync(join(root, 'reports'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'ignored'), { recursive: true });
    writeFileSync(join(root, 'reports', 'a.json'), '{}');
    writeFileSync(join(root, 'reports', 'b.json'), '{}');
    writeFileSync(join(root, 'node_modules', 'ignored', 'secret.json'), '{}');

    const result = evaluateArtifactSpecs({
      projectRoot: root,
      registeredArtifacts: [{ name: 'receipt', path: 'runtime/receipt.json' }],
      specs: [
        { name: 'receipt', type: 'name' },
        { name: 'report-a', type: 'path', path: 'reports/a.json', fromFilesystem: true },
        { name: 'json-reports', type: 'glob', glob: 'reports/*.json', fromFilesystem: true },
        { name: 'two-reports', type: 'file-count', glob: '**/*.json', min: 2, max: 2, fromFilesystem: true },
      ],
      limits: { maxEntries: 20, timeoutMs: 1_000 },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map(({ name, satisfied, count }) => ({ name, satisfied, count })), [
      { name: 'receipt', satisfied: true, count: 1 },
      { name: 'report-a', satisfied: true, count: 1 },
      { name: 'json-reports', satisfied: true, count: 2 },
      { name: 'two-reports', satisfied: true, count: 2 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:TC-3] artifact scans enforce bounds, ignore private build roots and prefer registered artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-task-artifact-bounds-'));
  try {
    for (const dir of ['.git', '.worktrees', 'node_modules', 'dist', 'visible']) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, `${dir.replace('.', '') || 'git'}.json`), '{}');
    }

    const result = evaluateArtifactSpecs({
      projectRoot: root,
      registeredArtifacts: [{ name: 'registered-report', path: 'registry/report.json' }],
      specs: [
        { name: 'registered-report', type: 'path', path: 'missing.json', fromFilesystem: true },
        { name: 'visible-only', type: 'file-count', glob: '**/*.json', min: 1, max: 1, fromFilesystem: true },
      ],
      limits: { maxEntries: 1, timeoutMs: 1_000 },
    });
    assert.deepEqual(result.results, [
      { name: 'registered-report', type: 'path', satisfied: true, count: 1, source: 'registered' },
      { name: 'visible-only', type: 'file-count', satisfied: true, count: 1, source: 'filesystem' },
    ]);

    assert.throws(() => evaluateArtifactSpecs({
      projectRoot: root,
      specs: [{ name: 'bounded', type: 'glob', glob: '**/*.json', fromFilesystem: true }],
      limits: { maxEntries: 0, timeoutMs: 1_000 },
    }), (error) => error?.code === 'TASK_ARTIFACT_SCAN_LIMIT');
    assert.throws(() => evaluateArtifactSpecs({
      projectRoot: root,
      specs: [{ name: 'timed', type: 'glob', glob: '**/*.json', fromFilesystem: true }],
      limits: { maxEntries: 10, timeoutMs: -1 },
    }), (error) => error?.code === 'TASK_ARTIFACT_SCAN_TIMEOUT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:TC-3] artifact scan fails closed on project escape and symlink escape', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-task-artifact-escape-'));
  const root = join(parent, 'project');
  const outside = join(parent, 'outside');
  try {
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'private');
    symlinkSync(outside, join(root, 'escape'), 'junction');

    assert.throws(() => evaluateArtifactSpecs({
      projectRoot: root,
      specs: [{ name: 'outside', type: 'path', path: '../outside/secret.txt', fromFilesystem: true }],
    }), (error) => error?.code === 'TASK_ARTIFACT_PATH_ESCAPE');

    assert.throws(() => evaluateArtifactSpecs({
      projectRoot: root,
      specs: [{ name: 'junction', type: 'path', path: 'escape/secret.txt', fromFilesystem: true }],
    }), (error) => error?.code === 'TASK_ARTIFACT_PATH_ESCAPE');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('[req:TC-4] checkbox alone cannot complete a task with open contract gates', () => {
  const [contract] = deriveTaskContracts({
    projectId: 'project-1',
    changeSlug: 'typed-contracts',
    activeContextId: 'context-1',
    headSha: 'a'.repeat(40),
    tasksSha256: '1'.repeat(64),
    effectiveSpecSha256: '2'.repeat(64),
    artifactManifestSha256: '3'.repeat(64),
    tasks: [{
      id: '3.1', text: 'evaluate gates', done: true, reqs: ['TC-4'], sensors: ['tests'],
      artifacts: ['report'], dependencies: ['2.2'],
    }],
  });

  const blocked = evaluateTaskContract(contract, {
    currentBinding: contract.binding,
    availableRequirementIds: [],
    sensorResults: [{ id: 'tests', status: 'red' }],
    artifactResults: [{ name: 'report', satisfied: false }],
    completedTaskIds: [],
  });
  assert.equal(blocked.can_complete, false);
  assert.deepEqual(blocked.missing_requirements, ['TC-4']);
  assert.deepEqual(blocked.missing_sensors, ['tests']);
  assert.deepEqual(blocked.missing_artifacts, ['report']);
  assert.deepEqual(blocked.open_dependencies, ['2.2']);

  const complete = evaluateTaskContract(contract, {
    currentBinding: contract.binding,
    availableRequirementIds: ['TC-4'],
    sensorResults: [{ id: 'tests', status: 'green' }],
    artifactResults: [{ name: 'report', satisfied: true }],
    completedTaskIds: ['2.2'],
  });
  assert.equal(complete.can_complete, true);
  assert.equal(complete.status, 'completed');
  assert.deepEqual(complete.blocking_findings, []);
});

test('[req:TC-1] [req:TC-3] [req:TC-8] published JSON Schemas expose the versioned contract surface', () => {
  const readSchema = (name) => JSON.parse(readFileSync(join(process.cwd(), 'schema', name), 'utf8'));
  const task = readSchema('task-contract-v1.schema.json');
  const handoff = readSchema('handoff-contract-v1.schema.json');
  const artifacts = readSchema('artifact-manifest-v1.schema.json');

  assert.equal(task.properties.schema_version.const, 1);
  assert.ok(task.required.includes('contract_id'));
  assert.ok(task.required.includes('phase'));
  assert.deepEqual(task.properties.phase.enum, ['execute', 'verify']);
  assert.deepEqual(task.properties.status.enum, ['ready', 'blocked', 'pending-evaluation', 'completed', 'stale']);
  assert.equal(handoff.properties.schema_version.const, 1);
  assert.ok(handoff.required.includes('handoff_id'));
  assert.deepEqual(artifacts.$defs.artifact.properties.type.enum, ['name', 'path', 'glob', 'file-count']);
});
