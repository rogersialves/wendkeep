import { createHash } from 'node:crypto';
import {
  constants as fsConstants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { sanitizeMemoryText, renderSharedMemory, validateSharedMemory } from '../hooks/memory-schema.mjs';
import {
  canonicalMemoryJson, deriveMemoryProjection, enqueueMemoryEvent, projectMemoryOutbox,
  MEMORY_LOCK_BUSY, prepareMemoryProjection, publishMemoryProjection, readMemoryLedger,
  repairMemoryLedger, withMemoryLock,
} from '../hooks/memory-store.mjs';
import { mutateSessionRegistry, readSessionRegistry, registryPath } from '../hooks/obsidian-common.mjs';
import {
  assertVaultPathSafe, assertVaultPathsSafe, mkdirVaultPath, unlinkVaultFile,
  writeVaultFileAtomic,
} from '../hooks/vault-path-safety.mjs';
import {
  readLedgerForValidation, readProjectForValidation, validateMemoryBundle,
} from './validate-memory.mjs';
import { validateCore } from './validate-core.mjs';
import { checkMemoryBundle } from '../hooks/vault-health.mjs';

const BRAIN = '.brain';
const LEDGER = 'MEMORY_EVENTS.jsonl';
const SHARED = 'SHARED_MEMORY.md';
const CANDIDATES = 'MEMORY_CANDIDATES.jsonl';

function brainPath(vault, name) { return join(vault, BRAIN, name); }
function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function byteHash(value) { return createHash('sha256').update(value).digest('hex'); }

function checkedVaultFile(vault, path, label, {
  allowMissing = true, mustNotExist = false,
} = {}) {
  return assertVaultPathSafe(vault, path, {
    allowMissing, expectedType: 'file', mustNotExist, label,
  });
}

function readVaultFile(vault, path, encoding, label, { allowMissing = false } = {}) {
  let checked = checkedVaultFile(vault, path, label, { allowMissing });
  if (!checked.exists) return null;
  checked = checkedVaultFile(vault, checked.target, label, { allowMissing: false });
  return readFileSync(checked.target, encoding);
}

function snapshotVaultFile(vault, path, label, encoding = undefined) {
  const checked = checkedVaultFile(vault, path, label);
  return checked.exists
    ? { exists: true, bytes: readVaultFile(vault, checked.target, encoding, label) }
    : { exists: false, bytes: null };
}

function copyVaultFileToExternal(vault, sourcePath, destinationPath, label) {
  let source = checkedVaultFile(vault, sourcePath, label, { allowMissing: false });
  source = checkedVaultFile(vault, source.target, label, { allowMissing: false });
  copyFileSync(source.target, destinationPath, fsConstants.COPYFILE_EXCL);
}

function copyVaultFileExclusive(vault, sourcePath, destinationPath, label) {
  checkedVaultFile(vault, sourcePath, `origem de ${label}`, { allowMissing: false });
  checkedVaultFile(vault, destinationPath, `destino de ${label}`, { mustNotExist: true });
  const source = checkedVaultFile(vault, sourcePath, `origem de ${label}`, { allowMissing: false });
  const destination = checkedVaultFile(vault, destinationPath, `destino de ${label}`, {
    mustNotExist: true,
  });
  copyFileSync(source.target, destination.target, fsConstants.COPYFILE_EXCL);
  checkedVaultFile(vault, destination.target, `destino de ${label}`, { allowMissing: false });
}

function writeVaultArtifact(vault, path, content, label, publisher = null) {
  const checked = checkedVaultFile(vault, path, label);
  if (!publisher) {
    writeVaultFileAtomic(vault, checked.target, content, 'utf8', { label });
    return;
  }
  // Test/fault-injection publishers keep their old (path, content) contract, but may
  // only run after the real Vault target has been checked immediately before mutation.
  checkedVaultFile(vault, checked.target, label);
  publisher(checked.target, content);
  checkedVaultFile(vault, checked.target, label, { allowMissing: false });
}

function restoreVaultFile(vault, path, snapshot, label) {
  if (snapshot.exists) writeVaultFileAtomic(vault, path, snapshot.bytes, 'utf8', { label });
  else unlinkVaultFile(vault, path, { label });
}

function projectId(vault) {
  const marker = JSON.parse(readVaultFile(
    vault, brainPath(vault, 'PROJECT.json'), 'utf8', 'autoridade PROJECT.json',
  ));
  if (!marker?.projectId) throw new Error('PROJECT.json inválido: projectId ausente.');
  return marker.projectId;
}

function legacyCandidates(content) {
  const safe = sanitizeMemoryText(content).replace(/\r\n/g, '\n');
  const candidates = [];
  let section = 'Legacy';
  for (const line of safe.split('\n')) {
    const heading = line.match(/^#{1,3}\s+(.+)/);
    if (heading) { section = heading[1].trim(); continue; }
    const value = line.replace(/^[-*]\s+/, '').trim();
    if (!value) continue;
    const candidateId = `legacy-${hash(`${section}\0${value}`).slice(0, 16)}`;
    candidates.push({
      v: 1,
      candidate_id: candidateId,
      reason: 'legacy_shared',
      memory_key: `legacy.${hash(section).slice(0, 8)}.${candidates.length + 1}`,
      value,
      section: sanitizeMemoryText(section),
      source: 'SHARED_MEMORY.md',
    });
  }
  return candidates;
}

function candidateText(candidates) {
  return candidates.map((item) => `${JSON.stringify(item)}\n`).join('');
}

export function seedMemoryV2(vault) {
  const brain = join(vault, BRAIN);
  mkdirVaultPath(vault, brain, { label: 'raiz .brain da memória' });
  const created = [];
  const artifacts = [
    [LEDGER, ''],
    [CANDIDATES, ''],
    [SHARED, renderSharedMemory()],
  ];
  const checked = assertVaultPathsSafe(vault, artifacts.map(([name]) => ({
    path: join(brain, name), expectedType: 'file', label: `artefato inicial ${name}`,
  })));
  for (let index = 0; index < artifacts.length; index += 1) {
    const [name, content] = artifacts[index];
    const path = checked[index].target;
    if (!checked[index].exists) {
      writeVaultFileAtomic(vault, path, content, 'utf8', { label: `artefato inicial ${name}` });
      created.push(name);
    }
  }
  return { status: created.length ? 'seeded' : 'unchanged', created };
}

export function memoryStatus(vault) {
  return checkMemoryBundle(vault);
}

export function migrateMemory(vault, {
  apply = false,
  validateBundle = validateMemoryBundle,
  publishArtifact = null,
} = {}) {
  projectId(vault);
  const sharedPath = brainPath(vault, SHARED);
  const shared = checkedVaultFile(vault, sharedPath, 'SHARED legado');
  const hadShared = shared.exists;
  const legacy = hadShared ? readVaultFile(vault, shared.target, 'utf8', 'SHARED legado') : '';
  const parsed = validateSharedMemory(legacy);
  const alreadyV2 = parsed.ok && parsed.metadata.schema_version === 2;
  const candidates = alreadyV2 ? [] : legacyCandidates(legacy);
  const backupPath = hadShared ? `${sharedPath}.legacy-${hash(legacy).slice(0, 12)}.bak` : null;
  if (!apply) return { status: 'dry-run', alreadyV2, candidates: candidates.length, backupPath };
  if (alreadyV2) {
    seedMemoryV2(vault);
    return { status: 'unchanged', alreadyV2: true, candidates: 0, backupPath: null };
  }

  // Validate every generated byte before the first publication. CORE is never written.
  const emptyShared = renderSharedMemory();
  const sharedValidation = validateSharedMemory(emptyShared, { eventIds: new Set() });
  if (!sharedValidation.ok) throw new Error(`Migração inválida: ${sharedValidation.errors.join(' ')}`);
  if (backupPath) {
    const backup = checkedVaultFile(vault, backupPath, 'backup do SHARED legado');
    if (!backup.exists) copyVaultFileExclusive(vault, sharedPath, backupPath, 'backup do SHARED legado');
  }

  // Build and validate a complete candidate vault away from the live paths. This makes
  // the validation callback incapable of observing a half-published live bundle.
  const stagingVault = mkdtempSync(join(dirname(vault), '.wendkeep-memory-stage-'));
  const stagingBrain = join(stagingVault, BRAIN);
  let stagedValidation;
  try {
    mkdirSync(stagingBrain, { recursive: true });
    copyVaultFileToExternal(
      vault, brainPath(vault, 'CORE.md'), join(stagingBrain, 'CORE.md'), 'autoridade CORE.md',
    );
    copyVaultFileToExternal(
      vault, brainPath(vault, 'PROJECT.json'), join(stagingBrain, 'PROJECT.json'), 'autoridade PROJECT.json',
    );
    writeFileSync(join(stagingBrain, LEDGER), '', 'utf8');
    writeFileSync(join(stagingBrain, SHARED), emptyShared, 'utf8');
    writeFileSync(join(stagingBrain, CANDIDATES), candidateText(candidates), 'utf8');
    stagedValidation = validateBundle(stagingVault);
    if (!stagedValidation.ok) {
      throw new Error(`Bundle migrado inválido: ${(stagedValidation.errors || []).join(' ')}`);
    }
  } finally {
    rmSync(stagingVault, { recursive: true, force: true });
  }

  const targets = [LEDGER, SHARED, CANDIDATES].map((name) => brainPath(vault, name));
  const before = new Map(targets.map((path) => [path, snapshotVaultFile(
    vault, path, `snapshot de ${path}`, 'utf8',
  )]));
  assertVaultPathsSafe(vault, targets.map((path) => ({
    path, expectedType: 'file', label: `target de migração ${path}`,
  })));
  try {
    if (!before.get(brainPath(vault, LEDGER)).exists) {
      writeVaultArtifact(vault, brainPath(vault, LEDGER), '', 'ledger migrado', publishArtifact);
    }
    writeVaultArtifact(vault, sharedPath, emptyShared, 'SHARED migrado', publishArtifact);
    writeVaultArtifact(
      vault, brainPath(vault, CANDIDATES), candidateText(candidates),
      'candidates migrados', publishArtifact,
    );
    const validation = validateMemoryBundle(vault);
    if (!validation.ok) throw new Error(`Bundle migrado inválido: ${validation.errors.join(' ')}`);
    return { status: 'migrated', alreadyV2: false, candidates: candidates.length, backupPath, validation };
  } catch (error) {
    for (const [path, snapshot] of before) {
      restoreVaultFile(vault, path, snapshot, `rollback da migração ${path}`);
    }
    throw error;
  }
}

function readCandidates(vault) {
  const path = brainPath(vault, CANDIDATES);
  const checked = checkedVaultFile(vault, path, 'MEMORY_CANDIDATES.jsonl');
  if (!checked.exists) return [];
  return readVaultFile(vault, checked.target, 'utf8', 'MEMORY_CANDIDATES.jsonl')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function decideMemoryCandidate(vault, { action, candidateId, value } = {}) {
  if (!['promote', 'reject'].includes(action)) throw new TypeError('action deve ser promote ou reject.');
  if (!candidateId) throw new TypeError('candidateId é obrigatório.');
  const candidates = readCandidates(vault);
  const candidate = candidates.find((item) => item.candidate_id === candidateId);
  if (!candidate) throw new Error(`Candidate não encontrado: ${candidateId}`);
  const now = new Date().toISOString();
  const event = {
    v: 1,
    event_id: `cli-${action}-${hash(candidateId).slice(0, 20)}`,
    project_id: projectId(vault),
    memory_key: action === 'promote' ? candidate.memory_key : `candidate.rejected.${candidateId}`,
    operation: 'assert',
    value: sanitizeMemoryText(action === 'promote' ? (value ?? candidate.value ?? candidate.values?.[0] ?? '') : 'rejected'),
    authority: 'verified',
    activation_id: 'wendkeep-memory-cli',
    turn_sequence: 0,
    observed_at: now,
    evidence: [`candidate:${candidateId}`],
  };
  enqueueMemoryEvent(vault, event);
  const projection = projectMemoryOutbox(vault);
  if (projection.status === 'busy') return { status: 'busy', candidateId };
  const remaining = candidates.filter((item) => item.candidate_id !== candidateId);
  const projected = readCandidates(vault);
  const merged = new Map([...remaining, ...projected].map((item) => [item.candidate_id, item]));
  writeVaultFileAtomic(
    vault, brainPath(vault, CANDIDATES), candidateText([...merged.values()]), 'utf8',
    { label: 'candidates após decisão humana' },
  );
  return { status: action === 'promote' ? 'promoted' : 'rejected', candidateId, eventId: event.event_id, projection };
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sameCheckpoint(left, right) {
  return Boolean(left && right) && canonicalMemoryJson(left) === canonicalMemoryJson(right);
}

function normalizeReconciliationRequest({ sessionId, bySessionId, reason } = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedBySessionId = String(bySessionId || '').trim();
  const normalizedReason = sanitizeMemoryText(reason || '').trim().slice(0, 500);
  if (!normalizedSessionId) throw new TypeError('sessionId é obrigatório para reconciliar attempt ambíguo.');
  if (!normalizedBySessionId) throw new TypeError('bySessionId é obrigatório para reconciliar attempt ambíguo.');
  if (!normalizedReason) throw new TypeError('reason é obrigatório para reconciliar attempt ambíguo.');
  if (normalizedSessionId === normalizedBySessionId) {
    throw new TypeError('A sessão reconciliadora deve ser diferente da sessão superseded.');
  }
  return { sessionId: normalizedSessionId, bySessionId: normalizedBySessionId, reason: normalizedReason };
}

function attemptFingerprint(attempt) {
  return hash(canonicalMemoryJson(attempt || null));
}

function memoryCheckpointFingerprint(entry) {
  const present = Object.prototype.hasOwnProperty.call(entry || {}, 'memory_checkpoint');
  return hash(canonicalMemoryJson({
    present,
    checkpoint: present ? (entry.memory_checkpoint ?? null) : null,
  }));
}

function matchingAppliedReconciliation(entry, request) {
  const attempt = entry?.last_memory_attempt;
  if (attempt?.memory_mode !== 'v2' || attempt?.state !== 'skipped' || attempt?.disposition !== 'superseded') return null;
  if (attempt.reconciled_by_session_id !== request.bySessionId
      || attempt.reconciliation_reason !== request.reason) return null;
  return (Array.isArray(entry.memory_reconciliations) ? entry.memory_reconciliations : [])
    .find((item) => item?.type === 'ambiguous_attempt_superseded'
      && item.reconciled_by_session_id === request.bySessionId
      && item.reason === request.reason) || null;
}

function validationError(label, result) {
  const details = (result?.errors || []).join(' ');
  return new Error(`${label} inválido para reconciliação${details ? `: ${details}` : '.'}`);
}

function readMemoryAuthority(vault) {
  assertVaultPathsSafe(vault, [
    ['PROJECT.json', 'autoridade PROJECT.json'],
    ['CORE.md', 'autoridade CORE.md'],
    [LEDGER, 'autoridade MEMORY_EVENTS.jsonl'],
  ].map(([name, label]) => ({
    path: brainPath(vault, name), expectedType: 'file', label,
  })));
  const project = readProjectForValidation(vault);
  if (!project.ok) throw validationError('PROJECT.json', project);

  const projectBytes = readVaultFile(vault, project.path, undefined, 'autoridade PROJECT.json');
  const corePath = brainPath(vault, 'CORE.md');
  let coreBytes;
  try {
    coreBytes = readVaultFile(vault, corePath, undefined, 'autoridade CORE.md');
  } catch (error) {
    throw new Error(`CORE.md ausente ou ilegível para reconciliação: ${error?.message || error}`);
  }
  const core = validateCore(coreBytes.toString('utf8'));
  if (!core.ok) throw validationError('CORE.md', core);

  const ledgerPath = brainPath(vault, LEDGER);
  let ledgerBefore;
  try {
    ledgerBefore = readVaultFile(vault, ledgerPath, undefined, 'autoridade MEMORY_EVENTS.jsonl');
  } catch (error) {
    throw new Error(`MEMORY_EVENTS.jsonl ausente ou ilegível para reconciliação: ${error?.message || error}`);
  }
  const ledger = readLedgerForValidation(vault, { projectId: project.projectId });
  if (!ledger.ok) throw validationError('Ledger', ledger);
  const ledgerAfter = readVaultFile(vault, ledgerPath, undefined, 'autoridade MEMORY_EVENTS.jsonl');
  if (!ledgerBefore.equals(ledgerAfter)) {
    throw new Error('Snapshot do ledger mudou durante o preflight de reconciliação.');
  }

  return {
    projectId: project.projectId,
    projectHash: byteHash(projectBytes),
    coreHash: byteHash(coreBytes),
    ledgerHash: byteHash(ledgerAfter),
    ledgerEvents: ledger.events,
    ledgerById: new Map(ledger.events.map((event) => [event.event_id, event])),
  };
}

function assertAuthorityMatches(expected, actual) {
  const changed = [
    ['PROJECT.json', 'projectHash'],
    ['CORE.md', 'coreHash'],
    ['ledger', 'ledgerHash'],
  ].find(([, key]) => expected?.[key] !== actual?.[key]);
  if (expected?.projectId !== actual?.projectId || changed) {
    const label = expected?.projectId !== actual?.projectId ? 'PROJECT.json' : changed[0];
    throw new Error(`Snapshot de autoridade mudou após o preflight (${label}); reconciliação abortada.`);
  }
}

function proofValue(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function validateSuccessorProof(request, attempt, authority) {
  if (attempt?.memory_mode !== 'v2' || attempt?.state !== 'projected'
      || attempt?.disposition !== 'applied') {
    throw new Error(`Sessão reconciliadora ${request.bySessionId} não possui attempt projected/applied.`);
  }
  if (!Array.isArray(attempt.event_ids) || attempt.event_ids.length === 0) {
    throw new Error(`Attempt da sessão reconciliadora ${request.bySessionId} não possui event_ids.`);
  }
  if (new Set(attempt.event_ids).size !== attempt.event_ids.length) {
    throw new Error('Identidade causal inválida: successor attempt possui event_ids duplicados.');
  }

  const expected = {
    canonical_session_id: request.bySessionId,
    activation_id: proofValue(attempt.activation_id),
    activation_epoch: attempt.activation_epoch,
    source_turn_id: proofValue(attempt.turn_id),
    turn_sequence: attempt.turn_sequence,
  };
  if (proofValue(attempt.canonical_session_id) !== request.bySessionId) {
    throw new Error(`Identidade causal inválida: canonical_session_id do successor attempt deve ser ${request.bySessionId}.`);
  }
  if (!expected.activation_id) throw new Error('Identidade causal inválida: activation_id ausente no successor attempt.');
  if (!Number.isInteger(expected.activation_epoch) || expected.activation_epoch < 0) {
    throw new Error('Identidade causal inválida: activation_epoch do successor attempt deve ser inteiro não negativo.');
  }
  if (!expected.source_turn_id) throw new Error('Identidade causal inválida: turn_id ausente no successor attempt.');
  if (!Number.isInteger(expected.turn_sequence) || expected.turn_sequence < 0) {
    throw new Error('Identidade causal inválida: turn_sequence do successor attempt deve ser inteiro não negativo.');
  }

  const ledgerById = authority.ledgerById
    || new Map(authority.ledgerEvents.map((event) => [event.event_id, event]));
  const missing = attempt.event_ids.filter((eventId) => !ledgerById.has(eventId));
  if (missing.length) {
    throw new Error('Attempt da sessão reconciliadora referencia event_ids ausentes do ledger.');
  }
  for (const eventId of attempt.event_ids) {
    const event = ledgerById.get(eventId);
    for (const [field, expectedValue] of Object.entries(expected)) {
      if (event?.[field] !== expectedValue) {
        throw new Error(`Identidade causal inválida no evento ${eventId}: ${field} não corresponde ao successor attempt.`);
      }
    }
  }

  return {
    v: 1,
    project_id: authority.projectId,
    registry_session_id: request.bySessionId,
    canonical_session_id: request.bySessionId,
    activation_id: expected.activation_id,
    activation_epoch: expected.activation_epoch,
    turn_id: expected.source_turn_id,
    turn_sequence: expected.turn_sequence,
    required_event_ids: [...attempt.event_ids],
    expected_ledger_sha256: authority.ledgerHash,
    expected_core_sha256: authority.coreHash,
  };
}

function assertStoredProofMatches(stored, current) {
  if (!stored || typeof stored !== 'object') {
    throw new Error('Audit matching inválido: causal_proof ausente; retry idempotente recusado.');
  }
  const causalFields = [
    'v', 'project_id', 'registry_session_id', 'canonical_session_id', 'activation_id',
    'activation_epoch', 'turn_id', 'turn_sequence', 'required_event_ids',
  ];
  const select = (proof) => Object.fromEntries(causalFields.map((field) => [field, proof?.[field]]));
  const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!validHash(stored.expected_ledger_sha256) || !validHash(stored.expected_core_sha256)
      || canonicalMemoryJson(select(stored)) !== canonicalMemoryJson(select(current))) {
    throw new Error('Prova causal armazenada diverge da identidade, dos event_ids ou dos hashes autorizados.');
  }
}

function assertHealthyReconciledBundle(vault, registry) {
  const health = checkMemoryBundle(vault, { registry });
  if (!health.ok || health.status === 'blocked') {
    throw new Error(`Memory health bloqueado durante reconciliação: ${(health.failures || []).join(' ')}`);
  }
  return health;
}

function assertPublishedProjection(vault, projection) {
  const shared = readVaultFile(
    vault, brainPath(vault, SHARED), 'utf8', 'projeção SHARED_MEMORY.md publicada',
  );
  const candidates = readVaultFile(
    vault, brainPath(vault, CANDIDATES), 'utf8', 'projeção MEMORY_CANDIDATES.jsonl publicada',
  );
  if (shared !== projection.sharedContent || candidates !== projection.candidatesContent) {
    throw new Error('Publicação derivada divergiu dos bytes preparados sob MEMORY.lock.');
  }
  const bundle = validateMemoryBundle(vault);
  if (!bundle.ok) throw new Error(`Bundle reprojetado inválido: ${bundle.errors.join(' ')}`);
}

function prepareReconciliation(vault, rawRequest, { expectedAuthority } = {}) {
  const request = normalizeReconciliationRequest(rawRequest);
  const authority = readMemoryAuthority(vault);
  if (expectedAuthority) assertAuthorityMatches(expectedAuthority, authority);
  const registry = readSessionRegistry(vault);
  const target = registry.sessions[request.sessionId];
  const successor = registry.sessions[request.bySessionId];
  if (!target) throw new Error(`Sessão não encontrada para reconciliação: ${request.sessionId}`);
  if (!successor) throw new Error(`Sessão reconciliadora não encontrada: ${request.bySessionId}`);

  const priorAudit = matchingAppliedReconciliation(target, request);
  if (priorAudit) {
    const proof = validateSuccessorProof(request, successor.last_memory_attempt, authority);
    assertStoredProofMatches(priorAudit.causal_proof, proof);
    const health = assertHealthyReconciledBundle(vault, registry);
    return {
      request,
      authority,
      alreadyApplied: true,
      health,
      reconciliationId: priorAudit.reconciliation_id || null,
    };
  }

  const targetAttempt = target.last_memory_attempt;
  if (targetAttempt?.memory_mode !== 'v2' || targetAttempt?.state !== 'skipped'
      || targetAttempt?.disposition !== 'ambiguous') {
    throw new Error(`Attempt da sessão ${request.sessionId} não está ambiguous/skipped em memória v2.`);
  }
  if (!Array.isArray(targetAttempt.event_ids) || targetAttempt.event_ids.length !== 0) {
    throw new Error(`Attempt ambíguo da sessão ${request.sessionId} deve ter event_ids vazio.`);
  }

  const successorAttempt = successor.last_memory_attempt;
  const proof = validateSuccessorProof(request, successorAttempt, authority);
  const derived = deriveMemoryProjection(vault, authority.ledgerEvents);
  return {
    request,
    authority,
    proof,
    alreadyApplied: false,
    targetFingerprint: attemptFingerprint(targetAttempt),
    successorFingerprint: attemptFingerprint(successorAttempt),
    targetAttempt: cloneJson(targetAttempt),
    successorCheckpoint: cloneJson(successorAttempt.checkpoint || successor.memory_checkpoint || null),
    nextCheckpoint: cloneJson(derived.checkpoint),
    ledgerEvents: authority.ledgerEvents.length,
  };
}

function snapshotArtifact(vault, path, label) {
  return snapshotVaultFile(vault, path, label);
}

function restoreArtifact(vault, path, snapshot, label) {
  restoreVaultFile(vault, path, snapshot, label);
}

export function reconcileMemory(vault, {
  sessionId,
  bySessionId,
  reason,
  apply = false,
  now = new Date().toISOString(),
  beforeRegistryMutation,
  memoryLock = {},
} = {}) {
  const prepared = prepareReconciliation(vault, { sessionId, bySessionId, reason });
  if (prepared.alreadyApplied && !apply) {
    return {
      status: 'unchanged',
      sessionId: prepared.request.sessionId,
      bySessionId: prepared.request.bySessionId,
      reconciliationId: prepared.reconciliationId,
    };
  }
  if (!apply) {
    return {
      status: 'dry-run',
      sessionId: prepared.request.sessionId,
      bySessionId: prepared.request.bySessionId,
      reason: prepared.request.reason,
      ledgerEvents: prepared.ledgerEvents,
      checkpointBefore: prepared.successorCheckpoint,
      checkpointAfter: prepared.nextCheckpoint,
    };
  }

  const outcome = withMemoryLock(vault, () => {
    const locked = prepareReconciliation(vault, prepared.request, { expectedAuthority: prepared.authority });
    if (locked.alreadyApplied) {
      return {
        status: 'unchanged',
        sessionId: locked.request.sessionId,
        bySessionId: locked.request.bySessionId,
        reconciliationId: locked.reconciliationId,
        health: locked.health,
      };
    }
    if (locked.targetFingerprint !== prepared.targetFingerprint
        || locked.successorFingerprint !== prepared.successorFingerprint) {
      throw new Error('CAS perdido: attempt mudou antes da região crítica de reconciliação.');
    }

    if (typeof beforeRegistryMutation === 'function') beforeRegistryMutation();
    const finalAuthority = readMemoryAuthority(vault);
    assertAuthorityMatches(prepared.authority, finalAuthority);
    const preparedProjection = prepareMemoryProjection(vault, finalAuthority.ledgerEvents);
    assertAuthorityMatches(prepared.authority, readMemoryAuthority(vault));

    const sharedPath = brainPath(vault, SHARED);
    const candidatesPath = brainPath(vault, CANDIDATES);
    const sharedBefore = snapshotArtifact(vault, sharedPath, 'snapshot SHARED de reconciliação');
    const candidatesBefore = snapshotArtifact(
      vault, candidatesPath, 'snapshot CANDIDATES de reconciliação',
    );
    let projectionTouched = false;
    let backupCreated = false;
    let backupPath = null;
    let projection;
    let committedHealth;

    try {
      // Intentional global order: MEMORY.lock -> SESSION_REGISTRY lock. The Stop
      // lifecycle releases its registry lock before projection, so no inverse nested
      // acquisition exists; keeping both here closes the CAS-to-sidecar race window.
      const registryResult = mutateSessionRegistry(vault, (registry) => {
        const target = registry.sessions?.[locked.request.sessionId];
        const successor = registry.sessions?.[locked.request.bySessionId];
        if (!target || !successor
            || attemptFingerprint(target.last_memory_attempt) !== locked.targetFingerprint
            || attemptFingerprint(successor.last_memory_attempt) !== locked.successorFingerprint) {
          throw new Error('CAS perdido: attempt mudou durante a reconciliação; nenhuma reclassificação aplicada.');
        }

        const nextCheckpoint = cloneJson(preparedProjection.checkpoint);
        const reconciliationId = `memrec-${hash(`${locked.request.sessionId}\0${locked.request.bySessionId}\0${locked.targetFingerprint}\0${locked.request.reason}`).slice(0, 20)}`;
        const targetAudit = {
          v: 1,
          reconciliation_id: reconciliationId,
          type: 'ambiguous_attempt_superseded',
          reconciled_at: now,
          reconciled_by_session_id: locked.request.bySessionId,
          reason: locked.request.reason,
          causal_proof: cloneJson(locked.proof),
          original_attempt: cloneJson(locked.targetAttempt),
        };
        target.memory_reconciliations = [
          ...(Array.isArray(target.memory_reconciliations) ? target.memory_reconciliations : []),
          targetAudit,
        ];
        target.last_memory_attempt = {
          ...cloneJson(locked.targetAttempt),
          disposition: 'superseded',
          reconciled_at: now,
          reconciled_by_session_id: locked.request.bySessionId,
          reconciliation_reason: locked.request.reason,
        };
        target.memory_status = 'skipped';

        const checkpointBefore = cloneJson(successor.last_memory_attempt.checkpoint || successor.memory_checkpoint || null);
        const refreshedCheckpoint = !sameCheckpoint(checkpointBefore, nextCheckpoint);
        if (refreshedCheckpoint) {
          successor.memory_reconciliations = [
            ...(Array.isArray(successor.memory_reconciliations) ? successor.memory_reconciliations : []),
            {
              v: 1,
              reconciliation_id: reconciliationId,
              type: 'checkpoint_refreshed',
              reconciled_at: now,
              event_ids: [...successor.last_memory_attempt.event_ids],
              causal_proof: cloneJson(locked.proof),
              original_checkpoint: checkpointBefore,
              checkpoint: cloneJson(nextCheckpoint),
            },
          ];
        }
        successor.last_memory_attempt = { ...successor.last_memory_attempt, checkpoint: cloneJson(nextCheckpoint) };
        successor.memory_checkpoint = cloneJson(nextCheckpoint);

        projectionTouched = true;
        projection = publishMemoryProjection(vault, preparedProjection);
        assertPublishedProjection(vault, preparedProjection);
        assertAuthorityMatches(prepared.authority, readMemoryAuthority(vault));
        // Policy blockers unrelated to this target (for example another ambiguous Stop
        // or a candidate conflict) remain visible, but do not roll back a valid scoped CAS.
        committedHealth = checkMemoryBundle(vault, { registry });

        const path = registryPath(vault);
        const registryArtifact = checkedVaultFile(vault, path, 'SESSION_REGISTRY da reconciliação');
        if (registryArtifact.exists) {
          const exact = readVaultFile(
            vault, registryArtifact.target, undefined, 'SESSION_REGISTRY da reconciliação',
          );
          backupPath = `${path}.reconcile-${hash(exact).slice(0, 12)}.bak`;
          const backup = checkedVaultFile(vault, backupPath, 'backup da reconciliação');
          if (!backup.exists) {
            copyVaultFileExclusive(vault, path, backupPath, 'backup da reconciliação');
            backupCreated = true;
          }
        }
        return {
          status: 'reconciled',
          reconciliationId,
          refreshedCheckpoint,
          supersededSession: locked.request.sessionId,
          backupPath,
        };
      });
      return {
        status: 'reconciled', projection, registry: registryResult, health: committedHealth,
      };
    } catch (error) {
      const rollbackErrors = [];
      if (projectionTouched) {
        try {
          restoreArtifact(vault, sharedPath, sharedBefore, 'rollback SHARED da reconciliação');
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        try {
          restoreArtifact(vault, candidatesPath, candidatesBefore, 'rollback CANDIDATES da reconciliação');
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (backupCreated && backupPath) {
        try {
          unlinkVaultFile(vault, backupPath, {
            missingOk: false, label: 'backup revertido da reconciliação',
          });
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length) {
        throw new AggregateError([error, ...rollbackErrors], `Reconciliação falhou e o rollback dos sidecars também falhou: ${error.message}`);
      }
      throw error;
    }
  }, memoryLock);

  if (outcome === MEMORY_LOCK_BUSY) {
    const error = new Error('MEMORY.lock indisponível; reconciliação não aplicada e ambiguidade preservada.');
    error.code = 'WENDKEEP_MEMORY_LOCK_BUSY';
    throw error;
  }
  return outcome;
}

function checkpointShape(checkpoint) {
  return checkpoint && typeof checkpoint === 'object'
    && Number.isInteger(checkpoint.revision) && checkpoint.revision >= 0
    && typeof checkpoint.event_cursor === 'string' && checkpoint.event_cursor
    && typeof checkpoint.state_hash === 'string' && checkpoint.state_hash;
}

function legacyEventOrder(left, right) {
  return (Number(left.base_revision ?? 0) - Number(right.base_revision ?? 0))
    || String(left.effective_at || left.observed_at).localeCompare(String(right.effective_at || right.observed_at))
    || Number(left.turn_sequence ?? 0) - Number(right.turn_sequence ?? 0)
    || String(left.event_id).localeCompare(String(right.event_id));
}

function historicalAssertOnlyCheckpoint(vault, attempt, authority, checkpoint) {
  const requiredEventIds = Array.isArray(attempt?.event_ids) ? [...attempt.event_ids] : [];
  if (!requiredEventIds.includes(checkpoint.event_cursor)) return null;

  const cursorIndex = authority.ledgerEvents
    .findIndex((event) => event.event_id === checkpoint.event_cursor);
  if (cursorIndex < 0) return null;
  const prefix = authority.ledgerEvents.slice(0, cursorIndex + 1);
  const prefixIds = new Set(prefix.map((event) => event.event_id));
  if (requiredEventIds.some((eventId) => !prefixIds.has(eventId))) return null;
  if (prefix.some((event) => event.operation !== 'assert')) return null;

  const firstByKey = [];
  const priorByKey = new Map();
  for (const event of [...prefix].sort(legacyEventOrder)) {
    const prior = priorByKey.get(event.memory_key);
    if (prior) {
      const sameActivation = Boolean(event.canonical_session_id)
        && event.canonical_session_id === prior.canonical_session_id
        && event.activation_id === prior.activation_id;
      if (!sameActivation || !Number.isInteger(event.turn_sequence)
          || event.turn_sequence <= prior.turn_sequence) return null;
    } else {
      firstByKey.push(event);
    }
    priorByKey.set(event.memory_key, event);
  }

  const legacyState = deriveMemoryProjection(vault, firstByKey);
  const currentPrefix = deriveMemoryProjection(vault, prefix);
  if (legacyState.candidates.length || currentPrefix.candidates.length) return null;
  const legacyCheckpoint = {
    revision: legacyState.revision,
    event_cursor: currentPrefix.eventCursor,
    state_hash: legacyState.stateHash,
  };
  if (!sameCheckpoint(checkpoint, legacyCheckpoint)) return null;
  return currentPrefix.checkpoint;
}

function legacyCheckpointMigration(vault, sessionId, entry, authority, fullReplay) {
  const attempt = entry?.last_memory_attempt;
  const checkpoint = attempt?.checkpoint;
  const requiredEventIds = Array.isArray(attempt?.event_ids) ? [...attempt.event_ids] : [];
  if (!checkpointShape(checkpoint) || !requiredEventIds.length) return null;
  if (entry?.memory_checkpoint !== undefined
      && !sameCheckpoint(entry.memory_checkpoint, checkpoint)) return null;
  // The pre-physical format had no explicit causal_event_cursor: event_cursor itself
  // named the reducer's causal tail while revision/hash described the full authority
  // snapshot. Historical prefixes are accepted only by the narrower assert-only proof below;
  // every other ambiguous tuple remains fail-closed for explicit human reconciliation.
  if (checkpoint.causal_event_cursor !== undefined) return null;
  if (requiredEventIds.some((eventId) => !authority.ledgerById.has(eventId))) return null;
  const matchesFullReplay = checkpoint.revision === fullReplay.revision
    && checkpoint.state_hash === fullReplay.stateHash
    && checkpoint.event_cursor === fullReplay.eventCursor;
  const nextCheckpoint = matchesFullReplay
    ? fullReplay.checkpoint
    : historicalAssertOnlyCheckpoint(vault, attempt, authority, checkpoint);
  if (!nextCheckpoint || sameCheckpoint(checkpoint, nextCheckpoint)) return null;

  const proof = validateSuccessorProof({ bySessionId: sessionId }, attempt, authority);
  return {
    sessionId,
    expectedFingerprint: attemptFingerprint(attempt),
    expectedMemoryCheckpointFingerprint: memoryCheckpointFingerprint(entry),
    originalCheckpoint: cloneJson(checkpoint),
    checkpoint: cloneJson(nextCheckpoint),
    proof,
  };
}

export function migrateLegacyMemoryCheckpoints(vault, {
  now = new Date().toISOString(), memoryLock = {},
} = {}) {
  const expectedAuthority = readMemoryAuthority(vault);
  const outcome = withMemoryLock(vault, () => {
    const authority = readMemoryAuthority(vault);
    assertAuthorityMatches(expectedAuthority, authority);
    const inspected = readSessionRegistry(vault);
    const fullReplay = deriveMemoryProjection(vault, authority.ledgerEvents);
    const plans = Object.entries(inspected.sessions || {})
      .map(([sessionId, entry]) => legacyCheckpointMigration(
        vault, sessionId, entry, authority, fullReplay,
      ))
      .filter(Boolean);
    assertAuthorityMatches(expectedAuthority, readMemoryAuthority(vault));
    if (!plans.length) return {
      status: 'unchanged', migrated: 0, sessions: [], backupPath: null,
    };

    let backupPath = null;
    let backupCreated = false;
    try {
      return mutateSessionRegistry(vault, (registry) => {
        // Validate every CAS before changing the first entry, making the batch atomic.
        for (const plan of plans) {
          const entry = registry.sessions?.[plan.sessionId];
          const attempt = entry?.last_memory_attempt;
          if (attemptFingerprint(attempt) !== plan.expectedFingerprint) {
            throw new Error(`CAS perdido: checkpoint da sessão ${plan.sessionId} mudou durante a migração estrutural.`);
          }
          if (memoryCheckpointFingerprint(entry) !== plan.expectedMemoryCheckpointFingerprint) {
            throw new Error(`CAS perdido: memory_checkpoint da sessão ${plan.sessionId} mudou durante a migração estrutural.`);
          }
        }

        const path = registryPath(vault);
        const registryArtifact = checkedVaultFile(vault, path, 'SESSION_REGISTRY da migração');
        if (registryArtifact.exists) {
          const exact = readVaultFile(
            vault, registryArtifact.target, undefined, 'SESSION_REGISTRY da migração',
          );
          backupPath = `${path}.checkpoint-migrate-${hash(exact).slice(0, 12)}.bak`;
          const backup = checkedVaultFile(vault, backupPath, 'backup da migração de checkpoint');
          if (!backup.exists) {
            copyVaultFileExclusive(vault, path, backupPath, 'backup da migração de checkpoint');
            backupCreated = true;
          }
        }

        for (const plan of plans) {
          const entry = registry.sessions[plan.sessionId];
          const reconciliationId = `memcp-${hash(`${plan.sessionId}\0${plan.expectedFingerprint}\0${plan.expectedMemoryCheckpointFingerprint}\0${canonicalMemoryJson(plan.checkpoint)}`).slice(0, 20)}`;
          entry.memory_reconciliations = [
            ...(Array.isArray(entry.memory_reconciliations) ? entry.memory_reconciliations : []),
            {
              v: 1,
              reconciliation_id: reconciliationId,
              type: 'legacy_causal_checkpoint_migrated',
              reconciled_at: now,
              causal_proof: cloneJson(plan.proof),
              original_checkpoint: cloneJson(plan.originalCheckpoint),
              checkpoint: cloneJson(plan.checkpoint),
            },
          ];
          entry.last_memory_attempt = {
            ...entry.last_memory_attempt,
            checkpoint: cloneJson(plan.checkpoint),
          };
          entry.memory_checkpoint = cloneJson(plan.checkpoint);
        }
        return {
          status: 'migrated',
          migrated: plans.length,
          sessions: plans.map((plan) => plan.sessionId),
          backupPath,
        };
      });
    } catch (error) {
      if (backupCreated && backupPath) {
        try {
          unlinkVaultFile(vault, backupPath, {
            missingOk: false, label: 'backup revertido da migração de checkpoint',
          });
        }
        catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `Migração de checkpoint falhou e o backup novo não pôde ser removido: ${error.message}`);
        }
      }
      throw error;
    }
  }, memoryLock);
  if (outcome === MEMORY_LOCK_BUSY) {
    const error = new Error('MEMORY.lock indisponível; checkpoints legados não foram migrados.');
    error.code = 'WENDKEEP_MEMORY_LOCK_BUSY';
    throw error;
  }
  return outcome;
}

export function repairMemory(vault, options = {}) {
  const repaired = repairMemoryLedger(vault);
  if (repaired.status === 'busy') return repaired;
  const projection = projectMemoryOutbox(vault);
  if (projection.status === 'busy') return { status: 'busy', repaired, projection };
  const checkpointMigration = migrateLegacyMemoryCheckpoints(vault, options);
  return {
    status: 'repaired', repaired, projection, checkpointMigration,
  };
}

export function runValidateMemoryBundle(argv) {
  const vault = option(argv, '--vault');
  if (!vault) {
    process.stderr.write('wendkeep validate-memory: --vault requer um path.\n');
    process.exitCode = 2;
    return;
  }
  if (!existsSync(vault)) {
    process.stderr.write(`wendkeep validate-memory: not found: ${vault}\n`);
    process.exitCode = 2;
    return;
  }
  const result = validateMemoryBundle(vault);
  if (!result.ok) {
    process.stderr.write(`❌  bundle de memória inválido (${result.errors.length} erro(s)):\n`);
    for (const error of result.errors) process.stderr.write(`   - ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('✅  bundle de memória v2 OK (CORE + ledger + SHARED).\n');
  process.exitCode = 0;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || '';
  return argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function memoryUsageError(message) {
  const error = new TypeError(message);
  error.code = 'WENDKEEP_MEMORY_USAGE';
  return error;
}

function parseReconcileArgs(argv) {
  const sessionId = argv[1];
  if (!sessionId || sessionId.startsWith('--')) {
    throw memoryUsageError('memory reconcile requer exatamente um <session> posicional.');
  }

  const values = new Map();
  const seen = new Set();
  let apply = false;
  const valueOptions = new Set(['--by-session', '--reason', '--vault']);

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw memoryUsageError(`memory reconcile recebeu argumento posicional extra: ${token}.`);
    }

    const equalAt = token.indexOf('=');
    const name = equalAt >= 0 ? token.slice(0, equalAt) : token;
    if (name !== '--apply' && !valueOptions.has(name)) {
      throw memoryUsageError(`memory reconcile recebeu opção desconhecida: ${name}.`);
    }
    if (seen.has(name)) throw memoryUsageError(`memory reconcile recebeu opção duplicada: ${name}.`);
    seen.add(name);

    if (name === '--apply') {
      if (equalAt >= 0) throw memoryUsageError('--apply não aceita valor.');
      apply = true;
      continue;
    }

    const value = equalAt >= 0 ? token.slice(equalAt + 1) : argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw memoryUsageError(`${name} requer valor não vazio que não comece com --.`);
    }
    values.set(name, value);
    if (equalAt < 0) index += 1;
  }

  if (!values.get('--by-session')?.trim()) {
    throw memoryUsageError('memory reconcile requer --by-session <session>.');
  }
  if (!values.get('--reason')?.trim()) {
    throw memoryUsageError('memory reconcile requer --reason <text>.');
  }

  return {
    sessionId,
    bySessionId: values.get('--by-session'),
    reason: values.get('--reason'),
    vault: values.get('--vault') || '',
    apply,
  };
}

export function runMemory(argv) {
  const [sub, positional] = argv;
  let reconcileArgs = null;
  if (sub === 'reconcile') {
    try {
      reconcileArgs = parseReconcileArgs(argv);
    } catch (error) {
      process.stderr.write(`wendkeep memory: ${error.message}\n`);
      process.exitCode = error.code === 'WENDKEEP_MEMORY_USAGE' ? 2 : 1;
      return;
    }
  }
  const vault = (reconcileArgs?.vault || option(argv, '--vault')) || process.env.OBSIDIAN_VAULT_PATH;
  if (!vault) { process.stderr.write('wendkeep memory: passe --vault <path>.\n'); process.exitCode = 2; return; }
  if (!existsSync(vault)) { process.stderr.write(`wendkeep memory: not found: ${vault}\n`); process.exitCode = 2; return; }
  try {
    let result;
    if (sub === 'status') result = memoryStatus(vault);
    else if (sub === 'migrate') result = migrateMemory(vault, { apply: argv.includes('--apply') });
    else if (sub === 'repair') result = repairMemory(vault);
    else if (sub === 'reconcile') {
      result = reconcileMemory(vault, {
        sessionId: reconcileArgs.sessionId,
        bySessionId: reconcileArgs.bySessionId,
        reason: reconcileArgs.reason,
        apply: reconcileArgs.apply,
      });
    }
    else if (sub === 'promote' || sub === 'reject') result = decideMemoryCandidate(vault, { action: sub, candidateId: positional });
    else { process.stderr.write('wendkeep memory: use status | migrate [--apply] | repair | reconcile <session> --by-session <session> --reason <text> [--apply] | promote <candidate> | reject <candidate>.\n'); process.exitCode = 2; return; }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (sub === 'status' && argv.includes('--gate')) process.exitCode = result.status === 'blocked' ? 1 : 0;
    else if (sub === 'reconcile' && reconcileArgs.apply) process.exitCode = result.health?.status === 'blocked' ? 1 : 0;
    else process.exitCode = result.ok === false ? 1 : 0;
  } catch (error) {
    process.stderr.write(`wendkeep memory: ${error.message}\n`);
    process.exitCode = 1;
  }
}
