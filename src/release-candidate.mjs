import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export const RELEASE_CANDIDATE_FILE = 'release-candidate.tgz';

export function verifyReleaseCandidateBytes({ tarballPath, receiptPath } = {}) {
  if (basename(String(tarballPath || '')) !== RELEASE_CANDIDATE_FILE) {
    throw Object.assign(new Error('release candidate must use the canonical tarball path'), {
      code: 'WENDKEEP_RELEASE_CANDIDATE_PATH_MISMATCH',
    });
  }
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const bytes = readFileSync(tarballPath);
  const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (receipt?.artifact?.file !== RELEASE_CANDIDATE_FILE
    || receipt?.artifact?.sha256 !== sha256
    || receipt?.artifact?.integrity !== integrity) {
    throw Object.assign(new Error('release candidate bytes do not match their immutable receipt'), {
      code: 'WENDKEEP_RELEASE_CANDIDATE_INTEGRITY_MISMATCH',
    });
  }
  return { receipt, sha256, integrity };
}
