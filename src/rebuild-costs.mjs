// Deterministic, causal reconstruction for historical session observability.
// Dry-run is a pure composition pass; apply delegates all note mutation to the CAS publisher.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readSessionRegistry } from '../hooks/obsidian-common.mjs';
import * as sessionObservability from '../hooks/session-observability.mjs';
import {
  mutateObservabilityStore,
  readObservabilityStore,
} from '../hooks/session-observability-store.mjs';
import { sanitizeObservabilityDiagnostics } from '../hooks/session-observability-state.mjs';
import { assertVaultPathSafe } from '../hooks/vault-path-safety.mjs';

function sortedEntries(registry, target) {
  return Object.entries(registry?.sessions || {})
    .map(([sessionId, value]) => ({ sessionId, ...value }))
    .filter((entry) => entry.session_file)
    .filter((entry) => !target || entry.sessionId === target || entry.session_file === target)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

function transcriptCandidates(entry) {
  const paths = new Set();
  if (entry.transcript_path) paths.add(entry.transcript_path);
  for (const path of entry.transcript_paths || []) if (path) paths.add(path);
  const activations = Array.isArray(entry.activations)
    ? entry.activations
    : Object.values(entry.activations || {});
  for (const activation of activations) {
    if (activation?.transcript_path) paths.add(activation.transcript_path);
    for (const path of activation?.transcript_paths || []) if (path) paths.add(path);
  }
  return [...paths];
}

function candidateContent(candidate, fallback) {
  return typeof candidate?.content === 'string' ? candidate.content : fallback;
}

function candidateHash(candidate, fallback) {
  return createHash('sha256').update(candidateContent(candidate, fallback)).digest('hex');
}

function safeDiagnostics(input, fallback = []) {
  try {
    return sanitizeObservabilityDiagnostics(input || fallback);
  } catch {
    return sanitizeObservabilityDiagnostics(fallback);
  }
}

export function semanticRebuildReport(report) {
  const {
    generatedAt: _generatedAt,
    changed = 0,
    unchanged = 0,
    sessions = [],
    ...semantic
  } = report || {};
  return {
    ...semantic,
    converged: Number(changed || 0) + Number(unchanged || 0),
    sessions: sessions.map((entry) => ({
      ...entry,
      status: entry.status === 'published' || entry.status === 'unchanged'
        ? 'converged'
        : entry.status,
    })),
  };
}

export function writeRebuildReportIfChanged(reportPath, report) {
  if (existsSync(reportPath)) {
    try {
      const previous = JSON.parse(readFileSync(reportPath, 'utf8'));
      if (JSON.stringify(semanticRebuildReport(previous))
        === JSON.stringify(semanticRebuildReport(report))) return false;
    } catch {
      // Invalid prior reports are replaced by the sanitized current schema.
    }
  }
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return true;
}

function markDirtyDefault(vaultBase, sessionId, diagnostics) {
  mutateObservabilityStore(vaultBase, sessionId, (state) => ({
    ...state,
    observability_dirty: true,
    diagnostics: safeDiagnostics(diagnostics, [{ code: 'STALE_FRONTIER', count: 1 }]),
  }));
}

export function rebuildSessionCosts(
  vaultBase,
  {
    apply = false,
    session = '',
    limit = 0,
    limits = {},
    overrides = {},
  } = {},
  effects = {},
) {
  const readRegistry = effects.readRegistry || readSessionRegistry;
  const compose = effects.compose || sessionObservability.composeSessionObservability;
  const publish = effects.publish || sessionObservability.publishSessionObservability;
  const readStore = effects.readStore || readObservabilityStore;
  const markDirty = effects.markDirty || markDirtyDefault;
  const writeReport = effects.writeReport || writeRebuildReportIfChanged;
  const now = effects.now || (() => new Date().toISOString());
  if (typeof compose !== 'function') throw new TypeError('composeSessionObservability indisponível');
  if (apply && typeof publish !== 'function') throw new TypeError('publishSessionObservability indisponível');

  const registry = readRegistry(vaultBase);
  const report = {
    version: 2,
    generatedAt: now(),
    mode: apply ? 'apply' : 'dry-run',
    targeted: Boolean(session),
    overrides: { ...overrides },
    scanned: 0,
    changed: 0,
    unchanged: 0,
    degraded: 0,
    stale: 0,
    missing: 0,
    errors: 0,
    ok: true,
    sessions: [],
  };

  for (const entry of sortedEntries(registry, session)) {
    if (limit && report.scanned >= limit) break;
    report.scanned += 1;
    let note;
    try {
      const checked = assertVaultPathSafe(vaultBase, join(vaultBase, entry.session_file), {
        expectedType: 'file', label: 'nota de sessão do rebuild de custos',
      });
      const hasTranscript = transcriptCandidates(entry).some((path) => existsSync(path));
      if (!checked.exists || !hasTranscript) {
        report.missing += 1;
        report.sessions.push({
          sessionId: entry.sessionId, status: 'missing', diagnostics: [],
        });
        continue;
      }
      note = checked.target;
      const before = readFileSync(note, 'utf8');
      const runtimeState = readStore(vaultBase, entry.sessionId);
      const candidate = compose({
        vaultBase,
        sessionContent: before,
        sessionEntry: entry,
        canonicalConversationId: entry.sessionId,
        caller: 'cost-rebuild',
        mode: 'offline',
        limits,
        runtimeState,
      });
      const diagnostics = safeDiagnostics(candidate?.diagnostics);
      const contentHash = candidateHash(candidate, before);
      if (candidate?.state === 'degraded') {
        report.degraded += 1;
        report.sessions.push({ sessionId: entry.sessionId, status: 'degraded', diagnostics });
        if (apply) markDirty(vaultBase, entry.sessionId, diagnostics);
        continue;
      }
      if (candidate?.state !== 'complete' && candidate?.state !== 'none') {
        report.degraded += 1;
        const invalidDiagnostics = [{ code: 'PARENT_META_INVALID', count: 1 }];
        report.sessions.push({
          sessionId: entry.sessionId, status: 'degraded', diagnostics: invalidDiagnostics,
        });
        if (apply) markDirty(vaultBase, entry.sessionId, invalidDiagnostics);
        continue;
      }

      if (!apply) {
        const changed = candidateContent(candidate, before) !== before;
        if (changed) report.changed += 1;
        else report.unchanged += 1;
        report.sessions.push({
          sessionId: entry.sessionId,
          status: changed ? 'would-change' : 'unchanged',
          candidateHash: contentHash,
          diagnostics,
        });
        continue;
      }

      const outcome = publish({
        vaultBase,
        sessionPath: note,
        canonicalConversationId: entry.sessionId,
        candidate,
        caller: 'cost-rebuild',
        mode: 'offline',
        allowSourceRefresh: true,
      }) || { status: 'degraded' };
      if (outcome.status === 'published') report.changed += 1;
      else if (outcome.status === 'unchanged') report.unchanged += 1;
      else if (outcome.status === 'stale' || outcome.status === 'conflict') {
        report.stale += 1;
        markDirty(vaultBase, entry.sessionId, [{ code: 'STALE_FRONTIER', count: 1 }]);
      } else {
        report.degraded += 1;
        markDirty(vaultBase, entry.sessionId, [{ code: 'PARENT_META_INVALID', count: 1 }]);
      }
      report.sessions.push({
        sessionId: entry.sessionId,
        status: outcome.status || 'degraded',
        candidateHash: contentHash,
        diagnostics: safeDiagnostics(outcome.diagnostics, diagnostics),
      });
    } catch {
      report.errors += 1;
      const diagnostics = [{ code: 'PARENT_META_INVALID', count: 1 }];
      report.sessions.push({ sessionId: entry.sessionId, status: 'degraded', diagnostics });
      if (apply) markDirty(vaultBase, entry.sessionId, diagnostics);
    }
  }

  report.ok = report.degraded === 0 && report.stale === 0
    && report.missing === 0 && report.errors === 0;
  if (apply) writeReport(join(vaultBase, '.brain', 'COST_REBUILD.json'), report);
  return report;
}
