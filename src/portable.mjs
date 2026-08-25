import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { readSessionRegistry } from '../hooks/obsidian-common.mjs';
import { discoverWorktreeRepository, readWorktreeRegistry } from '../packages/vault/src/worktree-metadata.mjs';
import { resolveProjectVault } from './project-vault.mjs';

const SCHEMA_VERSION = 1;
const DEFAULT_RELATIVE_PATH = '.wendkeep/portable/state.json';
const RUNTIME_STATE = '.brain/runtime/PORTABLE_ACTIVE_WORK.json';
const PROVENANCE_LEDGER = '.brain/runtime/PORTABLE_PROVENANCE.jsonl';
const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_ARTIFACTS = 4096;
const SHAREABLE_ROOTS = new Set(['07-Specs', '08-Mudanças', '08-Changes', '04-Decisões', '04-Decisions']);
const CHANGE_AUTHORED = new Set([
  'proposta.md', 'proposal.md', 'design.md', 'tarefas.md', 'tasks.md', 'artifacts.json',
  '.spec-impact-v1', '.spec-impact-v1.json', '.spec-base.json', 'flow-origin.json',
]);
const CHANGE_DERIVED = new Set([
  'evidencia.json', 'evidence.json', 'verificacao.json', 'verification.json', 'verdict.json',
]);

function portableError(code, message) {
  return Object.assign(new Error(message), { code });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function portablePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function boundedString(value, field, maxLength = 512) {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw portableError('WENDKEEP_PORTABLE_SCHEMA', `${field} must be a bounded string`);
  }
  if (/\0/.test(value) || /\b[A-Za-z]:\\/.test(value)
    || /(^|\s)\/(?:home|Users|private|var\/folders|tmp)\//.test(value)
    || /\b(?:gh[opsu]_|sk-)[A-Za-z0-9_-]{20,}/.test(value)) {
    throw portableError('WENDKEEP_PORTABLE_SCHEMA', `${field} contains private data`);
  }
  return value;
}

function pathParts(value) {
  return portablePath(value).split('/').filter(Boolean);
}

function safeRelativePath(value) {
  const normalized = portablePath(value);
  const parts = pathParts(normalized);
  if (!normalized || isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)
    || parts.includes('..') || parts.includes('.') || normalized.includes('\0')) {
    throw portableError('WENDKEEP_PORTABLE_PATH_UNSAFE', `unsafe portable path: ${value}`);
  }
  return normalized;
}

export function classifyPortableArtifact(logicalPath) {
  const path = portablePath(logicalPath);
  const parts = pathParts(path);
  if (!parts.length) return 'secret';
  if (path === '.brain/CORE.md') return 'authored';
  if (parts[0] === '.brain') return 'runtime';
  if (['02-Sessões', '02-Sessions'].includes(parts[0])) return 'secret';
  if (['04-Decisões', '04-Decisions'].includes(parts[0])) return 'authored';
  if (parts[0] === '07-Specs') return 'derived';
  if (['08-Mudanças', '08-Changes'].includes(parts[0])) {
    if (parts.includes('_arquivo') || parts.includes('_archive')) return 'derived';
    if (parts[2] === 'specs') return 'authored';
    if (CHANGE_DERIVED.has(parts.at(-1))) return 'derived';
    if (parts.length === 3 && CHANGE_AUTHORED.has(parts[2])) return 'authored';
    return 'runtime';
  }
  return 'secret';
}

function shareable(path) {
  const category = classifyPortableArtifact(path);
  return category === 'authored' || (category === 'derived' && portablePath(path).startsWith('07-Specs/'));
}

function redactPortableText(input) {
  let text = String(input).replace(/\r\n?/g, '\n');
  text = text.replace(/\b[A-Za-z]:\\(?:[^\s<>:"|?*\\]+\\)*[^\s<>:"|?*]*/g, '[REDACTED_PATH]');
  text = text.replace(/(^|[\s=("'`])\/(?:home|Users|private|var\/folders|tmp)\/[^\s)"'`<>]*/g, '$1[REDACTED_PATH]');
  text = text.replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_SECRET]');
  text = text.replace(/(Authorization\s*:\s*Bearer\s+)[^\s]+/gi, '$1[REDACTED_SECRET]');
  text = text.replace(/\b(token|password|secret|api[_-]?key)\s*=\s*[^\s]+/gi, '$1=[REDACTED_SECRET]');
  return text;
}

function walkFiles(vaultBase, logicalRoot) {
  const root = join(vaultBase, ...pathParts(logicalRoot));
  if (!existsSync(root)) return [];
  const results = [];
  const visit = (absolute, logical) => {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(join(absolute, name), `${logical}/${name}`);
      return;
    }
    if (stat.isFile() && stat.nlink === 1 && shareable(logical)) results.push({ absolute, logical: portablePath(logical) });
  };
  visit(root, logicalRoot);
  return results;
}

function artifactsOf(vaultBase) {
  const candidates = [];
  const core = join(vaultBase, '.brain', 'CORE.md');
  if (existsSync(core) && lstatSync(core).isFile() && lstatSync(core).nlink === 1) {
    candidates.push({ absolute: core, logical: '.brain/CORE.md' });
  }
  for (const root of [...SHAREABLE_ROOTS].sort()) candidates.push(...walkFiles(vaultBase, root));
  const unique = new Map(candidates.map((item) => [item.logical, item]));
  return [...unique.values()].sort((left, right) => left.logical.localeCompare(right.logical)).map((item) => {
    const content = redactPortableText(readFileSync(item.absolute, 'utf8'));
    return {
      path: item.logical,
      category: classifyPortableArtifact(item.logical),
      content_sha256: sha256(content),
      content,
    };
  });
}

function parseTasks(content = '') {
  const rows = [];
  for (const line of String(content).split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*\[([ xX])\]\s+([A-Za-z0-9._-]+)\s+(.+?)\s*$/);
    if (match) rows.push({ id: match[2], title: match[3], completed: match[1].toLowerCase() === 'x' });
  }
  return rows;
}

function digestArtifacts(artifacts, predicate) {
  return sha256(canonicalJson(artifacts.filter(predicate).map(({ path, content_sha256 }) => ({ path, content_sha256 }))));
}

function activeWorkOf({ activeContexts, artifacts, repositoryId, baseSha = '', headSha = '', now }) {
  return activeContexts.filter((context) => context?.state === 'active'
    && (!repositoryId || context.repository_id === repositoryId)).map((context) => {
    const slug = String(context.change_slug || '');
    const rootCandidates = [`08-Mudanças/${slug}/`, `08-Changes/${slug}/`];
    const changeArtifacts = artifacts.filter((item) => rootCandidates.some((root) => item.path.startsWith(root)));
    const tasksArtifact = changeArtifacts.find((item) => /\/(?:tarefas|tasks)\.md$/.test(item.path));
    const tasks = parseTasks(tasksArtifact?.content || '');
    const completed = tasks.filter((task) => task.completed).map((task) => task.id);
    const pending = tasks.filter((task) => !task.completed);
    const current = pending[0] || null;
    const branch = String(context.branch || '');
    const revision = Number.isSafeInteger(Number(context.revision)) ? Number(context.revision) : 0;
    return {
      schema_version: 1,
      active_work_id: sha256(`${context.repository_id || repositoryId}\0${branch}\0${slug}`).slice(7, 31),
      project_id: String(context.project_id || ''),
      repository_id: String(context.repository_id || repositoryId || ''),
      change_slug: slug,
      task_id: current?.id || '',
      branch,
      base_sha: String(context.base_sha || baseSha || ''),
      head_sha: String(context.head_sha || headSha || ''),
      spec_sha256: digestArtifacts(artifacts, (item) => item.path.startsWith('07-Specs/') || item.path.includes(`/${slug}/specs/`)),
      tasks_sha256: tasksArtifact?.content_sha256 || sha256(''),
      status: pending.length ? 'in_progress' : 'completed',
      completed,
      current_action: current ? { task_id: current.id, title: current.title } : {},
      next_actions: pending.slice(1).map((task) => task.id),
      blockers: [],
      evidence_refs: [],
      updated_at: now,
      revision,
    };
  }).sort((left, right) => left.active_work_id.localeCompare(right.active_work_id));
}

function projectIdOf(vaultBase) {
  try { return String(JSON.parse(readFileSync(join(vaultBase, '.brain', 'PROJECT.json'), 'utf8')).projectId || ''); }
  catch { return ''; }
}

export function buildPortableState({
  vaultBase, projectRoot = process.cwd(), repositoryId = '', activeContexts = [], baseSha = '', headSha = '',
  now = new Date().toISOString(),
} = {}) {
  if (!vaultBase) throw portableError('WENDKEEP_PORTABLE_VAULT_MISSING', 'vault is required');
  const resolvedVault = resolve(vaultBase);
  const artifacts = artifactsOf(resolvedVault);
  const projectId = projectIdOf(vaultBase);
  const priorProjection = activeContexts.length ? null : resumeState(resolvedVault);
  const contexts = activeContexts.length ? activeContexts : (priorProjection?.active_work || []).map((item) => ({
    ...item, state: 'active', project_id: item.project_id, repository_id: item.repository_id,
  }));
  const effectiveRepositoryId = String(repositoryId || priorProjection?.repository_id || '');
  const active_work = activeWorkOf({
    activeContexts: contexts, artifacts, repositoryId: effectiveRepositoryId, baseSha, headSha, now,
  });
  return {
    schema_version: SCHEMA_VERSION,
    kind: 'wendkeep-portable-state',
    project_id: projectId,
    repository_id: String(effectiveRepositoryId || active_work[0]?.repository_id || ''),
    authored_sha256: digestArtifacts(artifacts, () => true),
    artifacts,
    active_work,
  };
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function stateBytes(state) {
  return `${JSON.stringify(stableValue(state), null, 2)}\n`;
}

function appendProvenance(vaultBase, operation, state, now = new Date().toISOString()) {
  const path = join(vaultBase, ...pathParts(PROVENANCE_LEDGER));
  mkdirSync(resolve(path, '..'), { recursive: true });
  const record = {
    schema_version: 1, operation, occurred_at: now,
    project_id: String(state.project_id || ''), repository_id: String(state.repository_id || ''),
    authored_sha256: String(state.authored_sha256 || ''), state_sha256: sha256(stateBytes(state)),
    active_work: (state.active_work || []).map((item) => ({
      active_work_id: item.active_work_id, revision: item.revision,
      snapshot_sha256: sha256(canonicalJson(item)),
    })),
  };
  appendFileSync(path, `${canonicalJson(record)}\n`, 'utf8');
}

export function exportPortableState(options = {}) {
  const state = buildPortableState(options);
  if (!state.project_id || !state.repository_id) {
    throw portableError(
      'WENDKEEP_PORTABLE_IDENTITY_UNAVAILABLE',
      'PROJECT.json and the worktree registry must prove project/repository identity',
    );
  }
  const output = resolve(options.output || join(options.projectRoot || process.cwd(), ...pathParts(DEFAULT_RELATIVE_PATH)));
  const bytes = stateBytes(state);
  const previous = existsSync(output) ? readFileSync(output, 'utf8') : '';
  if (previous !== bytes) atomicWrite(output, bytes);
  appendProvenance(options.vaultBase, 'export', state, options.now);
  return { ok: true, output, changed: previous !== bytes, state_sha256: sha256(bytes), state };
}

function validateArtifact(artifact) {
  exactKeys(artifact, new Set(['path', 'category', 'content_sha256', 'content']), 'portable artifact');
  const path = safeRelativePath(artifact?.path);
  if (!shareable(path)) throw portableError('WENDKEEP_PORTABLE_PATH_UNSAFE', `non-shareable path: ${path}`);
  if (artifact.category !== classifyPortableArtifact(path)) {
    throw portableError('WENDKEEP_PORTABLE_SCHEMA', `artifact category mismatch: ${path}`);
  }
  if (typeof artifact?.content !== 'string' || Buffer.byteLength(artifact.content, 'utf8') > MAX_ARTIFACT_BYTES
    || !HASH.test(String(artifact?.content_sha256 || ''))
    || sha256(artifact.content) !== artifact.content_sha256) {
    throw portableError('WENDKEEP_PORTABLE_INTEGRITY', `content hash mismatch: ${path}`);
  }
  return { ...artifact, path };
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.has(key))) {
    throw portableError('WENDKEEP_PORTABLE_SCHEMA', `${label} contains unknown fields`);
  }
}

function validateStringArray(value, field) {
  if (!Array.isArray(value) || value.length > 1024) {
    throw portableError('WENDKEEP_PORTABLE_SCHEMA', `${field} must be a bounded array`);
  }
  const normalized = value.map((item) => boundedString(item, field, 512));
  if (new Set(normalized).size !== normalized.length) {
    throw portableError('WENDKEEP_PORTABLE_SCHEMA', `${field} contains duplicates`);
  }
  return normalized;
}

const ACTIVE_WORK_KEYS = new Set([
  'schema_version', 'active_work_id', 'project_id', 'repository_id', 'change_slug', 'task_id',
  'branch', 'base_sha', 'head_sha', 'spec_sha256', 'tasks_sha256', 'status', 'completed',
  'current_action', 'next_actions', 'blockers', 'evidence_refs', 'updated_at', 'revision',
]);

function validateActiveWork(item) {
  exactKeys(item, ACTIVE_WORK_KEYS, 'active-work');
  if (item.schema_version !== 1 || !/^[a-f0-9]{24}$/.test(String(item.active_work_id || ''))
    || !HASH.test(String(item.spec_sha256 || '')) || !HASH.test(String(item.tasks_sha256 || ''))
    || !['in_progress', 'completed', 'blocked'].includes(item.status)
    || !Number.isSafeInteger(item.revision) || item.revision < 0
    || Number.isNaN(Date.parse(item.updated_at))) {
    throw portableError('WENDKEEP_PORTABLE_SCHEMA', 'invalid active-work fields');
  }
  for (const field of ['project_id', 'repository_id', 'change_slug', 'task_id', 'branch', 'base_sha', 'head_sha']) {
    boundedString(item[field], `active-work.${field}`, field === 'branch' ? 240 : 160);
  }
  if (!item.project_id || !item.repository_id || !/^(|[a-f0-9]{40,64})$/.test(item.base_sha)
    || !/^(|[a-f0-9]{40,64})$/.test(item.head_sha)) {
    throw portableError('WENDKEEP_PORTABLE_SCHEMA', 'invalid active-work identity or commit hash');
  }
  exactKeys(item.current_action, new Set(['task_id', 'title']), 'active-work.current_action');
  for (const [key, value] of Object.entries(item.current_action)) boundedString(value, `current_action.${key}`, 512);
  for (const field of ['completed', 'next_actions', 'blockers', 'evidence_refs']) validateStringArray(item[field], field);
  return item;
}

function validateState(state, vaultBase) {
  let size;
  try { size = Buffer.byteLength(JSON.stringify(state), 'utf8'); } catch { size = MAX_STATE_BYTES + 1; }
  if (state?.schema_version !== SCHEMA_VERSION || state?.kind !== 'wendkeep-portable-state'
    || !Array.isArray(state?.artifacts) || state.artifacts.length > MAX_ARTIFACTS
    || !Array.isArray(state?.active_work) || size > MAX_STATE_BYTES) {
    throw portableError('WENDKEEP_PORTABLE_SCHEMA', 'invalid portable state schema');
  }
  exactKeys(state, new Set([
    'schema_version', 'kind', 'project_id', 'repository_id', 'authored_sha256', 'artifacts', 'active_work',
  ]), 'portable state');
  boundedString(state.project_id, 'project_id', 160);
  boundedString(state.repository_id, 'repository_id', 160);
  if (!state.project_id || !state.repository_id || !HASH.test(String(state.authored_sha256 || ''))) {
    throw portableError('WENDKEEP_PORTABLE_SCHEMA', 'portable identity or digest is invalid');
  }
  const projectId = projectIdOf(vaultBase);
  if (projectId && state.project_id && projectId !== state.project_id) {
    throw portableError('WENDKEEP_PORTABLE_PROJECT_MISMATCH', 'portable state belongs to another project');
  }
  const artifacts = state.artifacts.map(validateArtifact);
  if (new Set(artifacts.map((item) => item.path)).size !== artifacts.length
    || new Set(state.active_work.map((item) => item.active_work_id)).size !== state.active_work.length) {
    throw portableError('WENDKEEP_PORTABLE_SCHEMA', 'portable state contains duplicate identities');
  }
  state.active_work.forEach(validateActiveWork);
  if (digestArtifacts(artifacts, () => true) !== state.authored_sha256) {
    throw portableError('WENDKEEP_PORTABLE_INTEGRITY', 'authored state digest mismatch');
  }
  return { ...state, artifacts };
}

function resumeState(vaultBase) {
  const path = join(vaultBase, ...pathParts(RUNTIME_STATE));
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function activeWorkHash(item) {
  return sha256(canonicalJson(item));
}

function assertNotStale(localState, incoming) {
  const local = new Map((localState?.active_work || []).map((item) => [item.active_work_id, item]));
  const received = new Set(incoming.active_work.map((item) => item.active_work_id));
  for (const activeWorkId of local.keys()) {
    if (!received.has(activeWorkId)) {
      throw portableError('WENDKEEP_PORTABLE_STALE', 'portable state omits local active-work');
    }
  }
  for (const item of incoming.active_work) {
    const current = local.get(item.active_work_id);
    if (!current) continue;
    const incomingRevision = Number(item.revision || 0);
    const localRevision = Number(current.revision || 0);
    if (incomingRevision < localRevision) {
      throw portableError('WENDKEEP_PORTABLE_STALE', `portable revision ${incomingRevision} is older than local ${localRevision}`);
    }
    if (incomingRevision === localRevision && activeWorkHash(item) !== activeWorkHash(current)) {
      throw portableError('WENDKEEP_PORTABLE_CONFLICT', `portable revision ${incomingRevision} has a different hash`);
    }
  }
}

function safeImportTarget(vaultBase, logicalPath) {
  const target = join(vaultBase, ...pathParts(safeRelativePath(logicalPath)));
  const root = resolve(vaultBase);
  const resolved = resolve(target);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw portableError('WENDKEEP_PORTABLE_PATH_UNSAFE', `path escapes vault: ${logicalPath}`);
  }
  let cursor = root;
  for (const part of pathParts(relative(root, resolved))) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw portableError('WENDKEEP_PORTABLE_PATH_UNSAFE', `symlink in import path: ${logicalPath}`);
    }
  }
  if (existsSync(resolved) && lstatSync(resolved).isFile() && lstatSync(resolved).nlink !== 1) {
    throw portableError('WENDKEEP_PORTABLE_PATH_UNSAFE', `hardlink import target: ${logicalPath}`);
  }
  return resolved;
}

function readStateFile(path) {
  const target = resolve(path);
  if (statSync(target).size > MAX_STATE_BYTES) {
    throw portableError('WENDKEEP_PORTABLE_SCHEMA', 'portable state exceeds the byte limit');
  }
  return JSON.parse(readFileSync(target, 'utf8'));
}

export function importPortableState({ vaultBase, projectRoot = process.cwd(), state, input, now } = {}) {
  const raw = state || readStateFile(input || join(projectRoot, ...pathParts(DEFAULT_RELATIVE_PATH)));
  const validated = validateState(raw, vaultBase);
  const registryContexts = Object.values(readSessionRegistry(vaultBase).active_contexts || {});
  const current = buildPortableState({
    vaultBase, projectRoot, repositoryId: validated.repository_id,
    activeContexts: registryContexts,
    now: validated.active_work[0]?.updated_at || now || new Date().toISOString(),
  });
  assertNotStale(current, validated);
  const targets = validated.artifacts.map((artifact) => ({ artifact, target: safeImportTarget(vaultBase, artifact.path) }));
  let imported = 0;
  for (const { artifact, target } of targets) {
    const previous = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (previous !== artifact.content) {
      atomicWrite(target, artifact.content);
      imported += 1;
    }
  }
  const projection = {
    schema_version: 1, project_id: validated.project_id, repository_id: validated.repository_id,
    authored_sha256: validated.authored_sha256, active_work: validated.active_work,
  };
  atomicWrite(join(vaultBase, ...pathParts(RUNTIME_STATE)), stateBytes(projection));
  appendProvenance(vaultBase, 'import', validated, now);
  return { ok: true, imported, unchanged: targets.length - imported, active_work: validated.active_work };
}

function artifactMap(state) {
  return new Map((state?.artifacts || []).map((item) => [item.path, item.content_sha256]));
}

function inferredBuildOptions({ vaultBase, projectRoot, state }) {
  return {
    vaultBase, projectRoot, repositoryId: state.repository_id,
    activeContexts: state.active_work.map((item) => ({
      ...item, state: 'active', repository_id: item.repository_id, project_id: item.project_id,
    })),
    now: state.active_work[0]?.updated_at || new Date().toISOString(),
  };
}

export function diffPortableState({ vaultBase, projectRoot = process.cwd(), input, state } = {}) {
  const expected = validateState(state || readStateFile(input || join(projectRoot, ...pathParts(DEFAULT_RELATIVE_PATH))), vaultBase);
  const actual = buildPortableState(inferredBuildOptions({ vaultBase, projectRoot, state: expected }));
  const left = artifactMap(expected);
  const right = artifactMap(actual);
  const added = [...right.keys()].filter((path) => !left.has(path)).sort();
  const removed = [...left.keys()].filter((path) => !right.has(path)).sort();
  const changed = [...left.keys()].filter((path) => right.has(path) && left.get(path) !== right.get(path)).sort();
  return { equal: !added.length && !removed.length && !changed.length, added, removed, changed, expected, actual };
}

export function inspectPortableState(options = {}) {
  const input = resolve(options.input || join(options.projectRoot || process.cwd(), ...pathParts(DEFAULT_RELATIVE_PATH)));
  if (!existsSync(input)) return { status: 'not_configured', input, issues: [] };
  try {
    const diff = diffPortableState({ ...options, input });
    return { status: diff.equal ? 'current' : 'diverged', input, issues: [...diff.added, ...diff.removed, ...diff.changed], diff };
  } catch (error) {
    return { status: 'invalid', input, issues: [error.code || error.message], error };
  }
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || '';
  return argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function runtimeOptions(argv) {
  const projectRoot = resolve(option(argv, '--project') || process.cwd());
  const resolution = resolveProjectVault({ startDir: projectRoot, explicitVault: option(argv, '--vault') });
  const vaultBase = resolution.base;
  let repositoryId = '';
  let headSha = '';
  let baseSha = '';
  try {
    const repository = discoverWorktreeRepository({ startDir: projectRoot });
    repositoryId = readWorktreeRegistry(repository).registry?.repositoryId || '';
    headSha = repository.worktrees.find((item) => resolve(item.path) === resolve(repository.repoRoot))?.head || '';
    const mergeBase = spawnSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      cwd: repository.repoRoot, encoding: 'utf8', windowsHide: true,
    });
    if (mergeBase.status === 0) baseSha = String(mergeBase.stdout || '').trim();
  } catch { /* status/import can still operate before worktree metadata exists */ }
  const registry = readSessionRegistry(vaultBase);
  return {
    vaultBase, projectRoot, repositoryId, headSha, baseSha,
    activeContexts: Object.values(registry.active_contexts || {}),
  };
}

export const PORTABLE_HELP = `wendkeep portable <status|export|import|diff> [options]

  --project <path>  project root (default: current directory)
  --vault <path>    explicit local Vault
  --input <path>    portable JSON to import or compare
  --output <path>   export destination (default: .wendkeep/portable/state.json)
  --json            structured output
`;

export function runPortable(argv = []) {
  const sub = argv[0];
  if (!sub || ['help', '--help', '-h'].includes(sub)) {
    process.stdout.write(PORTABLE_HELP);
    return 0;
  }
  const json = argv.includes('--json');
  try {
    const common = runtimeOptions(argv);
    let result;
    if (sub === 'status') result = inspectPortableState({ ...common, input: option(argv, '--input') });
    else if (sub === 'export') result = exportPortableState({ ...common, output: option(argv, '--output') });
    else if (sub === 'import') result = importPortableState({ ...common, input: option(argv, '--input') });
    else if (sub === 'diff') result = diffPortableState({ ...common, input: option(argv, '--input') });
    else throw portableError('WENDKEEP_PORTABLE_SUBCOMMAND_UNKNOWN', `unknown subcommand: ${sub}`);
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else if (sub === 'status') process.stdout.write(`portable: ${result.status}${result.issues?.length ? ` (${result.issues.length} difference(s))` : ''}\n`);
    else if (sub === 'export') process.stdout.write(`portable export: ${result.output}${result.changed ? ' (updated)' : ' (unchanged)'}\n`);
    else if (sub === 'import') process.stdout.write(`portable import: ${result.imported} imported, ${result.unchanged} unchanged\n`);
    else process.stdout.write(`portable diff: ${result.equal ? 'equal' : `${result.added.length} added, ${result.removed.length} removed, ${result.changed.length} changed`}\n`);
    return sub === 'diff' && !result.equal ? 1 : sub === 'status' && ['invalid'].includes(result.status) ? 1 : 0;
  } catch (error) {
    const payload = { ok: false, code: error?.code || 'WENDKEEP_PORTABLE_FAILED', error: String(error?.message || error) };
    process.stderr.write(json ? `${JSON.stringify(payload)}\n` : `wendkeep portable: ${payload.code}: ${payload.error}\n`);
    return 2;
  }
}
