import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseTasks } from '../hooks/change-core.mjs';
import { getLocale } from '../hooks/locale.mjs';
import { buildEffectiveRequirementPackage, contentHashOf, tasksHashOf } from '../hooks/spec-core.mjs';
import { activeContextKey, resolveActiveContext } from '../hooks/active-context-store.mjs';
import { evaluateTddAttestation } from './tdd-attestation.mjs';
import { captureTddSnapshot, readTddAttestationStore } from './tdd-attestation-store.mjs';

const IGNORED_DIRECTORIES = new Set(['.git', '.worktrees', 'node_modules', 'dist']);
const BINDING_FIELDS = [
  ['active_context_id', 'TASK_CONTRACT_STALE_CONTEXT'],
  ['head_sha', 'TASK_CONTRACT_STALE_HEAD'],
  ['tasks_sha256', 'TASK_CONTRACT_STALE_TASKS'],
  ['effective_spec_sha256', 'TASK_CONTRACT_STALE_SPEC'],
  ['artifact_manifest_sha256', 'TASK_CONTRACT_STALE_ARTIFACT_MANIFEST'],
];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function uniqueStrings(values) {
  const list = Array.isArray(values) ? values : (values === undefined || values === null ? [] : [values]);
  return [...new Set(list.map((value) => String(value).trim()).filter(Boolean))];
}

function bindingFrom(input) {
  return {
    project_id: String(input.projectId || ''),
    active_context_id: String(input.activeContextId || ''),
    head_sha: String(input.headSha || ''),
    tasks_sha256: String(input.tasksSha256 || ''),
    effective_spec_sha256: String(input.effectiveSpecSha256 || ''),
    artifact_manifest_sha256: String(input.artifactManifestSha256 || ''),
  };
}

export function deriveTaskContracts(input = {}) {
  const changeSlug = String(input.changeSlug || '').trim();
  const projectId = String(input.projectId || '').trim();
  if (!projectId || !changeSlug) {
    throw Object.assign(new Error('projectId and changeSlug are required'), { code: 'TASK_CONTRACT_IDENTITY_MISSING' });
  }
  const binding = bindingFrom(input);
  const artifactSpecs = new Map((input.artifactSpecs ?? []).map((spec) => [String(spec.name || ''), spec]));
  const profile = String(input.profile || '').trim().toUpperCase();
  const attestations = Array.isArray(input.tddAttestations) ? input.tddAttestations : [];
  return (input.tasks ?? []).map((task) => {
    const taskId = String(task.id || '').trim();
    const phase = String(task.phase || 'execute').trim().toLowerCase();
    if (!['execute', 'verify'].includes(phase)) {
      throw Object.assign(new Error(`invalid task phase for ${taskId}: ${phase}`), { code: 'TASK_PHASE_INVALID' });
    }
    const lease = input.taskLeases?.[`${changeSlug}:${taskId}`];
    const activeLease = lease?.state === 'active' && Date.parse(String(lease.expires_at || '')) > Date.now()
      ? lease : null;
    const dependencies = uniqueStrings(task.dependencies);
    const requiredArtifacts = uniqueStrings(task.artifacts);
    const requirementIds = uniqueStrings(task.reqs);
    const tddRequired = (profile === 'GOVERN' && task.tdd === true)
      || (profile === 'ASSURE' && phase === 'execute'
        && (requirementIds.length > 0 || uniqueStrings(task.sensors).length > 0));
    const tddAttestation = attestations.find((attestation) => (
      String(attestation?.task_id || '') === taskId
      && requirementIds.includes(String(attestation?.requirement_id || ''))
      && ['green-observed', 'waived'].includes(String(attestation?.state || ''))
    )) || null;
    const authored = {
      change_slug: changeSlug,
      task_id: taskId,
      title: String(task.text || '').trim(),
      phase,
      checked: task.done === true,
      requirement_ids: requirementIds,
      required_sensors: uniqueStrings(task.sensors ?? (task.sensor ? [task.sensor] : [])),
      required_artifacts: requiredArtifacts,
      dependencies,
      tdd_required: tddRequired,
      binding,
      artifact_specs: requiredArtifacts.map((name) => artifactSpecs.get(name) ?? { name }),
    };
    return {
      schema_version: 1,
      contract_id: sha256(`${projectId}\0${changeSlug}\0${taskId}`),
      task_id: taskId,
      change_slug: changeSlug,
      title: authored.title,
      phase,
      status: task.done === true ? 'pending-evaluation' : (dependencies.length ? 'blocked' : 'ready'),
      inputs: uniqueStrings(task.inputs),
      expected_outputs: uniqueStrings(task.expectedOutputs),
      acceptance_criteria: uniqueStrings(task.acceptanceCriteria ?? [authored.title]),
      requirement_ids: authored.requirement_ids,
      required_sensors: authored.required_sensors,
      required_artifacts: authored.required_artifacts,
      dependencies,
      owner: activeLease?.owner_session_id ?? null,
      work_session_id: activeLease?.owner_work_session_id ?? null,
      evidence_envelope_id: input.evidenceEnvelopeId ?? null,
      tdd_required: tddRequired,
      tdd_attestation_id: tddAttestation ? String(tddAttestation.attestation_id || '') || null : null,
      checked: authored.checked,
      authored_sha256: sha256(canonicalJson(authored)),
      binding,
    };
  });
}

function taskFinding(code, field, expected, observed) {
  return {
    code,
    field,
    expected: expected ?? null,
    observed: observed ?? null,
    recovery: 'rebuild and re-evaluate the task contract in the active context',
  };
}

export function evaluateTaskContract(contract, options = {}) {
  const currentBinding = options.currentBinding ?? contract.binding ?? {};
  const blockingFindings = [];
  for (const [field, code] of BINDING_FIELDS) {
    if (String(contract.binding?.[field] ?? '') !== String(currentBinding?.[field] ?? '')) {
      blockingFindings.push(taskFinding(code, field, contract.binding?.[field], currentBinding?.[field]));
    }
  }
  if (contract.checked !== true) {
    blockingFindings.push(taskFinding('TASK_CHECKBOX_OPEN', 'checked', true, contract.checked === true));
  }

  const availableRequirements = new Set(uniqueStrings(options.availableRequirementIds));
  const missingRequirements = uniqueStrings(contract.requirement_ids).filter((id) => !availableRequirements.has(id));
  const sensors = new Map((options.sensorResults ?? []).map((sensor) => [String(sensor.id || ''), sensor]));
  const missingSensors = uniqueStrings(contract.required_sensors)
    .filter((id) => sensors.get(id)?.status !== 'green');
  const artifacts = new Map((options.artifactResults ?? []).map((artifact) => [String(artifact.name || ''), artifact]));
  const missingArtifacts = uniqueStrings(contract.required_artifacts)
    .filter((name) => artifacts.get(name)?.satisfied !== true);
  const completedTasks = new Set(uniqueStrings(options.completedTaskIds));
  const openDependencies = uniqueStrings(contract.dependencies).filter((id) => !completedTasks.has(id));
  const tddMissing = contract.tdd_required === true && !String(contract.tdd_attestation_id || '').trim();

  for (const id of missingRequirements) blockingFindings.push(taskFinding('TASK_REQUIREMENT_MISSING', 'requirement_ids', id, null));
  for (const id of missingSensors) blockingFindings.push(taskFinding('TASK_SENSOR_MISSING_OR_RED', 'required_sensors', id, sensors.get(id)?.status ?? null));
  for (const name of missingArtifacts) blockingFindings.push(taskFinding('TASK_ARTIFACT_MISSING', 'required_artifacts', name, null));
  for (const id of openDependencies) blockingFindings.push(taskFinding('TASK_DEPENDENCY_OPEN', 'dependencies', id, null));
  if (tddMissing) {
    blockingFindings.push(taskFinding(
      'TASK_TDD_ATTESTATION_MISSING_OR_INVALID',
      'tdd_attestation_id',
      'green-observed or waived',
      null,
    ));
  }

  const canComplete = blockingFindings.length === 0;
  return {
    task_id: contract.task_id,
    contract_id: contract.contract_id,
    phase: contract.phase || 'execute',
    can_complete: canComplete,
    status: canComplete ? 'completed' : (blockingFindings.some((finding) => finding.code.startsWith('TASK_CONTRACT_STALE_')) ? 'stale' : 'blocked'),
    missing_requirements: missingRequirements,
    missing_sensors: missingSensors,
    missing_artifacts: missingArtifacts,
    open_dependencies: openDependencies,
    blocking_findings: blockingFindings,
  };
}

function artifactError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function insideRoot(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function safeRelativePath(projectRoot, value) {
  const raw = String(value || '').replaceAll('\\', '/');
  if (!raw || isAbsolute(raw) || raw.split('/').includes('..')) {
    throw artifactError('TASK_ARTIFACT_PATH_ESCAPE', `artifact path escapes project: ${raw}`);
  }
  const root = realpathSync(projectRoot);
  const target = resolve(root, raw);
  if (!insideRoot(root, target)) throw artifactError('TASK_ARTIFACT_PATH_ESCAPE', `artifact path escapes project: ${raw}`);
  if (existsSync(target)) {
    const real = realpathSync(target);
    if (!insideRoot(root, real)) throw artifactError('TASK_ARTIFACT_PATH_ESCAPE', `artifact target escapes project: ${raw}`);
  }
  return { raw, root, target };
}

function globRegExp(pattern) {
  let source = '';
  const normalized = String(pattern || '').replaceAll('\\', '/');
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*' && normalized[index + 1] === '*') {
      index += 1;
      if (normalized[index + 1] === '/') {
        index += 1;
        source += '(?:.*/)?';
      } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function scanProject(projectRoot, limits = {}) {
  const root = realpathSync(projectRoot);
  const maxEntries = Number.isSafeInteger(limits.maxEntries) ? limits.maxEntries : 10_000;
  const timeoutMs = Number.isFinite(limits.timeoutMs) ? limits.timeoutMs : 2_000;
  const started = Date.now();
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (Date.now() - started > timeoutMs) throw artifactError('TASK_ARTIFACT_SCAN_TIMEOUT', 'artifact scan timed out');
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const real = realpathSync(absolute);
        if (!insideRoot(root, real)) throw artifactError('TASK_ARTIFACT_PATH_ESCAPE', `artifact symlink escapes project: ${rel}`);
        continue;
      }
      if (entry.isDirectory()) walk(absolute, rel);
      else {
        files.push(rel.replaceAll('\\', '/'));
        if (files.length > maxEntries) throw artifactError('TASK_ARTIFACT_SCAN_LIMIT', `artifact scan exceeded ${maxEntries} entries`);
      }
    }
  };
  walk(root);
  return files;
}

export function evaluateArtifactSpecs({ projectRoot, specs = [], registeredArtifacts = [], limits = {} } = {}) {
  const registered = new Map(registeredArtifacts.map((artifact) => [String(artifact.name || ''), artifact]));
  let files = null;
  const results = specs.map((spec) => {
    const name = String(spec.name || '').trim();
    const type = String(spec.type || '').trim();
    if (!name || !['name', 'path', 'glob', 'file-count'].includes(type)) {
      throw artifactError('TASK_ARTIFACT_SPEC_INVALID', `invalid artifact spec: ${name || '(unnamed)'}`);
    }
    if (registered.has(name)) return { name, type, satisfied: true, count: 1, source: 'registered' };
    if (type === 'name') return { name, type, satisfied: false, count: 0, source: 'registry' };
    if (spec.fromFilesystem !== true) return { name, type, satisfied: false, count: 0, source: 'filesystem-disabled' };

    if (type === 'path') {
      const checked = safeRelativePath(projectRoot, spec.path);
      const satisfied = existsSync(checked.target) && !lstatSync(checked.target).isSymbolicLink();
      return { name, type, satisfied, count: satisfied ? 1 : 0, source: 'filesystem' };
    }

    safeRelativePath(projectRoot, spec.glob);
    files ??= scanProject(projectRoot, limits);
    const matcher = globRegExp(spec.glob);
    const count = files.filter((file) => matcher.test(file)).length;
    if (type === 'glob') return { name, type, satisfied: count > 0, count, source: 'filesystem' };
    const min = Number.isSafeInteger(spec.min) ? spec.min : 1;
    const max = Number.isSafeInteger(spec.max) ? spec.max : Number.POSITIVE_INFINITY;
    return { name, type, satisfied: count >= min && count <= max, count, source: 'filesystem' };
  });
  return { ok: results.every((result) => result.satisfied), results };
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw Object.assign(new Error(`invalid JSON: ${path}`), { code: 'TASK_CONTRACT_JSON_INVALID', cause: error });
  }
}

function artifactManifest(changeDir) {
  const path = join(changeDir, 'artifacts.json');
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const parsed = raw ? readJson(path, {}) : {};
  if (raw && (parsed?.schema_version !== 1 || !Array.isArray(parsed?.artifacts))) {
    throw Object.assign(new Error('artifacts.json must use schema_version 1 and an artifacts array'), {
      code: 'TASK_ARTIFACT_MANIFEST_INVALID',
    });
  }
  return { raw, specs: parsed?.artifacts ?? [], hash: contentHashOf(raw) };
}

export function buildTaskContractSnapshot({
  vaultBase,
  projectRoot,
  changeSlug,
  identity,
  context = null,
  registeredArtifacts = [],
  artifactLimits,
  profile = 'GOVERN',
} = {}) {
  const slug = String(changeSlug || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) {
    throw Object.assign(new Error(`invalid change slug: ${slug}`), { code: 'TASK_CHANGE_INVALID' });
  }
  const changeDir = join(vaultBase, getLocale(vaultBase).folders.changes, slug);
  let tarefasMd;
  try { tarefasMd = readFileSync(join(changeDir, 'tarefas.md'), 'utf8'); }
  catch (error) {
    throw Object.assign(new Error(`change not found: ${slug}`), { code: 'TASK_CHANGE_NOT_FOUND', cause: error });
  }
  const tasks = parseTasks(tarefasMd);
  const reqIds = uniqueStrings(tasks.flatMap((task) => task.reqs ?? []));
  const effective = buildEffectiveRequirementPackage(vaultBase, changeDir, reqIds);
  const manifest = artifactManifest(changeDir);
  const evidence = readJson(join(changeDir, 'evidencia.json'), null);
  const causalContext = context || resolveActiveContext(vaultBase, identity);
  const tddSnapshot = captureTddSnapshot(projectRoot);
  const mutationSurvivors = (evidence?.sensors ?? []).flatMap((sensor) => sensor.survivors ?? []);
  const tddAttestations = readTddAttestationStore(vaultBase, slug).attestations
    .map((attestation) => evaluateTddAttestation(attestation, tddSnapshot, { mutationSurvivors }));
  const binding = {
    projectId: identity.projectId,
    activeContextId: activeContextKey(identity),
    headSha: identity.headSha,
    tasksSha256: tasksHashOf(tarefasMd),
    effectiveSpecSha256: effective.hash,
    artifactManifestSha256: manifest.hash,
  };
  const contracts = deriveTaskContracts({
    ...binding,
    changeSlug: slug,
    tasks,
    artifactSpecs: manifest.specs,
    taskLeases: causalContext?.task_leases ?? {},
    evidenceEnvelopeId: evidence?.envelope_id ?? null,
    profile,
    tddAttestations,
  });
  const artifactEvaluation = evaluateArtifactSpecs({
    projectRoot,
    specs: manifest.specs,
    registeredArtifacts,
    limits: artifactLimits,
  });
  return {
    schema_version: 1,
    change_slug: slug,
    binding: bindingFrom(binding),
    contracts,
    requirement_ids: effective.requirements.map((requirement) => requirement.id).filter(Boolean),
    missing_requirement_ids: effective.missing,
    sensor_results: evidence?.sensors ?? [],
    evidence_envelope_id: evidence?.envelope_id ?? null,
    artifact_results: artifactEvaluation.results,
    tdd_attestations: tddAttestations,
  };
}

export function evaluateTaskContracts(snapshot) {
  const completed = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const contract of snapshot.contracts ?? []) {
      if (completed.has(contract.task_id)) continue;
      const result = evaluateTaskContract(contract, {
        currentBinding: snapshot.binding,
        availableRequirementIds: snapshot.requirement_ids,
        sensorResults: snapshot.sensor_results,
        artifactResults: snapshot.artifact_results,
        completedTaskIds: [...completed],
      });
      if (result.can_complete) {
        completed.add(contract.task_id);
        changed = true;
      }
    }
  }
  return (snapshot.contracts ?? []).map((contract) => evaluateTaskContract(contract, {
    currentBinding: snapshot.binding,
    availableRequirementIds: snapshot.requirement_ids,
    sensorResults: snapshot.sensor_results,
    artifactResults: snapshot.artifact_results,
    completedTaskIds: [...completed].filter((id) => id !== contract.task_id),
  }));
}

export function deriveHandoffContract(input = {}) {
  const contract = {
    schema_version: 1,
    from: String(input.from || ''),
    to: String(input.to || ''),
    active_context_id: String(input.activeContextId || ''),
    task_id: String(input.taskId || ''),
    task_contract_id: String(input.taskContractId || ''),
    artifacts: uniqueStrings(input.artifacts),
    evidence: uniqueStrings(input.evidence),
    decisions: uniqueStrings(input.decisions),
    next_actions: uniqueStrings(input.nextActions),
    blockers: uniqueStrings(input.blockers),
    tdd_attestation_ids: uniqueStrings(input.tddAttestationIds),
    head_sha: String(input.headSha || ''),
    tasks_sha256: String(input.tasksSha256 || ''),
    spec_sha256: String(input.specSha256 || ''),
    authority: 'verified',
  };
  for (const field of ['from', 'to', 'active_context_id', 'head_sha', 'tasks_sha256', 'spec_sha256']) {
    if (!contract[field]) {
      throw Object.assign(new Error(`handoff field is required: ${field}`), { code: 'HANDOFF_CONTRACT_INVALID' });
    }
  }
  contract.handoff_id = sha256(canonicalJson(contract));
  return contract;
}

export function normalizeHandoffContract(value) {
  if (typeof value === 'string') {
    const summary = value.trim();
    return summary ? { schema_version: 0, authority: 'legacy-reported', summary } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schema_version !== 1) {
    const summary = String(value.summary || '').trim();
    return summary ? { schema_version: 0, authority: 'legacy-reported', summary } : null;
  }
  const normalized = {
    schema_version: 1,
    handoff_id: String(value.handoff_id || ''),
    from: String(value.from || ''),
    to: String(value.to || ''),
    active_context_id: String(value.active_context_id || ''),
    task_id: String(value.task_id || ''),
    task_contract_id: String(value.task_contract_id || ''),
    artifacts: uniqueStrings(value.artifacts),
    evidence: uniqueStrings(value.evidence),
    decisions: uniqueStrings(value.decisions),
    next_actions: uniqueStrings(value.next_actions),
    blockers: uniqueStrings(value.blockers),
    tdd_attestation_ids: uniqueStrings(value.tdd_attestation_ids),
    head_sha: String(value.head_sha || ''),
    tasks_sha256: String(value.tasks_sha256 || ''),
    spec_sha256: String(value.spec_sha256 || ''),
    authority: value.authority === 'verified' ? 'verified' : 'reported',
  };
  if (!normalized.handoff_id || !normalized.active_context_id || !normalized.head_sha
    || !normalized.tasks_sha256 || !normalized.spec_sha256) {
    throw Object.assign(new Error('structured handoff is incomplete'), { code: 'HANDOFF_CONTRACT_INVALID' });
  }
  return normalized;
}

export function evaluateHandoffContract(contract, current = {}) {
  if (!contract || contract.schema_version !== 1) {
    return { state: 'legacy-reported', blocking_findings: [] };
  }
  const findings = [];
  for (const [field, code] of [
    ['head_sha', 'HANDOFF_STALE_HEAD'],
    ['tasks_sha256', 'HANDOFF_STALE_TASKS'],
    ['spec_sha256', 'HANDOFF_STALE_SPEC'],
  ]) {
    if (String(contract[field] || '') !== String(current[field] || '')) findings.push({ code, field });
  }
  return { state: findings.length ? 'stale' : 'verified', blocking_findings: findings };
}

export function assertStructuredHandoffForProfile(profile, contract) {
  if (String(profile || '').toUpperCase() === 'ASSURE'
    && (!contract || contract.schema_version !== 1 || contract.authority !== 'verified')) {
    throw Object.assign(new Error('ASSURE requires a verified structured handoff'), {
      code: 'HANDOFF_STRUCTURED_REQUIRED',
    });
  }
  return contract;
}

export function buildStructuredTaskHandoff({
  profile = 'GOVERN',
  sessionId = '',
  snapshot = null,
  evaluations = [],
  context = {},
  shared = null,
} = {}) {
  const base = shared && typeof shared === 'object' && !Array.isArray(shared) ? { ...shared } : {};
  if (!snapshot) {
    assertStructuredHandoffForProfile(profile, null);
    return Object.keys(base).length ? base : null;
  }
  const activeLease = Object.values(context?.task_leases || {}).find((lease) => (
    lease?.state === 'active' && lease.owner_session_id === String(sessionId)
  ));
  const selectedEvaluation = evaluations.find((item) => item.task_id === activeLease?.task_id)
    || evaluations.find((item) => !item.can_complete)
    || evaluations[0]
    || null;
  const selectedContract = snapshot.contracts?.find((item) => item.task_id === selectedEvaluation?.task_id)
    || snapshot.contracts?.[0]
    || null;
  const blockers = uniqueStrings([
    ...uniqueStrings(base.blockers),
    ...(selectedEvaluation?.blocking_findings ?? []).map((finding) => finding.code),
  ]);
  const contract = deriveHandoffContract({
    from: sessionId,
    to: base.to || 'next-session',
    activeContextId: snapshot.binding?.active_context_id,
    taskId: selectedContract?.task_id || '',
    taskContractId: selectedContract?.contract_id || '',
    artifacts: (snapshot.artifact_results ?? []).filter((item) => item.satisfied).map((item) => item.name),
    evidence: snapshot.evidence_envelope_id ? [snapshot.evidence_envelope_id] : [],
    decisions: base.decisions,
    nextActions: base.next_actions,
    blockers,
    tddAttestationIds: (snapshot.tdd_attestations ?? [])
      .filter((attestation) => ['green-observed', 'waived'].includes(attestation.state))
      .map((attestation) => attestation.attestation_id),
    headSha: snapshot.binding?.head_sha,
    tasksSha256: snapshot.binding?.tasks_sha256,
    specSha256: snapshot.binding?.effective_spec_sha256,
  });
  assertStructuredHandoffForProfile(profile, contract);
  return {
    ...base,
    tasks_hash: snapshot.binding.tasks_sha256,
    spec_hash: snapshot.binding.effective_spec_sha256,
    handoff_contract: contract,
  };
}
