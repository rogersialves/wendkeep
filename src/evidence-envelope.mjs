import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProjectForValidation } from '../packages/vault/src/validate-memory.mjs';
import {
  discoverWorktreeRepository,
  readWorktreeRegistry,
  worktreeIdentity,
} from '../packages/vault/src/worktree-metadata.mjs';
import {
  canonicalSha256,
  evaluateEvidenceBinding,
  evidenceSensors,
} from '../packages/vault/src/evidence-envelope.mjs';

export { canonicalSha256, evaluateEvidenceBinding, evidenceSensors };

const PACKAGE_VERSION = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
  'utf8',
)).version;

export function sensorConfigSha256(sensors, ids) {
  const selected = new Set(ids || []);
  const canonical = (sensors || [])
    .filter((sensor) => selected.has(sensor.id))
    .map((sensor) => sensor)
    .sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));
  return canonicalSha256(canonical);
}

function normalizedPath(value) {
  return String(value || '').replaceAll('\\', '/');
}

const BINARY_EXTENSIONS = new Set([
  '.7z', '.a', '.avi', '.bin', '.bmp', '.class', '.dll', '.doc', '.docx', '.dylib', '.eot',
  '.exe', '.gif', '.gz', '.ico', '.jar', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.o',
  '.ogg', '.otf', '.pdf', '.png', '.so', '.tar', '.tif', '.tiff', '.ttf', '.wav', '.webm',
  '.webp', '.woff', '.woff2', '.xls', '.xlsx', '.zip',
]);

function normalizedContent(content, binary = false) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content || '');
  if (binary || bytes.includes(0) || !isUtf8(bytes)) return bytes;
  return Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
}

export function digestWorktreeEntries(entries) {
  const canonical = (entries || []).map((entry) => ({
    layer: String(entry.layer || ''),
    status: String(entry.status || ''),
    path: normalizedPath(entry.path),
    ...(entry.oldPath ? { old_path: normalizedPath(entry.oldPath) } : {}),
    content_mode: entry.binary ? 'binary' : 'text',
    content_sha256: entry.content == null ? null : canonicalSha256(normalizedContent(entry.content, entry.binary)),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return canonicalSha256(canonical);
}

function gitResult(projectRoot, args, { spawn = spawnSync, allowFailure = false } = {}) {
  const result = spawn('git', args, {
    cwd: projectRoot,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail = Buffer.from(result.stderr || '').toString('utf8').trim();
    const error = new Error(`git ${args.join(' ')} falhou${detail ? `: ${detail}` : ''}`);
    error.code = 'WENDKEEP_EVIDENCE_GIT_FAILED';
    throw error;
  }
  return result;
}

function gitText(projectRoot, args, options) {
  const result = gitResult(projectRoot, args, options);
  if (result.status !== 0) return '';
  return Buffer.from(result.stdout || '').toString('utf8').trim();
}

function gitBuffer(projectRoot, args, options) {
  const result = gitResult(projectRoot, args, options);
  return result.status === 0 ? Buffer.from(result.stdout || '') : Buffer.alloc(0);
}

function parseNameStatus(buffer, layer) {
  const tokens = buffer.toString('utf8').split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const entries = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const renamed = /^[RC]/.test(status);
    const oldPath = renamed ? tokens[index++] : '';
    const path = tokens[index++];
    if (!path) continue;
    entries.push({ layer, status, path, ...(oldPath ? { oldPath } : {}) });
  }
  return entries;
}

function binaryAttributes(projectRoot, paths, options) {
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return new Map();
  const tokens = gitBuffer(projectRoot, ['check-attr', '-z', 'binary', 'text', '--', ...unique], {
    ...options, allowFailure: true,
  }).toString('utf8').split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const attributes = new Map();
  for (let index = 0; index + 2 < tokens.length; index += 3) {
    const [path, attribute, value] = tokens.slice(index, index + 3);
    const entry = attributes.get(path) || {};
    entry[attribute] = value;
    attributes.set(path, entry);
  }
  return attributes;
}

function pathIsBinary(path, attributes) {
  const values = attributes.get(path) || {};
  if (values.binary === 'set' || values.text === 'unset') return true;
  if (values.binary === 'unset' || values.text === 'set' || values.text === 'auto') return false;
  const normalized = normalizedPath(path).toLowerCase();
  const dot = normalized.lastIndexOf('.');
  return dot >= 0 && BINARY_EXTENSIONS.has(normalized.slice(dot));
}

function readWorkingPath(projectRoot, path) {
  const root = resolve(projectRoot);
  const absolute = resolve(root, ...normalizedPath(path).split('/'));
  const scoped = relative(root, absolute);
  if (scoped === '..' || scoped.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(scoped)) {
    return null;
  }
  try {
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
    return readFileSync(absolute);
  } catch {
    return null;
  }
}

function changedEntries(projectRoot, options) {
  const staged = parseNameStatus(gitBuffer(projectRoot, [
    'diff', '--cached', '--name-status', '-z', '--find-renames', '--no-ext-diff',
  ], options), 'index');
  const unstaged = parseNameStatus(gitBuffer(projectRoot, [
    'diff', '--name-status', '-z', '--find-renames', '--no-ext-diff',
  ], options), 'worktree');
  const untracked = gitBuffer(projectRoot, [
    'ls-files', '--others', '--exclude-standard', '-z',
  ], options).toString('utf8').split('\0').filter(Boolean).map((path) => ({
    layer: 'untracked', status: '?', path,
  }));
  const attributes = binaryAttributes(projectRoot, [
    ...staged.map((entry) => entry.path),
    ...unstaged.map((entry) => entry.path),
    ...untracked.map((entry) => entry.path),
  ], options);

  for (const entry of staged) {
    entry.binary = pathIsBinary(entry.path, attributes);
    entry.content = /^D/.test(entry.status)
      ? null
      : gitBuffer(projectRoot, ['show', `:${entry.path}`], { ...options, allowFailure: true });
  }
  for (const entry of [...unstaged, ...untracked]) {
    entry.binary = pathIsBinary(entry.path, attributes);
    entry.content = /^D/.test(entry.status) ? null : readWorkingPath(projectRoot, entry.path);
  }
  return [...staged, ...unstaged, ...untracked];
}

function resolveBaseSha(projectRoot, headSha, options) {
  const upstream = gitText(projectRoot, ['rev-parse', '--verify', '@{upstream}'], {
    ...options, allowFailure: true,
  });
  let candidate = upstream;
  if (!candidate) {
    candidate = gitText(projectRoot, ['rev-parse', '--verify', 'refs/heads/main'], {
      ...options, allowFailure: true,
    });
  }
  if (!candidate) return headSha;
  return gitText(projectRoot, ['merge-base', headSha, candidate], {
    ...options, allowFailure: true,
  }) || headSha;
}

export function captureGitSnapshot(projectRoot, { spawn = spawnSync } = {}) {
  const options = { spawn };
  const headSha = gitText(projectRoot, ['rev-parse', 'HEAD'], options);
  const branch = gitText(projectRoot, ['symbolic-ref', '--short', '-q', 'HEAD'], {
    ...options, allowFailure: true,
  }) || 'HEAD';
  const indexTreeSha = gitText(projectRoot, ['write-tree'], options);
  const entries = changedEntries(projectRoot, options);
  return {
    branch,
    base_sha: resolveBaseSha(projectRoot, headSha, options),
    head_sha: headSha,
    index_tree_sha: indexTreeSha,
    worktree_digest: digestWorktreeEntries(entries),
    dirty: entries.length > 0,
  };
}

export function resolveEvidenceIdentity({
  vaultBase,
  projectRoot,
  changeSlug,
  sessionId = '',
  context = null,
  spawn = spawnSync,
} = {}) {
  const project = readProjectForValidation(vaultBase);
  const repository = discoverWorktreeRepository({ startDir: projectRoot, spawn });
  const { registry } = readWorktreeRegistry(repository);
  if (registry && project.ok && registry.projectId !== project.projectId) {
    const error = new Error('PROJECT.json e registry de worktrees pertencem a projetos diferentes');
    error.code = 'WENDKEEP_EVIDENCE_IDENTITY_MISMATCH';
    throw error;
  }
  const repositoryId = context?.repositoryId
    || registry?.repositoryId
    || canonicalSha256({ git_common_dir: normalizedPath(repository.commonDir).toLowerCase() });
  const projectId = context?.projectId
    || (project.ok ? project.projectId : canonicalSha256({ repository_id: repositoryId }));
  const worktreeId = context?.worktreeId || worktreeIdentity(repositoryId, repository.gitDir);
  const requestedSession = String(sessionId || '').trim();
  const workSessionId = context?.workSessionId
    || requestedSession
    || canonicalSha256({ project_id: projectId, worktree_id: worktreeId, change_slug: changeSlug });
  return {
    project_id: projectId,
    repository_id: repositoryId,
    worktree_id: worktreeId,
    work_session_id: workSessionId,
  };
}

export function assertStableHead(startSnapshot, finishSnapshot) {
  if (startSnapshot?.head_sha !== finishSnapshot?.head_sha) {
    const error = new Error(
      `HEAD mudou durante verify (${startSnapshot?.head_sha || 'ausente'} -> ${finishSnapshot?.head_sha || 'ausente'}); rode novamente no commit estável`,
    );
    error.code = 'WENDKEEP_EVIDENCE_HEAD_CHANGED';
    throw error;
  }
}

export function buildEvidenceEnvelope({
  identity,
  changeSlug,
  snapshot,
  tasksSha256,
  effectiveSpecSha256,
  sensorConfigSha256: configSha256,
  sensors,
  startedAt,
  finishedAt,
  version = PACKAGE_VERSION,
  runtimePlatform = `${process.platform}-${process.arch}`,
} = {}) {
  const envelope = {
    schema_version: 2,
    ...identity,
    change_slug: changeSlug,
    branch: snapshot.branch,
    base_sha: snapshot.base_sha,
    head_sha: snapshot.head_sha,
    index_tree_sha: snapshot.index_tree_sha,
    worktree_digest: snapshot.worktree_digest,
    dirty: snapshot.dirty,
    tasks_sha256: tasksSha256,
    effective_spec_sha256: effectiveSpecSha256,
    sensor_config_sha256: configSha256,
    wendkeep_version: version,
    platform: runtimePlatform,
    started_at: startedAt,
    finished_at: finishedAt,
    sensors,
  };
  return { ...envelope, envelope_id: canonicalSha256(envelope) };
}
