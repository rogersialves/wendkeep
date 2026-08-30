import { createHash } from 'node:crypto';

import { ECOSYSTEM_ADAPTER_MANIFESTS, isVersionInRange } from './capabilities.mjs';
import { bridgeDiagnostic, bridgeError } from './bridge-diagnostics.mjs';

export const ECOSYSTEM_BRIDGE_SCHEMA_VERSION = 1;

const SPEC_PROJECTION_ADAPTER = 'spec-kit';
const REFERENCE_KINDS = new Set(['constitution', 'spec', 'plan', 'task', 'artifact', 'review', 'commit']);
const MAPPING_SOURCE_KINDS = new Set(['story', 'requirement']);

export const BRIDGE_AUTHORITY_MATRIX = Object.freeze({
  spec_source: Object.freeze({ canonical_owner: 'wendkeep', adapters: ['spec-kit'], external_authority: 'reported' }),
  plan: Object.freeze({ canonical_owner: 'wendkeep', adapters: ['spec-kit'], external_authority: 'reported' }),
  task: Object.freeze({ canonical_owner: 'wendkeep', adapters: ['spec-kit', 'superpowers'], external_authority: 'reported' }),
  execution: Object.freeze({ canonical_owner: 'wendkeep', adapters: ['superpowers'], external_authority: 'reported' }),
  artifact: Object.freeze({ canonical_owner: 'wendkeep', adapters: ['superpowers'], external_authority: 'reported' }),
  evidence: Object.freeze({ canonical_owner: 'wendkeep', adapters: ['superpowers'], external_authority: 'reported' }),
});

export function canonicalBridgeJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalBridgeJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalBridgeJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function bridgeSha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

export function validateBridgeOwnership({ adapter = '', claims = [] } = {}) {
  const diagnostics = [];
  for (const claim of Array.isArray(claims) ? claims : []) {
    const concept = String(claim?.concept || '');
    const owner = String(claim?.owner || '');
    const policy = BRIDGE_AUTHORITY_MATRIX[concept];
    if (!policy || owner !== policy.canonical_owner) {
      diagnostics.push(bridgeDiagnostic('BRIDGE_OWNERSHIP_CONFLICT', {
        adapter,
        expected: policy?.canonical_owner || 'wendkeep',
        observed: owner || '(missing)',
        message: `external adapter cannot own canonical ${concept || 'state'}`,
      }));
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

function projectionIdentity(value) {
  const { projection_id: ignoredId, ...identity } = value || {};
  return identity;
}

function validSha(value, size = 64) {
  return new RegExp(`^[a-f0-9]{${size}}$`).test(String(value || ''));
}

function validReportedMetadata(value) {
  return Boolean(value?.origin?.tool && value?.provenance?.state === 'reported' && value?.provenance?.source);
}

function validVerifiedMetadata(value) {
  return Boolean(value?.origin?.tool === 'wendkeep'
    && value?.provenance?.state === 'verified'
    && value?.provenance?.source === 'wendkeep-evidence-envelope');
}

function hasExactKeys(value, expected) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0'));
}

export function createBridgeProjection({
  adapter, adapterVersion, sourceRoot = '', references = [], mappings = [], claims = [],
} = {}) {
  const ownership = validateBridgeOwnership({ adapter, claims });
  const manifest = ECOSYSTEM_ADAPTER_MANIFESTS[String(adapter || '')];
  const projection = {
    schema_version: ECOSYSTEM_BRIDGE_SCHEMA_VERSION,
    contract_kind: 'spec-projection',
    adapter: String(adapter || ''),
    adapter_version: String(adapterVersion || ''),
    source_root: String(sourceRoot || '').replaceAll('\\', '/'),
    authority: 'reported',
    origin: {
      tool: String(adapter || ''), version: String(adapterVersion || ''),
      root: String(sourceRoot || '').replaceAll('\\', '/'),
    },
    compatibility: {
      range: String(manifest?.compatibility_range || ''),
      detected_version: String(adapterVersion || ''),
      supported: Boolean(manifest && isVersionInRange(adapterVersion, manifest.compatibility_range)),
    },
    provenance: { state: 'reported', source: 'external-read-only' },
    ownership: claims.map((claim) => ({ concept: String(claim.concept || ''), owner: String(claim.owner || '') })),
    references: references.map((item) => ({
      kind: String(item.kind || ''),
      source_id: String(item.source_id || ''),
      path: String(item.path || '').replaceAll('\\', '/'),
      sha256: String(item.sha256 || ''),
      authority: 'reported',
      ...(item.title ? { title: String(item.title).slice(0, 300) } : {}),
    })),
    mappings: mappings.map((item) => ({
      source_id: String(item.source_id || ''),
      source_kind: String(item.source_kind || ''),
      capability: String(item.capability || ''),
      change_slug: String(item.change_slug || ''),
      task_ids: [...new Set(Array.isArray(item.task_ids) ? item.task_ids.map(String) : [])],
    })),
    diagnostics: ownership.diagnostics,
  };
  const sealed = sealBridgeProjection({ ...projection, ok: ownership.ok });
  const validation = validateBridgeProjection(sealed);
  const contractDiagnostics = validation.diagnostics.filter((item) => item.code === 'BRIDGE_PROJECTION_INVALID');
  if (contractDiagnostics.length) {
    throw bridgeError('BRIDGE_PROJECTION_INVALID', contractDiagnostics[0].message, {
      adapter: String(adapter || ''), diagnostics: contractDiagnostics,
    });
  }
  return sealed;
}

export function sealBridgeProjection(value) {
  const projection = structuredClone(value || {});
  delete projection.projection_id;
  return {
    ...projection,
    projection_id: bridgeSha256(canonicalBridgeJson(projectionIdentity(projection))),
  };
}

export function validateBridgeProjection(value) {
  const diagnostics = [];
  const fail = (message) => diagnostics.push(bridgeDiagnostic('BRIDGE_PROJECTION_INVALID', {
    adapter: String(value?.adapter || ''), message,
  }));
  if (value?.schema_version !== 1 || value?.contract_kind !== 'spec-projection') fail('projection contract kind/schema is invalid');
  const manifest = ECOSYSTEM_ADAPTER_MANIFESTS[SPEC_PROJECTION_ADAPTER];
  if (value?.adapter !== SPEC_PROJECTION_ADAPTER) fail('spec projection adapter must be spec-kit');
  if (typeof value?.adapter_version !== 'string' || !value.adapter_version
    || !value?.origin || !value?.compatibility || !value?.provenance) fail('projection metadata is incomplete');
  if (value?.authority !== 'reported' || value?.provenance?.state !== 'reported'
    || value?.provenance?.source !== 'external-read-only') fail('external projection cannot be authoritative');
  if (!hasExactKeys(value?.provenance, ['state', 'source'])) fail('projection provenance shape is invalid');
  if (value?.origin?.tool !== SPEC_PROJECTION_ADAPTER || value?.origin?.version !== value?.adapter_version
    || typeof value?.origin?.root !== 'string') fail('projection origin does not match its adapter/version');
  if (!hasExactKeys(value?.compatibility, ['range', 'detected_version', 'supported'])
    || value?.compatibility?.range !== manifest.compatibility_range
    || value?.compatibility?.detected_version !== value?.adapter_version
    || value?.compatibility?.supported !== true
    || !isVersionInRange(value?.adapter_version, manifest.compatibility_range)) {
    fail('projection adapter version is incompatible');
  }
  const decisionFieldsValid = Array.isArray(value?.diagnostics) && typeof value?.ok === 'boolean';
  if (!decisionFieldsValid) fail('projection decision fields are invalid');
  if (decisionFieldsValid) {
    const malformedDiagnostic = value.diagnostics.some((item) => (
      !item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.code !== 'string' || !item.code
      || typeof item.blocking !== 'boolean'
      || typeof item.message !== 'string' || !item.message
    ));
    if (malformedDiagnostic) fail('projection diagnostics are malformed');
    const hasBlockingDiagnostic = value.diagnostics.some((item) => item?.blocking === true);
    if (value.ok === hasBlockingDiagnostic) fail('projection ok decision does not match blocking diagnostics');
  }
  if (!Array.isArray(value?.ownership)) fail('projection ownership is invalid');
  if (!Array.isArray(value?.references) || value.references.some((item) => (
    !REFERENCE_KINDS.has(item?.kind) || typeof item?.source_id !== 'string' || !item.source_id
    || typeof item?.path !== 'string' || !item.path || !validSha(item?.sha256) || item?.authority !== 'reported'
    || (item?.title !== undefined && (typeof item.title !== 'string' || item.title.length > 300))
  ))) fail('projection references are invalid');
  if (!Array.isArray(value?.mappings) || value.mappings.some((item) => (
    !hasExactKeys(item, ['source_id', 'source_kind', 'capability', 'change_slug', 'task_ids'])
    || typeof item?.source_id !== 'string' || !item.source_id || !MAPPING_SOURCE_KINDS.has(item?.source_kind)
    || typeof item?.capability !== 'string' || !item.capability
    || typeof item?.change_slug !== 'string' || !item.change_slug
    || !Array.isArray(item?.task_ids) || item.task_ids.some((taskId) => typeof taskId !== 'string' || !taskId)
    || new Set(item.task_ids).size !== item.task_ids.length
  ))) fail('projection mappings are invalid');
  const ownership = validateBridgeOwnership({ adapter: value?.adapter, claims: value?.ownership });
  diagnostics.push(...ownership.diagnostics);
  const expected = bridgeSha256(canonicalBridgeJson(projectionIdentity(value)));
  if (!validSha(value?.projection_id) || value.projection_id !== expected) fail('projection_id does not match canonical projection bytes');
  return { valid: diagnostics.length === 0, diagnostics, expected_projection_id: expected };
}

export function validateBridgeRuntimeEnvelope(value) {
  const diagnostics = [];
  const invalid = (message) => diagnostics.push(bridgeDiagnostic('BRIDGE_SCHEMA_INVALID', {
    adapter: String(value?.adapter || ''), message,
  }));
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== 1) {
    invalid('bridge envelope must be a schema v1 object');
    return { valid: false, diagnostics };
  }
  const kind = String(value.contract_kind || '');
  if (kind === 'spec-projection') {
    const projection = validateBridgeProjection(value);
    return {
      valid: projection.valid,
      diagnostics: projection.valid ? [] : projection.diagnostics.map((item) => bridgeDiagnostic('BRIDGE_SCHEMA_INVALID', {
        adapter: value.adapter, message: item.message,
      })),
    };
  }
  if (kind === 'dispatch') {
    if (value.adapter !== 'superpowers' || value.authority !== 'reported' || value.canonical_owner !== 'wendkeep'
      || !validReportedMetadata(value) || !value.compatibility?.range || value.compatibility?.supported !== true
      || !value.task_contract?.contract_id
      || !value.task_contract?.binding?.active_context_id || !value.worktree?.provider || !validSha(value.dispatch_id)) {
      invalid('dispatch envelope is incomplete');
    }
    const { dispatch_id: ignoredId, ok: ignoredOk, ...identity } = value;
    if (validSha(value.dispatch_id) && bridgeSha256(canonicalBridgeJson(identity)) !== value.dispatch_id) {
      invalid('dispatch_id does not match canonical dispatch bytes');
    }
  } else if (kind === 'handoff') {
    if (!value.handoff_id || !value.task_contract_id || !validSha(value.head_sha, 40)
      || value.authority !== 'reported' || !validReportedMetadata(value)) invalid('handoff envelope is incomplete');
  } else if (kind === 'external-artifact') {
    const authorityValid = value.authority === 'reported'
      ? validReportedMetadata(value)
      : (value.authority === 'verified' && validVerifiedMetadata(value)
        && validateBridgeRuntimeEnvelope(value.proof).valid
        && value.proof.artifact_sha256 === value.sha256);
    if (value.source !== 'superpowers' || !value.external_id || !['artifact', 'review', 'commit'].includes(value.kind)
      || !validSha(value.sha256) || !authorityValid) invalid('external artifact envelope is invalid');
  } else if (kind === 'proof') {
    const { proof_id: ignoredId, ...identity } = value;
    if (value.type !== 'evidence-envelope' || !validSha(value.artifact_sha256)
      || value.authority !== 'verified' || !validVerifiedMetadata(value)
      || !validSha(value.proof_id) || bridgeSha256(canonicalBridgeJson(identity)) !== value.proof_id
      || !String(value.evidence_envelope_id || '').match(/^sha256:[a-f0-9]{64}$/)
      || value.origin?.evidence_envelope_id !== value.evidence_envelope_id
      || !value.external_id || !value.sensor_id || !value.task_id || !value.path
      || !validSha(value.head_sha, 40) || !validSha(value.git_blob, 40) || !validSha(value.manifest_git_blob, 40)) {
      invalid('proof envelope is invalid');
    }
  } else if (kind === 'status-projection') {
    if (value.adapter !== 'spec-kit' || value.authority !== 'reported' || value.canonical_owner !== 'wendkeep'
      || !validReportedMetadata(value) || !validSha(value.source_projection_id)
      || !Array.isArray(value.tasks) || !Array.isArray(value.evidence)) invalid('status projection is invalid');
    const { status_projection_id: ignoredId, ...identity } = value;
    if (!validSha(value.status_projection_id)
      || bridgeSha256(canonicalBridgeJson(identity)) !== value.status_projection_id) invalid('status_projection_id is invalid');
  } else {
    invalid(`unknown bridge contract_kind: ${kind || '(missing)'}`);
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export function detectBridgeDrift(previous, current) {
  const before = new Map((previous?.references || []).map((item) => [item.source_id, item]));
  const after = new Map((current?.references || []).map((item) => [item.source_id, item]));
  const diagnostics = [];
  for (const item of current?.references || []) {
    const expected = before.get(item.source_id);
    if (!before.has(item.source_id)) {
      diagnostics.push(bridgeDiagnostic('BRIDGE_SOURCE_DRIFT', {
        adapter: current.adapter,
        path: item.path,
        expected: '(absent)',
        observed: 'new',
        message: `new external source appeared: ${item.source_id}`,
      }));
    } else if (canonicalBridgeJson({ kind: expected.kind, path: expected.path, sha256: expected.sha256 })
      !== canonicalBridgeJson({ kind: item.kind, path: item.path, sha256: item.sha256 })) {
      diagnostics.push(bridgeDiagnostic('BRIDGE_SOURCE_DRIFT', {
        adapter: current.adapter,
        path: item.path,
        expected: canonicalBridgeJson({ kind: expected.kind, path: expected.path, sha256: expected.sha256 }),
        observed: canonicalBridgeJson({ kind: item.kind, path: item.path, sha256: item.sha256 }),
        message: `external source path/kind/hash drifted: ${item.source_id}`,
      }));
    }
  }
  for (const item of previous?.references || []) {
    if (!after.has(item.source_id)) {
      diagnostics.push(bridgeDiagnostic('BRIDGE_SOURCE_DRIFT', {
        adapter: current.adapter,
        path: item.path,
        expected: canonicalBridgeJson({ kind: item.kind, path: item.path, sha256: item.sha256 }),
        observed: '(missing)',
        message: `external source disappeared: ${item.source_id}`,
      }));
    }
  }
  const beforeMappings = new Map((previous?.mappings || []).map((item) => [item.source_id, item]));
  const afterMappings = new Map((current?.mappings || []).map((item) => [item.source_id, item]));
  for (const [sourceId, mapping] of afterMappings) {
    const expected = beforeMappings.get(sourceId);
    if (!expected || canonicalBridgeJson(expected) !== canonicalBridgeJson(mapping)) {
      diagnostics.push(bridgeDiagnostic('BRIDGE_SOURCE_DRIFT', {
        adapter: current?.adapter,
        expected: expected ? canonicalBridgeJson(expected) : '(absent)',
        observed: canonicalBridgeJson(mapping),
        message: `external capability/change/task mapping drifted: ${sourceId}`,
      }));
    }
  }
  for (const [sourceId, mapping] of beforeMappings) {
    if (!afterMappings.has(sourceId)) {
      diagnostics.push(bridgeDiagnostic('BRIDGE_SOURCE_DRIFT', {
        adapter: current?.adapter,
        expected: canonicalBridgeJson(mapping), observed: '(missing)',
        message: `external capability/change/task mapping disappeared: ${sourceId}`,
      }));
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}
