import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_SEGMENT_MANIFEST_FILE,
  MemorySegmentCorruption,
  enqueueMemoryEvent,
  projectMemoryOutbox,
  readMemorySegmentManifest,
  repairMemorySegmentManifest,
  sealMemorySegments,
  verifyMemorySegments,
} from '../hooks/memory-store.mjs';

const PROJECT_ID = 'project-segments';

function scratch() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-segments-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  writeFileSync(
    join(vault, '.brain', 'PROJECT.json'),
    `${JSON.stringify({ projectId: PROJECT_ID }, null, 2)}\n`,
  );
  return vault;
}

function memoryEvent(index, extra = {}) {
  const suffix = String(index).padStart(3, '0');
  return {
    v: 1,
    project_id: PROJECT_ID,
    event_id: `mem-segment-${suffix}`,
    memory_key: `next.segment-${suffix}`,
    operation: 'assert',
    value: `value-${suffix}`,
    authority: 'verified',
    canonical_session_id: 'session-segments',
    activation_id: 'activation-segments',
    activation_epoch: 1,
    turn_sequence: index,
    source_turn_id: `turn-segment-${suffix}`,
    observed_at: `2026-08-26T03:${String(index).padStart(2, '0')}:00.000Z`,
    evidence: ['segment-test'],
    ...extra,
  };
}

function seed(vault, from, to) {
  for (let index = from; index <= to; index += 1) {
    enqueueMemoryEvent(vault, memoryEvent(index));
  }
  return projectMemoryOutbox(vault, { snapshot: { force: true } });
}

function manifestFile(vault) {
  return join(vault, '.brain', MEMORY_SEGMENT_MANIFEST_FILE);
}

function segmentFiles(vault) {
  return readdirSync(join(vault, '.brain', 'memory-segments', 'data'))
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
}

test('[req:MEM-SEG-1] sealing creates immutable chained segments and advances only new suffixes', () => {
  const vault = scratch();
  try {
    const projected = seed(vault, 1, 5);
    assert.equal(projected.status, 'projected');
    assert.equal(projected.snapshotStatus, 'written');

    const sealed = sealMemorySegments(vault, { maxEvents: 2, maxBytes: 1024 * 1024, force: true });
    assert.equal(sealed.status, 'sealed');
    assert.equal(sealed.createdSegments, 3);
    assert.equal(sealed.reusedSegments, 0);
    assert.equal(sealed.coveredEvents, 5);
    assert.equal(sealed.pendingEvents, 0);

    const manifest = readMemorySegmentManifest(vault);
    assert.equal(manifest.status, 'ok');
    assert.equal(manifest.manifest.segment_count, 3);
    assert.equal(manifest.manifest.segments[0].previous_descriptor_hash, '0'.repeat(64));
    assert.equal(
      manifest.manifest.segments[1].previous_descriptor_hash,
      manifest.manifest.segments[0].descriptor_hash,
    );
    assert.equal(manifest.manifest.chain_tip, manifest.manifest.segments[2].descriptor_hash);
    assert.equal(verifyMemorySegments(vault).status, 'ok');

    const firstName = segmentFiles(vault)[0];
    const firstPath = join(vault, '.brain', 'memory-segments', 'data', firstName);
    const firstBytes = readFileSync(firstPath);
    const manifestBytes = readFileSync(manifestFile(vault));

    const noop = sealMemorySegments(vault, { maxEvents: 2, force: true });
    assert.equal(noop.status, 'noop');
    assert.equal(noop.createdSegments, 0);
    assert.deepEqual(readFileSync(firstPath), firstBytes);
    assert.deepEqual(readFileSync(manifestFile(vault)), manifestBytes);

    seed(vault, 6, 7);
    const advanced = sealMemorySegments(vault, { maxEvents: 2, force: true });
    assert.equal(advanced.status, 'sealed');
    assert.equal(advanced.createdSegments, 1);
    assert.equal(advanced.coveredEvents, 7);
    assert.equal(segmentFiles(vault).length, 4);
    assert.deepEqual(readFileSync(firstPath), firstBytes);
    assert.equal(verifyMemorySegments(vault).status, 'ok');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-SEG-2] default sealing leaves a bounded remainder until explicitly forced', () => {
  const vault = scratch();
  try {
    seed(vault, 1, 3);
    const partial = sealMemorySegments(vault, { maxEvents: 2, maxBytes: 1024 * 1024 });
    assert.equal(partial.status, 'sealed');
    assert.equal(partial.coveredEvents, 2);
    assert.equal(partial.pendingEvents, 1);
    assert.equal(segmentFiles(vault).length, 1);

    const forced = sealMemorySegments(vault, { maxEvents: 2, force: true });
    assert.equal(forced.status, 'sealed');
    assert.equal(forced.coveredEvents, 3);
    assert.equal(forced.pendingEvents, 0);
    assert.equal(segmentFiles(vault).length, 2);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-SEG-3] crash after an immutable segment keeps the prior chain and retry adopts the orphan', () => {
  const vault = scratch();
  try {
    seed(vault, 1, 4);
    assert.throws(
      () => sealMemorySegments(vault, {
        maxEvents: 2,
        force: true,
        faultAt: 'after-segment-1',
      }),
      /Injected memory-segment fault/,
    );
    assert.equal(segmentFiles(vault).length, 1);
    assert.equal(readMemorySegmentManifest(vault).status, 'missing');
    assert.equal(verifyMemorySegments(vault).status, 'missing');

    const retried = sealMemorySegments(vault, { maxEvents: 2, force: true });
    assert.equal(retried.status, 'sealed');
    assert.equal(retried.createdSegments, 1);
    assert.equal(retried.reusedSegments, 1);
    assert.equal(retried.coveredEvents, 4);
    assert.equal(verifyMemorySegments(vault).status, 'ok');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-SEG-4] manifest repair is dry-run first and reconstructs only a verified chain', () => {
  const vault = scratch();
  try {
    seed(vault, 1, 5);
    sealMemorySegments(vault, { maxEvents: 2, force: true });
    const expectedManifest = readMemorySegmentManifest(vault).manifest;
    const expectedChainTip = expectedManifest.chain_tip;
    unlinkSync(manifestFile(vault));

    const preview = repairMemorySegmentManifest(vault);
    assert.equal(preview.status, 'preview');
    assert.equal(preview.apply, false);
    assert.equal(preview.ok, true);
    assert.equal(preview.changed, true);
    assert.equal(preview.manifest.chain_tip, expectedChainTip);
    assert.equal(preview.manifest.covered_event_count, expectedManifest.covered_event_count);
    assert.equal(readMemorySegmentManifest(vault).status, 'missing');

    const repaired = repairMemorySegmentManifest(vault, { apply: true });
    assert.equal(repaired.status, 'repaired');
    assert.equal(repaired.apply, true);
    assert.equal(readMemorySegmentManifest(vault).manifest.chain_tip, expectedChainTip);
    assert.equal(verifyMemorySegments(vault).status, 'ok');

    writeFileSync(manifestFile(vault), '{invalid-json');
    const repairedCorrupt = repairMemorySegmentManifest(vault, { apply: true });
    assert.equal(repairedCorrupt.status, 'repaired');
    assert.equal(verifyMemorySegments(vault).status, 'ok');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-SEG-5] tampered segment or divergent ledger prefix blocks seal and repair without overwrite', () => {
  const vault = scratch();
  try {
    seed(vault, 1, 4);
    sealMemorySegments(vault, { maxEvents: 2, force: true });
    const first = join(vault, '.brain', 'memory-segments', 'data', segmentFiles(vault)[0]);
    const original = readFileSync(first, 'utf8');
    writeFileSync(first, original.replace('value-001', 'tampered-value'));

    const invalid = verifyMemorySegments(vault);
    assert.equal(invalid.status, 'invalid');
    assert.equal(invalid.valid, false);
    assert.throws(() => sealMemorySegments(vault, { maxEvents: 2, force: true }), MemorySegmentCorruption);
    const blocked = repairMemorySegmentManifest(vault, { apply: true });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.apply, false);
    assert.match(readFileSync(first, 'utf8'), /tampered-value/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-SEG-6] a valid segment chain detects later ledger-prefix divergence', () => {
  const vault = scratch();
  try {
    seed(vault, 1, 3);
    sealMemorySegments(vault, { maxEvents: 2, force: true });
    const ledgerPath = join(vault, '.brain', 'MEMORY_EVENTS.jsonl');
    const lines = readFileSync(ledgerPath, 'utf8').trimEnd().split('\n');
    const first = JSON.parse(lines[0]);
    first.value = 'ledger-tampered';
    lines[0] = JSON.stringify(first);
    writeFileSync(ledgerPath, `${lines.join('\n')}\n`);

    const invalid = verifyMemorySegments(vault);
    assert.equal(invalid.status, 'invalid');
    assert.match(invalid.errors.join('\n'), /ledger prefix diverges/);
    assert.equal(repairMemorySegmentManifest(vault, { apply: true }).status, 'blocked');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-SEG-7] hardlinked segment is rejected before external bytes or manifest change', (t) => {
  const vault = scratch();
  const outside = mkdtempSync(join(tmpdir(), 'wk-memory-segment-alias-'));
  try {
    seed(vault, 1, 2);
    sealMemorySegments(vault, { maxEvents: 2, force: true });
    const segment = join(vault, '.brain', 'memory-segments', 'data', segmentFiles(vault)[0]);
    const alias = join(outside, 'segment-alias.jsonl');
    try {
      linkSync(segment, alias);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    const externalBefore = readFileSync(alias);
    const manifestBefore = readFileSync(manifestFile(vault));

    assert.throws(
      () => verifyMemorySegments(vault),
      (error) => error?.code === 'VAULT_PATH_UNSAFE' && /hardlink|nlink|segment/i.test(error.message),
    );
    assert.deepEqual(readFileSync(alias), externalBefore);
    assert.deepEqual(readFileSync(manifestFile(vault)), manifestBefore);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
