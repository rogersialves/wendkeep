import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verifyReleaseCandidateBytes } from '../src/release-candidate.mjs';

test('[req:CI-SC-9] candidate runner is published without matching Node test discovery', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const command = packageJson.scripts['release:candidate:test'];
  const runner = command.match(/^node\s+(\S+)/)?.[1];
  assert.ok(runner, 'release:candidate:test must execute a versioned Node runner');
  assert.doesNotMatch(runner.split('/').at(-1), /^test-/u);
  assert.ok(packageJson.files.includes(runner), 'candidate runner must be present in the published tarball');
});

test('[req:CI-SC-9] canonical candidate receipt binds the exact bytes consumed before publish', () => {
  const root = mkdtempSync(join(tmpdir(), 'wendkeep-candidate-proof-'));
  try {
    const bytes = Buffer.from('immutable release candidate');
    const tarballPath = join(root, 'release-candidate.tgz');
    const receiptPath = join(root, 'release-candidate.json');
    const receipt = { artifact: {
      file: 'release-candidate.tgz',
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    } };
    writeFileSync(tarballPath, bytes);
    writeFileSync(receiptPath, JSON.stringify(receipt));
    assert.equal(verifyReleaseCandidateBytes({ tarballPath, receiptPath }).integrity, receipt.artifact.integrity);
    writeFileSync(tarballPath, 'mutated after receipt');
    assert.throws(
      () => verifyReleaseCandidateBytes({ tarballPath, receiptPath }),
      (error) => error.code === 'WENDKEEP_RELEASE_CANDIDATE_INTEGRITY_MISMATCH',
    );
    assert.throws(
      () => verifyReleaseCandidateBytes({ tarballPath: join(root, 'wendkeep-0.90.0.tgz'), receiptPath }),
      (error) => error.code === 'WENDKEEP_RELEASE_CANDIDATE_PATH_MISMATCH',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
