// Single atomic writer for session usage, models, reasoning/effort and subagents.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { collectSessionUsage, collectSessionUsageForRoots } from './token-usage.mjs';
import { collectClaudeSubagentUsageState, collectCodexSubagentUsage, sessionDirFromTranscript } from './subagent-usage.mjs';
import { inspectTranscriptIdentity } from './session-identity.mjs';
import { hasSessionFrontmatter, mutateSessionNote } from './session-note-io.mjs';
import { composeCodexSubagentGraph } from './codex-subagent-graph.mjs';
import { resolveObservabilityRoots } from './session-observability-lifecycle.mjs';
import { markObservabilityCheckpoint, readObservabilityStore } from './session-observability-store.mjs';
import { mutateSessionRegistry } from './obsidian-common.mjs';
import {
  compareObservabilityFrontiers,
  normalizeObservabilityFrontier,
  parseObservabilityCheckpoint,
  renderObservabilityCheckpoint,
  sanitizeObservabilityDiagnostics,
} from './session-observability-state.mjs';

const HEADING = '## Agentes, tokens e custos';
const LEGACY_HEADINGS = ['## Uso de tokens e custos', '## Subagents & Workflows'];
const fmt = (n) => Math.trunc(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const usd = (n) => `$${(Number(n) || 0).toFixed(4)}`;
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const effort = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return ['none', 'low', 'medium', 'high', 'xhigh', 'thinking'].includes(normalized) ? normalized : (normalized || 'unknown');
};
const usageTotal = (u = {}) => Number(u.total || 0) || (Number(u.input || 0) + Number(u.cached || 0) + Number(u.cacheWrite || 0) + Number(u.output || 0));

function setFrontmatterField(content, key, value) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return content;
  const re = new RegExp(`^${key}:.*$`, 'm');
  const line = `${key}: ${value}`;
  const body = re.test(match[1]) ? match[1].replace(re, line) : `${match[1]}\n${line}`;
  return content.replace(match[0], `---\n${body}\n---`);
}

function removeSection(content, heading, { preserveOrphanIterations = false } = {}) {
  const start = content.indexOf(`\n${heading}`);
  if (start < 0) return content;
  const next = content.indexOf('\n## ', start + heading.length + 1);
  const body = next < 0 ? content.slice(start) : content.slice(start, next);
  const orphanAt = preserveOrphanIterations ? body.search(/\n### \d{2}:\d{2} - /) : -1;
  const preserved = orphanAt >= 0 ? body.slice(orphanAt).trim() : '';
  const rest = next < 0 ? '' : content.slice(next + 1).trimStart();
  return [content.slice(0, start).trimEnd(), preserved, rest].filter(Boolean).join('\n\n').trimEnd() + '\n';
}

export function upsertObservabilitySection(content, section) {
  let base = content;
  base = removeSection(base, HEADING);
  base = removeSection(base, LEGACY_HEADINGS[0], { preserveOrphanIterations: true });
  base = removeSection(base, LEGACY_HEADINGS[1]);
  const anchors = ['\n## Pendências', '\n## Issues Linear', '\n## Encerramento'];
  const indexes = anchors.map((a) => base.indexOf(a)).filter((i) => i >= 0).sort((a, b) => a - b);
  if (!indexes.length) return `${base.trimEnd()}\n\n${section.trimEnd()}\n`;
  const at = indexes[0];
  return `${base.slice(0, at).trimEnd()}\n\n${section.trimEnd()}\n\n${base.slice(at).trimStart()}`;
}

function mainLedger(main) {
  const summaries = main.summary ? [main.summary] : (main.summaries || []);
  return summaries.flatMap((summary) => (summary.modelRows || []).map((row) => ({
    provider: row.provider || 'unknown', model: row.model || 'unknown', source: 'main',
    effort: effort(summary.pensamento), calls: row.calls || 0,
    input: row.usage.input || 0, cacheWrite: row.usage.cacheWrite || 0, cached: row.usage.cached || 0,
    output: row.usage.output || 0, reasoning: row.usage.reasoning || 0, total: usageTotal(row.usage),
    cost: round4(row.costs?.model || 0),
  })));
}

function subagentLedger(collected) {
  return (collected?.aggregate.modelRows || []).map((row) => ({
    provider: row.provider || 'unknown', model: row.model || 'unknown', source: 'subagent',
    effort: effort(row.effort), calls: row.calls || 0,
    input: row.usage?.input || 0, cacheWrite: row.usage?.cacheWrite || 0, cached: row.usage?.cached || 0,
    output: row.usage?.output || 0, reasoning: row.usage?.reasoning || 0, total: usageTotal(row.usage || row),
    cost: round4(row.cost || 0),
  }));
}

function renderLedger(rows) {
  if (!rows.length) return 'Nenhum modelo registrado.';
  return ['| Modelo | Provider | Origem | Effort | Chamadas | Input | Cache W | Cache R | Output | Reasoning | Total | Custo |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((r) => `| ${r.model} | ${r.provider} | ${r.source} | ${r.effort} | ${fmt(r.calls)} | ${fmt(r.input)} | ${fmt(r.cacheWrite)} | ${fmt(r.cached)} | ${fmt(r.output)} | ${fmt(r.reasoning)} | ${fmt(r.total)} | ${usd(r.cost)} |`),
  ].join('\n');
}

function renderHistory(entries) {
  if (!entries.length) return 'Nenhuma reabertura registrada.';
  return ['| Transcript | Modelo(s) | Effort | Input | Cache W | Cache R | Output | Reasoning | Total | Custo | Atualizado |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
    ...entries.map((e) => `| ${String(e.transcript_id).slice(0, 12)}… | ${(e.modelos || []).join(' + ')} | ${effort(e.pensamento)} | ${fmt(e.input)} | ${fmt(e.cache_write)} | ${fmt(e.cache_read)} | ${fmt(e.output)} | ${fmt(e.reasoning)} | ${fmt(e.total)} | ${usd(e.custo_usd)} | ${e.atualizado_em || ''} |`),
  ].join('\n');
}

function renderSubagents(collected) {
  if (!collected || collected.state === 'none') {
    return '### Subagents e workflows\n\nNenhum subagent registrado.';
  }
  const a = collected.aggregate;
  const workflows = collected.workflows.length
    ? collected.workflows.map((w) => `${w.name} (${w.runId}${w.status ? ` · ${w.status}` : ''} · ${w.agents} agentes · ${usd(w.cost)})`).join('; ')
    : '(nenhum)';
  const rows = collected.subagents.map((s) => `| ${s.id} | ${s.agentType || '-'} | ${s.workflow || '-'} | ${s.model} | ${effort(s.effort)} | ${s.tools} | ${fmt(s.tokens)} | ${usd(s.cost)} |`).join('\n');
  return `### Subagents e workflows

- **Subagents:** ${a.count} · ${a.calls} chamadas · ${fmt(a.tokens)} tokens · ${usd(a.cost)}
- **Workflows:** ${workflows}
- **Tools:** ${(a.tools || []).join(', ') || '(nenhuma)'}${a.wasted ? `\n- **Desperdiçado:** ${usd(a.wasted)}` : ''}

#### Por subagent (${a.count})

| Agent | Tipo | Workflow | Modelo | Effort | Tools | Tokens | Custo |
|---|---|---|---|---|---:|---:|---:|
${rows}`;
}

export function renderSessionObservability(snapshot) {
  const { main, subagents, ledger } = snapshot;
  const sub = subagents?.aggregate || { count: 0, tokens: 0, cost: 0 };
  const combinedTokens = main.aggregate.total + sub.tokens;
  const combinedCost = round4(main.aggregate.custo + sub.cost);
  return `${HEADING}

> Estimativa API-equivalente baseada nos transcripts locais. Reasoning e effort são observacionais e não acrescentam tarifa separada.

| Métrica | Principal | Subagents | Total |
|---|---:|---:|---:|
| Chamadas com uso | ${fmt(main.aggregate.calls)} | ${fmt(sub.calls)} | ${fmt(main.aggregate.calls + (sub.calls || 0))} |
| Input tokens | ${fmt(main.aggregate.input)} | ${fmt(sub.usage?.input)} | ${fmt(main.aggregate.input + (sub.usage?.input || 0))} |
| Cache write | ${fmt(main.aggregate.cacheWrite)} | ${fmt(sub.usage?.cacheWrite)} | ${fmt(main.aggregate.cacheWrite + (sub.usage?.cacheWrite || 0))} |
| Cache read | ${fmt(main.aggregate.cached)} | ${fmt(sub.usage?.cached)} | ${fmt(main.aggregate.cached + (sub.usage?.cached || 0))} |
| Output tokens | ${fmt(main.aggregate.output)} | ${fmt(sub.usage?.output)} | ${fmt(main.aggregate.output + (sub.usage?.output || 0))} |
| Reasoning tokens | ${fmt(main.aggregate.reasoning)} | ${fmt(sub.usage?.reasoning)} | ${fmt(main.aggregate.reasoning + (sub.usage?.reasoning || 0))} |
| Total tokens | ${fmt(main.aggregate.total)} | ${fmt(sub.tokens)} | ${fmt(combinedTokens)} |
| Custo estimado | ${usd(main.aggregate.custo)} | ${usd(sub.cost)} | ${usd(combinedCost)} |

### Por modelo e origem

${renderLedger(ledger)}

### Por reabertura

${renderHistory(main.entries)}

${renderSubagents(subagents)}`;
}

function quoteFrontmatter(value) {
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function applyCheckpoint(content, frontier, state, diagnostics) {
  let next = content;
  for (const [key, value] of Object.entries(renderObservabilityCheckpoint(frontier, { state, diagnostics }))) {
    next = setFrontmatterField(next, key, quoteFrontmatter(value));
  }
  return next;
}

function rootIds(roots = {}) {
  return new Set((roots.rootPaths || []).map((value) => String(value || '')
    .split(/[\\/]/).pop().replace(/\.jsonl?$/i, '').toLowerCase()).filter(Boolean));
}

function subagentIds(collected) {
  return new Set((collected?.subagents || []).map((entry) => String(entry?.id || entry?.rollout_id || '')
    .trim().toLowerCase()).filter(Boolean));
}

function combineDiagnostics(...groups) {
  return sanitizeObservabilityDiagnostics(groups.flatMap((group) => group || []));
}

function zeroSubagentAggregate() {
  return {
    count: 0, calls: 0, tokens: 0, cost: 0, wasted: 0, tools: [],
    usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    modelRows: [],
  };
}

function legacySubagentScan(transcriptPath) {
  const claude = collectClaudeSubagentUsageState(sessionDirFromTranscript(transcriptPath));
  if (claude.state === 'complete' || claude.state === 'degraded') return claude;
  const codex = collectCodexSubagentUsage(transcriptPath);
  return codex
    ? { ...codex, state: 'complete', diagnostics: [] }
    : { state: 'none', diagnostics: [], aggregate: zeroSubagentAggregate(), subagents: [], workflows: [] };
}

function graphSubagentScan({
  rootPaths,
  frontier,
  signals,
  cache,
  mode,
  limits,
  deadlineAt,
  now,
}) {
  if (!rootPaths?.length) return legacySubagentScan('');
  return composeCodexSubagentGraph({
    rootPaths,
    canonicalSessionId: frontier?.canonical_session_id || '',
    signals,
    cache,
    mode,
    limits,
    deadlineAt,
    now,
  });
}

/**
 * Pure, lock-free composition. Callers may inject the graph/main collectors so the same
 * merge logic is shared by live hooks, import and rebuild without coupling their scanners.
 */
export function composeSessionObservability({
  sessionContent,
  frontier: frontierInput,
  roots = {},
  transcriptPath = '',
  sessionEntry,
  canonicalConversationId = '',
  runtimeState,
  mainResult,
  subagentsResult,
  previousSnapshot = null,
  allowNone = true,
  signals = [],
  cache = null,
  mode = 'live',
  limits = {},
  deadlineAt = Number.POSITIVE_INFINITY,
  now,
} = {}, {
  collectMain = ({ sessionContent: content, rootPaths, descendantIds, transcriptPath: scanTranscriptPath }) => (
    rootPaths?.length
      ? collectSessionUsageForRoots({ sessionContent: content, rootPaths, descendantIds })
      : collectSessionUsage({ sessionContent: content, transcriptPath: scanTranscriptPath })
  ),
  collectSubagents = ({ rootPaths, transcriptPath: scanTranscriptPath, ...input }) => (rootPaths?.length
    ? graphSubagentScan({ rootPaths, ...input })
    : legacySubagentScan(scanTranscriptPath)),
} = {}) {
  if (sessionEntry) {
    return composeRegisteredSessionObservability({
      sessionContent,
      sessionEntry,
      canonicalConversationId,
      runtimeState,
      frontier: frontierInput,
      allowNone,
      mode,
      limits,
      deadlineAt,
      now,
    }, { collectMain, collectSubagents });
  }
  const original = String(sessionContent || '');
  if (!hasSessionFrontmatter(original)) {
    const frontier = normalizeObservabilityFrontier(frontierInput);
    return {
      state: 'degraded', frontier,
      diagnostics: [{ code: 'MAIN_TRANSCRIPT_UNRESOLVED', count: 1 }],
      snapshot: previousSnapshot, content: original,
    };
  }

  const collectedSubagents = subagentsResult ?? collectSubagents({
    roots,
    rootPaths: roots.rootPaths || [],
    descendantIds: roots.descendantIds || [],
    frontier: frontierInput,
    signals,
    cache,
    mode,
    limits,
    deadlineAt,
    now,
    transcriptPath,
  });
  const frontier = normalizeObservabilityFrontier({
    ...frontierInput,
    ...(collectedSubagents?.frontier?.rootsStatHash
      ? { roots_stat_hash: collectedSubagents.frontier.rootsStatHash }
      : {}),
    ...(collectedSubagents?.frontier?.graphCursor
      ? { graph_cursor: collectedSubagents.frontier.graphCursor }
      : {}),
    ...(collectedSubagents?.frontier?.sourceManifestHash
      ? { source_manifest_hash: collectedSubagents.frontier.sourceManifestHash }
      : {}),
  });
  const descendantIds = collectedSubagents?.descendantIds || roots.descendantIds || [];
  const preliminarySubagentState = collectedSubagents?.state || (collectedSubagents ? 'complete' : 'degraded');
  const preliminaryState = preliminarySubagentState === 'none' && allowNone
    ? 'none'
    : (preliminarySubagentState === 'complete' ? 'complete' : 'degraded');
  const preliminaryDiagnostics = combineDiagnostics(
    collectedSubagents?.diagnostics,
    !collectedSubagents ? [{ code: 'SOURCE_CHANGED_DURING_SCAN', count: 1 }] : [],
    preliminarySubagentState === 'none' && !allowNone ? [{ code: 'STALE_FRONTIER', count: 1 }] : [],
  );
  // Seed the checkpoint before the main frontmatter collector canonicalizes managed fields.
  // This makes the first materialization use the same ordering as every subsequent replay.
  const mainInputContent = preliminaryState === 'degraded'
    ? original
    : applyCheckpoint(original, frontier, preliminaryState, preliminaryDiagnostics);
  const main = mainResult ?? collectMain({
    sessionContent: mainInputContent,
    rootPaths: roots.rootPaths || [],
    descendantIds,
    roots,
    frontier,
    transcriptPath,
  });

  const mainState = main?.state || (main ? 'complete' : 'degraded');
  const subagentsState = preliminarySubagentState;
  const diagnostics = combineDiagnostics(
    main?.diagnostics,
    collectedSubagents?.diagnostics,
    !main ? [{ code: 'MAIN_TRANSCRIPT_UNRESOLVED', count: 1 }] : [],
    !collectedSubagents ? [{ code: 'SOURCE_CHANGED_DURING_SCAN', count: 1 }] : [],
    subagentsState === 'none' && !allowNone ? [{ code: 'STALE_FRONTIER', count: 1 }] : [],
  );
  const overlap = [...rootIds(roots)].filter((id) => subagentIds(collectedSubagents).has(id));
  const safeDiagnostics = overlap.length
    ? combineDiagnostics(diagnostics, [{ code: 'ROOT_MISMATCH', count: overlap.length }])
    : diagnostics;

  if (mainState === 'degraded' || subagentsState === 'degraded'
    || (subagentsState === 'none' && !allowNone) || overlap.length) {
    return {
      state: 'degraded', frontier, diagnostics: safeDiagnostics,
      snapshot: previousSnapshot, content: original,
    };
  }

  const state = subagentsState === 'none' ? 'none' : 'complete';
  // A proven empty graph still carries its source manifest/cache. Dropping that proof made
  // the next import/doctor run classify a genuinely fresh `none` snapshot as unprovable.
  const subagents = collectedSubagents;
  const ledger = [...mainLedger(main), ...subagentLedger(subagents)];
  const sub = subagents?.aggregate || zeroSubagentAggregate();
  let content = main.content;
  content = setFrontmatterField(content, 'subagents_count', sub.count || 0);
  content = setFrontmatterField(content, 'subagents_tokens_total', sub.tokens || 0);
  content = setFrontmatterField(content, 'subagents_custo_usd', sub.cost || 0);
  content = setFrontmatterField(content, 'subagents_tools', `"${(sub.tools || []).join(', ')}"`);
  content = setFrontmatterField(content, 'subagents_wasted_usd', sub.wasted || 0);
  content = setFrontmatterField(content, 'tokens_total_incl_subagents', main.aggregate.total + (sub.tokens || 0));
  content = setFrontmatterField(content, 'custo_total_incl_subagents_usd', round4(main.aggregate.custo + (sub.cost || 0)));
  content = setFrontmatterField(content, 'custo_por_modelo_json', `'${JSON.stringify(ledger).replaceAll("'", "''")}'`);
  content = applyCheckpoint(content, frontier, state, safeDiagnostics);
  const snapshot = {
    version: 2, state, frontier, diagnostics: safeDiagnostics,
    main, subagents, ledger,
    roots: {
      rootPaths: [...(roots.rootPaths || [])].sort(),
      descendantIds: [...descendantIds].sort(),
    },
  };
  return {
    state, frontier, diagnostics: safeDiagnostics, snapshot,
    content: upsertObservabilitySection(content, renderSessionObservability(snapshot)),
  };
}

function causalFieldsFromEntry(entry = {}, runtimeState = {}, canonicalConversationId = '') {
  const activationId = String(entry.active_activation_id || entry.activation_id || 'offline');
  const activation = entry.activations?.[activationId] || {};
  return {
    canonical_session_id: canonicalConversationId || entry.canonical_session_id || entry.session_id || 'offline-session',
    activation_id: activationId,
    activation_epoch: Number(activation.epoch ?? entry.activation_epoch ?? 0) || 0,
    turn_sequence: Number(entry.last_turn_sequence ?? activation.last_turn_sequence ?? 0) || 0,
    signal_sequence: Number(runtimeState.observability_signal_sequence ?? entry.observability_signal_sequence ?? 0) || 0,
    roots_stat_hash: runtimeState.checkpoint_frontier?.roots_stat_hash || 'pending-roots',
    graph_cursor: runtimeState.checkpoint_frontier?.graph_cursor || 'pending-graph',
    source_manifest_hash: runtimeState.checkpoint_frontier?.source_manifest_hash || 'pending-manifest',
  };
}

/** Pure registered-session composition used by import/rebuild previews. No writer is reachable. */
export function composeRegisteredSessionObservability({
  sessionContent,
  sessionEntry = {},
  canonicalConversationId = '',
  runtimeState = {},
  frontier: frontierInput,
  allowNone = true,
  mode = 'offline',
  limits = {},
  deadlineAt = Number.POSITIVE_INFINITY,
  now,
} = {}, dependencies = {}) {
  const provider = String(sessionEntry.provider || '').trim().toLowerCase();
  const transcriptPath = sessionEntry.transcript_path
    || sessionEntry.transcript_paths?.[0]
    || '';
  const resolution = provider === 'claude'
    ? { state: 'complete', rootPaths: [], descendantPaths: [], diagnostics: [] }
    : resolveObservabilityRoots(sessionEntry);
  const roots = {
    rootPaths: resolution.rootPaths || [],
    descendantPaths: resolution.descendantPaths || [],
    descendantIds: sessionEntry.descendant_ids || [],
  };
  const missingCodexRoot = provider !== 'claude' && roots.rootPaths.length === 0;
  const subagentsResult = resolution.state === 'degraded' || missingCodexRoot
    ? {
      state: 'degraded',
      diagnostics: resolution.diagnostics?.length
        ? resolution.diagnostics
        : [{ code: 'MAIN_TRANSCRIPT_UNRESOLVED', count: 1 }],
    }
    : undefined;
  return composeSessionObservability({
    sessionContent,
    transcriptPath,
    frontier: {
      ...causalFieldsFromEntry(sessionEntry, runtimeState, canonicalConversationId),
      ...(frontierInput || {}),
    },
    roots,
    subagentsResult,
    allowNone,
    signals: runtimeState.signals || [],
    cache: runtimeState.graph_cache || null,
    mode,
    limits,
    deadlineAt,
    now,
  }, dependencies);
}

function candidateRelation(current, candidate) {
  if (!current) return 'newer';
  const frontier = current.frontier || current;
  return compareObservabilityFrontiers(frontier, candidate);
}

function sameSortedStrings(left = [], right = []) {
  const a = [...new Set(left.filter(Boolean))].sort();
  const b = [...new Set(right.filter(Boolean))].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

const CAUSAL_FRONTIER_FIELDS = [
  'canonical_session_id',
  'activation_id',
  'activation_epoch',
  'turn_sequence',
  'signal_sequence',
];

function sameCausalAuthority(leftInput, rightInput) {
  const left = leftInput?.frontier || leftInput;
  const right = rightInput?.frontier || rightInput;
  return Boolean(left && right
    && CAUSAL_FRONTIER_FIELDS.every((field) => left[field] === right[field]));
}

function candidateManifestIsCurrent(snapshot) {
  const manifest = snapshot?.subagents?.sourceManifest;
  if (!Array.isArray(manifest) || manifest.length === 0) return false;
  return manifest.every((source) => {
    try {
      const stat = statSync(source.path);
      return stat.isFile() && stat.size === Number(source.size)
        && stat.mtimeMs === Number(source.mtimeMs);
    } catch {
      return false;
    }
  });
}

function registeredRootsAreCurrent(context, snapshot) {
  const candidateRoots = snapshot?.roots?.rootPaths || [];
  if (!context?.entry || !candidateRoots.length) return false;
  const resolution = resolveObservabilityRoots(context.entry);
  return resolution.state === 'complete'
    && sameSortedStrings(resolution.rootPaths, candidateRoots);
}

function canRefreshSourceFrontier(current, candidate, context, snapshot, enabled) {
  return Boolean(enabled
    && sameCausalAuthority(current, candidate)
    && registeredRootsAreCurrent(context, snapshot)
    && candidateManifestIsCurrent(snapshot));
}

function currentFrontierUnderGuard(candidate, context, snapshot) {
  if (!context) return candidate;
  const entry = context.entry;
  if (!entry) return { ...candidate, canonical_session_id: 'registry-session-missing' };
  const activationId = String(entry.active_activation_id || entry.activation_id || candidate.activation_id);
  const activation = entry.activations?.[activationId] || {};
  const current = {
    ...candidate,
    activation_id: activationId,
    activation_epoch: Number(activation.epoch ?? entry.activation_epoch ?? candidate.activation_epoch) || 0,
    turn_sequence: Number(entry.last_turn_sequence ?? activation.last_turn_sequence ?? candidate.turn_sequence) || 0,
    signal_sequence: Number(
      context.runtimeState?.observability_signal_sequence
      ?? entry.observability_signal_sequence
      ?? candidate.signal_sequence,
    ) || 0,
  };
  const candidateRoots = snapshot?.roots?.rootPaths || [];
  if (candidateRoots.length && String(entry.provider || '').toLowerCase() !== 'claude') {
    const resolution = resolveObservabilityRoots(entry);
    if (resolution.state !== 'complete'
      || !sameSortedStrings(resolution.rootPaths, candidateRoots)) {
      current.roots_stat_hash = `${candidate.roots_stat_hash}-registry-changed`;
    }
  }
  return current;
}

function updateGuardedRegistryCheckpoint(context, sessionId, checkpoint) {
  const registry = context?.registry;
  const current = registry?.sessions?.[sessionId];
  if (!current) return;
  const frontier = checkpoint.frontier;
  const signalSequence = Math.max(
    Number(current.observability_signal_sequence || 0),
    frontier.signal_sequence,
  );
  registry.sessions[sessionId] = {
    ...current,
    observability_schema: 2,
    subagents_observability_state: checkpoint.state,
    observability_signal_sequence: signalSequence,
    observability_checkpoint_sequence: frontier.signal_sequence,
    observability_dirty: signalSequence > frontier.signal_sequence,
    observability_checkpoint_frontier: frontier,
    subagents_diagnostics: checkpoint.diagnostics || [],
  };
}

/**
 * Causal publisher. Composition is deliberately completed before the note writer is entered;
 * the writer only validates the latest checkpoint and swaps complete bytes.
 */
export function publishSessionObservability({
  sessionPath,
  frontier: frontierInput,
  candidate: providedCandidate,
  compose,
  composeInput,
  readRuntimeFrontier,
  writeRegistryCheckpoint,
  withPublicationGuard,
  canonicalConversationId = '',
  vaultBase = '',
  allowSourceRefresh = false,
  allowDegradedRecovery = false,
  lockTimeoutMs,
} = {}, {
  mutateNote = mutateSessionNote,
  composeObservability = composeSessionObservability,
} = {}) {
  const candidate = providedCandidate
    ?? (compose ? compose() : composeObservability(composeInput));
  if (!candidate) return { status: 'missing', state: 'degraded', candidate: null };
  if (candidate.state === 'degraded') {
    return { status: 'degraded', state: 'degraded', candidate };
  }

  const frontier = normalizeObservabilityFrontier(candidate.frontier || frontierInput);
  const sessionId = canonicalConversationId || frontier.canonical_session_id;
  const guardedByDefault = Boolean(vaultBase && sessionId);
  const effectiveGuard = withPublicationGuard || (guardedByDefault
    ? (_candidateFrontier, publishGuarded) => mutateSessionRegistry(vaultBase, (registry) => {
      const entry = registry.sessions?.[sessionId] || null;
      const runtimeState = readObservabilityStore(vaultBase, sessionId);
      return publishGuarded({ registry, entry, runtimeState });
    }, { ...(lockTimeoutMs ? { timeoutMs: lockTimeoutMs } : {}) })
    : null);
  const effectiveReadFrontier = readRuntimeFrontier
    || (guardedByDefault
      ? (candidateFrontier, context) => currentFrontierUnderGuard(
        candidateFrontier,
        context,
        candidate.snapshot,
      )
      : null);
  const effectiveCheckpointWriter = writeRegistryCheckpoint
    || (guardedByDefault
      ? (checkpoint, context) => {
        updateGuardedRegistryCheckpoint(context, sessionId, checkpoint);
        return markObservabilityCheckpoint(vaultBase, sessionId, {
          checkpointSequence: checkpoint.frontier.signal_sequence,
          frontier: checkpoint.frontier,
          sourceManifest: checkpoint.snapshot?.subagents?.sourceManifest,
          graphCache: checkpoint.snapshot?.subagents?.cache,
          diagnostics: checkpoint.diagnostics,
        });
      }
      : null);
  const publishGuarded = (guardContext) => {
    const live = effectiveReadFrontier?.(frontier, guardContext);
    const liveRelation = candidateRelation(live, frontier);
    if ((liveRelation === 'stale' || liveRelation === 'conflict')
      && !canRefreshSourceFrontier(
        live,
        frontier,
        guardContext,
        candidate.snapshot,
        allowSourceRefresh,
      )) {
      return { status: liveRelation, state: candidate.state, candidate };
    }

    let rejection = '';
    const outcome = mutateNote(sessionPath, (original) => {
      if (!hasSessionFrontmatter(original)) {
        rejection = 'degraded';
        return null;
      }
      const checkpoint = parseObservabilityCheckpoint(original);
      const relation = candidateRelation(checkpoint, frontier);
      if ((relation === 'stale' || relation === 'conflict')
        && !canRefreshSourceFrontier(
          checkpoint,
          frontier,
          guardContext,
          candidate.snapshot,
          allowSourceRefresh,
        )) {
        rejection = relation;
        return null;
      }
      const recoveringDegraded = allowDegradedRecovery
        && checkpoint?.state === 'degraded'
        && candidate.state !== 'degraded';
      if (relation === 'same' && original !== candidate.content && !recoveringDegraded) {
        rejection = 'conflict';
        return null;
      }
      return candidate.content;
    }, { ...(lockTimeoutMs ? { timeoutMs: lockTimeoutMs } : {}), vaultBase });

    if (rejection) return { status: rejection, state: candidate.state, candidate, outcome };
    if (!outcome?.written && outcome?.reason !== 'unchanged') {
      return { status: outcome?.reason || 'missing', state: candidate.state, candidate, outcome };
    }

    // A crash here leaves a fully checkpointed note. Retrying observes the same bytes and
    // executes only this registry reconciliation, so publication remains idempotent.
    effectiveCheckpointWriter?.({
      frontier,
      state: candidate.state,
      diagnostics: candidate.diagnostics || [],
      snapshot: candidate.snapshot,
    }, guardContext);
    return {
      status: outcome.written ? 'published' : 'unchanged',
      state: candidate.state,
      candidate,
      snapshot: candidate.snapshot,
      outcome,
    };
  };
  return effectiveGuard
    ? effectiveGuard(frontier, publishGuarded)
    : publishGuarded(undefined);
}

/**
 * Hook-friendly facade: resolve registered roots, scan/compose outside the note lock and
 * causally publish the resulting candidate. Live hooks pass allowNone=false for an isolated
 * SubagentStop signal and true only for a causally eligible SessionStop.
 */
export function materializeSessionObservability({
  vaultBase = '',
  sessionPath,
  entry = {},
  transcriptPath = entry.transcript_path || '',
  frontier: frontierInput,
  canonicalConversationId = '',
  allowNone = true,
  signals = [],
  cache = null,
  mode = 'live',
  limits = {},
  deadlineAt = Number.POSITIVE_INFINITY,
  now,
  lockTimeoutMs,
  readRuntimeFrontier,
  writeRegistryCheckpoint,
  withPublicationGuard,
} = {}, {
  readSessionContent = (path) => readFileSync(path, 'utf8'),
  resolveRoots = resolveObservabilityRoots,
  mutateNote = mutateSessionNote,
  composeObservability = composeSessionObservability,
} = {}) {
  if (!sessionPath || !existsSync(sessionPath)) {
    return { status: 'missing', state: 'degraded', candidate: null };
  }
  const sessionContent = readSessionContent(sessionPath);
  const identity = inspectTranscriptIdentity(transcriptPath);
  const provider = String(entry.provider || '').trim().toLowerCase();
  const rootResolution = provider === 'claude'
    ? { state: 'complete', rootPaths: [], descendantPaths: [], diagnostics: [] }
    : resolveRoots(entry);
  const compatibility = compatibilityFrontier(
    transcriptPath,
    identity,
    canonicalConversationId || entry.canonical_session_id || entry.session_id || '',
  );
  const frontier = { ...compatibility, ...(frontierInput || {}) };
  const roots = {
    rootPaths: rootResolution.rootPaths || [],
    descendantPaths: rootResolution.descendantPaths || [],
    descendantIds: entry.descendant_ids || [],
  };
  const subagentsResult = rootResolution.state === 'degraded'
    ? { state: 'degraded', diagnostics: rootResolution.diagnostics || [] }
    : undefined;
  const candidate = composeObservability({
    sessionContent,
    frontier,
    roots,
    transcriptPath,
    subagentsResult,
    allowNone,
    signals,
    cache,
    mode,
    limits,
    deadlineAt,
    now,
  });
  return publishSessionObservability({
    sessionPath,
    candidate,
    canonicalConversationId: candidate.frontier?.canonical_session_id || frontier.canonical_session_id,
    readRuntimeFrontier,
    writeRegistryCheckpoint,
    withPublicationGuard,
    vaultBase,
    lockTimeoutMs,
  }, { mutateNote, composeObservability });
}

function compatibilityFrontier(transcriptPath, identity, canonicalConversationId = '') {
  const transcriptId = identity.transcriptId || String(transcriptPath || '').split(/[\\/]/).pop().replace(/\.jsonl?$/i, '') || 'legacy';
  return normalizeObservabilityFrontier({
    canonical_session_id: canonicalConversationId || identity.canonicalConversationId || transcriptId,
    activation_id: 'legacy',
    activation_epoch: 0,
    turn_sequence: 0,
    signal_sequence: 0,
    roots_stat_hash: `legacy-${transcriptId}`,
    graph_cursor: 'legacy',
    source_manifest_hash: `legacy-${transcriptId}`,
  });
}

export function buildSessionObservability({ sessionContent, transcriptPath, frontier, canonicalConversationId = '', allowNone = true }) {
  const identity = inspectTranscriptIdentity(transcriptPath);
  const result = composeSessionObservability({
    sessionContent,
    transcriptPath,
    frontier: frontier || compatibilityFrontier(transcriptPath, identity, canonicalConversationId),
    allowNone,
  });
  return result.state === 'degraded' ? null : result;
}

export function updateSessionObservability({
  vaultBase = '', sessionPath, transcriptPath, caller = 'unknown', canonicalConversationId = '', lockTimeoutMs,
}) {
  if (!sessionPath || !existsSync(sessionPath)) return null;
  const identity = inspectTranscriptIdentity(transcriptPath);
  let snapshot = null;

  // `subagent-stop` dispara uma vez por subagent: sem o lock, dois processos leem a mesma
  // nota e o segundo grava por cima — ou pior, lê o arquivo já truncado pelo primeiro.
  const outcome = mutateSessionNote(sessionPath, (sessionContent) => {
    // Fail-closed: leitura sem frontmatter íntegro é conteúdo truncado, não nota nova.
    if (!hasSessionFrontmatter(sessionContent)) return null;
    const noteProvider = sessionContent.match(/^provider:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || 'unknown';
    if ((noteProvider === 'codex' && identity.transcriptProvider !== 'openai')
      || (noteProvider === 'claude' && identity.transcriptProvider !== 'anthropic')) {
      throw new Error(`observability provider mismatch: note=${noteProvider}, transcript=${identity.transcriptProvider}`);
    }
    let annotated = sessionContent;
    if (!/^observability_caller:/m.test(annotated)) {
      annotated = setFrontmatterField(annotated, 'observability_caller', `"${caller}"`);
    }
    annotated = setFrontmatterField(annotated, 'observability_session_id', `"${canonicalConversationId || identity.canonicalConversationId || ''}"`);
    annotated = setFrontmatterField(annotated, 'observability_transcript_id', `"${identity.transcriptId || ''}"`);
    if (!/^observability_updated_at:/m.test(annotated)) {
      annotated = setFrontmatterField(annotated, 'observability_updated_at', `"${new Date().toISOString()}"`);
    }
    const result = buildSessionObservability({
      sessionContent: annotated,
      transcriptPath,
      canonicalConversationId: canonicalConversationId || identity.canonicalConversationId || '',
    });
    if (!result) return null;
    snapshot = result.snapshot;
    return result.content;
  }, { ...(lockTimeoutMs ? { timeoutMs: lockTimeoutMs } : {}), vaultBase });

  // 'unchanged' também é sucesso: a nota já estava em dia, o snapshot vale.
  return outcome.written || outcome.reason === 'unchanged' ? snapshot : null;
}
