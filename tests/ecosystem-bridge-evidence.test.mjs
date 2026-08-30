import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectBridgeArtifactEvidence } from '../src/ecosystem-bridge-artifact-collector.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wk-bridge-artifact-collector-'));
  mkdirSync(join(root, '.wendkeep'), { recursive: true });
  const bytes = Buffer.from([0, 255, 16, 128, 42]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(root, 'review.bin'), bytes);
  writeFileSync(join(root, '.wendkeep', 'bridge-artifacts.json'), JSON.stringify({
    schema_version: 1,
    artifacts: [{
      source: 'superpowers', external_id: 'review-1', kind: 'review', path: 'review.bin',
      sensor_id: 'review-check', task_id: '1.1',
    }],
  }));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'WendKeep Test']);
  git(root, ['config', 'user.email', 'test@localhost']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'test: bridge manifest']);
  return { root, digest };
}

test('[req:BRIDGE-23] productive collector binds a Git-indexed manifest, task, sensor result and binary blob', () => {
  const f = fixture();
  try {
    const result = collectBridgeArtifactEvidence({
      projectRoot: f.root,
      tasks: [{ id: '1.1', sensors: ['review-check'] }],
      sensors: [{
        id: 'review-check', status: 'green', exit_code: 0,
        artifact_results: [{
          schema_version: 1, external_id: 'review-1', path: 'review.bin', algorithm: 'sha256', digest: f.digest,
        }],
      }],
    });
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      schema_version: 1,
      source: 'superpowers', external_id: 'review-1', kind: 'review', path: 'review.bin',
      sha256: f.digest, authority: 'verified', sensor_id: 'review-check', task_id: '1.1',
      git_blob: git(f.root, ['rev-parse', ':review.bin']),
      manifest_path: '.wendkeep/bridge-artifacts.json',
      manifest_git_blob: git(f.root, ['rev-parse', ':.wendkeep/bridge-artifacts.json']),
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('[req:BRIDGE-24] collector fails closed for forged working bytes and untracked manifests', () => {
  const f = fixture();
  try {
    const input = {
      projectRoot: f.root,
      tasks: [{ id: '1.1', sensors: ['review-check'] }],
      sensors: [{ id: 'review-check', status: 'green', exit_code: 0, artifact_results: [{
        schema_version: 1, external_id: 'review-1', path: 'review.bin', algorithm: 'sha256', digest: f.digest,
      }] }],
    };
    writeFileSync(join(f.root, 'review.bin'), Buffer.from('forged'));
    assert.throws(() => collectBridgeArtifactEvidence(input), (error) => error.code === 'BRIDGE_ARTIFACT_FORGED');
    git(f.root, ['checkout', '--', 'review.bin']);
    git(f.root, ['rm', '--cached', '.wendkeep/bridge-artifacts.json']);
    assert.throws(() => collectBridgeArtifactEvidence(input), (error) => error.code === 'BRIDGE_ARTIFACT_MANIFEST_UNTRACKED');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('[req:BRIDGE-24] a tracked manifest deleted only from the worktree cannot disappear from verify', () => {
  const f = fixture();
  try {
    const manifest = join(f.root, '.wendkeep', 'bridge-artifacts.json');
    rmSync(manifest);
    assert.throws(
      () => collectBridgeArtifactEvidence({ projectRoot: f.root }),
      (error) => error.code === 'BRIDGE_ARTIFACT_MANIFEST_UNTRACKED',
    );

    git(f.root, ['rm', '--cached', '.wendkeep/bridge-artifacts.json']);
    assert.deepEqual(collectBridgeArtifactEvidence({ projectRoot: f.root }), []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('[req:BRIDGE-24] a green sensor cannot omit or forge its explicit artifact result', () => {
  const f = fixture();
  try {
    const base = {
      projectRoot: f.root,
      tasks: [{ id: '1.1', sensors: ['review-check'] }],
    };
    for (const artifactResults of [[], [{
      schema_version: 1, external_id: 'review-1', path: 'review.bin', algorithm: 'sha256', digest: '0'.repeat(64),
    }]]) {
      assert.throws(() => collectBridgeArtifactEvidence({
        ...base,
        sensors: [{ id: 'review-check', status: 'green', exit_code: 0, artifact_results: artifactResults }],
      }), (error) => error.code === 'BRIDGE_ARTIFACT_RESULT_MISSING');
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
