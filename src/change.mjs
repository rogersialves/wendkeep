// `wendkeep change <sub>` — native change lifecycle CLI (Pilar B).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, cpSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync,
  readdirSync, rmSync, unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  newChange,
  useChange,
  continueChange,
  activeChange,
  clearActiveChange,
  allChangesState,
  listChanges,
  renderOpenChanges,
  parseTasks,
  setTaskDone,
  archiveSourceDigest,
  finalizeArchiveTransaction,
  inspectArchiveRecovery,
  pendingArchiveRecovery,
  abandonChange,
  relinkChanges,
  backfillArtifactLinks,
  scaffoldPlaceholders,
  isGuideCompactChange,
  healSpecBacklinks,
  setActiveChange,
} from '../hooks/change-core.mjs';
import { evaluateGate, loadSensorsDetailed, requiredSensors } from '../hooks/sensors-core.mjs';
import { buildEffectiveRequirementPackage, buildSpecPromotionPlan, contentHashOf, evaluateVerdict, formatOrphanReqs, tasksHashOf, parseSpecsList, parseDelta, parseRequirements, applyDelta, renderSpec, renderSpecsReadme, validateSpecImpact, assertSpecPromotionTargetsSafe, discoverSpecDeltas } from '../hooks/spec-core.mjs';
import { getNextAdrNumber, monthFolderRelFromDateStr, readControl, readSessionRegistry, upsertSessionRegistry, wikilinkFromRel } from '../hooks/obsidian-common.mjs';
import { getLocale } from '../hooks/locale.mjs';
import { enqueueObserverDocumentChange } from './observer-sql-publish.mjs';
import { readProjectForValidation } from '../packages/vault/src/validate-memory.mjs';
import { resolveCommandActiveContext } from './active-context-runtime.mjs';
import {
  captureGitSnapshot,
  resolveEvidenceIdentity,
  sensorConfigSha256,
} from './evidence-envelope.mjs';
import {
  canonicalSha256,
  evaluateEvidenceBinding,
  evidenceCheckoutBinding,
  evidenceCheckoutBindingMatches,
  evidenceSensors,
} from '../packages/vault/src/evidence-envelope.mjs';
import {
  classifyEvidenceEnvelope,
  evaluateProvenanceGate,
} from './provenance-gate.mjs';
import {
  appendReceipt,
  createFileReceiptStore,
} from './receipt-ledger.mjs';
import { acquireArchiveOperationLock } from './archive-operation-lock.mjs';
import {
  assertVaultPathSafe, assertVaultPathsSafe, mkdirVaultPath, renameVaultPath,
  unlinkVaultFile, writeVaultFileAtomic, writeVaultFileSync,
} from '../hooks/vault-path-safety.mjs';

const ARCHIVE_DIR = '_arquivo';
const POINTER = '.brain/CURRENT_CHANGE.md';

function proofSchemaProblems(kind, proof) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return [`${kind} deve ser objeto JSON`];
  const problems = [];
  for (const field of ['slug', 'tasksHash', 'effectiveSpecHash', 'evidenceEnvelopeId']) {
    if (typeof proof[field] !== 'string' || !proof[field]) problems.push(`${field} ausente ou inválido`);
  }
  if (!proof.evidenceBinding || typeof proof.evidenceBinding !== 'object' || Array.isArray(proof.evidenceBinding)) {
    problems.push('evidenceBinding ausente ou inválido');
  }
  if (kind === 'package') {
    for (const field of ['requirements', 'tasks', 'sensors']) {
      if (!Array.isArray(proof[field])) problems.push(`${field} deve ser array`);
    }
  } else {
    if (typeof proof.ok !== 'boolean') problems.push('ok deve ser boolean');
    for (const field of ['coverage', 'notes']) {
      if (!Array.isArray(proof[field])) problems.push(`${field} deve ser array`);
    }
  }
  return problems;
}

function sameCanonical(left, right) {
  return canonicalSha256(left) === canonicalSha256(right);
}

function provenanceAssessment(kind, proof, evidence, expected, contract = {}) {
  if (!proof) {
    return {
      kind,
      ok: false,
      state: 'unproven',
      reasonCodes: ['PROV_REQUIRED_ASSESSMENT_MISSING'],
      diagnostics: [{ kind, state: 'unproven', blocker: `${kind} missing` }],
      receipts: [],
    };
  }
  const schemaProblems = proofSchemaProblems(kind, proof);
  if (schemaProblems.length) {
    return {
      kind,
      ok: false,
      state: 'unproven',
      reasonCodes: [`PROV_${kind === 'package' ? 'PACKAGE' : 'VERDICT'}_SCHEMA_INVALID`],
      diagnostics: schemaProblems.map((blocker) => ({ kind, state: 'unproven', blocker })),
      receipts: [],
    };
  }
  const normalizedProof = {
    ...proof,
    change_slug: proof.slug || proof.change || proof.change_slug,
    ...(proof.evidenceBinding && typeof proof.evidenceBinding === 'object' ? proof.evidenceBinding : {}),
    ...(proof.tasksHash ? { tasks_sha256: proof.tasksHash } : {}),
    ...(proof.effectiveSpecHash ? {
      effective_spec_sha256: String(proof.effectiveSpecHash).startsWith('sha256:')
        ? proof.effectiveSpecHash
        : `sha256:${proof.effectiveSpecHash}`,
    } : {}),
  };
  const result = classifyEvidenceEnvelope({
    evidence,
    expected,
    ...(kind === 'package' ? { verification: normalizedProof } : { verdict: normalizedProof }),
  });
  const reasonCodes = [...(result.reasonCodes || [])];
  const diagnostics = [...(result.diagnostics || [])];
  const conflicts = [];
  const stale = [];
  if (contract.slug && proof.slug !== contract.slug) conflicts.push('slug mismatch');
  if (proof.change != null && proof.change !== contract.slug) conflicts.push('change mismatch');
  if (proof.change_slug != null && proof.change_slug !== contract.slug) conflicts.push('change_slug mismatch');
  if (contract.tasksHash !== undefined && proof.tasksHash !== contract.tasksHash) stale.push('tasksHash mismatch');
  if (contract.effectiveSpecHash !== undefined && proof.effectiveSpecHash !== contract.effectiveSpecHash) stale.push('effectiveSpecHash mismatch');
  if (kind === 'package') {
    for (const field of ['requirements', 'tasks', 'sensors']) {
      if (!sameCanonical(proof[field], contract[field])) stale.push(`${field} mismatch`);
    }
  }
  if (evidence?.schema_version === 2 && proof.evidenceEnvelopeId !== evidence.envelope_id) {
    reasonCodes.push('WENDKEEP_PROVENANCE_BINDING_CONFLICT');
    diagnostics.push({ kind, state: 'conflict', blocker: 'evidence envelope id mismatch' });
  }
  if (evidence?.schema_version === 2
    && !evidenceCheckoutBindingMatches(proof.evidenceBinding, evidenceCheckoutBinding(evidence))) {
    reasonCodes.push('WENDKEEP_PROVENANCE_BINDING_CONFLICT');
    diagnostics.push({ kind, state: 'conflict', blocker: 'evidence checkout binding mismatch' });
  }
  if (conflicts.length) {
    reasonCodes.push('WENDKEEP_PROVENANCE_BINDING_CONFLICT');
    diagnostics.push(...conflicts.map((blocker) => ({ kind, state: 'conflict', blocker })));
  }
  if (reasonCodes.includes('WENDKEEP_PROVENANCE_BINDING_CONFLICT')) {
    return { ...result, kind, ok: false, state: 'conflict', reasonCodes: [...new Set(reasonCodes)], diagnostics };
  }
  if (stale.length) {
    return {
      ...result,
      kind,
      ok: false,
      state: 'stale',
      reasonCodes: [...new Set([...reasonCodes, 'WENDKEEP_PROVENANCE_STALE'])],
      diagnostics: [...diagnostics, ...stale.map((blocker) => ({ kind, state: 'stale', blocker }))],
    };
  }
  return { ...result, kind };
}

function provenanceBlock(assessment) {
  const code = assessment?.code || 'WENDKEEP_PROVENANCE_GATE_BLOCKED';
  const codes = [...new Set(assessment?.reasonCodes || [])];
  const diagnostics = (assessment?.diagnostics || [])
    .map((item) => item?.blocker || item?.reason || item?.message)
    .filter(Boolean);
  const repair = assessment?.repair?.command ? `recuperação: ${assessment.repair.command}` : '';
  return `${code}: operation=archive; state=${assessment?.state || 'unproven'}${codes.length ? `; reason_codes=${codes.join(',')}` : ''}${diagnostics.length ? `; ${diagnostics.join('; ')}` : ''}${repair ? `; ${repair}` : ''}`;
}

function archiveRepair(slug) {
  return {
    command: `wendkeep verify --deep --change ${slug}`,
    explanation: `Recapture package, verdict e evidência fresca para ${slug} antes de arquivar.`,
  };
}

function archiveRetryRepair(slug) {
  return {
    command: `wendkeep change archive ${slug}`,
    explanation: 'Aguarde o owner ativo concluir e tente o archive novamente.',
  };
}

function archiveManualRecovery(slug, published = false, { operationId = null, phase = null } = {}) {
  return {
    command: operationId ? `wendkeep change archive recover ${operationId} --change ${slug}` : null,
    mode: 'manual',
    operation_id: operationId,
    transaction_phase: phase,
    actions: published
      ? ['preserve-published-archive', 'inspect-journal-by-operation-id', 'reconcile-spec-adr-pointer', 'retry-only-after-reconciliation']
      : ['preserve-open-change', 'inspect-journal-by-operation-id', 'reconcile-retained-original', 'retry-only-after-reconciliation'],
    explanation: published
      ? `Publicação de ${slug} requer reconciliação manual antes de qualquer retry.`
      : `Reconcilie a change aberta e o original retido de ${slug} antes de tentar novamente.`,
  };
}

function sanitizeArchiveText(value) {
  return String(value || '')
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi, 'Authorization: Bearer [redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(?:token|secret|password|authorization|bearer|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:ghp_[A-Za-z0-9_]+|npm_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[redacted]')
    .replace(/\\\\[^\\\s,;]+\\[^\s,;]+/g, '[private-path]')
    .replace(/[A-Za-z]:\\[^,;\r\n]+/g, '[private-path]')
    .replace(/\/(?:Users|home)\/[^,;\r\n]+/g, '[private-path]')
    .replace(/(^|[\s(])\/(?:[^\s,;:)]+\/)+[^\s,;:)]+/g, '$1[private-path]')
    .replace(/\(ex\.:\s*[^)]+\)/gi, '(detalhe omitido)')
    .replace(/scaffold não preenchido\s*\([^)]+\)/gi, 'scaffold não preenchido')
    .slice(0, 320);
}

function sanitizeArchiveValue(value, depth = 0) {
  if (depth > 3) return '[bounded]';
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return sanitizeArchiveText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeArchiveValue(item, depth + 1));
  if (typeof value !== 'object') return sanitizeArchiveText(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|authorization|private|content|output|path/i.test(key)) continue;
    output[key] = sanitizeArchiveValue(item, depth + 1);
  }
  return output;
}

function archiveJsonFailure(slug, assessment, failing = []) {
  const current = assessment || {
    state: 'unproven',
    reasonCodes: ['WENDKEEP_ARCHIVE_GATE_BLOCKED'],
    diagnostics: failing.map((blocker) => ({ kind: 'archive', state: 'unproven', blocker })),
  };
  const diagnostics = (current.diagnostics || []).map((item) => sanitizeArchiveValue(item));
  const first = diagnostics[0] || {};
  const blocker = sanitizeArchiveText(first.blocker || first.reason || first.message
    || current.reasonCodes?.[0] || 'WENDKEEP_ARCHIVE_GATE_BLOCKED');
  const rawRepair = current.repair || archiveRepair(slug);
  const repair = sanitizeArchiveValue(rawRepair);
  const recovery = sanitizeArchiveText(current.recovery
    || rawRepair.command
    || rawRepair.explanation
    || archiveRepair(slug).command);
  return {
    ok: false,
    code: current.code || 'WENDKEEP_PROVENANCE_GATE_BLOCKED',
    operation: 'archive',
    state: current.state || 'unproven',
    reason_codes: [...new Set(current.reasonCodes || [])],
    blocker,
    expected: sanitizeArchiveValue(first.expected ?? null),
    observed: sanitizeArchiveValue(first.observed ?? null),
    recovery,
    diagnostics,
    repair,
  };
}

function archiveFailureText(payload) {
  return `${payload.code}: operation=${payload.operation}; state=${payload.state}; blocker=${payload.blocker}; expected=${JSON.stringify(payload.expected)}; observed=${JSON.stringify(payload.observed)}; recovery=${payload.recovery}; reason_codes=${JSON.stringify(payload.reason_codes)}; diagnostics=${JSON.stringify(payload.diagnostics)}; repair=${JSON.stringify(payload.repair)}`;
}

function archiveRuntimeRoot(projectRoot) {
  const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const commonDir = isAbsolute(raw) ? raw : resolve(projectRoot, raw);
  return join(commonDir, 'wendkeep');
}

function archiveReceiptStore(projectRoot) {
  const runtime = archiveRuntimeRoot(projectRoot);
  return createFileReceiptStore({
    ledgerPath: join(runtime, 'change-archive-receipts-v2.jsonl'),
    checkpointPath: join(runtime, 'change-archive-receipts-v2.checkpoint.json'),
    legacyPath: join(runtime, 'change-archive-receipts-v1.jsonl'),
    lockPath: join(runtime, 'change-archive-receipts-v2.lock'),
  });
}

function appendArchiveAuthorization({ projectRoot, slug, expected, contract, evidence, verification, verdict, required, reqIds, forced }) {
  const identity = expected.identity || {};
  const snapshot = expected.snapshot || {};
  return appendReceipt({
    store: archiveReceiptStore(projectRoot),
    draft: {
      kind: 'change-archive-authorization',
      subject: {
        operation: 'archive',
        outcome: 'authorized',
        change_slug: slug,
        project_id: identity.project_id,
        repository_id: identity.repository_id,
        worktree_id: identity.worktree_id,
        work_session_id: identity.work_session_id,
        branch: snapshot.branch,
        head_sha: snapshot.head_sha,
        index_tree_sha: snapshot.index_tree_sha,
        worktree_digest: snapshot.worktree_digest,
        tasks_sha256: contract.tasksHash,
        effective_spec_sha256: contract.effectiveSpecHash,
        evidence_envelope_id: evidence.envelope_id,
      },
      claims: {
        forced,
        requirements: reqIds,
        required_sensors: required,
      },
      observations: {
        package_sha256: canonicalSha256(verification),
        verdict_sha256: canonicalSha256(verdict),
      },
      recorded_at: new Date().toISOString(),
    },
  });
}

function archiveContract({ slug, tarefasMd, tasks, effective, sensorEvidence }) {
  return {
    slug,
    tasksHash: tasksHashOf(tarefasMd),
    effectiveSpecHash: effective.hash,
    requirements: effective.requirements.map((req) => ({
      id: req.id,
      name: req.name,
      capability: req.capability,
      operation: req.operation,
      source: req.source,
      body: req.body,
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      text: task.text,
      req: task.req || null,
      reqs: task.reqs || [],
      done: task.done,
    })),
    sensors: sensorEvidence,
  };
}

function recaptureArchiveAuthorization({
  dir, vaultBase, projectRoot, slug, sessionId, selectedContext, forced, authorized,
}) {
  if (!authorized) return { ok: false, failing: ['PROV_ARCHIVE_AUTHORIZATION_MISSING'] };
  try {
    const placeholders = scaffoldPlaceholders(dir);
    const impact = validateSpecImpact(dir);
    const tarefasMd = readFileSync(join(dir, 'tarefas.md'), 'utf8');
    const tasks = parseTasks(tarefasMd);
    const required = requiredSensors(tasks);
    const reqIds = [...new Set(tasks.flatMap((task) => task.reqs ?? []))];
    const effective = buildEffectiveRequirementPackage(vaultBase, dir, reqIds);
    const loaded = loadSensorsDetailed(projectRoot);
    const identity = resolveEvidenceIdentity({
      vaultBase, projectRoot, changeSlug: slug, sessionId, context: selectedContext,
    });
    const snapshot = captureGitSnapshot(projectRoot);
    const evidence = JSON.parse(readFileSync(join(dir, 'evidencia.json'), 'utf8'));
    const verification = JSON.parse(readFileSync(join(dir, 'verificacao.json'), 'utf8'));
    const verdict = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8'));
    const stable = placeholders.length === 0
      && impact.ok
      && (forced || !tasks.some((task) => !task.done))
      && effective.errors.length === 0
      && effective.missing.length === 0
      && sameCanonical(reqIds, authorized.reqIds)
      && sameCanonical(required, authorized.required)
      && tasksHashOf(tarefasMd) === authorized.contract.tasksHash
      && effective.hash === authorized.contract.effectiveSpecHash
      && sensorConfigSha256(loaded.sensors, required) === authorized.expected.sensor_config_sha256
      && sameCanonical(identity, authorized.expected.identity)
      && sameCanonical(snapshot, authorized.expected.snapshot)
      && sameCanonical(evidence, authorized.evidence)
      && sameCanonical(verification, authorized.verification)
      && sameCanonical(verdict, authorized.verdict);
    return stable
      ? { ok: true, failing: [] }
      : { ok: false, failing: ['PROV_ARCHIVE_INPUT_CHANGED'] };
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code : 'PROV_ARCHIVE_FINAL_SNAPSHOT_FAILED';
    return { ok: false, failing: [code] };
  }
}

function observerMarkdownUnder(vaultBase, relativeRoot) {
  const output = [];
  const walk = (absolute, relative) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const nextAbsolute = join(absolute, entry.name);
      const nextRelative = join(relative, entry.name);
      if (entry.isDirectory()) walk(nextAbsolute, nextRelative);
      else if (entry.isFile() && entry.name.endsWith('.md')) output.push(nextRelative);
    }
  };
  try { walk(join(vaultBase, relativeRoot), relativeRoot); } catch { /* reconcile recupera */ }
  return output;
}

function resolveVault(argv) {
  let vault;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') vault = argv[++i];
    else if (a.startsWith('--vault=')) vault = a.slice(8);
  }
  const base = vault || process.env.OBSIDIAN_VAULT_PATH;
  if (!base) {
    process.stderr.write('wendkeep change: no vault. Pass --vault <path> or set OBSIDIAN_VAULT_PATH.\n');
    process.exit(2);
  }
  return isAbsolute(base) ? base : resolve(process.cwd(), base);
}

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function allVaultMarkdown(vaultBase, { excludeRoots = [] } = {}) {
  const out = [];
  const skip = new Set(['.git', '.obsidian', 'node_modules']);
  const excluded = (target) => excludeRoots.some((root) => {
    const rel = relative(root, target);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  });
  const walk = (dir) => {
    if (excluded(dir)) return;
    try {
      assertVaultPathSafe(vaultBase, dir, {
        allowMissing: false, expectedType: 'directory', label: 'diretório varrido para wikilinks',
      });
    } catch { return; }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.brain') continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.md')) out.push(abs);
    }
  };
  walk(vaultBase);
  return out;
}

// Reescreve `[[fromRel/...]]`, `[[fromRel]]` e `[[fromRel|alias]]` em todo o vault.
// NUNCA por basename: `proposta`/`design` existem em toda change — só full-path é seguro.
function rewriteChangeLinks(vaultBase, fromRel, toRel, options = {}) {
  let touched = 0;
  for (const abs of allVaultMarkdown(vaultBase, options)) {
    let content;
    try { content = readFileSync(abs, 'utf8'); } catch { continue; }
    const next = content
      .split(`[[${fromRel}/`).join(`[[${toRel}/`)
      .split(`[[${fromRel}]]`).join(`[[${toRel}]]`)
      .split(`[[${fromRel}|`).join(`[[${toRel}|`);
    if (next !== content) {
      try {
        writeVaultFileSync(vaultBase, abs, next, 'utf8', { label: 'nota com wikilink reescrito' });
        touched += 1;
      } catch { /* nota readonly/unsafe — segue */ }
    }
  }
  return touched;
}

function decodePromotionImage(image) {
  const content = Buffer.from(String(image?.content_base64 || ''), 'base64').toString('utf8');
  if (image?.digest !== `sha256:${contentHashOf(content)}` || typeof image?.exists !== 'boolean') {
    const error = new Error('imagem de promoção inválida');
    error.code = 'PROV_SPEC_PROMOTION_PLAN_INVALID';
    throw error;
  }
  return { exists: image.exists, content };
}

function validateArchiveSpecPromotionPlan(vaultBase, manifest, {
  operationId,
  slug,
  transactionRoot,
}) {
  const invalid = () => {
    const error = new Error('plano de promoção não corresponde ao archive autorizado');
    error.code = 'PROV_SPEC_PROMOTION_PLAN_INVALID';
    throw error;
  };
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  const digestPattern = /^sha256:[a-f0-9]{64}$/;
  const decodeImage = (image) => {
    if (!exactKeys(image, ['exists', 'content_base64', 'digest'])
      || typeof image.exists !== 'boolean'
      || typeof image.content_base64 !== 'string'
      || !digestPattern.test(image.digest)) invalid();
    const bytes = Buffer.from(image.content_base64, 'base64');
    const content = bytes.toString('utf8');
    if (bytes.toString('base64') !== image.content_base64
      || image.digest !== `sha256:${contentHashOf(content)}`
      || (!image.exists && bytes.length !== 0)) invalid();
    return content;
  };
  const plan = manifest?.spec_promotion_plan;
  if (!exactKeys(plan, ['schema_version', 'entries', 'changes'])
    || plan.schema_version !== 1 || !Array.isArray(plan.entries) || !Array.isArray(plan.changes)) invalid();

  const loc = getLocale(vaultBase);
  const normalizedDestination = String(manifest.destination_rel || '').replaceAll('\\', '/');
  const archivePrefix = `${loc.folders.changes}/_arquivo/`;
  const destinationName = normalizedDestination.slice(archivePrefix.length);
  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (normalizedDestination !== manifest.destination_rel
    || !normalizedDestination.startsWith(archivePrefix)
    || !new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapedSlug}$`).test(destinationName)) invalid();
  const destination = assertVaultPathSafe(vaultBase, join(vaultBase, normalizedDestination), {
    allowMissing: false, expectedType: 'directory', label: 'archive autorizado para recovery de specs',
  }).target;
  if (!digestPattern.test(manifest.destination_digest || '')
    || archiveSourceDigest(destination) !== manifest.destination_digest) invalid();
  const capabilities = discoverSpecDeltas(destination);
  if (!capabilities.length || capabilities.some((capability) => (
    typeof capability !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(capability)
    || capability.normalize('NFC') !== capability
    || /^README$/i.test(capability)
  )) || new Set(capabilities).size !== capabilities.length) invalid();

  let baseline;
  try { baseline = JSON.parse(readFileSync(join(destination, '.spec-base.json'), 'utf8')); }
  catch { invalid(); }
  if (baseline?.version !== 1 || !baseline.specs || typeof baseline.specs !== 'object'
    || Array.isArray(baseline.specs)) invalid();

  if (plan.entries.length !== capabilities.length + 2) invalid();
  const capabilityEntries = plan.entries.slice(0, capabilities.length);
  const stateEntry = plan.entries[capabilities.length];
  const readmeEntry = plan.entries[capabilities.length + 1];
  const plannedCapabilities = capabilityEntries.map((entry) => entry?.capability);
  if (JSON.stringify([...plannedCapabilities].sort()) !== JSON.stringify([...capabilities].sort())
    || new Set(plannedCapabilities).size !== plannedCapabilities.length
    || stateEntry?.kind !== 'state' || stateEntry?.capability !== null
    || readmeEntry?.kind !== 'readme' || readmeEntry?.capability !== null) invalid();

  const transactionRel = relative(vaultBase, transactionRoot).replaceAll('\\', '/');
  const escapedTransaction = transactionRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const seenPhysicalPaths = new Set();
  const validateEntryEnvelope = (entry, index, expectedKind, expectedCapability, expectedTarget) => {
    if (!exactKeys(entry, [
      'kind', 'capability', 'target', 'claim_target', 'candidate_target', 'before', 'after',
    ]) || entry.kind !== expectedKind || entry.capability !== expectedCapability
      || entry.target !== expectedTarget.replaceAll('\\', '/')
      || !new RegExp(`^${escapedTransaction}/${index}-${uuid}\\.before$`, 'i').test(entry.claim_target)
      || !new RegExp(`^${escapedTransaction}/${index}-${uuid}\\.candidate$`, 'i').test(entry.candidate_target)
      || seenPhysicalPaths.has(entry.claim_target) || seenPhysicalPaths.has(entry.candidate_target)
      || entry.claim_target === entry.candidate_target) invalid();
    seenPhysicalPaths.add(entry.claim_target);
    seenPhysicalPaths.add(entry.candidate_target);
    return { before: decodeImage(entry.before), after: decodeImage(entry.after) };
  };

  const dateStr = destinationName.slice(0, 10);
  const changeWikilink = wikilinkFromRel(join(normalizedDestination, 'proposta'));
  const logicalChanges = [];
  const expectedSpecs = {};
  for (let index = 0; index < capabilityEntries.length; index += 1) {
    const entry = capabilityEntries[index];
    const capability = entry.capability;
    const expectedTarget = join(loc.folders.specs, `${capability}.md`);
    const images = validateEntryEnvelope(entry, index, 'capability', capability, expectedTarget);
    const baselineSpec = baseline.specs[capability];
    if (baselineSpec) {
      if (!entry.before.exists || entry.before.digest !== `sha256:${baselineSpec.hash}`) invalid();
    } else if (entry.before.exists || entry.before.digest !== `sha256:${contentHashOf('')}`) invalid();
    let delta;
    try { delta = parseDelta(readFileSync(join(destination, 'specs', capability, 'spec.md'), 'utf8')); }
    catch { invalid(); }
    const applied = applyDelta(parseRequirements(images.before), delta);
    const footer = `Atualizado por ${changeWikilink} em ${dateStr}.`;
    const expectedAfter = renderSpec(capability, applied.reqs, { footer, reqHeading: loc.reqHeading });
    if (!entry.after.exists || images.after !== expectedAfter) invalid();
    expectedSpecs[capability] = {
      hash: contentHashOf(expectedAfter),
      requirements: Object.fromEntries(parseRequirements(expectedAfter)
        .map((requirement) => [requirement.id || requirement.name, contentHashOf(JSON.stringify(requirement))])),
    };
    logicalChanges.push({
      capability,
      before_digest: entry.before.digest,
      after_digest: entry.after.digest,
    });
  }

  const stateImages = validateEntryEnvelope(
    stateEntry, capabilities.length, 'state', null, '.brain/SPECS_STATE.json',
  );
  let beforeState = null;
  let afterState;
  try {
    beforeState = stateEntry.before.exists ? JSON.parse(stateImages.before) : null;
    afterState = JSON.parse(stateImages.after);
  } catch { invalid(); }
  if ((beforeState && (beforeState.version !== 1 || !beforeState.specs || typeof beforeState.specs !== 'object'))
    || afterState?.version !== 1 || !afterState.specs || typeof afterState.specs !== 'object'
    || typeof afterState.generatedAt !== 'string' || Number.isNaN(Date.parse(afterState.generatedAt))) invalid();
  const expectedStateSpecs = { ...((beforeState?.specs) || baseline.specs), ...expectedSpecs };
  if (JSON.stringify(afterState.specs) !== JSON.stringify(expectedStateSpecs)) invalid();

  const readmeImages = validateEntryEnvelope(
    readmeEntry, capabilities.length + 1, 'readme', null, join(loc.folders.specs, 'README.md'),
  );
  const canonicalReadme = renderSpecsReadme(vaultBase);
  if (!readmeEntry.after.exists || readmeImages.after !== canonicalReadme
    || (readmeEntry.before.exists
      ? readmeImages.before !== canonicalReadme
      : readmeEntry.before.digest !== `sha256:${contentHashOf('')}`)) invalid();

  if (plan.changes.length !== logicalChanges.length
    || plan.changes.some((change, index) => !exactKeys(change, [
      'capability', 'before_digest', 'after_digest',
    ]) || JSON.stringify(change) !== JSON.stringify(logicalChanges[index]))
    || !Array.isArray(manifest.spec_changes)
    || JSON.stringify(manifest.spec_changes) !== JSON.stringify(logicalChanges)) invalid();
  return { plan, logicalChanges };
}

function applySpecPromotionPlan(vaultBase, plan, {
  action,
  faultInjection = {},
  assertOperationLock,
} = {}) {
  if (plan?.schema_version !== 1 || !Array.isArray(plan.entries)
    || !['resume', 'rollback'].includes(action)
    || typeof assertOperationLock !== 'function') {
    const error = new Error('plano de promoção inválido');
    error.code = 'PROV_SPEC_PROMOTION_PLAN_INVALID';
    throw error;
  }
  const entries = action === 'rollback' ? [...plan.entries].reverse() : plan.entries;
  for (let index = 0; index < entries.length; index += 1) {
    assertOperationLock();
    const entry = entries[index];
    if (!['capability', 'state', 'readme'].includes(entry?.kind)
      || typeof entry.target !== 'string' || !entry.target
      || typeof entry.claim_target !== 'string' || !entry.claim_target
      || typeof entry.candidate_target !== 'string' || !entry.candidate_target) {
      const error = new Error('target de promoção inválido');
      error.code = 'PROV_SPEC_PROMOTION_PLAN_INVALID';
      throw error;
    }
    const rawTarget = join(vaultBase, entry.target);
    const rawCandidate = join(vaultBase, entry.candidate_target);
    assertVaultPathSafe(vaultBase, dirname(rawTarget), {
      allowMissing: false, expectedType: 'directory', label: 'ancestral do target de promoção',
    });
    assertVaultPathSafe(vaultBase, dirname(rawCandidate), {
      expectedType: 'directory', label: 'ancestral do candidate de promoção',
    });
    if (existsSync(rawCandidate) && existsSync(rawTarget)) {
      const candidateStat = lstatSync(rawCandidate);
      const targetStat = lstatSync(rawTarget);
      if (!candidateStat.isFile() || !targetStat.isFile()
        || candidateStat.dev !== targetStat.dev || candidateStat.ino !== targetStat.ino) {
        const error = new Error('candidate órfão divergiu do target');
        error.code = 'PROV_SPEC_PROMOTION_RECOVERY_CONFLICT';
        throw error;
      }
      assertOperationLock();
      unlinkSync(rawCandidate);
      assertOperationLock();
    }
    const target = assertVaultPathSafe(vaultBase, rawTarget, {
      expectedType: 'file', label: 'target do plano de promoção',
    }).target;
    const selected = decodePromotionImage(action === 'resume' ? entry.after : entry.before);
    const claim = assertVaultPathSafe(vaultBase, join(vaultBase, entry.claim_target), {
      expectedType: 'file', label: 'claim do plano de promoção',
    }).target;
    const candidate = assertVaultPathSafe(vaultBase, join(vaultBase, entry.candidate_target), {
      expectedType: 'file', label: 'candidate do plano de promoção',
    }).target;
    const observed = (path) => {
      const exists = existsSync(path);
      const content = exists ? readFileSync(path, 'utf8') : '';
      return { exists, content, digest: `sha256:${contentHashOf(content)}` };
    };
    const matchesImage = (value, image) => value.exists === image.exists && value.digest === image.digest;
    mkdirVaultPath(vaultBase, dirname(target), { label: 'ancestral do plano de promoção' });
    mkdirVaultPath(vaultBase, dirname(claim), { label: 'retenção do plano de promoção' });
    let claimed = observed(claim);
    let current = observed(target);
    if (claimed.exists) {
      if (!matchesImage(claimed, entry.before) && !matchesImage(claimed, entry.after)) {
        const error = new Error('claim de promoção divergiu');
        error.code = 'PROV_SPEC_PROMOTION_RECOVERY_CONFLICT';
        throw error;
      }
      if (matchesImage(current, action === 'resume' ? entry.after : entry.before)) {
        continue;
      }
      if (current.exists) {
        if (!matchesImage(current, entry.before) && !matchesImage(current, entry.after)) {
          const error = new Error('writer concorrente ocupa target de promoção');
          error.code = 'PROV_SPEC_PROMOTION_RECOVERY_CONFLICT';
          throw error;
        }
        const retained = join(dirname(claim), `retained-${randomUUID()}`);
        assertOperationLock();
        renameVaultPath(vaultBase, target, retained, {
          sourceType: 'file', label: 'geração anterior retida da promoção',
        });
        assertOperationLock();
      }
    } else {
      if (!matchesImage(current, entry.before) && !matchesImage(current, entry.after)) {
        const error = new Error('target mudou fora do plano de promoção');
        error.code = 'PROV_SPEC_PROMOTION_RECOVERY_CONFLICT';
        throw error;
      }
      if (current.exists) {
        assertOperationLock();
        renameVaultPath(vaultBase, target, claim, {
          sourceType: 'file', label: 'claim físico do target de promoção',
        });
        assertOperationLock();
        claimed = observed(claim);
        if (!matchesImage(claimed, entry.before) && !matchesImage(claimed, entry.after)) {
          if (!existsSync(target)) {
            assertOperationLock();
            renameVaultPath(vaultBase, claim, target, {
              sourceType: 'file', label: 'restaura writer capturado pelo claim de promoção',
            });
            assertOperationLock();
          }
          const error = new Error('writer venceu antes do claim de promoção');
          error.code = 'PROV_SPEC_PROMOTION_RECOVERY_CONFLICT';
          throw error;
        }
      }
    }
    faultInjection.beforeTargetCommit?.({ entry, index, action, target });
    if (selected.exists) {
      if (existsSync(candidate)) {
        const stale = observed(candidate);
        if (stale.digest !== (action === 'resume' ? entry.after.digest : entry.before.digest)) {
          const error = new Error('candidate de promoção divergiu');
          error.code = 'PROV_SPEC_PROMOTION_RECOVERY_CONFLICT';
          throw error;
        }
        assertOperationLock();
        unlinkVaultFile(vaultBase, candidate, { missingOk: false, label: 'candidate stale de promoção' });
        assertOperationLock();
      }
      assertOperationLock();
      writeVaultFileAtomic(vaultBase, candidate, selected.content, 'utf8', {
        label: `candidate ${action} de promoção de spec`,
      });
      assertOperationLock();
      try { linkSync(candidate, target); }
      catch (cause) {
        const error = new Error('target concorrente impediu commit de promoção');
        error.code = 'PROV_SPEC_PROMOTION_RECOVERY_CONFLICT';
        error.cause = cause;
        throw error;
      }
      assertOperationLock();
      faultInjection.afterCandidateLink?.({ entry, index, action, target, candidate });
      assertOperationLock();
      unlinkSync(candidate);
      assertOperationLock();
    }
    current = observed(target);
    if (!matchesImage(current, action === 'resume' ? entry.after : entry.before)) {
      const error = new Error('target divergiu após recovery de promoção');
      error.code = 'PROV_SPEC_PROMOTION_RECOVERY_DIVERGED';
      throw error;
    }
    if (existsSync(claim)) {
      const retainedClaim = observed(claim);
      if (!matchesImage(retainedClaim, entry.before) && !matchesImage(retainedClaim, entry.after)) {
        const error = new Error('writer por handle alterou geração retida');
        error.code = 'PROV_SPEC_PROMOTION_RECOVERY_CONFLICT';
        throw error;
      }
    }
    faultInjection.afterEntryWrite?.({ entry, index, action });
    if (entry.kind === 'capability') {
      faultInjection.afterCapabilityWrite?.({ capability: entry.capability, index });
    } else if (entry.kind === 'state') faultInjection.afterStateWrite?.();
    else if (entry.kind === 'readme') faultInjection.afterReadmeWrite?.();
    assertOperationLock();
  }
  return { action, changes: plan.changes || [] };
}

function promoteSpecsMutation(vaultBase, changeDir, specs, options = {}) {
  const {
    faultInjection = {}, assertOperationLock, prepared: preparedOption = null, ...planOptions
  } = options;
  const prepared = preparedOption || buildSpecPromotionPlan(vaultBase, changeDir, specs, planOptions);
  const { plan, promoted, warnings, changes } = prepared;
  faultInjection.beforeMutation?.(plan);
  try {
    mkdirVaultPath(vaultBase, join(vaultBase, getLocale(vaultBase).folders.specs), {
      label: 'raiz de specs consolidadas',
    });
    mkdirVaultPath(vaultBase, join(vaultBase, '.brain'), { label: 'raiz do estado de specs' });
    applySpecPromotionPlan(vaultBase, plan, { action: 'resume', faultInjection, assertOperationLock });
    return { promoted, warnings, changes, plan };
  } catch (cause) {
    let rollbackError = null;
    try { applySpecPromotionPlan(vaultBase, plan, { action: 'rollback', assertOperationLock }); }
    catch (error) { rollbackError = error; }
    const ownershipLost = cause?.code === 'WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST';
    const error = new Error(ownershipLost
      ? 'ownership do lock perdido durante promoção de specs'
      : 'promoção de specs falhou; before-images restauradas');
    error.code = ownershipLost ? cause.code : 'PROV_SPEC_PROMOTION_ATOMIC_FAILED';
    error.cause = cause;
    error.changes = changes;
    error.plan = plan;
    error.rollback_failed = Boolean(rollbackError);
    error.rollback_errors = rollbackError ? [rollbackError.code || 'ROLLBACK_FAILED'] : [];
    throw error;
  }
}

function recoverArchiveSpecPromotionUnderLock(vaultBase, {
  operationId,
  slug,
  action,
  assertOperationLock,
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(operationId || '')
    || !/^[a-z0-9][a-z0-9._-]*$/i.test(slug || '')
    || !['resume', 'rollback'].includes(action)) {
    const error = new Error('recovery de promoção inválido');
    error.code = 'PROV_ARCHIVE_RECOVERY_NOT_FOUND';
    throw error;
  }
  const transactionRoot = join(vaultBase, '.brain', 'runtime', 'archive-transactions', operationId);
  const manifestPath = assertVaultPathSafe(vaultBase, join(transactionRoot, 'archive-transaction.json'), {
    allowMissing: false, expectedType: 'file', label: 'manifest de recovery de specs',
  }).target;
  assertOperationLock();
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest?.schema_version !== 1 || manifest.operation !== 'archive'
    || manifest.operation_id !== operationId || manifest.change_slug !== slug
    || manifest.spec_promotion_plan?.schema_version !== 1) {
    const error = new Error('binding do recovery de specs inválido');
    error.code = 'PROV_ARCHIVE_RECOVERY_NOT_FOUND';
    throw error;
  }
  let validated;
  try {
    validated = validateArchiveSpecPromotionPlan(vaultBase, manifest, {
      operationId,
      slug,
      transactionRoot,
    });
  } catch {
    const error = new Error('plano de promoção inválido');
    error.code = 'PROV_SPEC_PROMOTION_PLAN_INVALID';
    throw error;
  }
  applySpecPromotionPlan(vaultBase, validated.plan, {
    action,
    assertOperationLock,
  });
  assertOperationLock();
  const next = {
    ...manifest,
    phase: 'recovery-required',
    blocker: 'PROV_ARCHIVE_RECOVERY_RECONCILIATION_REQUIRED',
    publication_state: 'published-recovery-required',
    spec_promotion_state: action === 'resume' ? 'resumed' : 'rolled-back',
  };
  writeVaultFileAtomic(vaultBase, manifestPath, `${JSON.stringify(next)}\n`, 'utf8', {
    label: 'manifest após recovery de specs', scopeRoot: transactionRoot,
  });
  const fd = openSync(manifestPath, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  assertOperationLock();
  return {
    ok: false,
    code: 'PROV_ARCHIVE_RECOVERY_RECONCILIATION_REQUIRED',
    operation: 'archive-recover',
    state: 'conflict',
    operation_id: operationId,
    change_slug: slug,
    transaction_phase: 'recovery-required',
    original_retained: existsSync(join(transactionRoot, 'original')),
    publication_state: 'published-recovery-required',
    spec_promotion_state: next.spec_promotion_state,
    actions: [
      `${action}-spec-promotion-complete`,
      'reconcile-spec-adr-pointer',
      'retry-only-after-reconciliation',
    ],
  };
}

function recoverArchiveSpecPromotionMutation(vaultBase, { operationId, slug, action }) {
  const lock = acquireArchiveOperationLock({
    lockPath: join(vaultBase, '.brain', 'runtime', 'change-archive-operation.lock'),
  });
  try {
    return recoverArchiveSpecPromotionUnderLock(vaultBase, {
      operationId,
      slug,
      action,
      assertOperationLock: () => lock.assertOwned(),
    });
  } finally {
    lock.release();
  }
}

function archiveChangeMutation(vaultBase, slug, options = {}) {
  const {
    gate,
    preMutate,
    assertOperationLock,
    authorizationEnvelope,
    faultInjection = {},
    dateStr, adrNum, adrFlags = {}, context,
  } = options;
  if (![gate, preMutate, assertOperationLock, authorizationEnvelope].every((entry) => typeof entry === 'function')) {
    return { ok: false, failing: ['PROV_ARCHIVE_AUTHORIZATION_REQUIRED'] };
  }
  const existingRecovery = pendingArchiveRecovery(vaultBase, slug);
  if (existingRecovery) {
    return {
      ok: false,
      failing: [existingRecovery.invalid
        ? 'PROV_ARCHIVE_RECOVERY_JOURNAL_INVALID'
        : 'PROV_ARCHIVE_RECOVERY_REQUIRED'],
      recovery: existingRecovery,
    };
  }
  const loc = getLocale(vaultBase);
  const chDir = loc.folders.changes;
  const src = join(vaultBase, chDir, slug);
  const createAdr = !isGuideCompactChange(src);
  const operationFailureCode = (error, fallback) => (
    typeof error?.code === 'string' && /^(?:WENDKEEP|PROV|VAULT)_[A-Z0-9_]+$/.test(error.code)
      ? error.code : fallback
  );
  let verdict;
  try {
    assertOperationLock();
    verdict = gate(src);
    assertOperationLock();
  } catch (error) {
    return { ok: false, failing: [operationFailureCode(error, 'WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST')] };
  }
  if (!verdict.ok) return { ok: false, failing: verdict.failing || [] };
  let authorizedEnvelope;
  let authorizedEnvelopeJson;
  try {
    authorizedEnvelope = authorizationEnvelope();
    if (authorizedEnvelope?.schema_version !== 2
      || authorizedEnvelope.purpose !== 'archive'
      || authorizedEnvelope.change_slug !== slug
      || !authorizedEnvelope.authorization || typeof authorizedEnvelope.authorization !== 'object') {
      return { ok: false, failing: ['PROV_ARCHIVE_AUTHORIZATION_REQUIRED'] };
    }
    authorizedEnvelopeJson = JSON.stringify(authorizedEnvelope);
  } catch {
    return { ok: false, failing: ['PROV_ARCHIVE_AUTHORIZATION_REQUIRED'] };
  }

  const destRel = join(chDir, ARCHIVE_DIR, `${dateStr}-${slug}`);
  const destAbs = join(vaultBase, destRel);
  const changeWikilink = wikilinkFromRel(join(destRel, 'proposta'));
  const archiveRoot = join(vaultBase, chDir, ARCHIVE_DIR);
  const adrDirRel = monthFolderRelFromDateStr(loc.folders.decisions, dateStr, vaultBase);
  const num = String(adrNum).padStart(4, '0');
  const adrRel = join(adrDirRel, `ADR-${num}-${slug}.md`);

  // Validate every later mutation target before spec promotion can change living state.
  const mutationTargets = [
    { path: src, allowMissing: false, expectedType: 'directory', label: 'change a arquivar' },
    { path: destAbs, expectedType: 'directory', label: 'destino da change arquivada' },
    { path: archiveRoot, expectedType: 'directory', label: 'raiz de changes arquivadas' },
    { path: join(vaultBase, POINTER), expectedType: 'file', label: 'ponteiro CURRENT_CHANGE.md' },
    ...(createAdr ? [
      { path: join(vaultBase, adrDirRel), expectedType: 'directory', label: 'pasta mensal de ADR' },
      { path: join(vaultBase, adrRel), expectedType: 'file', label: 'ADR da change arquivada' },
    ] : []),
  ];
  const transactionId = randomUUID();
  const transactionsRoot = join(vaultBase, '.brain', 'runtime', 'archive-transactions');
  const transactionRoot = join(transactionsRoot, transactionId);
  const quarantineAbs = join(transactionRoot, 'original');
  const snapshotAbs = join(transactionRoot, 'authorized');
  const manifestAbs = join(transactionRoot, 'archive-transaction.json');
  mutationTargets.push(
    { path: quarantineAbs, expectedType: 'directory', label: 'quarentena causal do archive' },
    { path: snapshotAbs, expectedType: 'directory', label: 'snapshot autorizado do archive' },
    { path: manifestAbs, expectedType: 'file', label: 'manifest da transação de archive' },
  );
  const checkedMutationTargets = assertVaultPathsSafe(vaultBase, mutationTargets);
  const [checkedSource, checkedDestination] = checkedMutationTargets;
  const checkedQuarantine = checkedMutationTargets.at(-3);
  const checkedSnapshot = checkedMutationTargets.at(-2);
  const checkedManifest = checkedMutationTargets.at(-1);
  assertVaultPathsSafe(vaultBase, [
    { path: join(checkedSource.target, 'proposta.md'), expectedType: 'file', label: 'proposta da change' },
    { path: join(checkedSource.target, 'tarefas.md'), expectedType: 'file', label: 'tarefas da change' },
  ]);

  // Atomicity guard: fail BEFORE promoting specs if the destination already exists (e.g. a slug
  // reused after a same-day archive). Otherwise promoteSpecs would commit to 07-Specs and the
  // later renameSync would fail, leaving a half-archived state.
  if (checkedDestination.exists) {
    return { ok: false, failing: [`destino de arquivo já existe: ${destRel} — renomeie o slug ou remova o arquivo antigo`] };
  }

  // Commit seam: the public gate may perform durable authorization I/O before returning. Inputs
  // can still change while preflights run, so re-derive authority here, immediately before the
  // first product mutation. Tests inject a mutation at this exact boundary; production callers
  // omit faultInjection. A negative/failed recapture is fail-closed and leaves every target intact.
  let commitVerdict;
  try {
    assertOperationLock();
    if (typeof faultInjection?.afterGateBeforeMutation === 'function') {
      faultInjection.afterGateBeforeMutation({ source: checkedSource.target, destination: checkedDestination.target });
    }
    commitVerdict = preMutate(checkedSource.target);
    if (!commitVerdict?.ok) return { ok: false, failing: commitVerdict?.failing || ['PROV_ARCHIVE_INPUT_CHANGED'] };
    if (!/^sha256:[a-f0-9]{64}$/.test(commitVerdict.sourceDigest || '')) {
      return { ok: false, failing: ['PROV_ARCHIVE_AUTHORIZED_SNAPSHOT_MISSING'] };
    }
    if (typeof faultInjection?.afterPreMutateBeforeMutation === 'function') {
      faultInjection.afterPreMutateBeforeMutation({ source: checkedSource.target, destination: checkedDestination.target });
    }
    if (JSON.stringify(authorizationEnvelope()) !== authorizedEnvelopeJson) {
      return { ok: false, failing: ['PROV_ARCHIVE_AUTHORIZATION_CHANGED'] };
    }
    assertOperationLock();
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code : 'PROV_ARCHIVE_PRE_MUTATION_CHECK_FAILED';
    return { ok: false, failing: [code] };
  }

  let transactionPhase = 'unprepared';
  const writeTransactionPhase = (phase, extra = {}) => {
    assertOperationLock();
    writeVaultFileAtomic(vaultBase, checkedManifest.target, `${JSON.stringify({
      schema_version: 1,
      operation: 'archive',
      operation_id: transactionId,
      change_slug: slug,
      phase,
      source_digest: commitVerdict.sourceDigest,
      destination_rel: destRel.replaceAll('\\', '/'),
      ...extra,
    })}\n`, 'utf8', {
      label: 'manifest da transação de archive', scopeRoot: transactionRoot,
    });
    const manifestFd = openSync(checkedManifest.target, 'r+');
    try { fsyncSync(manifestFd); } finally { closeSync(manifestFd); }
    assertOperationLock();
    transactionPhase = phase;
  };
  const markRecoveryRequired = (code, extra = {}) => {
    if (!existsSync(transactionRoot)) return;
    try { writeTransactionPhase('recovery-required', { blocker: code, ...extra }); }
    catch { /* retain the whole transaction even when journaling is unavailable */ }
  };

  const rollbackSeal = () => {
    if (existsSync(checkedSnapshot.target)) {
      try { rmSync(checkedSnapshot.target, { recursive: true, force: true }); } catch { /* quarantine remains recoverable */ }
    }
    if (existsSync(checkedQuarantine.target)) {
      if (existsSync(checkedSource.target)) {
        markRecoveryRequired('PROV_ARCHIVE_ROLLBACK_COLLISION', {
          original_state: 'retained', public_change_state: 'recreated',
        });
        return {
          ok: false,
          code: 'PROV_ARCHIVE_ROLLBACK_COLLISION',
          recovery: { kind: 'retained-original', operation_id: transactionId, phase: transactionPhase },
        };
      }
      renameVaultPath(vaultBase, checkedQuarantine.target, checkedSource.target, {
        sourceType: 'directory', label: 'rollback do isolamento causal da change',
      });
    }
    if (existsSync(transactionRoot)) {
      try { rmSync(transactionRoot, { recursive: true, force: true }); } catch { /* recoverable private runtime */ }
    }
    return { ok: true };
  };
  const rollbackFailure = (fallbackCode) => {
    try {
      const rollback = rollbackSeal();
      if (!rollback.ok) {
        return { ok: false, failing: [rollback.code], recovery: rollback.recovery };
      }
    } catch {
      return {
        ok: false,
        failing: ['PROV_ARCHIVE_ROLLBACK_FAILED'],
        recovery: { kind: 'retained-original', operation_id: transactionId, phase: transactionPhase },
      };
    }
    return { ok: false, failing: [fallbackCode] };
  };

  // Atomic namespace isolation is the first mutation. Writers addressing the public change path
  // can no longer alter the quarantined tree. A second private copy is hashed and becomes the only
  // publication source, so even a pre-existing OS handle to the original inode cannot inject bytes.
  try {
    assertOperationLock();
    mkdirVaultPath(vaultBase, transactionsRoot, {
      label: 'runtime de transações causais do archive',
    });
    mkdirVaultPath(vaultBase, transactionRoot, {
      exclusive: true, label: 'transação causal privada do archive',
    });
    writeTransactionPhase('prepared');
    assertOperationLock();
    renameVaultPath(vaultBase, checkedSource.target, checkedQuarantine.target, {
      sourceType: 'directory', label: 'isolamento causal da change',
    });
    assertOperationLock();
    if (archiveSourceDigest(checkedQuarantine.target) !== commitVerdict.sourceDigest) {
      return rollbackFailure('PROV_ARCHIVE_INPUT_CHANGED');
    }
    writeTransactionPhase('isolated');
    assertOperationLock();
    cpSync(checkedQuarantine.target, checkedSnapshot.target, {
      recursive: true, errorOnExist: true, force: false,
    });
    if (!existsSync(checkedSnapshot.target)) {
      const error = new Error('snapshot autorizado ausente após cópia');
      error.code = 'PROV_ARCHIVE_SNAPSHOT_COPY_MISSING';
      throw error;
    }
    if (archiveSourceDigest(checkedSnapshot.target) !== commitVerdict.sourceDigest) {
      return rollbackFailure('PROV_ARCHIVE_SNAPSHOT_DIVERGED');
    }
    writeTransactionPhase('copied');
    assertOperationLock();
    if (typeof faultInjection?.afterSealBeforePromotion === 'function') {
      faultInjection.afterSealBeforePromotion({
        source: checkedSource.target,
        original: checkedQuarantine.target,
        snapshot: checkedSnapshot.target,
      });
    }
  } catch (error) {
    const code = operationFailureCode(error, 'PROV_ARCHIVE_SOURCE_SEAL_FAILED');
    return rollbackFailure(code);
  }
  const mutationSource = checkedSnapshot.target;

  // Promote spec deltas into the living 07-Specs BEFORE moving (deltas live in src).
  // UNIÃO frontmatter + disco (0.31.0): o scaffold deixa `specs: []`, então um delta real
  // preenchido em specs/<cap>/ mas não listado era silenciosamente ignorado. Deltas ainda em
  // placeholder (o `exemplo` do scaffold) são filtrados por discoverSpecDeltas.
  let promoted = [];
  let specWarnings = [];
  let specCapabilities = [];
  let specChanges = [];
  let specPromotionPlan = null;
  let preparedSpecPromotion = null;
  try {
    assertOperationLock();
    let listed = [];
    try { listed = parseSpecsList(readFileSync(join(mutationSource, 'proposta.md'), 'utf8')); } catch { /* proposta ilegível */ }
    const onDisk = discoverSpecDeltas(mutationSource);
    specCapabilities = [...new Set([...listed, ...onDisk])];
    assertSpecPromotionTargetsSafe(vaultBase, mutationSource, specCapabilities);
    specWarnings = onDisk
      .filter((c) => !listed.includes(c))
      .map((c) => `spec no disco não listada no frontmatter da proposta: ${c} — promovida assim mesmo`);
  } catch (error) {
    return rollbackFailure(operationFailureCode(error, 'PROV_ARCHIVE_SPEC_DISCOVERY_FAILED'));
  }

  let reqIds = [];
  try { reqIds = [...new Set(parseTasks(readFileSync(join(mutationSource, 'tarefas.md'), 'utf8')).flatMap((t) => t.reqs ?? []))]; } catch { /* sem tarefas */ }

  // Backlink dos artefatos escritos à mão (spec.md) ANTES do move — o rewriteChangeLinks
  // abaixo retargeta o wikilink pro _arquivo junto com os demais. Fail-quiet.
  try {
    assertOperationLock();
    healSpecBacklinks(mutationSource, vaultBase, { proposalChangeDir: src });
  } catch (error) {
    if (error?.code === 'WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST') return rollbackFailure(error.code);
    // heal é bônus
  }

  // Semantic spec conflicts must fail before the archive is published so the public change can be
  // restored and `spec rebase --accept-current` remains available. The returned plan is read-only
  // and is reused after publication; its physical CAS still catches living-state changes that race
  // this preflight.
  try {
    assertOperationLock();
    if (specCapabilities.length) {
      preparedSpecPromotion = buildSpecPromotionPlan(vaultBase, mutationSource, specCapabilities, {
        changeWikilink,
        dateStr,
        recoveryRoot: transactionRoot,
      });
      specPromotionPlan = preparedSpecPromotion.plan;
      specChanges = preparedSpecPromotion.changes || [];
    }
    assertOperationLock();
  } catch (error) {
    return rollbackFailure(error?.message || 'PROV_ARCHIVE_SPEC_PREFLIGHT_FAILED');
  }

  let publicationDigest;
  try {
    assertOperationLock();
    publicationDigest = archiveSourceDigest(mutationSource);
    writeTransactionPhase('sealed', { publication_digest: publicationDigest });
  } catch (error) {
    return rollbackFailure(operationFailureCode(error, 'PROV_ARCHIVE_PUBLICATION_SEAL_FAILED'));
  }

  let archivePublished = false;
  const publishedFailure = (code, extra = {}) => {
    markRecoveryRequired(code, { publication_state: 'published-recovery-required', ...extra });
    return {
      ok: false,
      failing: [code],
      published: true,
      recovery: { kind: 'published-recovery-required', operation_id: transactionId, phase: transactionPhase },
    };
  };
  try {
    assertOperationLock();
    mkdirVaultPath(vaultBase, archiveRoot, { label: 'raiz de changes arquivadas' });
    assertOperationLock();
    renameVaultPath(vaultBase, mutationSource, destAbs, {
      sourceType: 'directory', label: 'archive da change',
    });
    archivePublished = true;
    assertOperationLock();
    if (existsSync(src) || archiveSourceDigest(destAbs) !== publicationDigest) {
      return publishedFailure('PROV_ARCHIVE_PUBLICATION_DIVERGED');
    }
    writeTransactionPhase('published', { destination_digest: publicationDigest });
    if (typeof faultInjection?.afterPublishBeforeFinalize === 'function') {
      faultInjection.afterPublishBeforeFinalize({
        source: src,
        destination: destAbs,
        operationId: transactionId,
      });
    }
  } catch (error) {
    const code = operationFailureCode(error, 'PROV_ARCHIVE_MOVE_FAILED');
    if (archivePublished) {
      return publishedFailure(code);
    }
    return rollbackFailure(code);
  }

  // Specs are promoted only after the immutable archive publication exists. A partial promotion
  // can therefore never trigger a false rollback; the journal retains the original for recovery.
  try {
    assertOperationLock();
    if (specCapabilities.length) {
      const res = promoteSpecsMutation(vaultBase, destAbs, specCapabilities, {
        changeWikilink,
        dateStr,
        recoveryRoot: transactionRoot,
        prepared: preparedSpecPromotion,
        assertOperationLock,
        faultInjection: {
          ...(faultInjection?.specPromotion || {}),
          beforeMutation: (plan) => {
            specPromotionPlan = plan;
            specChanges = plan.changes || [];
            writeTransactionPhase('promotion-prepared', {
              destination_digest: publicationDigest,
              spec_changes: specChanges,
              spec_promotion_plan: specPromotionPlan,
              spec_promotion_state: 'prepared',
            });
            faultInjection?.specPromotion?.beforeMutation?.(plan);
          },
        },
      });
      promoted = res.promoted;
      specChanges = res.changes || [];
      specPromotionPlan = res.plan || specPromotionPlan;
      specWarnings.push(...res.warnings);
      writeTransactionPhase('promotion-applied', {
        destination_digest: publicationDigest,
        spec_changes: specChanges,
        spec_promotion_plan: specPromotionPlan,
        spec_promotion_state: 'applied',
      });
    }
    assertOperationLock();
  }
  catch (error) {
    specChanges = error?.changes || specChanges;
    specPromotionPlan = error?.plan || specPromotionPlan;
    return publishedFailure(operationFailureCode(error, 'PROV_ARCHIVE_SPEC_PROMOTION_FAILED'), {
      spec_changes: specChanges,
      spec_promotion_plan: specPromotionPlan,
      spec_promotion_state: error?.rollback_failed ? 'recovery-required' : 'rolled-back',
    });
  }

  // Flip the archived proposta's frontmatter status so it no longer reads as active.
  try {
    assertOperationLock();
    const pp = join(destAbs, 'proposta.md');
    const c = readFileSync(pp, 'utf8').replace(/^status:\s*active\s*$/m, 'status: archived');
    writeVaultFileSync(vaultBase, pp, c, 'utf8', { label: 'proposta arquivada' });
  } catch (error) {
    return publishedFailure(operationFailureCode(error, 'PROV_ARCHIVE_PROPOSAL_UPDATE_FAILED'));
  }

  // O move quebrava TODO wikilink gravado antes (sessões fechadas, decisões, outras changes —
  // links cinza no grafo, visto em produção). Reescreve vault-wide; fail-quiet.
  let linksRewritten = 0;
  try {
    assertOperationLock();
    linksRewritten = rewriteChangeLinks(vaultBase, `${chDir}/${slug}`, destRel.replaceAll('\\', '/'), {
      excludeRoots: [transactionRoot],
    });
  } catch (error) {
    return publishedFailure(operationFailureCode(error, 'PROV_ARCHIVE_LINK_REWRITE_FAILED'));
  }

  // ADR goes in the same dated month folder as session-derived decisions (04-Decisões/ano/MM-MMM/)
  // — not the year root — so all ADRs sit together in the vault's convention.
  try {
    assertOperationLock();
    if (createAdr) mkdirVaultPath(vaultBase, join(vaultBase, adrDirRel), { label: 'pasta mensal de ADR' });
  } catch (error) {
    return publishedFailure(operationFailureCode(error, 'PROV_ARCHIVE_ADR_DIRECTORY_FAILED'));
  }
  const capLine = promoted.length
    ? `\n\nCapabilities: ${promoted.map((c) => wikilinkFromRel(join(loc.folders.specs, c))).join(', ')}.`
    : '';
  const reqLine = reqIds.length ? `\n\nRequisitos: ${reqIds.join(', ')}.` : '';
  // Rastro auditável (0.31.0): um archive forçado ou sem prova declarada fica marcado no ADR.
  const flagLines = `${adrFlags.forced ? '\nforced: true' : ''}${adrFlags.trivial ? '\ntrivial: true' : ''}`;
  const forcedNote = adrFlags.forced ? '\n\n> ⚠️ Arquivada com --force — havia tarefa(s) aberta(s) pulada(s) no gate.' : '';
  if (createAdr) {
    try {
      assertOperationLock();
      if (typeof faultInjection?.beforeAdrWrite === 'function') faultInjection.beforeAdrWrite({ destination: destAbs });
      writeVaultFileSync(vaultBase, join(vaultBase, adrRel), `---
type: decision
status: accepted
date: ${dateStr}${flagLines}
cssclasses:
  - topic-decision
tags:
  - decisao
---

# ADR-${num} — ${slug}

## Decisão

Mudança ${changeWikilink} concluída e arquivada.${capLine}${reqLine}${forcedNote}
`, 'utf8', { label: 'ADR da change arquivada' });
      assertOperationLock();
    }
    catch (error) {
      return publishedFailure(operationFailureCode(error, 'PROV_ARCHIVE_ADR_WRITE_FAILED'));
    }
  }

  // Only clear the pointer when the archived change IS the active one — archiving some other
  // slug explicitly must not blank the pointer of a different, still-active change.
  try {
    assertOperationLock();
    if (typeof faultInjection?.beforePointerClear === 'function') faultInjection.beforePointerClear({ destination: destAbs });
    if (activeChange(vaultBase, { context }) === slug) clearActiveChange(vaultBase, { context });
    assertOperationLock();
  } catch (error) {
    return publishedFailure(operationFailureCode(error, 'PROV_ARCHIVE_POINTER_CLEAR_FAILED'));
  }
  if (existsSync(src)) {
    return publishedFailure('PROV_ARCHIVE_PUBLIC_NAMESPACE_RECREATED', { public_change_state: 'recreated' });
  }
  let finalDestinationDigest;
  try {
    finalDestinationDigest = archiveSourceDigest(destAbs);
    for (const capability of promoted) {
      const living = join(vaultBase, loc.folders.specs, `${capability}.md`);
      if (!existsSync(living)) throw Object.assign(new Error('spec ausente'), { code: 'PROV_ARCHIVE_SPEC_PUBLICATION_MISSING' });
    }
    if (createAdr && !existsSync(join(vaultBase, adrRel))) {
      throw Object.assign(new Error('ADR ausente'), { code: 'PROV_ARCHIVE_ADR_MISSING' });
    }
    if (activeChange(vaultBase, { context }) === slug) {
      throw Object.assign(new Error('pointer ativo'), { code: 'PROV_ARCHIVE_POINTER_NOT_CLEARED' });
    }
    if (typeof faultInjection?.beforeCompletedJournal === 'function') {
      faultInjection.beforeCompletedJournal({ destination: destAbs });
    }
    writeTransactionPhase('completed', {
      destination_digest: finalDestinationDigest,
      spec_changes: specChanges,
      spec_promotion_plan: specPromotionPlan,
      spec_promotion_state: specPromotionPlan ? 'applied' : 'not-required',
    });
    assertOperationLock();
    if (typeof faultInjection?.beforeFinalInvariant === 'function') {
      faultInjection.beforeFinalInvariant({ destination: destAbs });
    }
    if (existsSync(src) || archiveSourceDigest(destAbs) !== finalDestinationDigest) {
      throw Object.assign(new Error('invariante final divergiu'), { code: 'PROV_ARCHIVE_FINAL_INVARIANT_DIVERGED' });
    }
    assertOperationLock();
  } catch (error) {
    return publishedFailure(operationFailureCode(error, 'PROV_ARCHIVE_FINALIZATION_FAILED'));
  }
  return {
    ok: true,
    failing: [],
    operationId: transactionId,
    transactionPhase,
    transactionPendingCleanup: true,
    archivedRel: destRel,
    adrRel: createAdr ? adrRel : '',
    promoted,
    specWarnings,
    specChanges,
    linksRewritten,
  };
}

export function runChange(argv) {
  const [sub, ...rest] = argv;
  const vaultBase = resolveVault(rest);
  const VALUE_FLAGS = new Set(['--vault', '--change', '--project', '--session']);
  const slugArg = () => rest.find((a, i) => !a.startsWith('-') && !VALUE_FLAGS.has(rest[i - 1]));
  const projectRoot = resolve(opt(rest, '--project') || process.cwd());
  const sessionId = opt(rest, '--session')
    || process.env.CODEX_THREAD_ID
    || process.env.CLAUDE_SESSION_ID
    || '';
  let contextResolved = false;
  let resolvedContext = null;
  const context = () => {
    if (contextResolved) return resolvedContext;
    contextResolved = true;
    try {
      resolvedContext = resolveCommandActiveContext({ vaultBase, projectRoot, sessionId });
      return resolvedContext;
    } catch (error) {
      process.stderr.write(`wendkeep change: ${error.code || 'WENDKEEP_ACTIVE_CONTEXT_FAILED'}: ${error.message}\n`);
      process.exit(2);
    }
  };

  if (sub === 'new') {
    const slug = slugArg();
    if (!slug) { process.stderr.write('wendkeep change new: missing <slug>\n'); process.exit(2); }
    // G2: link the active session into the proposta's source: (graph edge proposta->sessão).
    let sessionRel = '';
    try { sessionRel = readControl(vaultBase).session_file || ''; } catch { /* sem control */ }
    const r = newChange(vaultBase, slug, {
      dateStr: today(), simple: rest.includes('--simple'), guide: rest.includes('--guide'), sessionRel,
      context: context(),
    });
    process.stdout.write(`change ${r.created ? 'created' : 'exists'}: ${r.rel} (active)\n`);
    process.exit(0);
  }

  if (sub === 'use') {
    const slug = slugArg();
    if (!slug) { process.stderr.write('wendkeep change use: missing <slug>\n'); process.exit(2); }
    const r = useChange(vaultBase, slug, { context: context() });
    if (!r.ok) { process.stderr.write(`wendkeep change use: ${r.error}\n`); process.exit(2); }
    process.stdout.write(`current change: ${slug}\n`);
    process.exit(0);
  }

  if (sub === 'bind') {
    const slug = slugArg();
    const sessionId = opt(rest, '--session');
    if (!slug || !sessionId) { process.stderr.write('wendkeep change bind: use <slug> --session <id>\n'); process.exit(2); }
    const state = allChangesState(vaultBase);
    if (!state.changes.some((item) => item.slug === slug)) { process.stderr.write(`wendkeep change bind: open change not found: ${slug}\n`); process.exit(2); }
    if (!readSessionRegistry(vaultBase).sessions?.[sessionId]) { process.stderr.write(`wendkeep change bind: session not found: ${sessionId}\n`); process.exit(2); }
    upsertSessionRegistry(vaultBase, sessionId, { change_slug: slug });
    const selectedContext = context();
    if (selectedContext) setActiveChange(vaultBase, slug, { context: selectedContext });
    process.stdout.write(`session ${sessionId} -> change ${slug}\n`);
    process.exit(0);
  }

  if (sub === 'continue') {
    const positionals = rest.filter((a, i) => !a.startsWith('-') && !VALUE_FLAGS.has(rest[i - 1]));
    const [archivedSlug, newSlug] = positionals;
    if (!archivedSlug || !newSlug) {
      process.stderr.write('wendkeep change continue: use <archived-slug> <new-slug>\n');
      process.exit(2);
    }
    let sessionRel = '';
    try { sessionRel = readControl(vaultBase).session_file || ''; } catch { /* no control */ }
    const r = continueChange(vaultBase, archivedSlug, newSlug, {
      dateStr: today(), simple: rest.includes('--simple'), guide: rest.includes('--guide'), sessionRel,
      context: context(),
    });
    if (!r.ok) { process.stderr.write(`wendkeep change continue: ${r.error}\n`); process.exit(2); }
    process.stdout.write(`change created: ${r.rel} (continues ${r.archived}; active)\n`);
    process.exit(0);
  }

  if (sub === 'list') {
    const state = allChangesState(vaultBase, { context: context() });
    const { archived } = listChanges(vaultBase);
    process.stdout.write(`${renderOpenChanges(state, { tag: '' }) || 'open changes: (none)'}\n`);
    process.stdout.write(`archived: ${archived.join(', ') || '(none)'}\n`);
    process.exit(0);
  }

  if (sub === 'show') {
    const slug = slugArg();
    if (!slug) { process.stderr.write('wendkeep change show: missing <slug>\n'); process.exit(2); }
    let md;
    try { md = readFileSync(join(vaultBase, getLocale(vaultBase).folders.changes, slug, 'tarefas.md'), 'utf8'); }
    catch { process.stderr.write(`wendkeep change show: not found: ${slug}\n`); process.exit(2); }
    const tasks = parseTasks(md);
    const open = tasks.filter((t) => !t.done).length;
    process.stdout.write(`${slug}: ${tasks.length} task(s), ${open} open\n`);
    for (const t of tasks) process.stdout.write(`  [${t.done ? 'x' : ' '}] ${t.id} ${t.text}\n`);
    process.exit(0);
  }

  if (sub === 'status') {
    const slug = slugArg();
    if (!slug) {
      const state = allChangesState(vaultBase, { context: context() });
      if (!state.changes.length && !state.pointerWarning) {
        process.stderr.write('wendkeep change status: no open changes\n');
        process.exit(2);
      }
      process.stdout.write(`${renderOpenChanges(state, { tag: '' })}\n`);
      process.exit(0);
    }
    const dir = join(vaultBase, getLocale(vaultBase).folders.changes, slug);
    let tarefasMd;
    try { tarefasMd = readFileSync(join(dir, 'tarefas.md'), 'utf8'); }
    catch { process.stderr.write(`wendkeep change status: not found: ${slug}\n`); process.exit(2); }
    const tasks = parseTasks(tarefasMd);
    const done = tasks.filter((t) => t.done).length;
    process.stdout.write(`change: ${slug}${slug === activeChange(vaultBase, { context: context() }) ? ' (ativa)' : ''}\n`);
    let specs = [];
    try { specs = parseSpecsList(readFileSync(join(dir, 'proposta.md'), 'utf8')); } catch { /* sem proposta */ }
    process.stdout.write(`specs: ${specs.join(', ') || '(nenhuma)'}\n`);
    process.stdout.write(`tarefas: ${done} done / ${tasks.length - done} open\n`);
    for (const t of tasks) {
      const sensorIds = t.sensors ?? (t.sensor ? [t.sensor] : []);
      process.stdout.write(`  [${t.done ? 'x' : ' '}] ${t.id} ${t.text}${(t.reqs ?? []).map((r) => ` [req:${r}]`).join('')}${sensorIds.map((id) => ` [sensor:${id}]`).join('')}\n`);
    }
    let evidence = null;
    try { evidence = JSON.parse(readFileSync(join(dir, 'evidencia.json'), 'utf8')); } catch { /* sem evidência */ }
    if (evidence) for (const e of evidenceSensors(evidence)) process.stdout.write(`  ${e.status === 'green' ? '✓' : '✗'} ${e.id} (${e.severity || 'critical'})\n`);
    else process.stdout.write('evidencia: ausente\n');
    const reqIds = [...new Set(tasks.flatMap((t) => t.reqs ?? []))];
    const effective = buildEffectiveRequirementPackage(vaultBase, dir, reqIds);
    if (effective.errors.length || effective.missing.length) {
      process.stdout.write(`spec efetiva: inválida (${[...effective.errors, ...effective.missing.map((id) => `req órfão ${id}`)].join('; ')})\n`);
    }
    if (evidence) {
      let expected = {
        change_slug: slug,
        tasks_sha256: tasksHashOf(tarefasMd),
        effective_spec_sha256: `sha256:${effective.hash}`,
      };
      let unavailable = '';
      try {
        const ids = requiredSensors(tasks);
        const loaded = loadSensorsDetailed(projectRoot);
        expected = {
          ...expected,
          identity: resolveEvidenceIdentity({
            vaultBase, projectRoot, changeSlug: slug, sessionId, context: context(),
          }),
          snapshot: captureGitSnapshot(projectRoot),
          sensor_config_sha256: sensorConfigSha256(loaded.sensors, ids),
        };
      } catch (error) {
        unavailable = error.code || error.message;
      }
      const binding = evaluateEvidenceBinding(evidence, expected);
      process.stdout.write(`evidence-binding: ${binding.state}${binding.reasons.length ? ` (${binding.reasons.join('; ')})` : ''}${unavailable ? ` [current snapshot unavailable: ${unavailable}]` : ''}\n`);
    }
    let verdict = null;
    try { verdict = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')); } catch { /* sem verdict */ }
    if (!verdict) process.stdout.write(`verdict: ausente — rode \`wendkeep verify --deep\`${reqIds.length ? ' + wk-verify' : ' (verdict trivial automático)'}\n`);
    else if (!reqIds.length) process.stdout.write(`verdict: ${verdict.ok === true ? 'ok (trivial)' : 'não-ok — re-verifique'}\n`);
    else {
      const v = evaluateVerdict(verdict, reqIds, {
        tasksHash: tasksHashOf(tarefasMd),
        effectiveSpecHash: effective.hash,
        evidenceEnvelopeId: evidence?.schema_version === 2 ? evidence.envelope_id : undefined,
        evidenceBinding: evidence?.schema_version === 2 ? evidenceCheckoutBinding(evidence) : undefined,
      });
      process.stdout.write(`verdict: ${v.ok ? 'ok' : v.stale ? 'stale — re-verifique' : `incompleto: falta ${v.missing.join(', ')}`}\n`);
    }
    try { process.stdout.write(`mutation-round: ${readFileSync(join(dir, '.mutation-round'), 'utf8').trim()}/3\n`); } catch { /* sem rodadas */ }
    process.exit(0);
  }

  if (sub === 'done' || sub === 'undone') {
    const taskId = slugArg();
    if (!taskId) { process.stderr.write(`wendkeep change ${sub}: missing <taskId>\n`); process.exit(2); }
    const slug = opt(rest, '--change') || activeChange(vaultBase, { context: context() });
    if (!slug) { process.stderr.write(`wendkeep change ${sub}: no active change\n`); process.exit(2); }
    const dir = join(vaultBase, getLocale(vaultBase).folders.changes, slug);
    let ok = false;
    try { ok = setTaskDone(dir, taskId, sub === 'done'); } catch { /* sem tarefas.md */ }
    if (!ok) { process.stderr.write(`wendkeep change ${sub}: task não encontrada: ${taskId}\n`); process.exit(2); }
    process.stdout.write(`task ${taskId}: ${sub === 'done' ? '[x]' : '[ ]'}\n`);
    process.exit(0);
  }

  if (sub === 'diff') {
    const slug = slugArg() || activeChange(vaultBase, { context: context() });
    if (!slug) { process.stderr.write('wendkeep change diff: no change (arg or active)\n'); process.exit(2); }
    const dir = join(vaultBase, getLocale(vaultBase).folders.changes, slug);
    let specs = [];
    try { specs = parseSpecsList(readFileSync(join(dir, 'proposta.md'), 'utf8')); }
    catch { process.stderr.write(`wendkeep change diff: not found: ${slug}\n`); process.exit(2); }
    if (!specs.length) { process.stdout.write('diff: sem specs declaradas na proposta\n'); process.exit(0); }
    for (const cap of specs) {
      let delta;
      try { delta = parseDelta(readFileSync(join(dir, 'specs', cap, 'spec.md'), 'utf8')); }
      catch { process.stdout.write(`! sem delta para ${cap}\n`); continue; }
      process.stdout.write(`spec: ${cap}\n`);
      for (const r of delta.added) process.stdout.write(`  + ${r.id || r.name} (ADDED)\n`);
      for (const r of delta.modified) process.stdout.write(`  ~ ${r.id || r.name} (MODIFIED)\n`);
      for (const k of delta.removed) process.stdout.write(`  - ${k} (REMOVED)\n`);
      let living = [];
      try { living = parseRequirements(readFileSync(join(vaultBase, getLocale(vaultBase).folders.specs, `${cap}.md`), 'utf8')); } catch { /* nova capability */ }
      for (const w of applyDelta(living, delta).warnings) process.stdout.write(`  ! ${w}\n`);
    }
    process.exit(0);
  }

  if (sub === 'archive') {
    if (rest[0] === 'recover') {
      const operationId = rest[1] || '';
      const recoverySlug = opt(rest, '--change') || '';
      const specAction = opt(rest, '--spec-action');
      let payload;
      try {
        if (specAction) {
          payload = recoverArchiveSpecPromotionMutation(vaultBase, {
            operationId,
            slug: recoverySlug,
            action: specAction,
          });
        } else {
          payload = inspectArchiveRecovery(vaultBase, { operationId, slug: recoverySlug });
        }
      } catch (error) {
        payload = {
          ok: false,
          code: error?.code || 'PROV_ARCHIVE_RECOVERY_NOT_FOUND',
          operation: 'archive-recover',
          state: 'unproven',
          operation_id: /^[0-9a-f-]{36}$/i.test(operationId) ? operationId : null,
          change_slug: /^[a-z0-9][a-z0-9._-]*$/i.test(recoverySlug) ? recoverySlug : null,
          transaction_phase: null,
          blocker: error?.code || 'PROV_ARCHIVE_RECOVERY_NOT_FOUND',
          original_retained: null,
          publication_state: 'unknown',
          actions: ['verify-operation-id-and-change-slug'],
        };
      }
      if (rest.includes('--json')) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else process.stderr.write(`${payload.code}: operation=${payload.operation}; state=${payload.state}; operation_id=${payload.operation_id}; change_slug=${payload.change_slug}; transaction_phase=${payload.transaction_phase}; blocker=${payload.blocker}; original_retained=${payload.original_retained}; publication_state=${payload.publication_state}; actions=${JSON.stringify(payload.actions)}\n`);
      process.exit(1);
    }
    const selectedContext = context();
    const slug = slugArg() || activeChange(vaultBase, { context: selectedContext });
    if (!slug) { process.stderr.write('wendkeep change archive: missing <slug> and no active change\n'); process.exit(2); }
    let archiveGateAssessment = null;
    let archiveAuthorization = null;
    let operationLock;
    // Real gate (Pilar C): every sensor a task declared must be green in evidencia.json.
    const gate = (dir) => {
      operationLock.assertOwned();
      // G0: um scaffold nunca preenchido não é uma mudança concluída — arquivar geraria um
      // ADR falso. INESCAPÁVEL desde 0.31.0 (--force não pula — visto em produção: change
      // 100% placeholder arquivada via --force mintou ADR falso). Saída legítima: abandon.
      const placeholders = scaffoldPlaceholders(dir);
      if (placeholders.length) {
        return { ok: false, failing: [`scaffold não preenchido (${placeholders.join('; ')}) — preencha proposta/design/tarefas antes de arquivar, ou \`wendkeep change abandon ${slug}\` se a change não vai adiante (--force não pula este check)`] };
      }
      const impact = validateSpecImpact(dir);
      for (const warning of impact.warnings) process.stderr.write(`aviso spec: ${warning}\n`);
      if (!impact.ok) return { ok: false, failing: impact.errors };
      let tarefasMd = '';
      try { tarefasMd = readFileSync(join(dir, 'tarefas.md'), 'utf8'); } catch { /* no tasks */ }
      const tasks = parseTasks(tarefasMd);
      // G1: uma change não arquiva com tarefa aberta (inclui fix-tasks M.n de mutação).
      const open = tasks.filter((t) => !t.done);
      if (open.length && !rest.includes('--force')) {
        return { ok: false, failing: [`${open.length} tarefa(s) aberta(s) (ex.: ${open[0].id} ${open[0].text}) — conclua ou use --force`] };
      }
      const required = requiredSensors(tasks);
      const reqIds = [...new Set(tasks.flatMap((t) => t.reqs ?? []))];
      const effective = buildEffectiveRequirementPackage(vaultBase, dir, reqIds);
      if (effective.errors.length) return { ok: false, failing: [`spec efetiva inválida: ${effective.errors.join('; ')}`] };
      if (effective.missing.length) return { ok: false, failing: [formatOrphanReqs(effective.missing)] };
      let evidence = null;
      try { evidence = JSON.parse(readFileSync(join(dir, 'evidencia.json'), 'utf8')); } catch { /* no evidence */ }
      const sensorEvidence = evidenceSensors(evidence);
      let verdict = null;
      try { verdict = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')); } catch { /* none */ }
      let verification = null;
      try { verification = JSON.parse(readFileSync(join(dir, 'verificacao.json'), 'utf8')); } catch { /* none */ }
      const checkoutBinding = evidence?.schema_version === 2 ? evidenceCheckoutBinding(evidence) : null;
      let expected;
      try {
        const loaded = loadSensorsDetailed(projectRoot);
        expected = {
          change_slug: slug,
          identity: resolveEvidenceIdentity({
            vaultBase, projectRoot, changeSlug: slug, sessionId, context: selectedContext,
          }),
          snapshot: captureGitSnapshot(projectRoot),
          tasks_sha256: tasksHashOf(tarefasMd),
          effective_spec_sha256: `sha256:${effective.hash}`,
          sensor_config_sha256: sensorConfigSha256(loaded.sensors, required),
        };
      } catch (error) {
        const blocker = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
          ? error.code : 'PROV_EXPECTED_CONTEXT_UNAVAILABLE';
        archiveGateAssessment = {
          ok: false,
          state: 'unproven',
          reasonCodes: ['PROV_EXPECTED_CONTEXT_UNAVAILABLE'],
          diagnostics: [{ kind: 'archive', state: 'unproven', blocker }],
          repair: archiveRepair(slug),
        };
        return { ok: false, failing: [provenanceBlock(archiveGateAssessment)] };
      }
      const contract = archiveContract({ slug, tarefasMd, tasks, effective, sensorEvidence });
      const provenance = evaluateProvenanceGate({
        purpose: 'archive',
        assessments: {
          envelope: classifyEvidenceEnvelope({ evidence, expected }),
          package: provenanceAssessment('package', verification, evidence, expected, contract),
          verdict: provenanceAssessment('verdict', verdict, evidence, expected, contract),
        },
        requiredKinds: ['envelope', 'package', 'verdict'],
      });
      provenance.repair = archiveRepair(slug);
      if (!provenance.ok) {
        archiveGateAssessment = provenance;
        return { ok: false, failing: [provenanceBlock(provenance)] };
      }
      // Verdict SEMPRE exigido (0.31.0) — a exigência universal vive AQUI no gate; a semântica
      // reqless→ok de evaluateVerdict (spec-core) não muda porque `verify --deep` e `change
      // status` dependem dela. Change sem [req:] destrava com o auto-verdict do verify --deep.
      if (!verdict) {
        return { ok: false, failing: [reqIds.length
          ? 'sem verdict — rode `wendkeep verify --deep` + skill wk-verify'
          : 'sem verdict — rode `wendkeep verify --deep` (verdict trivial automático)'] };
      }
      if (verdict.ok !== true) return { ok: false, failing: ['verdict não-ok — re-verifique a change antes de arquivar'] };
      const s = evaluateGate(sensorEvidence, required);
      if (!s.ok) return s;
      const v = evaluateVerdict(verdict, reqIds, {
        tasksHash: contract.tasksHash,
        effectiveSpecHash: contract.effectiveSpecHash,
        evidenceEnvelopeId: evidence?.schema_version === 2 ? evidence.envelope_id : undefined,
        evidenceBinding: checkoutBinding || undefined,
      });
      if (!v.ok) {
        if (v.stale) return { ok: false, failing: ['verdict stale — re-verifique: `wendkeep verify --deep` + wk-verify'] };
        return { ok: false, failing: [`verdict incompleto: falta ${v.missing.join(', ')}`] };
      }

      // Recapture every mutable input at the last possible point before authorizing the archive.
      // This narrows the verify→archive TOCTOU window without trusting the first read above.
      let finalEvidence;
      let finalVerification;
      let finalVerdict;
      let finalExpected;
      let finalContract;
      let finalRequired;
      let finalReqIds;
      try {
        const finalPlaceholders = scaffoldPlaceholders(dir);
        if (finalPlaceholders.length) throw Object.assign(new Error('scaffold mudou durante o gate'), { code: 'PROV_ARCHIVE_INPUT_CHANGED' });
        const finalImpact = validateSpecImpact(dir);
        if (!finalImpact.ok) throw Object.assign(new Error(finalImpact.errors.join('; ')), { code: 'PROV_ARCHIVE_INPUT_CHANGED' });
        const finalTarefasMd = readFileSync(join(dir, 'tarefas.md'), 'utf8');
        const finalTasks = parseTasks(finalTarefasMd);
        if (finalTasks.some((task) => !task.done) && !rest.includes('--force')) {
          throw Object.assign(new Error('tarefas abertas surgiram durante o gate'), { code: 'PROV_ARCHIVE_INPUT_CHANGED' });
        }
        finalRequired = requiredSensors(finalTasks);
        finalReqIds = [...new Set(finalTasks.flatMap((task) => task.reqs ?? []))];
        const finalEffective = buildEffectiveRequirementPackage(vaultBase, dir, finalReqIds);
        if (finalEffective.errors.length || finalEffective.missing.length) {
          throw Object.assign(new Error('spec efetiva mudou durante o gate'), { code: 'PROV_ARCHIVE_INPUT_CHANGED' });
        }
        finalEvidence = JSON.parse(readFileSync(join(dir, 'evidencia.json'), 'utf8'));
        finalVerification = JSON.parse(readFileSync(join(dir, 'verificacao.json'), 'utf8'));
        finalVerdict = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8'));
        const finalLoaded = loadSensorsDetailed(projectRoot);
        finalExpected = {
          change_slug: slug,
          identity: resolveEvidenceIdentity({
            vaultBase, projectRoot, changeSlug: slug, sessionId, context: selectedContext,
          }),
          snapshot: captureGitSnapshot(projectRoot),
          tasks_sha256: tasksHashOf(finalTarefasMd),
          effective_spec_sha256: `sha256:${finalEffective.hash}`,
          sensor_config_sha256: sensorConfigSha256(finalLoaded.sensors, finalRequired),
        };
        finalContract = archiveContract({
          slug,
          tarefasMd: finalTarefasMd,
          tasks: finalTasks,
          effective: finalEffective,
          sensorEvidence: evidenceSensors(finalEvidence),
        });
      } catch (error) {
        archiveGateAssessment = {
          ok: false,
          state: 'stale',
          reasonCodes: [error.code || 'PROV_ARCHIVE_FINAL_SNAPSHOT_FAILED'],
          diagnostics: [{ kind: 'archive', state: 'stale', blocker: error.code || 'final snapshot failed' }],
          repair: archiveRepair(slug),
        };
        return { ok: false, failing: [provenanceBlock(archiveGateAssessment)] };
      }
      const finalProvenance = evaluateProvenanceGate({
        purpose: 'archive',
        assessments: {
          envelope: classifyEvidenceEnvelope({ evidence: finalEvidence, expected: finalExpected }),
          package: provenanceAssessment('package', finalVerification, finalEvidence, finalExpected, finalContract),
          verdict: provenanceAssessment('verdict', finalVerdict, finalEvidence, finalExpected, finalContract),
        },
        requiredKinds: ['envelope', 'package', 'verdict'],
      });
      finalProvenance.repair = archiveRepair(slug);
      const finalSensors = evaluateGate(evidenceSensors(finalEvidence), finalRequired);
      const finalVerdictResult = evaluateVerdict(finalVerdict, finalReqIds, {
        tasksHash: finalContract.tasksHash,
        effectiveSpecHash: finalContract.effectiveSpecHash,
        evidenceEnvelopeId: finalEvidence.envelope_id,
        evidenceBinding: evidenceCheckoutBinding(finalEvidence),
      });
      if (!finalProvenance.ok || !finalSensors.ok || !finalVerdictResult.ok) {
        archiveGateAssessment = finalProvenance.ok ? {
          ok: false,
          state: 'stale',
          reasonCodes: ['PROV_ARCHIVE_FINAL_SNAPSHOT_STALE'],
          diagnostics: [{ kind: 'archive', state: 'stale', blocker: 'final snapshot diverged' }],
          repair: archiveRepair(slug),
        } : finalProvenance;
        return { ok: false, failing: [provenanceBlock(archiveGateAssessment)] };
      }
      try {
        operationLock.assertOwned();
        appendArchiveAuthorization({
          projectRoot,
          slug,
          expected: finalExpected,
          contract: finalContract,
          evidence: finalEvidence,
          verification: finalVerification,
          verdict: finalVerdict,
          required: finalRequired,
          reqIds: finalReqIds,
          forced,
        });
        operationLock.assertOwned();
      } catch (error) {
        archiveGateAssessment = {
          ok: false,
          code: error?.code || 'WENDKEEP_ARCHIVE_RECEIPT_UNAVAILABLE',
          state: ['WENDKEEP_RECEIPT_LEDGER_CORRUPT', 'WENDKEEP_RECEIPT_LEDGER_TRUNCATED'].includes(error?.code)
            ? 'conflict' : 'reported',
          reasonCodes: [error?.code || 'WENDKEEP_ARCHIVE_RECEIPT_UNAVAILABLE'],
          diagnostics: [{ kind: 'archive-receipt', state: 'conflict', blocker: error?.code || 'receipt unavailable' }],
          repair: archiveRepair(slug),
        };
        return { ok: false, failing: [provenanceBlock(archiveGateAssessment)] };
      }
      // The receipt append is durable I/O and therefore widens the race window. Seal the exact
      // authorized state, re-read it now, and let archiveChange re-read it again at its commit seam.
      archiveAuthorization = {
        expected: finalExpected,
        contract: finalContract,
        evidence: finalEvidence,
        verification: finalVerification,
        verdict: finalVerdict,
        required: finalRequired,
        reqIds: finalReqIds,
      };
      const postReceipt = recaptureArchiveAuthorization({
        dir, vaultBase, projectRoot, slug, sessionId, selectedContext, forced,
        authorized: archiveAuthorization,
      });
      if (!postReceipt.ok) {
        archiveGateAssessment = {
          ok: false,
          state: 'stale',
          reasonCodes: postReceipt.failing,
          diagnostics: [{ kind: 'archive', state: 'stale', blocker: postReceipt.failing[0] }],
          repair: archiveRepair(slug),
        };
        return { ok: false, failing: [provenanceBlock(archiveGateAssessment)] };
      }
      return { ok: true, failing: [] };
    };
    // Rastro auditável: forced só quando o --force de fato pulou G1 (tarefa aberta); trivial
    // quando a change não declarou nenhuma prova ([req:]/[sensor:]).
    let tasks = [];
    try { tasks = parseTasks(readFileSync(join(vaultBase, getLocale(vaultBase).folders.changes, slug, 'tarefas.md'), 'utf8')); } catch { /* sem tarefas */ }
    const forced = rest.includes('--force') && tasks.some((t) => !t.done);
    const trivial = !tasks.some((t) => t.req) && !tasks.some((t) => t.sensor);
    const compactGuide = isGuideCompactChange(join(vaultBase, getLocale(vaultBase).folders.changes, slug));
    if (trivial) process.stderr.write(compactGuide
      ? 'aviso: GUIDE compacta sem [req:]/[sensor:] — resultado permanece auditável no archive, sem ADR automático\n'
      : 'aviso: change trivial (sem [req:]/[sensor:]) — ADR marcado trivial: true\n');
    try {
      operationLock = acquireArchiveOperationLock({
        lockPath: join(vaultBase, '.brain', 'runtime', 'change-archive-operation.lock'),
      });
    } catch (error) {
      archiveGateAssessment = {
        ok: false,
        code: error?.code || 'WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE',
        state: error?.code === 'WENDKEEP_ARCHIVE_BUSY' ? 'conflict' : 'unproven',
        reasonCodes: [error?.code || 'WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE'],
        diagnostics: [{
          kind: 'archive-lock', state: 'conflict', blocker: error?.code || 'WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE',
          expected: { owner_state: 'available' },
          observed: { owner_state: error?.owner_state || 'unavailable' },
        }],
        recovery: error?.code === 'WENDKEEP_ARCHIVE_BUSY'
          ? archiveRetryRepair(slug).command
          : archiveManualRecovery(slug).explanation,
        repair: error?.code === 'WENDKEEP_ARCHIVE_BUSY'
          ? archiveRetryRepair(slug)
          : archiveManualRecovery(slug),
      };
      const payload = archiveJsonFailure(slug, archiveGateAssessment);
      if (rest.includes('--json')) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else process.stderr.write(`${archiveFailureText(payload)}\n`);
      process.exit(1);
    }
    let r;
    let releaseError = null;
    try {
      r = archiveChangeMutation(vaultBase, slug, {
        dateStr: today(), adrNum: getNextAdrNumber(vaultBase), gate,
        assertOperationLock: () => operationLock.assertOwned(),
        authorizationEnvelope: () => ({
          schema_version: 2,
          purpose: 'archive',
          change_slug: slug,
          authorization: archiveAuthorization,
        }),
        preMutate: (dir) => {
          operationLock.assertOwned();
          const sourceDigestBefore = archiveSourceDigest(dir);
          operationLock.assertOwned();
          const commitCheck = recaptureArchiveAuthorization({
            dir, vaultBase, projectRoot, slug, sessionId, selectedContext, forced,
            authorized: archiveAuthorization,
          });
          if (commitCheck.ok) {
            operationLock.assertOwned();
            const sourceDigestAfter = archiveSourceDigest(dir);
            operationLock.assertOwned();
            if (sourceDigestBefore !== sourceDigestAfter) {
              return { ok: false, failing: ['PROV_ARCHIVE_INPUT_CHANGED'] };
            }
            return { ...commitCheck, sourceDigest: sourceDigestBefore };
          }
          archiveGateAssessment = {
            ok: false,
            state: 'stale',
            reasonCodes: commitCheck.failing,
            diagnostics: [{ kind: 'archive', state: 'stale', blocker: commitCheck.failing[0] }],
            repair: archiveRepair(slug),
          };
          return { ok: false, failing: [provenanceBlock(archiveGateAssessment)] };
        },
        adrFlags: { forced, trivial }, context: selectedContext,
      });
    } catch (error) {
      r = {
        ok: false,
        failing: [error?.code || 'WENDKEEP_ARCHIVE_OPERATION_FAILED'],
        published: false,
      };
    } finally {
      try { operationLock.release(); }
      catch (error) { releaseError = error; }
    }
    if (releaseError) {
      const published = Boolean(r?.ok || r?.published);
      const code = releaseError?.code || 'WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST';
      archiveGateAssessment = {
        ok: false,
        code,
        state: 'conflict',
        reasonCodes: [code],
        diagnostics: [{
          kind: 'archive-lock', state: 'conflict', blocker: code,
          expected: { owner_state: 'held' },
          observed: { owner_state: 'lost', publication_state: published ? 'published-recovery-required' : 'not-published' },
        }],
        recovery: archiveManualRecovery(slug, published).explanation,
        repair: archiveManualRecovery(slug, published),
      };
      archiveGateAssessment.diagnostics[0].observed.operation_id = r?.recovery?.operation_id || r?.operationId || null;
      archiveGateAssessment.diagnostics[0].observed.transaction_phase = r?.recovery?.phase || r?.transactionPhase || null;
      r = { ...r, ok: false, failing: [code], published };
    }
    if (!releaseError && r?.ok && r.transactionPendingCleanup) {
      try {
        const finalized = finalizeArchiveTransaction(vaultBase, { operationId: r.operationId, slug });
        r.transactionPendingCleanup = false;
        r.transactionRetained = finalized?.retained === true;
      } catch (error) {
        const code = error?.code || 'PROV_ARCHIVE_TRANSACTION_CLEANUP_FAILED';
        r = { ...r, ok: false, failing: [code], published: true };
      }
    }
    if (!r.ok) {
      const code = r.failing?.[0];
      if (r.published || code === 'PROV_ARCHIVE_ROLLBACK_COLLISION' || code === 'PROV_ARCHIVE_ROLLBACK_FAILED'
        || code === 'PROV_ARCHIVE_RECOVERY_REQUIRED'
        || code === 'PROV_ARCHIVE_RECOVERY_JOURNAL_INVALID'
        || code === 'PROV_ARCHIVE_PUBLIC_NAMESPACE_RECREATED'
        || code === 'WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST') {
        const published = Boolean(r.published);
        const operationId = r.recovery?.operation_id || r.operationId || null;
        const phase = r.recovery?.phase || r.transactionPhase || null;
        const manualRecovery = archiveManualRecovery(slug, published, { operationId, phase });
        archiveGateAssessment = {
          ok: false,
          code,
          state: 'conflict',
          reasonCodes: [code],
          diagnostics: [{
            kind: 'archive-transaction', state: 'conflict', blocker: code,
            expected: { public_change: 'absent', lock_owner: 'held' },
            observed: {
              public_change: code === 'PROV_ARCHIVE_ROLLBACK_COLLISION' ? 'recreated' : 'unknown',
              original_state: r.recovery?.kind === 'retained-original' ? 'retained' : 'unknown',
              publication_state: published ? 'published-recovery-required' : 'not-published',
              operation_id: operationId,
              transaction_phase: phase,
            },
          }],
          recovery: manualRecovery.explanation,
          repair: manualRecovery,
        };
      }
      const payload = archiveJsonFailure(slug, archiveGateAssessment, r.failing);
      if (rest.includes('--json')) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        process.stderr.write(`${archiveFailureText(payload)}\n`);
      }
      process.exit(1);
    }
    try {
      const project = readProjectForValidation(vaultBase);
      if (project.ok && project.projectId) {
        const loc = getLocale(vaultBase);
        for (const archivedPath of observerMarkdownUnder(vaultBase, r.archivedRel)) {
          enqueueObserverDocumentChange({ vaultBase, projectId: project.projectId, logicalPath: archivedPath });
          const suffix = archivedPath.slice(String(r.archivedRel).length).replace(/^[\\/]+/, '');
          enqueueObserverDocumentChange({
            vaultBase,
            projectId: project.projectId,
            logicalPath: join(loc.folders.changes, slug, suffix),
            deleted: true,
          });
        }
        if (r.adrRel) enqueueObserverDocumentChange({ vaultBase, projectId: project.projectId, logicalPath: r.adrRel });
        for (const capability of r.promoted || []) {
          enqueueObserverDocumentChange({
            vaultBase,
            projectId: project.projectId,
            logicalPath: join(loc.folders.specs, capability, 'spec.md'),
          });
        }
      }
    } catch { /* Observer é fail-open; reconcile recupera qualquer enqueue perdido. */ }
    const successPayload = {
      ok: true,
      code: 'WENDKEEP_CHANGE_ARCHIVED',
      operation: 'archive',
      state: 'verified',
      reason_codes: [],
      blocker: null,
      expected: { change_slug: slug },
      observed: { archived_rel: r.archivedRel, adr_rel: r.adrRel || null, promoted: r.promoted || [] },
      recovery: null,
      diagnostics: [],
      repair: null,
      archived_rel: r.archivedRel,
      adr_rel: r.adrRel || null,
      promoted: r.promoted || [],
    };
    if (rest.includes('--json')) {
      process.stdout.write(`${JSON.stringify(successPayload, null, 2)}\n`);
    } else {
      process.stdout.write(`${successPayload.code}: operation=${successPayload.operation}; state=${successPayload.state}; blocker=null; expected=${JSON.stringify(successPayload.expected)}; observed=${JSON.stringify(successPayload.observed)}; recovery=null; reason_codes=[]; diagnostics=[]; repair=null; archived: ${r.archivedRel}${r.adrRel ? `; ADR: ${r.adrRel}` : '; GUIDE compacta: sem ADR'}\n`);
    }
    if (!rest.includes('--json') && r.promoted && r.promoted.length) {
      process.stdout.write(`specs promovidas: ${r.promoted.join(', ')}\n`);
    }
    if (r.specWarnings && r.specWarnings.length) for (const w of r.specWarnings) process.stderr.write(`  aviso spec: ${w}\n`);
    process.exit(0);
  }

  if (sub === 'relink') {
    const r = relinkChanges(vaultBase, { apply: rest.includes('--apply') });
    if (rest.includes('--json')) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); process.exit(0); }
    process.stdout.write(`${r.rewritten.length} slug(s) morto(s) mapeado(s)${r.applied ? ` · ${r.filesTouched} arquivo(s) reescritos` : ''}\n`);
    for (const m of r.rewritten) process.stdout.write(`  ${m.from} → ${m.to}\n`);
    for (const a of r.ambiguous) process.stdout.write(`  ambíguo (pulado): ${a}\n`);
    for (const o of r.orphans) process.stdout.write(`  sem archive correspondente: ${o}\n`);
    if (!r.applied) process.stdout.write('\ndry-run — nada foi escrito. Rode com --apply para reescrever os wikilinks.\n');
    process.exit(0);
  }

  if (sub === 'backlink') {
    const r = backfillArtifactLinks(vaultBase, { apply: rest.includes('--apply') });
    if (rest.includes('--json')) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); process.exit(0); }
    process.stdout.write(`${r.changed.length} artefato(s) órfão(s) em ${r.scanned} change(s)${r.applied ? ' · reescritos' : ''}\n`);
    for (const f of r.changed) process.stdout.write(`  ${f}\n`);
    if (!r.applied && r.changed.length) process.stdout.write('\ndry-run — nada escrito. Rode com --apply para injetar os backlinks.\n');
    process.exit(0);
  }

  if (sub === 'abandon') {
    const selectedContext = context();
    const slug = slugArg() || activeChange(vaultBase, { context: selectedContext });
    if (!slug) { process.stderr.write('wendkeep change abandon: missing <slug> and no active change\n'); process.exit(2); }
    const r = abandonChange(vaultBase, slug, { dateStr: today(), context: selectedContext });
    if (!r.ok) { process.stderr.write(`wendkeep change abandon: ${r.failing.join('; ')}\n`); process.exit(2); }
    process.stdout.write(`abandoned: ${r.archivedRel}\n`);
    process.exit(0);
  }

  process.stderr.write(`wendkeep change: unknown subcommand "${sub}". Known: new, use, continue, list, show, status, done, undone, diff, archive, abandon, relink, backlink.\n`);
  process.exit(2);
}
