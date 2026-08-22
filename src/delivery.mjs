import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
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

export const DELIVERY_HELP = `wendkeep delivery <subcommand>

  start [id] --allow <capability> [--source-change <slug>] [--source-commit <sha>]
  status [id]
  finish [id] [--target <ref>] [--ci-url <url>] [--version <x.y.z>]
              [--npm-integrity <sha512-...>] [--release-url <url>]
  abandon [id] --reason <text>

Common options: --project <path> --vault <path> --session <id> --json
Delivery authorizes operational risk and creates an append-only receipt. It never creates a change,
spec, or ADR. If code/config must change, abandon or pause delivery and resume an implementation.
`;

export const DELIVERY_CAPABILITIES = Object.freeze([
  'git:merge', 'git:pull', 'git:push', 'git:tag', 'publish',
]);

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

function git(projectRoot, args, optional = false) {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (optional) return '';
    throw new Error(`git ${args.join(' ')} falhou: ${String(error.stderr || error.message).trim()}`);
  }
}

function deliveryPaths(vaultBase, id = '') {
  const runtime = join(vaultBase, '.brain', 'runtime');
  const deliveries = join(runtime, 'deliveries');
  return {
    runtime,
    deliveries,
    pointer: join(runtime, 'CURRENT_DELIVERY'),
    receipts: join(runtime, 'delivery-receipts.jsonl'),
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

function assertStateContext(state, binding) {
  if (!binding) return;
  if (state.context_key !== binding.key) {
    throw deliveryContextError(`delivery ${state.id} pertence a outro active context`);
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

function appendReceipt(vaultBase, receipt) {
  const paths = deliveryPaths(vaultBase);
  mkdirVaultPath(vaultBase, paths.runtime, { label: 'runtime de delivery' });
  let previous = '';
  if (existsSync(paths.receipts)) {
    const checked = assertVaultPathSafe(vaultBase, paths.receipts, {
      allowMissing: false, expectedType: 'file', label: 'ledger de receipts de delivery',
    });
    previous = readFileSync(checked.target, 'utf8');
  }
  writeVaultFileSync(vaultBase, paths.receipts, `${previous}${JSON.stringify(receipt)}\n`, 'utf8', {
    label: 'ledger de receipts de delivery',
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
  if (context) {
    try {
      const current = contextualBinding(vaultBase, context);
      if (current.id) throw deliveryContextBusy(current.id);
    } catch (error) {
      if (error?.code !== 'WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND') throw error;
    }
  }
  const commit = sourceCommit || git(repoRoot, ['rev-parse', 'HEAD']);
  git(repoRoot, ['cat-file', '-e', `${commit}^{commit}`]);
  const requestedCapabilities = [...new Set((capabilities || []).map((item) => String(item).trim()).filter(Boolean))];
  const invalidCapabilities = requestedCapabilities.filter((item) => !DELIVERY_CAPABILITIES.includes(item));
  if (invalidCapabilities.length) {
    throw new Error(`capability inválida: ${invalidCapabilities.join(', ')}. Use ${DELIVERY_CAPABILITIES.join(', ')}.`);
  }
  const route = createWorkRoute({
    workKind: 'delivery', profile: 'ASSURE', contractImpact: 'none',
    operationRisk: requestedCapabilities, sourceChange, sourceCommit: commit,
  });
  if (!route.operation_risk.length) throw new Error('delivery start requer ao menos um --allow <capability>');
  const state = {
    schema_version: 1,
    id: deliveryId,
    state: 'active',
    route,
    repository: repoRoot,
    worktree: repoRoot,
    branch: git(repoRoot, ['branch', '--show-current'], true),
    source_commit: commit,
    ...(context ? { context_key: activeContextKey(context) } : {}),
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

export function finishDelivery({
  vaultBase, repoRoot, id, target = 'HEAD', evidence = {}, context = null, now = new Date(),
}) {
  ensureClean(repoRoot);
  const state = readState(vaultBase, safeId(id));
  const binding = context ? contextualBinding(vaultBase, context, state.id) : null;
  assertStateContext(state, binding);
  if (state.state !== 'active') throw new Error(`delivery ${id} não está ativa`);
  const targetCommit = git(repoRoot, ['rev-parse', `${target}^{commit}`]);
  git(repoRoot, ['merge-base', '--is-ancestor', state.source_commit, targetCommit]);
  const capabilities = state.route?.operation_risk || [];
  if (capabilities.includes('git:tag') || capabilities.includes('publish')) {
    if (!evidence.version) throw new Error('delivery com tag/publicação requer --version');
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    if (pkg.version !== evidence.version) throw new Error(`package.json ${pkg.version} diverge de ${evidence.version}`);
    const tagCommit = git(repoRoot, ['rev-list', '-n', '1', `refs/tags/v${evidence.version}`]);
    if (tagCommit !== targetCommit) throw new Error(`v${evidence.version} não aponta para o target comprovado`);
  }
  if (capabilities.includes('publish')) {
    for (const [key, label] of [
      ['ci_url', '--ci-url'], ['npm_integrity', '--npm-integrity'], ['release_url', '--release-url'],
    ]) if (!evidence[key]) throw new Error(`delivery com publish requer ${label}`);
  }
  const receipt = {
    schema_version: 1,
    delivery_id: state.id,
    outcome: 'completed',
    work_kind: 'delivery',
    source_change: state.route.source_change || '',
    source_commit: state.source_commit,
    ...(state.context_key ? { context_key: state.context_key } : {}),
    target,
    target_commit: targetCommit,
    capabilities,
    evidence,
    finished_at: now.toISOString(),
  };
  if (context) clearActiveContextDelivery(vaultBase, context, { expectedRevision: binding.binding.revision });
  try {
    appendReceipt(vaultBase, receipt);
    writeState(vaultBase, { ...state, state: 'completed', target, target_commit: targetCommit, finished_at: receipt.finished_at, receipt });
  } catch (error) {
    if (context) {
      try { setActiveContextDelivery(vaultBase, context, state.id); } catch { /* rollback best-effort */ }
    }
    throw error;
  }
  if (!context && readPointer(vaultBase) === state.id) setPointer(vaultBase);
  return receipt;
}

export function abandonDelivery({ vaultBase, id, reason, context = null, now = new Date() }) {
  const state = readState(vaultBase, safeId(id));
  const binding = context ? contextualBinding(vaultBase, context, state.id) : null;
  assertStateContext(state, binding);
  if (state.state !== 'active') throw new Error(`delivery ${id} não está ativa`);
  if (!String(reason || '').trim()) throw new Error('delivery abandon requer --reason <text>');
  const receipt = {
    schema_version: 1, delivery_id: state.id, outcome: 'abandoned',
    ...(state.context_key ? { context_key: state.context_key } : {}),
    reason: String(reason).trim(), abandoned_at: now.toISOString(),
  };
  if (context) clearActiveContextDelivery(vaultBase, context, { expectedRevision: binding.binding.revision });
  try {
    appendReceipt(vaultBase, receipt);
    writeState(vaultBase, { ...state, state: 'abandoned', reason: receipt.reason, abandoned_at: receipt.abandoned_at });
  } catch (error) {
    if (context) {
      try { setActiveContextDelivery(vaultBase, context, state.id); } catch { /* rollback best-effort */ }
    }
    throw error;
  }
  if (!context && readPointer(vaultBase) === state.id) setPointer(vaultBase);
  return receipt;
}

function emit(payload, json) {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${payload.id || payload.delivery_id}: ${payload.state || payload.outcome}\n`);
}

export function runDelivery(argv = []) {
  try {
    const parsed = parseArgv(argv);
    const sub = parsed.positionals[0] || 'status';
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
    process.stderr.write(`wendkeep delivery: ${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    return 2;
  }
}
