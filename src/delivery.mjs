import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  assertVaultPathSafe, mkdirVaultPath, writeVaultFileSync,
} from '../hooks/vault-path-safety.mjs';
import { resolveProjectVault } from './project-vault.mjs';
import { createWorkRoute } from './work-kind.mjs';
import {
  activeContextKey,
  clearActiveContextDelivery,
  resolveActiveContext,
  setActiveContextDelivery,
} from '../hooks/active-context-store.mjs';
import { resolveCommandActiveContext } from './active-context-runtime.mjs';
import {
  evaluateProvenanceGate,
  evaluateReleaseChain,
} from './provenance-gate.mjs';
import {
  collectCiObservation,
  collectGitHubReleaseObservation,
  collectGitSubject,
  collectNpmObservation,
  collectTagObservation,
  normalizeRepository,
} from './provenance-sources.mjs';
import {
  appendReceipt as appendLedgerReceipt,
  createFileReceiptStore,
  readReceiptLedger,
} from './receipt-ledger.mjs';
import { collectArtifactAtCommit } from './release-provenance.mjs';

export const DELIVERY_HELP = `wendkeep delivery <subcommand>

  start [id] --allow <capability> [--source-change <slug>] [--source-commit <sha>]
  status [id]
  finish [id] [--target <remote>/<branch>] [--ci-url <url>] [--version <x.y.z>]
              [--npm-integrity <sha512-...>] [--release-url <url>]
  abandon [id] --reason <text>

Common options: --project <path> --vault <path> --session <id> --json
Delivery authorizes operational risk and creates an append-only receipt. It never creates a change,
spec, or ADR. If code/config must change, abandon or pause delivery and resume an implementation.
`;

export const DELIVERY_CAPABILITIES = Object.freeze([
  'git:merge', 'git:pull', 'git:push', 'git:tag', 'publish',
]);

const REMOTE_TARGET_CAPABILITIES = Object.freeze(['git:merge', 'git:push']);
const REMOTE_BOUND_CAPABILITIES = Object.freeze([...REMOTE_TARGET_CAPABILITIES, 'publish']);

const VALUE_OPTIONS = new Set([
  '--project', '--vault', '--allow', '--source-change', '--source-commit', '--target',
  '--ci-url', '--version', '--npm-integrity', '--release-url', '--reason', '--session',
]);

function parseArgv(argv) {
  const values = new Map();
  const positionals = [];
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--json') { json = true; continue; }
    if (item.startsWith('--')) {
      const eq = item.indexOf('=');
      const name = eq > 0 ? item.slice(0, eq) : item;
      if (!VALUE_OPTIONS.has(name)) throw new Error(`opção desconhecida: ${name}`);
      const value = eq > 0 ? item.slice(eq + 1) : argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${name} requer um valor`);
      const list = values.get(name) || [];
      list.push(value);
      values.set(name, list);
      continue;
    }
    positionals.push(item);
  }
  return {
    json,
    positionals,
    value: (name) => values.get(name)?.at(-1) || '',
    all: (name) => values.get(name) || [],
  };
}

function sanitizeDeliveryText(value, maximum = 240) {
  const clean = String(value || '')
    .replace(/\b(?:ghp|github_pat|npm_|sk-|xox[baprs]-)[A-Za-z0-9_-]+/gi, '[redacted-token]')
    .replace(/\b(?:token|authorization|bearer|password|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '[redacted-token]')
    .replace(/\bBearer\s+[^\s,;]+/gi, '[redacted-token]')
    .replace(/[A-Za-z]:\\[^\r\n"'`;|&]+/g, '[redacted-path]')
    .replace(/(?:^|\s)\/[^\s"'`;|&]+/g, ' [redacted-path]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return clean.length > maximum ? `${clean.slice(0, maximum - 3)}...` : clean;
}

function sanitizedDeliveryValue(value, depth = 0) {
  if (depth > 4 || value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitizeDeliveryText(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizedDeliveryValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 30)
      .map(([key, item]) => [sanitizeDeliveryText(key, 80), sanitizedDeliveryValue(item, depth + 1)]));
  }
  return sanitizeDeliveryText(value);
}

function gitFailure(error) {
  const failure = new Error('Falha ao consultar o repositório Git para a delivery.');
  failure.code = 'WENDKEEP_DELIVERY_GIT_FAILED';
  failure.operation = 'delivery.git';
  failure.state = 'unproven';
  failure.blocker = failure.code;
  failure.recovery = 'wendkeep delivery status --json';
  if (Number.isSafeInteger(Number(error?.status))) failure.status = Number(error.status);
  return failure;
}

function git(projectRoot, args, optional = false) {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (optional) return '';
    throw gitFailure(error);
  }
}

function gitWith(projectRoot, args, execute = execFileSync, optional = false) {
  try {
    return String(execute('git', args, {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, timeout: 15_000,
    }) || '').trim();
  } catch (error) {
    if (optional) return '';
    throw gitFailure(error);
  }
}

function deliveryPaths(vaultBase, id = '') {
  const runtime = join(vaultBase, '.brain', 'runtime');
  const deliveries = join(runtime, 'deliveries');
  return {
    runtime,
    deliveries,
    pointer: join(runtime, 'CURRENT_DELIVERY'),
    legacyReceipts: join(runtime, 'delivery-receipts.jsonl'),
    receipts: join(runtime, 'delivery-receipts-v2.jsonl'),
    receiptsCheckpoint: join(runtime, 'delivery-receipts-v2.checkpoint.json'),
    receiptsLock: join(runtime, 'delivery-receipts-v2.lock'),
    state: id ? join(deliveries, `${id}.json`) : '',
  };
}

function safeId(value) {
  const id = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,100}$/i.test(id)) throw new Error('id de delivery inválido');
  return id;
}

function generatedId(now = new Date()) {
  return `delivery-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').toLowerCase()}`;
}

function readPointer(vaultBase) {
  const { pointer } = deliveryPaths(vaultBase);
  try { return safeId(readFileSync(pointer, 'utf8').trim()); } catch { return ''; }
}

function deliveryContextError(message) {
  const error = new Error(message);
  error.code = 'WENDKEEP_DELIVERY_CONTEXT_MISMATCH';
  error.operation = 'delivery';
  error.state = 'conflict';
  error.blocker = error.code;
  error.recovery = 'wendkeep delivery status --json';
  return error;
}

function deliveryContextBusy(id) {
  const error = new Error(`active context já possui delivery ativo: ${id}`);
  error.code = 'WENDKEEP_DELIVERY_CONTEXT_BUSY';
  return error;
}

function contextualBinding(vaultBase, context, expectedId = '') {
  const binding = resolveActiveContext(vaultBase, context);
  const id = String(binding.delivery_id || '').trim();
  if (expectedId && id !== expectedId) {
    throw deliveryContextError(`delivery ${expectedId} não pertence ao active context chamador`);
  }
  return { binding, id, key: activeContextKey(context) };
}

function contextIdentityBinding(context, authority = {}) {
  return {
    project_id: String(authority.project_id ?? context?.projectId ?? context?.project_id ?? ''),
    repository_id: String(authority.repository_id ?? context?.repositoryId ?? context?.repository_id ?? ''),
    worktree_id: String(authority.worktree_id ?? context?.worktreeId ?? context?.worktree_id ?? ''),
    work_session_id: String(authority.work_session_id ?? context?.workSessionId ?? context?.work_session_id ?? ''),
    change_slug: String(authority.change_slug || ''),
  };
}

function assertStateContext(state, binding) {
  if (state.context_key && !binding) {
    throw deliveryContextError(`delivery ${state.id} exige o active context proprietário`);
  }
  if (!binding) return;
  if (state.context_key !== binding.key) {
    throw deliveryContextError(`delivery ${state.id} pertence a outro active context`);
  }
}

function normalizedCheckoutPath(value) {
  let canonical = resolve(String(value || ''));
  try { canonical = realpathSync.native(canonical); } catch { /* mismatch stays fail-closed below */ }
  const normalized = canonical.replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function deliveryScopeError(details) {
  const error = new Error('delivery não pertence ao repository, worktree ou branch atuais');
  error.code = 'WENDKEEP_DELIVERY_SCOPE_MISMATCH';
  error.details = details;
  error.operation = 'delivery.finish';
  error.state = 'conflict';
  error.blocker = error.code;
  error.recovery = 'wendkeep delivery status --json';
  return error;
}

function assertStateCheckout(state, repoRoot, execute) {
  const currentWorktree = gitWith(repoRoot, ['rev-parse', '--show-toplevel'], execute, true);
  const currentBranch = gitWith(repoRoot, ['branch', '--show-current'], execute, true);
  const sameRepository = Boolean(typeof state.repository === 'string' && state.repository
    && normalizedCheckoutPath(repoRoot) === normalizedCheckoutPath(state.repository));
  const sameWorktree = Boolean(typeof state.worktree === 'string' && state.worktree && currentWorktree
    && normalizedCheckoutPath(currentWorktree) === normalizedCheckoutPath(state.worktree));
  const sameBranch = typeof state.branch === 'string' && currentBranch === state.branch;
  if (!sameRepository || !sameWorktree || !sameBranch) {
    throw deliveryScopeError({ same_repository: sameRepository, same_worktree: sameWorktree, same_branch: sameBranch });
  }
}

export function activeDelivery(vaultBase, { context = null } = {}) {
  let binding = null;
  let id = readPointer(vaultBase);
  if (context) {
    try { binding = contextualBinding(vaultBase, context); }
    catch (error) {
      if (error?.code === 'WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND') return null;
      throw error;
    }
    id = binding.id;
  }
  if (!id) return null;
  try {
    const state = readState(vaultBase, id);
    assertStateContext(state, binding);
    return state.state === 'active' ? state : null;
  } catch {
    return null;
  }
}

function readState(vaultBase, id) {
  const path = deliveryPaths(vaultBase, id).state;
  const checked = assertVaultPathSafe(vaultBase, path, {
    allowMissing: false, expectedType: 'file', label: `delivery ${id}`,
  });
  return JSON.parse(readFileSync(checked.target, 'utf8'));
}

function writeState(vaultBase, state) {
  const paths = deliveryPaths(vaultBase, state.id);
  mkdirVaultPath(vaultBase, paths.runtime, { label: 'runtime de delivery' });
  mkdirVaultPath(vaultBase, paths.deliveries, { label: 'estados de delivery' });
  writeVaultFileSync(vaultBase, paths.state, `${JSON.stringify(state, null, 2)}\n`, 'utf8', {
    label: `delivery ${state.id}`,
  });
}

function setPointer(vaultBase, id = '') {
  const paths = deliveryPaths(vaultBase);
  mkdirVaultPath(vaultBase, paths.runtime, { label: 'runtime de delivery' });
  writeVaultFileSync(vaultBase, paths.pointer, id ? `${id}\n` : '', 'utf8', {
    label: 'ponteiro de delivery',
  });
}

function receiptStore(vaultBase) {
  const paths = deliveryPaths(vaultBase);
  mkdirVaultPath(vaultBase, paths.runtime, { label: 'runtime de delivery' });
  for (const [path, label] of [
    [paths.receipts, 'ledger v2 de receipts de delivery'],
    [paths.receiptsCheckpoint, 'checkpoint do ledger de delivery'],
    [paths.receiptsLock, 'lock do ledger de delivery'],
    [paths.legacyReceipts, 'ledger legado de delivery'],
  ]) assertVaultPathSafe(vaultBase, path, {
    allowMissing: true,
    expectedType: 'file',
    label,
  });
  return createFileReceiptStore({
    ledgerPath: paths.receipts,
    checkpointPath: paths.receiptsCheckpoint,
    legacyPath: paths.legacyReceipts,
    lockPath: paths.receiptsLock,
  });
}

function context(parsed) {
  const projectRoot = resolve(parsed.value('--project') || process.cwd());
  const resolved = resolveProjectVault({
    startDir: projectRoot,
    explicitVault: parsed.value('--vault'),
  });
  const repoRoot = git(projectRoot, ['rev-parse', '--show-toplevel']);
  return { projectRoot, repoRoot, vaultBase: resolved.base };
}

function currentId(parsed, vaultBase, commandContext = null) {
  const explicit = parsed.positionals[1];
  if (explicit) return safeId(explicit);
  return safeId(commandContext
    ? activeDelivery(vaultBase, { context: commandContext })?.id
    : readPointer(vaultBase));
}

function ensureClean(repoRoot) {
  const dirty = git(repoRoot, ['status', '--porcelain']);
  if (dirty) {
    const error = new Error('delivery requer working tree limpa; alterações de código/config exigem implementation.');
    error.code = 'WENDKEEP_DELIVERY_IMPLEMENTATION_REQUIRED';
    throw error;
  }
}

export function startDelivery({
  vaultBase,
  repoRoot,
  id,
  capabilities,
  sourceChange = '',
  sourceCommit = '',
  context = null,
  bindDelivery = setActiveContextDelivery,
  removeState = rmSync,
  now = new Date(),
}) {
  ensureClean(repoRoot);
  const deliveryId = safeId(id || generatedId(now));
  const paths = deliveryPaths(vaultBase, deliveryId);
  if (existsSync(paths.state)) throw new Error(`delivery já existe: ${deliveryId}`);
  let existingContext = null;
  if (context) {
    try {
      const current = contextualBinding(vaultBase, context);
      if (current.id) throw deliveryContextBusy(current.id);
      existingContext = current.binding;
    } catch (error) {
      if (error?.code !== 'WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND') throw error;
    }
  }
  const requestedCapabilities = [...new Set((capabilities || []).map((item) => String(item).trim()).filter(Boolean))];
  const invalidCapabilities = requestedCapabilities.filter((item) => !DELIVERY_CAPABILITIES.includes(item));
  if (invalidCapabilities.length) {
    throw new Error(`capability inválida: ${invalidCapabilities.join(', ')}. Use ${DELIVERY_CAPABILITIES.join(', ')}.`);
  }
  if (!requestedCapabilities.length) throw new Error('delivery start requer ao menos um --allow <capability>');
  const commit = git(repoRoot, [
    'rev-parse', '--verify', '--end-of-options', `${sourceCommit || 'HEAD'}^{commit}`,
  ]);
  const remoteName = 'origin';
  const remoteRepository = normalizeRepository(git(repoRoot, ['remote', 'get-url', remoteName], true));
  if (requestedCapabilities.some((capability) => REMOTE_BOUND_CAPABILITIES.includes(capability)) && !remoteRepository) {
    const error = new Error('delivery externa requer remote origin GitHub identificável no start.');
    error.code = 'WENDKEEP_DELIVERY_REPOSITORY_REQUIRED';
    throw error;
  }
  const route = createWorkRoute({
    workKind: 'delivery', profile: 'ASSURE', contractImpact: 'none',
    operationRisk: requestedCapabilities, sourceChange, sourceCommit: commit,
  });
  const state = {
    schema_version: 1,
    id: deliveryId,
    state: 'active',
    route,
    repository: repoRoot,
    remote_name: remoteName,
    remote_repository: remoteRepository,
    worktree: repoRoot,
    branch: git(repoRoot, ['branch', '--show-current'], true),
    source_commit: commit,
    ...(context ? {
      context_key: activeContextKey(context),
      ...contextIdentityBinding(context, existingContext || {}),
    } : {}),
    started_at: now.toISOString(),
  };
  writeState(vaultBase, state);
  if (context) {
    try { bindDelivery(vaultBase, context, deliveryId); }
    catch (error) {
      try { removeState(paths.state, { force: true }); } catch { /* rollback best-effort */ }
      throw error;
    }
  } else {
    setPointer(vaultBase, deliveryId);
  }
  return state;
}

const DEFAULT_PROVENANCE_COLLECTORS = Object.freeze({
  collectGitSubject,
  collectArtifactObservation: collectArtifactAtCommit,
  collectTagObservation,
  collectCiObservation,
  collectNpmObservation,
  collectGitHubReleaseObservation,
});

function observationAssessment(kind, observation) {
  const state = String(observation?.state || 'unproven');
  return {
    kind,
    state,
    reasonCodes: observation?.reasonCodes || (state === 'verified' ? [] : ['PROV_REQUIRED_ASSESSMENT_MISSING']),
    diagnostics: observation?.diagnostics || [{ kind, state }],
  };
}

function verifiedAssessment(kind, diagnostics = []) {
  return { kind, state: 'verified', reasonCodes: [], diagnostics };
}

function conflictAssessment(kind, code, diagnostics = []) {
  return { kind, state: 'conflict', reasonCodes: [code], diagnostics };
}

function provenanceBlocked(gate, message = 'delivery bloqueada por evidência de proveniência insuficiente') {
  const error = new Error(message);
  error.code = 'WENDKEEP_PROVENANCE_GATE_BLOCKED';
  error.provenance = gate;
  error.operation = 'delivery.finish';
  error.state = gate?.state || 'unproven';
  error.blocker = gate?.reasonCodes?.[0] || 'PROV_REQUIRED_ASSESSMENT_MISSING';
  error.recovery = gate?.repair?.command || 'wendkeep delivery status --json';
  const first = gate?.diagnostics?.[0] || {};
  error.expected = first.expected ?? null;
  error.observed = first.observed ?? null;
  return error;
}

function remoteBindingObservation({ repoRoot, state, remote = state.remote_name || 'origin', execute }) {
  const expectedRepository = normalizeRepository(state.remote_repository || '');
  const remoteUrl = gitWith(repoRoot, ['remote', 'get-url', remote], execute, true);
  const repository = normalizeRepository(remoteUrl);
  if (!expectedRepository) {
    return {
      state: 'unproven', reasonCodes: ['PROVENANCE_REPOSITORY_UNBOUND'], remote, repository,
    };
  }
  if (!repository) {
    return {
      state: 'unproven', reasonCodes: ['PROVENANCE_REPOSITORY_UNOBSERVED'], remote, repository,
    };
  }
  if (repository !== expectedRepository) {
    return {
      state: 'conflict', reasonCodes: ['PROVENANCE_REPOSITORY_MISMATCH'],
      remote, repository, expectedRepository,
    };
  }
  return {
    state: 'verified', reasonCodes: [], remote, repository, expectedRepository,
  };
}

function parseRemoteTarget(target) {
  const value = String(target || '').trim();
  const match = value.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/(.+)$/);
  if (!match) return null;
  const remote = match[1];
  const branch = match[2].replace(/^refs\/heads\//, '');
  if (!branch || branch.startsWith('-') || branch.endsWith('/') || branch.endsWith('.')
    || branch.includes('..') || branch.includes('@{') || branch.includes('\\')
    || /[\u0000-\u0020~^:?*[\u007f]/.test(branch)
    || branch.split('/').some((part) => !part || part.endsWith('.lock'))) return null;
  return { remote, branch, ref: `refs/heads/${branch}` };
}

function remoteTargetObservation({ repoRoot, state, target, execute }) {
  const parsed = parseRemoteTarget(target);
  if (!parsed) {
    return { state: 'unproven', reasonCodes: ['PROVENANCE_REMOTE_TARGET_REQUIRED'] };
  }
  const expectedRemote = String(state.remote_name || 'origin');
  if (parsed.remote !== expectedRemote) {
    return {
      state: 'conflict', reasonCodes: ['PROVENANCE_REMOTE_TARGET_MISMATCH'],
      remote: parsed.remote, expectedRemote, ref: parsed.ref,
    };
  }
  const binding = remoteBindingObservation({ repoRoot, state, remote: parsed.remote, execute });
  if (binding.state !== 'verified') return { ...binding, ref: parsed.ref };
  let output;
  try {
    output = gitWith(repoRoot, [
      'ls-remote', '--exit-code', parsed.remote, parsed.ref,
    ], execute);
  } catch (error) {
    return {
      state: Number(error?.status) === 2 ? 'unproven' : 'reported',
      reasonCodes: [Number(error?.status) === 2
        ? 'PROVENANCE_REMOTE_TARGET_UNOBSERVED'
        : 'PROVENANCE_SOURCE_UNAVAILABLE'],
      remote: parsed.remote,
      ref: parsed.ref,
      repository: binding.repository,
    };
  }
  const matches = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line) => line.match(/^([0-9a-f]{40})\s+(.+)$/i)).filter(Boolean)
    .filter((match) => match[2] === parsed.ref);
  if (matches.length !== 1) {
    return {
      state: 'unproven', reasonCodes: ['PROVENANCE_REMOTE_TARGET_UNOBSERVED'],
      remote: parsed.remote, ref: parsed.ref, repository: binding.repository,
    };
  }
  return {
    state: 'verified', reasonCodes: [], commit: matches[0][1], remote: parsed.remote,
    ref: parsed.ref, repository: binding.repository, locator: `${parsed.remote}/${parsed.branch}`,
  };
}

function completedReceipt(vaultBase, state) {
  const receipt = state.receipt;
  if (!receipt || receipt.schema_version !== 2) {
    const error = new Error('State completed não contém receipt v2 verificável.');
    error.code = 'WENDKEEP_RECEIPT_LEDGER_CORRUPT';
    throw error;
  }
  const ledger = readReceiptLedger({ store: receiptStore(vaultBase) });
  const record = ledger.records.find((candidate) => candidate.receipt_id === receipt.receipt_id);
  const binding = deliveryBinding(state);
  const recordMatches = record
    && record.receipt_hash === receipt.receipt_hash
    && record.sequence === receipt.sequence
    && record.kind === 'delivery.completed'
    && record.subject?.delivery_id === state.id
    && record.subject?.source_commit === state.source_commit
    && record.subject?.target_commit === state.target_commit
    && receipt.delivery_id === state.id
    && receipt.source_commit === state.source_commit
    && receipt.target_commit === state.target_commit
    && receipt.target === state.target
    && Object.entries(binding).every(([key, value]) => record.subject?.[key] === value && receipt[key] === value)
    && Object.keys(record).every((key) => isDeepStrictEqual(receipt[key], record[key]));
  if (!recordMatches) {
    const error = new Error('Receipt do state completed diverge do ledger v2 verificado.');
    error.code = 'WENDKEEP_RECEIPT_LEDGER_CORRUPT';
    throw error;
  }
  return receipt;
}

function sanitizedLocator(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

function sanitizedEvidence(evidence = {}) {
  return {
    version: String(evidence.version || ''),
    npm_integrity: String(evidence.npm_integrity || ''),
    ci_url: sanitizedLocator(evidence.ci_url),
    release_url: sanitizedLocator(evidence.release_url),
  };
}

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function privateReason(reason) {
  return { reason: 'operator-provided', reason_digest: sha256Text(String(reason).trim()) };
}

function deliveryBinding(state) {
  return {
    project_id: String(state.project_id || ''),
    repository_id: String(state.repository_id || ''),
    repository: String(state.remote_repository || ''),
    worktree_id: String(state.worktree_id || ''),
    work_session_id: String(state.work_session_id || ''),
    change_slug: String(state.route?.source_change || state.change_slug || ''),
    branch: String(state.branch || ''),
  };
}

function releaseLocatorMatches(locator, repository, tag) {
  try {
    const url = new URL(String(locator || ''));
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'github.com'
      && normalizeRepository(`${parts[0] || ''}/${parts[1] || ''}`) === repository
      && parts[2] === 'releases'
      && parts[3] === 'tag'
      && parts.slice(4).join('/') === tag;
  } catch {
    return false;
  }
}

function sanitizedObservation(value = {}) {
  const clean = {};
  for (const key of [
    'state', 'kind', 'commit', 'sourceCommit', 'targetCommit', 'name', 'version', 'tag',
    'integrity', 'repository', 'locator', 'remote', 'ref', 'conclusion', 'status',
    'expectedCommit', 'expectedIntegrity', 'expectedRepository',
  ]) if (value[key] !== undefined) clean[key] = value[key];
  if (Array.isArray(value.reasonCodes)) clean.reasonCodes = value.reasonCodes.map(String);
  if (value.package && typeof value.package === 'object') {
    clean.package = { name: String(value.package.name || ''), version: String(value.package.version || '') };
  }
  return clean;
}

function sanitizedObservations(observations = {}) {
  return Object.fromEntries(Object.entries(observations).map(([kind, value]) => [kind, sanitizedObservation(value)]));
}

function deliveryReceiptDraft({ state, target, targetCommit, capabilities, evidence, observations, now }) {
  return {
    kind: 'delivery.completed',
    subject: {
      delivery_id: state.id,
      source_commit: state.source_commit,
      target,
      target_commit: targetCommit,
      ...deliveryBinding(state),
    },
    claims: {
      work_kind: 'delivery',
      source_change: state.route.source_change || '',
      capabilities,
      evidence: sanitizedEvidence(evidence),
      ...(state.context_key ? { context_key: state.context_key } : {}),
    },
    observations: sanitizedObservations(observations),
    recorded_at: now.toISOString(),
  };
}

function publicDeliveryReceipt(record, state, target, targetCommit, capabilities, evidence) {
  return {
    ...record,
    delivery_id: state.id,
    outcome: 'completed',
    work_kind: 'delivery',
    source_change: state.route.source_change || '',
    source_commit: state.source_commit,
    ...deliveryBinding(state),
    ...(state.context_key ? { context_key: state.context_key } : {}),
    target,
    target_commit: targetCommit,
    capabilities,
    evidence: sanitizedEvidence(evidence),
    finished_at: record.recorded_at,
  };
}

export function finishDelivery({
  vaultBase,
  repoRoot,
  id,
  target = 'HEAD',
  evidence = {},
  context = null,
  now = new Date(),
  collectors = DEFAULT_PROVENANCE_COLLECTORS,
  execute = execFileSync,
  appendLedger = appendLedgerReceipt,
  persistState = writeState,
  clearContextDelivery = clearActiveContextDelivery,
}) {
  const state = readState(vaultBase, safeId(id));
  const binding = context
    ? contextualBinding(vaultBase, context, state.state === 'active' ? state.id : '')
    : null;
  assertStateContext(state, binding);
  assertStateCheckout(state, repoRoot, execute);
  ensureClean(repoRoot);
  if (state.state === 'completed') {
    const receipt = completedReceipt(vaultBase, state);
    if (context && binding.id === state.id) {
      clearContextDelivery(vaultBase, context, { expectedRevision: binding.binding.revision });
    }
    if (!context && readPointer(vaultBase) === state.id) setPointer(vaultBase);
    return receipt;
  }
  if (state.state !== 'active') throw new Error(`delivery ${id} não está ativa`);

  const capabilities = state.route?.operation_risk || [];
  const needsRemoteTarget = capabilities.some((capability) => REMOTE_TARGET_CAPABILITIES.includes(capability));
  let remoteTarget = null;
  if (needsRemoteTarget) {
    remoteTarget = remoteTargetObservation({ repoRoot, state, target, execute });
    const remoteGate = evaluateProvenanceGate({
      purpose: 'delivery', assessments: [observationAssessment('remote-target', remoteTarget)], requiredKinds: ['remote-target'],
    });
    if (!remoteGate.ok) throw provenanceBlocked(remoteGate);
  }
  const subject = collectors.collectGitSubject?.({
    repoRoot,
    sourceRef: state.source_commit,
    targetRef: remoteTarget?.commit || target,
    execute,
  }) || { state: 'unproven', reasonCodes: ['PROVENANCE_GIT_SUBJECT_UNRESOLVED'] };
  const targetCommit = String(subject.targetCommit || remoteTarget?.commit
    || gitWith(repoRoot, ['rev-parse', `${target}^{commit}`], execute, true));
  const assessments = [
    ...(remoteTarget ? [observationAssessment('remote-target', remoteTarget)] : []),
    observationAssessment('git-subject', subject),
  ];
  let ancestor = false;
  if (subject.state === 'verified' && subject.sourceCommit === state.source_commit && targetCommit) {
    try {
      gitWith(repoRoot, ['merge-base', '--is-ancestor', state.source_commit, targetCommit], execute);
      ancestor = true;
    } catch { /* represented by the assessment below */ }
  }
  assessments.push(ancestor
    ? verifiedAssessment('ancestry', [{ source_commit: state.source_commit, target_commit: targetCommit }])
    : conflictAssessment('ancestry', 'PROVENANCE_SOURCE_NOT_ANCESTOR', [{ source_commit: state.source_commit, target_commit: targetCommit }]));
  const observations = {
    ...(remoteTarget ? { remote_target: remoteTarget } : {}),
    git_subject: subject,
    ancestry: { state: ancestor ? 'verified' : 'conflict' },
  };
  const requiredKinds = [...(remoteTarget ? ['remote-target'] : []), 'git-subject', 'ancestry'];
  let tagObservation = null;
  let artifactObservation = null;
  let ciObservation = null;
  let npmObservation = null;
  let releaseObservation = null;
  if (capabilities.includes('git:tag') || capabilities.includes('publish')) {
    if (!evidence.version) throw new Error('delivery com tag/publicação requer --version');
    const packageMatches = subject.state === 'verified' && subject.package?.version === evidence.version;
    assessments.push(packageMatches
      ? verifiedAssessment('package', [{ version: subject.package.version, target_commit: targetCommit }])
      : conflictAssessment('package', 'PROVENANCE_VERSION_MISMATCH', [{ expected: evidence.version, observed: subject.package?.version || '' }]));
    requiredKinds.push('package', 'tag');
    tagObservation = collectors.collectTagObservation?.({
      repoRoot,
      tag: `v${evidence.version}`,
      expectedCommit: targetCommit,
      execute,
    }) || { state: 'unproven', reasonCodes: ['PROVENANCE_TAG_UNRESOLVED'] };
    assessments.push(observationAssessment('tag', tagObservation));
    observations.tag = tagObservation;
  }
  if (capabilities.includes('publish')) {
    for (const [key, label] of [
      ['ci_url', '--ci-url'], ['npm_integrity', '--npm-integrity'], ['release_url', '--release-url'],
    ]) if (!evidence[key]) throw new Error(`delivery com publish requer ${label}`);
    const repositoryBinding = remoteBindingObservation({ repoRoot, state, execute });
    assessments.push(observationAssessment('repository', repositoryBinding));
    requiredKinds.push('repository');
    observations.repository = repositoryBinding;
    const repositoryGate = evaluateProvenanceGate({
      purpose: 'delivery',
      assessments: [observationAssessment('repository', repositoryBinding)],
      requiredKinds: ['repository'],
    });
    if (!repositoryGate.ok) throw provenanceBlocked(repositoryGate);
    const repository = repositoryBinding.repository || state.remote_repository || '';
    artifactObservation = collectors.collectArtifactObservation?.({
      repoRoot,
      targetCommit,
      execute,
    }) || { state: 'unproven', reasonCodes: ['PROVENANCE_INTEGRITY_MISSING'] };
    ciObservation = collectors.collectCiObservation?.({
      locator: evidence.ci_url,
      repository,
      expectedCommit: targetCommit,
      execute,
    }) || { state: 'unproven', reasonCodes: ['PROVENANCE_SOURCE_UNAVAILABLE'] };
    npmObservation = collectors.collectNpmObservation?.({
      name: subject.package?.name,
      version: subject.package?.version,
      expectedIntegrity: artifactObservation.integrity,
      expectedCommit: targetCommit,
      repository,
      execute,
    }) || { state: 'unproven', reasonCodes: ['PROVENANCE_SOURCE_UNAVAILABLE'] };
    releaseObservation = collectors.collectGitHubReleaseObservation?.({
      repository,
      tag: `v${evidence.version}`,
      expectedCommit: targetCommit,
      expectedVersion: evidence.version,
      expectedNotes: subject.notes,
      locator: evidence.release_url,
      execute,
    }) || { state: 'unproven', reasonCodes: ['PROVENANCE_SOURCE_UNAVAILABLE'] };
    observations.artifact = artifactObservation;
    observations.ci = ciObservation;
    observations.npm = npmObservation;
    observations.release = releaseObservation;
    for (const [kind, observation] of [
      ['artifact', artifactObservation], ['ci', ciObservation], ['npm', npmObservation], ['release', releaseObservation],
    ]) assessments.push(observationAssessment(kind, observation));
    const integrityClaimMatches = artifactObservation.state === 'verified'
      && evidence.npm_integrity === artifactObservation.integrity;
    assessments.push(integrityClaimMatches
      ? verifiedAssessment('integrity-claim', [{ integrity: artifactObservation.integrity }])
      : conflictAssessment('integrity-claim', 'PROVENANCE_INTEGRITY_MISMATCH', [{
        expected: artifactObservation.integrity || '', observed: evidence.npm_integrity,
      }]));
    const releaseClaimMatches = releaseLocatorMatches(evidence.release_url, repository, `v${evidence.version}`);
    assessments.push(releaseClaimMatches
      ? verifiedAssessment('release-locator')
      : conflictAssessment('release-locator', 'PROVENANCE_REPOSITORY_MISMATCH'));
    requiredKinds.push('artifact', 'ci', 'npm', 'release', 'integrity-claim', 'release-locator', 'release-chain');
    const releaseParts = [tagObservation, artifactObservation, ciObservation, npmObservation, releaseObservation];
    const releaseChain = releaseParts.every((item) => item?.state === 'verified')
      ? evaluateReleaseChain({
        chain: {
          commit: { sha: targetCommit },
          tag: { name: tagObservation?.tag || tagObservation?.name || `v${evidence.version}`, commit: tagObservation?.commit },
          package: { ...subject.package, commit: targetCommit },
          artifact: artifactObservation,
          npm: npmObservation,
          ci: ciObservation,
          release: releaseObservation,
        },
        context: {
          repository,
          target_commit: targetCommit,
          package_name: subject.package?.name,
          package_version: subject.package?.version,
          tag: `v${evidence.version}`,
        },
      })
      : {
        kind: 'release-chain',
        state: releaseParts.some((item) => item?.state === 'conflict')
          ? 'conflict'
          : (releaseParts.some((item) => item?.state === 'reported') ? 'reported' : 'unproven'),
        reasonCodes: [...new Set(releaseParts.flatMap((item) => item?.reasonCodes || []))],
        diagnostics: releaseParts.flatMap((item) => item?.diagnostics || []),
      };
    assessments.push({ ...releaseChain, kind: 'release-chain' });
  }
  const gate = evaluateProvenanceGate({ purpose: 'delivery', assessments, requiredKinds });
  if (!gate.ok) throw provenanceBlocked(gate);
  const appended = appendLedger({
    store: receiptStore(vaultBase),
    draft: deliveryReceiptDraft({ state, target, targetCommit, capabilities, evidence, observations, now }),
  });
  const receipt = publicDeliveryReceipt(appended.record, state, target, targetCommit, capabilities, evidence);
  persistState(vaultBase, {
    ...state, state: 'completed', target, target_commit: targetCommit, finished_at: receipt.finished_at, receipt,
  });
  if (context) {
    clearContextDelivery(vaultBase, context, { expectedRevision: binding.binding.revision });
  }
  if (!context && readPointer(vaultBase) === state.id) setPointer(vaultBase);
  return receipt;
}

function abandonedReceipt(vaultBase, state) {
  const receipt = state.receipt;
  if (!receipt || receipt.schema_version !== 2 || !receipt.reason_digest) {
    const error = new Error('State abandoned não contém receipt v2 verificável.');
    error.code = 'WENDKEEP_RECEIPT_LEDGER_CORRUPT';
    throw error;
  }
  const ledger = readReceiptLedger({ store: receiptStore(vaultBase) });
  const record = ledger.records.find((candidate) => candidate.receipt_id === receipt.receipt_id);
  const binding = deliveryBinding(state);
  const matches = record
    && record.receipt_hash === receipt.receipt_hash
    && record.sequence === receipt.sequence
    && record.kind === 'delivery.abandoned'
    && record.subject?.delivery_id === state.id
    && record.subject?.source_commit === state.source_commit
    && Object.entries(binding).every(([key, value]) => record.subject?.[key] === value && receipt[key] === value)
    && record.claims?.reason_digest === receipt.reason_digest
    && Object.keys(record).every((key) => isDeepStrictEqual(receipt[key], record[key]));
  if (!matches) {
    const error = new Error('Receipt de abandono diverge do ledger v2 verificado.');
    error.code = 'WENDKEEP_RECEIPT_LEDGER_CORRUPT';
    throw error;
  }
  return receipt;
}

export function abandonDelivery({
  vaultBase,
  id,
  reason,
  context = null,
  now = new Date(),
  appendLedger = appendLedgerReceipt,
  persistState = writeState,
  clearContextDelivery = clearActiveContextDelivery,
}) {
  const state = readState(vaultBase, safeId(id));
  const binding = context
    ? contextualBinding(vaultBase, context, state.state === 'active' ? state.id : '')
    : null;
  assertStateContext(state, binding);
  if (state.state === 'abandoned') {
    const receipt = abandonedReceipt(vaultBase, state);
    if (context && binding.id === state.id) {
      clearContextDelivery(vaultBase, context, { expectedRevision: binding.binding.revision });
    }
    if (!context && readPointer(vaultBase) === state.id) setPointer(vaultBase);
    return receipt;
  }
  if (state.state !== 'active') throw new Error(`delivery ${id} não está ativa`);
  if (!String(reason || '').trim()) throw new Error('delivery abandon requer --reason <text>');
  const reasonBinding = privateReason(reason);
  const appended = appendLedger({
    store: receiptStore(vaultBase),
    draft: {
      kind: 'delivery.abandoned',
      subject: { delivery_id: state.id, source_commit: state.source_commit, ...deliveryBinding(state) },
      claims: {
        outcome: 'abandoned',
        ...reasonBinding,
        ...(state.context_key ? { context_key: state.context_key } : {}),
      },
      observations: { local_state: { state: 'verified', delivery_state: state.state } },
      recorded_at: now.toISOString(),
    },
  });
  const receipt = {
    ...appended.record,
    delivery_id: state.id,
    outcome: 'abandoned',
    ...deliveryBinding(state),
    ...(state.context_key ? { context_key: state.context_key } : {}),
    ...reasonBinding,
    abandoned_at: now.toISOString(),
  };
  persistState(vaultBase, {
    ...state, state: 'abandoned', ...reasonBinding, abandoned_at: receipt.abandoned_at, receipt,
  });
  if (context) {
    clearContextDelivery(vaultBase, context, { expectedRevision: binding.binding.revision });
  }
  if (!context && readPointer(vaultBase) === state.id) setPointer(vaultBase);
  return receipt;
}

function emit(payload, json) {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${payload.id || payload.delivery_id}: ${payload.state || payload.outcome}\n`);
}

function deliveryFailurePayload(error, operation) {
  const provenance = error?.provenance || null;
  const code = /^[A-Z0-9_]+$/.test(String(error?.code || ''))
    ? String(error.code)
    : 'WENDKEEP_DELIVERY_FAILED';
  const state = sanitizeDeliveryText(error?.state || provenance?.state || 'unproven', 40) || 'unproven';
  const blocker = sanitizeDeliveryText(
    error?.blocker || provenance?.reasonCodes?.[0] || code,
    120,
  ) || code;
  const recovery = sanitizeDeliveryText(
    error?.recovery?.command || error?.recovery || provenance?.repair?.command
      || 'wendkeep delivery status --json',
  );
  return {
    ok: false,
    code,
    error: code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED'
      ? 'Delivery bloqueada pelo gate de proveniência.'
      : (code === 'WENDKEEP_DELIVERY_GIT_FAILED'
        ? 'Falha ao consultar o repositório Git para a delivery.'
        : 'Falha no comando delivery.'),
    operation: sanitizeDeliveryText(error?.operation || operation, 80) || 'delivery',
    state,
    blocker,
    expected: sanitizedDeliveryValue(error?.expected ?? provenance?.diagnostics?.[0]?.expected ?? null),
    observed: sanitizedDeliveryValue(error?.observed ?? provenance?.diagnostics?.[0]?.observed ?? null),
    recovery,
  };
}

function renderDeliveryFailure(error, operation, json) {
  const payload = deliveryFailurePayload(error, operation);
  if (json) return JSON.stringify(payload);
  return `${payload.code}: ${payload.error} operation=${payload.operation} state=${payload.state} blocker=${payload.blocker} expected=${JSON.stringify(payload.expected)} observed=${JSON.stringify(payload.observed)} recovery=${payload.recovery}`;
}

export function runDelivery(argv = []) {
  let parsed = null;
  let sub = 'status';
  try {
    parsed = parseArgv(argv);
    sub = parsed.positionals[0] || 'status';
    const { projectRoot, repoRoot, vaultBase } = context(parsed);
    const commandContext = resolveCommandActiveContext({
      vaultBase,
      projectRoot,
      sessionId: parsed.value('--session') || process.env.CODEX_THREAD_ID || process.env.CLAUDE_SESSION_ID || '',
    });
    if (sub === 'start') {
      const state = startDelivery({
        vaultBase, repoRoot, id: parsed.positionals[1], capabilities: parsed.all('--allow'),
        sourceChange: parsed.value('--source-change'), sourceCommit: parsed.value('--source-commit'),
        context: commandContext,
      });
      emit(state, parsed.json);
      return 0;
    }
    if (sub === 'status') {
      const id = currentId(parsed, vaultBase, commandContext);
      const binding = commandContext ? contextualBinding(vaultBase, commandContext, id) : null;
      const state = readState(vaultBase, id);
      assertStateContext(state, binding);
      emit(state, parsed.json);
      return 0;
    }
    if (sub === 'finish') {
      const receipt = finishDelivery({
        vaultBase, repoRoot, id: currentId(parsed, vaultBase, commandContext), target: parsed.value('--target') || 'HEAD',
        context: commandContext,
        evidence: {
          ci_url: parsed.value('--ci-url'), version: parsed.value('--version'),
          npm_integrity: parsed.value('--npm-integrity'), release_url: parsed.value('--release-url'),
        },
      });
      emit(receipt, parsed.json);
      return 0;
    }
    if (sub === 'abandon') {
      const receipt = abandonDelivery({
        vaultBase, id: currentId(parsed, vaultBase, commandContext), reason: parsed.value('--reason'),
        context: commandContext,
      });
      emit(receipt, parsed.json);
      return 0;
    }
    throw new Error(`subcomando desconhecido: ${sub}`);
  } catch (error) {
    const json = Boolean(parsed?.json || argv.includes('--json'));
    process.stderr.write(`${renderDeliveryFailure(error, `delivery.${sub}`, json)}\n`);
    return 2;
  }
}
