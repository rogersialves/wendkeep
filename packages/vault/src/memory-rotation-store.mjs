import {
  closeSync, fstatSync, fsyncSync, openSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  MEMORY_LOCK_BUSY,
  canonicalMemoryJson,
  memoryFileIdentityMatches,
  readMemoryLedger as readActiveMemoryLedger,
  withMemoryLock,
} from './memory-store-base.mjs';
import {
  MEMORY_LEDGER_GENERATION_SCHEMA_VERSION,
  MEMORY_ROTATION_JOURNAL_SCHEMA_VERSION,
  MEMORY_ROTATION_RECEIPT_CHECKPOINT_SCHEMA_VERSION,
  MEMORY_ROTATION_RECEIPT_SCHEMA_VERSION,
  MemoryLedgerGenerationCorruption,
  MemoryRotationReceiptCorruption,
  canonicalMemoryControlJson,
  hashMemoryControl,
  memoryLedgerBackupDirectory,
  memoryLedgerGenerationPath,
  memoryLedgerGenerationStatus,
  memoryLedgerPath,
  memoryRotationJournalPath,
  memoryRotationReceiptCheckpointPath,
  memoryRotationReceiptsPath,
  memorySha256,
  parseMemoryLedgerContent,
  projectIdForMemoryLedger,
  readMemoryControlFile,
  readMemoryLedger,
  readMemoryLedgerGeneration,
  readMemoryRotationJournal,
  readMemoryRotationReceipts,
} from './memory-ledger-view.mjs';
import {
  readMemorySegmentManifest,
  verifyMemorySegments,
} from './memory-segment-store.mjs';
import { readMemoryProjectionSnapshot } from './memory-snapshot-store.mjs';
import {
  assertVaultPathSafe,
  mkdirVaultPath,
  unlinkVaultFile,
  writeVaultFileAtomic,
} from './vault-path-safety.mjs';

export const MEMORY_ROTATION_CANDIDATE_PREFIX = 'MEMORY_ROTATION_CANDIDATE';
export const MEMORY_ROTATION_POLICY = 'retain-source-backup';

const SHA256 = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^memrot-[a-f0-9]{16}$/;
const BACKUP_FILE = /^memory-ledger-generations\/ledger-gen-(\d{6})-([a-f0-9]{16})\.jsonl$/;
const CANDIDATE_FILE = /^MEMORY_ROTATION_CANDIDATE\.(memrot-[a-f0-9]{16})\.jsonl$/;
const CHAIN_GENESIS = '0'.repeat(64);
const RECEIPT_KIND = 'memory-ledger-rotation';

export class MemoryLedgerRotationBlocked extends Error {
  constructor(errors, message = 'Memory ledger rotation is blocked; inspect the dry-run and recover any pending journal.') {
    super(message);
    this.name = 'MemoryLedgerRotationBlocked';
    this.code = 'MEMORY_LEDGER_ROTATION_BLOCKED';
    this.errors = Array.isArray(errors) ? errors : [String(errors || 'unknown rotation blocker')];
  }
}

function brainDir(vaultBase) { return join(vaultBase, '.brain'); }
function outboxDir(vaultBase) { return join(brainDir(vaultBase), 'memory-outbox'); }
function snapshotPath(vaultBase) { return join(brainDir(vaultBase), 'MEMORY_SNAPSHOT.json'); }
function candidateRelative(operationId) { return `${MEMORY_ROTATION_CANDIDATE_PREFIX}.${operationId}.jsonl`; }
function candidatePath(vaultBase, operationId) { return join(brainDir(vaultBase), candidateRelative(operationId)); }
function backupRelative(generation, hash) {
  return `memory-ledger-generations/ledger-gen-${String(generation).padStart(6, '0')}-${hash.slice(0, 16)}.jsonl`;
}
function backupPath(vaultBase, relativePath) {
  if (!BACKUP_FILE.test(String(relativePath || '')) || String(relativePath).includes('..') || String(relativePath).includes('\\')) {
    throw new MemoryLedgerRotationBlocked([`unsafe backup path: ${relativePath}`]);
  }
  return join(brainDir(vaultBase), ...String(relativePath).split('/'));
}

function checkedFile(vaultBase, path, label, { allowMissing = true, mustNotExist = false } = {}) {
  return assertVaultPathSafe(vaultBase, path, {
    allowMissing,
    expectedType: 'file',
    mustNotExist,
    label,
  });
}

function checkedDirectory(vaultBase, path, label, { allowMissing = true } = {}) {
  return assertVaultPathSafe(vaultBase, path, {
    allowMissing,
    expectedType: 'directory',
    label,
  });
}

function assertOpenedFile(vaultBase, path, fd, label) {
  const checked = checkedFile(vaultBase, path, label, { allowMissing: false });
  const descriptor = fstatSync(fd, { bigint: true });
  const target = statSync(checked.target, { bigint: true });
  if (!descriptor.isFile() || descriptor.nlink > 1n || target.nlink > 1n
      || !memoryFileIdentityMatches(descriptor, target)) {
    const error = new Error(`${label} mudou de inode ou possui hardlink antes da mutação.`);
    error.code = 'VAULT_PATH_UNSAFE';
    throw error;
  }
  return checked.target;
}

function canonicalLedger(events) {
  return events.map((event) => canonicalMemoryJson(event)).join('\n') + (events.length ? '\n' : '');
}

function snapshotHash(snapshot) {
  return hashMemoryControl(snapshot, 'snapshot_hash');
}

function sanitizedText(value, max) {
  return String(value || '').trim().replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, max);
}

function authorization(options = {}, { required = false } = {}) {
  const reason = sanitizedText(options.reason, 500);
  const authorizedBy = sanitizedText(options.authorizedBy ?? options.authorized_by, 200);
  const errors = [];
  if (required && reason.length < 3) errors.push('reason is required for rotation apply');
  if (required && authorizedBy.length < 2) errors.push('authorizedBy is required for rotation apply');
  return { reason, authorizedBy, errors };
}

function now(options = {}) {
  const value = typeof options.now === 'function' ? options.now() : (options.now || new Date().toISOString());
  const text = String(value || '');
  if (Number.isNaN(Date.parse(text))) throw new TypeError('rotation now must be an ISO timestamp');
  return new Date(text).toISOString();
}

function countPendingOutbox(vaultBase) {
  let checked = checkedDirectory(vaultBase, outboxDir(vaultBase), 'outbox da rotação do ledger');
  if (!checked.exists) return { pending: 0, unknown: [] };
  checked = checkedDirectory(vaultBase, checked.target, 'outbox da rotação do ledger', {
    allowMissing: false,
  });
  const unknown = [];
  let pending = 0;
  for (const entry of readdirSync(checked.target, { withFileTypes: true })) {
    const path = join(checked.target, entry.name);
    assertVaultPathSafe(vaultBase, path, {
      allowMissing: false,
      label: `entrada ${entry.name} do outbox da rotação`,
    });
    if (entry.isFile() && entry.name.endsWith('.json')) pending += 1;
    else unknown.push(entry.name);
  }
  return { pending, unknown };
}

function readSnapshotRaw(vaultBase) {
  return readMemoryControlFile(
    vaultBase,
    snapshotPath(vaultBase),
    'snapshot da rotação do ledger',
    { allowMissing: false },
  );
}

function transformSnapshot(
  snapshot,
  generation,
  operationId,
  sourceLedgerHash,
  anchorLine,
  anchorEventId,
) {
  const transformed = structuredClone(snapshot);
  const lineBytes = Buffer.byteLength(anchorLine);
  transformed.ledger_bytes = lineBytes + 1;
  transformed.through_line_start = 0;
  transformed.through_line_length = lineBytes;
  transformed.through_line_hash = memorySha256(anchorLine);
  transformed.through_event_id = anchorEventId;
  transformed.ledger_generation = generation;
  transformed.ledger_generation_operation_id = operationId;
  transformed.ledger_generation_source_hash = sourceLedgerHash;
  delete transformed.ledger_generation_state_hash;
  transformed.snapshot_hash = snapshotHash(transformed);
  return transformed;
}

function receiptFacts(plan) {
  return {
    schema_version: MEMORY_ROTATION_RECEIPT_SCHEMA_VERSION,
    kind: RECEIPT_KIND,
    operation_id: plan.operationId,
    project_id: plan.projectId,
    generation: plan.generation,
    previous_generation: plan.previousGeneration,
    policy: MEMORY_ROTATION_POLICY,
    source_ledger_hash: plan.sourceLedgerHash,
    source_event_count: plan.sourceEventCount,
    segment_manifest_hash: plan.segmentManifestHash,
    segment_chain_tip: plan.segmentChainTip,
    snapshot_hash: plan.nextSnapshot.snapshot_hash,
    source_snapshot_hash: plan.sourceSnapshotHash,
    backup_file: plan.backupFile,
    backup_hash: plan.backupHash,
    active_ledger_hash: plan.candidateHash,
    anchor_event_id: plan.anchorEventId,
    generation_state_hash: plan.generationState.state_hash,
    reason: plan.reason,
    authorized_by: plan.authorizedBy,
    completed_at: plan.completedAt,
  };
}

function operationIdFor(subject) {
  return `memrot-${memorySha256(canonicalMemoryControlJson(subject)).slice(0, 16)}`;
}

function generationCandidate(vaultBase, generationState) {
  if (!generationState?.operation_id) return { exists: false, path: null };
  const path = candidatePath(vaultBase, generationState.operation_id);
  const checked = checkedFile(vaultBase, path, 'candidate residual da rotação', { allowMissing: true });
  return { exists: checked.exists, path: checked.target };
}

function buildPlan(vaultBase, options = {}, { allowJournal = false } = {}) {
  const blockers = [];
  const projectId = projectIdForMemoryLedger(vaultBase);
  const journal = readMemoryRotationJournal(vaultBase);
  if (!allowJournal && journal.status !== 'missing') {
    blockers.push(journal.status === 'ok'
      ? `rotation recovery required for ${journal.journal.operation_id} at stage ${journal.journal.stage}`
      : `rotation journal invalid: ${journal.errors.join('; ')}`);
  }

  const auth = authorization(options);
  const outbox = countPendingOutbox(vaultBase);
  if (outbox.pending) blockers.push(`${outbox.pending} pending memory outbox event(s)`);
  if (outbox.unknown.length) blockers.push(`unknown outbox entries: ${outbox.unknown.join(', ')}`);

  const generation = readMemoryLedgerGeneration(vaultBase);
  if (generation.status === 'invalid') blockers.push(`generation state invalid: ${generation.errors.join('; ')}`);
  if (generation.status === 'ok' && generationCandidate(vaultBase, generation.state).exists) {
    blockers.push(`completed rotation candidate cleanup required for ${generation.state.operation_id}`);
  }
  const previousGeneration = generation.status === 'ok' ? generation.state.generation : 0;
  const previousStateHash = generation.status === 'ok' ? generation.state.state_hash : CHAIN_GENESIS;

  const source = readMemoryLedger(vaultBase);
  if (source.status !== 'ok') blockers.push(...source.errors.map((error) => `ledger: ${error.message}`));
  if (!source.events.length) blockers.push('ledger has no events to rotate');
  if (generation.status === 'ok'
      && source.events.length === generation.state.source_event_count
      && Number(source.activeTailEvents?.length || 0) === 0) {
    blockers.push('current generation has no new events to rotate');
  }

  const snapshot = readMemoryProjectionSnapshot(vaultBase);
  if (snapshot.status !== 'ok' || snapshot.tail?.status !== 'ok') {
    blockers.push(`snapshot invalid: ${snapshot.reason || snapshot.tail?.reason || snapshot.status}`);
  } else if (source.status === 'ok') {
    if (snapshot.snapshot.event_count !== source.events.length) blockers.push('snapshot event_count does not cover current ledger');
    if (snapshot.tail.events.length !== 0) blockers.push('snapshot has an unapplied tail; project and advance it before rotation');
  }

  const segments = verifyMemorySegments(vaultBase);
  if (segments.status !== 'ok') blockers.push(`segments invalid: ${(segments.errors || []).join('; ') || segments.status}`);
  const manifest = readMemorySegmentManifest(vaultBase);
  if (manifest.status !== 'ok') blockers.push(`segment manifest unavailable: ${(manifest.errors || []).join('; ') || manifest.status}`);
  if (source.status === 'ok' && segments.status === 'ok' && segments.coveredEvents !== source.events.length) {
    blockers.push(`segment chain covers ${segments.coveredEvents} of ${source.events.length} events; seal with force first`);
  }

  const active = readActiveMemoryLedger(vaultBase);
  if (active.status !== 'ok') blockers.push(...active.errors.map((error) => `active ledger: ${error.message}`));

  const completedAt = now(options);
  const generationNumber = previousGeneration + 1;
  const sourceContent = source.status === 'ok' ? canonicalLedger(source.events) : '';
  const sourceLedgerHash = memorySha256(sourceContent);
  const anchor = source.events.at(-1);
  const anchorLine = anchor ? canonicalMemoryJson(anchor) : '';
  const candidateContent = anchor ? `${anchorLine}\n` : '';
  const candidateHash = memorySha256(candidateContent);
  const backupFile = backupRelative(generationNumber, sourceLedgerHash);
  const sourceSnapshotHash = snapshot.status === 'ok' ? snapshot.snapshot.snapshot_hash : CHAIN_GENESIS;
  const segmentManifestHash = manifest.status === 'ok' ? manifest.manifest.manifest_hash : CHAIN_GENESIS;
  const segmentChainTip = manifest.status === 'ok' ? manifest.manifest.chain_tip : CHAIN_GENESIS;
  const operationId = operationIdFor({
    project_id: projectId,
    generation: generationNumber,
    previous_state_hash: previousStateHash,
    source_ledger_hash: sourceLedgerHash,
    source_event_count: source.events.length,
    segment_manifest_hash: segmentManifestHash,
    snapshot_hash: sourceSnapshotHash,
  });
  const nextSnapshot = snapshot.status === 'ok' && anchor
    ? transformSnapshot(
      snapshot.snapshot,
      generationNumber,
      operationId,
      sourceLedgerHash,
      anchorLine,
      anchor.event_id,
    )
    : null;
  const generationState = {
    schema_version: MEMORY_LEDGER_GENERATION_SCHEMA_VERSION,
    project_id: projectId,
    generation: generationNumber,
    previous_generation: previousGeneration,
    operation_id: operationId,
    policy: MEMORY_ROTATION_POLICY,
    backup_file: backupFile,
    backup_hash: sourceLedgerHash,
    source_ledger_hash: sourceLedgerHash,
    source_event_count: source.events.length,
    anchor_event_id: anchor?.event_id || '',
    anchor_payload_hash: anchor ? memorySha256(anchorLine) : CHAIN_GENESIS,
    active_ledger_hash: candidateHash,
    segment_manifest_hash: segmentManifestHash,
    segment_chain_tip: segmentChainTip,
    source_snapshot_hash: sourceSnapshotHash,
    snapshot_hash: nextSnapshot?.snapshot_hash || CHAIN_GENESIS,
    previous_state_hash: previousStateHash,
    rotated_at: completedAt,
  };
  generationState.state_hash = hashMemoryControl(generationState, 'state_hash');

  const sourceActiveHash = active.status === 'ok' ? memorySha256(active.raw) : CHAIN_GENESIS;
  const plan = {
    projectId,
    operationId,
    generation: generationNumber,
    previousGeneration,
    previousStateHash,
    sourceContent,
    sourceLedgerHash,
    sourceEventCount: source.events.length,
    sourceActiveHash,
    sourceActiveBytes: active.status === 'ok' ? Buffer.byteLength(active.raw) : 0,
    sourceSnapshotHash,
    segmentManifestHash,
    segmentChainTip,
    backupFile,
    backupHash: sourceLedgerHash,
    candidateFile: candidateRelative(operationId),
    candidateContent,
    candidateHash,
    anchorEventId: anchor?.event_id || '',
    generationState,
    nextSnapshot,
    reason: auth.reason,
    authorizedBy: auth.authorizedBy,
    completedAt,
  };

  return {
    status: blockers.length ? 'blocked' : 'preview',
    apply: false,
    blockers,
    plan,
    sourceEvents: source.events.length,
    sourceBytes: Buffer.byteLength(sourceContent),
    activeBytesBefore: plan.sourceActiveBytes,
    activeBytesAfter: Buffer.byteLength(candidateContent),
    reclaimedActiveBytes: Math.max(0, plan.sourceActiveBytes - Buffer.byteLength(candidateContent)),
    backupBytes: Buffer.byteLength(sourceContent),
    generation: generationNumber,
    operationId,
    policy: MEMORY_ROTATION_POLICY,
  };
}

export function planMemoryLedgerRotation(vaultBase, options = {}) {
  return buildPlan(vaultBase, options);
}

function renderControl(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeImmutableFile(vaultBase, path, content, label, scopeRoot) {
  const checked = checkedFile(vaultBase, path, label);
  if (checked.exists) {
    const current = readMemoryControlFile(vaultBase, checked.target, label, { allowMissing: false });
    if (current !== content) throw new MemoryLedgerRotationBlocked([`${label} exists with divergent bytes`]);
    return 'existing';
  }
  writeVaultFileAtomic(vaultBase, path, content, 'utf8', {
    label,
    scopeRoot,
    beforeRename: () => checkedFile(vaultBase, path, label, { mustNotExist: true }),
  });
  return 'written';
}

function writeJournal(vaultBase, journal) {
  const value = { ...journal, journal_hash: '' };
  value.journal_hash = hashMemoryControl(value, 'journal_hash');
  writeVaultFileAtomic(
    vaultBase,
    memoryRotationJournalPath(vaultBase),
    renderControl(value),
    'utf8',
    { label: 'journal da rotação do ledger', scopeRoot: brainDir(vaultBase) },
  );
  return value;
}

function journalForPlan(plan) {
  return writeJournalShape(plan, 'prepared', plan.completedAt);
}

function writeJournalShape(plan, stage, updatedAt) {
  return {
    schema_version: MEMORY_ROTATION_JOURNAL_SCHEMA_VERSION,
    project_id: plan.projectId,
    operation_id: plan.operationId,
    stage,
    created_at: plan.completedAt,
    updated_at: updatedAt,
    plan: {
      generation: plan.generation,
      previous_generation: plan.previousGeneration,
      previous_state_hash: plan.previousStateHash,
      source_ledger_hash: plan.sourceLedgerHash,
      source_event_count: plan.sourceEventCount,
      source_active_hash: plan.sourceActiveHash,
      source_active_bytes: plan.sourceActiveBytes,
      source_snapshot_hash: plan.sourceSnapshotHash,
      segment_manifest_hash: plan.segmentManifestHash,
      segment_chain_tip: plan.segmentChainTip,
      backup_file: plan.backupFile,
      backup_hash: plan.backupHash,
      candidate_file: plan.candidateFile,
      candidate_hash: plan.candidateHash,
      anchor_event_id: plan.anchorEventId,
      generation_state: plan.generationState,
      next_snapshot: plan.nextSnapshot,
      reason: plan.reason,
      authorized_by: plan.authorizedBy,
      completed_at: plan.completedAt,
    },
  };
}

function updateJournalStage(vaultBase, journal, stage) {
  return writeJournal(vaultBase, {
    ...journal,
    stage,
    updated_at: new Date().toISOString(),
  });
}

function injectFault(faultAt, boundary) {
  if (faultAt === boundary) throw new Error(`Injected memory-rotation fault: ${boundary}`);
}

function generationStateMatches(current, expected) {
  return current.status === 'ok'
    && canonicalMemoryControlJson(current.state) === canonicalMemoryControlJson(expected);
}

function currentStateHash(vaultBase) {
  const current = readMemoryLedgerGeneration(vaultBase);
  if (current.status === 'missing') return CHAIN_GENESIS;
  if (current.status !== 'ok') throw new MemoryLedgerGenerationCorruption(current.errors);
  return current.state.state_hash;
}

function switchActiveLedger(vaultBase, plan) {
  const active = readActiveMemoryLedger(vaultBase);
  if (active.status !== 'ok') throw new MemoryLedgerRotationBlocked(active.errors.map((error) => error.message));
  const currentHash = memorySha256(active.raw);
  if (currentHash === plan.candidateHash) return 'existing';
  if (currentHash !== plan.sourceActiveHash) {
    throw new MemoryLedgerRotationBlocked(['active ledger changed after rotation plan']);
  }
  writeVaultFileAtomic(
    vaultBase,
    memoryLedgerPath(vaultBase),
    plan.candidateContent,
    'utf8',
    {
      label: 'active ledger generation switch',
      scopeRoot: brainDir(vaultBase),
      beforeRename: () => {
        const fresh = readActiveMemoryLedger(vaultBase);
        if (fresh.status !== 'ok' || memorySha256(fresh.raw) !== plan.sourceActiveHash) {
          throw new MemoryLedgerRotationBlocked(['active ledger changed at switch boundary']);
        }
        if (currentStateHash(vaultBase) !== plan.previousStateHash) {
          throw new MemoryLedgerRotationBlocked(['generation state changed at switch boundary']);
        }
      },
    },
  );
  return 'written';
}

function ensureGenerationState(vaultBase, expected) {
  const current = readMemoryLedgerGeneration(vaultBase);
  if (current.status === 'ok') {
    if (!generationStateMatches(current, expected)) {
      throw new MemoryLedgerRotationBlocked(['generation state diverges from rotation journal']);
    }
    return 'existing';
  }
  if (current.status !== 'missing') throw new MemoryLedgerGenerationCorruption(current.errors);
  writeVaultFileAtomic(
    vaultBase,
    memoryLedgerGenerationPath(vaultBase),
    renderControl(expected),
    'utf8',
    { label: 'estado da geração do ledger', scopeRoot: brainDir(vaultBase) },
  );
  return 'written';
}

function ensureSnapshot(vaultBase, expected, sourceSnapshotHash) {
  const raw = readSnapshotRaw(vaultBase);
  let current;
  try { current = JSON.parse(raw); } catch { throw new MemoryLedgerRotationBlocked(['snapshot became invalid during rotation']); }
  if (current.snapshot_hash === expected.snapshot_hash
      && canonicalMemoryControlJson(current) === canonicalMemoryControlJson(expected)) return 'existing';
  if (current.snapshot_hash !== sourceSnapshotHash) {
    throw new MemoryLedgerRotationBlocked(['snapshot changed after rotation plan']);
  }
  writeVaultFileAtomic(
    vaultBase,
    snapshotPath(vaultBase),
    renderControl(expected),
    'utf8',
    { label: 'snapshot reanchored to active generation', scopeRoot: brainDir(vaultBase) },
  );
  return 'written';
}

function receiptRecord(plan, sequence, previousHash) {
  const receipt = {
    ...receiptFacts(plan),
    sequence,
    previous_receipt_hash: previousHash,
  };
  receipt.receipt_hash = hashMemoryControl(receipt, 'receipt_hash');
  return receipt;
}

function receiptEquivalent(receipt, plan) {
  const facts = receiptFacts(plan);
  return Object.entries(facts).every(([key, value]) => (
    canonicalMemoryControlJson(receipt[key]) === canonicalMemoryControlJson(value)
  ));
}

function appendReceiptLine(vaultBase, line) {
  const path = memoryRotationReceiptsPath(vaultBase);
  let fd;
  try {
    let checked = checkedFile(vaultBase, path, 'ledger de receipts da rotação');
    checked = checkedFile(vaultBase, checked.target, 'ledger de receipts da rotação');
    fd = openSync(checked.target, 'a');
    assertOpenedFile(vaultBase, checked.target, fd, 'ledger de receipts da rotação');
    writeFileSync(fd, line, 'utf8');
    fsyncSync(fd);
    assertOpenedFile(vaultBase, checked.target, fd, 'ledger de receipts da rotação');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeReceiptCheckpoint(vaultBase, receipts) {
  const raw = readMemoryControlFile(
    vaultBase,
    memoryRotationReceiptsPath(vaultBase),
    'ledger de receipts da rotação',
    { allowMissing: true },
  ) ?? '';
  const checkpoint = {
    schema_version: MEMORY_ROTATION_RECEIPT_CHECKPOINT_SCHEMA_VERSION,
    project_id: projectIdForMemoryLedger(vaultBase),
    count: receipts.receipts.length,
    last_hash: receipts.lastHash,
    file_bytes: Buffer.byteLength(raw),
  };
  checkpoint.checkpoint_hash = hashMemoryControl(checkpoint, 'checkpoint_hash');
  writeVaultFileAtomic(
    vaultBase,
    memoryRotationReceiptCheckpointPath(vaultBase),
    renderControl(checkpoint),
    'utf8',
    { label: 'checkpoint dos receipts da rotação', scopeRoot: brainDir(vaultBase) },
  );
  return checkpoint;
}

function ensureReceipt(vaultBase, plan) {
  let receipts = readMemoryRotationReceipts(vaultBase);
  if (receipts.status !== 'ok') throw new MemoryRotationReceiptCorruption(receipts.errors);
  const existing = receipts.receipts.find((receipt) => receipt.operation_id === plan.operationId);
  if (existing) {
    if (!receiptEquivalent(existing, plan)) {
      throw new MemoryRotationReceiptCorruption([`operation_id reused with divergent receipt: ${plan.operationId}`]);
    }
    if (receipts.checkpointStatus !== 'ok') writeReceiptCheckpoint(vaultBase, receipts);
    return { status: 'existing', receipt: existing };
  }
  const receipt = receiptRecord(plan, receipts.receipts.length + 1, receipts.lastHash);
  appendReceiptLine(vaultBase, `${canonicalMemoryControlJson(receipt)}\n`);
  receipts = readMemoryRotationReceipts(vaultBase);
  if (receipts.status !== 'ok') throw new MemoryRotationReceiptCorruption(receipts.errors);
  const persisted = receipts.receipts.find((item) => item.operation_id === plan.operationId);
  if (!persisted || !receiptEquivalent(persisted, plan)) {
    throw new MemoryRotationReceiptCorruption(['persisted receipt does not match rotation plan']);
  }
  writeReceiptCheckpoint(vaultBase, receipts);
  return { status: 'written', receipt: persisted };
}

function planFromJournal(vaultBase, journal) {
  const value = journal.plan || {};
  const generationState = value.generation_state;
  const nextSnapshot = value.next_snapshot;
  const plan = {
    projectId: journal.project_id,
    operationId: journal.operation_id,
    generation: value.generation,
    previousGeneration: value.previous_generation,
    previousStateHash: value.previous_state_hash,
    sourceLedgerHash: value.source_ledger_hash,
    sourceEventCount: value.source_event_count,
    sourceActiveHash: value.source_active_hash,
    sourceActiveBytes: value.source_active_bytes,
    sourceSnapshotHash: value.source_snapshot_hash,
    segmentManifestHash: value.segment_manifest_hash,
    segmentChainTip: value.segment_chain_tip,
    backupFile: value.backup_file,
    backupHash: value.backup_hash,
    candidateFile: value.candidate_file,
    candidateHash: value.candidate_hash,
    anchorEventId: value.anchor_event_id,
    generationState,
    nextSnapshot,
    reason: value.reason,
    authorizedBy: value.authorized_by,
    completedAt: value.completed_at,
    candidateContent: '',
    sourceContent: '',
  };
  const errors = [];
  if (!OPERATION_ID.test(String(plan.operationId || ''))) errors.push('journal operation id invalid');
  if (!BACKUP_FILE.test(String(plan.backupFile || ''))) errors.push('journal backup file invalid');
  if (!CANDIDATE_FILE.test(String(plan.candidateFile || '')) || !plan.candidateFile.includes(plan.operationId)) {
    errors.push('journal candidate file invalid');
  }
  if (!Number.isInteger(plan.sourceActiveBytes) || plan.sourceActiveBytes < 0) {
    errors.push('journal source_active_bytes invalid');
  }
  if (!generationState || generationState.state_hash !== hashMemoryControl(generationState, 'state_hash')) {
    errors.push('journal generation state invalid');
  }
  if (!nextSnapshot || nextSnapshot.snapshot_hash !== snapshotHash(nextSnapshot)) {
    errors.push('journal snapshot invalid');
  } else {
    if (nextSnapshot.ledger_generation !== plan.generation) errors.push('journal snapshot generation mismatch');
    if (nextSnapshot.ledger_generation_operation_id !== plan.operationId) {
      errors.push('journal snapshot operation mismatch');
    }
    if (nextSnapshot.ledger_generation_source_hash !== plan.sourceLedgerHash) {
      errors.push('journal snapshot source mismatch');
    }
    if (Object.hasOwn(nextSnapshot, 'ledger_generation_state_hash')) {
      errors.push('journal snapshot contains circular generation state binding');
    }
  }
  if (generationState?.snapshot_hash !== nextSnapshot?.snapshot_hash) {
    errors.push('journal state/snapshot hash mismatch');
  }
  for (const [key, item] of Object.entries({
    sourceLedgerHash: plan.sourceLedgerHash,
    sourceActiveHash: plan.sourceActiveHash,
    sourceSnapshotHash: plan.sourceSnapshotHash,
    segmentManifestHash: plan.segmentManifestHash,
    segmentChainTip: plan.segmentChainTip,
    backupHash: plan.backupHash,
    candidateHash: plan.candidateHash,
  })) {
    if (!SHA256.test(String(item || ''))) errors.push(`journal ${key} invalid`);
  }
  if (errors.length) throw new MemoryLedgerRotationBlocked(errors);

  const backup = readMemoryControlFile(
    vaultBase,
    backupPath(vaultBase, plan.backupFile),
    'backup da rotação pendente',
    { allowMissing: false },
  );
  if (memorySha256(backup) !== plan.backupHash || memorySha256(backup) !== plan.sourceLedgerHash) {
    throw new MemoryLedgerRotationBlocked(['journal backup hash mismatch']);
  }
  const parsedBackup = parseMemoryLedgerContent(backup, plan.projectId, plan.backupFile);
  if (parsedBackup.status !== 'ok' || parsedBackup.events.length !== plan.sourceEventCount) {
    throw new MemoryLedgerRotationBlocked(['journal backup authority invalid']);
  }
  const candidate = readMemoryControlFile(
    vaultBase,
    join(brainDir(vaultBase), plan.candidateFile),
    'candidate da rotação pendente',
    { allowMissing: false },
  );
  if (memorySha256(candidate) !== plan.candidateHash) throw new MemoryLedgerRotationBlocked(['journal candidate hash mismatch']);
  const candidateParsed = parseMemoryLedgerContent(candidate, plan.projectId, plan.candidateFile);
  if (candidateParsed.status !== 'ok' || candidateParsed.events.length !== 1
      || candidateParsed.events[0].event_id !== plan.anchorEventId) {
    throw new MemoryLedgerRotationBlocked(['journal candidate anchor invalid']);
  }
  plan.sourceContent = backup;
  plan.candidateContent = candidate;

  const manifest = readMemorySegmentManifest(vaultBase);
  if (manifest.status !== 'ok'
      || manifest.manifest.manifest_hash !== plan.segmentManifestHash
      || manifest.manifest.chain_tip !== plan.segmentChainTip
      || manifest.manifest.covered_event_count !== plan.sourceEventCount) {
    throw new MemoryLedgerRotationBlocked(['segment manifest changed after rotation journal']);
  }
  const segments = verifyMemorySegments(vaultBase, { verifyLedger: false, verifySnapshot: false });
  if (segments.status !== 'ok') throw new MemoryLedgerRotationBlocked(segments.errors || ['segment verification failed']);
  return plan;
}

function cleanupOperation(vaultBase, plan, options = {}) {
  unlinkVaultFile(vaultBase, memoryRotationJournalPath(vaultBase), {
    missingOk: true,
    label: 'journal finalizado da rotação',
  });
  injectFault(options.faultAt, 'after-journal-removal');
  unlinkVaultFile(vaultBase, join(brainDir(vaultBase), plan.candidateFile), {
    missingOk: true,
    label: 'candidate finalizado da rotação',
  });
}

function resumeLocked(vaultBase, journal, options = {}) {
  const plan = planFromJournal(vaultBase, journal);
  let currentJournal = journal;
  const switchStatus = switchActiveLedger(vaultBase, plan);
  if (currentJournal.stage === 'prepared') {
    currentJournal = updateJournalStage(vaultBase, currentJournal, 'switched');
  }
  injectFault(options.faultAt, 'after-switch');

  const stateStatus = ensureGenerationState(vaultBase, plan.generationState);
  if (['prepared', 'switched'].includes(currentJournal.stage)) {
    currentJournal = updateJournalStage(vaultBase, currentJournal, 'state-published');
  }
  injectFault(options.faultAt, 'after-state');

  const snapshotStatus = ensureSnapshot(vaultBase, plan.nextSnapshot, plan.sourceSnapshotHash);
  if (['prepared', 'switched', 'state-published'].includes(currentJournal.stage)) {
    currentJournal = updateJournalStage(vaultBase, currentJournal, 'snapshot-published');
  }
  injectFault(options.faultAt, 'after-snapshot');

  const receipt = ensureReceipt(vaultBase, plan);
  if (currentJournal.stage !== 'receipt-published') {
    currentJournal = updateJournalStage(vaultBase, currentJournal, 'receipt-published');
  }
  injectFault(options.faultAt, 'after-receipt');

  cleanupOperation(vaultBase, plan, options);
  return {
    status: 'rotated',
    apply: true,
    operationId: plan.operationId,
    generation: plan.generation,
    sourceEvents: plan.sourceEventCount,
    sourceBytes: Buffer.byteLength(plan.sourceContent),
    activeBytesBefore: plan.sourceActiveBytes,
    activeBytesAfter: Buffer.byteLength(plan.candidateContent),
    reclaimedActiveBytes: Math.max(0, plan.sourceActiveBytes - Buffer.byteLength(plan.candidateContent)),
    backupFile: plan.backupFile,
    backupRetained: true,
    policy: MEMORY_ROTATION_POLICY,
    switchStatus,
    stateStatus,
    snapshotStatus,
    receiptStatus: receipt.status,
    receiptHash: receipt.receipt.receipt_hash,
    recoveryRequired: false,
  };
}

function applyNewRotationLocked(vaultBase, preview, options = {}) {
  const auth = authorization(options, { required: true });
  if (auth.errors.length) throw new MemoryLedgerRotationBlocked(auth.errors);
  const plan = {
    ...preview.plan,
    reason: auth.reason,
    authorizedBy: auth.authorizedBy,
  };
  if (preview.status !== 'preview') return preview;
  mkdirVaultPath(vaultBase, memoryLedgerBackupDirectory(vaultBase), {
    label: 'diretório de backups das gerações do ledger',
  });
  const backupStatus = writeImmutableFile(
    vaultBase,
    backupPath(vaultBase, plan.backupFile),
    plan.sourceContent,
    'backup imutável da geração do ledger',
    memoryLedgerBackupDirectory(vaultBase),
  );
  const candidateStatus = writeImmutableFile(
    vaultBase,
    candidatePath(vaultBase, plan.operationId),
    plan.candidateContent,
    'candidate imutável da rotação do ledger',
    brainDir(vaultBase),
  );
  const journal = writeJournal(vaultBase, journalForPlan(plan));
  injectFault(options.faultAt, 'after-prepared');
  return {
    ...resumeLocked(vaultBase, journal, options),
    backupStatus,
    candidateStatus,
  };
}

export function rotateMemoryLedger(vaultBase, options = {}) {
  const preview = buildPlan(vaultBase, options);
  if (!options.apply) return preview;
  const result = withMemoryLock(vaultBase, () => {
    const pending = readMemoryRotationJournal(vaultBase);
    if (pending.status === 'ok') return resumeLocked(vaultBase, pending.journal, options);
    if (pending.status === 'invalid') throw new MemoryLedgerRotationBlocked(pending.errors);
    const fresh = buildPlan(vaultBase, options);
    if (fresh.status !== 'preview') return fresh;
    return applyNewRotationLocked(vaultBase, fresh, options);
  }, options.lock || {});
  if (result === MEMORY_LOCK_BUSY) return { status: 'busy', apply: true };
  return result;
}

function inspectOrphanCandidate(vaultBase) {
  const generation = readMemoryLedgerGeneration(vaultBase);
  if (generation.status === 'missing') {
    return { status: 'none', apply: false, recoveryRequired: false };
  }
  if (generation.status !== 'ok') {
    return {
      status: 'blocked',
      apply: false,
      recoveryRequired: true,
      errors: generation.errors,
    };
  }
  const candidate = generationCandidate(vaultBase, generation.state);
  if (!candidate.exists) return { status: 'none', apply: false, recoveryRequired: false };

  const errors = [];
  const ledger = readMemoryLedger(vaultBase);
  if (ledger.status !== 'ok') errors.push(...ledger.errors.map((error) => error.message));
  const receipts = readMemoryRotationReceipts(vaultBase);
  if (receipts.status !== 'ok') errors.push(...receipts.errors);
  if (receipts.checkpointStatus !== 'ok') errors.push(...receipts.checkpointErrors);
  const raw = readMemoryControlFile(
    vaultBase,
    candidate.path,
    'candidate residual da rotação concluída',
    { allowMissing: false },
  );
  if (memorySha256(raw) !== generation.state.active_ledger_hash) {
    errors.push('orphan candidate hash diverges from current generation');
  }
  const parsed = parseMemoryLedgerContent(raw, generation.projectId, candidate.path);
  if (parsed.status !== 'ok' || parsed.events.length !== 1
      || parsed.events[0].event_id !== generation.state.anchor_event_id) {
    errors.push('orphan candidate anchor is invalid');
  }
  if (errors.length) {
    return {
      status: 'blocked',
      apply: false,
      recoveryRequired: true,
      operationId: generation.state.operation_id,
      generation: generation.state.generation,
      errors,
    };
  }
  return {
    status: 'preview',
    apply: false,
    recoveryRequired: true,
    operationId: generation.state.operation_id,
    generation: generation.state.generation,
    stage: 'candidate-cleanup',
    candidatePath: candidate.path,
  };
}

function finalizeOrphanCandidateLocked(vaultBase) {
  const inspection = inspectOrphanCandidate(vaultBase);
  if (inspection.status !== 'preview') return inspection;
  unlinkVaultFile(vaultBase, inspection.candidatePath, {
    missingOk: false,
    label: 'candidate residual da rotação concluída',
  });
  return {
    status: 'finalized',
    apply: true,
    recoveryRequired: false,
    operationId: inspection.operationId,
    generation: inspection.generation,
    stage: inspection.stage,
  };
}

export function recoverMemoryLedgerRotation(vaultBase, options = {}) {
  const pending = readMemoryRotationJournal(vaultBase);
  if (pending.status === 'missing') {
    if (!options.apply) return inspectOrphanCandidate(vaultBase);
    const result = withMemoryLock(
      vaultBase,
      () => finalizeOrphanCandidateLocked(vaultBase),
      options.lock || {},
    );
    if (result === MEMORY_LOCK_BUSY) return { status: 'busy', apply: true, recoveryRequired: true };
    return result;
  }
  if (pending.status !== 'ok') {
    return { status: 'blocked', apply: false, recoveryRequired: true, errors: pending.errors };
  }
  if (!options.apply) {
    return {
      status: 'preview',
      apply: false,
      recoveryRequired: true,
      operationId: pending.journal.operation_id,
      stage: pending.journal.stage,
      generation: pending.journal.plan.generation,
    };
  }
  const result = withMemoryLock(
    vaultBase,
    () => resumeLocked(vaultBase, readMemoryRotationJournal(vaultBase).journal, options),
    options.lock || {},
  );
  if (result === MEMORY_LOCK_BUSY) return { status: 'busy', apply: true, recoveryRequired: true };
  return result;
}

export function memoryLedgerRotationStatus(vaultBase) {
  return {
    ...memoryLedgerGenerationStatus(vaultBase),
    journalDetails: readMemoryRotationJournal(vaultBase),
    orphanCandidate: inspectOrphanCandidate(vaultBase),
  };
}

export const compactMemoryLedger = rotateMemoryLedger;
