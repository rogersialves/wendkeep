const dispatchReceipts = new WeakMap();
const artifactProofReceipts = new WeakMap();

function receipt(kind) {
  return Object.freeze({ schema_version: 1, kind });
}

// Internal composition-root capability. This module is deliberately not re-exported by index.mjs.
export function issueCanonicalDispatchAuthority({ task_contract, active_context } = {}) {
  const value = receipt('canonical-dispatch-authority');
  dispatchReceipts.set(value, {
    task_contract: structuredClone(task_contract),
    active_context: structuredClone(active_context),
  });
  return value;
}

export function readCanonicalDispatchAuthority(value) {
  const payload = value && typeof value === 'object' ? dispatchReceipts.get(value) : null;
  return payload ? structuredClone(payload) : null;
}

export function issueCanonicalArtifactProof(proof = {}) {
  const value = receipt('canonical-artifact-proof');
  artifactProofReceipts.set(value, structuredClone(proof));
  return value;
}

export function readCanonicalArtifactProof(value) {
  const payload = value && typeof value === 'object' ? artifactProofReceipts.get(value) : null;
  return payload ? structuredClone(payload) : null;
}
