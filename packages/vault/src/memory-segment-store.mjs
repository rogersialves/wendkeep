import { createHash } from 'node:crypto';
import {
  closeSync, fstatSync, fsyncSync, openSync, readFileSync, readdirSync, statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  MEMORY_LOCK_BUSY,
  MemoryLedgerCorruption,
  canonicalMemoryJson,
  memoryFileIdentityMatches,
  readMemoryLedger,
  withMemoryLock,
} from './memory-store-core.mjs';
import { validateMemoryEvent } from './memory-schema.mjs';
import { readMemoryProjectionSnapshot } from './memory-snapshot-store.mjs';
import {
  assertVaultPathSafe,
  mkdirVaultPath,
  writeVaultFileAtomic,
} from './vault-path-safety.mjs';

export const MEMORY_SEGMENT_DIRECTORY = 'memory-segments';
export const MEMORY_SEGMENT_MANIFEST_FILE = 'MEMORY_SEGMENTS.json';
export const MEMORY_SEGMENT_SCHEMA_VERSION = 1;
export const MEMORY_SEGMENT_MANIFEST_SCHEMA_VERSION = 1;
export const MEMORY_SEGMENT_DEFAULT_MAX_EVENTS = 4096;
export const MEMORY_SEGMENT_DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

const SEGMENT_KIND = 'wendkeep-memory-segment';
const SHA256 = /^[a-f0-9]{64}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEGMENT_FILE = /^segment-(\d{6})-([a-f0-9]{16})\.jsonl$/;
const CHAIN_GENESIS = '0'.repeat(64);

export class MemorySegmentCorruption extends Error {
  constructor(errors, message = 'Memory segment chain is corrupt; rebuild its manifest before rotation.') {
    super(message);
    this.name = 'MemorySegmentCorruption';
    this.code = 'MEMORY_SEGMENT_CORRUPT';
    this.errors = Array.isArray(errors) ? errors : [String(errors || 'unknown segment error')];
  }
}

function brainDir(vaultBase) { return join(vaultBase, '.brain'); }
function segmentRoot(vaultBase) { return join(brainDir(vaultBase), MEMORY_SEGMENT_DIRECTORY); }
function segmentDataDir(vaultBase) { return join(segmentRoot(vaultBase), 'data'); }
function manifestPath(vaultBase) { return join(brainDir(vaultBase), MEMORY_SEGMENT_MANIFEST_FILE); }
function projectPath(vaultBase) { return join(brainDir(vaultBase), 'PROJECT.json'); }

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function hashUnsigned(value, excludedKey) {
  const clone = { ...(value || {}) };
  delete clone[excludedKey];
  return sha256(canonicalJson(clone));
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

function readCheckedFile(vaultBase, path, encoding, label, { allowMissing = false } = {}) {
  let checked = checkedFile(vaultBase, path, label, { allowMissing });
  if (!checked.exists) return null;
  checked = checkedFile(vaultBase, checked.target, label, { allowMissing: false });
  return readFileSync(checked.target, encoding);
}

function assertOpenedFile(vaultBase, path, fd, label) {
  const checked = checkedFile(vaultBase, path, label, { allowMissing: false });
  const descriptor = fstatSync(fd, { bigint: true });
  const target = statSync(checked.target, { bigint: true });
  if (!descriptor.isFile() || descriptor.nlink > 1n || target.nlink > 1n
      || !memoryFileIdentityMatches(descriptor, target)) {
    const error = new Error(`${label} mudou de inode ou possui hardlink antes da escrita.`);
    error.code = 'VAULT_PATH_UNSAFE';
    throw error;
  }
  return checked.target;
}

function projectIdForVault(vaultBase) {
  const raw = readCheckedFile(
    vaultBase,
    projectPath(vaultBase),
    'utf8',
    'autoridade PROJECT.json dos segmentos de memória',
    { allowMissing: true },
  );
  if (raw === null) return '';
  try {
    const project = JSON.parse(raw);
    return typeof project.projectId === 'string' ? project.projectId : '';
  } catch {
    return '';
  }
}

function eventChainStep(previous, event) {
  return sha256(`${previous}\u0000${canonicalMemoryJson(event)}`);
}

function eventChain(events, initial = CHAIN_GENESIS) {
  return events.reduce((chain, event) => eventChainStep(chain, event), initial);
}

function validPositiveInteger(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum ? number : fallback;
}

function policyFromOptions(options = {}, fallback = {}) {
  return {
    max_events: validPositiveInteger(
      options.maxEvents ?? options.max_events,
      validPositiveInteger(fallback.max_events, MEMORY_SEGMENT_DEFAULT_MAX_EVENTS),
    ),
    max_bytes: validPositiveInteger(
      options.maxBytes ?? options.max_bytes,
      validPositiveInteger(fallback.max_bytes, MEMORY_SEGMENT_DEFAULT_MAX_BYTES),
    ),
  };
}

function descriptorHash(descriptor) {
  return hashUnsigned(descriptor, 'descriptor_hash');
}

function manifestHash(manifest) {
  return hashUnsigned(manifest, 'manifest_hash');
}

function renderManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function segmentFileName(sequence, contentHash) {
  return `segment-${String(sequence).padStart(6, '0')}-${contentHash.slice(0, 16)}.jsonl`;
}

function segmentRelativePath(fileName) {
  return `${MEMORY_SEGMENT_DIRECTORY}/data/${fileName}`;
}

function buildSegment({
  projectId,
  sequence,
  previousDescriptorHash,
  eventChainStart,
  events,
}) {
  if (!events.length) throw new TypeError('segment must contain at least one event');
  const eventChainEnd = eventChain(events, eventChainStart);
  const header = {
    kind: SEGMENT_KIND,
    schema_version: MEMORY_SEGMENT_SCHEMA_VERSION,
    project_id: projectId,
    sequence,
    previous_descriptor_hash: previousDescriptorHash,
    event_count: events.length,
    first_event_id: events[0].event_id,
    last_event_id: events.at(-1).event_id,
    event_chain_start: eventChainStart,
    event_chain_end: eventChainEnd,
  };
  const content = `${canonicalJson(header)}\n${events.map((event) => canonicalMemoryJson(event)).join('\n')}\n`;
  const contentHash = sha256(content);
  const fileName = segmentFileName(sequence, contentHash);
  const descriptor = {
    sequence,
    file: segmentRelativePath(fileName),
    project_id: projectId,
    event_count: events.length,
    byte_length: Buffer.byteLength(content),
    content_hash: contentHash,
    previous_descriptor_hash: previousDescriptorHash,
    first_event_id: header.first_event_id,
    last_event_id: header.last_event_id,
    event_chain_start: eventChainStart,
    event_chain_end: eventChainEnd,
  };
  descriptor.descriptor_hash = descriptorHash(descriptor);
  return { header, events, content, descriptor, fileName };
}

function buildManifest({ projectId, policy, descriptors, snapshot = null }) {
  const segments = descriptors.map((descriptor) => ({ ...descriptor }));
  const last = segments.at(-1);
  const manifest = {
    schema_version: MEMORY_SEGMENT_MANIFEST_SCHEMA_VERSION,
    segment_schema_version: MEMORY_SEGMENT_SCHEMA_VERSION,
    project_id: projectId,
    revision: segments.length,
    policy,
    segment_count: segments.length,
    covered_event_count: segments.reduce((total, segment) => total + segment.event_count, 0),
    covered_bytes: segments.reduce((total, segment) => total + segment.byte_length, 0),
    through_event_id: last?.last_event_id || 'none',
    event_chain_hash: last?.event_chain_end || CHAIN_GENESIS,
    chain_tip: last?.descriptor_hash || CHAIN_GENESIS,
    source_snapshot_hash: snapshot?.snapshot_hash || CHAIN_GENESIS,
    source_snapshot_event_count: Number(snapshot?.event_count || 0),
    segments,
  };
  manifest.manifest_hash = manifestHash(manifest);
  return manifest;
}

function validateDescriptorShape(descriptor, projectId) {
  return Boolean(descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor))
    && Number.isInteger(descriptor.sequence) && descriptor.sequence > 0
    && typeof descriptor.file === 'string'
    && descriptor.project_id === projectId
    && Number.isInteger(descriptor.event_count) && descriptor.event_count > 0
    && Number.isInteger(descriptor.byte_length) && descriptor.byte_length > 0
    && SHA256.test(String(descriptor.content_hash || ''))
    && SHA256.test(String(descriptor.previous_descriptor_hash || ''))
    && EVENT_ID.test(String(descriptor.first_event_id || ''))
    && EVENT_ID.test(String(descriptor.last_event_id || ''))
    && SHA256.test(String(descriptor.event_chain_start || ''))
    && SHA256.test(String(descriptor.event_chain_end || ''))
    && SHA256.test(String(descriptor.descriptor_hash || ''))
    && descriptor.descriptor_hash === descriptorHash(descriptor);
}

function validateManifestShape(manifest, projectId) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest is not an object'];
  }
  if (manifest.schema_version !== MEMORY_SEGMENT_MANIFEST_SCHEMA_VERSION) errors.push('manifest schema_version mismatch');
  if (manifest.segment_schema_version !== MEMORY_SEGMENT_SCHEMA_VERSION) errors.push('segment schema_version mismatch');
  if (manifest.project_id !== projectId) errors.push('manifest project_id mismatch');
  if (!Array.isArray(manifest.segments)) errors.push('manifest segments missing');
  if (!SHA256.test(String(manifest.source_snapshot_hash || ''))) errors.push('source_snapshot_hash missing');
  if (!Number.isInteger(manifest.source_snapshot_event_count)
      || manifest.source_snapshot_event_count < manifest.covered_event_count) {
    errors.push('source_snapshot_event_count mismatch');
  }
  if (!manifest.policy || typeof manifest.policy !== 'object') errors.push('manifest policy missing');
  if (!SHA256.test(String(manifest.manifest_hash || '')) || manifest.manifest_hash !== manifestHash(manifest)) {
    errors.push('manifest hash mismatch');
  }
  const segments = Array.isArray(manifest.segments) ? manifest.segments : [];
  if (manifest.revision !== segments.length || manifest.segment_count !== segments.length) {
    errors.push('manifest segment count mismatch');
  }
  let previousDescriptorHash = CHAIN_GENESIS;
  let previousEventChain = CHAIN_GENESIS;
  let events = 0;
  let bytes = 0;
  segments.forEach((descriptor, index) => {
    if (!validateDescriptorShape(descriptor, projectId)) {
      errors.push(`invalid descriptor at index ${index}`);
      return;
    }
    if (descriptor.sequence !== index + 1) errors.push(`segment sequence gap at ${descriptor.sequence}`);
    if (descriptor.previous_descriptor_hash !== previousDescriptorHash) {
      errors.push(`descriptor chain mismatch at ${descriptor.sequence}`);
    }
    if (descriptor.event_chain_start !== previousEventChain) {
      errors.push(`event chain mismatch at ${descriptor.sequence}`);
    }
    previousDescriptorHash = descriptor.descriptor_hash;
    previousEventChain = descriptor.event_chain_end;
    events += descriptor.event_count;
    bytes += descriptor.byte_length;
  });
  if (manifest.covered_event_count !== events) errors.push('covered_event_count mismatch');
  if (manifest.covered_bytes !== bytes) errors.push('covered_bytes mismatch');
  if (manifest.chain_tip !== previousDescriptorHash) errors.push('chain_tip mismatch');
  if (manifest.event_chain_hash !== previousEventChain) errors.push('event_chain_hash mismatch');
  if (manifest.through_event_id !== (segments.at(-1)?.last_event_id || 'none')) {
    errors.push('through_event_id mismatch');
  }
  return errors;
}

function readManifestDocument(vaultBase, projectId) {
  let raw;
  try {
    raw = readCheckedFile(
      vaultBase,
      manifestPath(vaultBase),
      'utf8',
      'manifest dos segmentos de memória',
      { allowMissing: true },
    );
  } catch (error) {
    if (error?.code === 'VAULT_PATH_UNSAFE') throw error;
    return { status: 'invalid', errors: ['manifest unreadable'] };
  }
  if (raw === null) return { status: 'missing', manifest: null, errors: [] };
  let manifest;
  try { manifest = JSON.parse(raw); } catch { return { status: 'invalid', errors: ['manifest invalid JSON'] }; }
  const errors = validateManifestShape(manifest, projectId);
  return errors.length
    ? { status: 'invalid', manifest, errors }
    : { status: 'ok', manifest, errors: [] };
}

function parseSegmentContent(vaultBase, path, descriptor = null, projectId = '') {
  const content = readCheckedFile(vaultBase, path, 'utf8', `segmento de memória ${path}`);
  const errors = [];
  if (!content.endsWith('\n')) errors.push('segment missing final newline');
  const lines = content.split('\n');
  lines.pop();
  if (lines.length < 2) errors.push('segment has no events');
  let header = null;
  try { header = JSON.parse(lines[0] || ''); } catch { errors.push('segment header invalid JSON'); }
  const events = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    let event;
    try { event = JSON.parse(line); } catch {
      errors.push(`segment event line ${index + 1} invalid JSON`);
      continue;
    }
    const validation = validateMemoryEvent(event, projectId ? { projectId } : {});
    if (!validation.ok) errors.push(`segment event line ${index + 1} invalid: ${validation.errors.join(' ')}`);
    if (canonicalMemoryJson(event) !== line) errors.push(`segment event line ${index + 1} is not canonical`);
    events.push(event);
  }
  const contentHash = sha256(content);
  if (!header || header.kind !== SEGMENT_KIND
      || header.schema_version !== MEMORY_SEGMENT_SCHEMA_VERSION
      || header.project_id !== projectId
      || !Number.isInteger(header.sequence) || header.sequence <= 0
      || !SHA256.test(String(header.previous_descriptor_hash || ''))
      || !Number.isInteger(header.event_count) || header.event_count <= 0
      || !EVENT_ID.test(String(header.first_event_id || ''))
      || !EVENT_ID.test(String(header.last_event_id || ''))
      || !SHA256.test(String(header.event_chain_start || ''))
      || !SHA256.test(String(header.event_chain_end || ''))) {
    errors.push('segment header shape invalid');
  }
  if (header) {
    if (header.event_count !== events.length) errors.push('segment event_count mismatch');
    if (events.length && header.first_event_id !== events[0].event_id) errors.push('segment first_event_id mismatch');
    if (events.length && header.last_event_id !== events.at(-1).event_id) errors.push('segment last_event_id mismatch');
    if (eventChain(events, header.event_chain_start) !== header.event_chain_end) errors.push('segment event chain hash mismatch');
  }
  const sequence = Number(header?.sequence || descriptor?.sequence || 0);
  const fileName = path.split(/[\\/]/).at(-1) || '';
  const expectedName = sequence > 0 ? segmentFileName(sequence, contentHash) : '';
  if (expectedName && fileName !== expectedName) errors.push('segment filename hash mismatch');

  const computedDescriptor = header && events.length ? {
    sequence: header.sequence,
    file: segmentRelativePath(fileName),
    project_id: header.project_id,
    event_count: header.event_count,
    byte_length: Buffer.byteLength(content),
    content_hash: contentHash,
    previous_descriptor_hash: header.previous_descriptor_hash,
    first_event_id: header.first_event_id,
    last_event_id: header.last_event_id,
    event_chain_start: header.event_chain_start,
    event_chain_end: header.event_chain_end,
  } : null;
  if (computedDescriptor) computedDescriptor.descriptor_hash = descriptorHash(computedDescriptor);
  if (descriptor && computedDescriptor && canonicalJson(descriptor) !== canonicalJson(computedDescriptor)) {
    errors.push('segment descriptor does not match file content');
  }
  return {
    status: errors.length ? 'invalid' : 'ok',
    errors,
    content,
    header,
    events,
    descriptor: computedDescriptor,
  };
}

function segmentPathFromDescriptor(vaultBase, descriptor) {
  const expectedPrefix = `${MEMORY_SEGMENT_DIRECTORY}/data/`;
  if (!descriptor.file.startsWith(expectedPrefix) || descriptor.file.includes('..') || descriptor.file.includes('\\')) {
    throw new MemorySegmentCorruption([`unsafe segment path: ${descriptor.file}`]);
  }
  return join(brainDir(vaultBase), ...descriptor.file.split('/'));
}

function verifyManifestFiles(vaultBase, manifest) {
  const errors = [];
  const events = [];
  for (const descriptor of manifest.segments) {
    let parsed;
    try {
      parsed = parseSegmentContent(
        vaultBase,
        segmentPathFromDescriptor(vaultBase, descriptor),
        descriptor,
        manifest.project_id,
      );
    } catch (error) {
      if (error?.code === 'VAULT_PATH_UNSAFE') throw error;
      errors.push(`segment ${descriptor.sequence} unreadable`);
      continue;
    }
    errors.push(...parsed.errors.map((error) => `segment ${descriptor.sequence}: ${error}`));
    events.push(...parsed.events);
  }
  return { errors, events };
}

function compareEventsWithLedger(segmentEvents, ledgerEvents) {
  const errors = [];
  if (segmentEvents.length > ledgerEvents.length) return ['segment chain is longer than ledger authority'];
  for (let index = 0; index < segmentEvents.length; index += 1) {
    if (canonicalMemoryJson(segmentEvents[index]) !== canonicalMemoryJson(ledgerEvents[index])) {
      errors.push(`ledger prefix diverges at event ${index + 1}`);
      break;
    }
  }
  return errors;
}

function verifyLocked(vaultBase, { verifyLedger = true, verifySnapshot = true } = {}) {
  const projectId = projectIdForVault(vaultBase);
  const loaded = readManifestDocument(vaultBase, projectId);
  if (loaded.status === 'missing') {
    return {
      status: 'missing',
      valid: true,
      projectId,
      segments: 0,
      coveredEvents: 0,
      errors: [],
    };
  }
  if (loaded.status !== 'ok') {
    return {
      status: 'invalid',
      valid: false,
      projectId,
      segments: loaded.manifest?.segments?.length || 0,
      coveredEvents: loaded.manifest?.covered_event_count || 0,
      errors: loaded.errors,
    };
  }
  const files = verifyManifestFiles(vaultBase, loaded.manifest);
  const errors = [...files.errors];
  let ledger = null;
  if (verifyLedger) {
    ledger = readMemoryLedger(vaultBase);
    if (ledger.status !== 'ok') {
      errors.push(...ledger.errors.map((item) => `ledger line ${item.line}: ${item.message}`));
    } else {
      errors.push(...compareEventsWithLedger(files.events, ledger.events));
      if (eventChain(files.events) !== loaded.manifest.event_chain_hash) {
        errors.push('manifest event chain does not match segment events');
      }
    }
  }
  let snapshot = null;
  if (verifySnapshot) {
    snapshot = readMemoryProjectionSnapshot(vaultBase);
    if (snapshot.status !== 'ok' || snapshot.tail?.status !== 'ok') {
      errors.push(`snapshot unavailable for segment verification: ${snapshot.reason || snapshot.tail?.reason || snapshot.status}`);
    } else if (snapshot.snapshot.event_count < loaded.manifest.covered_event_count) {
      errors.push('snapshot boundary is older than sealed segment chain');
    }
  }
  return {
    status: errors.length ? 'invalid' : 'ok',
    valid: errors.length === 0,
    projectId,
    manifest: loaded.manifest,
    segments: loaded.manifest.segment_count,
    coveredEvents: loaded.manifest.covered_event_count,
    coveredBytes: loaded.manifest.covered_bytes,
    chainTip: loaded.manifest.chain_tip,
    manifestHash: loaded.manifest.manifest_hash,
    errors,
    _events: files.events,
    _ledger: ledger,
    _snapshot: snapshot,
  };
}

export function readMemorySegmentManifest(vaultBase) {
  const projectId = projectIdForVault(vaultBase);
  const loaded = readManifestDocument(vaultBase, projectId);
  return loaded.status === 'ok'
    ? { status: 'ok', manifest: loaded.manifest }
    : { status: loaded.status, errors: loaded.errors };
}

export function verifyMemorySegments(vaultBase, options = {}) {
  const result = verifyLocked(vaultBase, options);
  const { _events, _ledger, _snapshot, ...publicResult } = result;
  return publicResult;
}

function writeImmutableSegment(vaultBase, segment) {
  const dir = segmentDataDir(vaultBase);
  mkdirVaultPath(vaultBase, dir, { label: 'diretório de dados dos segmentos de memória' });
  const path = join(dir, segment.fileName);
  const checked = checkedFile(vaultBase, path, `segmento imutável ${segment.fileName}`);
  if (checked.exists) {
    const existing = readCheckedFile(vaultBase, checked.target, 'utf8', `segmento imutável ${segment.fileName}`);
    if (existing !== segment.content) {
      throw new MemorySegmentCorruption([`immutable segment content diverged: ${segment.fileName}`]);
    }
    return { status: 'existing', path };
  }
  writeVaultFileAtomic(vaultBase, path, segment.content, 'utf8', {
    label: `segmento imutável ${segment.fileName}`,
    scopeRoot: dir,
    beforeRename: () => checkedFile(
      vaultBase,
      path,
      `destino imutável ${segment.fileName}`,
      { mustNotExist: true },
    ),
  });
  return { status: 'written', path };
}

function partitionEvents(events, policy, force) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  const flush = () => {
    if (!current.length) return;
    chunks.push(current);
    current = [];
    currentBytes = 0;
  };
  for (const event of events) {
    const bytes = Buffer.byteLength(`${canonicalMemoryJson(event)}\n`);
    if (current.length && (current.length >= policy.max_events || currentBytes + bytes > policy.max_bytes)) {
      flush();
    }
    current.push(event);
    currentBytes += bytes;
    if (current.length >= policy.max_events || currentBytes >= policy.max_bytes) flush();
  }
  if (current.length && force) flush();
  return {
    chunks,
    pending: current.length,
    pendingBytes: currentBytes,
  };
}

function writeManifestIfChanged(vaultBase, manifest) {
  const path = manifestPath(vaultBase);
  const content = renderManifest(manifest);
  const current = readCheckedFile(
    vaultBase,
    path,
    'utf8',
    'manifest dos segmentos de memória',
    { allowMissing: true },
  );
  if (current === content) return { status: 'unchanged', path };
  writeVaultFileAtomic(vaultBase, path, content, 'utf8', {
    label: 'manifest dos segmentos de memória',
    scopeRoot: brainDir(vaultBase),
  });
  return { status: 'written', path };
}

function injectFault(faultAt, boundary) {
  if (faultAt === boundary) throw new Error(`Injected memory-segment fault: ${boundary}`);
}

function sealLocked(vaultBase, options = {}) {
  mkdirVaultPath(vaultBase, brainDir(vaultBase), { label: 'raiz .brain dos segmentos de memória' });
  mkdirVaultPath(vaultBase, segmentRoot(vaultBase), { label: 'raiz dos segmentos de memória' });
  mkdirVaultPath(vaultBase, segmentDataDir(vaultBase), { label: 'diretório de dados dos segmentos de memória' });

  const projectId = projectIdForVault(vaultBase);
  const snapshot = readMemoryProjectionSnapshot(vaultBase);
  if (snapshot.status !== 'ok' || snapshot.tail?.status !== 'ok') {
    throw new MemorySegmentCorruption([
      `valid snapshot required: ${snapshot.reason || snapshot.tail?.reason || snapshot.status}`,
    ]);
  }
  const ledger = readMemoryLedger(vaultBase);
  if (ledger.status !== 'ok') throw new MemoryLedgerCorruption(ledger.errors);
  const boundaryCount = snapshot.snapshot.event_count;
  if (boundaryCount > ledger.events.length) {
    throw new MemorySegmentCorruption(['snapshot event_count exceeds ledger authority']);
  }
  const snapshotEvents = ledger.events.slice(0, boundaryCount);
  if (boundaryCount > 0 && snapshotEvents.at(-1)?.event_id !== snapshot.snapshot.through_event_id) {
    throw new MemorySegmentCorruption(['snapshot through_event_id diverges from ledger authority']);
  }
  if (eventChain(snapshotEvents) !== snapshot.snapshot.chain_hash) {
    throw new MemorySegmentCorruption(['snapshot chain_hash diverges from ledger authority']);
  }

  const current = verifyLocked(vaultBase, { verifyLedger: true, verifySnapshot: false });
  if (current.status === 'invalid') throw new MemorySegmentCorruption(current.errors);
  const existing = current.manifest || buildManifest({
    projectId,
    policy: policyFromOptions(options),
    descriptors: [],
    snapshot: snapshot.snapshot,
  });
  if (existing.covered_event_count > boundaryCount) {
    throw new MemorySegmentCorruption(['segment chain extends beyond current snapshot boundary']);
  }
  const policy = policyFromOptions(options, existing.policy);
  const remaining = snapshotEvents.slice(existing.covered_event_count);
  const partitioned = partitionEvents(remaining, policy, options.force === true);
  if (!partitioned.chunks.length) {
    return {
      status: 'noop',
      segments: existing.segment_count,
      createdSegments: 0,
      coveredEvents: existing.covered_event_count,
      pendingEvents: remaining.length,
      pendingBytes: partitioned.pendingBytes,
      manifestHash: existing.manifest_hash,
      chainTip: existing.chain_tip,
    };
  }

  const descriptors = existing.segments.map((descriptor) => ({ ...descriptor }));
  let previousDescriptorHash = existing.chain_tip;
  let chain = existing.event_chain_hash;
  let written = 0;
  let reused = 0;
  for (const events of partitioned.chunks) {
    const sequence = descriptors.length + 1;
    const segment = buildSegment({
      projectId,
      sequence,
      previousDescriptorHash,
      eventChainStart: chain,
      events,
    });
    const result = writeImmutableSegment(vaultBase, segment);
    if (result.status === 'written') written += 1;
    else reused += 1;
    descriptors.push(segment.descriptor);
    previousDescriptorHash = segment.descriptor.descriptor_hash;
    chain = segment.descriptor.event_chain_end;
    injectFault(options.faultAt, 'after-segment');
    injectFault(options.faultAt, `after-segment-${sequence}`);
  }
  const manifest = buildManifest({ projectId, policy, descriptors, snapshot: snapshot.snapshot });
  const manifestResult = writeManifestIfChanged(vaultBase, manifest);
  injectFault(options.faultAt, 'after-manifest');
  return {
    status: 'sealed',
    segments: manifest.segment_count,
    createdSegments: written,
    reusedSegments: reused,
    coveredEvents: manifest.covered_event_count,
    pendingEvents: boundaryCount - manifest.covered_event_count,
    pendingBytes: partitioned.pendingBytes,
    manifestStatus: manifestResult.status,
    manifestHash: manifest.manifest_hash,
    chainTip: manifest.chain_tip,
    eventChainHash: manifest.event_chain_hash,
  };
}

export function sealMemorySegments(vaultBase, options = {}) {
  const result = withMemoryLock(
    vaultBase,
    () => sealLocked(vaultBase, options),
    options.lock || {},
  );
  if (result === MEMORY_LOCK_BUSY) return { status: 'busy' };
  return result;
}

function scanSegmentFiles(vaultBase, projectId) {
  const dir = segmentDataDir(vaultBase);
  let checked = checkedDirectory(vaultBase, dir, 'diretório de dados dos segmentos de memória');
  if (!checked.exists) return { descriptors: [], events: [], errors: [], unknown: [] };
  checked = checkedDirectory(vaultBase, checked.target, 'diretório de dados dos segmentos de memória', {
    allowMissing: false,
  });
  const entries = readdirSync(checked.target, { withFileTypes: true });
  const errors = [];
  const unknown = [];
  const parsed = [];
  for (const entry of entries) {
    const path = join(checked.target, entry.name);
    assertVaultPathSafe(vaultBase, path, {
      allowMissing: false,
      label: `entrada ${entry.name} dos segmentos de memória`,
    });
    if (!entry.isFile() || !SEGMENT_FILE.test(entry.name)) {
      unknown.push(entry.name);
      continue;
    }
    const result = parseSegmentContent(vaultBase, path, null, projectId);
    if (result.status !== 'ok') {
      errors.push(...result.errors.map((error) => `${entry.name}: ${error}`));
      continue;
    }
    parsed.push(result);
  }
  parsed.sort((left, right) => left.descriptor.sequence - right.descriptor.sequence);
  const descriptors = [];
  const events = [];
  let previousDescriptorHash = CHAIN_GENESIS;
  let previousEventChain = CHAIN_GENESIS;
  for (let index = 0; index < parsed.length; index += 1) {
    const item = parsed[index];
    const descriptor = item.descriptor;
    if (descriptor.sequence !== index + 1) errors.push(`segment sequence gap at ${descriptor.sequence}`);
    if (descriptors.some((entry) => entry.sequence === descriptor.sequence)) {
      errors.push(`duplicate segment sequence ${descriptor.sequence}`);
    }
    if (descriptor.previous_descriptor_hash !== previousDescriptorHash) {
      errors.push(`descriptor chain mismatch at ${descriptor.sequence}`);
    }
    if (descriptor.event_chain_start !== previousEventChain) {
      errors.push(`event chain mismatch at ${descriptor.sequence}`);
    }
    descriptors.push(descriptor);
    events.push(...item.events);
    previousDescriptorHash = descriptor.descriptor_hash;
    previousEventChain = descriptor.event_chain_end;
  }
  return { descriptors, events, errors, unknown };
}

function repairPlan(vaultBase, options = {}) {
  const projectId = projectIdForVault(vaultBase);
  const scanned = scanSegmentFiles(vaultBase, projectId);
  const errors = [...scanned.errors];
  const ledger = readMemoryLedger(vaultBase);
  if (ledger.status !== 'ok') {
    errors.push(...ledger.errors.map((item) => `ledger line ${item.line}: ${item.message}`));
  } else {
    errors.push(...compareEventsWithLedger(scanned.events, ledger.events));
  }
  const snapshot = readMemoryProjectionSnapshot(vaultBase);
  if (snapshot.status !== 'ok' || snapshot.tail?.status !== 'ok') {
    errors.push(`snapshot unavailable: ${snapshot.reason || snapshot.tail?.reason || snapshot.status}`);
  } else if (snapshot.snapshot.event_count < scanned.events.length) {
    errors.push('snapshot boundary is older than scanned segment chain');
  }
  const current = readManifestDocument(vaultBase, projectId);
  const policy = policyFromOptions(options, current.manifest?.policy || {});
  const manifest = buildManifest({
    projectId,
    policy,
    descriptors: scanned.descriptors,
    snapshot: snapshot.status === 'ok' ? snapshot.snapshot : null,
  });
  const currentHash = current.status === 'ok' ? current.manifest.manifest_hash : null;
  return {
    ok: errors.length === 0,
    errors,
    unknown: scanned.unknown,
    manifest,
    currentStatus: current.status,
    currentHash,
    changed: currentHash !== manifest.manifest_hash,
    segments: scanned.descriptors.length,
    coveredEvents: scanned.events.length,
  };
}

export function repairMemorySegmentManifest(vaultBase, options = {}) {
  const preview = repairPlan(vaultBase, options);
  if (!options.apply || !preview.ok) {
    return {
      status: preview.ok ? 'preview' : 'blocked',
      apply: false,
      ...preview,
    };
  }
  const result = withMemoryLock(vaultBase, () => {
    const fresh = repairPlan(vaultBase, options);
    if (!fresh.ok) return { status: 'blocked', apply: false, ...fresh };
    const publication = writeManifestIfChanged(vaultBase, fresh.manifest);
    return {
      status: publication.status === 'unchanged' ? 'unchanged' : 'repaired',
      apply: true,
      publication: publication.status,
      ...fresh,
    };
  }, options.lock || {});
  if (result === MEMORY_LOCK_BUSY) return { status: 'busy', apply: false };
  return result;
}
