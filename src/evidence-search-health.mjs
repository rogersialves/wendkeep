import { statSync } from 'node:fs';
import { join } from 'node:path';

import {
  EVIDENCE_INDEX_FILE,
} from '../packages/vault/src/evidence-recall.mjs';
import {
  EVIDENCE_INDEX_STATE_FILE,
  loadEvidenceIndexState,
} from '../packages/vault/src/evidence-index-store.mjs';
import {
  EVIDENCE_SEARCH_STATE_FILE,
  evidenceSearchSqliteAvailable,
  loadEvidenceSearchState,
} from '../packages/vault/src/evidence-search-index.mjs';
import { assertVaultPathSafe } from '../packages/vault/src/vault-path-safety.mjs';

export const EVIDENCE_SEARCH_HEALTH_SCHEMA_VERSION = 1;

function brainDir(vaultBase) {
  return join(vaultBase, '.brain');
}

function nsText(value, fallbackMs = 0) {
  if (typeof value === 'bigint') return value.toString();
  return BigInt(Math.max(0, Math.trunc(Number(fallbackMs || 0) * 1_000_000))).toString();
}

function fileInfo(vaultBase, path, label) {
  let checked = assertVaultPathSafe(vaultBase, path, {
    expectedType: 'file',
    label,
  });
  if (!checked.exists) return { exists: false, bytes: 0, fingerprint: null };
  checked = assertVaultPathSafe(vaultBase, checked.target, {
    allowMissing: false,
    expectedType: 'file',
    label,
  });
  const stat = statSync(checked.target, { bigint: true });
  return {
    exists: true,
    bytes: Number(stat.size),
    fingerprint: {
      size: stat.size.toString(),
      mtime_ns: nsText(stat.mtimeNs, stat.mtimeMs),
      ctime_ns: nsText(stat.ctimeNs, stat.ctimeMs),
    },
  };
}

function sameFingerprint(left, right) {
  if (left === null || right === null) return left === right;
  return Boolean(left && right)
    && String(left.size) === String(right.size)
    && String(left.mtime_ns) === String(right.mtime_ns)
    && String(left.ctime_ns) === String(right.ctime_ns);
}

function safeCode(value, fallback = '') {
  const text = String(value || fallback).trim();
  return text
    ? text.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120)
    : null;
}

function artifactInfo(vaultBase, artifact, kind) {
  if (!artifact) {
    return { status: 'not-built', bytes: 0, current: false };
  }
  const path = join(brainDir(vaultBase), ...String(artifact.path || '').split('/'));
  const file = fileInfo(vaultBase, path, `artefato ${kind} da busca de evidências`);
  if (!file.exists) return { status: 'missing', bytes: 0, current: false };
  const current = sameFingerprint(artifact.fingerprint, file.fingerprint);
  return {
    status: current ? 'current' : 'stale',
    bytes: file.bytes,
    current,
  };
}

export function emptyEvidenceSearchHealth() {
  return {
    schemaVersion: EVIDENCE_SEARCH_HEALTH_SCHEMA_VERSION,
    status: 'unknown',
    errorCode: null,
    authorityStatus: 'unknown',
    authorityBytes: 0,
    incrementalStateStatus: 'unknown',
    incrementalStateBytes: 0,
    documentCount: 0,
    searchStateStatus: 'unknown',
    searchStateBytes: 0,
    rowCount: 0,
    sourceIndexCurrent: false,
    sourceStateCurrent: false,
    lexicalStatus: 'unknown',
    lexicalBytes: 0,
    sqliteStatus: 'unknown',
    sqliteBytes: 0,
    sqliteCapability: false,
    backend: 'unavailable',
  };
}

function deriveStatus(metrics) {
  if (metrics.authorityStatus === 'missing') return 'missing';
  if (metrics.incrementalStateStatus === 'invalid'
      || metrics.searchStateStatus === 'invalid') return 'degraded';
  if (metrics.searchStateStatus !== 'current') return 'warning';
  if (metrics.lexicalStatus !== 'current') return 'degraded';
  return 'healthy';
}

export function inspectEvidenceSearchHealth(vaultBase) {
  const metrics = emptyEvidenceSearchHealth();
  try {
    const brain = brainDir(vaultBase);
    const authority = fileInfo(
      vaultBase,
      join(brain, EVIDENCE_INDEX_FILE),
      'autoridade EVIDENCE_INDEX.jsonl',
    );
    const incrementalFile = fileInfo(
      vaultBase,
      join(brain, EVIDENCE_INDEX_STATE_FILE),
      'estado incremental EVIDENCE_INDEX_STATE.json',
    );
    const searchFile = fileInfo(
      vaultBase,
      join(brain, EVIDENCE_SEARCH_STATE_FILE),
      'estado derivado EVIDENCE_SEARCH_STATE.json',
    );

    metrics.authorityStatus = authority.exists ? 'present' : 'missing';
    metrics.authorityBytes = authority.bytes;
    metrics.incrementalStateBytes = incrementalFile.bytes;
    metrics.searchStateBytes = searchFile.bytes;
    metrics.sqliteCapability = evidenceSearchSqliteAvailable();

    const incremental = incrementalFile.exists ? loadEvidenceIndexState(vaultBase) : null;
    metrics.incrementalStateStatus = incrementalFile.exists
      ? (incremental ? 'ok' : 'invalid')
      : 'missing';
    metrics.documentCount = incremental
      ? Object.keys(incremental.documents || {}).length
      : 0;

    const state = searchFile.exists ? loadEvidenceSearchState(vaultBase) : null;
    if (!searchFile.exists) {
      metrics.searchStateStatus = 'missing';
      metrics.lexicalStatus = 'not-built';
      metrics.sqliteStatus = 'not-built';
      metrics.backend = authority.exists ? 'lexical-ephemeral' : 'unavailable';
      metrics.status = deriveStatus(metrics);
      return metrics;
    }
    if (!state) {
      metrics.searchStateStatus = 'invalid';
      metrics.lexicalStatus = 'unknown';
      metrics.sqliteStatus = 'unknown';
      metrics.backend = authority.exists ? 'lexical-ephemeral' : 'unavailable';
      metrics.status = deriveStatus(metrics);
      return metrics;
    }

    metrics.rowCount = Number(state.row_count || 0);
    metrics.sourceIndexCurrent = sameFingerprint(state.source?.index, authority.fingerprint);
    metrics.sourceStateCurrent = sameFingerprint(
      state.source?.state ?? null,
      incrementalFile.fingerprint,
    );
    const lexical = artifactInfo(vaultBase, state.lexical, 'lexical');
    const sqlite = artifactInfo(vaultBase, state.sqlite, 'SQLite FTS');
    metrics.lexicalStatus = lexical.status;
    metrics.lexicalBytes = lexical.bytes;
    metrics.sqliteStatus = sqlite.status;
    metrics.sqliteBytes = sqlite.bytes;

    const sourceCurrent = metrics.sourceIndexCurrent && metrics.sourceStateCurrent;
    const artifactsCurrent = lexical.current && (!state.sqlite || sqlite.current);
    metrics.searchStateStatus = sourceCurrent && artifactsCurrent ? 'current' : 'stale';
    metrics.backend = metrics.searchStateStatus === 'current'
      && sqlite.current
      && metrics.sqliteCapability
      ? 'sqlite-fts5'
      : metrics.searchStateStatus === 'current' && lexical.current
        ? 'lexical-sidecar'
        : authority.exists
          ? 'lexical-ephemeral'
          : 'unavailable';
    metrics.status = deriveStatus(metrics);
    return metrics;
  } catch (error) {
    return {
      ...metrics,
      status: 'blocked',
      errorCode: safeCode(error?.code, 'EVIDENCE_SEARCH_HEALTH_UNSAFE'),
    };
  }
}

const statusLabel = (status) => ({
  healthy: 'saudável', warning: 'atenção', degraded: 'degradado', blocked: 'bloqueado',
  missing: 'ausente', current: 'atual', stale: 'stale', present: 'presente', ok: 'saudável',
  invalid: 'inválido', 'not-built': 'não construído', unknown: 'desconhecido',
}[status] || status || 'desconhecido');

export function renderEvidenceSearchHealthLines(metrics) {
  const lines = [
    `[recall] ${statusLabel(metrics.status)} — backend: ${metrics.backend} · SQLite/FTS5: ${metrics.sqliteCapability ? 'disponível' : 'indisponível'}`,
    `  autoridade: ${statusLabel(metrics.authorityStatus)} · ${metrics.authorityBytes} bytes · documentos: ${metrics.documentCount} · chunks: ${metrics.rowCount}`,
    `  incremental: ${statusLabel(metrics.incrementalStateStatus)} · ${metrics.incrementalStateBytes} bytes · busca: ${statusLabel(metrics.searchStateStatus)} · ${metrics.searchStateBytes} bytes`,
    `  lexical: ${statusLabel(metrics.lexicalStatus)} · ${metrics.lexicalBytes} bytes · SQLite: ${statusLabel(metrics.sqliteStatus)} · ${metrics.sqliteBytes} bytes`,
  ];
  if (metrics.searchStateStatus === 'stale' || metrics.searchStateStatus === 'missing') {
    lines.push('  ! o próximo recall pode reconstruir o índice derivado a partir da autoridade JSONL');
  }
  if (metrics.errorCode) lines.push(`  ✗ ${metrics.errorCode}`);
  return lines;
}
