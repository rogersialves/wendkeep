import { assessBridgeAdapter } from './bridge-config.mjs';
import {
  bridgeSha256, canonicalBridgeJson, validateBridgeOwnership, validateBridgeProjection,
  validateBridgeRuntimeEnvelope,
} from './bridge-contract.mjs';
import { bridgeDiagnostic } from './bridge-diagnostics.mjs';
import {
  readCanonicalArtifactProof, readCanonicalDispatchAuthority,
} from './canonical-bridge-authority.mjs';

function publicTaskContract(contract) {
  return {
    schema_version: 1,
    contract_id: String(contract.contract_id),
    task_id: String(contract.task_id),
    change_slug: String(contract.change_slug || ''),
    title: String(contract.title || '').slice(0, 500),
    phase: String(contract.phase || ''),
    status: String(contract.status || ''),
    inputs: [...(contract.inputs || [])].map(String),
    expected_outputs: [...(contract.expected_outputs || [])].map(String),
    acceptance_criteria: [...(contract.acceptance_criteria || [])].map(String),
    requirement_ids: [...(contract.requirement_ids || [])].map(String),
    required_sensors: [...(contract.required_sensors || [])].map(String),
    required_artifacts: [...(contract.required_artifacts || [])].map(String),
    dependencies: [...(contract.dependencies || [])].map(String),
    authored_sha256: String(contract.authored_sha256 || ''),
    binding: {
      project_id: String(contract.binding?.project_id || ''),
      active_context_id: String(contract.binding?.active_context_id || ''),
      head_sha: String(contract.binding?.head_sha || ''),
      tasks_sha256: String(contract.binding?.tasks_sha256 || ''),
      effective_spec_sha256: String(contract.binding?.effective_spec_sha256 || ''),
      artifact_manifest_sha256: String(contract.binding?.artifact_manifest_sha256 || ''),
    },
  };
}

function validateDispatchInput(taskContract, activeContext) {
  const diagnostics = [];
  if (taskContract?.schema_version !== 1 || !taskContract?.contract_id || !taskContract?.task_id
    || !taskContract?.authored_sha256 || !taskContract?.binding?.active_context_id || !taskContract?.binding?.head_sha) {
    diagnostics.push(bridgeDiagnostic('BRIDGE_CONTRACT_INVALID', {
      adapter: 'superpowers', message: 'a complete canonical task contract is required',
    }));
    return diagnostics;
  }
  for (const field of ['active_context_id', 'head_sha']) {
    if (activeContext?.[field] && String(activeContext[field]) !== String(taskContract.binding[field])) {
      diagnostics.push(bridgeDiagnostic('BRIDGE_CONTRACT_INVALID', {
        adapter: 'superpowers',
        expected: taskContract.binding[field],
        observed: activeContext[field],
        message: `canonical task binding is stale: ${field}`,
      }));
    }
  }
  return diagnostics;
}

function canonicalDispatchAuthority(submitted, authority) {
  const diagnostics = [];
  const issued = readCanonicalDispatchAuthority(authority);
  if (!issued?.task_contract || !issued?.active_context) {
    diagnostics.push(bridgeDiagnostic('BRIDGE_CANONICAL_AUTHORITY_REQUIRED', {
      adapter: 'superpowers', message: 'dispatch requires a task contract rederived from canonical WendKeep state',
    }));
    return { taskContract: null, activeContext: null, diagnostics };
  }
  const canonical = issued.task_contract;
  const activeContext = issued.active_context;
  for (const field of ['contract_id', 'authored_sha256', 'task_id', 'change_slug']) {
    if (String(submitted?.[field] || '') !== String(canonical?.[field] || '')) {
      diagnostics.push(bridgeDiagnostic('BRIDGE_CONTRACT_STALE', {
        adapter: 'superpowers', expected: canonical?.[field], observed: submitted?.[field],
        message: `submitted task contract differs from canonical ${field}`,
      }));
    }
  }
  for (const field of ['project_id', 'active_context_id', 'head_sha', 'tasks_sha256', 'effective_spec_sha256', 'artifact_manifest_sha256']) {
    if (String(submitted?.binding?.[field] || '') !== String(canonical?.binding?.[field] || '')) {
      diagnostics.push(bridgeDiagnostic('BRIDGE_CONTRACT_STALE', {
        adapter: 'superpowers', expected: canonical?.binding?.[field], observed: submitted?.binding?.[field],
        message: `submitted task binding differs from canonical ${field}`,
      }));
    }
  }
  diagnostics.push(...validateDispatchInput(canonical, activeContext));
  return { taskContract: canonical, activeContext, diagnostics };
}

export function buildSuperpowersDispatch({
  taskContract, canonicalAuthority = null, handoffContract = null, specKitProjection = null,
  config, detectedVersion = '', present = true,
} = {}) {
  const assessment = assessBridgeAdapter('superpowers', { config, detectedVersion, present });
  if (!assessment.available) {
    const disabled = assessment.diagnostics.every((item) => !item.blocking);
    return { schema_version: 1, adapter: 'superpowers', active: false, ok: disabled, diagnostics: assessment.diagnostics };
  }
  const canonical = canonicalDispatchAuthority(taskContract, canonicalAuthority);
  const authoritativeTask = canonical.taskContract;
  const diagnostics = [...canonical.diagnostics];
  const ownership = validateBridgeOwnership({
    adapter: 'superpowers', claims: config?.adapters?.superpowers?.ownership_claims || [],
  });
  diagnostics.push(...ownership.diagnostics);
  const handoffEnvelope = handoffContract ? {
    schema_version: 1,
    contract_kind: 'handoff',
    handoff_id: String(handoffContract.handoff_id || ''),
    task_contract_id: String(handoffContract.task_contract_id || ''),
    task_id: String(handoffContract.task_id || ''),
    head_sha: String(handoffContract.head_sha || ''),
    authority: 'reported',
    origin: { tool: 'wendkeep' },
    provenance: { state: 'reported', source: 'canonical-handoff-reference' },
  } : null;
  const handoffValidation = handoffEnvelope ? validateBridgeRuntimeEnvelope(handoffEnvelope) : { valid: true };
  if (handoffContract && (!handoffValidation.valid || handoffContract.schema_version !== 1
    || (handoffContract.task_contract_id && handoffContract.task_contract_id !== authoritativeTask?.contract_id)
    || (handoffContract.task_id && handoffContract.task_id !== authoritativeTask?.task_id))) {
    diagnostics.push(bridgeDiagnostic('BRIDGE_CONTRACT_INVALID', {
      adapter: 'superpowers', message: 'handoff does not bind the selected canonical task contract',
    }));
  }
  if (specKitProjection) {
    const blockers = (Array.isArray(specKitProjection.diagnostics) ? specKitProjection.diagnostics : [])
      .filter((item) => item?.blocking)
      .map((item) => ({
        schema_version: 1,
        code: String(item.code || 'BRIDGE_SOURCE_DRIFT'),
        adapter: 'spec-kit',
        blocking: true,
        message: String(item.message || item.code || 'external source blocks dispatch'),
        ...(item.expected ? { expected: String(item.expected) } : {}),
        ...(item.observed ? { observed: String(item.observed) } : {}),
      }));
    const projectionValidation = validateBridgeProjection(specKitProjection);
    if (!projectionValidation.valid) {
      diagnostics.push(bridgeDiagnostic('BRIDGE_PROJECTION_INVALID', {
        adapter: 'spec-kit', message: 'Spec Kit projection_id/schema does not match its canonical content',
      }));
      diagnostics.push(...blockers);
    } else if (specKitProjection.ok !== true) {
      diagnostics.push(...(blockers.length ? blockers : [bridgeDiagnostic('BRIDGE_PROJECTION_INVALID', {
        adapter: 'spec-kit', message: 'Spec Kit projection must be explicitly green before dispatch',
      })]));
    }
  }
  if (diagnostics.length) {
    return { schema_version: 1, adapter: 'superpowers', active: true, ok: false, diagnostics };
  }
  const dispatch = {
    schema_version: 1,
    contract_kind: 'dispatch',
    adapter: 'superpowers',
    adapter_version: assessment.version,
    active: true,
    canonical_owner: 'wendkeep',
    executor: 'superpowers',
    authority: 'reported',
    origin: { tool: 'superpowers', version: assessment.version },
    compatibility: {
      range: assessment.manifest.compatibility_range,
      detected_version: assessment.version,
      supported: true,
    },
    provenance: { state: 'reported', source: 'wendkeep-canonical-dispatch' },
    task_contract: publicTaskContract(authoritativeTask),
    ...(handoffContract ? {
      handoff_ref: {
        handoff_id: String(handoffContract.handoff_id || ''),
        task_contract_id: String(handoffContract.task_contract_id || ''),
        head_sha: String(handoffContract.head_sha || ''),
      },
    } : {}),
    spec_refs: (specKitProjection?.references || [])
      .filter((item) => ['spec', 'constitution'].includes(item.kind))
      .map((item) => ({ source_id: String(item.source_id), sha256: String(item.sha256) })),
    worktree: {
      provider: 'wendkeep',
      mode: 'reuse-or-create',
      create_argv: ['wendkeep', 'worktree', 'create', String(authoritativeTask.change_slug)],
      finish_argv: ['wendkeep', 'worktree', 'finish', String(authoritativeTask.change_slug), '--pr', '<number-or-url>'],
    },
    diagnostics: [],
  };
  dispatch.dispatch_id = bridgeSha256(canonicalBridgeJson(dispatch));
  const runtime = validateBridgeRuntimeEnvelope(dispatch);
  if (!runtime.valid) {
    return { schema_version: 1, adapter: 'superpowers', active: true, ok: false, diagnostics: runtime.diagnostics };
  }
  return { ...dispatch, ok: true };
}

export function ingestSuperpowersArtifacts(items = []) {
  return (Array.isArray(items) ? items : []).map((item, index) => {
    const externalId = String(item?.external_id || '').trim();
    const kind = String(item?.kind || 'artifact').trim();
    if (!externalId || !['artifact', 'review', 'commit'].includes(kind)) {
      throw Object.assign(new Error(`invalid Superpowers artifact at index ${index}`), { code: 'BRIDGE_CONTRACT_INVALID' });
    }
    const bytes = item.content === undefined ? String(item.sha256 || '') : String(item.content);
    const sha256 = /^[a-f0-9]{64}$/.test(String(item.sha256 || '')) && item.content === undefined
      ? String(item.sha256)
      : bridgeSha256(bytes);
    const artifact = {
      schema_version: 1,
      contract_kind: 'external-artifact',
      source: 'superpowers',
      external_id: externalId,
      kind,
      sha256,
      authority: 'reported',
      origin: { tool: 'superpowers', external_id: externalId },
      provenance: { state: 'reported', source: 'external-ingest' },
      proof: null,
      diagnostics: [],
    };
    const runtime = validateBridgeRuntimeEnvelope(artifact);
    if (!runtime.valid) {
      throw Object.assign(new Error(`invalid Superpowers artifact at index ${index}`), {
        code: 'BRIDGE_CONTRACT_INVALID', diagnostics: runtime.diagnostics,
      });
    }
    return artifact;
  });
}

export function verifyExternalArtifact(artifact, { proofs = [], canonicalProofs = [] } = {}) {
  const canonical = (Array.isArray(canonicalProofs) ? canonicalProofs : [])
    .map(readCanonicalArtifactProof)
    .find((proof) => (
      proof?.external_id === artifact?.external_id
      && proof?.artifact_sha256 === artifact?.sha256
      && proof?.authority === 'verified'
      && proof?.evidence_envelope_id
      && proof?.sensor_id
      && proof?.head_sha
      && proof?.proof_id
    ));
  if (canonical) {
    return {
      ...artifact,
      authority: 'verified',
      origin: { tool: 'wendkeep', evidence_envelope_id: canonical.evidence_envelope_id },
      provenance: { state: 'verified', source: 'wendkeep-evidence-envelope' },
      proof: { ...canonical },
      diagnostics: [],
    };
  }
  const matching = (Array.isArray(proofs) ? proofs : []).find((proof) => (
    ['git', 'ci', 'evidence-envelope'].includes(String(proof?.type || ''))
      && proof?.state === 'verified'
      && String(proof?.artifact_sha256 || '') === String(artifact?.sha256 || '')
  ));
  return {
    ...artifact,
    authority: 'reported',
    proof: null,
    diagnostics: [bridgeDiagnostic(matching ? 'BRIDGE_PROOF_UNVERIFIED' : 'BRIDGE_PROOF_MISSING', {
      adapter: 'superpowers',
      message: matching
        ? 'self-declared proof cannot promote authority; use the WendKeep Evidence Envelope/provenance gate'
        : `no independent proof binds ${artifact?.external_id || 'artifact'}`,
    })],
  };
}
