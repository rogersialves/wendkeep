import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * External provenance is deliberately collected in this module and kept
 * separate from the pure gate. Every command receives an argument array and
 * an explicit non-shell option. The default commands are replaceable in tests
 * and by callers that already have an authenticated client.
 */

const SOURCE_TIMEOUT_MS = 15_000;
const SAFE_REF = /^(?!-)[A-Za-z0-9_./@^~:+-]+$/;
const SAFE_PACKAGE = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/;
const GITHUB_HOSTS = new Set(['github.com', 'api.github.com']);

function result(kind, state, fields = {}) {
  return {
    kind,
    state,
    ok: state === 'verified',
    reasonCodes: [],
    diagnostics: [],
    ...fields,
  };
}

function failure(kind, state, code, fields = {}) {
  return result(kind, state, {
    reasonCodes: [code],
    diagnostics: [{ code }],
    ...fields,
  });
}

function commandOptions(cwd) {
  return {
    cwd,
    encoding: 'utf8',
    timeout: SOURCE_TIMEOUT_MS,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

function outputOf(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value && typeof value === 'object' && Object.hasOwn(value, 'stdout')) {
    return outputOf(value.stdout);
  }
  return String(value ?? '');
}

function parseJsonOutput(raw) {
  const text = outputOf(raw).trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // npm and gh may print a warning before JSON. Do not return the warning;
    // only parse a complete JSON value from the first object/array boundary.
    const starts = [text.indexOf('{'), text.indexOf('[')].filter((index) => index >= 0);
    const start = starts.length ? Math.min(...starts) : -1;
    if (start < 0) return undefined;
    const endObject = text.lastIndexOf('}');
    const endArray = text.lastIndexOf(']');
    const end = Math.max(endObject, endArray);
    if (end < start) return undefined;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function executeFile(execute, command, args, cwd) {
  return execute(command, args, commandOptions(cwd));
}

function executeGithubApi(execute, path) {
  return executeFile(execute, 'gh', ['api', '--hostname', 'github.com', path], undefined);
}

function safeRef(ref) {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 512 && SAFE_REF.test(ref);
}

function safePath(path) {
  return typeof path === 'string'
    && path.length > 0
    && !path.startsWith('/')
    && !path.includes('..')
    && !/[\u0000-\u001f\u007f]/.test(path);
}

function safePackageName(name) {
  return typeof name === 'string' && name.length <= 214 && SAFE_PACKAGE.test(name);
}

function safeVersion(version) {
  return typeof version === 'string' && version.length > 0 && version.length <= 128
    && !/[\s\u0000-\u001f\u007f]/.test(version);
}

function safeTag(tag) {
  return typeof tag === 'string' && tag.length > 0 && tag.length <= 256 && safeRef(tag);
}

function errorCode(error) {
  const code = String(error?.code || '').toUpperCase();
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ABORT_ERR') {
    return 'PROVENANCE_SOURCE_TIMEOUT';
  }
  return 'PROVENANCE_SOURCE_UNAVAILABLE';
}

function normalizeRepository(repository) {
  if (typeof repository !== 'string') return '';
  let value = repository.trim();
  if (!value) return '';
  if (value.startsWith('git+')) value = value.slice(4);
  const scp = value.match(/^git@([^:]+):(.+)$/i);
  if (scp) {
    if (scp[1].toLowerCase() !== 'github.com') return '';
    value = scp[2];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (!['git:', 'http:', 'https:', 'ssh:'].includes(url.protocol)
        || url.hostname.toLowerCase() !== 'github.com') return '';
      value = url.pathname.replace(/^\//, '');
    } catch {
      return '';
    }
  }
  value = value.replace(/\/$/, '').replace(/\.git$/i, '');
  const match = value.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/);
  if (!match || match[1].endsWith('-') || match[2] === '.' || match[2] === '..') return '';
  return value;
}

function repositoryFromPath(pathname) {
  const match = String(pathname).match(/^\/repos\/([^/]+\/[^/]+)(?:\/|$)/);
  return match ? match[1] : '';
}

function parseGithubLocator(locator, expectedRepository) {
  const expected = normalizeRepository(expectedRepository);
  if (!expected) return { state: 'unproven', code: 'PROVENANCE_REPOSITORY_MISSING' };

  if (locator && typeof locator === 'object' && !Array.isArray(locator)) {
    if (locator.repository && normalizeRepository(locator.repository) !== expected) {
      return { state: 'conflict', code: 'PROVENANCE_REPOSITORY_MISMATCH' };
    }
    if (locator.url !== undefined) return parseGithubLocator(locator.url, expected);
    if (locator.apiPath !== undefined) return parseGithubLocator(locator.apiPath, expected);
    const runId = String(locator.runId ?? locator.run_id ?? '').trim();
    if (/^[0-9]+$/.test(runId)) {
      return { state: 'ok', repository: expected, path: `/repos/${expected}/actions/runs/${runId}` };
    }
    return { state: 'reported', code: 'PROVENANCE_LOCATOR_INVALID' };
  }

  if (typeof locator !== 'string' || !locator.trim()) {
    return { state: 'unproven', code: 'PROVENANCE_LOCATOR_MISSING' };
  }
  const value = locator.trim();
  if (value.startsWith('/repos/')) {
    const repository = repositoryFromPath(value);
    if (!repository) return { state: 'reported', code: 'PROVENANCE_LOCATOR_INVALID' };
    if (repository !== expected) return { state: 'conflict', code: 'PROVENANCE_REPOSITORY_MISMATCH' };
    if (!/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/[0-9]+(?:$|[/?])/.test(value)) {
      return { state: 'reported', code: 'PROVENANCE_LOCATOR_INVALID' };
    }
    return { state: 'ok', repository, path: value.split('?')[0] };
  }
  if (!value.startsWith('http://') && !value.startsWith('https://')) {
    return { state: 'reported', code: 'PROVENANCE_LOCATOR_INVALID' };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return { state: 'reported', code: 'PROVENANCE_LOCATOR_INVALID' };
  }
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) {
    return { state: 'conflict', code: 'PROVENANCE_REPOSITORY_MISMATCH' };
  }
  const actions = url.pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/runs\/([0-9]+)(?:\/|$)/);
  const apiRepository = actions ? `${actions[1]}/${actions[2]}` : '';
  if (!actions || !apiRepository) return { state: 'reported', code: 'PROVENANCE_LOCATOR_INVALID' };
  if (apiRepository !== expected) return { state: 'conflict', code: 'PROVENANCE_REPOSITORY_MISMATCH' };
  return { state: 'ok', repository: apiRepository, path: `/repos/${apiRepository}/actions/runs/${actions[3]}` };
}

function sourceError(kind, error, fields = {}) {
  return failure(kind, 'reported', errorCode(error), fields);
}

function mismatch(kind, code, fields = {}) {
  return failure(kind, 'conflict', code, fields);
}

function parsePackage(raw) {
  const packageJson = parseJsonOutput(raw);
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) return undefined;
  const name = String(packageJson.name || '');
  const version = String(packageJson.version || '');
  if (!safePackageName(name) || !safeVersion(version)) return undefined;
  return { name, version };
}

function extractNotes(changelog, version) {
  const lines = String(changelog || '').split(/\r?\n/);
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^##\\s*\\[${escaped}\\]\\s*[—–-]`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return undefined;
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s*\[/.test(lines[index])) break;
    body.push(lines[index]);
  }
  return body.join('\n').trim();
}

/** Read a tracked file from a commit/ref. This never reads the worktree. */
export function readTextAtCommit(repoRoot, ref, path, { execute = execFileSync } = {}) {
  if (!safeRef(ref)) throw new Error('unsafe git ref');
  if (!safePath(path)) throw new Error('unsafe git path');
  return outputOf(executeFile(execute, 'git', [
    'cat-file', 'blob', `${ref}:${path}`,
  ], repoRoot));
}

export function readJsonAtCommit(repoRoot, ref, path, options = {}) {
  const text = readTextAtCommit(repoRoot, ref, path, options);
  const parsed = parseJsonOutput(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid tracked JSON');
  return parsed;
}

/**
 * Resolve source and target, then read package/changelog from targetRef. The
 * target subject is therefore stable even if the caller's worktree differs.
 */
export function collectGitSubject({
  repoRoot,
  sourceRef = '',
  targetRef,
  execute = execFileSync,
} = {}) {
  const kind = 'git-subject';
  if (!repoRoot || !safeRef(targetRef) || (sourceRef && !safeRef(sourceRef))) {
    return failure(kind, 'unproven', 'PROVENANCE_GIT_REF_INVALID');
  }
  let sourceCommit = '';
  let targetCommit = '';
  try {
    if (sourceRef) sourceCommit = outputOf(executeFile(execute, 'git', [
      'rev-parse', '--verify', '--end-of-options', `${sourceRef}^{commit}`,
    ], repoRoot)).trim();
    targetCommit = outputOf(executeFile(execute, 'git', [
      'rev-parse', '--verify', '--end-of-options', `${targetRef}^{commit}`,
    ], repoRoot)).trim();
  } catch (error) {
    return sourceError(kind, error, { sourceRef, targetRef });
  }
  if (!/^[0-9a-f]{40}$/i.test(targetCommit) || (sourceRef && !/^[0-9a-f]{40}$/i.test(sourceCommit))) {
    return failure(kind, 'unproven', 'PROVENANCE_GIT_SUBJECT_UNRESOLVED', { sourceRef, targetRef });
  }
  let packageJson;
  let changelog;
  try {
    packageJson = readJsonAtCommit(repoRoot, targetCommit, 'package.json', { execute });
    changelog = readTextAtCommit(repoRoot, targetCommit, 'CHANGELOG.md', { execute });
  } catch (error) {
    return failure(kind, 'unproven', 'PROVENANCE_TARGET_ARTIFACT_MISSING', {
      sourceRef, targetRef, sourceCommit, targetCommit,
    });
  }
  const pkg = parsePackage(JSON.stringify(packageJson));
  if (!pkg) return failure(kind, 'unproven', 'PROVENANCE_PACKAGE_INVALID', { sourceRef, targetRef, sourceCommit, targetCommit });
  const notes = extractNotes(changelog, pkg.version);
  if (notes === undefined) return failure(kind, 'unproven', 'PROVENANCE_CHANGELOG_VERSION_MISSING', {
    sourceRef,
    targetRef,
    sourceCommit,
    targetCommit,
    commit: targetCommit,
    package: pkg,
    name: pkg.name,
    version: pkg.version,
  });
  return result(kind, 'verified', {
    sourceRef,
    targetRef,
    sourceCommit,
    targetCommit,
    commit: targetCommit,
    package: pkg,
    name: pkg.name,
    version: pkg.version,
    changelog,
    notes,
  });
}

export function collectCiObservation({
  locator,
  repository,
  expectedCommit,
  execute = execFileSync,
} = {}) {
  const kind = 'ci';
  if (!expectedCommit || !/^[0-9a-f]{40}$/i.test(String(expectedCommit))) {
    return failure(kind, 'unproven', 'PROVENANCE_COMMIT_MISSING');
  }
  const parsed = parseGithubLocator(locator, repository);
  if (parsed.state !== 'ok') return failure(kind, parsed.state, parsed.code, { repository: normalizeRepository(repository) });
  try {
    const raw = executeGithubApi(execute, parsed.path);
    const response = parseJsonOutput(raw);
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      return failure(kind, 'reported', 'PROVENANCE_SOURCE_UNAVAILABLE', { repository: parsed.repository });
    }
    const observedRepository = normalizeRepository(response.repository?.full_name
      || response.head_repository?.full_name || parsed.repository);
    if (observedRepository && observedRepository !== parsed.repository) {
      return mismatch(kind, 'PROVENANCE_REPOSITORY_MISMATCH', { repository: parsed.repository, observedRepository });
    }
    const commit = String(response.head_sha || response.head_commit?.id || response.commit || '').trim();
    if (!commit) return failure(kind, 'reported', 'PROVENANCE_COMMIT_UNOBSERVED', { repository: parsed.repository });
    if (commit !== expectedCommit) return mismatch(kind, 'PROVENANCE_COMMIT_MISMATCH', { repository: parsed.repository, commit, expectedCommit });
    if (!response.conclusion) {
      return failure(kind, 'reported', 'PROVENANCE_CI_CONCLUSION_UNOBSERVED', { repository: parsed.repository, commit });
    }
    if (String(response.conclusion).toLowerCase() !== 'success') {
      return mismatch(kind, 'PROVENANCE_CI_NOT_SUCCESS', { repository: parsed.repository, commit });
    }
    if (String(response.status || '').toLowerCase() !== 'completed') {
      return failure(kind, 'reported', 'PROVENANCE_CI_INCOMPLETE', { repository: parsed.repository, commit });
    }
    return result(kind, 'verified', {
      repository: parsed.repository,
      locator: parsed.path,
      commit,
      conclusion: response.conclusion,
      status: 'success',
      workflow_status: 'completed',
      observed: {
        repository: parsed.repository, commit, conclusion: response.conclusion,
        status: 'success', workflow_status: 'completed',
      },
    });
  } catch (error) {
    return sourceError(kind, error, { repository: parsed.repository, locator: parsed.path });
  }
}

export function collectTagObservation({
  repoRoot,
  tag,
  expectedCommit,
  execute = execFileSync,
} = {}) {
  const kind = 'tag';
  if (!repoRoot || !safeTag(tag) || !expectedCommit) return failure(kind, 'unproven', 'PROVENANCE_TAG_INPUT_INVALID');
  const tagRef = `refs/tags/${tag}`;
  try {
    const commit = outputOf(executeFile(execute, 'git', [
      'rev-parse', '--verify', '--end-of-options', `${tagRef}^{commit}`,
    ], repoRoot)).trim();
    if (!/^[0-9a-f]{40}$/i.test(commit)) return failure(kind, 'unproven', 'PROVENANCE_TAG_UNRESOLVED', { tag });
    if (commit !== expectedCommit) return mismatch(kind, 'PROVENANCE_COMMIT_MISMATCH', { tag, commit, expectedCommit });
    return result(kind, 'verified', { tag, commit, expectedCommit, observed: { tag, commit } });
  } catch (error) {
    return failure(kind, 'unproven', errorCode(error), { tag });
  }
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function collectNpmObservation({
  name,
  version,
  expectedIntegrity,
  expectedCommit,
  repository,
  execute = execFileSync,
} = {}) {
  const kind = 'npm';
  if (!safePackageName(name) || !safeVersion(version)) return failure(kind, 'unproven', 'PROVENANCE_PACKAGE_INPUT_INVALID');
  if (!expectedIntegrity) return failure(kind, 'unproven', 'PROVENANCE_INTEGRITY_MISSING', { name, version });
  const expectedRepository = normalizeRepository(repository);
  if (!expectedRepository || !/^[0-9a-f]{40}$/i.test(String(expectedCommit || ''))) {
    return failure(kind, 'unproven', 'PROVENANCE_NPM_BINDING_MISSING', { name, version });
  }
  const cacheRoot = mkdtempSync(join(tmpdir(), 'wendkeep-npm-provenance-'));
  try {
    const raw = executeFile(execute, npmCommand(), [
      'view', `${name}@${version}`, 'name', 'version', 'dist.integrity', 'gitHead', 'repository',
      '--json',
      '--registry=https://registry.npmjs.org/',
      '--cache', cacheRoot,
      '--prefer-online',
      '--fetch-retries=0',
    ], undefined);
    const response = parseJsonOutput(raw);
    const observedIntegrity = typeof response === 'string'
      ? response
      : String(response?.dist?.integrity || response?.integrity || '');
    const observedName = String(response?.name || '');
    const observedVersion = String(response?.version || '');
    const commit = String(response?.gitHead || response?.git_head || '').trim();
    const observedRepository = normalizeRepository(response?.repository?.url || response?.repository || '');
    if (observedName && observedName !== name) return mismatch(kind, 'PROVENANCE_PACKAGE_MISMATCH', { name, version, observedName });
    if (observedVersion && observedVersion !== version) return mismatch(kind, 'PROVENANCE_VERSION_MISMATCH', { name, version, observedVersion });
    if (!observedIntegrity) return failure(kind, 'reported', 'PROVENANCE_INTEGRITY_UNOBSERVED', { name, version });
    if (observedIntegrity !== expectedIntegrity) return mismatch(kind, 'PROVENANCE_INTEGRITY_MISMATCH', { name, version, observedIntegrity, expectedIntegrity });
    if (!commit || !observedRepository) return failure(kind, 'reported', 'PROVENANCE_NPM_BINDING_UNOBSERVED', {
      name, version, integrity: observedIntegrity,
    });
    if (commit !== expectedCommit) return mismatch(kind, 'PROVENANCE_COMMIT_MISMATCH', {
      name, version, commit, expectedCommit,
    });
    if (observedRepository !== expectedRepository) return mismatch(kind, 'PROVENANCE_REPOSITORY_MISMATCH', {
      name, version, repository: expectedRepository, observedRepository,
    });
    return result(kind, 'verified', {
      name,
      version,
      integrity: observedIntegrity,
      expectedIntegrity,
      commit,
      repository: observedRepository,
      status: 'published',
      observed: {
        name, version, integrity: observedIntegrity, commit, repository: observedRepository, status: 'published',
      },
    });
  } catch (error) {
    return sourceError(kind, error, { name, version });
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}

function githubTagCommit({ repository, tag, execute }) {
  const refPath = `/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`;
  const ref = parseJsonOutput(executeGithubApi(execute, refPath));
  let object = ref?.object;
  const visited = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    const type = String(object?.type || '').toLowerCase();
    const sha = String(object?.sha || '').trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      return { state: 'reported', code: 'PROVENANCE_TAG_COMMIT_UNOBSERVED' };
    }
    if (type === 'commit') return { state: 'verified', commit: sha };
    if (type !== 'tag' || visited.has(sha)) {
      return { state: 'reported', code: 'PROVENANCE_TAG_COMMIT_AMBIGUOUS' };
    }
    visited.add(sha);
    const tagObject = parseJsonOutput(executeGithubApi(execute, `/repos/${repository}/git/tags/${sha}`));
    object = tagObject?.object;
  }
  return { state: 'reported', code: 'PROVENANCE_TAG_COMMIT_AMBIGUOUS' };
}

export function collectGitHubReleaseObservation({
  repository,
  tag,
  expectedCommit,
  expectedVersion,
  expectedNotes,
  execute = execFileSync,
} = {}) {
  const kind = 'github-release';
  const normalized = normalizeRepository(repository);
  if (!normalized || !safeTag(tag) || !expectedCommit) return failure(kind, 'unproven', 'PROVENANCE_RELEASE_INPUT_INVALID');
  try {
    const path = `/repos/${normalized}/releases/tags/${encodeURIComponent(tag)}`;
    const response = parseJsonOutput(executeGithubApi(execute, path));
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      return failure(kind, 'reported', 'PROVENANCE_SOURCE_UNAVAILABLE', { repository: normalized, tag });
    }
    const observedRepository = normalizeRepository(response.repository?.full_name || normalized);
    if (observedRepository && observedRepository !== normalized) return mismatch(kind, 'PROVENANCE_REPOSITORY_MISMATCH', { repository: normalized, observedRepository, tag });
    const observedTag = String(response.tag_name || '');
    const version = String(expectedVersion || String(tag).replace(/^v/i, ''));
    const observedVersion = observedTag.replace(/^v/i, '');
    const reasonCodes = [];
    if (!observedTag || observedTag !== tag) reasonCodes.push('PROVENANCE_TAG_MISMATCH');
    if (observedVersion !== version) reasonCodes.push('PROVENANCE_VERSION_MISMATCH');
    const targetCommitish = String(response.target_commitish || '').trim();
    const explicitCommit = String(response.target_sha || response.commit || '').trim();
    if (/^[0-9a-f]{40}$/i.test(targetCommitish) && targetCommitish !== expectedCommit) {
      reasonCodes.push('PROVENANCE_COMMIT_MISMATCH');
    }
    if (explicitCommit && explicitCommit !== expectedCommit) reasonCodes.push('PROVENANCE_COMMIT_MISMATCH');
    if (expectedNotes !== undefined && String(response.body || '').trim() !== String(expectedNotes).trim()) {
      reasonCodes.push('PROVENANCE_NOTES_MISMATCH');
    }
    if (reasonCodes.some((code) => code.endsWith('_MISMATCH'))) {
      return failure(kind, 'conflict', reasonCodes[0], {
        reasonCodes,
        diagnostics: reasonCodes.map((code) => ({ code })),
        repository: normalized,
        tag,
        version,
        commit: explicitCommit,
      });
    }
    if (response.draft === true) return failure(kind, 'reported', 'PROVENANCE_RELEASE_DRAFT', {
      repository: normalized, tag, version, target_commitish: targetCommitish,
    });
    const resolvedTag = githubTagCommit({ repository: normalized, tag, execute });
    if (resolvedTag.state !== 'verified') return failure(kind, 'reported', resolvedTag.code, {
      repository: normalized, tag, version, target_commitish: targetCommitish,
    });
    const commit = resolvedTag.commit;
    if (commit !== expectedCommit) return mismatch(kind, 'PROVENANCE_COMMIT_MISMATCH', {
      repository: normalized, tag, version, commit, expectedCommit, target_commitish: targetCommitish,
    });
    return result(kind, 'verified', {
      repository: normalized,
      tag,
      version,
      commit,
      target_commitish: targetCommitish,
      status: 'published',
      notes: String(response.body || '').trim(),
      observed: {
        repository: normalized, tag, version, commit, target_commitish: targetCommitish, status: 'published',
      },
    });
  } catch (error) {
    return sourceError(kind, error, { repository: normalized, tag });
  }
}

export { normalizeRepository };
