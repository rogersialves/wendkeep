import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { isProjectContainedPath } from '../packages/integrations/src/bridge-config.mjs';

const MANIFEST_PATH = '.wendkeep/bridge-artifacts.json';
const MAX_ARTIFACT_BYTES = 1024 * 1024;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function gitText(projectRoot, args, spawn = spawnSync) {
  const result = spawn('git', args, {
    cwd: projectRoot, encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0 && !result.error ? String(result.stdout || '').trim() : '';
}

function trackedBlob(projectRoot, path, spawn) {
  if (!gitText(projectRoot, ['ls-files', '--error-unmatch', '--', path], spawn)) return '';
  const working = gitText(projectRoot, ['hash-object', '--', path], spawn);
  const indexed = gitText(projectRoot, ['rev-parse', `:${path}`], spawn);
  return working && working === indexed ? indexed : '';
}

function safeProjectFile(projectRoot, path, code) {
  const candidate = resolve(projectRoot, String(path || ''));
  if (!String(path || '').trim() || !isProjectContainedPath(projectRoot, candidate)
    || !existsSync(candidate) || !lstatSync(candidate).isFile()) {
    fail(code, `bridge artifact path is unavailable: ${path || '<missing>'}`);
  }
  const file = realpathSync(candidate);
  if (!isProjectContainedPath(projectRoot, file) || lstatSync(file).size > MAX_ARTIFACT_BYTES) {
    fail(code, `bridge artifact path is unsafe: ${path}`);
  }
  return { file, path: relative(projectRoot, file).replaceAll('\\', '/') };
}

function readManifest(projectRoot, spawn) {
  const candidate = resolve(projectRoot, MANIFEST_PATH);
  const tracked = gitText(projectRoot, ['ls-files', '--error-unmatch', '--', MANIFEST_PATH], spawn);
  if (!tracked && !existsSync(candidate)) return null;
  if (!tracked || !existsSync(candidate)) {
    fail('BRIDGE_ARTIFACT_MANIFEST_UNTRACKED', 'bridge artifact manifest must exist and match the Git index');
  }
  const manifest = safeProjectFile(projectRoot, MANIFEST_PATH, 'BRIDGE_ARTIFACT_MANIFEST_INVALID');
  const gitBlob = trackedBlob(projectRoot, manifest.path, spawn);
  if (!gitBlob) fail('BRIDGE_ARTIFACT_MANIFEST_UNTRACKED', 'bridge artifact manifest must match the Git index');
  let parsed;
  try { parsed = JSON.parse(readFileSync(manifest.file, 'utf8')); }
  catch { fail('BRIDGE_ARTIFACT_MANIFEST_INVALID', 'bridge artifact manifest must be valid JSON'); }
  if (parsed?.schema_version !== 1 || !Array.isArray(parsed?.artifacts)) {
    fail('BRIDGE_ARTIFACT_MANIFEST_INVALID', 'bridge artifact manifest requires schema_version 1 and artifacts');
  }
  if (Object.keys(parsed).some((key) => !['schema_version', 'artifacts'].includes(key))) {
    fail('BRIDGE_ARTIFACT_MANIFEST_INVALID', 'bridge artifact manifest contains unsupported fields');
  }
  return { artifacts: parsed.artifacts, gitBlob, path: manifest.path };
}

export function collectBridgeArtifactEvidence({
  projectRoot, tasks = [], sensors = [], spawn = spawnSync,
} = {}) {
  const root = realpathSync(resolve(projectRoot));
  const manifest = readManifest(root, spawn);
  if (!manifest) return [];
  const taskById = new Map((tasks || []).map((task) => [String(task.id || ''), task]));
  const sensorById = new Map((sensors || []).map((sensor) => [String(sensor.id || ''), sensor]));
  const seen = new Set();
  return manifest.artifacts.map((entry) => {
    const externalId = String(entry?.external_id || '').trim();
    const kind = String(entry?.kind || '').trim();
    const sensorId = String(entry?.sensor_id || '').trim();
    const taskId = String(entry?.task_id || '').trim();
    if (Object.keys(entry || {}).some((key) => ![
      'source', 'external_id', 'kind', 'path', 'sensor_id', 'task_id',
    ].includes(key)) || entry?.source !== 'superpowers' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(externalId)
      || !['artifact', 'review', 'commit'].includes(kind) || !sensorId || !taskId || seen.has(externalId)) {
      fail('BRIDGE_ARTIFACT_MANIFEST_INVALID', `invalid or duplicate bridge artifact: ${externalId || '<missing>'}`);
    }
    seen.add(externalId);
    const task = taskById.get(taskId);
    const requiredSensors = Array.isArray(task?.sensors) && task.sensors.length ? task.sensors : [task?.sensor].filter(Boolean);
    if (!task || !requiredSensors.includes(sensorId)) {
      fail('BRIDGE_ARTIFACT_TASK_UNBOUND', `bridge artifact ${externalId} is not bound to task ${taskId} and sensor ${sensorId}`);
    }
    const artifact = safeProjectFile(root, entry.path, 'BRIDGE_ARTIFACT_FORGED');
    const gitBlob = trackedBlob(root, artifact.path, spawn);
    if (!gitBlob) fail('BRIDGE_ARTIFACT_FORGED', `bridge artifact ${externalId} must match the Git index`);
    const digest = createHash('sha256').update(readFileSync(artifact.file)).digest('hex');
    const sensor = sensorById.get(sensorId);
    const result = (sensor?.artifact_results || []).find((item) => (
      item?.schema_version === 1 && item.external_id === externalId && item.path === artifact.path
      && item.algorithm === 'sha256' && item.digest === digest
    ));
    if (sensor?.status === 'green' && sensor?.exit_code === 0 && !result) {
      fail('BRIDGE_ARTIFACT_RESULT_MISSING', `green sensor ${sensorId} did not produce the bound digest for ${externalId}`);
    }
    const verified = sensor?.status === 'green' && sensor?.exit_code === 0 && Boolean(result);
    return {
      schema_version: 1,
      source: 'superpowers', external_id: externalId, kind, path: artifact.path,
      sha256: digest, authority: verified ? 'verified' : 'reported', sensor_id: sensorId, task_id: taskId,
      git_blob: gitBlob, manifest_path: manifest.path, manifest_git_blob: manifest.gitBlob,
    };
  });
}
