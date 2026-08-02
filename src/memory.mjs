import { createHash } from 'node:crypto';
import {
  constants as fsConstants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
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

const TERMINAL_CANDIDATE_STATUSES = new Set(['resolved', 'rejected', 'superseded']);

function lexicalCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sanitizedCandidate(candidate, index) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`MEMORY_CANDIDATES.jsonl: candidate ${index + 1} inválido.`);
  }
  const required = ['candidate_id', 'reason', 'memory_key'];
  const missing = required.filter((field) => typeof candidate[field] !== 'string' || !candidate[field]);
  if (missing.length) {
    throw new Error(`MEMORY_CANDIDATES.jsonl: candidate ${index + 1} sem ${missing.join(', ')}.`);
  }
  if (candidate.status !== undefined && (typeof candidate.status !== 'string' || !candidate.status)) {
    throw new Error(`MEMORY_CANDIDATES.jsonl: candidate ${index + 1} possui status inválido.`);
  }
  const eventIds = candidate.event_ids ?? [];
  if (!Array.isArray(eventIds) || eventIds.some((eventId) => typeof eventId !== 'string' || !eventId)) {
    throw new Error(`MEMORY_CANDIDATES.jsonl: candidate ${index + 1} possui event_ids inválidos.`);
  }
  return {
    candidate_id: candidate.candidate_id,
    reason: candidate.reason,
    status: candidate.status || 'active',
    memory_key: candidate.memory_key,
    event_ids: [...eventIds].sort(lexicalCompare),
  };
}

export function listMemoryCandidates(vault, { activeOnly = false } = {}) {
  const candidates = readCandidates(vault)
    .map(sanitizedCandidate)
    .filter((candidate) => !activeOnly || !TERMINAL_CANDIDATE_STATUSES.has(candidate.status))
    .sort((left, right) => lexicalCompare(left.memory_key, right.memory_key)
      || lexicalCompare(left.candidate_id, right.candidate_id));
  return { status: 'ok', candidates };
}

function priorCandidateDecision(vault, candidateId) {
  return readMemoryLedger(vault).events.find(
    (event) => event.candidate_decision?.candidate_id === candidateId,
  ) || null;
}

function candidateEvent(candidate, eventId) {
  const events = Array.isArray(candidate.events) ? candidate.events : [];
  if (candidate.reason === 'conflict' && !eventId) {
    throw new Error('Candidate de conflito exige eventId (--event na CLI).');
  }
  if (!eventId) return events.length === 1 ? events[0] : null;
  const selected = events.find((event) => event.event_id === eventId);
  if (!selected) throw new Error(`event_id ${eventId} não pertence ao candidate ${candidate.candidate_id}.`);
  return selected;
}

function assertCompatibleDecision(prior, { action, eventId }) {
  const decision = prior.candidate_decision;
  const sameSelection = action !== 'promote'
    || (decision.selected_event_id || null) === (eventId || null);
  if (decision.action !== action || !sameSelection) {
    throw new Error(`Candidate ${decision.candidate_id} já possui decisão incompatível (${decision.action}).`);
  }
}

function promotedMemoryValue(value) {
  return typeof value === 'string' ? sanitizeMemoryText(value) : cloneJson(value);
}

function eventSupersedes(event) {
  if (Array.isArray(event?.supersedes)) return event.supersedes;
  return event?.supersedes_event_id ? [event.supersedes_event_id] : [];
}

function hasCompleteCausalIdentity(event) {
  return Boolean(event?.canonical_session_id && event?.activation_id && event?.source_turn_id)
    && Number.isInteger(event.activation_epoch)
    && Number.isInteger(event.turn_sequence);
}

function sameCausalLineage(left, right) {
  return hasCompleteCausalIdentity(left) && hasCompleteCausalIdentity(right)
    && left.canonical_session_id === right.canonical_session_id
    && left.activation_id === right.activation_id
    && left.activation_epoch === right.activation_epoch;
}

function promotedSupersedes(vault, candidate, selected) {
  const memberIds = new Set(Array.isArray(candidate.event_ids) ? candidate.event_ids : []);
  const ledger = readMemoryLedger(vault);
  if (ledger.status !== 'ok') throw new Error('Ledger de memória inválido durante a promoção.');
  const current = deriveMemoryProjection(vault, ledger.events)
    .records?.[candidate.memory_key]?.source;
  if (!current?.event_id || memberIds.has(current.event_id)) return [...memberIds].sort();

  const currentSelectedId = current.candidate_decision?.selected_event_id;
  const currentSelected = currentSelectedId
    ? ledger.events.find((event) => event.event_id === currentSelectedId)
    : null;
  const selectedLedger = ledger.events.find((event) => event.event_id === selected.event_id);
  const currentAncestors = eventSupersedes(current);
  const decisionMembers = Array.isArray(current.candidate_decision?.event_ids)
    ? current.candidate_decision.event_ids
    : [];
  const canonicalAncestors = [...new Set(currentAncestors)].sort();
  const canonicalDecisionMembers = [...new Set(decisionMembers)].sort();
  const currentObserved = String(current.effective_at || current.observed_at || '');
  const selectedObserved = String(selectedLedger?.effective_at || selectedLedger?.observed_at || '');
  const currentPhysicalIndex = ledger.events.findIndex((event) => event.event_id === current.event_id);
  const selectedPhysicalIndex = ledger.events.findIndex((event) => event.event_id === selected.event_id);
  const bridgeChecks = {
    legacyShape: current.operation === 'replace' && current.authority === 'verified'
      && !current.canonical_session_id && !current.source_turn_id,
    promotion: current.candidate_decision?.action === 'promote',
    selectedPresent: Boolean(currentSelected),
    selectedPersisted: Boolean(selectedLedger),
    exactDecisionMembers: canonicalAncestors.length === currentAncestors.length
      && canonicalDecisionMembers.length === decisionMembers.length
      && canonicalAncestors.length === canonicalDecisionMembers.length
      && canonicalAncestors.every((eventId, index) => eventId === canonicalDecisionMembers[index]),
    selectedSuperseded: currentAncestors.includes(currentSelectedId)
      && decisionMembers.includes(currentSelectedId),
    candidateAncestor: currentAncestors.some((eventId) => memberIds.has(eventId)),
    sameLineage: sameCausalLineage(currentSelected, selectedLedger),
    laterTurn: selectedLedger?.turn_sequence > currentSelected?.turn_sequence,
    appendedAfterCurrent: selectedPhysicalIndex > currentPhysicalIndex && currentPhysicalIndex >= 0,
    observedBeforeCurrent: selectedObserved < currentObserved,
  };
  const bridgesObservedOrder = Object.values(bridgeChecks).every(Boolean);
  if (!bridgesObservedOrder) {
    throw new Error(
      `Candidate ${candidate.candidate_id} não corresponde mais à projeção causal atual; `
      + 'recarregue os candidates antes de promover.',
    );
  }
  memberIds.add(current.event_id);
  return [...memberIds].sort();
}

function matchesPromotedAttempt(attempt, selected) {
  if (attempt?.memory_mode !== 'v2' || attempt.state !== 'projected'
      || !Array.isArray(attempt.event_ids) || !attempt.event_ids.includes(selected.event_id)) return false;
  if (attempt.activation_id && selected.activation_id
      && attempt.activation_id !== selected.activation_id) return false;
  if (Number.isInteger(attempt.activation_epoch) && Number.isInteger(selected.activation_epoch)
      && attempt.activation_epoch !== selected.activation_epoch) return false;
  if (Number.isInteger(attempt.turn_sequence) && Number.isInteger(selected.turn_sequence)
      && attempt.turn_sequence !== selected.turn_sequence) return false;
  if (attempt.canonical_session_id && selected.canonical_session_id
      && attempt.canonical_session_id !== selected.canonical_session_id) return false;
  return true;
}

function snapshotPromotedAttemptCheckpoints(vault, selected) {
  if (!selected) return new Map();
  const registry = readSessionRegistry(vault);
  return new Map(Object.entries(registry.sessions || {})
    .filter(([, entry]) => matchesPromotedAttempt(entry?.last_memory_attempt, selected))
    .map(([sessionId, entry]) => [sessionId, {
      attempt: attemptFingerprint(entry.last_memory_attempt),
      checkpoint: memoryCheckpointFingerprint(entry),
    }]));
}

function refreshPromotedAttemptCheckpoint(vault, {
  candidateId, decisionEventId, selected, checkpoint, decidedAt, expectedAttempts,
}) {
  if (!selected || !checkpoint || !expectedAttempts?.size) return 0;
  return mutateSessionRegistry(vault, (registry) => {
    let refreshed = 0;
    for (const [sessionId, entry] of Object.entries(registry.sessions || {})) {
      const expected = expectedAttempts.get(sessionId);
      if (!expected) continue;
      const attempt = entry?.last_memory_attempt;
      if (attemptFingerprint(attempt) !== expected.attempt
          || memoryCheckpointFingerprint(entry) !== expected.checkpoint) continue;

      const alreadyAudited = (entry.memory_candidate_decisions || [])
        .some((audit) => audit.decision_event_id === decisionEventId);
      if (alreadyAudited && sameCheckpoint(attempt.checkpoint, checkpoint)
          && sameCheckpoint(entry.memory_checkpoint, checkpoint)) continue;
      const originalCheckpoint = cloneJson(attempt.checkpoint || entry.memory_checkpoint || null);
      attempt.checkpoint = cloneJson(checkpoint);
      entry.memory_checkpoint = cloneJson(checkpoint);
      entry.memory_status = 'projected';
      if (!alreadyAudited) {
        entry.memory_candidate_decisions = [
          ...(Array.isArray(entry.memory_candidate_decisions) ? entry.memory_candidate_decisions : []),
          {
            v: 1,
            type: 'candidate_checkpoint_refreshed',
            candidate_id: candidateId,
            decision_event_id: decisionEventId,
            selected_event_id: selected.event_id,
            decided_at: decidedAt,
            original_checkpoint: originalCheckpoint,
            checkpoint: cloneJson(checkpoint),
          },
        ];
      }
      refreshed += 1;
    }
    return refreshed;
  });
}

export function decideMemoryCandidate(vault, {
  action, candidateId, value, eventId, beforeCheckpointRefresh,
} = {}) {
  if (!['promote', 'reject'].includes(action)) throw new TypeError('action deve ser promote ou reject.');
  if (!candidateId) throw new TypeError('candidateId é obrigatório.');
  const preflight = projectMemoryOutbox(vault);
  if (preflight.status === 'busy') return { status: 'busy', candidateId };
  const prior = priorCandidateDecision(vault, candidateId);
  if (prior) {
    assertCompatibleDecision(prior, { action, eventId });
    const selected = action === 'promote' && prior.candidate_decision.selected_event_id
      ? readMemoryLedger(vault).events.find(
        (event) => event.event_id === prior.candidate_decision.selected_event_id,
      )
      : null;
    const expectedAttempts = snapshotPromotedAttemptCheckpoints(vault, selected);
    beforeCheckpointRefresh?.();
    const checkpointRefreshed = action === 'promote'
      ? refreshPromotedAttemptCheckpoint(vault, {
        candidateId,
        decisionEventId: prior.event_id,
        selected,
        checkpoint: preflight.checkpoint,
        decidedAt: prior.observed_at,
        expectedAttempts,
      })
      : 0;
    return {
      status: action === 'promote' ? 'promoted' : 'rejected',
      candidateId,
      eventId: prior.event_id,
      alreadyApplied: true,
      checkpointRefreshed,
      projection: preflight,
    };
  }
  const candidates = readCandidates(vault);
  const candidate = candidates.find((item) => item.candidate_id === candidateId);
  if (!candidate) throw new Error(`Candidate não encontrado: ${candidateId}`);
  if (action === 'promote' && candidate.reason === 'blocked_by_core') {
    throw new Error(`Candidate ${candidateId} está blocked_by_core; edite CORE ou rejeite o candidate.`);
  }
  const selected = action === 'promote' ? candidateEvent(candidate, eventId) : null;
  const expectedAttempts = snapshotPromotedAttemptCheckpoints(vault, selected);
  const selectedValue = selected?.value ?? value ?? candidate.value ?? candidate.proposed_value;
  if (action === 'promote' && selectedValue === undefined) {
    throw new Error(`Candidate ${candidateId} não contém valor promovível.`);
  }
  const supersedes = action === 'promote' && selected
    ? promotedSupersedes(vault, candidate, selected)
    : [];
  const now = new Date().toISOString();
  const decision = {
    candidate_id: candidateId,
    action,
    event_ids: Array.isArray(candidate.event_ids) ? [...candidate.event_ids].sort() : [],
    ...(selected ? { selected_event_id: selected.event_id } : {}),
  };
  const event = {
    v: 1,
    event_id: `cli-${action}-${hash(`${candidateId}\0${selected?.event_id || ''}`).slice(0, 20)}`,
    project_id: projectId(vault),
    memory_key: action === 'promote' ? candidate.memory_key : `candidate.decision.${candidateId}`,
    operation: action === 'promote' && selected ? 'replace' : 'assert',
    value: action === 'promote' ? promotedMemoryValue(selectedValue) : 'rejected',
    authority: 'verified',
    ...(selected?.canonical_session_id
      ? { canonical_session_id: selected.canonical_session_id }
      : {}),
    activation_id: selected?.activation_id || 'wendkeep-memory-cli',
    ...(Number.isInteger(selected?.activation_epoch) ? { activation_epoch: selected.activation_epoch } : {}),
    turn_sequence: selected?.turn_sequence ?? 0,
    ...(selected?.source_turn_id ? { source_turn_id: selected.source_turn_id } : {}),
    observed_at: now,
    evidence: [`candidate:${candidateId}`],
    candidate_decision: decision,
    ...(selected ? { supersedes } : {}),
  };
  enqueueMemoryEvent(vault, event);
  const projection = projectMemoryOutbox(vault);
  if (projection.status === 'busy') return { status: 'busy', candidateId };
  beforeCheckpointRefresh?.();
  const checkpointRefreshed = action === 'promote'
    ? refreshPromotedAttemptCheckpoint(vault, {
      candidateId,
      decisionEventId: event.event_id,
      selected,
      checkpoint: projection.checkpoint,
      decidedAt: now,
      expectedAttempts,
    })
    : 0;
  return {
    status: action === 'promote' ? 'promoted' : 'rejected',
    candidateId,
    eventId: event.event_id,
    checkpointRefreshed,
    projection,
  };
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

function fieldSnapshot(value, key) {
  const present = Object.prototype.hasOwnProperty.call(value || {}, key);
  return { present, value: present ? (value[key] ?? null) : null };
}

function attemptAuthorityFingerprint(entry, attempt) {
  const activation = entry?.activations?.[attempt?.activation_id];
  return hash(canonicalMemoryJson({
    status: fieldSnapshot(entry, 'status'),
    active_activation_id: fieldSnapshot(entry, 'active_activation_id'),
    activation_epoch: fieldSnapshot(entry, 'activation_epoch'),
    last_turn_id: fieldSnapshot(entry, 'last_turn_id'),
    last_turn_sequence: fieldSnapshot(entry, 'last_turn_sequence'),
    turn_sequence: fieldSnapshot(entry?.turn_sequences, attempt?.turn_id),
    activation: {
      status: fieldSnapshot(activation, 'status'),
      epoch: fieldSnapshot(activation, 'epoch'),
      last_stop_turn_id: fieldSnapshot(activation, 'last_stop_turn_id'),
      last_stop_turn_sequence: fieldSnapshot(activation, 'last_stop_turn_sequence'),
      last_turn_sequence: fieldSnapshot(activation, 'last_turn_sequence'),
    },
    memory_status: fieldSnapshot(entry, 'memory_status'),
    memory_activation_id: fieldSnapshot(entry, 'memory_activation_id'),
  }));
}

function ownsAttemptContext(entry, attempt) {
  const activation = entry?.activations?.[attempt?.activation_id];
  return entry?.status === 'active'
    && entry.active_activation_id === attempt.activation_id
    && entry.activation_epoch === attempt.activation_epoch
    && activation?.status === 'active'
    && activation.epoch === attempt.activation_epoch
    && entry.last_turn_id === attempt.turn_id
    && entry.last_turn_sequence === attempt.turn_sequence
    && entry.turn_sequences?.[attempt.turn_id] === attempt.turn_sequence
    && activation.last_stop_turn_id === attempt.turn_id
    && activation.last_stop_turn_sequence === attempt.turn_sequence
    && activation.last_turn_sequence === attempt.turn_sequence
    && entry.memory_status === attempt.state
    && entry.memory_activation_id === attempt.activation_id;
}

function attemptEventMatches(event, attempt, expectedProjectId) {
  return event?.project_id === expectedProjectId
    && event.canonical_session_id === attempt.canonical_session_id
    && event.activation_id === attempt.activation_id
    && event.activation_epoch === attempt.activation_epoch
    && event.source_turn_id === attempt.turn_id
    && event.turn_sequence === attempt.turn_sequence;
}

function readAttemptOutboxEvents(vault, eventIds) {
  const events = [];
  for (const eventId of eventIds) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(eventId)) return null;
    const path = brainPath(vault, join('memory-outbox', `${eventId}.json`));
    const checked = checkedVaultFile(vault, path, `outbox do attempt ${eventId}`);
    if (!checked.exists) return null;
    try {
      const event = JSON.parse(readVaultFile(
        vault, checked.target, 'utf8', `outbox do attempt ${eventId}`,
      ));
      if (event?.event_id !== eventId) return null;
      events.push(event);
    } catch (error) {
      if (error?.code === 'VAULT_PATH_UNSAFE') throw error;
      return null;
    }
  }
  return events;
}

function targetOutboxIsAbsent(vault, eventIds) {
  return eventIds.every((eventId) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(eventId)) return false;
    const path = brainPath(vault, join('memory-outbox', `${eventId}.json`));
    return !checkedVaultFile(vault, path, `outbox do attempt ${eventId}`).exists;
  });
}

function freezeRepairAttemptAcknowledgements(vault, options = {}) {
  const result = withMemoryLock(vault, () => {
    const expectedProjectId = projectId(vault);
    const registry = readSessionRegistry(vault);
    const frozen = [];
    let pending = false;
    for (const [sessionId, entry] of Object.entries(registry.sessions || {})) {
      const attempt = entry?.last_memory_attempt;
      const eventIds = Array.isArray(attempt?.event_ids) ? [...attempt.event_ids] : [];
      if (attempt?.memory_mode !== 'v2' || attempt.disposition !== 'applied'
          || !['enqueued', 'degraded'].includes(attempt.state)) continue;
      pending = true;
      if (!eventIds.length || new Set(eventIds).size !== eventIds.length
          || eventIds.some((eventId) => typeof eventId !== 'string' || !eventId)
          || sessionId !== attempt.canonical_session_id
          || !ownsAttemptContext(entry, attempt)) continue;
      const outboxEvents = readAttemptOutboxEvents(vault, eventIds);
      if (!outboxEvents
          || outboxEvents.some((event) => !attemptEventMatches(event, attempt, expectedProjectId))) {
        continue;
      }
      frozen.push({
        sessionId,
        projectId: expectedProjectId,
        eventIds,
        eventFingerprints: new Map(outboxEvents.map((event) => [
          event.event_id, hash(canonicalMemoryJson(event)),
        ])),
        attemptFingerprint: attemptFingerprint(attempt),
        checkpointFingerprint: memoryCheckpointFingerprint(entry),
        authorityFingerprint: attemptAuthorityFingerprint(entry, attempt),
      });
    }
    if (pending) {
      const ledger = readLedgerForValidation(vault, { projectId: expectedProjectId });
      if (!ledger.ok) {
        throw new Error(`Ledger físico inválido para acknowledgement de repair: ${(ledger.errors || []).join(' ')}`);
      }
    }
    return { attempts: frozen, pending };
  }, options.memoryLock || {});
  return result;
}

function publishedProjectionMatches(vault, events, projection) {
  const prepared = prepareMemoryProjection(vault, events);
  if (!sameCheckpoint(prepared.checkpoint, projection?.checkpoint)) return false;
  const shared = readVaultFile(
    vault, brainPath(vault, SHARED), 'utf8', 'projeção SHARED_MEMORY.md',
  );
  const candidates = readVaultFile(
    vault, brainPath(vault, CANDIDATES), 'utf8', 'projeção MEMORY_CANDIDATES.jsonl',
  );
  return shared === prepared.sharedContent && candidates === prepared.candidatesContent;
}

function acknowledgeRepairAttempts(vault, frozen, projection, options = {}) {
  const receipt = new Set(Array.isArray(projection?.consumedEventIds)
    ? projection.consumedEventIds
    : []);
  const covered = frozen.filter((item) => item.eventIds.every((eventId) => receipt.has(eventId)));
  if (!covered.length) {
    return {
      status: 'unchanged', eligible: frozen.length, acknowledged: 0, stale: frozen.length,
    };
  }

  const outcome = withMemoryLock(vault, () => {
    if (options.beforeAttemptAcknowledgement) options.beforeAttemptAcknowledgement();
    const ledger = readMemoryLedger(vault);
    if (ledger.status !== 'ok' || !publishedProjectionMatches(vault, ledger.events, projection)) {
      return {
        status: 'attention', eligible: frozen.length, acknowledged: 0, stale: frozen.length,
      };
    }
    const byId = new Map(ledger.events.map((event) => [event.event_id, event]));
    const valid = covered.filter((item) => {
      if (projectId(vault) !== item.projectId || !targetOutboxIsAbsent(vault, item.eventIds)) {
        return false;
      }
      return item.eventIds.every((eventId) => {
        const event = byId.get(eventId);
        return event
          && item.eventFingerprints.get(eventId) === hash(canonicalMemoryJson(event));
      });
    });
    if (!valid.length) {
      return {
        status: 'attention', eligible: frozen.length, acknowledged: 0, stale: frozen.length,
      };
    }

    const acknowledged = mutateSessionRegistry(vault, (registry) => {
      const sessionIds = [];
      for (const item of valid) {
        const entry = registry.sessions?.[item.sessionId];
        const attempt = entry?.last_memory_attempt;
        if (!attempt || attemptFingerprint(attempt) !== item.attemptFingerprint
            || memoryCheckpointFingerprint(entry) !== item.checkpointFingerprint
            || attemptAuthorityFingerprint(entry, attempt) !== item.authorityFingerprint
            || !ownsAttemptContext(entry, attempt)
            || item.eventIds.some((eventId) => !attemptEventMatches(
              byId.get(eventId), attempt, item.projectId,
            ))) continue;
        attempt.state = 'projected';
        attempt.checkpoint = cloneJson(projection.checkpoint);
        entry.memory_status = 'projected';
        entry.memory_checkpoint = cloneJson(projection.checkpoint);
        sessionIds.push(item.sessionId);
      }
      return sessionIds;
    });
    return {
      status: acknowledged.length === valid.length ? 'acknowledged' : 'attention',
      eligible: frozen.length,
      acknowledged: acknowledged.length,
      stale: frozen.length - acknowledged.length,
      sessionIds: acknowledged,
    };
  }, options.memoryLock || {});
  return outcome === MEMORY_LOCK_BUSY
    ? {
      status: 'busy', eligible: frozen.length, acknowledged: 0, stale: frozen.length,
    }
    : outcome;
}

function normalizeProjectedAttemptRecoveryRequest({ sessionId } = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    throw new TypeError('sessionId é obrigatório para recuperar attempt projetado.');
  }
  return { sessionId: normalizedSessionId };
}

function readStrictSessionRegistry(vault) {
  const path = registryPath(vault);
  const checked = checkedVaultFile(vault, path, 'SESSION_REGISTRY da recuperação', {
    allowMissing: false,
  });
  const generationBefore = filesystemGeneration(checked.target);
  let bytes;
  try {
    bytes = readVaultFile(vault, checked.target, undefined, 'SESSION_REGISTRY da recuperação');
  } catch (error) {
    throw new Error(`SESSION_REGISTRY ausente ou ilegível para recuperação: ${error?.message || error}`);
  }
  const generationAfter = filesystemGeneration(checked.target);
  if (canonicalMemoryJson(generationBefore) !== canonicalMemoryJson(generationAfter)) {
    throw new Error('SESSION_REGISTRY mudou durante o preflight da recuperação targeted.');
  }
  let registry;
  try {
    registry = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`SESSION_REGISTRY contém JSON inválido para recuperação: ${error?.message || error}`);
  }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)
      || !Number.isInteger(registry.version) || registry.version < 2
      || !registry.sessions || typeof registry.sessions !== 'object'
      || Array.isArray(registry.sessions)) {
    throw new Error('SESSION_REGISTRY inválido para recuperação targeted.');
  }
  return {
    registry,
    registryHash: hash(canonicalMemoryJson(registry)),
    registryGeneration: generationAfter,
  };
}

function filesystemGeneration(path) {
  const stat = statSync(path, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    birthtimeNs: String(stat.birthtimeNs),
  };
}

function projectedRecoveryOutboxProof(vault) {
  const path = brainPath(vault, 'memory-outbox');
  const checked = assertVaultPathSafe(vault, path, {
    allowMissing: true,
    expectedType: 'directory',
    label: 'diretório memory-outbox da recuperação',
  });
  if (!checked.exists) return { exists: false, entries: [] };

  const namesBefore = readdirSync(checked.target).sort();
  const entries = namesBefore.map((name) => {
    const memberPath = join(checked.target, name);
    const member = checkedVaultFile(
      vault, memberPath, `membro ${name} da memory-outbox`, { allowMissing: false },
    );
    const bytes = readVaultFile(
      vault, member.target, undefined, `membro ${name} da memory-outbox`,
    );
    let event;
    try {
      event = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new Error(`Membro ${name} da memory-outbox contém JSON inválido: ${error?.message || error}`);
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)
        || typeof event.event_id !== 'string' || !event.event_id.trim()) {
      throw new Error(`Membro ${name} da memory-outbox não contém event_id válido.`);
    }
    return {
      name,
      eventId: event.event_id,
      generation: filesystemGeneration(member.target),
      hash: byteHash(bytes),
    };
  });
  const namesAfter = readdirSync(checked.target).sort();
  if (canonicalMemoryJson(namesBefore) !== canonicalMemoryJson(namesAfter)) {
    throw new Error('memory-outbox mudou durante o preflight da recuperação targeted.');
  }
  return {
    exists: true,
    generation: filesystemGeneration(checked.target),
    entries,
  };
}

function recoveryContextFingerprint(entry, attempt) {
  return hash(canonicalMemoryJson({
    status: fieldSnapshot(entry, 'status'),
    session_id: fieldSnapshot(entry, 'session_id'),
    activation_id: fieldSnapshot(entry, 'activation_id'),
    active_activation_id: fieldSnapshot(entry, 'active_activation_id'),
    activation_epoch: fieldSnapshot(entry, 'activation_epoch'),
    last_turn_id: fieldSnapshot(entry, 'last_turn_id'),
    last_turn_sequence: fieldSnapshot(entry, 'last_turn_sequence'),
    turn_sequences: cloneJson(entry?.turn_sequences || null),
    activation: cloneJson(entry?.activations?.[attempt?.activation_id] || null),
    memory_status: fieldSnapshot(entry, 'memory_status'),
    memory_activation_id: fieldSnapshot(entry, 'memory_activation_id'),
  }));
}

function recoveryRegistryProof(entry, attempt) {
  return {
    attemptFingerprint: attemptFingerprint(attempt),
    contextFingerprint: recoveryContextFingerprint(entry, attempt),
    checkpointFingerprint: memoryCheckpointFingerprint(entry),
  };
}

function validStoredProjectedCheckpoint(vault, authority, attempt, entry) {
  if (!checkpointShape(attempt?.checkpoint)
      || !sameCheckpoint(attempt.checkpoint, entry?.memory_checkpoint)) return false;
  const cursorIndex = authority.ledgerEvents
    .findIndex((event) => event.event_id === attempt.checkpoint.event_cursor);
  if (cursorIndex < 0) return false;
  const prefix = authority.ledgerEvents.slice(0, cursorIndex + 1);
  const prefixIds = new Set(prefix.map((event) => event.event_id));
  if (attempt.event_ids.some((eventId) => !prefixIds.has(eventId))) return false;
  return sameCheckpoint(
    attempt.checkpoint,
    prepareMemoryProjection(vault, prefix).checkpoint,
  );
}

function prepareProjectedAttemptRecovery(vault, rawRequest) {
  const request = normalizeProjectedAttemptRecoveryRequest(rawRequest);
  const authority = readMemoryAuthority(vault);
  const registrySnapshot = readStrictSessionRegistry(vault);
  const { registry } = registrySnapshot;
  const outboxProof = projectedRecoveryOutboxProof(vault);
  const entry = registry.sessions[request.sessionId];
  if (!entry) throw new Error(`Sessão não encontrada para recuperação: ${request.sessionId}`);

  const attempt = entry.last_memory_attempt;
  const eventIds = Array.isArray(attempt?.event_ids) ? [...attempt.event_ids] : [];
  if (attempt?.memory_mode !== 'v2' || attempt?.disposition !== 'applied'
      || !['enqueued', 'degraded', 'projected'].includes(attempt?.state)) {
    throw new Error(`Attempt da sessão ${request.sessionId} não é v2/applied recuperável.`);
  }
  if (!eventIds.length
      || eventIds.some((eventId) => typeof eventId !== 'string' || !eventId.trim())
      || new Set(eventIds).size !== eventIds.length) {
    throw new Error('Attempt recuperável deve possuir event_ids não vazios e únicos.');
  }
  if (request.sessionId !== attempt.canonical_session_id
      || (Object.prototype.hasOwnProperty.call(entry, 'session_id')
        && entry.session_id !== request.sessionId)
      || !ownsAttemptContext(entry, attempt)) {
    throw new Error('Contexto causal do attempt não pertence mais à sessão ativa.');
  }

  const eventIndexes = eventIds.map((eventId) => (
    authority.ledgerEvents.findIndex((event) => event.event_id === eventId)
  ));
  if (eventIndexes.some((index) => index < 0)) {
    throw new Error('Attempt recuperável referencia event_ids ausentes do ledger.');
  }
  for (const eventId of eventIds) {
    if (!attemptEventMatches(authority.ledgerById.get(eventId), attempt, authority.projectId)) {
      throw new Error(`Identidade causal inválida no evento ${eventId}.`);
    }
  }
  const lastAttemptEventIndex = Math.max(...eventIndexes);
  if (authority.ledgerEvents.slice(lastAttemptEventIndex + 1)
    .some((event) => event.canonical_session_id === request.sessionId)) {
    throw new Error('Existe evento posterior da mesma sessão; attempt histórico não pode ser recuperado.');
  }
  if (!targetOutboxIsAbsent(vault, eventIds)
      || outboxProof.entries.some((item) => eventIds.includes(item.eventId))) {
    throw new Error('A outbox ainda contém evento alvo; recuperação targeted recusada.');
  }

  const projection = prepareMemoryProjection(vault, authority.ledgerEvents);
  const sharedBytes = readVaultFile(
    vault, brainPath(vault, SHARED), undefined, 'projeção SHARED_MEMORY.md',
  );
  const candidatesBytes = readVaultFile(
    vault, brainPath(vault, CANDIDATES), undefined, 'projeção MEMORY_CANDIDATES.jsonl',
  );
  if (!sharedBytes.equals(Buffer.from(projection.sharedContent))
      || !candidatesBytes.equals(Buffer.from(projection.candidatesContent))) {
    throw new Error('SHARED/candidates divergem da autoridade integral do ledger.');
  }
  assertAuthorityMatches(authority, readMemoryAuthority(vault));

  const alreadyProjected = attempt.state === 'projected';
  if (alreadyProjected && !validStoredProjectedCheckpoint(vault, authority, attempt, entry)) {
    throw new Error('Attempt projected não possui checkpoint armazenado válido.');
  }

  return {
    request,
    eligible: !alreadyProjected,
    alreadyProjected,
    checkpoint: cloneJson(alreadyProjected ? attempt.checkpoint : projection.checkpoint),
    proof: {
      projectId: authority.projectId,
      projectHash: authority.projectHash,
      coreHash: authority.coreHash,
      ledgerHash: authority.ledgerHash,
      sharedHash: byteHash(sharedBytes),
      candidatesHash: byteHash(candidatesBytes),
      outboxProof,
      registryHash: registrySnapshot.registryHash,
      registryGeneration: registrySnapshot.registryGeneration,
      eventIds,
      eventFingerprints: eventIds.map((eventId) => (
        hash(canonicalMemoryJson(authority.ledgerById.get(eventId)))
      )),
      ...recoveryRegistryProof(entry, attempt),
    },
  };
}

function projectedAttemptRecoveryResult(prepared, status) {
  return {
    status,
    eligible: prepared.eligible,
    sessionId: prepared.request.sessionId,
    checkpoint: cloneJson(prepared.checkpoint),
  };
}

function assertProjectedAttemptRecoveryProof(expected, actual) {
  if (canonicalMemoryJson(expected.proof) !== canonicalMemoryJson(actual.proof)
      || expected.alreadyProjected !== actual.alreadyProjected
      || !sameCheckpoint(expected.checkpoint, actual.checkpoint)) {
    throw new Error('CAS perdido: autoridade, attempt, contexto causal ou checkpoint mudou.');
  }
}

export function inspectProjectedAttemptRecovery(vault, { sessionId } = {}) {
  const prepared = prepareProjectedAttemptRecovery(vault, { sessionId });
  return projectedAttemptRecoveryResult(
    prepared, prepared.alreadyProjected ? 'unchanged' : 'eligible',
  );
}

export function recoverProjectedAttempt(vault, {
  sessionId,
  apply = false,
  beforeRegistryMutation,
  memoryLock = {},
} = {}) {
  const prepared = prepareProjectedAttemptRecovery(vault, { sessionId });
  if (prepared.alreadyProjected) {
    return projectedAttemptRecoveryResult(prepared, 'unchanged');
  }
  if (!apply) return projectedAttemptRecoveryResult(prepared, 'dry-run');

  const outcome = withMemoryLock(vault, () => {
    const locked = prepareProjectedAttemptRecovery(vault, prepared.request);
    assertProjectedAttemptRecoveryProof(prepared, locked);
    if (beforeRegistryMutation) beforeRegistryMutation();
    const current = prepareProjectedAttemptRecovery(vault, prepared.request);
    assertProjectedAttemptRecoveryProof(locked, current);

    mutateSessionRegistry(vault, (registry) => {
      const entry = registry.sessions?.[current.request.sessionId];
      const attempt = entry?.last_memory_attempt;
      const expectedRegistryProof = {
        attemptFingerprint: current.proof.attemptFingerprint,
        contextFingerprint: current.proof.contextFingerprint,
        checkpointFingerprint: current.proof.checkpointFingerprint,
      };
      if (!entry || !attempt
          || hash(canonicalMemoryJson(registry)) !== current.proof.registryHash
          || canonicalMemoryJson(filesystemGeneration(registryPath(vault)))
            !== canonicalMemoryJson(current.proof.registryGeneration)
          || canonicalMemoryJson(recoveryRegistryProof(entry, attempt))
            !== canonicalMemoryJson(expectedRegistryProof)) {
        throw new Error('CAS perdido: registry mudou antes do acknowledgement targeted.');
      }
      attempt.state = 'projected';
      attempt.checkpoint = cloneJson(current.checkpoint);
      entry.memory_status = 'projected';
      entry.memory_activation_id = attempt.activation_id;
      entry.memory_checkpoint = cloneJson(current.checkpoint);
    });
    return projectedAttemptRecoveryResult(current, 'applied');
  }, memoryLock);

  if (outcome === MEMORY_LOCK_BUSY) {
    const error = new Error('MEMORY.lock indisponível; recuperação targeted não foi aplicada.');
    error.code = 'WENDKEEP_MEMORY_LOCK_BUSY';
    throw error;
  }
  return outcome;
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

function deferredAssertReplayCheckpointMigration(
  sessionId, entry, authority, legacyReplay, fullReplay,
) {
  const attempt = entry?.last_memory_attempt;
  const checkpoint = attempt?.checkpoint;
  if (attempt?.memory_mode !== 'v2' || attempt?.state !== 'projected'
      || attempt?.disposition !== 'applied' || !checkpointShape(checkpoint)) return null;
  if (!Object.prototype.hasOwnProperty.call(entry, 'memory_checkpoint')
      || !sameCheckpoint(entry.memory_checkpoint, checkpoint)
      || !sameCheckpoint(checkpoint, legacyReplay.checkpoint)
      || sameCheckpoint(checkpoint, fullReplay.checkpoint)) return null;

  const requiredEventIds = Array.isArray(attempt.event_ids) ? [...attempt.event_ids] : [];
  if (!requiredEventIds.length || new Set(requiredEventIds).size !== requiredEventIds.length) return null;
  const current = fullReplay.records?.['handoff.latest']?.source;
  if (!current?.event_id || !requiredEventIds.includes(current.event_id)) return null;
  const relevantLegacyCandidate = legacyReplay.candidates.some(
    (candidate) => candidate.memory_key === 'handoff.latest'
      && candidate.event_ids.includes(current.event_id),
  );
  const relevantCandidateStillReal = fullReplay.candidates.some(
    (candidate) => candidate.memory_key === 'handoff.latest',
  );
  if (!relevantLegacyCandidate || relevantCandidateStillReal) return null;

  const currentIdentity = {
    canonical_session_id: current.canonical_session_id,
    activation_id: current.activation_id,
    activation_epoch: current.activation_epoch,
    source_turn_id: current.source_turn_id,
    turn_sequence: current.turn_sequence,
  };
  if (currentIdentity.canonical_session_id !== sessionId
      || attempt.canonical_session_id !== currentIdentity.canonical_session_id
      || attempt.activation_id !== currentIdentity.activation_id
      || attempt.activation_epoch !== currentIdentity.activation_epoch
      || attempt.turn_id !== currentIdentity.source_turn_id
      || attempt.turn_sequence !== currentIdentity.turn_sequence) return null;

  const newerAttemptEvent = authority.ledgerEvents.some((event) => (
    event.canonical_session_id === currentIdentity.canonical_session_id
      && event.activation_id === currentIdentity.activation_id
      && event.activation_epoch === currentIdentity.activation_epoch
      && Number.isInteger(event.turn_sequence)
      && event.turn_sequence > currentIdentity.turn_sequence
  ));
  if (newerAttemptEvent) return null;

  const proof = validateSuccessorProof({ bySessionId: sessionId }, attempt, authority);
  return {
    sessionId,
    expectedFingerprint: attemptFingerprint(attempt),
    expectedMemoryCheckpointFingerprint: memoryCheckpointFingerprint(entry),
    originalCheckpoint: cloneJson(checkpoint),
    checkpoint: cloneJson(fullReplay.checkpoint),
    proof,
    migrationType: 'deferred_assert_replay_migrated',
    eventIds: requiredEventIds,
  };
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
    migrationType: 'legacy_causal_checkpoint_migrated',
    eventIds: requiredEventIds,
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
    const legacyReplay = deriveMemoryProjection(vault, authority.ledgerEvents, {
      resolveDeferredAsserts: false,
    });
    const fullReplay = deriveMemoryProjection(vault, authority.ledgerEvents);
    const plans = Object.entries(inspected.sessions || {})
      .map(([sessionId, entry]) => deferredAssertReplayCheckpointMigration(
        sessionId, entry, authority, legacyReplay, fullReplay,
      ) || legacyCheckpointMigration(vault, sessionId, entry, authority, fullReplay))
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
          const reconciliationSeed = plan.migrationType === 'legacy_causal_checkpoint_migrated'
            ? `${plan.sessionId}\0${plan.expectedFingerprint}\0${plan.expectedMemoryCheckpointFingerprint}\0${canonicalMemoryJson(plan.checkpoint)}`
            : `${plan.migrationType}\0${plan.sessionId}\0${plan.expectedFingerprint}\0${plan.expectedMemoryCheckpointFingerprint}\0${canonicalMemoryJson(plan.checkpoint)}`;
          const reconciliationId = `memcp-${hash(reconciliationSeed).slice(0, 20)}`;
          entry.memory_reconciliations = [
            ...(Array.isArray(entry.memory_reconciliations) ? entry.memory_reconciliations : []),
            {
              v: 1,
              reconciliation_id: reconciliationId,
              type: plan.migrationType,
              reconciled_at: now,
              ...(plan.migrationType === 'deferred_assert_replay_migrated'
                ? { event_ids: [...plan.eventIds] }
                : {}),
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
  if (options.beforeAttemptFreeze) options.beforeAttemptFreeze();
  const acknowledgementPreflight = freezeRepairAttemptAcknowledgements(vault, options);
  if (acknowledgementPreflight === MEMORY_LOCK_BUSY) {
    return { status: 'busy', stage: 'attempt-freeze' };
  }
  const frozenAttempts = acknowledgementPreflight.attempts;
  const repaired = acknowledgementPreflight.pending
    ? { status: 'unchanged', repairedLines: 0, backupPath: null }
    : repairMemoryLedger(vault);
  if (repaired.status === 'busy') return repaired;
  const projection = projectMemoryOutbox(vault);
  if (projection.status === 'busy') return { status: 'busy', repaired, projection };
  const attemptAcknowledgements = acknowledgeRepairAttempts(
    vault, frozenAttempts, projection, options,
  );
  const checkpointMigration = migrateLegacyMemoryCheckpoints(vault, options);
  return {
    status: 'repaired',
    repaired,
    projection,
    attemptAcknowledgements,
    checkpointMigration,
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

function parseRecoverAttemptArgs(argv) {
  const positionals = [];
  const seen = new Set();
  let apply = false;
  let vault = '';

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      if (positionals.length > 1) {
        throw memoryUsageError(`memory recover-attempt recebeu argumento posicional extra: ${token}.`);
      }
      continue;
    }

    const equalAt = token.indexOf('=');
    const name = equalAt >= 0 ? token.slice(0, equalAt) : token;
    if (name !== '--apply' && name !== '--vault') {
      throw memoryUsageError(`memory recover-attempt recebeu opção desconhecida: ${name}.`);
    }
    if (seen.has(name)) {
      throw memoryUsageError(`memory recover-attempt recebeu opção duplicada: ${name}.`);
    }
    seen.add(name);

    if (name === '--apply') {
      if (equalAt >= 0) throw memoryUsageError('--apply não aceita valor.');
      apply = true;
      continue;
    }

    const value = equalAt >= 0 ? token.slice(equalAt + 1) : argv[index + 1];
    if (!value || !value.trim() || value.startsWith('--')) {
      throw memoryUsageError('--vault requer valor não vazio que não comece com --.');
    }
    vault = value;
    if (equalAt < 0) index += 1;
  }

  if (positionals.length !== 1) {
    throw memoryUsageError('memory recover-attempt requer exatamente uma sessão obrigatória.');
  }

  return {
    sessionId: positionals[0],
    apply,
    vault,
  };
}

function parseCandidatesArgs(argv) {
  const seen = new Set();
  let activeOnly = false;
  let vault = '';

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw memoryUsageError(`memory candidates recebeu argumento posicional extra: ${token}.`);
    }

    const equalAt = token.indexOf('=');
    const name = equalAt >= 0 ? token.slice(0, equalAt) : token;
    if (name !== '--active' && name !== '--vault') {
      throw memoryUsageError(`memory candidates recebeu opção desconhecida: ${name}.`);
    }
    if (seen.has(name)) {
      throw memoryUsageError(`memory candidates recebeu opção duplicada: ${name}.`);
    }
    seen.add(name);

    if (name === '--active') {
      if (equalAt >= 0) throw memoryUsageError('--active não aceita valor.');
      activeOnly = true;
      continue;
    }

    const value = equalAt >= 0 ? token.slice(equalAt + 1) : argv[index + 1];
    if (!value || !value.trim() || value.startsWith('--')) {
      throw memoryUsageError('--vault requer valor não vazio que não comece com --.');
    }
    vault = value;
    if (equalAt < 0) index += 1;
  }

  return { activeOnly, vault };
}

export function runMemory(argv) {
  const [sub, positional] = argv;
  let reconcileArgs = null;
  let recoverAttemptArgs = null;
  let candidatesArgs = null;
  if (sub === 'reconcile') {
    try {
      reconcileArgs = parseReconcileArgs(argv);
    } catch (error) {
      process.stderr.write(`wendkeep memory: ${error.message}\n`);
      process.exitCode = error.code === 'WENDKEEP_MEMORY_USAGE' ? 2 : 1;
      return;
    }
  }
  if (sub === 'recover-attempt') {
    try {
      recoverAttemptArgs = parseRecoverAttemptArgs(argv);
    } catch (error) {
      process.stderr.write(`wendkeep memory: ${error.message}\n`);
      process.exitCode = error.code === 'WENDKEEP_MEMORY_USAGE' ? 2 : 1;
      return;
    }
  }
  if (sub === 'candidates') {
    try {
      candidatesArgs = parseCandidatesArgs(argv);
    } catch (error) {
      process.stderr.write(`wendkeep memory: ${error.message}\n`);
      process.exitCode = error.code === 'WENDKEEP_MEMORY_USAGE' ? 2 : 1;
      return;
    }
  }
  const vault = (
    recoverAttemptArgs?.vault || reconcileArgs?.vault || candidatesArgs?.vault || option(argv, '--vault')
  ) || process.env.OBSIDIAN_VAULT_PATH;
  if (!vault) { process.stderr.write('wendkeep memory: passe --vault <path>.\n'); process.exitCode = 2; return; }
  if (!existsSync(vault)) { process.stderr.write(`wendkeep memory: not found: ${vault}\n`); process.exitCode = 2; return; }
  try {
    let result;
    if (sub === 'status') result = memoryStatus(vault);
    else if (sub === 'candidates') {
      result = listMemoryCandidates(vault, { activeOnly: candidatesArgs.activeOnly });
    }
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
    else if (sub === 'recover-attempt') {
      result = recoverProjectedAttempt(vault, {
        sessionId: recoverAttemptArgs.sessionId,
        apply: recoverAttemptArgs.apply,
      });
    }
    else if (sub === 'promote' || sub === 'reject') {
      const eventId = option(argv, '--event');
      if (sub === 'reject' && eventId) throw memoryUsageError('--event é permitido somente em memory promote.');
      result = decideMemoryCandidate(vault, {
        action: sub, candidateId: positional, ...(eventId ? { eventId } : {}),
      });
    }
    else { process.stderr.write('wendkeep memory: use status | candidates [--active] | migrate [--apply] | repair | recover-attempt <session> [--apply] | reconcile <session> --by-session <session> --reason <text> [--apply] | promote <candidate> [--event <event-id>] | reject <candidate>.\n'); process.exitCode = 2; return; }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (sub === 'status' && argv.includes('--gate')) process.exitCode = result.status === 'blocked' ? 1 : 0;
    else if (sub === 'reconcile' && reconcileArgs.apply) process.exitCode = result.health?.status === 'blocked' ? 1 : 0;
    else process.exitCode = result.ok === false ? 1 : 0;
  } catch (error) {
    process.stderr.write(`wendkeep memory: ${error.message}\n`);
    process.exitCode = 1;
  }
}
