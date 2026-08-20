import { createHash } from 'node:crypto';

export const MEMORY_SCOPE_TYPES = Object.freeze([
  'project',
  'work_session',
  'change',
  'branch',
  'worktree',
]);

const SCOPE_TYPES = new Set(MEMORY_SCOPE_TYPES);
const REGISTER_PATTERNS = [
  /^git\.local-head$/,
  /^handoff\.latest$/,
  /^quality\.latest-(?:sensors|verdict)$/,
  /^change\.[A-Za-z0-9._-]+\.status$/,
];

function clean(value) {
  return String(value ?? '').trim().replace(/[\r\n\t]+/g, ' ').slice(0, 240);
}

function digest(value) {
  return createHash('sha256').update(clean(value)).digest('hex').slice(0, 16);
}

export function normalizeMemoryScope(scope, { projectId = '' } = {}) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return null;
  const type = clean(scope.type);
  const id = clean(scope.id);
  if (!SCOPE_TYPES.has(type) || !id) return null;
  if (type === 'project' && projectId && id !== projectId) return null;
  return { type, id };
}

function changeSlug(memoryKey, context) {
  const fromKey = String(memoryKey || '').match(/^change\.([A-Za-z0-9._-]+)\.status$/)?.[1];
  return clean(fromKey || context.changeSlug || context.change_slug);
}

function workSession(context) {
  return clean(
    context.workSessionId || context.work_session_id
    || context.canonicalSessionId || context.canonical_session_id
    || context.sessionId || context.session_id,
  );
}

/** Deterministic scope policy for operational keys. It never uses an absolute local path. */
export function scopeForMemoryKey(memoryKey, context = {}) {
  const key = clean(memoryKey);
  const projectId = clean(context.projectId || context.project_id) || 'unknown-project';
  if (key === 'handoff.latest') {
    return { type: 'work_session', id: workSession(context) || `legacy:${projectId}` };
  }
  if (key === 'git.local-head') {
    const branch = clean(context.branch || context.branchName || context.branch_name);
    const worktree = clean(context.worktreeId || context.worktree_id);
    const repository = clean(context.repositoryId || context.repository_id);
    if (branch) {
      return {
        type: 'branch',
        id: [repository && `repo:${repository}`, worktree && `worktree:${worktree}`, `branch:${branch}`]
          .filter(Boolean).join('|'),
      };
    }
    const lineage = workSession(context) || clean(context.activation_id) || clean(context.event_id);
    return { type: 'branch', id: `legacy:${projectId}:${digest(lineage || key)}` };
  }
  if (/^quality\.latest-(?:sensors|verdict)$/.test(key)) {
    const slug = changeSlug(key, context) || `legacy:${digest(workSession(context) || key)}`;
    const proof = clean(context.tasksHash || context.tasks_hash || context.specHash || context.spec_hash);
    return { type: 'change', id: proof ? `${slug}|proof:${proof}` : slug };
  }
  if (/^change\.[A-Za-z0-9._-]+\.status$/.test(key)) {
    return { type: 'change', id: changeSlug(key, context) };
  }
  if (/^(?:decision|adr)\b/.test(key)) {
    const slug = changeSlug(key, context);
    return slug ? { type: 'change', id: slug } : { type: 'project', id: projectId };
  }
  if (/^(?:constraint|restriction)\b/.test(key)) {
    const session = workSession(context);
    return session ? { type: 'work_session', id: session } : { type: 'project', id: projectId };
  }
  return { type: 'project', id: projectId };
}

export function effectiveMemoryScope(event = {}) {
  // Ledger rows written before scoped registers existed remain project-scoped until an
  // explicit append-only rescope migration supersedes them. This preserves historic replay.
  return normalizeMemoryScope(event.scope, { projectId: event.project_id })
    || { type: 'project', id: clean(event.project_id) || 'unknown-project' };
}

export function memoryScopeKey(scope) {
  const normalized = normalizeMemoryScope(scope);
  return normalized ? `${normalized.type}:${normalized.id}` : 'project:unknown-project';
}

export function sameMemoryScope(left, right) {
  return memoryScopeKey(effectiveMemoryScope(left)) === memoryScopeKey(effectiveMemoryScope(right));
}

/** Project-scoped keys retain their historic public name; narrower registers are qualified. */
export function memoryRecordKey(event) {
  const scope = effectiveMemoryScope(event);
  return scope.type === 'project'
    ? String(event.memory_key)
    : `${event.memory_key}@${memoryScopeKey(scope)}`;
}

export function isRegisterMemoryKey(memoryKey) {
  return REGISTER_PATTERNS.some((pattern) => pattern.test(String(memoryKey || '')));
}

export function isHumanCuratedMemoryKey(memoryKey) {
  return /^(?:decision|adr|constraint|restriction|block|blocker)\b/.test(String(memoryKey || ''));
}
