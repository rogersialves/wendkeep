import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as integrations from '../packages/integrations/src/index.mjs';
import { bindProjectVault } from '../packages/vault/src/project-vault.mjs';
import { issueCanonicalDispatchAuthority } from '../packages/integrations/src/canonical-bridge-authority.mjs';
import { finishManagedWorktree } from '../src/worktree-cleanup.mjs';

const inspectBridges = (options) => integrations.inspectEcosystemBridges({ ...options, fs });

const bin = fileURLToPath(new URL('../bin/wendkeep.mjs', import.meta.url));

function run(args, cwd) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CODEX_THREAD_ID: '', CLAUDE_SESSION_ID: '' },
  });
}

test('[req:BRIDGE-12] bridge diagnostics distinguish optional disabled from enabled missing', () => {
  assert.equal(typeof integrations.inspectEcosystemBridges, 'function');
  const root = mkdtempSync(join(tmpdir(), 'wendkeep-bridge-status-'));
  try {
    const disabled = inspectBridges({ projectRoot: root });
    assert.equal(disabled.ok, true);
    assert.ok(disabled.adapters.every((item) => item.active === false));
    mkdirSync(join(root, '.wendkeep'), { recursive: true });
    writeFileSync(join(root, '.wendkeep', 'ecosystem-bridges.json'), JSON.stringify({
      schema_version: 1,
      adapters: { 'spec-kit': { enabled: true } },
    }));
    const missing = inspectBridges({ projectRoot: root });
    assert.equal(missing.ok, false);
    assert.equal(missing.diagnostics.some((item) => item.code === 'BRIDGE_ADAPTER_MISSING'), true);

    mkdirSync(join(root, '.superpowers'), { recursive: true });
    writeFileSync(join(root, '.superpowers', 'version'), '1.2.0\n');
    writeFileSync(join(root, '.wendkeep', 'ecosystem-bridges.json'), JSON.stringify({
      schema_version: 1,
      adapters: { superpowers: { enabled: true, version: '1.2.0', ownership_claims: [{ concept: 'task', owner: 'superpowers' }] } },
    }));
    const conflicted = inspectBridges({ projectRoot: root });
    assert.equal(conflicted.ok, false);
    assert.equal(conflicted.diagnostics.some((item) => item.code === 'BRIDGE_OWNERSHIP_CONFLICT'), true);
    if (process.platform === 'win32') {
      const otherDrive = root.toUpperCase().startsWith('C:') ? 'D:' : 'C:';
      const escaped = run([
        'bridge', 'verify-artifacts', '--project', root,
        '--input', `${otherDrive}\\outside\\artifacts.json`, '--proofs', 'proofs.json', '--json',
      ], root);
      assert.equal(escaped.status, 2);
      assert.equal(JSON.parse(escaped.stderr).code, 'BRIDGE_INPUT_ESCAPE');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:BRIDGE-16] Superpowers root is one real project-contained directory for status and dispatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'wendkeep-bridge-root-'));
  const external = mkdtempSync(join(tmpdir(), 'wendkeep-bridge-external-'));
  const configPath = join(root, '.wendkeep', 'ecosystem-bridges.json');
  const configure = (adapterRoot) => writeFileSync(configPath, JSON.stringify({
    schema_version: 1,
    adapters: { superpowers: { enabled: true, version: '1.2.0', root: adapterRoot } },
  }));
  try {
    mkdirSync(join(root, '.wendkeep'), { recursive: true });

    writeFileSync(join(root, '.superpowers-file'), 'not a directory');
    configure('.superpowers-file');
    const regularFile = inspectBridges({ projectRoot: root });
    assert.equal(regularFile.adapters.find((item) => item.adapter === 'superpowers').available, false);
    assert.equal(regularFile.diagnostics.some((item) => item.code === 'BRIDGE_SOURCE_INVALID'), true);
    const rejectedDispatch = run([
      'bridge', 'dispatch-superpowers', '--project', root, '--task-id', 'T001', '--json',
    ], root);
    assert.equal(rejectedDispatch.status, 1, rejectedDispatch.stderr);
    assert.equal(JSON.parse(rejectedDispatch.stdout).diagnostics[0].code, 'BRIDGE_SOURCE_INVALID');

    configure(external);
    const outside = inspectBridges({ projectRoot: root });
    assert.equal(outside.ok, false);
    assert.equal(outside.diagnostics.some((item) => item.code === 'BRIDGE_SOURCE_INVALID'), true);

    const link = join(root, '.superpowers-link');
    symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    configure('.superpowers-link');
    const escapedLink = inspectBridges({ projectRoot: root });
    assert.equal(escapedLink.ok, false);
    assert.equal(escapedLink.adapters.find((item) => item.adapter === 'superpowers').available, false);
    assert.equal(escapedLink.diagnostics.some((item) => item.code === 'BRIDGE_SOURCE_INVALID'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('[req:BRIDGE-13] isolated consumer anchors, proves and finishes the merged bridge worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wendkeep-bridge-e2e-'));
  const vault = `${root}-vault`;
  const linked = join(root, '.worktrees', 'bridge-e2e');
  try {
    mkdirSync(join(root, '.wendkeep', 'canonical'), { recursive: true });
    mkdirSync(join(root, '.specify', 'specs', '001-demo'), { recursive: true });
    mkdirSync(join(root, '.superpowers'), { recursive: true });
    writeFileSync(join(root, '.superpowers', 'version'), '1.2.0\n');
    writeFileSync(join(root, '.wendkeep', 'ecosystem-bridges.json'), JSON.stringify({
      schema_version: 1,
      adapters: {
        'spec-kit': { enabled: true, version: '1.1.0' },
        superpowers: { enabled: true, version: '1.2.0', root: '.superpowers' },
      },
    }));
    writeFileSync(join(root, '.specify', 'specs', '001-demo', 'spec.md'), '# Demo\n### Requirement: DEMO-1 — Safe bridge\n');
    writeFileSync(join(root, '.specify', 'specs', '001-demo', 'tasks.md'), '- [ ] T001 [DEMO-1] Execute safely\n');
    const sentinel = '{"tasks":["canonical"]}\n';
    writeFileSync(join(root, '.wendkeep', 'canonical', 'tasks.json'), sentinel);
    const task = {
      schema_version: 1, contract_id: 'a'.repeat(64), task_id: 'T001', change_slug: 'demo',
      title: 'Execute safely', phase: 'execute', status: 'ready', inputs: [], expected_outputs: [],
      acceptance_criteria: ['safe'], requirement_ids: ['DEMO-1'], required_sensors: [],
      required_artifacts: [], dependencies: [], owner: null, work_session_id: null,
      evidence_envelope_id: null, checked: false, authored_sha256: 'b'.repeat(64),
      binding: { project_id: 'demo', active_context_id: 'ctx-demo', head_sha: 'c'.repeat(40), tasks_sha256: 'd'.repeat(64), effective_spec_sha256: 'e'.repeat(64), artifact_manifest_sha256: 'f'.repeat(64) },
    };
    writeFileSync(join(root, 'task-contract.json'), JSON.stringify(task));

    execFileSync('git', ['init', '-b', 'main'], { cwd: root, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'WendKeep E2E'], { cwd: root, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'e2e@localhost'], { cwd: root, windowsHide: true });
    execFileSync('git', ['add', '.'], { cwd: root, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'test: bridge fixture'], { cwd: root, windowsHide: true });
    bindProjectVault({ projectRoot: root, vaultPath: vault });
    mkdirSync(join(vault, '08-Mudanças', 'bridge-e2e'), { recursive: true });
    execFileSync('git', ['add', '.wendkeep.json'], { cwd: root, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'test: bind isolated vault'], { cwd: root, windowsHide: true });
    const created = run(['worktree', 'create', 'bridge-e2e', '--project', root, '--open', 'none', '--json'], root);
    assert.equal(created.status, 0, created.stderr);
    const createdStat = statSync(JSON.parse(created.stdout).worktree.path);
    const expectedStat = statSync(linked);
    assert.equal(createdStat.dev, expectedStat.dev);
    assert.equal(createdStat.ino, expectedStat.ino);
    const canonicalBefore = readFileSync(join(linked, '.wendkeep', 'canonical', 'tasks.json'), 'utf8');

    const missingBaseline = run([
      'bridge', 'import-spec-kit', '--project', linked, '--change', 'bridge-e2e', '--json',
    ], linked);
    assert.equal(missingBaseline.status, 1, missingBaseline.stderr);
    assert.equal(JSON.parse(missingBaseline.stdout).diagnostics.some((item) => item.code === 'BRIDGE_BASELINE_MISSING'), true);

    const imported = run([
      'bridge', 'import-spec-kit', '--project', linked, '--change', 'bridge-e2e', '--accept-baseline', '--json',
    ], linked);
    assert.equal(imported.status, 0, imported.stderr);
    const projection = JSON.parse(imported.stdout);
    assert.equal(projection.references.some((item) => item.source_id === 'DEMO-1'), true);
    writeFileSync(join(linked, 'spec-projection.json'), JSON.stringify(projection));

    const dispatch = integrations.buildSuperpowersDispatch({
      taskContract: task,
      canonicalAuthority: issueCanonicalDispatchAuthority({
        task_contract: structuredClone(task),
        active_context: structuredClone(task.binding),
      }),
      specKitProjection: projection,
      config: integrations.normalizeBridgeConfig({ adapters: { superpowers: { enabled: true } } }),
      detectedVersion: '1.2.0',
      present: true,
    });
    assert.equal(dispatch.ok, true, JSON.stringify(dispatch.diagnostics));
    assert.equal(dispatch.task_contract.task_id, 'T001');
    assert.equal(dispatch.canonical_owner, 'wendkeep');
    assert.equal(readFileSync(join(linked, '.wendkeep', 'canonical', 'tasks.json'), 'utf8'), canonicalBefore);

    const exported = run([
      'bridge', 'export-status', '--project', linked,
      '--task-contract', 'task-contract.json', '--spec-projection', 'spec-projection.json', '--json',
    ], linked);
    assert.equal(exported.status, 0, exported.stderr);
    const statusProjection = JSON.parse(exported.stdout);
    assert.equal(statusProjection.authority, 'reported');
    assert.equal(statusProjection.tasks[0].task_id, 'T001');

    rmSync(join(linked, 'spec-projection.json'));
    const reviewContent = Buffer.from([0, 255, 16, 128, 42]);
    const reviewSha = createHash('sha256').update(reviewContent).digest('hex');
    writeFileSync(join(linked, 'review-e2e.bin'), reviewContent);
    writeFileSync(join(linked, 'artifact-input.json'), JSON.stringify([
      { external_id: 'review-e2e', kind: 'review', sha256: reviewSha },
    ]));
    writeFileSync(join(linked, 'proof-input.json'), JSON.stringify([
      { type: 'evidence-envelope', external_id: 'review-e2e' },
    ]));
    writeFileSync(join(linked, '.wendkeep', 'bridge-artifacts.json'), JSON.stringify({
      schema_version: 1,
      artifacts: [{
        source: 'superpowers', external_id: 'review-e2e', kind: 'review', path: 'review-e2e.bin',
        sensor_id: 'ci-review-e2e', task_id: '1.1',
      }],
    }));
    const sensorConfig = JSON.stringify({
      version: 1,
      sensors: [{
        id: 'ci-review-e2e', severity: 'critical', command: 'node -e "process.exit(0)"',
        artifact_results: [{
          schema_version: 1, external_id: 'review-e2e', path: 'review-e2e.bin', algorithm: 'sha256',
        }],
      }],
    });
    writeFileSync(join(linked, 'wendkeep.sensors.json'), sensorConfig);
    execFileSync('git', ['add', 'review-e2e.bin', 'artifact-input.json', 'proof-input.json', '.wendkeep/bridge-artifacts.json', 'wendkeep.sensors.json'], { cwd: linked, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'test: canonical bridge proof inputs'], { cwd: linked, windowsHide: true });

    const changeDir = join(vault, '08-Mudanças', 'bridge-e2e');
    const tarefas = '- [x] 1.1 Verify external review [sensor:ci-review-e2e]\n';
    writeFileSync(join(changeDir, 'tarefas.md'), tarefas);
    const verify = run([
      'verify', '--project', linked, '--vault', vault,
      '--change', 'bridge-e2e',
    ], linked);
    assert.equal(verify.status, 0, verify.stderr);
    const envelope = JSON.parse(readFileSync(join(changeDir, 'evidencia.json'), 'utf8'));
    assert.equal(envelope.external_artifacts[0].authority, 'verified');
    assert.equal(envelope.external_artifacts[0].sha256, reviewSha);
    assert.equal(envelope.sensors[0].artifact_results[0].digest, reviewSha);
    assert.equal(envelope.sensors[0].output_tail, '');
    const proof = run([
      'bridge', 'verify-artifacts', '--project', linked,
      '--input', 'artifact-input.json', '--proofs', 'proof-input.json',
      '--change', 'bridge-e2e', '--json',
    ], linked);
    assert.equal(proof.status, 0, proof.stderr);
    const proofResult = JSON.parse(proof.stdout);
    assert.equal(proofResult.artifacts[0].authority, 'verified');
    assert.equal(proofResult.artifacts[0].proof.evidence_envelope_id, envelope.envelope_id);
    assert.equal(integrations.validateBridgeRuntimeEnvelope(proofResult.artifacts[0]).valid, true);

    writeFileSync(join(changeDir, 'tarefas.md'), `${tarefas}- [ ] 1.2 Stale task\n`);
    const staleTasks = run([
      'bridge', 'verify-artifacts', '--project', linked, '--input', 'artifact-input.json',
      '--proofs', 'proof-input.json', '--change', 'bridge-e2e', '--json',
    ], linked);
    assert.equal(staleTasks.status, 1, staleTasks.stderr);
    writeFileSync(join(changeDir, 'tarefas.md'), tarefas);

    mkdirSync(join(changeDir, 'specs', 'bridge-proof'), { recursive: true });
    writeFileSync(join(changeDir, 'specs', 'bridge-proof', 'spec.md'), '## ADDED Requirements\n### Requirement: BRIDGE-1 — Changed\n');
    const staleSpec = run([
      'bridge', 'verify-artifacts', '--project', linked, '--input', 'artifact-input.json',
      '--proofs', 'proof-input.json', '--change', 'bridge-e2e', '--json',
    ], linked);
    assert.equal(staleSpec.status, 1, staleSpec.stderr);
    rmSync(join(changeDir, 'specs'), { recursive: true, force: true });

    writeFileSync(join(linked, 'wendkeep.sensors.json'), sensorConfig.replace('process.exit(0)', 'process.exitCode=0'));
    const staleSensors = run([
      'bridge', 'verify-artifacts', '--project', linked, '--input', 'artifact-input.json',
      '--proofs', 'proof-input.json', '--change', 'bridge-e2e', '--json',
    ], linked);
    assert.equal(staleSensors.status, 1, staleSensors.stderr);
    writeFileSync(join(linked, 'wendkeep.sensors.json'), sensorConfig);

    const status = run(['bridge', 'status', '--project', linked, '--json'], linked);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).ok, true);
    const branchHead = execFileSync('git', ['rev-parse', 'wk/bridge-e2e'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
    execFileSync('git', ['merge', '--no-ff', 'wk/bridge-e2e', '-m', 'merge bridge e2e'], { cwd: root, windowsHide: true });
    const mergeCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
    const finished = await finishManagedWorktree({
      startDir: root, slug: 'bridge-e2e', pullRequest: '72',
      github: async () => ({
        number: 72, url: 'https://github.com/acme/bridge-e2e/pull/72', state: 'MERGED',
        mergedAt: '2026-08-29T12:10:00.000Z', headRefName: 'wk/bridge-e2e',
        headRefOid: branchHead, baseRefName: 'main', mergeCommitOid: mergeCommit,
        isCrossRepository: false,
      }),
    });
    assert.equal(finished.state, 'completed');
    assert.equal(existsSync(linked), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});
