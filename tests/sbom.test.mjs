import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createReleaseSbom, finalizeReleaseReceipt } from '../scripts/generate-sbom.mjs';

test('[req:CI-SC-6] CycloneDX SBOM is deterministic and bound to exact tarball bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'wendkeep-sbom-'));
  try {
    const tarball = join(root, 'wendkeep-0.90.0.tgz');
    writeFileSync(tarball, 'synthetic-tarball-bytes');
    const pkg = { name: 'wendkeep', version: '0.90.0' };
    const lock = { packages: {
      '': { name: 'wendkeep', version: '0.90.0' },
      'packages/migrations': { name: '@wendkeep/migrations' },
      'node_modules/runtime-only': { version: '1.2.3' },
      'node_modules/dev-only': { version: '9.9.9', dev: true },
    } };
    const first = createReleaseSbom({ tarballPath: tarball, pkg, lock });
    const second = createReleaseSbom({ tarballPath: tarball, pkg, lock });
    assert.deepEqual(first, second);
    assert.equal(first.bomFormat, 'CycloneDX');
    assert.equal(first.specVersion, '1.5');
    assert.deepEqual(first.metadata.component.hashes.map((item) => item.alg), ['SHA-256', 'SHA-512']);
    assert.deepEqual(first.components.map((item) => item.name), ['@wendkeep/migrations', 'runtime-only']);
    assert.doesNotMatch(JSON.stringify(first), /dev-only|synthetic-tarball-bytes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:CI-SC-7] release receipt binds #40 commit gate, tarball, SBOM and published provenance', () => {
  const sha = 'a'.repeat(40);
  const integrity = 'sha512-candidate';
  const candidate = {
    schema_version: 1,
    status: 'candidate',
    package: { name: 'wendkeep', version: '0.90.0' },
    commit: sha,
    commit_receipt: { policy: 'wendkeep-universal-commit-v1', validated: true },
    artifact: { file: 'release-candidate.tgz', integrity, sha256: `sha256:${'b'.repeat(64)}` },
    sbom: { file: 'wendkeep-0.90.0.cdx.json', sha256: `sha256:${'c'.repeat(64)}` },
  };
  const published = {
    ok: true, code: 'verified', name: 'wendkeep', version: '0.90.0',
    commit: sha, integrity, attestation: { verified: true, commit: sha },
  };
  const receipt = finalizeReleaseReceipt(candidate, published);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.commit_receipt.validated, true);
  assert.equal(receipt.published.integrity, candidate.artifact.integrity);
  assert.equal(receipt.published.attestation.verified, true);
  assert.throws(
    () => finalizeReleaseReceipt(candidate, { ...published, commit: 'd'.repeat(40) }),
    (error) => error.code === 'WENDKEEP_RELEASE_RECEIPT_MISMATCH',
  );
  assert.throws(
    () => finalizeReleaseReceipt({ ...candidate, commit_receipt: { ...candidate.commit_receipt, validated: false } }, published),
    (error) => error.code === 'WENDKEEP_RELEASE_COMMIT_UNPROVEN',
  );
  assert.throws(
    () => finalizeReleaseReceipt(candidate, { ...published, attestation: null }),
    (error) => error.code === 'WENDKEEP_RELEASE_RECEIPT_MISMATCH',
  );
});
