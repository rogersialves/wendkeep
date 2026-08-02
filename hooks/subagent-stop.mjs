#!/usr/bin/env node
// SubagentStop hook: refresh this session's subagent/workflow telemetry the MOMENT a subagent
// finishes — not only at the main Stop. It recomposes the complete main + subagent snapshot
// through the same atomic writer used by Stop/import/rebuild. Fail-open.
//
// Model choice for subagents stays the harness's job (agent frontmatter `model:` / the Task/
// workflow `model` param). wendkeep OBSERVES (this telemetry) rather than dictating a routing rule.
import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import {
  getVaultBase,
  mutateSessionRegistry,
  providerMeta,
  readHookInput,
  writeHookOutput,
} from './obsidian-common.mjs';
import { materializeSessionObservability } from './session-observability.mjs';
import { resolveSessionEntry } from './session-identity.mjs';
import { readCodexRolloutMeta } from './codex-rollout-meta.mjs';
import { resolveObservabilityRoots } from './session-observability-lifecycle.mjs';
import {
  readObservabilityStore,
  markObservabilityCheckpoint,
  recordObservabilitySignal,
  releaseObservabilityLease,
  tryAcquireObservabilityLease,
} from './session-observability-store.mjs';

const SUBAGENT_COALESCE_MS = 250;
const SUBAGENT_DEADLINE_MS = 15_000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function causalSnapshot(entry) {
  const activationId = String(entry?.active_activation_id || '');
  const activation = entry?.activations?.[activationId] || {};
  return {
    activationId,
    activationEpoch: Number(activation.epoch || entry?.activation_epoch || 0),
    turnSequence: Number(entry?.last_turn_sequence || activation.last_turn_sequence || 0),
  };
}

function sameCausalSnapshot(left, right) {
  return left.activationId === right.activationId
    && left.activationEpoch === right.activationEpoch
    && left.turnSequence === right.turnSequence;
}

function defaultMaterialize(request) {
  return materializeSessionObservability({
    vaultBase: request.vaultBase,
    sessionPath: request.sessionPath,
    transcriptPath: request.transcriptPath,
    entry: request.entry,
    canonicalConversationId: request.canonicalConversationId,
    frontier: request.frontier,
    signals: request.signals,
    cache: request.cache,
    mode: 'live',
    deadlineAt: request.deadlineAt,
    now: request.now,
    allowNone: request.allowNone,
    readRuntimeFrontier: request.readRuntimeFrontier,
    withPublicationGuard: request.withPublicationGuard,
    writeRegistryCheckpoint: request.writeRegistryCheckpoint,
  });
}

function claudeRoots(entry) {
  const paths = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) paths.add(value.trim());
  };
  add(entry?.transcript_path);
  for (const path of entry?.transcript_paths || []) add(path);
  for (const activation of Object.values(entry?.activations || {})) {
    add(activation?.transcript_path);
    for (const path of activation?.transcript_paths || []) add(path);
  }
  return { state: 'complete', rootPaths: [...paths], descendantPaths: [], diagnostics: [] };
}

export function subagentIdentityInput(input = {}) {
  const agentTranscriptPath = input.agent_transcript_path || input.agentTranscriptPath || '';
  if (!agentTranscriptPath) return input;
  return {
    ...input,
    transcript_path: agentTranscriptPath,
    transcriptPath: agentTranscriptPath,
  };
}

function validatedCodexRootIds(entry, canonicalConversationId, { resolveRoots, readMeta }) {
  const roots = resolveRoots(entry, { readMeta });
  if (roots?.state !== 'complete' || !roots.rootPaths?.length) return null;

  const ids = new Set();
  for (const rootPath of roots.rootPaths) {
    const result = readMeta(rootPath);
    const meta = result?.meta;
    const rootId = String(meta?.id || '');
    if (!result?.ok || !rootId || meta?.source?.subagent) return null;
    if (meta.session_id && meta.session_id !== canonicalConversationId) return null;
    ids.add(rootId);
  }
  return ids;
}

export async function refreshSubagents(vaultBase, input, {
  now = Date.now,
  hookStartedAt = now(),
  sleep = wait,
  coalesceMs = SUBAGENT_COALESCE_MS,
  deadlineMs = SUBAGENT_DEADLINE_MS,
  resolveEntry = resolveSessionEntry,
  readMeta = readCodexRolloutMeta,
  mutateRegistry = mutateSessionRegistry,
  recordSignal = recordObservabilitySignal,
  readStore = readObservabilityStore,
  acquireLease = tryAcquireObservabilityLease,
  releaseLease = releaseObservabilityLease,
  resolveRoots = resolveObservabilityRoots,
  materialize = defaultMaterialize,
} = {}) {
  const deadlineAt = hookStartedAt + deadlineMs;
  const provider = providerMeta(input.provider).id;
  const identityInput = subagentIdentityInput(input);
  const { identity, entry } = resolveEntry(vaultBase, identityInput, provider);
  if (identity.state !== 'resolved') return false;
  const childTranscriptPath = identity.transcriptPath;
  const sessionRel = entry?.session_file || '';
  if (!sessionRel) return false;

  let childParentThreadId = '';
  if (identity.provider === 'codex') {
    const childMeta = readMeta(childTranscriptPath);
    if (!childMeta?.ok || !childMeta.meta?.source?.subagent) return false;
    if (!childMeta.meta.id || childMeta.meta.id !== identity.transcriptId) return false;
    if (childMeta.meta.session_id
      && childMeta.meta.session_id !== identity.canonicalConversationId) return false;
    childParentThreadId = String(
      childMeta.meta.parent_thread_id
      || childMeta.meta.source?.subagent?.thread_spawn?.parent_thread_id
      || '',
    );
    const rootIds = validatedCodexRootIds(entry, identity.canonicalConversationId, {
      resolveRoots,
      readMeta,
    });
    if (!childParentThreadId || !rootIds?.has(childParentThreadId)) return false;
  }

  const observed = causalSnapshot(entry);
  const signal = mutateRegistry(vaultBase, (registry) => {
    const current = registry.sessions?.[identity.canonicalConversationId];
    if (!current || current.session_file !== sessionRel
      || !sameCausalSnapshot(observed, causalSnapshot(current))) return null;
    const recorded = recordSignal(vaultBase, identity.canonicalConversationId, {
      rollout_id: identity.transcriptId,
      transcript_path: childTranscriptPath,
      parent_thread_id: childParentThreadId,
      kind: 'started',
      activation_id: observed.activationId,
      activation_epoch: observed.activationEpoch,
      turn_sequence: observed.turnSequence,
    });
    if (!recorded?.state) return recorded;
    registry.sessions[identity.canonicalConversationId] = {
      ...current,
      observability_signal_sequence: recorded.sequence,
      observability_checkpoint_sequence: Number(
        recorded.state.observability_checkpoint_sequence
        ?? current.observability_checkpoint_sequence
        ?? 0,
      ),
      observability_dirty: Boolean(recorded.state.observability_dirty),
    };
    return recorded;
  });
  if (!signal?.state) return false;
  if (!signal.state.observability_dirty) return true;

  await sleep(coalesceMs);
  if (now() >= deadlineAt) return true;

  const latest = readStore(vaultBase, identity.canonicalConversationId);
  if (!latest?.observability_dirty
    || latest.observability_signal_sequence !== signal.sequence) return true;

  const leaseNow = now();
  if (leaseNow >= deadlineAt) return true;
  const lease = acquireLease(vaultBase, identity.canonicalConversationId, {
    signalSequence: signal.sequence,
    now: leaseNow,
    ttlMs: Math.max(1, deadlineAt - leaseNow),
  });
  if (!lease?.acquired) return true;

  try {
    if (now() >= deadlineAt) return true;
    const fresh = resolveEntry(vaultBase, identityInput, provider);
    if (fresh.identity?.state !== 'resolved'
      || fresh.identity.canonicalConversationId !== identity.canonicalConversationId
      || !fresh.entry?.session_file
      || !sameCausalSnapshot(observed, causalSnapshot(fresh.entry))) return true;

    const sessionPath = join(vaultBase, fresh.entry.session_file);
    if (!existsSync(sessionPath)) return true;
    const roots = identity.provider === 'codex'
      ? resolveRoots(fresh.entry)
      : claudeRoots(fresh.entry);
    if (roots?.state !== 'complete' || !roots.rootPaths?.length) return true;

    const runtimeState = lease.state || latest;
    const frontier = {
      canonical_session_id: identity.canonicalConversationId,
      activation_id: observed.activationId || 'legacy',
      activation_epoch: observed.activationEpoch,
      turn_sequence: observed.turnSequence,
      signal_sequence: signal.sequence,
      roots_stat_hash: 'pending',
      graph_cursor: 'pending',
      source_manifest_hash: 'pending',
    };
    const readRuntimeFrontier = (candidateFrontier, guardContext) => {
      const currentRuntime = readStore(vaultBase, identity.canonicalConversationId);
      const currentEntry = guardContext?.entry;
      const currentResolved = currentEntry
        ? { identity: { state: 'resolved', canonicalConversationId: identity.canonicalConversationId }, entry: currentEntry }
        : resolveEntry(vaultBase, identityInput, provider);
      if (currentResolved.identity?.state !== 'resolved'
        || currentResolved.identity.canonicalConversationId !== identity.canonicalConversationId
        || !currentResolved.entry) {
        return { ...candidateFrontier, canonical_session_id: 'unresolved' };
      }
      const currentCausal = causalSnapshot(currentResolved.entry);
      return {
        ...candidateFrontier,
        activation_id: currentCausal.activationId || 'legacy',
        activation_epoch: currentCausal.activationEpoch,
        turn_sequence: currentCausal.turnSequence,
        signal_sequence: Math.max(
          Number(currentRuntime?.observability_signal_sequence || 0),
          Number(currentResolved.entry.observability_signal_sequence || 0),
        ),
      };
    };
    const withPublicationGuard = (_candidateFrontier, publishGuarded) => (
      mutateRegistry(vaultBase, (registry) => publishGuarded({
        registry,
        entry: registry.sessions?.[identity.canonicalConversationId] || null,
      }))
    );
    const writeRegistryCheckpoint = ({
      frontier: checkpointFrontier,
      state,
      diagnostics,
      snapshot,
    }, guardContext) => {
      const registry = guardContext?.registry;
      const current = registry?.sessions?.[identity.canonicalConversationId];
      if (!current) return null;
      const currentSignal = Number(current.observability_signal_sequence || checkpointFrontier.signal_sequence);
      registry.sessions[identity.canonicalConversationId] = {
        ...current,
        observability_signal_sequence: currentSignal,
        observability_checkpoint_sequence: checkpointFrontier.signal_sequence,
        observability_dirty: currentSignal > checkpointFrontier.signal_sequence,
        observability_checkpoint_frontier: checkpointFrontier,
        subagents_observability_state: state,
        subagents_diagnostics: diagnostics || [],
      };
      return markObservabilityCheckpoint(vaultBase, identity.canonicalConversationId, {
        checkpointSequence: checkpointFrontier.signal_sequence,
        frontier: checkpointFrontier,
        sourceManifest: snapshot?.subagents?.sourceManifest,
        graphCache: snapshot?.subagents?.cache,
        diagnostics,
      });
    };

    await Promise.resolve(materialize({
      vaultBase,
      sessionPath,
      entry: fresh.entry,
      rootPaths: roots.rootPaths,
      transcriptPath: roots.rootPaths[0],
      caller: 'subagent-stop',
      canonicalConversationId: identity.canonicalConversationId,
      activationId: observed.activationId,
      activationEpoch: observed.activationEpoch,
      turnSequence: observed.turnSequence,
      signalSequence: signal.sequence,
      deadlineAt,
      allowNone: false,
      frontier,
      signals: runtimeState.signals || [],
      cache: runtimeState.graph_cache || null,
      now,
      readRuntimeFrontier,
      withPublicationGuard,
      writeRegistryCheckpoint,
    }));
    return true;
  } finally {
    releaseLease(vaultBase, identity.canonicalConversationId, {
      ownerToken: lease.ownerToken,
      signalSequence: signal.sequence,
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const hookStartedAt = Date.now();
    const input = readHookInput();
    await refreshSubagents(getVaultBase(input), input, { hookStartedAt });
    writeHookOutput({});
  } catch (error) {
    process.stderr.write(`[wendkeep] subagent-stop falhou: ${error.message}\n`);
    writeHookOutput({});
  }
}
