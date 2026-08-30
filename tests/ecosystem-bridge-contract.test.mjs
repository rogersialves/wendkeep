import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import test from 'node:test';

import * as integrations from '../packages/integrations/src/index.mjs';
import { runSensors } from '../hooks/sensors-core.mjs';

test('[req:BRIDGE-1] bridge v1 keeps WendKeep ownership fail-closed', () => {
  assert.equal(integrations.ECOSYSTEM_BRIDGE_SCHEMA_VERSION, 1);
  assert.equal(integrations.BRIDGE_AUTHORITY_MATRIX.plan.canonical_owner, 'wendkeep');
  assert.equal(integrations.BRIDGE_AUTHORITY_MATRIX.task.canonical_owner, 'wendkeep');
  assert.equal(integrations.BRIDGE_AUTHORITY_MATRIX.evidence.canonical_owner, 'wendkeep');

  const result = integrations.validateBridgeOwnership({
    adapter: 'spec-kit',
    claims: [{ concept: 'task', owner: 'spec-kit' }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.map((item) => item.code), ['BRIDGE_OWNERSHIP_CONFLICT']);
  assert.equal(result.diagnostics[0].blocking, true);
});

test('[req:BRIDGE-22] sensor evidence records an explicit binary artifact digest without output content', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-bridge-sensor-artifact-'));
  try {
    writeFileSync(join(root, 'review.bin'), Buffer.from([0, 255, 16, 128, 42]));
    const [evidence] = runSensors([{
      id: 'review-check', command: 'review-check', severity: 'critical',
      artifact_results: [{ schema_version: 1, external_id: 'review-1', path: 'review.bin', algorithm: 'sha256' }],
    }], ['review-check'], {
      cwd: root,
      spawn: () => ({ status: 0, stdout: '', stderr: '' }),
      now: () => '2026-08-29T12:00:00.000Z',
    });
    assert.equal(evidence.status, 'green');
    assert.deepEqual(evidence.artifact_results, [{
      schema_version: 1, external_id: 'review-1', path: 'review.bin', algorithm: 'sha256',
      digest: 'e52593d804ff64a26729602addd41339f23334f88f1d25db019129a85650d7ce',
    }]);
    assert.equal(evidence.output_tail, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:BRIDGE-2] adapters are independently disabled and compatibility is typed', () => {
  const config = integrations.normalizeBridgeConfig({});
  assert.deepEqual(config.adapters, {
    'spec-kit': { enabled: false },
    superpowers: { enabled: false },
  });

  const disabled = integrations.assessBridgeAdapter('spec-kit', { config, detectedVersion: '1.2.0' });
  assert.equal(disabled.available, false);
  assert.equal(disabled.diagnostics[0].code, 'BRIDGE_ADAPTER_DISABLED');
  assert.equal(disabled.diagnostics[0].blocking, false);

  const enabled = integrations.normalizeBridgeConfig({
    adapters: { 'spec-kit': { enabled: true }, superpowers: { enabled: false } },
  });
  const incompatible = integrations.assessBridgeAdapter('spec-kit', {
    config: enabled,
    detectedVersion: '9.0.0',
  });
  assert.equal(incompatible.available, false);
  assert.equal(incompatible.diagnostics[0].code, 'BRIDGE_VERSION_INCOMPATIBLE');
  assert.equal(incompatible.diagnostics[0].blocking, true);
  assert.match(incompatible.diagnostics[0].expected, /^>=/);
});

test('[req:BRIDGE-3] unknown adapters and malformed config never fall back silently', () => {
  assert.throws(
    () => integrations.normalizeBridgeConfig({ adapters: { unknown: { enabled: true } } }),
    (error) => error.code === 'BRIDGE_CONFIG_INVALID',
  );
  const result = integrations.assessBridgeAdapter('unknown', { config: integrations.normalizeBridgeConfig({}) });
  assert.equal(result.available, false);
  assert.equal(result.diagnostics[0].code, 'BRIDGE_ADAPTER_UNKNOWN');
  assert.equal(result.diagnostics[0].blocking, true);
});

test('[req:BRIDGE-16] Windows cross-drive paths are never project-contained', () => {
  assert.equal(typeof integrations.isProjectContainedPath, 'function');
  assert.equal(integrations.isProjectContainedPath('C:\\repo', 'C:\\repo\\config.json', win32), true);
  assert.equal(integrations.isProjectContainedPath('C:\\repo', 'D:\\secrets\\config.json', win32), false);
  assert.equal(integrations.isProjectContainedPath('C:\\repo', '\\server\\share\\config.json', win32), false);
  if (process.platform === 'win32') {
    const otherDrive = process.cwd().toUpperCase().startsWith('C:') ? 'D:' : 'C:';
    assert.throws(
      () => integrations.readBridgeConfig(process.cwd(), `${otherDrive}\\outside\\bridge.json`, { fs }),
      (error) => error.code === 'BRIDGE_CONFIG_INVALID',
    );
  }
});

test('[req:BRIDGE-21] published schema and runtime cover projection dispatch handoff and proof', () => {
  assert.equal(typeof integrations.validateBridgeRuntimeEnvelope, 'function');
  const schema = JSON.parse(readFileSync(new URL('../schema/ecosystem-bridge-v1.schema.json', import.meta.url), 'utf8'));
  for (const name of ['origin', 'compatibility', 'provenance', 'mapping', 'specProjection', 'dispatch', 'handoff', 'externalArtifact', 'proof']) {
    assert.ok(schema.$defs[name], `missing schema $defs.${name}`);
  }
  assert.ok(schema.$defs.proof.required.includes('evidence_envelope_id'));
  assert.ok(schema.$defs.externalArtifact.allOf, 'verified artifacts must require a canonical proof');
  const evidenceSchema = JSON.parse(readFileSync(new URL('../schema/wendkeep.evidence-envelope-v2.schema.json', import.meta.url), 'utf8'));
  assert.ok(evidenceSchema.properties.external_artifacts);
  assert.ok(evidenceSchema.$defs.externalArtifact);
  assert.ok(evidenceSchema.$defs.sensorArtifactResult);
  const sensorSchema = JSON.parse(readFileSync(new URL('../schema/wendkeep.sensors.schema.json', import.meta.url), 'utf8'));
  assert.ok(sensorSchema.properties.sensors.items.properties.artifact_results);
  const artifactManifestSchema = JSON.parse(readFileSync(new URL('../schema/ecosystem-bridge-artifact-manifest-v1.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(artifactManifestSchema.$defs.artifact.required, ['source', 'external_id', 'kind', 'path', 'sensor_id', 'task_id']);
  const invalid = integrations.validateBridgeRuntimeEnvelope({ schema_version: 1, contract_kind: 'dispatch' });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.diagnostics[0].code, 'BRIDGE_SCHEMA_INVALID');
  const selfDeclaredProof = integrations.validateBridgeRuntimeEnvelope({
    schema_version: 1, contract_kind: 'proof', type: 'ci', artifact_sha256: 'a'.repeat(64),
    authority: 'verified', origin: { tool: 'ci' }, provenance: { state: 'verified', source: 'external-json' },
  });
  assert.equal(selfDeclaredProof.valid, false);
  const missingHandoffOrigin = integrations.validateBridgeRuntimeEnvelope({
    schema_version: 1, contract_kind: 'handoff', handoff_id: 'handoff-1',
    task_contract_id: 'b'.repeat(64), head_sha: 'c'.repeat(40), authority: 'reported',
  });
  assert.equal(missingHandoffOrigin.valid, false);
});

test('[req:BRIDGE-21] Spec Kit projection builder and runtime stay fail-closed with the public schema', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/ecosystem-bridge-v1.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$defs.specProjection.properties.adapter.const, 'spec-kit');
  assert.deepEqual(schema.$defs.reference.properties.kind.enum,
    ['constitution', 'spec', 'plan', 'task', 'artifact', 'review', 'commit']);
  assert.deepEqual(schema.$defs.mapping.properties.source_kind.enum, ['story', 'requirement']);

  const input = {
    adapter: 'spec-kit', adapterVersion: '1.1.0', sourceRoot: '.specify',
    claims: [{ concept: 'spec_source', owner: 'wendkeep' }],
    references: [{ kind: 'spec', source_id: 'AUTH-1', path: '.specify/spec.md', sha256: '1'.repeat(64) }],
    mappings: [{ source_id: 'AUTH-1', source_kind: 'requirement', capability: 'auth', change_slug: '001-auth', task_ids: ['T001'] }],
  };
  const valid = integrations.createBridgeProjection(input);
  const blockingDiagnostic = {
    schema_version: 1, code: 'BRIDGE_SOURCE_DRIFT', adapter: 'spec-kit', blocking: true, message: 'stale source',
  };

  for (const mutation of [
    { label: 'ok-false-without-blocker', value: { ...valid, ok: false, diagnostics: [] } },
    { label: 'ok-true-with-blocker', value: { ...valid, ok: true, diagnostics: [blockingDiagnostic] } },
    { label: 'adapter-kind', value: { ...valid, adapter: 'superpowers', origin: { ...valid.origin, tool: 'superpowers' } } },
    { label: 'origin-adapter', value: { ...valid, origin: { ...valid.origin, tool: 'superpowers' } } },
    { label: 'unsupported-version', value: {
      ...valid, adapter_version: '9.0.0', origin: { ...valid.origin, version: '9.0.0' },
      compatibility: { ...valid.compatibility, detected_version: '9.0.0', supported: false },
    } },
    { label: 'forged-supported-version', value: {
      ...valid, adapter_version: '9.0.0', origin: { ...valid.origin, version: '9.0.0' },
      compatibility: { ...valid.compatibility, detected_version: '9.0.0', supported: true },
    } },
    { label: 'reference-enum', value: { ...valid, references: [{ ...valid.references[0], kind: 'opaque-command' }] } },
    { label: 'mapping-enum', value: { ...valid, mappings: [{ ...valid.mappings[0], source_kind: 'opaque' }] } },
    { label: 'mapping-shape', value: { ...valid, mappings: [{ ...valid.mappings[0], unexpected: true }] } },
  ]) {
    const resealed = integrations.sealBridgeProjection(mutation.value);
    assert.equal(integrations.validateBridgeProjection(resealed).valid, false, mutation.label);
    assert.equal(integrations.validateBridgeRuntimeEnvelope(resealed).valid, false, mutation.label);
  }

  for (const invalidInput of [
    { ...input, adapter: 'superpowers' },
    { ...input, adapterVersion: '9.0.0' },
    { ...input, references: [{ ...input.references[0], kind: 'opaque-command' }] },
    { ...input, mappings: [{ ...input.mappings[0], source_kind: 'opaque' }] },
  ]) {
    assert.throws(
      () => integrations.createBridgeProjection(invalidInput),
      (error) => error.code === 'BRIDGE_PROJECTION_INVALID',
    );
  }
});

test('[req:BRIDGE-20] projection identity binds decision and diagnostic fields', () => {
  const projection = integrations.createBridgeProjection({
    adapter: 'spec-kit', adapterVersion: '1.1.0', sourceRoot: '.specify',
    claims: [{ concept: 'spec_source', owner: 'wendkeep' }], references: [], mappings: [],
  });
  assert.equal(integrations.validateBridgeProjection(projection).valid, true);
  assert.equal(integrations.validateBridgeProjection({ ...projection, ok: false }).valid, false);
  assert.equal(integrations.validateBridgeProjection({
    ...projection,
    diagnostics: [{ schema_version: 1, code: 'BRIDGE_SOURCE_DRIFT', adapter: 'spec-kit', blocking: true, message: 'stale' }],
  }).valid, false);
});

test('[req:BRIDGE-17] drift binds capability/change/task mapping even when source hashes match', () => {
  const base = integrations.createBridgeProjection({
    adapter: 'spec-kit', adapterVersion: '1.1.0', sourceRoot: '.specify',
    claims: [{ concept: 'spec_source', owner: 'wendkeep' }],
    references: [{ kind: 'spec', source_id: 'AUTH-1', path: '.specify/spec.md', sha256: 'a'.repeat(64) }],
    mappings: [{ source_id: 'AUTH-1', source_kind: 'requirement', capability: 'auth', change_slug: '001-auth', task_ids: ['T001'] }],
  });
  const remapped = integrations.sealBridgeProjection({
    ...base,
    mappings: [{ source_id: 'AUTH-1', source_kind: 'requirement', capability: 'admin', change_slug: '002-admin', task_ids: ['T009'] }],
  });
  const drift = integrations.detectBridgeDrift(base, remapped);
  assert.equal(drift.ok, false);
  assert.equal(drift.diagnostics.some((item) => item.code === 'BRIDGE_SOURCE_DRIFT' && /mapping/.test(item.message)), true);
});
