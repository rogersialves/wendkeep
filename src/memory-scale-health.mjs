import {
  readMemoryLedgerGeneration,
  readMemoryProjectionSnapshot,
  readMemoryRotationJournal,
  readMemoryRotationReceipts,
  readMemorySegmentManifest,
} from '../hooks/memory-store.mjs';
import {
  quoteCommandArgument,
  WENDKEEP_COMMAND,
} from '../hooks/obsidian-common.mjs';

export const MEMORY_SCALE_HEALTH_SCHEMA_VERSION = 1;

function safeReason(value, fallback = '') {
  const text = String(value || fallback).trim();
  return text
    ? text.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120)
    : null;
}

function numberMetric(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function emptyMemoryScaleMetrics() {
  return {
    scaleSchemaVersion: MEMORY_SCALE_HEALTH_SCHEMA_VERSION,
    scaleStatus: 'unknown',
    scaleErrorCode: null,
    snapshotStatus: 'unknown',
    snapshotReason: null,
    snapshotEvents: 0,
    snapshotLedgerBytes: 0,
    snapshotTailEvents: 0,
    snapshotTailBytes: 0,
    segmentStatus: 'unknown',
    segmentCount: 0,
    segmentCoveredEvents: 0,
    segmentCoveredBytes: 0,
    segmentPendingEvents: 0,
    generationStatus: 'unknown',
    generation: 0,
    generationSourceEvents: 0,
    generationActiveTailEvents: 0,
    generationRotatedAt: null,
    rotationJournal: 'unknown',
    rotationRecoveryRequired: false,
    rotationReceiptsStatus: 'unknown',
    rotationReceipts: 0,
    rotationReceiptCheckpoint: 'unknown',
  };
}

function inspectSnapshot(vaultBase, metrics) {
  try {
    const snapshot = readMemoryProjectionSnapshot(vaultBase);
    const tailStatus = snapshot.status === 'ok' ? snapshot.tail?.status : null;
    metrics.snapshotStatus = snapshot.status === 'ok' && tailStatus !== 'ok'
      ? 'invalid'
      : snapshot.status;
    metrics.snapshotReason = safeReason(
      snapshot.reason || snapshot.tail?.reason,
      metrics.snapshotStatus === 'invalid' ? 'snapshot-tail-unavailable' : '',
    );
    if (snapshot.status === 'ok') {
      metrics.snapshotEvents = numberMetric(snapshot.snapshot?.event_count);
      metrics.snapshotLedgerBytes = numberMetric(snapshot.snapshot?.ledger_bytes);
      metrics.snapshotTailEvents = Array.isArray(snapshot.tail?.events)
        ? snapshot.tail.events.length
        : 0;
      metrics.snapshotTailBytes = numberMetric(snapshot.tail?.bytes);
    }
  } catch (error) {
    if (error?.code === 'VAULT_PATH_UNSAFE') throw error;
    metrics.snapshotStatus = 'invalid';
    metrics.snapshotReason = safeReason(error?.code, 'snapshot-read-failed');
  }
}

function inspectSegments(vaultBase, ledgerEvents, metrics) {
  try {
    const manifest = readMemorySegmentManifest(vaultBase);
    metrics.segmentStatus = manifest.status;
    if (manifest.status === 'ok') {
      metrics.segmentCount = numberMetric(manifest.manifest?.segment_count);
      metrics.segmentCoveredEvents = numberMetric(manifest.manifest?.covered_event_count);
      metrics.segmentCoveredBytes = numberMetric(manifest.manifest?.covered_bytes);
    }
    metrics.segmentPendingEvents = Math.max(
      0,
      numberMetric(ledgerEvents) - metrics.segmentCoveredEvents,
    );
  } catch (error) {
    if (error?.code === 'VAULT_PATH_UNSAFE') throw error;
    metrics.segmentStatus = 'invalid';
    metrics.scaleErrorCode ||= safeReason(error?.code, 'segment-manifest-read-failed');
  }
}

function inspectRotation(vaultBase, ledgerEvents, metrics) {
  try {
    const generation = readMemoryLedgerGeneration(vaultBase);
    metrics.generationStatus = generation.status;
    if (generation.status === 'ok') {
      metrics.generation = numberMetric(generation.state?.generation);
      metrics.generationSourceEvents = numberMetric(generation.state?.source_event_count);
      metrics.generationActiveTailEvents = Math.max(
        0,
        numberMetric(ledgerEvents) - metrics.generationSourceEvents,
      );
      metrics.generationRotatedAt = String(generation.state?.rotated_at || '') || null;
    }
  } catch (error) {
    if (error?.code === 'VAULT_PATH_UNSAFE') throw error;
    metrics.generationStatus = 'invalid';
    metrics.scaleErrorCode ||= safeReason(error?.code, 'generation-read-failed');
  }

  try {
    const journal = readMemoryRotationJournal(vaultBase);
    metrics.rotationJournal = journal.status === 'ok'
      ? String(journal.journal?.stage || 'invalid')
      : journal.status;
    metrics.rotationRecoveryRequired = journal.status !== 'missing';
  } catch (error) {
    if (error?.code === 'VAULT_PATH_UNSAFE') throw error;
    metrics.rotationJournal = 'invalid';
    metrics.rotationRecoveryRequired = true;
    metrics.scaleErrorCode ||= safeReason(error?.code, 'rotation-journal-read-failed');
  }

  try {
    const receipts = readMemoryRotationReceipts(vaultBase);
    metrics.rotationReceiptsStatus = receipts.status;
    metrics.rotationReceipts = Array.isArray(receipts.receipts)
      ? receipts.receipts.length
      : 0;
    metrics.rotationReceiptCheckpoint = String(receipts.checkpointStatus || 'unknown');
  } catch (error) {
    if (error?.code === 'VAULT_PATH_UNSAFE') throw error;
    metrics.rotationReceiptsStatus = 'invalid';
    metrics.rotationReceiptCheckpoint = 'invalid';
    metrics.scaleErrorCode ||= safeReason(error?.code, 'rotation-receipts-read-failed');
  }
}

function deriveScaleStatus(metrics) {
  const invalid = [
    metrics.snapshotStatus,
    metrics.segmentStatus,
    metrics.generationStatus,
    metrics.rotationJournal,
    metrics.rotationReceiptsStatus,
    metrics.rotationReceiptCheckpoint,
  ].some((status) => ['invalid', 'corrupt', 'blocked'].includes(status));
  if (invalid || metrics.scaleErrorCode) return 'degraded';
  if (metrics.rotationRecoveryRequired) return 'warning';
  return 'healthy';
}

export function inspectMemoryScaleHealth(vaultBase, { ledgerEvents = 0 } = {}) {
  const metrics = emptyMemoryScaleMetrics();
  inspectSnapshot(vaultBase, metrics);
  inspectSegments(vaultBase, ledgerEvents, metrics);
  inspectRotation(vaultBase, ledgerEvents, metrics);
  metrics.scaleStatus = deriveScaleStatus(metrics);
  return metrics;
}

function statusCommand(vaultBase) {
  return `${WENDKEEP_COMMAND} memory status --gate --vault ${quoteCommandArgument(vaultBase)}`;
}

export function augmentVaultHealthWithMemoryScale(result, vaultBase) {
  const memory = result?.metrics?.memory;
  if (!memory || ['legacy', 'blocked'].includes(result.memoryStatus)) return result;

  try {
    const scale = inspectMemoryScaleHealth(vaultBase, {
      ledgerEvents: memory.ledgerEvents,
    });
    return {
      ...result,
      metrics: {
        ...result.metrics,
        memory: { ...memory, ...scale },
      },
    };
  } catch (error) {
    const code = safeReason(error?.code, 'memory-scale-boundary-unsafe');
    const failure = `Memória: Artefatos de escala da memória estão inseguros ou ilegíveis (${code}). Inspecione com: ${statusCommand(vaultBase)}.`;
    return {
      ...result,
      ok: false,
      memoryStatus: 'blocked',
      failures: [...(result.failures || []), failure],
      metrics: {
        ...result.metrics,
        memory: {
          ...memory,
          ...emptyMemoryScaleMetrics(),
          scaleStatus: 'blocked',
          scaleErrorCode: code,
        },
      },
    };
  }
}
