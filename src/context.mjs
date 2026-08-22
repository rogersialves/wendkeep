import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import {
  mutateSessionRegistry,
  readSessionRegistry,
} from '../hooks/obsidian-common.mjs';
import {
  captureProjectScope,
  compareProjectScopes,
  concurrentScopeConflicts,
  scopeForRegistry,
} from '../hooks/project-scope.mjs';
import { readVaultMarker } from './project-vault.mjs';
import { sanitizeMemoryText } from '../packages/vault/src/memory-schema.mjs';
import { repairActiveContext } from './active-context-health.mjs';

export const CONTEXT_HELP = `wendkeep context <subcommand>

  switch <branch> [--create] [--session <id>] [--project <path>] [--vault <path>] [--json]
  status --session <id> [--project <path>] [--vault <path>] [--json]
  recover --session <id> --select <reserved|observed> --revision <n> --reason <text>
    [--project <path>] [--vault <path>] [--json]
  repair --key <repository:worktree:work-session> --revision <n> --reason <text> --session <id>
    [--project <path>] [--vault <path>] [--json]

Switches Git branch and the causal session scope together inside the same worktree.
Without --session, exactly one active session must match the current scope.
Status inventories reserved/observed recovery candidates without selecting one.
Recover resolves a quarantined conflict only when the selected candidate still matches the checkout.
Repair revalidates an orphan/removed context or expired request lease under CAS; it never deletes history.
`;

const VALUE_OPTIONS = new Set(['--project', '--vault', '--session', '--select', '--revision', '--reason', '--key']);
const FLAG_OPTIONS = new Set(['--create', '--json']);

function contextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || '';
  return argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function positionals(argv) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (VALUE_OPTIONS.has(value)) { index += 1; continue; }
    if ([...VALUE_OPTIONS].some((name) => value.startsWith(`${name}=`))) continue;
    if (FLAG_OPTIONS.has(value)) continue;
    if (value.startsWith('--')) throw contextError('WENDKEEP_CONTEXT_ARGS', `opção desconhecida: ${value}`);
    result.push(value);
  }
  return result;
}

function validateArgv(argv) {
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (FLAG_OPTIONS.has(value)) {
      if (seen.has(value)) throw contextError('WENDKEEP_CONTEXT_ARGS', `opção duplicada: ${value}`);
      seen.add(value);
      continue;
    }
    if (VALUE_OPTIONS.has(value)) {
      if (seen.has(value)) throw contextError('WENDKEEP_CONTEXT_ARGS', `opção duplicada: ${value}`);
      seen.add(value);
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw contextError('WENDKEEP_CONTEXT_ARGS', `${value} requer um valor`);
      index += 1;
      continue;
    }
    if (value.startsWith('--')) {
      const name = value.split('=', 1)[0];
      if (!VALUE_OPTIONS.has(name)) throw contextError('WENDKEEP_CONTEXT_ARGS', `opção desconhecida: ${name}`);
      if (seen.has(name)) throw contextError('WENDKEEP_CONTEXT_ARGS', `opção duplicada: ${name}`);
      seen.add(name);
      if (!value.slice(name.length + 1)) throw contextError('WENDKEEP_CONTEXT_ARGS', `${name} requer um valor`);
    }
  }
}

function vaultOf(argv) {
  const raw = optionValue(argv, '--vault') || process.env.OBSIDIAN_VAULT_PATH;
  if (!raw) throw contextError('WENDKEEP_CONTEXT_VAULT', 'binding de Vault ausente; use --vault <path>');
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

function projectOf(argv) {
  const raw = optionValue(argv, '--project') || process.cwd();
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

function git(projectRoot, args, spawn = spawnSync) {
  const result = spawn('git', args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || 'falhou').trim();
    throw contextError('WENDKEEP_CONTEXT_GIT', `git ${args.join(' ')}: ${detail}`);
  }
  return String(result.stdout || '').trim();
}

function actualScope(projectRoot, expected, sessionId, spawn) {
  return captureProjectScope({
    input: { cwd: projectRoot },
    projectRoot: expected?.projectRoot || projectRoot,
    projectId: expected?.projectId || '',
    provider: expected?.provider || '',
    sessionId,
    targetCwd: projectRoot,
    spawn,
  });
}

function matchingSessionIds(registry, projectRoot, spawn) {
  const matches = [];
  for (const [sessionId, entry] of Object.entries(registry.sessions || {})) {
    if (entry?.status !== 'active' || entry.project_scope_conflict === true || !entry?.project_scope) continue;
    const actual = actualScope(projectRoot, entry.project_scope, sessionId, spawn);
    if (compareProjectScopes(entry.project_scope, actual).ok) matches.push(sessionId);
  }
  return matches;
}

function contextRevision(entry) {
  return Number.isSafeInteger(entry?.context_revision) && entry.context_revision >= 0
    ? entry.context_revision : 0;
}

function activeSessionEntry(registry, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) throw contextError('WENDKEEP_CONTEXT_SESSION', 'status requer --session <id>');
  const entry = registry.sessions?.[id];
  if (!entry || entry.status !== 'active') {
    throw contextError('WENDKEEP_CONTEXT_SESSION', `sessão ativa não encontrada: ${id}`);
  }
  return { id, entry };
}

function validCandidateScope(scope, label) {
  const required = [
    'projectId', 'projectRoot', 'repoRoot', 'remote', 'branch', 'worktree',
    'head', 'provider', 'sessionId',
  ];
  const complete = scope && typeof scope === 'object' && scope.complete === true
    && required.every((field) => typeof scope[field] === 'string' && scope[field].trim());
  const head = complete ? scope.head.trim() : '';
  const branch = complete ? scope.branch.trim() : '';
  const safeHead = /^[0-9a-f]{40,64}$/i.test(head);
  const safeBranch = branch === `detached:${head}` || (
    branch.length <= 255
    && !branch.startsWith('/')
    && !branch.endsWith('/')
    && !branch.endsWith('.')
    && !branch.endsWith('.lock')
    && !branch.includes('..')
    && !branch.includes('@{')
    && !branch.includes('//')
    && !/[\u0000-\u0020~^:?*[\]\\]/u.test(branch)
  );
  if (!complete || !safeHead || !safeBranch) {
    throw contextError('WENDKEEP_CONTEXT_SCOPE_CONFLICT', `scope ${label} ausente ou incompleta`);
  }
  return scope;
}

function scopeMatchesActual(candidate, actual) {
  return compareProjectScopes(candidate, actual).ok
    && Boolean(candidate.head)
    && candidate.head === actual.head;
}

function candidateSummary(id, candidate, actual) {
  return {
    id,
    branch: candidate.branch || '',
    head: candidate.head || '',
    complete: candidate.complete === true,
    matches_actual: scopeMatchesActual(candidate, actual),
  };
}

function requiredRevision(value) {
  const raw = String(value ?? '').trim();
  const revision = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(revision)) {
    throw contextError('WENDKEEP_CONTEXT_ARGS', 'recover requer --revision <inteiro não negativo>');
  }
  return revision;
}

function recoveryReason(value) {
  const raw = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) throw contextError('WENDKEEP_CONTEXT_ARGS', 'recover requer --reason <texto>');
  if (raw.length > 240) throw contextError('WENDKEEP_CONTEXT_ARGS', '--reason excede 240 caracteres');
  return sanitizeMemoryText(raw).replace(/\s+/g, ' ').trim();
}

function recoverySelection(value) {
  const selected = String(value || '').trim();
  if (!['reserved', 'observed'].includes(selected)) {
    throw contextError('WENDKEEP_CONTEXT_ARGS', 'recover requer --select <reserved|observed>');
  }
  return selected;
}

function scopeIdentityMismatches(reserved, observed) {
  const fields = ['projectId', 'remote', 'provider', 'sessionId'];
  return fields.filter((field) => String(reserved?.[field] || '') !== String(observed?.[field] || ''));
}

function validateRecoveryIdentity(vaultBase, entry, sessionId, reserved, observed = null) {
  const mismatches = observed ? scopeIdentityMismatches(reserved, observed) : [];
  const candidates = observed ? [reserved, observed] : [reserved];
  if (candidates.some((candidate) => candidate.sessionId !== sessionId)) mismatches.push('sessionId');
  if (entry.provider && candidates.some((candidate) => candidate.provider !== entry.provider)) {
    mismatches.push('provider');
  }
  let marker = null;
  try { marker = readVaultMarker(vaultBase)?.marker || null; } catch { /* fail closed below */ }
  if (!marker?.projectId || candidates.some((candidate) => candidate.projectId !== marker.projectId)) {
    mismatches.push('projectId');
  }
  if (mismatches.length) {
    throw contextError(
      'WENDKEEP_CONTEXT_IDENTITY_CHANGED',
      `candidatas divergem na identidade causal (${[...new Set(mismatches)].join(', ')})`,
    );
  }
}

function recoveryActualScope(projectRoot, expected, sessionId, spawn) {
  return captureProjectScope({
    input: { cwd: projectRoot },
    projectRoot,
    projectId: expected.projectId,
    provider: expected.provider,
    sessionId,
    targetCwd: projectRoot,
    spawn,
  });
}

const CONFLICT_FIELDS = new Set([
  'scope.projectId', 'scope.projectRoot', 'scope.repoRoot', 'scope.remote', 'scope.branch',
  'scope.worktree', 'scope.provider', 'scope.sessionId', 'scope.incomplete',
]);

function sanitizedConflictFields(value) {
  if (!Array.isArray(value) || value.some((field) => !CONFLICT_FIELDS.has(String(field)))) {
    throw contextError('WENDKEEP_CONTEXT_SCOPE_CONFLICT', 'campos de conflito ausentes ou inválidos');
  }
  return [...new Set(value.map(String))].sort();
}

function receiptScope(candidate) {
  return { branch: candidate.branch || '', head: candidate.head || '' };
}

export function inspectSessionContext({
  vaultBase,
  projectRoot = process.cwd(),
  sessionId = '',
  spawn = spawnSync,
} = {}) {
  const registry = readSessionRegistry(vaultBase);
  const selected = activeSessionEntry(registry, sessionId);
  const reserved = validCandidateScope(selected.entry.project_scope, 'reserved');
  const conflict = selected.entry.project_scope_conflict === true;
  const observed = conflict
    ? validCandidateScope(selected.entry.project_scope_observed, 'observed')
    : null;
  validateRecoveryIdentity(vaultBase, selected.entry, selected.id, reserved, observed);
  const actual = recoveryActualScope(projectRoot, reserved, selected.id, spawn);
  const candidates = [candidateSummary('reserved', reserved, actual)];
  if (observed) candidates.push(candidateSummary('observed', observed, actual));
  return {
    status: conflict ? 'conflict' : 'healthy',
    session_id: selected.id,
    revision: contextRevision(selected.entry),
    conflict,
    conflict_fields: conflict ? sanitizedConflictFields(selected.entry.project_scope_conflict_fields) : [],
    candidates,
  };
}

export function recoverSessionContext({
  vaultBase,
  projectRoot = process.cwd(),
  sessionId = '',
  select = '',
  revision,
  reason = '',
  spawn = spawnSync,
  mutateRegistry = mutateSessionRegistry,
  now = () => new Date(),
} = {}) {
  const requestedSessionId = String(sessionId || '').trim();
  if (!requestedSessionId) throw contextError('WENDKEEP_CONTEXT_SESSION', 'recover requer --session <id>');
  const selectedId = recoverySelection(select);
  const expectedRevision = requiredRevision(revision);
  const safeReason = recoveryReason(reason);

  return mutateRegistry(vaultBase, (registry) => {
    const selected = activeSessionEntry(registry, requestedSessionId);
    const entry = selected.entry;
    if (entry.project_scope_conflict !== true) {
      throw contextError('WENDKEEP_CONTEXT_SCOPE_CONFLICT', 'a sessão não possui conflito de scope ativo');
    }
    const currentRevision = contextRevision(entry);
    if (currentRevision !== expectedRevision) {
      throw contextError(
        'WENDKEEP_CONTEXT_CAS_MISMATCH',
        `context_revision mudou de ${expectedRevision} para ${currentRevision}; inspecione o status novamente`,
      );
    }
    const reserved = validCandidateScope(entry.project_scope, 'reserved');
    const observed = validCandidateScope(entry.project_scope_observed, 'observed');
    validateRecoveryIdentity(vaultBase, entry, selected.id, reserved, observed);
    const candidate = selectedId === 'reserved' ? reserved : observed;
    const actual = recoveryActualScope(projectRoot, candidate, selected.id, spawn);
    if (!scopeMatchesActual(candidate, actual)) {
      throw contextError(
        'WENDKEEP_CONTEXT_SCOPE_MISMATCH',
        `a candidata ${selectedId} não corresponde integralmente ao checkout atual`,
      );
    }

    const nextRevision = currentRevision + 1;
    const at = now().toISOString();
    const receipt = {
      revision: nextRevision,
      operation: 'recover',
      selected: selectedId,
      from: {
        reserved: receiptScope(reserved),
        observed: receiptScope(observed),
      },
      to: receiptScope(actual),
      actor: { provider: candidate.provider || entry.provider || '', session_id: selected.id },
      reason: safeReason,
      at,
    };
    const {
      project_scope_conflict: _conflict,
      project_scope_conflict_fields: _conflictFields,
      project_scope_observed: _observed,
      ...preserved
    } = entry;
    registry.sessions[selected.id] = {
      ...preserved,
      project_scope: scopeForRegistry(actual, { authorizedActions: reserved.authorizedActions }),
      context_revision: nextRevision,
      context_recoveries: [
        ...(Array.isArray(entry.context_recoveries) ? entry.context_recoveries : []),
        receipt,
      ],
      last_seen: at,
      updated_at: at,
    };
    return {
      status: 'recovered',
      session_id: selected.id,
      selected: selectedId,
      revision: nextRevision,
      receipt,
    };
  });
}

function resolveSessionId(vaultBase, projectRoot, requested, spawn) {
  const registry = readSessionRegistry(vaultBase);
  if (requested) {
    const entry = registry.sessions?.[requested];
    if (!entry || entry.status !== 'active') {
      throw contextError('WENDKEEP_CONTEXT_SESSION', `sessão ativa não encontrada: ${requested}`);
    }
    return { sessionId: requested, revision: contextRevision(entry) };
  }
  const matches = matchingSessionIds(registry, projectRoot, spawn);
  if (matches.length !== 1) {
    throw contextError(
      'WENDKEEP_CONTEXT_AMBIGUOUS',
      `${matches.length} sessões ativas correspondem à scope atual; informe --session <id>.`,
    );
  }
  return {
    sessionId: matches[0],
    revision: contextRevision(registry.sessions[matches[0]]),
  };
}

function rollbackGit(projectRoot, previous, createdBranch, spawn) {
  const args = previous.branch.startsWith('detached:')
    ? ['switch', '--detach', previous.head]
    : ['switch', previous.branch];
  git(projectRoot, args, spawn);
  if (createdBranch) git(projectRoot, ['branch', '-D', createdBranch], spawn);
}

export function switchSessionContext({
  vaultBase,
  projectRoot = process.cwd(),
  branch,
  create = false,
  sessionId = '',
  spawn = spawnSync,
  mutateRegistry = mutateSessionRegistry,
  now = () => new Date(),
} = {}) {
  const target = String(branch || '').trim();
  if (!target) throw contextError('WENDKEEP_CONTEXT_ARGS', 'switch requer <branch>');
  git(projectRoot, ['check-ref-format', '--branch', target], spawn);
  const selected = resolveSessionId(vaultBase, projectRoot, sessionId, spawn);
  const selectedSessionId = selected.sessionId;
  let switched = false;
  let previous = null;

  try {
    return mutateRegistry(vaultBase, (registry) => {
      const entry = registry.sessions?.[selectedSessionId];
      if (!entry || entry.status !== 'active') {
        throw contextError('WENDKEEP_CONTEXT_SESSION', `sessão ativa não encontrada: ${selectedSessionId}`);
      }
      if (entry.project_scope_conflict === true || !entry.project_scope) {
        throw contextError('WENDKEEP_CONTEXT_SCOPE_CONFLICT', 'a sessão possui scope ausente ou conflitante');
      }
      const currentRevision = contextRevision(entry);
      if (currentRevision !== selected.revision) {
        throw contextError(
          'WENDKEEP_CONTEXT_CAS_MISMATCH',
          `context_revision mudou de ${selected.revision} para ${currentRevision}; repita com estado fresco`,
        );
      }
      const expected = entry.project_scope;
      const actual = actualScope(projectRoot, expected, selectedSessionId, spawn);
      const comparison = compareProjectScopes(expected, actual);
      if (!comparison.ok) {
        throw contextError(
          'WENDKEEP_CONTEXT_SCOPE_MISMATCH',
          `scope atual diverge da reserva (${comparison.mismatches.join(', ')})`,
        );
      }
      if (actual.branch === target && !create) {
        return {
          status: 'unchanged', session_id: selectedSessionId, branch: target,
          head: actual.head, revision: currentRevision,
        };
      }

      previous = { branch: actual.branch, head: actual.head };
      git(projectRoot, create ? ['switch', '-c', target] : ['switch', target], spawn);
      switched = true;
      const next = actualScope(projectRoot, expected, selectedSessionId, spawn);
      const identity = compareProjectScopes({ ...expected, branch: next.branch }, next);
      if (!identity.ok || next.branch !== target || next.worktree !== actual.worktree) {
        const mismatches = [...identity.mismatches, ...(next.branch === target ? [] : ['scope.branch'])];
        throw contextError(
          'WENDKEEP_CONTEXT_IDENTITY_CHANGED',
          `a transição saiu da identidade reservada (${[...new Set(mismatches)].join(', ')})`,
        );
      }
      const conflicts = concurrentScopeConflicts(
        next,
        Object.entries(registry.sessions || {}).filter(([, candidate]) => candidate?.status === 'active'),
        selectedSessionId,
      );
      if (conflicts.length) {
        throw contextError(
          'WENDKEEP_CONTEXT_CONFLICT',
          `o destino conflita com ${conflicts.length} contexto(s) ativo(s): ${conflicts.map((item) => item.sessionId).join(', ')}`,
        );
      }

      const revision = currentRevision + 1;
      const at = now().toISOString();
      const transition = {
        revision,
        operation: create ? 'create' : 'switch',
        from: { branch: actual.branch, head: actual.head },
        to: { branch: next.branch, head: next.head },
        worktree: next.worktree,
        at,
      };
      const {
        project_scope_conflict: _conflict,
        project_scope_conflict_fields: _conflictFields,
        project_scope_observed: _observed,
        ...preserved
      } = entry;
      registry.sessions[selectedSessionId] = {
        ...preserved,
        project_scope: scopeForRegistry(next, { authorizedActions: expected.authorizedActions }),
        context_revision: revision,
        context_transitions: [...(Array.isArray(entry.context_transitions) ? entry.context_transitions : []), transition],
        last_seen: at,
        updated_at: at,
      };
      return {
        status: 'switched', session_id: selectedSessionId, branch: next.branch,
        head: next.head, revision, transition,
      };
    });
  } catch (error) {
    if (switched && previous) {
      try {
        rollbackGit(projectRoot, previous, create ? target : '', spawn);
      } catch (rollbackError) {
        throw contextError(
          'WENDKEEP_CONTEXT_ROLLBACK_FAILED',
          `${error.code || 'WENDKEEP_CONTEXT_FAILED'}: ${error.message}; rollback: ${rollbackError.message}`,
        );
      }
    }
    throw error;
  }
}

function output(result, json) {
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (Array.isArray(result.candidates)) {
    process.stdout.write(`context ${result.status}: session ${result.session_id}; revision ${result.revision}; candidates ${result.candidates.map((candidate) => candidate.id).join(', ')}\n`);
  }
  else if (result.status === 'recovered') {
    process.stdout.write(`context recovered: ${result.selected} selected (session ${result.session_id}; revision ${result.revision})\n`);
  }
  else if (result.status === 'repaired') {
    process.stdout.write(`context repaired: ${result.key} (${result.effect}; revision ${result.revision})\n`);
  }
  else process.stdout.write(`context ${result.status}: ${result.branch} (session ${result.session_id}; revision ${result.revision})\n`);
}

export function runContext(argv = []) {
  try {
    validateArgv(argv);
    const [sub, branch, ...extra] = positionals(argv);
    if (sub === 'status' && !branch && !extra.length) {
      const result = inspectSessionContext({
        vaultBase: vaultOf(argv),
        projectRoot: projectOf(argv),
        sessionId: optionValue(argv, '--session'),
      });
      output(result, argv.includes('--json'));
      return 0;
    }
    if (sub === 'recover' && !branch && !extra.length) {
      const result = recoverSessionContext({
        vaultBase: vaultOf(argv),
        projectRoot: projectOf(argv),
        sessionId: optionValue(argv, '--session'),
        select: optionValue(argv, '--select'),
        revision: optionValue(argv, '--revision'),
        reason: optionValue(argv, '--reason'),
      });
      output(result, argv.includes('--json'));
      return 0;
    }
    if (sub === 'repair' && !branch && !extra.length) {
      const result = repairActiveContext({
        vaultBase: vaultOf(argv),
        projectRoot: projectOf(argv),
        key: optionValue(argv, '--key'),
        revision: optionValue(argv, '--revision'),
        reason: optionValue(argv, '--reason'),
        actorSessionId: optionValue(argv, '--session'),
      });
      output(result, argv.includes('--json'));
      return 0;
    }
    if (sub !== 'switch' || !branch || extra.length) {
      throw contextError('WENDKEEP_CONTEXT_ARGS', 'use: wendkeep context switch <branch> [--create] [--session <id>]');
    }
    const result = switchSessionContext({
      vaultBase: vaultOf(argv),
      projectRoot: projectOf(argv),
      branch,
      create: argv.includes('--create'),
      sessionId: optionValue(argv, '--session'),
    });
    output(result, argv.includes('--json'));
    return 0;
  } catch (error) {
    process.stderr.write(`wendkeep context: ${error.code || 'WENDKEEP_CONTEXT_FAILED'}: ${error.message}\n`);
    return 2;
  }
}
