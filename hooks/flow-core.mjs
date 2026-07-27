import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readSessionRegistry, redactSecrets, upsertSessionRegistry } from './obsidian-common.mjs';
import { assertChangeScaffoldTargetsSafe, changeDirRel, newChange } from './change-core.mjs';
import { loadSensorsDetailed, runSensors, evaluateGate, sensorProcessEnv } from './sensors-core.mjs';
import {
  assertAllowedPathTopology, captureGitSnapshot, capturePhysicalTreeSnapshot, diffGitSnapshots, normalizeAllowedPaths,
  pathAllowed, runGitDiffCheck,
} from './git-snapshot.mjs';
import {
  flowProtectedIgnoredPathspecs,
  flowProtectedPhysicalScanOptions,
  flowProtectedTopologyRoots,
  isProtectedFlowPath as matchesProtectedFlowPolicy,
} from './flow-protected-policy.mjs';
import {
  appendFlowAttempt, createFlowContract, findActiveFlow, findFlow, listFlows, readFlow,
  reserveFlowPromotion, withFlowPromotionLock, writeFlowPromotion, writeFlowReceipt,
} from './vault-runtime-store.mjs';
import { projectSessionIteration } from './session-iteration.mjs';
import { hasSessionFrontmatter } from './session-note-io.mjs';
import {
  assertVaultPathSafe, mkdirVaultPath, writeVaultFileAtomic,
} from './vault-path-safety.mjs';

function flowError(message, code = 'FLOW_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function iso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('data FLOW inválida');
  return date.toISOString();
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function definitionHash(sensors) {
  return createHash('sha256').update(JSON.stringify(canonical(sensors))).digest('hex');
}

function selectedSensors(projectRoot, sensorIds) {
  const loaded = loadSensorsDetailed(projectRoot);
  if (loaded.error) throw flowError(`configuração de sensores inválida: ${loaded.error}`, 'FLOW_SENSOR_CONFIG');
  if (loaded.missing) throw flowError(`wendkeep.sensors.json ausente: ${loaded.path}`, 'FLOW_SENSOR_CONFIG');
  const byId = new Map(loaded.sensors.map((sensor) => [sensor.id, sensor]));
  const missing = sensorIds.filter((id) => !byId.has(id));
  if (missing.length) throw flowError(`sensor não definido: ${missing.join(', ')}`, 'FLOW_SENSOR_CONFIG');
  return sensorIds.map((id) => byId.get(id));
}

export function resolveFlowSession(vaultBase, { sessionId = '', env = process.env } = {}) {
  const registry = readSessionRegistry(vaultBase);
  const active = Object.entries(registry.sessions || {})
    .filter(([, entry]) => entry?.status === 'active' && entry.session_file)
    .map(([id, entry]) => ({ sessionId: id, entry }));
  const requested = String(sessionId || env?.CODEX_THREAD_ID || '').trim();
  if (requested) {
    const match = active.find((item) => item.sessionId === requested);
    if (!match) throw flowError(`sessão ativa não encontrada: ${requested}`, 'FLOW_SESSION_NOT_FOUND');
    return match;
  }
  if (active.length === 1) return active[0];
  if (active.length === 0) throw flowError('nenhuma sessão ativa e inequívoca para FLOW', 'FLOW_SESSION_NOT_FOUND');
  throw flowError(`sessão FLOW ambígua: mais de uma sessão ativa (${active.map((item) => item.sessionId).join(', ')})`, 'FLOW_SESSION_AMBIGUOUS');
}


function captureFlowGitSnapshot(projectRoot, gitRoot, protectedRoots = [], vaultBase = '') {
  const physicalOptions = flowProtectedPhysicalScanOptions(projectRoot, gitRoot, {
    protectedRoots, vaultBase,
  });
  // Scan before invoking Git's ignored-file discovery so junctions are never used
  // as a traversal path by the protected-surface pass.
  const physical = capturePhysicalTreeSnapshot(projectRoot, physicalOptions);
  const snapshot = captureGitSnapshot(projectRoot, {
    ignoredPathspecs: flowProtectedIgnoredPathspecs(protectedRoots),
    ignoredPathFilter: (path) => !physicalOptions.isExcludedPath(path)
      && matchesProtectedFlowPolicy(path, protectedRoots),
  });
  return {
    ...snapshot,
    protected_physical_fingerprint: physical.fingerprint,
    protected_physical_fingerprints: physical.fingerprints,
    protected_physical_unsafe_paths: physical.unsafe_paths,
    protected_physical_entries_scanned: physical.entries_scanned,
    protected_physical_max_depth_seen: physical.max_depth_seen,
  };
}

function assertBuiltinProtectedTopology(projectRoot, gitRoot) {
  const roots = flowProtectedTopologyRoots(projectRoot, gitRoot).map((root) => `${root}/**`);
  return assertAllowedPathTopology(gitRoot, roots);
}

function canonicalFsPath(path) {
  const normalized = resolve(path).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function projectRelFromGitRoot(projectRoot, gitRoot) {
  const project = realpathSync.native(resolve(projectRoot));
  const root = realpathSync.native(resolve(gitRoot));
  const rel = relative(root, project);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw flowError('projectRoot FLOW fora do repositório Git', 'FLOW_REPOSITORY_CHANGED');
  }
  return rel ? rel.replaceAll('\\', '/') : '.';
}

function resolveContractProjectRoot(contract, requestedProjectRoot) {
  const rel = String(contract?.project_rel || '');
  if (!rel || isAbsolute(rel) || rel.split('/').includes('..')) {
    throw flowError('project_rel ausente ou inválido no contrato FLOW', 'FLOW_STORE_CORRUPT');
  }
  const gitRoot = realpathSync.native(resolve(contract.baseline.root));
  const expected = rel === '.' ? gitRoot : resolve(gitRoot, ...rel.split('/'));
  const expectedPhysical = realpathSync.native(expected);
  const requestedPhysical = realpathSync.native(resolve(requestedProjectRoot));
  const expectedFromGit = relative(gitRoot, expectedPhysical);
  if (expectedFromGit === '..' || expectedFromGit.startsWith(`..${sep}`) || isAbsolute(expectedFromGit)
    || canonicalFsPath(expectedPhysical) !== canonicalFsPath(requestedPhysical)) {
    throw flowError('projectRoot diverge do projeto congelado no contrato FLOW', 'FLOW_REPOSITORY_CHANGED');
  }
  return expectedPhysical;
}

function snapshotSafetyFailures(snapshot, phase = '') {
  const suffix = phase ? ` ${phase}` : '';
  const failures = [];
  if ((snapshot?.hidden_index_paths || []).length) {
    failures.push(`índice Git oculta paths${suffix}: ${snapshot.hidden_index_paths.join(', ')}`);
  }
  if ((snapshot?.unsafe_git_metadata_paths || []).length) {
    failures.push(`metadados Git atravessam alias físico inseguro${suffix}: ${snapshot.unsafe_git_metadata_paths.join(', ')}`);
  }
  if ((snapshot?.unsafe_worktree_paths || []).length) {
    failures.push(`worktree contém path físico inseguro${suffix}: ${snapshot.unsafe_worktree_paths.join(', ')}`);
  }
  if ((snapshot?.protected_physical_unsafe_paths || []).length) {
    failures.push(`scan físico protegido encontrou alias/hardlink inseguro${suffix}: ${snapshot.protected_physical_unsafe_paths.join(', ')}`);
  }
  return failures;
}

function assertSafeStartingSnapshot(snapshot) {
  const failures = snapshotSafetyFailures(snapshot, 'antes do FLOW');
  if (failures.length) throw flowError(failures.join('; '), 'FLOW_GIT_VISIBILITY');
}

export function isProtectedFlowPath(path, protectedRoots = []) {
  return matchesProtectedFlowPolicy(path, protectedRoots);
}

function configuredProtectedFlowRoots(projectRoot, gitRoot) {
  const configPath = join(resolve(projectRoot), '.wendkeep.json');
  if (!existsSync(configPath)) return [];
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw flowError(`binding ilegível ao resolver protectedRoots: ${error?.message || error}`, 'FLOW_PROTECTED_ROOTS_CONFIG');
  }
  const configured = config?.harness?.flow?.protectedRoots;
  if (configured === undefined) return [];
  if (!Array.isArray(configured)) {
    throw flowError('harness.flow.protectedRoots deve ser uma lista', 'FLOW_PROTECTED_ROOTS_CONFIG');
  }
  const normalized = [];
  for (const raw of configured) {
    if (typeof raw !== 'string') {
      throw flowError('raiz protegida FLOW deve ser string relativa', 'FLOW_PROTECTED_ROOTS_CONFIG');
    }
    const value = String(raw || '').trim().replace(/[\\/]$/, '');
    const segments = value.replaceAll('\\', '/').split('/');
    if (!value || isAbsolute(value) || segments.includes('..') || /[*?\[\]{}!]/.test(value)) {
      throw flowError(`raiz protegida FLOW inválida: ${raw}`, 'FLOW_PROTECTED_ROOTS_CONFIG');
    }
    try {
      const [root] = normalizeAllowedPaths(projectRoot, gitRoot, [`${value}/**`]);
      if (!root || /^(?:\.git)(?:\/|$)/i.test(root)) {
        throw new TypeError('raiz reservada do repositório');
      }
      normalized.push(root);
    } catch (error) {
      throw flowError(`raiz protegida FLOW inválida (${raw}): ${error?.message || error}`, 'FLOW_PROTECTED_ROOTS_CONFIG');
    }
  }
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) {
    throw flowError('raízes protegidas FLOW sobrepostas ou duplicadas', 'FLOW_PROTECTED_ROOTS_CONFIG');
  }
  for (let left = 0; left < unique.length; left += 1) {
    for (let right = left + 1; right < unique.length; right += 1) {
      const leftRoot = unique[left].replace(/\/\*\*$/, '');
      const rightRoot = unique[right].replace(/\/\*\*$/, '');
      if (pathAllowed(leftRoot, [unique[right]]) || pathAllowed(rightRoot, [unique[left]])) {
        throw flowError('raízes protegidas FLOW sobrepostas', 'FLOW_PROTECTED_ROOTS_CONFIG');
      }
    }
  }
  return unique;
}

export function startFlow({
  vaultBase,
  projectRoot,
  projectId = '',
  slug,
  allowedPaths,
  sensorIds,
  reason,
  sessionId = '',
  env = process.env,
  now = new Date(),
  flowId = randomUUID(),
}) {
  const cleanSlug = String(slug || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(cleanSlug)) throw flowError('slug FLOW inválido', 'FLOW_USAGE');
  if (!String(reason || '').trim()) throw flowError('--reason é obrigatório para FLOW', 'FLOW_USAGE');
  const ids = uniqueStrings(sensorIds);
  if (!ids.length) throw flowError('ao menos um sensor é obrigatório para FLOW', 'FLOW_USAGE');
  if (!Array.isArray(allowedPaths) || !allowedPaths.length) throw flowError('allowlist exige ao menos um path permitido', 'FLOW_USAGE');

  const session = resolveFlowSession(vaultBase, { sessionId, env });
  assertSessionProjectionTarget(vaultBase, session.entry.session_file);
  const visibleBaseline = captureGitSnapshot(projectRoot);
  const allowlist = normalizeAllowedPaths(projectRoot, visibleBaseline.root, allowedPaths);
  const protectedRoots = configuredProtectedFlowRoots(projectRoot, visibleBaseline.root);
  const baseline = captureFlowGitSnapshot(projectRoot, visibleBaseline.root, protectedRoots, vaultBase);
  assertSafeStartingSnapshot(baseline);
  assertBuiltinProtectedTopology(projectRoot, baseline.root);
  assertAllowedPathTopology(baseline.root, allowlist);
  assertAllowedPathTopology(baseline.root, protectedRoots);
  const preexistingAllowed = (visibleBaseline.dirty_paths || Object.keys(visibleBaseline.fingerprints))
    .filter((path) => pathAllowed(path, allowlist));
  if (preexistingAllowed.length) {
    throw flowError(`path permitido já contém sujeira preexistente: ${preexistingAllowed.join(', ')}`, 'FLOW_DIRTY_ALLOWLIST');
  }
  const definitions = selectedSensors(projectRoot, ids);
  const contract = {
    schema_version: 1,
    flow_id: flowId,
    session_id: session.sessionId,
    session_file: session.entry.session_file,
    project_id: projectId,
    project_rel: projectRelFromGitRoot(projectRoot, baseline.root),
    slug: cleanSlug,
    profile: 'FLOW',
    started_at: iso(now),
    reason: redactSecrets(String(reason).trim()),
    spec_impact: 'none',
    spec_impact_reason: redactSecrets(String(reason).trim()),
    allowed_paths: allowlist,
    protected_roots: protectedRoots,
    sensor_ids: ids,
    sensor_definition_hash: definitionHash(definitions),
    baseline: {
      schema_version: baseline.schema_version,
      root: baseline.root,
      head: baseline.head,
      fingerprints: baseline.fingerprints,
      git_metadata_fingerprint: baseline.git_metadata_fingerprint,
      hidden_index_paths: baseline.hidden_index_paths,
      unsafe_git_metadata_paths: baseline.unsafe_git_metadata_paths,
      unsafe_worktree_paths: baseline.unsafe_worktree_paths,
      protected_physical_fingerprint: baseline.protected_physical_fingerprint,
      protected_physical_fingerprints: baseline.protected_physical_fingerprints,
      protected_physical_unsafe_paths: baseline.protected_physical_unsafe_paths,
    },
  };
  createFlowContract(vaultBase, contract);
  return readFlow(vaultBase, { sessionId: session.sessionId, flowId });
}

export function flowStatus(vaultBase, { flowId = '', sessionId = '', env = process.env } = {}) {
  let state;
  if (flowId) state = findFlow(vaultBase, flowId, { sessionId });
  else {
    const session = resolveFlowSession(vaultBase, { sessionId, env });
    state = findActiveFlow(vaultBase, session.sessionId);
  }
  if (!state) throw flowError(`FLOW não encontrado${flowId ? `: ${flowId}` : ''}`, 'FLOW_NOT_FOUND');
  return state;
}

function sessionPath(vaultBase, relPath) {
  const raw = String(relPath || '');
  if (!raw || isAbsolute(raw)) throw flowError('session_file FLOW inválido', 'FLOW_SESSION_INVALID');
  const path = resolve(vaultBase, raw);
  const fromVault = relative(resolve(vaultBase), path);
  if (fromVault === '..' || fromVault.startsWith(`..${sep}`) || isAbsolute(fromVault)) {
    throw flowError('session_file FLOW fora do Vault', 'FLOW_SESSION_INVALID');
  }
  return path;
}

function assertSessionProjectionTarget(vaultBase, relPath) {
  const path = sessionPath(vaultBase, relPath);
  const checked = assertVaultPathSafe(vaultBase, path, {
    expectedType: 'file',
    label: 'session_file FLOW',
    code: 'FLOW_SESSION_INVALID',
  });
  if (!checked.exists) {
    throw flowError('nota da sessão indisponível para projeção FLOW', 'FLOW_SESSION_PROJECTION');
  }
  if (!hasSessionFrontmatter(readFileSync(path, 'utf8'))) {
    throw flowError('nota da sessão inválida para projeção FLOW', 'FLOW_SESSION_PROJECTION');
  }
  return checked.target;
}

function assertPromotionWriteTarget(vaultBase, targetPath) {
  return assertVaultPathSafe(vaultBase, targetPath, {
    expectedType: 'directory',
    label: 'destino da change promovida',
    code: 'FLOW_VAULT_BOUNDARY',
  });
}

function projectionFailure(projection) {
  if (projection?.written || projection?.reason === 'unchanged') return '';
  return `projeção na nota da sessão falhou: ${projection?.reason || 'estado desconhecido'}`;
}

function renderFinishBlock(contract, receipt) {
  const sensors = receipt.evidence.map((entry) => `\`${entry.id}\` ${entry.status}`).join(', ');
  return `### ${receipt.finished_at.slice(11, 16)} - FLOW concluído: ${contract.slug}\n\n`
    + `- **FLOW:** \`${contract.flow_id}\`\n`
    + `- **Motivo:** ${markdownInline(contract.reason)}\n`
    + `- **Paths:** ${receipt.changed_paths.map((path) => `\`${path}\``).join(', ')}\n`
    + `- **Sensores:** ${sensors}`;
}

function projectReceipt(vaultBase, state) {
  const { contract, receipt } = state;
  let path;
  try {
    path = assertSessionProjectionTarget(vaultBase, contract.session_file);
  } catch (error) {
    return { inserted: false, written: false, reason: error?.message || 'invalid-session-target' };
  }
  return projectSessionIteration(path, {
    markerId: `flow:${contract.flow_id}:finished`,
    block: renderFinishBlock(contract, receipt),
  }, { vaultBase });
}

function recordFailedAttempt(vaultBase, state, { failures, changedPaths, evidence, now }) {
  appendFlowAttempt(vaultBase, state.contract.session_id, state.contract.flow_id, {
    schema_version: 1,
    attempt_id: randomUUID(),
    status: 'red',
    recorded_at: iso(now),
    failures,
    changed_paths: changedPaths,
    evidence,
  });
  return readFlow(vaultBase, { sessionId: state.contract.session_id, flowId: state.contract.flow_id });
}

export function finishFlow({ vaultBase, projectRoot, flowId, sessionId = '', now = new Date() }) {
  const state = findFlow(vaultBase, flowId, { sessionId });
  if (!state) throw flowError(`FLOW não encontrado: ${flowId}`, 'FLOW_NOT_FOUND');
  if (state.state === 'promoted') throw flowError(`FLOW já promovido: ${flowId}`, 'FLOW_TERMINAL');
  if (state.state === 'promoting') throw flowError(`FLOW em promoção: ${flowId}`, 'FLOW_TERMINAL');
  if (state.state === 'finished') {
    const projection = projectReceipt(vaultBase, state);
    const failure = projectionFailure(projection);
    return failure
      ? { ok: false, failures: [failure], state, projection, idempotent: true }
      : { ok: true, state, projection, idempotent: true };
  }

  let frozenProjectRoot;
  try {
    frozenProjectRoot = resolveContractProjectRoot(state.contract, projectRoot);
    assertBuiltinProtectedTopology(frozenProjectRoot, state.contract.baseline.root);
    assertAllowedPathTopology(state.contract.baseline.root, state.contract.allowed_paths);
    assertAllowedPathTopology(state.contract.baseline.root, state.contract.protected_roots);
    assertSessionProjectionTarget(vaultBase, state.contract.session_file);
  } catch (error) {
    const failures = [error?.message || 'topologia física da allowlist inválida'];
    const latest = recordFailedAttempt(vaultBase, state, {
      failures, changedPaths: [], evidence: [], now,
    });
    return { ok: false, failures, state: latest };
  }

  let current;
  try {
    current = captureFlowGitSnapshot(
      frozenProjectRoot, state.contract.baseline.root, state.contract.protected_roots, vaultBase,
    );
  } catch (error) {
    const failures = [error?.message || 'scan físico protegido indisponível antes dos sensores'];
    const latest = recordFailedAttempt(vaultBase, state, {
      failures, changedPaths: [], evidence: [], now,
    });
    return { ok: false, failures, state: latest };
  }
  const delta = diffGitSnapshots(state.contract.baseline, current);
  let changedPaths = delta.changedPaths;
  const failures = [];
  if (delta.rootChanged) failures.push('repositório Git mudou durante o FLOW');
  if (delta.headChanged) failures.push('HEAD mudou durante o FLOW');
  if (delta.metadataChanged) failures.push('metadados Git mudaram durante o FLOW');
  failures.push(...snapshotSafetyFailures(current, 'antes dos sensores'));
  if (!changedPaths.length) failures.push('nenhuma alteração atribuível ao FLOW');
  for (const path of changedPaths) {
    if (!pathAllowed(path, state.contract.allowed_paths)) failures.push(`path fora da allowlist: ${path}`);
    if (isProtectedFlowPath(path, state.contract.protected_roots)) failures.push(`superfície protegida: ${path}`);
  }
  const diffCheck = runGitDiffCheck(current.root, { paths: changedPaths });
  if (!diffCheck.ok) failures.push(`git diff --check vermelho${diffCheck.output ? `: ${diffCheck.output}` : ''}`);

  let evidence = [];
  let definitions = [];
  try {
    definitions = selectedSensors(frozenProjectRoot, state.contract.sensor_ids);
    if (definitionHash(definitions) !== state.contract.sensor_definition_hash) {
      failures.push('definição de sensor mudou durante o FLOW');
    }
  } catch (error) {
    failures.push(error?.message || 'configuração de sensores inválida');
  }
  if (!failures.length) {
    evidence = runSensors(definitions, state.contract.sensor_ids, {
      cwd: frozenProjectRoot,
      env: sensorProcessEnv(vaultBase),
      now: iso(now),
    });
    const gate = evaluateGate(evidence, state.contract.sensor_ids);
    if (!gate.ok) failures.push(`sensor crítico vermelho: ${gate.failing.join(', ')}`);
    try {
      const afterSensors = captureFlowGitSnapshot(
        frozenProjectRoot, state.contract.baseline.root, state.contract.protected_roots, vaultBase,
      );
      const sensorMutation = diffGitSnapshots(current, afterSensors);
      if (sensorMutation.rootChanged || sensorMutation.headChanged
        || sensorMutation.metadataChanged || sensorMutation.changedPaths.length) {
        const detail = sensorMutation.changedPaths.length ? `: ${sensorMutation.changedPaths.join(', ')}` : '';
        failures.push(`sensor modificou o repositório${detail}`);
        changedPaths = diffGitSnapshots(state.contract.baseline, afterSensors).changedPaths;
      }
      failures.push(...snapshotSafetyFailures(afterSensors, 'após sensores'));
      for (const path of changedPaths) {
        if (!pathAllowed(path, state.contract.allowed_paths)) failures.push(`path fora da allowlist após sensores: ${path}`);
        if (isProtectedFlowPath(path, state.contract.protected_roots)) failures.push(`superfície protegida após sensores: ${path}`);
      }
      assertAllowedPathTopology(afterSensors.root, state.contract.allowed_paths, changedPaths);
      assertBuiltinProtectedTopology(frozenProjectRoot, afterSensors.root);
      assertAllowedPathTopology(afterSensors.root, state.contract.protected_roots);
      assertSessionProjectionTarget(vaultBase, state.contract.session_file);
    } catch (error) {
      failures.push(`não foi possível confirmar o estado Git após os sensores: ${error?.message || error}`);
    }
  }
  if (failures.length) {
    const latest = recordFailedAttempt(vaultBase, state, { failures, changedPaths, evidence, now });
    return { ok: false, failures, state: latest };
  }

  let terminalSnapshot;
  try {
    terminalSnapshot = captureFlowGitSnapshot(
      frozenProjectRoot, state.contract.baseline.root, state.contract.protected_roots, vaultBase,
    );
    const terminalDrift = diffGitSnapshots(current, terminalSnapshot);
    if (terminalDrift.rootChanged || terminalDrift.headChanged
      || terminalDrift.metadataChanged || terminalDrift.changedPaths.length) {
      throw flowError('repositório mudou após a validação dos sensores', 'FLOW_SENSOR_MUTATION');
    }
    const terminalSafety = snapshotSafetyFailures(terminalSnapshot, 'antes do recibo');
    if (terminalSafety.length) throw flowError(terminalSafety.join('; '), 'FLOW_GIT_VISIBILITY');
    changedPaths = diffGitSnapshots(state.contract.baseline, terminalSnapshot).changedPaths;
    for (const path of changedPaths) {
      if (!pathAllowed(path, state.contract.allowed_paths)) throw flowError(`path fora da allowlist antes do recibo: ${path}`);
      if (isProtectedFlowPath(path, state.contract.protected_roots)) throw flowError(`superfície protegida antes do recibo: ${path}`);
    }
    const terminalDiffCheck = runGitDiffCheck(terminalSnapshot.root, { paths: changedPaths });
    if (!terminalDiffCheck.ok) {
      throw flowError(`git diff --check vermelho antes do recibo${terminalDiffCheck.output ? `: ${terminalDiffCheck.output}` : ''}`);
    }
    assertAllowedPathTopology(terminalSnapshot.root, state.contract.allowed_paths, changedPaths);
    assertBuiltinProtectedTopology(frozenProjectRoot, terminalSnapshot.root);
    assertAllowedPathTopology(terminalSnapshot.root, state.contract.protected_roots);
    assertSessionProjectionTarget(vaultBase, state.contract.session_file);
  } catch (error) {
    const finalFailures = [error?.message || 'topologia física da allowlist inválida'];
    const latest = recordFailedAttempt(vaultBase, state, {
      failures: finalFailures, changedPaths, evidence, now,
    });
    return { ok: false, failures: finalFailures, state: latest };
  }

  const receipt = {
    schema_version: 1,
    flow_id: state.contract.flow_id,
    status: 'finished',
    finished_at: iso(now),
    reason: state.contract.reason,
    allowed_paths: state.contract.allowed_paths,
    sensor_ids: state.contract.sensor_ids,
    changed_paths: changedPaths,
    evidence,
    baseline_head: state.contract.baseline.head,
    final_head: terminalSnapshot.head,
  };
  writeFlowReceipt(vaultBase, state.contract.session_id, state.contract.flow_id, receipt);
  const finished = readFlow(vaultBase, { sessionId: state.contract.session_id, flowId: state.contract.flow_id });
  const projection = projectReceipt(vaultBase, finished);
  const failure = projectionFailure(projection);
  return failure
    ? { ok: false, failures: [failure], state: finished, projection }
    : { ok: true, state: finished, projection };
}

function markdownInline(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('`', 'ˋ');
}

function renderPromotionBlock(contract, promotion) {
  const paths = promotion.changed_paths.length
    ? promotion.changed_paths.map((path) => `\`${markdownInline(path)}\``).join(', ')
    : '(nenhum path alterado observado)';
  return `### ${promotion.promoted_at.slice(11, 16)} - FLOW promovido: ${contract.slug}\n\n`
    + `- **FLOW:** \`${contract.flow_id}\`\n`
    + `- **Change:** \`${promotion.change_slug}\`\n`
    + `- **Motivo:** ${markdownInline(contract.reason)}\n`
    + `- **Paths observados:** ${paths}`;
}

function projectPromotion(vaultBase, state) {
  const { contract, promotion } = state;
  let path;
  try {
    path = assertSessionProjectionTarget(vaultBase, contract.session_file);
  } catch (error) {
    return { inserted: false, written: false, reason: error?.message || 'invalid-session-target' };
  }
  return projectSessionIteration(path, {
    markerId: `flow:${contract.flow_id}:promoted`,
    block: renderPromotionBlock(contract, promotion),
  }, { vaultBase });
}

function promotionResult(vaultBase, state, { idempotent = false } = {}) {
  const projection = projectPromotion(vaultBase, state);
  const failure = projectionFailure(projection);
  return failure
    ? { ok: false, failures: [failure], state, projection, ...(idempotent ? { idempotent: true } : {}) }
    : { ok: true, state, projection, ...(idempotent ? { idempotent: true } : {}) };
}

function promotionConflict(message) {
  return flowError(message, 'FLOW_PROMOTION_CONFLICT');
}

function readOrigin(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw promotionConflict(`origem FLOW inválida na change: ${path}`);
  }
}

function assertOriginMatches(origin, contract) {
  const sameContract = JSON.stringify(canonical(origin?.contract)) === JSON.stringify(canonical(contract));
  if (origin?.schema_version !== 1
    || origin?.flow_id !== contract.flow_id
    || !sameContract
    || !Array.isArray(origin?.attempts)
    || !Array.isArray(origin?.observed_git?.changed_paths)) {
    throw promotionConflict(`origem FLOW inconsistente para ${contract.flow_id}`);
  }
  return origin;
}

function ensureOrigin(vaultBase, path, origin) {
  const checked = assertVaultPathSafe(vaultBase, path, {
    expectedType: 'file', label: 'flow-origin.json', code: 'FLOW_VAULT_BOUNDARY',
  });
  if (checked.exists) {
    const existing = assertOriginMatches(readOrigin(path), origin.contract);
    if (JSON.stringify(canonical(existing)) !== JSON.stringify(canonical(origin))) {
      throw promotionConflict(`origem FLOW diverge da reserva de ${origin.flow_id}`);
    }
    return existing;
  }
  writeVaultFileAtomic(
    vaultBase,
    path,
    `${JSON.stringify(canonical(origin), null, 2)}\n`,
    'utf8',
    { label: 'flow-origin.json', code: 'FLOW_VAULT_BOUNDARY' },
  );
  return origin;
}

function renderOriginSummary(origin) {
  const contract = origin.contract;
  const paths = origin.observed_git.changed_paths.length
    ? origin.observed_git.changed_paths.map((path) => `\`${markdownInline(path)}\``).join(', ')
    : '(nenhum path alterado observado)';
  const sensors = contract.sensor_ids.map((id) => `\`${markdownInline(id)}\``).join(', ');
  const attempts = origin.attempts.length
    ? origin.attempts.map((attempt) => {
      const failures = (attempt.failures || []).map(markdownInline).join('; ') || attempt.status;
      return `- \`${attempt.attempt_id}\` (${attempt.recorded_at}): ${failures}`;
    }).join('\n')
    : '- Nenhuma tentativa de finalização anterior.';
  return `<!-- wendkeep:flow-origin:${contract.flow_id} -->\n`
    + '## Origem FLOW\n\n'
    + `- **FLOW:** \`${contract.flow_id}\`\n`
    + `- **Sessão:** \`${contract.session_id}\`\n`
    + `- **Motivo original:** ${markdownInline(contract.reason)}\n`
    + `- **Paths permitidos:** ${contract.allowed_paths.map((path) => `\`${markdownInline(path)}\``).join(', ')}\n`
    + `- **Paths observados:** ${paths}\n`
    + `- **Sensores:** ${sensors}\n`
    + `- **Baseline HEAD:** \`${contract.baseline.head}\`\n\n`
    + '### Tentativas preservadas\n\n'
    + `${attempts}\n\n`
    + 'O escopo deve seguir agora o lifecycle completo de uma change WendKeep. '
    + 'O arquivo `flow-origin.json` é a evidência estruturada e imutável desta promoção.';
}

function enrichProposal(vaultBase, path, origin) {
  let proposal = readFileSync(path, 'utf8');
  const marker = `<!-- wendkeep:flow-origin:${origin.flow_id} -->`;
  if (proposal.includes(marker)) return false;
  const why = `Promovida do FLOW \`${origin.flow_id}\`: ${markdownInline(origin.contract.reason)}`;
  const scope = origin.observed_git.changed_paths.length
    ? `Escopo observado antes da promoção: ${origin.observed_git.changed_paths.map(markdownInline).join(', ')}.`
    : 'Nenhuma alteração foi observada antes da promoção; o escopo será definido nesta change.';
  proposal = proposal
    .replace('(motivo da mudança)', why)
    .replace('(reason for the change)', why)
    .replace('(escopo da mudança)', scope)
    .replace('(scope of the change)', scope);
  proposal = `${proposal.trimEnd()}\n\n${renderOriginSummary(origin)}\n`;
  writeVaultFileAtomic(
    vaultBase,
    path,
    proposal,
    'utf8',
    { label: 'proposta promovida do FLOW', code: 'FLOW_VAULT_BOUNDARY' },
  );
  return true;
}

function assertSlugOwner(vaultBase, state, changeRel) {
  const foreign = listFlows(vaultBase).find((candidate) => {
    const ownsChange = candidate.reservation?.change_rel === changeRel
      || candidate.promotion?.change_rel === changeRel;
    const sameFlow = candidate.contract.session_id === state.contract.session_id
      && candidate.contract.flow_id === state.contract.flow_id;
    return ownsChange && !sameFlow;
  });
  if (foreign) {
    throw promotionConflict(
      `change ${changeRel.replaceAll('\\', '/')} já pertence ao FLOW ${foreign.contract.flow_id}`,
    );
  }
}

export function promoteFlow({
  vaultBase,
  projectRoot,
  flowId,
  sessionId = '',
  changeSlug = '',
  now = new Date(),
}) {
  let state = findFlow(vaultBase, flowId, { sessionId });
  if (!state) throw flowError(`FLOW não encontrado: ${flowId}`, 'FLOW_NOT_FOUND');
  if (state.state === 'finished') throw flowError(`FLOW já finalizado: ${flowId}`, 'FLOW_TERMINAL');
  if (state.state === 'promoted') return promotionResult(vaultBase, state, { idempotent: true });

  assertSessionProjectionTarget(vaultBase, state.contract.session_file);

  const explicitSlug = String(changeSlug || '').trim();
  const requestedSlug = explicitSlug
    || (state.state === 'promoting' ? state.reservation.change_slug : state.contract.slug)
    || '';
  const slug = state.state === 'promoting' ? state.reservation.change_slug : requestedSlug;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) throw flowError('slug da change promovida inválido', 'FLOW_USAGE');
  if (state.state === 'promoting' && explicitSlug && requestedSlug !== slug) {
    throw promotionConflict(`promoção de ${flowId} já reservada para a change ${slug}`);
  }

  const locked = withFlowPromotionLock(vaultBase, slug, () => {
    // Re-read only after owning the slug. This is the authoritative state for every
    // ownership decision and for the reservation that follows.
    state = readFlow(vaultBase, {
      sessionId: state.contract.session_id,
      flowId: state.contract.flow_id,
    });
    if (!state) throw flowError(`FLOW não encontrado: ${flowId}`, 'FLOW_NOT_FOUND');
    if (state.state === 'finished') throw flowError(`FLOW já finalizado: ${flowId}`, 'FLOW_TERMINAL');
    if (state.state === 'promoted') return { state, idempotent: true };
    assertSessionProjectionTarget(vaultBase, state.contract.session_file);

    const lockedSlug = state.state === 'promoting' ? state.reservation.change_slug : slug;
    if (lockedSlug !== slug) {
      throw promotionConflict(`promoção de ${flowId} já reservada para a change ${lockedSlug}`);
    }
    const changeRel = changeDirRel(slug, vaultBase).replaceAll('\\', '/');
    if (state.state === 'promoting' && state.reservation.change_rel !== changeRel) {
      throw promotionConflict(`path da change reservada diverge para ${flowId}`);
    }
    assertSlugOwner(vaultBase, state, changeRel);
    const frozenProjectRoot = resolveContractProjectRoot(state.contract, projectRoot);

    const changeDir = join(vaultBase, changeRel);
    const proposalPath = join(changeDir, 'proposta.md');
    const originPath = join(changeDir, 'flow-origin.json');
    // Boundary validation is inside the slug lock and precedes both durable ownership
    // reservation and every write through the change scaffold.
    assertChangeScaffoldTargetsSafe(vaultBase, slug, {
      simple: false,
      includeSessionControl: true,
      code: 'FLOW_VAULT_BOUNDARY',
    });
    const checkedChangeDir = assertPromotionWriteTarget(vaultBase, changeDir);
    if (state.state === 'active' && checkedChangeDir.exists) {
      throw promotionConflict(`change preexistente não pode ser reivindicada pelo FLOW: ${slug}`);
    }
    const checkedOrigin = assertVaultPathSafe(vaultBase, originPath, {
      expectedType: 'file', label: 'flow-origin.json', code: 'FLOW_VAULT_BOUNDARY',
    });
    if (state.state === 'promoting' && checkedChangeDir.exists && !checkedOrigin.exists) {
      const retryArtifacts = readdirSync(changeDir);
      for (const name of retryArtifacts) {
        assertVaultPathSafe(vaultBase, join(changeDir, name), {
          expectedType: 'any',
          label: `artefato inesperado de retry FLOW ${name}`,
          code: 'FLOW_VAULT_BOUNDARY',
        });
      }
      const resumableEmptyDir = retryArtifacts.length === 0;
      if (!resumableEmptyDir) {
        throw promotionConflict(`change preexistente sem origem deste FLOW: ${slug}`);
      }
    }
    if (state.state === 'promoting' && checkedChangeDir.exists && checkedOrigin.exists) {
      const expectedArtifacts = new Set([
        'flow-origin.json', 'proposta.md', 'tarefas.md', 'design.md',
        '.spec-impact-v1', '.spec-base.json',
      ]);
      for (const name of readdirSync(changeDir)) {
        const artifact = join(changeDir, name);
        assertVaultPathSafe(vaultBase, artifact, {
          expectedType: expectedArtifacts.has(name) ? 'file' : 'any',
          label: `artefato de retry FLOW ${name}`,
          code: 'FLOW_VAULT_BOUNDARY',
        });
        if (!expectedArtifacts.has(name)) {
          throw promotionConflict(`artefato inesperado na change reservada: ${name}`);
        }
      }
    }
    const existingOrigin = state.state === 'promoting' && checkedOrigin.exists
      ? assertOriginMatches(readOrigin(originPath), state.contract)
      : null;
    assertBuiltinProtectedTopology(frozenProjectRoot, state.contract.baseline.root);
    assertAllowedPathTopology(state.contract.baseline.root, state.contract.protected_roots);
    const current = captureFlowGitSnapshot(
      frozenProjectRoot, state.contract.baseline.root, state.contract.protected_roots, vaultBase,
    );
    assertBuiltinProtectedTopology(frozenProjectRoot, current.root);
    assertAllowedPathTopology(current.root, state.contract.protected_roots);
    const delta = diffGitSnapshots(state.contract.baseline, current);
    if (delta.rootChanged) {
      throw flowError('repositório Git mudou durante o FLOW', 'FLOW_REPOSITORY_CHANGED');
    }
    if (delta.metadataChanged || snapshotSafetyFailures(current, 'antes da promoção').length) {
      throw flowError(
        ['metadados Git mudaram ou ficaram inseguros durante o FLOW', ...snapshotSafetyFailures(current, 'antes da promoção')].join('; '),
        'FLOW_GIT_VISIBILITY',
      );
    }
    if (state.state === 'active') {
      const reservedAt = existingOrigin?.promoted_at || iso(now);
      const originCandidate = existingOrigin || {
        schema_version: 1,
        flow_id: state.contract.flow_id,
        promoted_at: reservedAt,
        contract: state.contract,
        attempts: state.attempts,
        observed_git: {
          baseline_head: state.contract.baseline.head,
          current_head: current.head,
          head_changed: delta.headChanged,
          changed_paths: delta.changedPaths,
        },
      };
      reserveFlowPromotion(vaultBase, state.contract.session_id, state.contract.flow_id, {
        schema_version: 1,
        flow_id: state.contract.flow_id,
        status: 'promoting',
        reserved_at: reservedAt,
        change_slug: slug,
        change_rel: changeRel,
        origin: originCandidate,
      });
      state = readFlow(vaultBase, {
        sessionId: state.contract.session_id,
        flowId: state.contract.flow_id,
      });
    }
    const originCandidate = state.reservation.origin;

    assertPromotionWriteTarget(vaultBase, changeDir);
    mkdirVaultPath(vaultBase, changeDir, {
      label: 'destino da change promovida', code: 'FLOW_VAULT_BOUNDARY',
    });
    assertPromotionWriteTarget(vaultBase, changeDir);
    const origin = ensureOrigin(vaultBase, originPath, originCandidate);
    assertPromotionWriteTarget(vaultBase, changeDir);
    const change = newChange(vaultBase, slug, {
      sessionRel: state.contract.session_file,
      dateStr: state.reservation.reserved_at.slice(0, 10),
      simple: false,
    });
    assertPromotionWriteTarget(vaultBase, changeDir);
    enrichProposal(vaultBase, proposalPath, origin);
    upsertSessionRegistry(vaultBase, state.contract.session_id, { change_slug: slug });

    const promotion = {
      schema_version: 1,
      flow_id: state.contract.flow_id,
      status: 'promoted',
      promoted_at: origin.promoted_at,
      change_slug: slug,
      change_rel: state.reservation.change_rel,
      origin_file: `${change.rel.replaceAll('\\', '/')}/flow-origin.json`,
      changed_paths: origin.observed_git.changed_paths,
      baseline_head: origin.observed_git.baseline_head,
      current_head: origin.observed_git.current_head,
    };
    const terminalSnapshot = captureFlowGitSnapshot(
      frozenProjectRoot, state.contract.baseline.root, state.contract.protected_roots, vaultBase,
    );
    assertBuiltinProtectedTopology(frozenProjectRoot, terminalSnapshot.root);
    assertAllowedPathTopology(terminalSnapshot.root, state.contract.protected_roots);
    const terminalDrift = diffGitSnapshots(current, terminalSnapshot);
    const terminalSafety = snapshotSafetyFailures(terminalSnapshot, 'antes de terminalizar a promoção');
    if (terminalDrift.rootChanged || terminalDrift.headChanged || terminalDrift.metadataChanged
      || terminalDrift.changedPaths.length || terminalSafety.length) {
      throw flowError(
        [
          'repositório mudou ou ficou inseguro durante a promoção',
          ...(terminalDrift.changedPaths.length ? [`paths: ${terminalDrift.changedPaths.join(', ')}`] : []),
          ...terminalSafety,
        ].join('; '),
        'FLOW_GIT_VISIBILITY',
      );
    }
    assertSessionProjectionTarget(vaultBase, state.contract.session_file);
    writeFlowPromotion(vaultBase, state.contract.session_id, state.contract.flow_id, promotion);
    return {
      state: readFlow(vaultBase, {
        sessionId: state.contract.session_id,
        flowId: state.contract.flow_id,
      }),
      idempotent: false,
    };
  });
  return promotionResult(vaultBase, locked.state, { idempotent: locked.idempotent });
}
