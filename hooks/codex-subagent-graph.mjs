import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { readCodexRolloutMeta } from "./codex-rollout-meta.mjs";
import {
  addUsage,
  costBreakdown,
  emptyTokenUsage,
  normalizeCodexUsage,
  priceForModel,
} from "./token-usage.mjs";

export const CODEX_SUBAGENT_GRAPH_LIMITS = Object.freeze({
  maxGraphNodes: 4096,
  maxFallbackDays: 31,
  maxFallbackCandidates: 20_000,
  maxLiveUncachedBytes: 512 * 1024 * 1024,
});

const READ_CHUNK_BYTES = 64 * 1024;
const CACHE_VERSION = 1;
const DIAGNOSTIC_ORDER = [
  "PARENT_META_INVALID",
  "CHILD_MISSING",
  "CHILD_META_INVALID",
  "ROOT_MISMATCH",
  "LEGACY_CHAIN_UNPROVEN",
  "DUPLICATE_ROLLOUT_ID",
  "GRAPH_LIMIT_EXCEEDED",
  "FALLBACK_LIMIT_EXCEEDED",
  "LIVE_BYTE_BUDGET_EXCEEDED",
  "LIVE_DEADLINE_EXCEEDED",
  "SOURCE_CHANGED_DURING_SCAN",
  "CACHE_INVALID",
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stableHash = (value) => sha256(JSON.stringify(value));
const round4 = (value) => Math.round((Number(value) || 0) * 10_000) / 10_000;

function tokenTotal(usage) {
  const explicit = Number(usage?.total);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return (
    (Number(usage?.input) || 0) +
    (Number(usage?.cached) || 0) +
    (Number(usage?.cacheWrite) || 0) +
    (Number(usage?.output) || 0)
  );
}

function normalizedLimits(overrides = {}) {
  const result = { ...CODEX_SUBAGENT_GRAPH_LIMITS };
  for (const key of Object.keys(result)) {
    const value = Number(overrides?.[key]);
    if (Number.isSafeInteger(value) && value > 0) result[key] = value;
  }
  return result;
}

function makeClock(now) {
  if (typeof now === "function") {
    return (phase) => {
      const value = Number(now(phase));
      return Number.isFinite(value) ? value : Date.now();
    };
  }
  if (Number.isFinite(Number(now))) return () => Number(now);
  return () => Date.now();
}

function safeStat(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function sameStat(left, right) {
  return Boolean(
    left &&
    right &&
    Number(left.size) === Number(right.size) &&
    Number(left.mtimeMs) === Number(right.mtimeMs),
  );
}

function cacheKey(rolloutId, stat) {
  return `${rolloutId}\u0000${stat.size}\u0000${stat.mtimeMs}`;
}

function validCachedSummary(value, rolloutId) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.rolloutId === rolloutId &&
    Array.isArray(value.activities) &&
    Array.isArray(value.tools) &&
    Array.isArray(value.modelRows) &&
    value.totals &&
    typeof value.totals === "object",
  );
}

function normalizeInputCache(cache, diagnostic) {
  if (cache == null) return {};
  if (
    !cache ||
    typeof cache !== "object" ||
    cache.version !== CACHE_VERSION ||
    !cache.entries ||
    typeof cache.entries !== "object" ||
    Array.isArray(cache.entries)
  ) {
    diagnostic("CACHE_INVALID");
    return {};
  }
  return cache.entries;
}

function parseDateParts(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (!Number.isFinite(date.getTime())) return null;
  return {
    date,
    year: match[1],
    month: match[2],
    day: match[3],
    key: `${match[1]}-${match[2]}-${match[3]}`,
  };
}

function rolloutLocation(path) {
  const normalized = String(path || "").replace(/\\/g, "/");
  const match = normalized.match(/^(.*)\/(\d{4})\/(\d{2})\/(\d{2})\/[^/]+$/);
  if (!match) return null;
  return {
    base: match[1],
    date: parseDateParts(`${match[2]}-${match[3]}-${match[4]}`),
  };
}

function dayDir(base, dateParts) {
  return join(base, dateParts.year, dateParts.month, dateParts.day);
}

function addDays(date, amount) {
  return new Date(date.getTime() + amount * 86_400_000);
}

function partsFromDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return parseDateParts(
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
  );
}

function listJsonl(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".jsonl"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function idMatchesFilename(path, rolloutId) {
  const name = basename(path).toLowerCase();
  return (
    name.endsWith(`-${String(rolloutId).toLowerCase()}.jsonl`) ||
    name === `${String(rolloutId).toLowerCase()}.jsonl`
  );
}

function normalizeActivity(event, parentRolloutId) {
  const payload = event?.payload || {};
  if (event?.type !== "event_msg" || payload.type !== "sub_agent_activity")
    return null;
  const childId = String(
    payload.agent_thread_id || payload.agentThreadId || "",
  ).trim();
  const kind = String(payload.kind || "")
    .trim()
    .toLowerCase();
  if (!childId || !["started", "interacted", "interrupted"].includes(kind))
    return null;
  return {
    parentRolloutId,
    childId,
    kind,
    timestamp: event.timestamp || payload.timestamp || "",
    agentPath: String(payload.agent_path || payload.agentPath || ""),
    transcriptPath: "",
    source: "transcript",
  };
}

function normalizeSignal(signal) {
  if (!signal || typeof signal !== "object") return null;
  const childId = String(
    signal.rolloutId ||
      signal.rollout_id ||
      signal.agentThreadId ||
      signal.agent_thread_id ||
      "",
  ).trim();
  const parentRolloutId = String(
    signal.parentRolloutId ||
      signal.parent_rollout_id ||
      signal.parentThreadId ||
      signal.parent_thread_id ||
      "",
  ).trim();
  if (!childId) return null;
  const rawKind = String(
    signal.kind || signal.eventKind || signal.event_kind || "started",
  ).toLowerCase();
  const kind = ["interacted", "interrupted"].includes(rawKind)
    ? rawKind
    : "started";
  return {
    parentRolloutId,
    childId,
    kind,
    timestamp: signal.timestamp || signal.startedAt || signal.started_at || "",
    agentPath: String(signal.agentPath || signal.agent_path || ""),
    transcriptPath: String(
      signal.transcriptPath || signal.transcript_path || signal.path || "",
    ),
    source: "signal",
  };
}

function modelRowCost(row) {
  return costBreakdown(row.usage, priceForModel(row.model))?.total || 0;
}

function emptyScanSummary(rolloutId) {
  return {
    rolloutId,
    activities: [],
    malformedLines: 0,
    effort: "",
    calls: 0,
    tools: [],
    totals: emptyTokenUsage(),
    modelRows: [],
    cost: 0,
  };
}

function parseRolloutStream(path, rolloutId, shouldContinue) {
  const summary = emptyScanSummary(rolloutId);
  const tools = new Set();
  const byModel = new Map();
  let currentModel = "unknown";
  let currentProvider = "unknown";
  let fd;
  let carry = "";
  const decoder = new StringDecoder("utf8");

  const parseLine = (line) => {
    if (!line) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      summary.malformedLines += 1;
      return;
    }
    const payload = event?.payload || {};
    if (event?.type === "session_meta") {
      currentModel = String(payload.model || currentModel || "unknown");
      currentProvider = String(
        payload.model_provider || currentProvider || "unknown",
      );
      return;
    }
    if (event?.type === "turn_context") {
      currentModel = String(payload.model || currentModel || "unknown");
      currentProvider = String(
        payload.model_provider || currentProvider || "unknown",
      );
      summary.effort = String(
        payload.effort ||
          payload.reasoning_effort ||
          payload.collaboration_mode?.settings?.reasoning_effort ||
          summary.effort ||
          "",
      );
      return;
    }
    const subagentActivity = normalizeActivity(event, rolloutId);
    if (subagentActivity) {
      summary.activities.push(subagentActivity);
      return;
    }
    if (event?.type === "response_item" && payload.type === "function_call") {
      tools.add(String(payload.name || "function_call"));
      return;
    }
    if (
      event?.type === "response_item" &&
      payload.type === "tool_search_call"
    ) {
      tools.add("tool_search");
      return;
    }
    if (event?.type === "response_item" && payload.type === "web_search_call") {
      tools.add("web_search");
      return;
    }
    if (event?.type !== "event_msg" || payload.type !== "token_count") return;
    const info = payload.info || {};
    if (!info.last_token_usage) return;
    const usage = normalizeCodexUsage(info.last_token_usage);
    const model = String(
      info.model || payload.model || currentModel || "unknown",
    );
    const provider = String(
      info.model_provider ||
        payload.model_provider ||
        currentProvider ||
        "unknown",
    );
    const key = `${provider}\u0000${model}\u0000${summary.effort}`;
    const row = byModel.get(key) || {
      provider,
      model,
      effort: summary.effort,
      calls: 0,
      usage: emptyTokenUsage(),
    };
    row.calls += 1;
    addUsage(row.usage, usage);
    byModel.set(key, row);
    summary.calls += 1;
    addUsage(summary.totals, usage);
  };

  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (true) {
      if (!shouldContinue("chunk")) return { ok: false, summary };
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      carry += decoder.write(buffer.subarray(0, bytesRead));
      let newlineAt;
      while ((newlineAt = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, newlineAt).replace(/\r$/, "");
        carry = carry.slice(newlineAt + 1);
        parseLine(line);
      }
    }
    carry += decoder.end();
    if (carry) parseLine(carry.replace(/\r$/, ""));
  } catch {
    return { ok: false, summary };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }

  summary.tools = [...tools].sort();
  summary.modelRows = [...byModel.values()]
    .sort((left, right) =>
      `${left.provider}\u0000${left.model}\u0000${left.effort}`.localeCompare(
        `${right.provider}\u0000${right.model}\u0000${right.effort}`,
      ),
    )
    .map((row) => {
      const cost = round4(modelRowCost(row));
      return {
        ...row,
        tokens: tokenTotal(row.usage),
        cost,
        costs: { model: cost },
      };
    });
  summary.cost = round4(
    summary.modelRows.reduce((total, row) => total + row.cost, 0),
  );
  return { ok: true, summary };
}

function fileDigest(path, shouldContinue) {
  let fd;
  const hash = createHash("sha256");
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (true) {
      if (!shouldContinue("duplicate-hash")) return null;
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

function sourceSubagent(meta) {
  return meta?.source?.subagent || null;
}

function immediateParent(meta) {
  return String(
    meta?.parent_thread_id ||
      sourceSubagent(meta)?.thread_spawn?.parent_thread_id ||
      "",
  ).trim();
}

function makeAgent(meta, summary, status, fallbackDepth) {
  const spawn = sourceSubagent(meta)?.thread_spawn || {};
  const calls = Number(summary.calls) || 0;
  const tokens = tokenTotal(summary.totals);
  return {
    id: String(meta.id),
    parentId: immediateParent(meta),
    depth: Number(spawn.depth) || fallbackDepth,
    agentType: String(spawn.agent_nickname || "codex-subagent"),
    workflow: null,
    status: status || "started",
    model:
      calls > 0 ? String(summary.modelRows[0]?.model || "unknown") : "unknown",
    effort: calls > 0 ? String(summary.effort || "") : "",
    tools: summary.tools.length,
    toolNames: [...summary.tools],
    calls,
    tokens,
    cost: round4(summary.cost),
    modelRows: summary.modelRows.map((row) => ({ ...row })),
  };
}

function aggregateAgents(agents) {
  const usage = emptyTokenUsage();
  const tools = new Set();
  const byModel = new Map();
  let calls = 0;
  let cost = 0;
  for (const agent of agents) {
    calls += agent.calls || 0;
    cost += agent.cost || 0;
    for (const name of agent.toolNames || []) tools.add(name);
    for (const row of agent.modelRows || []) {
      addUsage(usage, row.usage || {});
      const key = `${row.provider || "unknown"}\u0000${row.model || "unknown"}\u0000${row.effort || ""}`;
      const current = byModel.get(key) || {
        provider: row.provider || "unknown",
        model: row.model || "unknown",
        effort: row.effort || "",
        calls: 0,
        usage: emptyTokenUsage(),
        cost: 0,
      };
      current.calls += row.calls || 0;
      addUsage(current.usage, row.usage || {});
      current.cost += row.cost || row.costs?.model || 0;
      byModel.set(key, current);
    }
  }
  const modelRows = [...byModel.values()]
    .sort((left, right) =>
      `${left.provider}\u0000${left.model}\u0000${left.effort}`.localeCompare(
        `${right.provider}\u0000${right.model}\u0000${right.effort}`,
      ),
    )
    .map((row) => ({
      ...row,
      tokens: tokenTotal(row.usage),
      cost: round4(row.cost),
      costs: { model: round4(row.cost) },
      source: "subagent",
    }));
  return {
    count: agents.length,
    calls,
    tokens: tokenTotal(usage),
    cost: round4(cost),
    wasted: 0,
    usage,
    tools: [...tools].sort(),
    modelRows,
  };
}

/**
 * Compose a deterministic Codex subagent graph from registered top-level rollouts.
 * Transcripts are authoritative; cache is a caller-owned, discardable optimization.
 */
export function composeCodexSubagentGraph({
  rootPaths = [],
  canonicalSessionId = "",
  signals = [],
  cache = null,
  mode = "live",
  limits: limitOverrides = {},
  deadlineAt = Number.POSITIVE_INFINITY,
  now,
} = {}) {
  const live = mode !== "offline";
  const limits = normalizedLimits(limitOverrides);
  const clock = makeClock(now);
  const diagnosticCounts = new Map();
  const diagnostic = (code, count = 1) => {
    if (!DIAGNOSTIC_ORDER.includes(code)) return;
    diagnosticCounts.set(code, (diagnosticCounts.get(code) || 0) + count);
  };
  let aborted = false;
  const shouldContinue = (phase) => {
    if (aborted) return false;
    if (live && clock(phase) >= Number(deadlineAt)) {
      diagnostic("LIVE_DEADLINE_EXCEEDED");
      aborted = true;
      return false;
    }
    return true;
  };

  const inputCache = normalizeInputCache(cache, diagnostic);
  const outputCache = {};
  const stats = {
    parsedRollouts: 0,
    cacheHits: 0,
    fallbackDays: 0,
    fallbackCandidates: 0,
    uncachedBytes: 0,
  };
  const sourceByPath = new Map();
  const statuses = new Map();
  const statusRank = { started: 1, interacted: 2, interrupted: 3 };
  const updateStatus = (activityItem) => {
    const current = statuses.get(activityItem.childId) || "started";
    if ((statusRank[activityItem.kind] || 0) >= (statusRank[current] || 0)) {
      statuses.set(activityItem.childId, activityItem.kind);
    }
  };
  const graphEvidence = new Set();
  const queue = [];
  const queuedEdges = new Set();
  const enqueue = (item) => {
    if (!item?.childId) return;
    updateStatus(item);
    if (item.kind !== "started") return;
    const key = `${item.parentRolloutId}\u0000started\u0000${item.childId}`;
    graphEvidence.add(key);
    if (queuedEdges.has(key)) return;
    queuedEdges.add(key);
    queue.push(item);
  };

  const roots = [
    ...new Set(
      (Array.isArray(rootPaths) ? rootPaths : [rootPaths])
        .filter((value) => typeof value === "string" && value)
        .map((value) => resolve(value)),
    ),
  ].sort();
  if (roots.length === 0) diagnostic("PARENT_META_INVALID");
  const rootLocations = roots.map(rolloutLocation).filter(Boolean);
  const bases = [...new Set(rootLocations.map((item) => item.base))].sort();
  const rootDates = rootLocations.map((item) => item.date).filter(Boolean);
  const rootRecords = [];
  const rootIds = new Set();
  const acceptedParents = new Set();
  const depthById = new Map();

  const addSource = (path, rolloutId, stat) => {
    sourceByPath.set(resolve(path), {
      path: resolve(path),
      rolloutId,
      ...stat,
    });
  };

  const scanWithCache = (path, rolloutId, stat, role) => {
    const key = cacheKey(rolloutId, stat);
    const cached = inputCache[key];
    if (cached !== undefined) {
      if (validCachedSummary(cached, rolloutId)) {
        stats.cacheHits += 1;
        outputCache[key] = cached;
        return cached;
      }
      diagnostic("CACHE_INVALID");
    }
    if (live && stats.uncachedBytes + stat.size > limits.maxLiveUncachedBytes) {
      diagnostic("LIVE_BYTE_BUDGET_EXCEEDED");
      aborted = true;
      return null;
    }
    stats.uncachedBytes += stat.size;
    const parsed = parseRolloutStream(path, rolloutId, shouldContinue);
    if (!parsed.ok) {
      if (!aborted)
        diagnostic(
          role === "root" ? "PARENT_META_INVALID" : "CHILD_META_INVALID",
        );
      return null;
    }
    stats.parsedRollouts += 1;
    outputCache[key] = parsed.summary;
    if (parsed.summary.malformedLines > 0) {
      diagnostic(
        role === "root" ? "PARENT_META_INVALID" : "CHILD_META_INVALID",
      );
    }
    return parsed.summary;
  };

  if (shouldContinue("start")) {
    for (const path of roots) {
      if (!shouldContinue("root")) break;
      const stat = safeStat(path);
      const metaResult = readCodexRolloutMeta(path);
      if (!stat || !metaResult.ok || !metaResult.meta?.id) {
        diagnostic("PARENT_META_INVALID");
        continue;
      }
      const meta = metaResult.meta;
      const rolloutId = String(meta.id);
      addSource(path, rolloutId, stat);
      if (sourceSubagent(meta)) {
        diagnostic("PARENT_META_INVALID");
        continue;
      }
      if (rootIds.has(rolloutId)) {
        diagnostic("DUPLICATE_ROLLOUT_ID");
        continue;
      }
      if (rootIds.size >= limits.maxGraphNodes) {
        diagnostic("GRAPH_LIMIT_EXCEEDED");
        aborted = true;
        break;
      }
      rootIds.add(rolloutId);
      acceptedParents.add(rolloutId);
      depthById.set(rolloutId, 0);
      const summary = scanWithCache(path, rolloutId, stat, "root");
      rootRecords.push({ path, rolloutId, stat, meta, summary });
      for (const item of summary?.activities || []) enqueue(item);
    }
  }

  const normalizedSignals = (Array.isArray(signals) ? signals : [signals])
    .map(normalizeSignal)
    .filter(Boolean)
    .sort((left, right) =>
      `${left.timestamp}\u0000${left.parentRolloutId}\u0000${left.childId}\u0000${left.kind}`.localeCompare(
        `${right.timestamp}\u0000${right.parentRolloutId}\u0000${right.childId}\u0000${right.kind}`,
      ),
    );
  for (const item of normalizedSignals) enqueue(item);

  const directCandidates = (item) => {
    const candidates = new Set();
    if (item.transcriptPath && safeStat(item.transcriptPath))
      candidates.add(resolve(item.transcriptPath));
    if (
      item.agentPath &&
      item.agentPath.toLowerCase().endsWith(".jsonl") &&
      safeStat(item.agentPath)
    ) {
      candidates.add(resolve(item.agentPath));
    }
    const date = parseDateParts(item.timestamp);
    if (date) {
      for (const base of bases) {
        for (const path of listJsonl(dayDir(base, date))) {
          if (idMatchesFilename(path, item.childId))
            candidates.add(resolve(path));
        }
      }
    }
    return [...candidates].sort();
  };

  const fallbackCandidates = (item) => {
    if (!rootDates.length || !bases.length) return [];
    const start = new Date(
      Math.min(...rootDates.map((entry) => entry.date.getTime())),
    );
    const latestRoot = new Date(
      Math.max(...rootDates.map((entry) => entry.date.getTime())),
    );
    const hinted = parseDateParts(item.timestamp)?.date;
    const end = addDays(hinted && hinted > latestRoot ? hinted : latestRoot, 1);
    const span = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
    const daysToScan = Math.min(span, limits.maxFallbackDays);
    if (span > limits.maxFallbackDays) diagnostic("FALLBACK_LIMIT_EXCEEDED");
    const found = [];
    for (let offset = 0; offset < daysToScan; offset += 1) {
      if (!shouldContinue("fallback-day")) break;
      stats.fallbackDays += 1;
      const date = partsFromDate(addDays(start, offset));
      for (const base of bases) {
        for (const path of listJsonl(dayDir(base, date))) {
          const resolved = resolve(path);
          if (roots.includes(resolved)) continue;
          if (stats.fallbackCandidates >= limits.maxFallbackCandidates) {
            diagnostic("FALLBACK_LIMIT_EXCEEDED");
            return found;
          }
          stats.fallbackCandidates += 1;
          const metaResult = readCodexRolloutMeta(resolved);
          if (
            metaResult.ok &&
            String(metaResult.meta?.id || "") === item.childId
          )
            found.push(resolved);
        }
      }
    }
    return [...new Set(found)].sort();
  };

  const agents = [];
  const attempted = new Set();
  while (queue.length > 0 && !aborted) {
    if (!shouldContinue("node")) break;
    const item = queue.shift();
    if (
      rootIds.has(item.childId) ||
      acceptedParents.has(item.childId) ||
      attempted.has(item.childId)
    )
      continue;
    attempted.add(item.childId);
    let candidates = directCandidates(item);
    if (!candidates.length) candidates = fallbackCandidates(item);
    if (!candidates.length) {
      diagnostic("CHILD_MISSING");
      continue;
    }

    const valid = [];
    for (const path of candidates) {
      const stat = safeStat(path);
      const metaResult = readCodexRolloutMeta(path);
      if (
        !stat ||
        !metaResult.ok ||
        String(metaResult.meta?.id || "") !== item.childId
      ) {
        diagnostic("CHILD_META_INVALID");
        continue;
      }
      addSource(path, item.childId, stat);
      valid.push({ path, stat, meta: metaResult.meta });
    }
    if (!valid.length) continue;
    if (valid.length > 1) {
      const hashes = new Set(
        valid
          .map((candidate) => fileDigest(candidate.path, shouldContinue))
          .filter(Boolean),
      );
      if (hashes.size !== 1 || hashes.size === 0) {
        if (!aborted) diagnostic("DUPLICATE_ROLLOUT_ID");
        continue;
      }
    }
    const candidate = valid[0];
    const meta = candidate.meta;
    if (!sourceSubagent(meta)) {
      diagnostic("CHILD_META_INVALID");
      continue;
    }
    const parentId = immediateParent(meta);
    const sessionRoot = String(meta.session_id || "").trim();
    const compatibleRoots = new Set([
      String(canonicalSessionId || ""),
      ...rootIds,
    ]);
    if (sessionRoot && !compatibleRoots.has(sessionRoot)) {
      diagnostic("ROOT_MISMATCH");
      continue;
    }
    const effectiveParentId =
      item.parentRolloutId ||
      (item.source === "signal" && acceptedParents.has(parentId)
        ? parentId
        : "");
    if (
      !acceptedParents.has(effectiveParentId) ||
      parentId !== effectiveParentId
    ) {
      diagnostic(sessionRoot ? "ROOT_MISMATCH" : "LEGACY_CHAIN_UNPROVEN");
      continue;
    }
    if (!sessionRoot && (!parentId || !acceptedParents.has(parentId))) {
      diagnostic("LEGACY_CHAIN_UNPROVEN");
      continue;
    }
    if (rootIds.size + agents.length >= limits.maxGraphNodes) {
      diagnostic("GRAPH_LIMIT_EXCEEDED");
      aborted = true;
      break;
    }

    const summary = scanWithCache(
      candidate.path,
      item.childId,
      candidate.stat,
      "child",
    );
    if (!summary) continue;
    const depth = (depthById.get(parentId) || 0) + 1;
    const agent = makeAgent(meta, summary, statuses.get(item.childId), depth);
    agents.push(agent);
    acceptedParents.add(item.childId);
    depthById.set(item.childId, agent.depth);
    for (const activityItem of summary.activities) enqueue(activityItem);
  }

  agents.sort((left, right) => left.id.localeCompare(right.id));
  const aggregate = aggregateAgents(agents);
  if (!aborted && sourceByPath.size > 0 && shouldContinue("before-recheck")) {
    for (const source of sourceByPath.values()) {
      const current = safeStat(source.path);
      if (!sameStat(current, source)) diagnostic("SOURCE_CHANGED_DURING_SCAN");
    }
  }

  const rootStats = rootRecords
    .map((record) => ({
      rolloutId: record.rolloutId,
      size: record.stat.size,
      mtimeMs: record.stat.mtimeMs,
    }))
    .sort((left, right) => left.rolloutId.localeCompare(right.rolloutId));
  const sourceManifest = [...sourceByPath.values()].sort((left, right) =>
    `${left.rolloutId}\u0000${left.path}`.localeCompare(
      `${right.rolloutId}\u0000${right.path}`,
    ),
  );
  const sourceHashInput = sourceManifest
    .map((source) => ({
      rolloutId: source.rolloutId,
      size: source.size,
      mtimeMs: source.mtimeMs,
    }))
    .sort((left, right) =>
      `${left.rolloutId}\u0000${left.size}\u0000${left.mtimeMs}`.localeCompare(
        `${right.rolloutId}\u0000${right.size}\u0000${right.mtimeMs}`,
      ),
    );
  const diagnostics = DIAGNOSTIC_ORDER.filter((code) =>
    diagnosticCounts.has(code),
  ).map((code) => ({ code, count: diagnosticCounts.get(code) }));
  const state =
    diagnostics.length > 0
      ? "degraded"
      : agents.length > 0
        ? "complete"
        : "none";

  return {
    state,
    frontier: {
      rootsStatHash: stableHash(rootStats),
      graphCursor: stableHash([...graphEvidence].sort()),
      sourceManifestHash: stableHash(sourceHashInput),
    },
    subagents: agents,
    descendantIds: agents.map((agent) => agent.id),
    workflows: [],
    aggregate,
    diagnostics,
    sourceManifest,
    cache: { version: CACHE_VERSION, entries: outputCache },
    stats,
  };
}
