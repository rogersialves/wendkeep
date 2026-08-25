import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findProjectBinding, readProjectBinding, resolveProjectVault } from '../../../src/project-vault.mjs';
import { resolveOperatingProfile } from '../../../src/operating-profile.mjs';
import { inspectSessionContext } from '../../../src/context.mjs';
import { listMemoryCandidates } from '../../../src/memory.mjs';
import { resolveCommandActiveContext } from '../../../src/active-context-runtime.mjs';
import { allChangesState } from '../../../hooks/change-core.mjs';
import { activeContextKey } from '../../../hooks/active-context-store.mjs';
import { readSessionRegistry } from '../../../hooks/obsidian-common.mjs';
import { loadEvidenceIndex, recallEvidence } from '../../vault/src/evidence-recall.mjs';
import { getLocale } from '../../vault/src/locale.mjs';
import {
  deriveMemoryProjection,
  enqueueMemoryEvent,
  projectMemoryOutbox,
  readMemoryLedger,
} from '../../vault/src/memory-store.mjs';
import { scopeForMemoryKey } from '../../vault/src/memory-scope.mjs';
import { sanitizeMemoryText } from '../../vault/src/memory-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = join(ROOT, 'bin', 'wendkeep.mjs');
const OUTPUT_LIMIT = 1_000_000;

function canonicalPath(value) {
  const absolute = resolve(String(value || ''));
  let physical = absolute;
  try { physical = realpathSync.native(absolute); } catch { /* validated by binding resolution */ }
  const normalized = physical.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function contextFor(args) {
  if (!isAbsolute(String(args.project_root || ''))) {
    throw Object.assign(new Error('project_root must be absolute'), { code: 'MCP_PROJECT_INVALID' });
  }
  const declaredProjectRoot = resolve(String(args.project_root));
  const requestedWorktreeRoot = resolve(String(args.worktree_root || declaredProjectRoot));
  if (args.worktree_root && !isAbsolute(args.worktree_root)) {
    throw Object.assign(new Error('worktree_root must be absolute'), { code: 'MCP_WORKTREE_INVALID' });
  }
  const worktreeBinding = findProjectBinding(requestedWorktreeRoot);
  if (!worktreeBinding
      || canonicalPath(worktreeBinding.projectRoot) !== canonicalPath(requestedWorktreeRoot)) {
    throw Object.assign(new Error('worktree_root must identify a bound project root'), {
      code: 'MCP_WORKTREE_INVALID',
    });
  }
  const resolution = resolveProjectVault({ startDir: worktreeBinding.projectRoot });
  const declaredProject = canonicalPath(declaredProjectRoot);
  const resolvedProject = canonicalPath(resolution.projectRoot || worktreeBinding.projectRoot);
  const boundWorktree = canonicalPath(worktreeBinding.projectRoot);
  if (declaredProject !== resolvedProject && declaredProject !== boundWorktree) {
    throw Object.assign(new Error('declared project does not match the resolved binding'), {
      code: 'MCP_PROJECT_SCOPE_MISMATCH',
    });
  }
  return {
    projectRoot: resolution.projectRoot || worktreeBinding.projectRoot,
    worktreeRoot: worktreeBinding.projectRoot,
    resolution,
    vaultBase: resolution.base,
  };
}

function sanitize(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([field]) => !/(?:absolute_)?path$/i.test(field))
      .map(([field, child]) => [field, sanitize(child, field)]));
  }
  if (typeof value !== 'string') return value;
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return '[LOCAL_PATH]';
  return value
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b[A-Za-z]:\\+[^\s)'"\r\n]+/g, '[LOCAL_PATH]')
    .replace(/\/(?:Users|home|private|tmp)\/[^\s)'"\r\n]+/g, '[LOCAL_PATH]')
    .slice(0, key === 'output' ? 20_000 : 4_000);
}

function parseCliOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return { ok: true };
  try { return JSON.parse(text); }
  catch { return { ok: true, output: text }; }
}

function runCli(argv, cwd, signal, allowedExitCodes = [0]) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [BIN, ...argv], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OBSIDIAN_VAULT_PATH: '' },
    });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => `${current}${chunk}`.slice(-OUTPUT_LIMIT);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', rejectRun);
    child.once('exit', (code) => {
      signal?.removeEventListener('abort', abort);
      const parsed = parseCliOutput(stdout);
      if (allowedExitCodes.includes(code)) resolveRun(sanitize(parsed));
      else {
        const error = new Error(parsed?.error || stderr || `CLI exited ${code}`);
        error.code = parsed?.code || 'MCP_CLI_REJECTED';
        rejectRun(error);
      }
    });
  });
}

function cliArgs(tool, args, ctx) {
  const common = ['--project', ctx.worktreeRoot, '--vault', ctx.vaultBase, '--json'];
  const session = args.session_id ? ['--session', String(args.session_id)] : [];
  const change = args.change ? ['--change', String(args.change)] : [];
  const task = String(args.task || '');
  switch (tool.name) {
    case 'wendkeep_spec_effective': return ['spec', 'effective', ...change, ...session, ...common];
    case 'wendkeep_task_show': return ['task', 'show', task, ...change, ...session, ...common];
    case 'wendkeep_task_evaluate': return ['task', 'evaluate', task, ...change, ...session, ...common];
    case 'wendkeep_task_claim': return ['task', 'claim', task, ...change, ...session, ...common];
    case 'wendkeep_task_complete': return ['change', 'done', task, ...change, ...session, ...common];
    case 'wendkeep_context_select': return [
      'context', 'recover', ...session, '--select', String(args.payload?.select || ''),
      '--revision', String(args.payload?.revision || ''), '--reason', String(args.reason), ...common,
    ];
    default: return null;
  }
}

function changeResult(tool, args, vaultBase) {
  const state = allChangesState(vaultBase);
  if (tool.name === 'wendkeep_change_list') return sanitize(state.changes);
  const change = state.changes.find((candidate) => candidate.slug === String(args.change || ''));
  if (!change) throw Object.assign(new Error('change not found'), { code: 'MCP_CHANGE_NOT_FOUND' });
  return sanitize(tool.name === 'wendkeep_change_status'
    ? { slug: change.slug, current: change.current, open_count: change.openCount, done_count: change.doneCount, warning: change.warning }
    : change);
}

async function observerQuery(args, ctx) {
  const {
    openObserverDatabase,
    readSqlProjectOverview,
    readUsageBreakdown,
    readUsageCalls,
    readUsageSummary,
    searchSqlDocuments,
  } = await import('../../../src/observer-sql-store.mjs');
  const kind = String(args.query || 'overview').trim();
  const filters = args.payload?.filters && typeof args.payload.filters === 'object'
    ? args.payload.filters
    : {};
  const dataDir = resolve(process.env.WENDKEEP_OBSERVER_DATA_DIR || join(homedir(), '.wendkeep-observer'));
  let db;
  try {
    db = openObserverDatabase(dataDir);
    switch (kind) {
      case 'overview': return sanitize(readSqlProjectOverview(db, ctx.resolution.projectId));
      case 'usage_summary': return sanitize(readUsageSummary(db, ctx.resolution.projectId, filters));
      case 'usage_breakdown': return sanitize(readUsageBreakdown(db, ctx.resolution.projectId, filters));
      case 'usage_calls': return sanitize(readUsageCalls(db, ctx.resolution.projectId, filters));
      case 'memory_search': return sanitize(searchSqlDocuments(
        db, ctx.resolution.projectId, String(args.payload?.text || ''),
      ));
      default: throw Object.assign(new Error('unsupported semantic Observer query'), {
        code: 'MCP_OBSERVER_QUERY_INVALID',
      });
    }
  } finally {
    db?.close();
  }
}

function assertMemory(tool, args, ctx, identity) {
  const payload = args.payload && typeof args.payload === 'object' ? args.payload : {};
  const memoryKey = tool.name === 'wendkeep_handoff_publish'
    ? 'handoff.latest'
    : String(payload.memory_key || '').trim();
  if (!memoryKey || !Object.hasOwn(payload, 'value')) {
    throw Object.assign(new Error('payload.memory_key and payload.value are required'), {
      code: 'MCP_MEMORY_ASSERT_INVALID',
    });
  }
  const authority = ['candidate', 'reported'].includes(payload.authority)
    ? payload.authority
    : 'reported';
  const entry = readSessionRegistry(ctx.vaultBase).sessions?.[String(args.session_id)] || {};
  const activationId = String(entry.active_activation_id || entry.activation_id || '').trim();
  if (!activationId) {
    throw Object.assign(new Error('active session activation is required'), {
      code: 'MCP_SESSION_ACTIVATION_REQUIRED',
    });
  }
  const changeSlug = String(payload.change || entry.change_slug || '').trim();
  const event = {
    v: 1,
    event_id: `mcp-${createHash('sha256').update(JSON.stringify([
      identity.projectId, args.session_id, args.lease?.id, tool.name,
    ])).digest('hex').slice(0, 32)}`,
    project_id: identity.projectId,
    memory_key: memoryKey,
    scope: scopeForMemoryKey(memoryKey, {
      projectId: identity.projectId,
      repositoryId: identity.repositoryId,
      worktreeId: identity.worktreeId,
      workSessionId: identity.workSessionId,
      changeSlug,
    }),
    operation: 'assert',
    value: payload.value,
    authority,
    canonical_session_id: String(args.session_id),
    activation_id: activationId,
    activation_epoch: Number(entry.activation_epoch || 0),
    turn_sequence: Number(entry.last_turn_sequence || 0),
    observed_at: new Date().toISOString(),
    evidence: (Array.isArray(payload.evidence) ? payload.evidence : [])
      .slice(0, 20)
      .map((item) => sanitizeMemoryText(item)),
    ...(identity.workSessionId ? { work_session_id: identity.workSessionId } : {}),
  };
  const enqueued = enqueueMemoryEvent(ctx.vaultBase, event);
  const projected = projectMemoryOutbox(ctx.vaultBase);
  return sanitize({
    schema_version: 1,
    status: enqueued.status,
    event_id: enqueued.eventId,
    checkpoint: projected.checkpoint || null,
  });
}

export async function executeNativeMcpTool(tool, args, { signal } = {}) {
  const ctx = contextFor(args);
  let writeIdentity = null;
  if (tool.effect === 'write') {
    writeIdentity = resolveCommandActiveContext({
      vaultBase: ctx.vaultBase,
      projectRoot: ctx.worktreeRoot,
      sessionId: String(args.session_id || ''),
      requireExisting: true,
    });
    if (!writeIdentity || activeContextKey(writeIdentity) !== String(args.active_context_id || '')) {
      throw Object.assign(new Error('active context does not match the causal session'), {
        code: 'MCP_ACTIVE_CONTEXT_MISMATCH',
      });
    }
    const authorized = readSessionRegistry(ctx.vaultBase)
      .sessions?.[String(args.session_id)]?.project_scope?.authorizedActions;
    if (Array.isArray(authorized)
        && !authorized.includes(tool.capability)
        && !authorized.includes('tool:mutation')
        && !authorized.includes('*')) {
      throw Object.assign(new Error('capability is not authorized by the causal project scope'), {
        code: 'MCP_SCOPE_AUTH_REQUIRED',
      });
    }
  }
  if (['wendkeep_memory_assert', 'wendkeep_handoff_publish'].includes(tool.name)) {
    return assertMemory(tool, args, ctx, writeIdentity);
  }
  if (tool.name === 'wendkeep_checkpoint_create') {
    return sanitize({
      schema_version: 1,
      checkpoint: projectMemoryOutbox(ctx.vaultBase).checkpoint || null,
    });
  }
  if (tool.name === 'wendkeep_observer_query') return observerQuery(args, ctx);
  if (tool.name === 'wendkeep_project_status') {
    const canonicalBinding = ctx.resolution.source === 'worktree-registry'
      ? readProjectBinding(ctx.projectRoot)
      : null;
    const profile = resolveOperatingProfile(canonicalBinding?.config || ctx.resolution.config || {});
    return {
      schema_version: 1,
      project_id: ctx.resolution.projectId || '',
      binding_source: ctx.resolution.source,
      profile: profile.profile,
      profile_source: profile.source,
    };
  }
  if (tool.name === 'wendkeep_context_status') {
    return sanitize(inspectSessionContext({
      vaultBase: ctx.vaultBase,
      projectRoot: ctx.worktreeRoot,
      sessionId: String(args.session_id || ''),
    }));
  }
  if (tool.name === 'wendkeep_memory_recall') {
    return sanitize(recallEvidence(loadEvidenceIndex(ctx.vaultBase), String(args.query || ''), {
      topK: Math.min(Number(args.limit || 10), 100),
    }));
  }
  if (tool.name === 'wendkeep_memory_conflicts') {
    return sanitize(listMemoryCandidates(ctx.vaultBase, { activeOnly: true }).candidates);
  }
  if (['wendkeep_change_list', 'wendkeep_change_show', 'wendkeep_change_status'].includes(tool.name)) {
    return changeResult(tool, args, ctx.vaultBase);
  }
  if (tool.name === 'wendkeep_handoff_current') {
    const ledger = readMemoryLedger(ctx.vaultBase);
    if (ledger.errors.length) {
      throw Object.assign(new Error('memory ledger is not valid'), { code: 'MCP_MEMORY_LEDGER_INVALID' });
    }
    const session = readSessionRegistry(ctx.vaultBase).sessions?.[String(args.session_id)] || {};
    const workSessionId = String(session.work_session_id || '');
    const scoped = ledger.events.filter((event) => (
      event.memory_key === 'handoff.latest'
      && (!workSessionId || event.scope?.id === workSessionId || event.work_session_id === workSessionId)
    ));
    const record = deriveMemoryProjection(ctx.vaultBase, scoped).records?.['handoff.latest'];
    if (!record) throw Object.assign(new Error('current handoff not found'), { code: 'MCP_HANDOFF_NOT_FOUND' });
    return sanitize({
      schema_version: 1,
      value: record.value,
      revision: record.revision,
      authority: record.source?.authority || '',
      observed_at: record.source?.observed_at || '',
    });
  }
  if (tool.name === 'wendkeep_evidence_latest') {
    const slug = String(args.change || allChangesState(ctx.vaultBase).current || '');
    if (!slug) throw Object.assign(new Error('change is required'), { code: 'MCP_CHANGE_REQUIRED' });
    const file = join(ctx.vaultBase, getLocale(ctx.vaultBase).folders.changes, slug, 'evidencia.json');
    try { return sanitize(JSON.parse(readFileSync(file, 'utf8'))); }
    catch { throw Object.assign(new Error('evidence not found'), { code: 'MCP_EVIDENCE_NOT_FOUND' }); }
  }
  const argv = cliArgs(tool, args, ctx);
  if (argv) {
    return runCli(
      argv,
      ctx.worktreeRoot,
      signal,
      tool.name === 'wendkeep_task_evaluate' ? [0, 1] : [0],
    );
  }
  throw Object.assign(new Error(`${tool.name} is not available in the native adapter yet`), {
    code: 'MCP_CAPABILITY_UNAVAILABLE',
  });
}
