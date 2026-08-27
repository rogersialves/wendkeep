import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { allChangesState } from '../hooks/change-core.mjs';
import { readControl, readSessionRegistry } from '../hooks/obsidian-common.mjs';
import { runVaultHealth } from '../hooks/vault-health.mjs';
import { readProjectForValidation } from '../packages/vault/src/validate-memory.mjs';
import { inspectEvidenceSearchHealth } from './evidence-search-health.mjs';
import { inspectSyncOutbox, readLocalSyncState } from './sync-outbox.mjs';

export const OBSERVER_SCHEMA_VERSION = 1;
export const MAX_SNAPSHOT_BYTES = 32 * 1024;
const MAX_TEXT = 160;

function fail(message, code = 'WENDKEEP_OBSERVER_SNAPSHOT_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeText(value, max = MAX_TEXT) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, '[REDACTED_PATH]')
    .replace(/\\\\[^\s"']+/g, '[REDACTED_PATH]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeCount(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function isoNow(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw fail('captured_at inválido.');
  return date.toISOString();
}

function packageVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function activeSessionSummary(vaultBase, control, registry) {
  const entries = Object.entries(registry?.sessions || {})
    .map(([sessionId, entry]) => ({ sessionId, entry }))
    .sort((a, b) => String(b.entry?.last_seen || b.entry?.updated_at || '').localeCompare(String(a.entry?.last_seen || a.entry?.updated_at || '')));
  const selected = entries.find(({ sessionId }) => sessionId === control?.session_id) || entries[0];
  const entry = selected?.entry || {};
  const coverage = entry.host_coverage;
  return {
    status: safeText(control?.status || entry.status || 'inactive', 32),
    session_id: safeText(control?.session_id || selected?.sessionId || '', 100),
    provider: safeText(entry.provider || '', 32),
    change_slug: safeText(entry.change_slug || '', 100),
    last_seen: safeText(entry.last_seen || entry.updated_at || '', 40),
    ...(coverage ? {
      coverage: {
        host_id: safeText(coverage.host_id || 'unknown', 32),
        degraded: coverage.degraded === true,
        unavailable: (coverage.capabilities || []).filter((item) => item?.state === 'unavailable').length,
        manual: (coverage.capabilities || []).filter((item) => item?.state === 'manual').length,
      },
    } : {}),
  };
}

function recallSearchSummary(metrics) {
  return {
    schema_version: 1,
    status: safeText(metrics?.status || 'unknown', 32),
    ...(metrics?.errorCode ? { error_code: safeText(metrics.errorCode, 120) } : {}),
    authority: {
      status: safeText(metrics?.authorityStatus || 'unknown', 32),
      bytes: safeCount(metrics?.authorityBytes),
    },
    incremental: {
      status: safeText(metrics?.incrementalStateStatus || 'unknown', 32),
      bytes: safeCount(metrics?.incrementalStateBytes),
      documents: safeCount(metrics?.documentCount),
    },
    search: {
      status: safeText(metrics?.searchStateStatus || 'unknown', 32),
      bytes: safeCount(metrics?.searchStateBytes),
      chunks: safeCount(metrics?.rowCount),
      source_index_current: metrics?.sourceIndexCurrent === true,
      source_state_current: metrics?.sourceStateCurrent === true,
    },
    lexical: {
      status: safeText(metrics?.lexicalStatus || 'unknown', 32),
      bytes: safeCount(metrics?.lexicalBytes),
    },
    sqlite: {
      status: safeText(metrics?.sqliteStatus || 'unknown', 32),
      bytes: safeCount(metrics?.sqliteBytes),
      capability: metrics?.sqliteCapability === true,
    },
    backend: safeText(metrics?.backend || 'unavailable', 40),
  };
}

function healthSummary(vaultBase) {
  try {
    const health = runVaultHealth({ vaultBase });
    const recall = recallSearchSummary(inspectEvidenceSearchHealth(vaultBase));
    return {
      ok: health.ok === true,
      status: safeText(health.memoryStatus || (health.ok ? 'healthy' : 'degraded'), 40),
      failure_count: Array.isArray(health.failures) ? health.failures.length : 0,
      warning_count: Array.isArray(health.warnings) ? health.warnings.length : 0,
      registry_sessions: Number(health.metrics?.registrySessions || 0),
      derived_notes: Number(health.metrics?.derivedNotes || 0),
      recall_search: recall,
    };
  } catch {
    return {
      ok: false,
      status: 'unavailable',
      failure_count: 1,
      warning_count: 0,
      registry_sessions: 0,
      derived_notes: 0,
    };
  }
}

function hashEvent(snapshot) {
  const canonical = JSON.stringify({ ...snapshot, event_id: undefined });
  return `obs-${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

function syncSummary(vaultBase, projectId) {
  const outbox = inspectSyncOutbox(vaultBase);
  let openConflicts = 0;
  if (!['disabled', 'corrupt'].includes(outbox.status)) {
    try {
      const state = readLocalSyncState(vaultBase, projectId);
      openConflicts = Object.values(state.conflicts || {}).filter((item) => item?.status === 'open').length;
    } catch {
      return { status: 'corrupt', pending: outbox.pending, open_conflicts: 0 };
    }
  }
  return { status: outbox.status, pending: outbox.pending, open_conflicts: openConflicts };
}

function hasForbiddenKey(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:core|shared|digest|transcript|secret|token|prompt|raw|path|vault)/i.test(key)) return true;
    if (hasForbiddenKey(child)) return true;
  }
  return false;
}

function hasAbsolutePath(value) {
  if (typeof value === 'string') {
    return /[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/]|(?:^|\s)\/(?:Users|home|mnt|var|tmp)\//.test(value);
  }
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(hasAbsolutePath);
}

export function validateObserverSnapshot(snapshot, { projectId = '' } = {}) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { ok: false, errors: ['snapshot deve ser um objeto JSON.'] };
  }
  if (snapshot.schema_version !== OBSERVER_SCHEMA_VERSION) errors.push('schema_version incompatível.');
  for (const key of ['event_id', 'project_id', 'project_name', 'wendkeep_version', 'captured_at']) {
    if (typeof snapshot[key] !== 'string' || !snapshot[key].trim()) errors.push(`${key} ausente ou inválido.`);
  }
  if (projectId && snapshot.project_id !== projectId) errors.push('project_id não corresponde ao projeto registrado.');
  if (!Array.isArray(snapshot.changes)) errors.push('changes deve ser uma lista.');
  if (!snapshot.session || typeof snapshot.session !== 'object') errors.push('session ausente.');
  if (!snapshot.health || typeof snapshot.health !== 'object') errors.push('health ausente.');
  if (hasForbiddenKey(snapshot)) errors.push('snapshot contém campo não permitido.');
  if (hasAbsolutePath(snapshot)) errors.push('snapshot contém caminho absoluto.');
  const size = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  if (size > MAX_SNAPSHOT_BYTES) errors.push(`snapshot excede ${MAX_SNAPSHOT_BYTES} bytes.`);
  return { ok: errors.length === 0, errors, size };
}

export function buildProjectSnapshot({ vaultBase, projectRoot = process.cwd(), now = new Date() } = {}) {
  if (!vaultBase) throw fail('vaultBase é obrigatório.');
  const project = readProjectForValidation(vaultBase);
  if (!project.ok || !project.projectId) throw fail(project.errors?.join(' ') || 'PROJECT.json inválido.');
  const control = readControl(vaultBase);
  const registry = readSessionRegistry(vaultBase);
  const changes = allChangesState(vaultBase).changes.map((change) => ({
    slug: safeText(change.slug, 100),
    current: change.current === true,
    openTasks: Number(change.openCount || 0),
    doneTasks: Number(change.doneCount || 0),
    warning: safeText(change.warning || '', 120),
  }));
  const markerName = project.marker?.projectName || basename(projectRoot);
  const snapshot = {
    schema_version: OBSERVER_SCHEMA_VERSION,
    event_id: '',
    project_id: project.projectId,
    projectId: project.projectId,
    project_name: safeText(markerName || project.projectId, 100),
    wendkeep_version: packageVersion(),
    captured_at: isoNow(now),
    session: activeSessionSummary(vaultBase, control, registry),
    changes,
    health: healthSummary(vaultBase),
    sync: syncSummary(vaultBase, project.projectId),
  };
  snapshot.event_id = hashEvent(snapshot);
  const validation = validateObserverSnapshot(snapshot, { projectId: project.projectId });
  if (!validation.ok) throw fail(validation.errors.join(' '));
  return snapshot;
}
