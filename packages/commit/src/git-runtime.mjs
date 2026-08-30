import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { assertPublicText, normalizeCommitInput } from './commit-input.mjs';
import { prepareCommitMessage, renderCommitMessage } from './commit-message.mjs';
import { nativeDesignReference, validateCommitMessage } from './commit-policy.mjs';
import {
  collectCommitSensorProof,
  commitTaskRequirementIds,
  commitTaskSensorIds,
  contentSha256,
  validateCommitProofSet,
} from './proof-validation.mjs';
import { resolveProjectVault } from '../../vault/src/project-vault.mjs';
import {
  captureGitSnapshot,
  resolveEvidenceIdentity,
} from '../../evidence/src/evidence-envelope.mjs';
import { loadSensorsDetailed } from '../../harness/src/sensors-core.mjs';
import { resolveCommandActiveContext } from '../../../src/active-context-runtime.mjs';
import { activeContextKey, resolveActiveContext } from '../../../hooks/active-context-store.mjs';
import { buildEffectiveRequirementPackage } from '../../../hooks/spec-core.mjs';
import { getLocale } from '../../vault/src/locale.mjs';

export const COMMIT_CONTEXT_FILE = 'wendkeep-commit-input.json';

function git(args, { cwd = process.cwd(), binary = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: binary ? null : 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = binary ? result.stderr?.toString('utf8') : result.stderr;
    const error = new Error((stderr || `git ${args.join(' ')} failed`).trim());
    error.code = 'WENDKEEP_COMMIT_GIT_FAILED';
    throw error;
  }
  return result.stdout;
}

export function resolveCommitContextPath({ cwd = process.cwd() } = {}) {
  const raw = String(git(['rev-parse', '--git-path', COMMIT_CONTEXT_FILE], { cwd })).trim();
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

export function collectStagedDiff({ cwd = process.cwd() } = {}) {
  const diff = git(['diff', '--cached', '--binary', '--no-ext-diff', '--no-color'], { cwd, binary: true });
  const names = git(['diff', '--cached', '--name-only', '-z', '--no-renames'], { cwd, binary: true })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  if (!names.length) {
    const error = new Error('staged diff is empty');
    error.code = 'WENDKEEP_COMMIT_EMPTY_INDEX';
    throw error;
  }
  return {
    sha256: createHash('sha256').update(diff).digest('hex'),
    files: names,
  };
}

function sameStagedDiff(left, right) {
  return left?.sha256 === right?.sha256
    && JSON.stringify(left?.files || []) === JSON.stringify(right?.files || []);
}

function policyError(code, message) {
  return Object.assign(new Error(message), { code });
}

function canonicalRef(value, field = 'reference') {
  const ref = String(value || '').replaceAll('\\', '/');
  const segments = ref.split('/');
  if (!ref || isAbsolute(ref) || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw policyError('WENDKEEP_COMMIT_REFERENCE_INVALID', `${field} must be a canonical repository-relative path`);
  }
  assertPublicText(ref, field);
  return ref;
}

function indexFile(ref, { cwd }) {
  const path = canonicalRef(ref);
  try {
    git(['ls-files', '--error-unmatch', '--', path], { cwd });
    return String(git(['show', `:${path}`], { cwd }));
  } catch {
    throw policyError('WENDKEEP_COMMIT_EVIDENCE_UNVERSIONED', `evidence is not versioned in the Git index: ${path}`);
  }
}

function configuredVaultMarkers(cwd) {
  const configPath = resolve(cwd, '.wendkeep.json');
  if (!existsSync(configPath)) return [];
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const raw = typeof config?.vault === 'string' ? config.vault.trim() : '';
    return raw ? [raw.replaceAll('\\', '/'), basename(raw.replaceAll('\\', '/'))].filter(Boolean) : [];
  } catch {
    throw policyError('WENDKEEP_COMMIT_PROJECT_CONFIG_INVALID', '.wendkeep.json is invalid');
  }
}

function assertConfiguredPrivacy(value, { cwd }) {
  const source = String(value ?? '');
  assertPublicText(source, 'commit input');
  const lower = source.toLowerCase();
  for (const marker of configuredVaultMarkers(cwd)) {
    if (marker.length >= 3 && lower.includes(marker.toLowerCase())) {
      throw policyError('WENDKEEP_COMMIT_PRIVATE_PATH', 'commit input references the configured project Vault');
    }
  }
}

function resolveEvidence(input, { cwd }) {
  const entries = input.evidence.map((item) => {
    const content = indexFile(item.ref, { cwd });
    return { ...item, path: item.ref, content, sha256: contentSha256(content) };
  });
  let project = {};
  try { project = JSON.parse(readFileSync(resolve(cwd, '.wendkeep.json'), 'utf8')); } catch { /* authority gate reports invalid binding */ }
  const snapshot = captureGitSnapshot(cwd);
  const sensorIds = commitTaskSensorIds(entries);
  const loaded = loadSensorsDetailed(cwd);
  if (loaded.error) {
    throw policyError('WENDKEEP_COMMIT_SENSOR_CONFIG_INVALID', `wendkeep.sensors.json is invalid: ${loaded.error}`);
  }
  const executionProof = sensorIds.length
    ? collectCommitSensorProof({ sensors: loaded.sensors, ids: sensorIds, cwd })
    : null;
  let governedBinding = {};
  if (entries.some((entry) => entry.kind === 'evidence')) {
    const vault = resolveProjectVault({ startDir: cwd });
    const commandContext = resolveCommandActiveContext({
      vaultBase: vault.base,
      projectRoot: cwd,
      requireExisting: true,
    });
    if (!commandContext) {
      throw policyError('WENDKEEP_COMMIT_BINDING_INCOMPLETE', 'Evidence Envelope requires an active canonical context');
    }
    const active = resolveActiveContext(vault.base, commandContext);
    const changeSlug = String(active.change_slug || '').trim();
    if (!changeSlug) {
      throw policyError('WENDKEEP_COMMIT_BINDING_INCOMPLETE', 'Evidence Envelope requires a causal active change');
    }
    const reqIds = commitTaskRequirementIds(entries);
    const changeDir = join(vault.base, getLocale(vault.base).folders.changes, changeSlug);
    const effective = buildEffectiveRequirementPackage(vault.base, changeDir, reqIds);
    if (effective.errors?.length || effective.missing?.length) {
      throw policyError('WENDKEEP_COMMIT_EFFECTIVE_SPEC_INVALID', 'canonical effective spec is invalid or incomplete');
    }
    const identity = resolveEvidenceIdentity({
      vaultBase: vault.base,
      projectRoot: cwd,
      changeSlug,
      context: commandContext,
    });
    governedBinding = {
      projectId: identity.project_id,
      repositoryId: identity.repository_id,
      worktreeId: identity.worktree_id,
      workSessionId: identity.work_session_id,
      activeContextId: activeContextKey(commandContext),
      changeSlug,
      effectiveSpecSha256: `sha256:${effective.hash}`,
    };
  }
  return validateCommitProofSet({
    entries,
    authority: input.authority,
    stagedHash: input.staged_diff.sha256,
    context: {
      projectId: project.projectId || '',
      changeSlug: input.authority.kind === 'adr' ? input.authority.adr.toLowerCase() : `issue-${input.authority.issue.slice(1)}`,
      branch: snapshot.branch,
      baseSha: snapshot.base_sha,
      headSha: snapshot.head_sha,
      indexTreeSha: snapshot.index_tree_sha,
      worktreeDigest: snapshot.worktree_digest,
      dirty: snapshot.dirty,
      sensorConfigSha256: executionProof?.configSha256,
      executionProof,
      profile: String(project?.harness?.profile || 'OFF').toUpperCase(),
      ...governedBinding,
    },
  });
}

function markdownFiles(root) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) result.push(path);
  }
  return result;
}

function verifyNativeAuthority(input, { cwd }) {
  const configPath = resolve(cwd, '.wendkeep.json');
  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
  catch { throw policyError('WENDKEEP_COMMIT_NATIVE_PROFILE_REQUIRED', 'native authority requires a valid project binding'); }
  if (String(config?.harness?.profile || '').toUpperCase() !== 'OFF') {
    throw policyError('WENDKEEP_COMMIT_NATIVE_PROFILE_REQUIRED', 'native authority is permitted only under observed profile OFF');
  }
  const branch = String(git(['branch', '--show-current'], { cwd })).trim();
  let vault = null;
  try { vault = resolveProjectVault({ startDir: cwd }); }
  catch (error) {
    if (!['WENDKEEP_VAULT_MARKER_MISSING', 'WENDKEEP_VAULT_UNCONFIGURED'].includes(error?.code)) throw error;
  }
  if (vault) {
    const registryPath = join(vault.base, '.brain', 'SESSION_REGISTRY.json');
    if (existsSync(registryPath)) {
      let registry;
      try { registry = JSON.parse(readFileSync(registryPath, 'utf8')); }
      catch { throw policyError('WENDKEEP_COMMIT_CAUSAL_CONTEXT_INVALID', 'Keep Core active-context registry is invalid'); }
      const contexts = Object.values(registry?.active_contexts || {}).filter((context) => (
        context?.state === 'active' && context?.branch === branch
      ));
      if (contexts.some((context) => context.change_slug || context.delivery_id
        || context?.operating_profile_task?.state === 'active')) {
        throw policyError('WENDKEEP_COMMIT_CAUSAL_AUTHORITY_EXISTS', 'active causal change, delivery, or profile lease exists');
      }
    }
    const decisions = join(vault.base, '04-Decisões');
    for (const path of markdownFiles(decisions)) {
      const text = readFileSync(path, 'utf8');
      if (text.includes(input.authority.issue) && text.includes(basename(input.authority.design))) {
        throw policyError('WENDKEEP_COMMIT_CAUSAL_AUTHORITY_EXISTS', 'a causal ADR already exists for the native issue/design');
      }
    }
  }
  const adrPaths = String(git(['ls-files', '*ADR-*.md', '*adr-*.md'], { cwd })).split(/\r?\n/).filter(Boolean);
  for (const path of adrPaths) {
    const content = indexFile(path, { cwd });
    if (content.includes(input.authority.issue) && content.includes(basename(input.authority.design))) {
      throw policyError('WENDKEEP_COMMIT_CAUSAL_AUTHORITY_EXISTS', 'a versioned causal ADR already exists');
    }
  }
}

export function buildCommitInput(draft, { cwd = process.cwd() } = {}) {
  const stagedDiff = collectStagedDiff({ cwd });
  assertConfiguredPrivacy(JSON.stringify(draft), { cwd });
  if (draft?.staged_diff && !sameStagedDiff(draft.staged_diff, stagedDiff)) {
    const error = new Error('provided staged_diff does not match the current Git index');
    error.code = 'WENDKEEP_COMMIT_STALE_INPUT';
    throw error;
  }
  const draftInput = normalizeCommitInput({ ...draft, staged_diff: stagedDiff }, { resolved: false });
  if (draftInput.authority.kind === 'native') {
    try { git(['ls-files', '--error-unmatch', '--', draftInput.authority.design], { cwd }); }
    catch {
      throw policyError('WENDKEEP_COMMIT_DESIGN_UNVERSIONED', `native authority design is not versioned: ${draftInput.authority.design}`);
    }
    verifyNativeAuthority(draftInput, { cwd });
  }
  const proofs = resolveEvidence(draftInput, { cwd });
  const input = normalizeCommitInput({
    ...draftInput,
    evidence: proofs.evidence,
    tasks: proofs.tasks,
    tests: proofs.tests,
  }, { resolved: true });
  assertConfiguredPrivacy(JSON.stringify(input), { cwd });
  return input;
}

export function writeCommitContext(draft, { cwd = process.cwd() } = {}) {
  const input = buildCommitInput(draft, { cwd });
  const path = resolveCommitContextPath({ cwd });
  assertConfiguredPrivacy(JSON.stringify(input), { cwd });
  writeFileSync(path, `${JSON.stringify(input, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { path, input };
}

export function readCommitContext({ cwd = process.cwd(), required = false } = {}) {
  const path = resolveCommitContextPath({ cwd });
  if (!existsSync(path)) {
    if (required) {
      const error = new Error('commit context is missing; run `wendkeep commit context --input <file>`');
      error.code = 'WENDKEEP_COMMIT_CONTEXT_MISSING';
      throw error;
    }
    return { path, input: null };
  }
  const input = normalizeCommitInput(JSON.parse(readFileSync(path, 'utf8')), { resolved: true });
  assertConfiguredPrivacy(JSON.stringify(input), { cwd });
  const stagedDiff = collectStagedDiff({ cwd });
  if (!sameStagedDiff(input.staged_diff, stagedDiff)) {
    const error = new Error('commit context is stale for the current Git index');
    error.code = 'WENDKEEP_COMMIT_STALE_INPUT';
    throw error;
  }
  return { path, input };
}

export function clearCommitContext({ cwd = process.cwd() } = {}) {
  const path = resolveCommitContextPath({ cwd });
  const existed = existsSync(path);
  if (existed) rmSync(path, { force: true });
  return { path, cleared: existed };
}

function isWithin(path, parent) {
  const canonical = (value) => {
    try { return realpathSync.native(resolve(value)); } catch { return resolve(value); }
  };
  const rel = relative(canonical(parent), canonical(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveMessageFile(messageFile, { cwd }) {
  if (!messageFile) throw policyError('WENDKEEP_COMMIT_ARGUMENT', '--message-file is required');
  const candidate = resolve(cwd, messageFile);
  const root = String(git(['rev-parse', '--show-toplevel'], { cwd })).trim();
  const gitDir = String(git(['rev-parse', '--absolute-git-dir'], { cwd })).trim();
  if (!isWithin(candidate, root) && !isWithin(candidate, gitDir)) {
    throw policyError('WENDKEEP_COMMIT_MESSAGE_PATH_OUTSIDE_REPOSITORY', '--message-file must stay inside the repository or Git directory');
  }
  return candidate;
}

function trivialMessageForFiles(message, files) {
  const subject = String(message || '').split(/\r?\n/, 1)[0];
  const docsPath = (path) => /^(?:docs\/|README(?:\.en)?\.md$|[^/]+\.md$)/.test(path);
  const testPath = (path) => /^(?:tests?\/|fixtures?\/)/.test(path) || /(?:^|\/)__tests__\//.test(path);
  if (/^docs(?:\([^)]*\))?:/.test(subject)) return files.length > 0 && files.every(docsPath);
  if (/^test(?:\([^)]*\))?:/.test(subject)) return files.length > 0 && files.every(testPath);
  if (/^chore(?:\([^)]*\))?:/.test(subject)) return files.length > 0 && files.every((file) => docsPath(file) || testPath(file));
  return false;
}

function unchangedGovernedAmend(message, { cwd }) {
  const previous = git(['log', '-1', '--format=%B'], { cwd });
  const diff = spawnSync('git', ['diff', '--cached', '--quiet', 'HEAD', '--'], { cwd, windowsHide: true });
  return diff.status === 0
    && String(previous).replace(/\r\n?/g, '\n').trimEnd() === String(message).replace(/\r\n?/g, '\n').trimEnd();
}

export function prepareCommitMessageFile({
  messageFile,
  source = '',
  cwd = process.cwd(),
} = {}) {
  const path = resolveMessageFile(messageFile, { cwd });
  const current = readFileSync(path, 'utf8');
  if (['merge', 'squash', 'commit'].includes(source)) {
    const cleared = clearCommitContext({ cwd }).cleared;
    return { changed: false, skipped: source, contextCleared: cleared };
  }
  const { input } = readCommitContext({ cwd, required: false });
  if (!input) return { changed: false, skipped: 'no-context' };
  const prepared = prepareCommitMessage(current, input, { source: '' });
  if (prepared !== current) writeFileSync(path, prepared, 'utf8');
  return { changed: prepared !== current, skipped: '' };
}

export function validateCommitMessageFile({
  messageFile,
  consumeContext = false,
  cwd = process.cwd(),
} = {}) {
  const path = resolveMessageFile(messageFile, { cwd });
  const message = readFileSync(path, 'utf8');
  assertConfiguredPrivacy(message, { cwd });
  const result = validateCommitMessage(message);
  if (consumeContext && result.governed) {
    try {
      const { input } = readCommitContext({ cwd, required: true });
      if (message.replace(/\r\n?/g, '\n') !== renderCommitMessage(input)) {
        result.ok = false;
        result.errors.push('WENDKEEP_COMMIT_CONTEXT_MISMATCH: message does not match the current staged context');
      }
    } catch (error) {
      if (!unchangedGovernedAmend(message, { cwd })) {
        result.ok = false;
        result.errors.push(`${error.code || 'WENDKEEP_COMMIT_CONTEXT_INVALID'}: ${error.message}`);
      }
    }
  } else if (consumeContext && !result.governed && existsSync(resolveCommitContextPath({ cwd }))) {
    result.ok = false;
    result.errors.push('WENDKEEP_COMMIT_CONTEXT_UNUSED: non-governed commit cannot leave a prepared context pending');
  }
  if (consumeContext && !result.governed) {
    const mergePath = String(git(['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd })).trim();
    const mergeInProgress = existsSync(isAbsolute(mergePath) ? mergePath : resolve(cwd, mergePath));
    if (!mergeInProgress) {
      try {
        const staged = collectStagedDiff({ cwd });
        if (!trivialMessageForFiles(message, staged.files)) {
          result.ok = false;
          result.errors.push('WENDKEEP_COMMIT_PRODUCT_CHANGE_UNGOVERNED');
        }
      } catch (error) {
        if (error.code !== 'WENDKEEP_COMMIT_EMPTY_INDEX') throw error;
      }
    }
  }
  const design = nativeDesignReference(message);
  if (result.ok && design) {
    try {
      git(['ls-files', '--error-unmatch', '--', design], { cwd });
    } catch {
      result.ok = false;
      result.errors.push(`WENDKEEP_COMMIT_DESIGN_UNVERSIONED: ${design}`);
    }
  }
  if (result.ok && consumeContext && result.governed) clearCommitContext({ cwd });
  return result;
}
