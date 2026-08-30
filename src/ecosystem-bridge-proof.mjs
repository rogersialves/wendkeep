import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { getLocale } from '../hooks/locale.mjs';
import { parseTasks } from '../hooks/change-core.mjs';
import { buildEffectiveRequirementPackage, tasksHashOf } from '../hooks/spec-core.mjs';
import { loadSensorsDetailed, requiredSensors } from '../hooks/sensors-core.mjs';
import { evaluateEvidenceBinding } from '../packages/vault/src/evidence-envelope.mjs';
import { bridgeSha256, canonicalBridgeJson } from '../packages/integrations/src/index.mjs';
import { issueCanonicalArtifactProof } from '../packages/integrations/src/canonical-bridge-authority.mjs';
import { captureGitSnapshot, resolveEvidenceIdentity, sensorConfigSha256 } from './evidence-envelope.mjs';
import { collectBridgeArtifactEvidence } from './ecosystem-bridge-artifact-collector.mjs';

function safeSlug(value) {
  const slug = String(value || '').trim();
  return /^[a-z0-9][a-z0-9._-]*$/i.test(slug) && !slug.includes('..') ? slug : '';
}

export function deriveCanonicalArtifactProof({
  artifact, proof, projectRoot, vaultBase, changeSlug, sessionId = '', spawn = spawnSync,
} = {}) {
  try {
    const slug = safeSlug(changeSlug);
    if (!slug || proof?.type !== 'evidence-envelope'
      || String(proof?.external_id || '') !== String(artifact?.external_id || '')) return null;

    const root = realpathSync(resolve(projectRoot));

    const evidencePath = join(vaultBase, getLocale(vaultBase).folders.changes, slug, 'evidencia.json');
    if (!existsSync(evidencePath) || !lstatSync(evidencePath).isFile()) return null;
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    const changeDir = join(vaultBase, getLocale(vaultBase).folders.changes, slug);
    const tarefas = readFileSync(join(changeDir, 'tarefas.md'), 'utf8');
    const tasks = parseTasks(tarefas);
    const sensorIds = requiredSensors(tasks);
    const loaded = loadSensorsDetailed(root);
    if (loaded.error || loaded.missing) return null;
    const reqIds = [...new Set(tasks.flatMap((task) => task.reqs ?? []))];
    const effective = buildEffectiveRequirementPackage(vaultBase, changeDir, reqIds);
    const identity = resolveEvidenceIdentity({
      vaultBase, projectRoot: root, changeSlug: slug, sessionId, spawn,
    });
    const snapshot = captureGitSnapshot(root, { spawn });
    const binding = evaluateEvidenceBinding(evidence, {
      change_slug: slug,
      identity,
      snapshot,
      tasks_sha256: tasksHashOf(tarefas),
      effective_spec_sha256: `sha256:${effective.hash}`,
      sensor_config_sha256: sensorConfigSha256(loaded.sensors, sensorIds),
    });
    if (binding.state !== 'bound') return null;
    const envelopeArtifact = (evidence.external_artifacts || []).find((item) => (
      item.source === 'superpowers'
      && item.external_id === artifact.external_id
      && item.kind === artifact.kind
      && item.sha256 === artifact.sha256
      && item.authority === 'verified'
    ));
    if (!envelopeArtifact) return null;
    const currentArtifacts = collectBridgeArtifactEvidence({
      projectRoot: root, tasks, sensors: evidence.sensors || [], spawn,
    });
    const currentArtifact = currentArtifacts.find((item) => item.external_id === artifact.external_id);
    if (!currentArtifact || currentArtifact.authority !== 'verified'
      || canonicalBridgeJson(currentArtifact) !== canonicalBridgeJson(envelopeArtifact)) return null;
    const sensor = (evidence.sensors || []).find((item) => item.id === envelopeArtifact.sensor_id);
    const artifactResult = (sensor?.artifact_results || []).find((item) => (
      item.external_id === artifact.external_id && item.path === envelopeArtifact.path
      && item.algorithm === 'sha256' && item.digest === artifact.sha256
    ));
    if (!sensor || sensor.status !== 'green' || sensor.exit_code !== 0 || !artifactResult) return null;

    const canonical = {
      schema_version: 1,
      contract_kind: 'proof',
      type: 'evidence-envelope',
      authority: 'verified',
      external_id: artifact.external_id,
      artifact_sha256: artifact.sha256,
      origin: { tool: 'wendkeep', evidence_envelope_id: evidence.envelope_id },
      provenance: { state: 'verified', source: 'wendkeep-evidence-envelope' },
      evidence_envelope_id: evidence.envelope_id,
      sensor_id: envelopeArtifact.sensor_id,
      task_id: envelopeArtifact.task_id,
      path: envelopeArtifact.path,
      head_sha: evidence.head_sha,
      git_blob: envelopeArtifact.git_blob,
      manifest_git_blob: envelopeArtifact.manifest_git_blob,
    };
    canonical.proof_id = bridgeSha256(canonicalBridgeJson(canonical));
    return issueCanonicalArtifactProof(canonical);
  } catch {
    return null;
  }
}
