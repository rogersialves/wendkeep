import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  HOST_CAPABILITIES,
  HOST_CAPABILITY_MANIFESTS,
  evaluateHostCoverage,
  normalizeHostEnvelope,
  verifyHostCapabilityManifest,
} from '../packages/integrations/src/capabilities.mjs';
import { loadSensorsDetailed } from '../packages/harness/src/sensors-core.mjs';
import { buildHostCoverage } from '../src/host-capabilities.mjs';
import { MCP_EFFECT_MANIFEST } from '../packages/mcp/src/effects.mjs';
import { normalizePiLifecycleEvent, piAdapterDescriptor } from '../packages/pi/src/index.mjs';

test('[req:HOST-1] every host manifest declares the complete lifecycle matrix', () => {
  assert.equal(HOST_CAPABILITIES.length, 17);
  for (const host of ['claude', 'codex', 'pi', 'generic-mcp']) {
    const manifest = HOST_CAPABILITY_MANIFESTS[host];
    assert.equal(verifyHostCapabilityManifest(manifest).valid, true, host);
    assert.deepEqual(Object.keys(manifest.capabilities).sort(), [...HOST_CAPABILITIES].sort());
  }
});

test('[req:HOST-2] Codex reports TaskCompleted as unavailable and manual work is never verified', () => {
  const coverage = buildHostCoverage({
    hostId: 'codex', hostVersion: '1.2.0', effectManifest: MCP_EFFECT_MANIFEST,
    observedAt: '2026-08-25T12:00:00.000Z',
  });
  const task = coverage.capabilities.find((item) => item.capability === 'task.completed');
  const decision = coverage.capabilities.find((item) => item.capability === 'decision.capture');
  assert.deepEqual({ state: task.state, authority: task.authority }, { state: 'unavailable', authority: 'unavailable' });
  assert.deepEqual({ state: decision.state, authority: decision.authority }, { state: 'manual', authority: 'reported' });
  assert.ok(coverage.degradations.some((item) => item.capability === 'task.completed'));
});

test('[req:HOST-3] unknown hosts and unsupported versions fall back to explicit MCP/CLI degradation', () => {
  const unknown = buildHostCoverage({ hostId: 'future-agent', hostVersion: '99.0.0' });
  assert.equal(unknown.host_id, 'generic-mcp');
  assert.equal(unknown.requested_host_id, 'future-agent');
  assert.equal(unknown.degraded, true);
  assert.equal(unknown.degradations.some((item) => item.code === 'HOST_UNKNOWN'), true);

  const unsupported = buildHostCoverage({ hostId: 'codex', hostVersion: '99.0.0' });
  assert.equal(unsupported.version_supported, false);
  assert.equal(unsupported.degradations.some((item) => item.code === 'HOST_VERSION_UNPROVEN'), true);
});

test('[req:HOST-4] MCP effects come from the signed manifest, never from a misleading name', () => {
  const coverage = buildHostCoverage({ hostId: 'generic-mcp', effectManifest: MCP_EFFECT_MANIFEST });
  assert.deepEqual(coverage.tool_effects, {
    manifest_valid: true,
    catalog_version: MCP_EFFECT_MANIFEST.catalog_version,
    read: true,
    write: true,
    destructive: false,
    unknown: 'fail-closed',
  });
  const tampered = structuredClone(MCP_EFFECT_MANIFEST);
  tampered.tools[0].effect = 'destructive';
  const invalid = buildHostCoverage({ hostId: 'generic-mcp', effectManifest: tampered });
  assert.equal(invalid.tool_effects.manifest_valid, false);
  assert.equal(invalid.tool_effects.unknown, 'fail-closed');
});

test('[req:HOST-5] unavailable required capability blocks without an explicit human waiver', () => {
  const coverage = buildHostCoverage({ hostId: 'codex' });
  const blocked = evaluateHostCoverage(coverage, ['task.completed']);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.findings[0].code, 'HOST_CAPABILITY_UNAVAILABLE');
  const waived = evaluateHostCoverage(coverage, ['task.completed'], {
    waivers: [{ capability: 'task.completed', authority: 'human', approved_by: 'maintainer', reason: 'manual confirmation' }],
  });
  assert.equal(waived.ok, true);
  assert.equal(waived.waived.length, 1);
});

test('[req:HOST-6] unknown envelopes fail closed before becoming lifecycle evidence', () => {
  assert.deepEqual(normalizeHostEnvelope({ hostId: 'codex', event: 'SessionStart', envelopeVersion: 1 }), {
    ok: true, capability: 'session.start', state: 'native', authority: 'verified',
  });
  const unknown = normalizeHostEnvelope({ hostId: 'codex', event: 'FutureEvent', envelopeVersion: 1 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'HOST_ENVELOPE_UNKNOWN');
  assert.equal(normalizeHostEnvelope({ hostId: 'codex', event: 'SessionStart', envelopeVersion: 99 }).ok, false);
});

test('[req:HOST-7] Pi is a tested thin adapter instead of an empty workspace', () => {
  assert.equal(piAdapterDescriptor().host_id, 'pi');
  assert.deepEqual(normalizePiLifecycleEvent({ type: 'session_start', sessionId: 'pi-session' }), {
    schema_version: 1, host_id: 'pi', capability: 'session.start', session_id: 'pi-session', authority: 'adapted',
  });
  assert.equal(normalizePiLifecycleEvent({ type: 'unknown' }).ok, false);
  assert.equal(readFileSync(new URL('../packages/pi/src/index.mjs', import.meta.url), 'utf8').includes('../mcp/'), false);
});

test('[req:HOST-11] CLI exposes exact host coverage without requiring a Vault', () => {
  const bin = fileURLToPath(new URL('../bin/wendkeep.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [bin, 'capabilities', '--host', 'codex', '--host-version', '1.2.0', '--json'], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.host_id, 'codex');
  assert.equal(payload.capabilities.length, 17);
  assert.equal(payload.degradations.some((item) => item.capability === 'task.completed'), true);

  const invalid = spawnSync(process.execPath, [bin, 'capabilities', '--host'], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /HOST_ARGUMENT_INVALID/);
});

test('[req:HOST-12] published schemas and sensor config expose capability gates and human waivers', () => {
  const root = new URL('..', import.meta.url);
  const manifestSchema = JSON.parse(readFileSync(new URL('schema/host-capability-manifest-v1.schema.json', root), 'utf8'));
  const coverageSchema = JSON.parse(readFileSync(new URL('schema/host-coverage-v1.schema.json', root), 'utf8'));
  const sensorSchema = JSON.parse(readFileSync(new URL('schema/wendkeep.sensors.schema.json', root), 'utf8'));
  const handoffSchema = JSON.parse(readFileSync(new URL('schema/handoff-contract-v1.schema.json', root), 'utf8'));
  assert.equal(manifestSchema.$defs.capabilityName.enum.length, 17);
  assert.equal(coverageSchema.properties.capabilities.minItems, 17);
  assert.ok(sensorSchema.properties.requires_host_capabilities);
  assert.equal(sensorSchema.properties.host_capability_waivers.items.properties.authority.const, 'human');
  assert.ok(handoffSchema.properties.host_coverage);

  const fixture = new URL('fixtures/host-capability-sensors.json', import.meta.url);
  const loaded = loadSensorsDetailed(fileURLToPath(new URL('fixtures', import.meta.url)), 'host-capability-sensors.json');
  assert.deepEqual(loaded.requiredHostCapabilities, ['task.completed']);
  assert.equal(loaded.hostCapabilityWaivers[0].authority, 'human');
  assert.equal(fileURLToPath(fixture).endsWith('host-capability-sensors.json'), true);
});
