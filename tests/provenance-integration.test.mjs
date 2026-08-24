import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { finishDelivery, startDelivery } from '../src/delivery.mjs';
import { collectNpmObservation } from '../src/provenance-sources.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'wk-delivery-provenance-repo-'));
  const vault = mkdtempSync(join(tmpdir(), 'wk-delivery-provenance-vault-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'provenance@example.test']);
  git(repo, ['config', 'user.name', 'Provenance Test']);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/example/project.git']);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name: 'fixture', version: '1.2.3', repository: 'https://github.com/example/project.git',
  }));
  writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n\n## [1.2.3] — 2026-08-23\n- Provenance.\n');
  git(repo, ['add', 'package.json', 'CHANGELOG.md']);
  git(repo, ['commit', '-m', 'release 1.2.3']);
  const releaseCommit = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['tag', '-a', 'v1.2.3', '-m', 'v1.2.3']);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9' }));
  git(repo, ['add', 'package.json']);
  git(repo, ['commit', '-m', 'advance incidental worktree']);
  const incidentalCommit = git(repo, ['rev-parse', 'HEAD']);
  return { repo, vault, releaseCommit, incidentalCommit };
}

function verifiedCollectors({ releaseCommit, overrides = {}, calls = [] }) {
  const repository = 'example/project';
  const base = {
    collectGitSubject(args) {
      calls.push(['git', args]);
      return {
        ok: true,
        state: 'verified',
        sourceCommit: releaseCommit,
        targetCommit: releaseCommit,
        name: 'fixture',
        version: '1.2.3',
        package: { name: 'fixture', version: '1.2.3' },
        changelog: '## [1.2.3] — 2026-08-23\n- Provenance.',
      };
    },
    collectArtifactObservation(args) {
      calls.push(['artifact', args]);
      return { ok: true, state: 'verified', commit: releaseCommit, integrity: 'sha512-target' };
    },
    collectTagObservation(args) {
      calls.push(['tag', args]);
      return { ok: true, state: 'verified', name: 'v1.2.3', commit: releaseCommit };
    },
    collectCiObservation(args) {
      calls.push(['ci', args]);
      return { ok: true, state: 'verified', status: 'success', commit: releaseCommit, repository };
    },
    collectNpmObservation(args) {
      calls.push(['npm', args]);
      return {
        ok: true, state: 'verified', name: 'fixture', version: '1.2.3',
        integrity: 'sha512-target', repository, commit: releaseCommit,
      };
    },
    collectGitHubReleaseObservation(args) {
      calls.push(['release', args]);
      return {
        ok: true, state: 'verified', tag: 'v1.2.3', version: '1.2.3',
        commit: releaseCommit, repository, status: 'published',
      };
    },
  };
  return Object.assign(base, overrides);
}

function publishEvidence(overrides = {}) {
  return {
    ci_url: 'https://github.com/example/project/actions/runs/42',
    version: '1.2.3',
    npm_integrity: 'sha512-target',
    release_url: 'https://github.com/example/project/releases/tag/v1.2.3',
    ...overrides,
  };
}

test('[req:PROV-4] [req:PROV-6] delivery derives package and artifact from target, not incidental HEAD', () => {
  const f = fixture();
  const calls = [];
  try {
    const state = startDelivery({
      vaultBase: f.vault,
      repoRoot: f.repo,
      id: 'target-not-worktree',
      capabilities: ['git:tag'],
      sourceCommit: f.releaseCommit,
    });
    const receipt = finishDelivery({
      vaultBase: f.vault,
      repoRoot: f.repo,
      id: state.id,
      target: 'v1.2.3',
      evidence: { version: '1.2.3' },
      collectors: verifiedCollectors({ releaseCommit: f.releaseCommit, calls }),
    });

    assert.equal(receipt.outcome, 'completed');
    assert.equal(receipt.target_commit, f.releaseCommit);
    assert.notEqual(f.releaseCommit, f.incidentalCommit);
    assert.equal(calls.find(([kind]) => kind === 'git')[1].targetRef, 'v1.2.3');
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
    rmSync(f.vault, { recursive: true, force: true });
  }
});

test('[req:PROV-5] publish claims cannot replace authoritative observations', () => {
  const f = fixture();
  try {
    const state = startDelivery({
      vaultBase: f.vault,
      repoRoot: f.repo,
      id: 'offline-publish',
      capabilities: ['publish'],
      sourceCommit: f.releaseCommit,
    });
    const collectors = verifiedCollectors({
      releaseCommit: f.releaseCommit,
      overrides: {
        collectCiObservation: () => ({ state: 'reported', reasonCodes: ['PROVENANCE_SOURCE_UNAVAILABLE'] }),
      },
    });

    assert.throws(
      () => finishDelivery({
        vaultBase: f.vault,
        repoRoot: f.repo,
        id: state.id,
        target: 'v1.2.3',
        evidence: publishEvidence(),
        collectors,
      }),
      (error) => error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED'
        && error?.provenance?.state === 'reported',
    );
    assert.equal(existsSync(join(f.vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl')), false);
    assert.equal(readFileSync(join(f.vault, '.brain', 'runtime', 'deliveries', `${state.id}.json`), 'utf8').includes('"state": "active"'), true);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
    rmSync(f.vault, { recursive: true, force: true });
  }
});

test('[req:PROV-5] finish binds the npm observation to the target commit and start repository', () => {
  const f = fixture();
  const npmCalls = [];
  try {
    const state = startDelivery({
      vaultBase: f.vault,
      repoRoot: f.repo,
      id: 'npm-authority-inputs',
      capabilities: ['publish'],
      sourceCommit: f.releaseCommit,
    });
    const collectors = verifiedCollectors({
      releaseCommit: f.releaseCommit,
      overrides: { collectNpmObservation },
    });
    const receipt = finishDelivery({
      vaultBase: f.vault,
      repoRoot: f.repo,
      id: state.id,
      target: 'v1.2.3',
      evidence: publishEvidence(),
      collectors,
      execute(command, args, options = {}) {
        if (/^npm(?:\.cmd)?$/.test(command)) {
          npmCalls.push(args);
          return JSON.stringify({
            name: 'fixture',
            version: '1.2.3',
            dist: { integrity: 'sha512-target' },
            gitHead: f.releaseCommit,
            repository: { url: 'https://github.com/example/project.git' },
          });
        }
        return execFileSync(command, args, options);
      },
    });

    assert.equal(receipt.outcome, 'completed');
    assert.equal(receipt.observations.npm.commit, f.releaseCommit);
    assert.equal(receipt.observations.npm.repository, 'example/project');
    assert.equal(npmCalls.length, 1);
    assert.ok(npmCalls[0].includes('--registry=https://registry.npmjs.org/'));
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
    rmSync(f.vault, { recursive: true, force: true });
  }
});

test('[req:PROV-5] remote repository mismatch blocks before consulting external publication sources', () => {
  const f = fixture();
  let externalCalled = false;
  try {
    const state = startDelivery({
      vaultBase: f.vault,
      repoRoot: f.repo,
      id: 'foreign-remote-publish',
      capabilities: ['publish'],
      sourceCommit: f.releaseCommit,
    });
    git(f.repo, ['remote', 'set-url', 'origin', 'https://github.com/foreign/project.git']);
    const collectors = verifiedCollectors({
      releaseCommit: f.releaseCommit,
      overrides: {
        collectArtifactObservation: () => {
          externalCalled = true;
          return { state: 'verified', commit: f.releaseCommit, integrity: 'sha512-target' };
        },
      },
    });

    assert.throws(
      () => finishDelivery({
        vaultBase: f.vault,
        repoRoot: f.repo,
        id: state.id,
        target: 'v1.2.3',
        evidence: publishEvidence(),
        collectors,
      }),
      (error) => error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED'
        && error?.provenance?.state === 'conflict',
    );
    assert.equal(externalCalled, false);
    assert.equal(existsSync(join(f.vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl')), false);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
    rmSync(f.vault, { recursive: true, force: true });
  }
});

test('[req:PROV-6] every conflicting external link blocks without a completion receipt', () => {
  for (const [kind, replacement] of [
    ['tag', { state: 'conflict', reasonCodes: ['PROVENANCE_COMMIT_MISMATCH'] }],
    ['npm', { state: 'conflict', reasonCodes: ['PROVENANCE_INTEGRITY_MISMATCH'] }],
    ['ci', { state: 'conflict', reasonCodes: ['PROVENANCE_COMMIT_MISMATCH'] }],
    ['release', { state: 'conflict', reasonCodes: ['PROVENANCE_NOTES_MISMATCH'] }],
  ]) {
    const f = fixture();
    try {
      const state = startDelivery({
        vaultBase: f.vault,
        repoRoot: f.repo,
        id: `conflicting-${kind}`,
        capabilities: ['publish'],
        sourceCommit: f.releaseCommit,
      });
      const key = {
        tag: 'collectTagObservation', npm: 'collectNpmObservation',
        ci: 'collectCiObservation', release: 'collectGitHubReleaseObservation',
      }[kind];
      const collectors = verifiedCollectors({
        releaseCommit: f.releaseCommit,
        overrides: { [key]: () => replacement },
      });
      assert.throws(
        () => finishDelivery({
          vaultBase: f.vault, repoRoot: f.repo, id: state.id, target: 'v1.2.3',
          evidence: publishEvidence(), collectors,
        }),
        (error) => error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED',
        kind,
      );
      assert.equal(existsSync(join(f.vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl')), false, kind);
    } finally {
      rmSync(f.repo, { recursive: true, force: true });
      rmSync(f.vault, { recursive: true, force: true });
    }
  }
});

test('[req:PROV-6] target version and claimed integrity must match the observed release subject', () => {
  for (const [id, evidence, override] of [
    ['version-mismatch', publishEvidence({ version: '1.2.4' }), {}],
    ['integrity-mismatch', publishEvidence({ npm_integrity: 'sha512-foreign' }), {}],
  ]) {
    const f = fixture();
    try {
      const state = startDelivery({
        vaultBase: f.vault,
        repoRoot: f.repo,
        id,
        capabilities: ['publish'],
        sourceCommit: f.releaseCommit,
      });
      assert.throws(
        () => finishDelivery({
          vaultBase: f.vault,
          repoRoot: f.repo,
          id: state.id,
          target: 'v1.2.3',
          evidence,
          collectors: verifiedCollectors({ releaseCommit: f.releaseCommit, overrides: override }),
        }),
        (error) => error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED'
          || (id === 'version-mismatch' && /tag/i.test(error?.message || '')),
      );
      assert.equal(existsSync(join(f.vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl')), false);
    } finally {
      rmSync(f.repo, { recursive: true, force: true });
      rmSync(f.vault, { recursive: true, force: true });
    }
  }
});

test('[req:PROV-7] successful delivery writes v2 ledger/checkpoint and retry is idempotent', () => {
  const f = fixture();
  try {
    const state = startDelivery({
      vaultBase: f.vault,
      repoRoot: f.repo,
      id: 'v2-receipt',
      capabilities: ['publish'],
      sourceCommit: f.releaseCommit,
    });
    const input = {
      vaultBase: f.vault,
      repoRoot: f.repo,
      id: state.id,
      target: 'v1.2.3',
      evidence: publishEvidence({
        ci_url: 'https://github.com/example/project/actions/runs/42?token=ci-secret',
        release_url: 'https://github.com/example/project/releases/tag/v1.2.3?token=release-secret',
      }),
      collectors: verifiedCollectors({ releaseCommit: f.releaseCommit }),
      now: new Date('2026-08-23T12:00:00Z'),
    };
    const receipt = finishDelivery(input);
    const ledgerPath = join(f.vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl');
    const checkpointPath = join(f.vault, '.brain', 'runtime', 'delivery-receipts-v2.checkpoint.json');
    const before = readFileSync(ledgerPath, 'utf8');
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    assert.equal(receipt.schema_version, 2);
    assert.match(JSON.parse(before).previous_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(checkpoint.last_sequence, 1);
    assert.doesNotMatch(before, /ci-secret|release-secret|# Changelog/);

    const replay = finishDelivery(input);
    assert.equal(replay.receipt_hash, receipt.receipt_hash);
    assert.equal(readFileSync(ledgerPath, 'utf8'), before);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
    rmSync(f.vault, { recursive: true, force: true });
  }
});

test('[req:PROV-4] source commit not ancestral to observed target fails before collectors or receipt', () => {
  const f = fixture();
  let collected = false;
  try {
    git(f.repo, ['checkout', '--orphan', 'unrelated']);
    writeFileSync(join(f.repo, 'unrelated.txt'), 'unrelated\n');
    git(f.repo, ['add', 'unrelated.txt']);
    git(f.repo, ['commit', '-m', 'unrelated']);
    const unrelated = git(f.repo, ['rev-parse', 'HEAD']);
    const state = startDelivery({
      vaultBase: f.vault,
      repoRoot: f.repo,
      id: 'non-ancestor',
      capabilities: ['git:push'],
      sourceCommit: unrelated,
    });
    assert.throws(
      () => finishDelivery({
        vaultBase: f.vault,
        repoRoot: f.repo,
        id: state.id,
        target: 'origin/main',
        execute(command, args, options = {}) {
          if (command === 'git' && args[0] === 'ls-remote') {
            return `${f.releaseCommit}\trefs/heads/main\n`;
          }
          return execFileSync(command, args, options);
        },
        collectors: {
          collectGitSubject: () => {
            collected = true;
            return {
              state: 'verified',
              sourceCommit: unrelated,
              targetCommit: f.releaseCommit,
              package: { name: 'fixture', version: '1.2.3' },
            };
          },
        },
      }),
      (error) => error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED',
    );
    assert.equal(collected, true, 'git subject is the only collector needed before the ancestry gate');
    assert.equal(existsSync(join(f.vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl')), false);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
    rmSync(f.vault, { recursive: true, force: true });
  }
});
