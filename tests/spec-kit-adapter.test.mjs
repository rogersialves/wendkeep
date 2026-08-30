import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as integrations from '../packages/integrations/src/index.mjs';

const importProjection = (options) => integrations.importSpecKitProjection({ ...options, fs });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wendkeep-spec-kit-'));
  const source = join(root, '.specify');
  mkdirSync(join(source, 'memory'), { recursive: true });
  mkdirSync(join(source, 'specs', '001-login'), { recursive: true });
  writeFileSync(join(source, 'version'), '1.1.0\n');
  writeFileSync(join(source, 'memory', 'constitution.md'), '# Constitution\n\nCONST-1: privacy first.\n');
  writeFileSync(join(source, 'specs', '001-login', 'spec.md'), [
    '# Login',
    '### Requirement: AUTH-1 — Authenticate',
    'Untrusted text: `node should-never-run.mjs`.',
  ].join('\n'));
  writeFileSync(join(source, 'specs', '001-login', 'plan.md'), '# Plan\n\nDeliver AUTH-1.\n');
  writeFileSync(join(source, 'specs', '001-login', 'tasks.md'), '- [ ] T001 [AUTH-1] Implement login.\n');
  return root;
}

function enabled(options = {}) {
  return integrations.normalizeBridgeConfig({ adapters: { 'spec-kit': { enabled: true, ...options } } });
}

test('[req:BRIDGE-4] Spec Kit import is read-only and preserves source IDs and hashes', () => {
  assert.equal(typeof integrations.importSpecKitProjection, 'function');
  const root = fixture();
  try {
    const specPath = join(root, '.specify', 'specs', '001-login', 'spec.md');
    const before = readFileSync(specPath, 'utf8');
    const result = importProjection({ projectRoot: root, config: enabled() });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.authority, 'reported');
    assert.equal(result.adapter, 'spec-kit');
    assert.equal(result.adapter_version, '1.1.0');
    assert.equal(result.references.some((item) => item.source_id === 'AUTH-1' && item.kind === 'spec'), true);
    assert.equal(result.references.some((item) => item.source_id === 'T001' && item.kind === 'task'), true);
    assert.deepEqual(result.mappings.find((item) => item.source_id === 'AUTH-1'), {
      source_id: 'AUTH-1', source_kind: 'requirement', capability: 'login',
      change_slug: '001-login', task_ids: ['T001'],
    });
    assert.ok(result.references.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
    assert.ok(result.references.every((item) => item.authority === 'reported'));
    assert.equal(readFileSync(specPath, 'utf8'), before);
    assert.equal(result.references.some((item) => item.path.includes('should-never-run')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:BRIDGE-19] duplicate external IDs and competing ownership fail closed', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, '.specify', 'specs', '001-login', 'duplicate.md'), '# Duplicate\n### Requirement: AUTH-1 — Duplicate\n');
    const duplicate = importProjection({ projectRoot: root, config: enabled() });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.diagnostics.some((item) => item.code === 'BRIDGE_SOURCE_ID_DUPLICATE'), true);

    rmSync(join(root, '.specify', 'specs', '001-login', 'duplicate.md'));
    const ownership = importProjection({
      projectRoot: root,
      config: enabled({ ownership_claims: [{ concept: 'task', owner: 'spec-kit' }] }),
    });
    assert.equal(ownership.ok, false);
    assert.equal(ownership.diagnostics.some((item) => item.code === 'BRIDGE_OWNERSHIP_CONFLICT'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:BRIDGE-5] changed external bytes block a later projection as drift', () => {
  const root = fixture();
  try {
    const first = importProjection({ projectRoot: root, config: enabled() });
    writeFileSync(join(root, '.specify', 'specs', '001-login', 'spec.md'), '# Login\n### Requirement: AUTH-1 — Changed\n');
    const second = importProjection({ projectRoot: root, config: enabled(), previousProjection: first });
    assert.equal(second.ok, false);
    assert.equal(second.diagnostics.some((item) => item.code === 'BRIDGE_SOURCE_DRIFT' && item.blocking), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:BRIDGE-17] new and removed external references both block as drift', () => {
  const root = fixture();
  try {
    const first = importProjection({ projectRoot: root, config: enabled() });
    writeFileSync(join(root, '.specify', 'specs', '001-login', 'extra.md'), '# Extra\n### Requirement: AUTH-2 — New\n');
    const added = importProjection({ projectRoot: root, config: enabled(), previousProjection: first });
    assert.equal(added.ok, false);
    assert.equal(added.diagnostics.some((item) => item.code === 'BRIDGE_SOURCE_DRIFT' && item.observed === 'new'), true);

    rmSync(join(root, '.specify', 'specs', '001-login', 'tasks.md'));
    const removed = importProjection({ projectRoot: root, config: enabled(), previousProjection: first });
    assert.equal(removed.ok, false);
    assert.equal(removed.diagnostics.some((item) => item.code === 'BRIDGE_SOURCE_DRIFT' && item.observed === '(missing)'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:BRIDGE-17] stale external plan blocks reuse of a prior projection', () => {
  const root = fixture();
  try {
    const first = importProjection({ projectRoot: root, config: enabled() });
    writeFileSync(join(root, '.specify', 'specs', '001-login', 'plan.md'), '# Plan\n\nA different plan for AUTH-1.\n');
    const stale = importProjection({ projectRoot: root, config: enabled(), previousProjection: first });
    assert.equal(stale.ok, false);
    assert.equal(stale.diagnostics.some((item) => item.code === 'BRIDGE_SOURCE_DRIFT' && item.path.endsWith('/plan.md')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:BRIDGE-17] moving identical source bytes changes the bound path and blocks', () => {
  const root = fixture();
  try {
    const first = importProjection({ projectRoot: root, config: enabled() });
    const original = join(root, '.specify', 'specs', '001-login', 'spec.md');
    const moved = join(root, '.specify', 'specs', '001-login', 'moved.md');
    writeFileSync(moved, readFileSync(original));
    rmSync(original);
    const next = importProjection({ projectRoot: root, config: enabled(), previousProjection: first });
    assert.equal(next.ok, false);
    assert.equal(next.diagnostics.some((item) => item.code === 'BRIDGE_SOURCE_DRIFT' && /path|moved/.test(item.message)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:BRIDGE-6] Spec Kit absent or disabled never degrades native Core', () => {
  const root = mkdtempSync(join(tmpdir(), 'wendkeep-spec-kit-absent-'));
  try {
    const disabled = importProjection({
      projectRoot: root,
      config: integrations.normalizeBridgeConfig({}),
    });
    assert.equal(disabled.ok, true);
    assert.equal(disabled.active, false);
    assert.equal(disabled.diagnostics[0].code, 'BRIDGE_ADAPTER_DISABLED');
    assert.equal(disabled.diagnostics[0].blocking, false);

    const missing = importProjection({ projectRoot: root, config: enabled() });
    assert.equal(missing.ok, false);
    assert.equal(missing.diagnostics[0].code, 'BRIDGE_ADAPTER_MISSING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:BRIDGE-15] optional status export is a reported projection and never a second task authority', () => {
  assert.equal(typeof integrations.buildSpecKitStatusProjection, 'function');
  const [ingested] = integrations.ingestSuperpowersArtifacts([
    { external_id: 'review-3', kind: 'review', content: 'reviewed' },
  ]);
  const proven = integrations.verifyExternalArtifact(ingested, {
    proofs: [{ type: 'ci', state: 'verified', artifact_sha256: ingested.sha256 }],
  });
  const sourceProjection = integrations.createBridgeProjection({
    adapter: 'spec-kit', adapterVersion: '1.1.0', sourceRoot: '.specify',
    claims: [{ concept: 'spec_source', owner: 'wendkeep' }],
    references: [{ kind: 'spec', source_id: 'AUTH-1', path: '.specify/specs/001-login/spec.md', sha256: 'a'.repeat(64) }],
    mappings: [{ source_id: 'AUTH-1', source_kind: 'requirement', capability: 'login', change_slug: '001-login', task_ids: ['T001'] }],
  });
  const result = integrations.buildSpecKitStatusProjection({
    sourceProjection,
    taskContracts: [{ task_id: 'T001', contract_id: 'b'.repeat(64), status: 'completed' }],
    artifacts: [
      { external_id: 'review-1', sha256: 'c'.repeat(64), authority: 'verified' },
      { external_id: 'review-2', sha256: 'd'.repeat(64), authority: 'verified', proof: { type: 'ci', state: 'verified', artifact_sha256: 'd'.repeat(64) } },
      proven,
    ],
  });
  assert.equal(result.authority, 'reported');
  assert.equal(result.canonical_owner, 'wendkeep');
  assert.deepEqual(result.tasks, [{ task_id: 'T001', contract_id: 'b'.repeat(64), status: 'completed' }]);
  assert.deepEqual(result.evidence, [
    { external_id: 'review-1', sha256: 'c'.repeat(64), authority: 'reported' },
    { external_id: 'review-2', sha256: 'd'.repeat(64), authority: 'reported' },
    { external_id: 'review-3', sha256: ingested.sha256, authority: 'reported' },
  ]);
  assert.equal(Object.hasOwn(result, 'task_ownership'), false);

  const fabricated = structuredClone(sourceProjection);
  fabricated.references[0].sha256 = '0'.repeat(64);
  assert.throws(
    () => integrations.buildSpecKitStatusProjection({ sourceProjection: fabricated }),
    (error) => error.code === 'BRIDGE_CONTRACT_INVALID',
  );
});
