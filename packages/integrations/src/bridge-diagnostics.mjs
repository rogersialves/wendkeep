export const BRIDGE_DIAGNOSTIC_CODES = Object.freeze({
  adapterDisabled: 'BRIDGE_ADAPTER_DISABLED',
  adapterMissing: 'BRIDGE_ADAPTER_MISSING',
  adapterUnknown: 'BRIDGE_ADAPTER_UNKNOWN',
  versionMissing: 'BRIDGE_VERSION_MISSING',
  versionIncompatible: 'BRIDGE_VERSION_INCOMPATIBLE',
  ownershipConflict: 'BRIDGE_OWNERSHIP_CONFLICT',
  sourceInvalid: 'BRIDGE_SOURCE_INVALID',
  sourceDrift: 'BRIDGE_SOURCE_DRIFT',
  sourceIdDuplicate: 'BRIDGE_SOURCE_ID_DUPLICATE',
  contractInvalid: 'BRIDGE_CONTRACT_INVALID',
  contractStale: 'BRIDGE_CONTRACT_STALE',
  canonicalAuthorityRequired: 'BRIDGE_CANONICAL_AUTHORITY_REQUIRED',
  projectionInvalid: 'BRIDGE_PROJECTION_INVALID',
  schemaInvalid: 'BRIDGE_SCHEMA_INVALID',
  baselineMissing: 'BRIDGE_BASELINE_MISSING',
  baselineStale: 'BRIDGE_BASELINE_STALE',
  baselineInvalid: 'BRIDGE_BASELINE_INVALID',
  artifactManifestInvalid: 'BRIDGE_ARTIFACT_MANIFEST_INVALID',
  artifactManifestUntracked: 'BRIDGE_ARTIFACT_MANIFEST_UNTRACKED',
  artifactForged: 'BRIDGE_ARTIFACT_FORGED',
  artifactTaskUnbound: 'BRIDGE_ARTIFACT_TASK_UNBOUND',
  artifactResultMissing: 'BRIDGE_ARTIFACT_RESULT_MISSING',
  proofMissing: 'BRIDGE_PROOF_MISSING',
  proofUnverified: 'BRIDGE_PROOF_UNVERIFIED',
});

export function bridgeDiagnostic(code, {
  adapter = '', message = '', blocking = true, expected = '', observed = '', path = '',
} = {}) {
  return {
    schema_version: 1,
    code: String(code),
    adapter: String(adapter),
    blocking: Boolean(blocking),
    message: String(message || code),
    ...(expected ? { expected: String(expected) } : {}),
    ...(observed ? { observed: String(observed) } : {}),
    ...(path ? { path: String(path).replaceAll('\\', '/') } : {}),
  };
}

export function bridgeError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, diagnostics: [bridgeDiagnostic(code, details)] });
}
