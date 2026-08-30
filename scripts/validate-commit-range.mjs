#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  messageEvidence, messageScope, messageTasks, messageTests, nativeDesignReference, validateCommitMessage,
} from '../packages/commit/src/index.mjs';
import {
  collectCommitSensorProof,
  commitTaskSensorIds,
  parseSignedEvidenceRef,
  validateCommitProofSet,
} from '../packages/commit/src/proof-validation.mjs';

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || '';
  return argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function git(args, { binary = false, allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    encoding: binary ? null : 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    process.stderr.write((binary ? result.stderr?.toString('utf8') : result.stderr) || `git ${args.join(' ')} failed\n`);
    process.exit(2);
  }
  return result;
}
const text = (args, options) => String(git(args, options).stdout || '');
const objectExists = (specifier) => git(['cat-file', '-e', specifier], { allowFailure: true }).status === 0;
const parents = (sha) => text(['show', '-s', '--format=%P', sha]).trim().split(/\s+/).filter(Boolean);

function commitDiff(sha) {
  const parent = parents(sha)[0];
  const args = parent
    ? ['diff', '--binary', '--no-ext-diff', '--no-color', parent, sha]
    : ['show', '--format=', '--binary', '--no-ext-diff', '--no-color', sha];
  return git(args, { binary: true }).stdout;
}

function changedFiles(sha) {
  const parent = parents(sha)[0];
  const args = parent
    ? ['diff', '--name-only', '-z', '--no-renames', parent, sha]
    : ['diff-tree', '--root', '--no-commit-id', '--name-only', '-z', '-r', sha];
  return text(args).split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/'))
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function scopeFor(sha) {
  return { sha256: createHash('sha256').update(commitDiff(sha)).digest('hex'), files: changedFiles(sha) };
}

const docsPath = (path) => /^(?:docs\/|README(?:\.en)?\.md$|[^/]+\.md$)/.test(path);
const testPath = (path) => /^(?:tests?\/|fixtures?\/)/.test(path) || /(?:^|\/)__tests__\//.test(path);
function trivialCommit(subject, files) {
  if (!files.length) return false;
  if (/^docs(?:\([^)]*\))?:/.test(subject)) return files.every(docsPath);
  if (/^test(?:\([^)]*\))?:/.test(subject)) return files.every(testPath);
  if (/^chore(?:\([^)]*\))?:/.test(subject)) return files.every((path) => docsPath(path) || testPath(path));
  return false;
}

function mergeErrors(sha, message) {
  const commitParents = parents(sha);
  if (commitParents.length < 2 || !/^Merge\b/.test(message.split(/\r?\n/, 1)[0])) {
    return ['merge commit must have multiple parents and a canonical Merge subject'];
  }
  const errors = [];
  for (const path of changedFiles(sha)) {
    const mergeObject = text(['rev-parse', `${sha}:${path}`], { allowFailure: true }).trim();
    if (!mergeObject) continue;
    const inherited = commitParents.some((parent) => (
      text(['rev-parse', `${parent}:${path}`], { allowFailure: true }).trim() === mergeObject
    ));
    if (!inherited) errors.push(`WENDKEEP_COMMIT_MERGE_RESOLUTION_UNGOVERNED: ${path}`);
  }
  return errors;
}

function commitJson(sha, path) {
  try { return JSON.parse(text(['show', `${sha}:${path}`])); } catch { return null; }
}

function collectSensorsAtCommit(sha, entries) {
  const ids = commitTaskSensorIds(entries);
  if (!ids.length) return null;
  const config = commitJson(sha, 'wendkeep.sensors.json');
  if (!config || !Array.isArray(config.sensors)) {
    throw Object.assign(new Error('versioned wendkeep.sensors.json is required'), {
      code: 'WENDKEEP_COMMIT_SENSOR_CONFIG_MISSING',
    });
  }
  const parent = mkdtempSync(join(tmpdir(), 'wendkeep-commit-range-'));
  const checkout = join(parent, 'checkout');
  const added = git(['worktree', 'add', '--detach', '--force', checkout, sha], { allowFailure: true });
  if (added.status !== 0) {
    rmSync(parent, { recursive: true, force: true });
    throw Object.assign(new Error(String(added.stderr || 'temporary commit checkout failed').trim()), {
      code: 'WENDKEEP_COMMIT_CHECKOUT_FAILED',
    });
  }
  try {
    return collectCommitSensorProof({ sensors: config.sensors, ids, cwd: checkout });
  } finally {
    git(['worktree', 'remove', '--force', checkout], { allowFailure: true });
    const bounded = resolve(parent);
    if (bounded.startsWith(resolve(tmpdir()))) rmSync(bounded, { recursive: true, force: true });
  }
}

function evidenceErrors(sha, message, scope) {
  const errors = [];
  const evidence = messageEvidence(message);
  const entries = [];
  for (const item of evidence) {
    if (item.status !== 'verified' || ['evidence', 'receipt', 'verdict'].includes(item.kind)) {
      errors.push('WENDKEEP_COMMIT_REMOTE_PROOF_UNAVAILABLE');
      continue;
    }
    let signed;
    try { signed = parseSignedEvidenceRef(item.ref); }
    catch (error) { errors.push(error.code || error.message); continue; }
    if (!objectExists(`${sha}:${signed.path}`)) {
      errors.push(`WENDKEEP_COMMIT_EVIDENCE_UNVERSIONED: ${signed.path}`);
      continue;
    }
    entries.push({ kind: item.kind, path: signed.path, sha256: signed.sha256, content: text(['show', `${sha}:${signed.path}`]) });
    if (item.status !== 'verified') errors.push(`WENDKEEP_COMMIT_EVIDENCE_STATUS_INVALID: ${signed.path}`);
  }
  const adr = message.match(/^ADR:\s*(ADR-\d{4,})$/m)?.[1] || '';
  const design = nativeDesignReference(message);
  const authority = adr
    ? { kind: 'adr', adr, ref: entries.find((entry) => entry.kind === 'adr')?.path || '', issue: message.match(/^Refs:\s*(#\d+)$/m)?.[1] || '' }
    : { kind: 'native', issue: message.match(/^Issue:\s*(#\d+)$/m)?.[1] || '', design };
  try {
    const config = commitJson(sha, '.wendkeep.json') || {};
    const executionProof = collectSensorsAtCommit(sha, entries);
    const snapshot = {
      head_sha: parents(sha)[0] || sha,
      index_tree_sha: text(['show', '-s', '--format=%T', sha]).trim(),
    };
    const resolved = validateCommitProofSet({
      entries, authority, stagedHash: scope.sha256,
      context: {
        projectId: config.projectId || '',
        changeSlug: adr ? adr.toLowerCase() : `issue-${authority.issue.slice(1)}`,
        baseSha: snapshot.base_sha,
        headSha: snapshot.head_sha,
        indexTreeSha: snapshot.index_tree_sha,
        worktreeDigest: snapshot.worktree_digest,
        dirty: snapshot.dirty,
        sensorConfigSha256: executionProof?.configSha256,
        executionProof,
        profile: String(config?.harness?.profile || 'OFF').toUpperCase(),
      },
    });
    if (JSON.stringify(messageTasks(message)) !== JSON.stringify(resolved.tasks)) errors.push('WENDKEEP_COMMIT_TASKS_MISMATCH');
    if (JSON.stringify(messageTests(message)) !== JSON.stringify(resolved.tests)) errors.push('WENDKEEP_COMMIT_TESTS_MISMATCH');
  } catch (error) {
    errors.push(`${error.code || 'WENDKEEP_COMMIT_EVIDENCE_UNVERIFIED'}: ${error.message}`);
  }
  return errors;
}

function authorityErrors(sha, message) {
  const errors = [];
  const design = nativeDesignReference(message);
  if (!design) return errors;
  if (!objectExists(`${sha}:${design}`)) return [`WENDKEEP_COMMIT_DESIGN_UNVERSIONED: ${design}`];
  const issue = message.match(/^Issue:\s*(#\d+)$/m)?.[1] || '';
  const content = text(['show', `${sha}:${design}`]);
  if (!content.includes(issue)) errors.push('WENDKEEP_COMMIT_NATIVE_ISSUE_UNVERIFIED');
  const config = commitJson(sha, '.wendkeep.json');
  if (String(config?.harness?.profile || '').toUpperCase() !== 'OFF') errors.push('WENDKEEP_COMMIT_NATIVE_PROFILE_REQUIRED');
  const adrPaths = text(['ls-tree', '-r', '--name-only', sha]).split(/\r?\n/)
    .filter((path) => /ADR-\d+.*\.md$/i.test(path));
  if (adrPaths.some((path) => {
    const adr = text(['show', `${sha}:${path}`]);
    return adr.includes(issue) && adr.includes(design.split('/').at(-1));
  })) errors.push('WENDKEEP_COMMIT_CAUSAL_AUTHORITY_EXISTS');
  return errors;
}

function configuredPrivacyErrors(sha, message) {
  const config = commitJson(sha, '.wendkeep.json');
  const vault = typeof config?.vault === 'string' ? config.vault.replaceAll('\\', '/').trim() : '';
  if (!vault) return [];
  const name = vault.split('/').filter(Boolean).at(-1) || '';
  const lower = message.toLowerCase();
  return [vault, name].some((marker) => marker.length >= 3 && lower.includes(marker.toLowerCase()))
    ? ['WENDKEEP_COMMIT_PRIVATE_PATH: message references the configured project Vault'] : [];
}

const base = option(process.argv.slice(2), '--base') || process.env.WENDKEEP_COMMIT_BASE || '';
const head = option(process.argv.slice(2), '--head') || process.env.WENDKEEP_COMMIT_HEAD || 'HEAD';
if (!base) {
  process.stderr.write('WENDKEEP_COMMIT_ARGUMENT: --base is required\n');
  process.exit(2);
}

const commits = text(['rev-list', '--reverse', `${base}..${head}`]).trim().split(/\r?\n/).filter(Boolean);
const failures = [];
for (const sha of commits) {
  const message = text(['show', '-s', '--format=%B', sha]);
  const subject = message.split(/\r?\n/, 1)[0];
  const commitParents = parents(sha);
  const errors = [...configuredPrivacyErrors(sha, message)];
  if (commitParents.length > 1) {
    errors.push(...mergeErrors(sha, message));
  } else {
    const result = validateCommitMessage(message);
    errors.push(...result.errors);
    if (messageEvidence(message).some((item) => (
      item.status !== 'verified' || ['evidence', 'receipt', 'verdict'].includes(item.kind)
    ))) errors.push('WENDKEEP_COMMIT_REMOTE_PROOF_UNAVAILABLE');
    const files = changedFiles(sha);
    if (!result.governed && !trivialCommit(subject, files)) errors.push('WENDKEEP_COMMIT_PRODUCT_CHANGE_UNGOVERNED');
    if (result.governed && result.ok) {
      const expected = scopeFor(sha);
      const observed = messageScope(message);
      if (expected.sha256 !== observed.sha256 || JSON.stringify(expected.files) !== JSON.stringify(observed.files)) {
        errors.push('WENDKEEP_COMMIT_SCOPE_MISMATCH');
      }
      errors.push(...evidenceErrors(sha, message, expected), ...authorityErrors(sha, message));
    }
  }
  if (errors.length) failures.push({ sha, subject, errors: [...new Set(errors)] });
}

if (failures.length) {
  process.stderr.write(`WENDKEEP_COMMIT_RANGE_INVALID: ${failures.length} invalid commit(s)\n`);
  for (const failure of failures) {
    process.stderr.write(`${failure.sha.slice(0, 12)} ${failure.subject}\n`);
    for (const error of failure.errors) process.stderr.write(`  - ${error}\n`);
  }
  process.exit(1);
}
process.stdout.write(`${commits.length} commit(s) valid\n`);
