import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { getLocale } from '../hooks/locale.mjs';
import {
  withVaultPathLock,
  writeVaultFileAtomic,
} from '../packages/vault/src/vault-path-safety.mjs';
import { captureGitSnapshot } from './evidence-envelope.mjs';

function git(projectRoot, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw Object.assign(new Error(result.stderr || `git ${args.join(' ')} failed`), {
      code: 'TDD_GIT_FAILED',
    });
  }
  return result;
}

function zeroPaths(value) {
  return String(value || '').split('\0').map((path) => path.trim()).filter(Boolean);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function captureTddSnapshot(projectRoot) {
  const snapshot = captureGitSnapshot(projectRoot);
  const changed = zeroPaths(git(projectRoot, ['diff', '--name-only', '-z', 'HEAD']).stdout);
  const untracked = zeroPaths(git(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z']).stdout);
  const paths = [...new Set([...changed, ...untracked])].sort();
  const changeManifest = {};
  for (const path of paths) {
    const target = join(projectRoot, ...path.split('/'));
    if (!existsSync(target)) changeManifest[path] = 'deleted';
    else if (lstatSync(target).isFile()) changeManifest[path] = sha256(readFileSync(target));
  }
  return { ...snapshot, change_manifest: changeManifest };
}

export function committedPathsBetween(projectRoot, from, to) {
  if (!from || !to || from === to) return [];
  return zeroPaths(git(projectRoot, ['diff', '--name-only', '-z', from, to]).stdout).sort();
}

export function isGitAncestor(projectRoot, from, to) {
  if (!from || !to) return false;
  return git(projectRoot, ['merge-base', '--is-ancestor', from, to], { allowFailure: true }).status === 0;
}

export function tddAttestationStorePath(vaultBase, changeSlug) {
  return join(vaultBase, getLocale(vaultBase).folders.changes, changeSlug, 'tdd-attestations.json');
}

export function readTddAttestationStore(vaultBase, changeSlug) {
  const path = tddAttestationStorePath(vaultBase, changeSlug);
  if (!existsSync(path)) return { schema_version: 1, attestations: [] };
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (cause) {
    throw Object.assign(new Error('tdd-attestations.json is invalid JSON'), {
      code: 'TDD_STORE_INVALID', cause,
    });
  }
  if (parsed?.schema_version !== 1 || !Array.isArray(parsed.attestations)) {
    throw Object.assign(new Error('tdd-attestations.json must use schema_version 1'), {
      code: 'TDD_STORE_INVALID',
    });
  }
  return parsed;
}

export function saveTddAttestation(vaultBase, changeSlug, attestation) {
  const path = tddAttestationStorePath(vaultBase, changeSlug);
  const outcome = withVaultPathLock(vaultBase, path, () => {
    const store = readTddAttestationStore(vaultBase, changeSlug);
    const attestations = store.attestations.filter((item) => item.attestation_id !== attestation.attestation_id);
    attestations.push(attestation);
    attestations.sort((left, right) => String(left.attestation_id).localeCompare(String(right.attestation_id)));
    writeVaultFileAtomic(vaultBase, path, `${JSON.stringify({ schema_version: 1, attestations }, null, 2)}\n`, 'utf8', {
      label: 'TDD attestation store',
    });
    return attestation;
  }, { timeoutMs: 5_000, code: 'TDD_STORE_BUSY' });
  if (typeof outcome === 'symbol') {
    throw Object.assign(new Error('TDD attestation store is busy'), { code: 'TDD_STORE_BUSY' });
  }
  return outcome;
}
