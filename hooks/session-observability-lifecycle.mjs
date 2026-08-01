import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readCodexRolloutMeta } from './codex-rollout-meta.mjs';

const stableHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function addTranscriptPath(paths, value) {
  if (typeof value === 'string' && value.trim()) paths.add(value.trim());
}

function collectActivationPaths(paths, activations) {
  if (!activations || typeof activations !== 'object') return;
  const values = Array.isArray(activations) ? activations : Object.values(activations);
  for (const activation of values) {
    if (!activation || typeof activation !== 'object') continue;
    addTranscriptPath(paths, activation.transcript_path);
    for (const path of activation.transcript_paths || []) addTranscriptPath(paths, path);
  }
}

function isCodexDescendant(meta) {
  return Boolean(meta?.source && typeof meta.source === 'object' && meta.source.subagent);
}

// Resolve every transcript explicitly attached to the registry entry. Classification is
// authoritative only when the rollout's first session_meta line can be read: filename and
// directory layout are deliberately not used as subagent heuristics.
export function resolveObservabilityRoots(entry, { readMeta = readCodexRolloutMeta } = {}) {
  if (!entry || typeof entry !== 'object') {
    return {
      state: 'degraded',
      rootPaths: [],
      descendantPaths: [],
      diagnostics: [{ code: 'MAIN_TRANSCRIPT_UNRESOLVED', count: 1 }],
    };
  }

  const candidates = new Set();
  addTranscriptPath(candidates, entry.transcript_path);
  for (const path of entry.transcript_paths || []) addTranscriptPath(candidates, path);
  collectActivationPaths(candidates, entry.activations);

  const rootPaths = [];
  const descendantPaths = [];
  let unreadable = 0;
  for (const path of [...candidates].sort((a, b) => a.localeCompare(b))) {
    const result = readMeta(path);
    if (!result?.ok) {
      unreadable += 1;
      continue;
    }
    if (isCodexDescendant(result.meta)) descendantPaths.push(path);
    else rootPaths.push(path);
  }

  if (unreadable > 0) {
    return {
      state: 'degraded',
      rootPaths,
      descendantPaths,
      diagnostics: [{ code: 'MAIN_TRANSCRIPT_UNRESOLVED', count: unreadable }],
    };
  }

  return { state: 'complete', rootPaths, descendantPaths, diagnostics: [] };
}

function sameFrontier(left, right) {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}

export function assessObservabilityFreshness({
  checkpoint,
  runtimeState,
  statSource = statSync,
} = {}) {
  if (!checkpoint) return { fresh: false, status: 'legacy', diagnostics: [] };
  if (checkpoint.state === 'degraded') {
    return {
      fresh: false,
      status: 'degraded',
      diagnostics: checkpoint.diagnostics || [],
    };
  }
  const manifest = runtimeState?.source_manifest;
  if (!Array.isArray(manifest) || manifest.length === 0) {
    return { fresh: false, status: 'manifest-unproven', diagnostics: [] };
  }

  const hashInput = [];
  for (const source of manifest) {
    if (!source || typeof source.path !== 'string' || typeof source.rolloutId !== 'string') {
      return { fresh: false, status: 'manifest-unproven', diagnostics: [] };
    }
    let stat;
    try { stat = statSource(source.path); } catch {
      return {
        fresh: false,
        status: 'stale',
        diagnostics: [{ code: 'STALE_FRONTIER', count: 1 }],
      };
    }
    if (!stat.isFile() || stat.size !== Number(source.size)
      || stat.mtimeMs !== Number(source.mtimeMs)) {
      return {
        fresh: false,
        status: 'stale',
        diagnostics: [{ code: 'STALE_FRONTIER', count: 1 }],
      };
    }
    hashInput.push({ rolloutId: source.rolloutId, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  hashInput.sort((left, right) =>
    `${left.rolloutId}\u0000${left.size}\u0000${left.mtimeMs}`.localeCompare(
      `${right.rolloutId}\u0000${right.size}\u0000${right.mtimeMs}`,
    ));
  const stale = stableHash(hashInput) !== checkpoint.frontier.source_manifest_hash
    || !sameFrontier(runtimeState?.checkpoint_frontier, checkpoint.frontier)
    || runtimeState?.observability_dirty !== false
    || runtimeState?.observability_checkpoint_sequence !== runtimeState?.observability_signal_sequence
    || runtimeState?.observability_checkpoint_sequence !== checkpoint.frontier.signal_sequence;
  return stale
    ? {
      fresh: false,
      status: 'stale',
      diagnostics: [{ code: 'STALE_FRONTIER', count: 1 }],
    }
    : { fresh: true, status: 'fresh', diagnostics: [] };
}
