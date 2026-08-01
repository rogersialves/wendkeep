// [req:OBS-3] [req:OBS-12]
// Synthetic Codex graph fixtures only. No consumer transcript, identifier, path or prompt
// belongs in this suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CODEX_SUBAGENT_GRAPH_LIMITS,
  composeCodexSubagentGraph,
} from "../hooks/codex-subagent-graph.mjs";

const ROOT = "root-alpha";
const CHILD_A = "child-alpha";
const CHILD_B = "child-beta";

function sandbox(t) {
  const path = mkdtempSync(join(tmpdir(), "wk-codex-graph-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function sessionMeta(
  id,
  { sessionId, parentId, depth = 1, nickname = "Synthetic Agent" } = {},
) {
  const payload = {
    id,
    timestamp: "2026-01-01T10:00:00.000Z",
    cwd: "C:\\synthetic-project",
    model_provider: "openai",
  };
  if (sessionId !== undefined) payload.session_id = sessionId;
  if (parentId !== undefined) {
    payload.parent_thread_id = parentId;
    payload.source = {
      subagent: {
        thread_spawn: {
          parent_thread_id: parentId,
          depth,
          agent_nickname: nickname,
        },
      },
    };
  }
  return { type: "session_meta", timestamp: payload.timestamp, payload };
}

function activity(
  childId,
  {
    kind = "started",
    timestamp = "2026-01-02T11:00:00.000Z",
    agentPath = `/root/${childId}`,
  } = {},
) {
  const event = {
    type: "event_msg",
    payload: {
      type: "sub_agent_activity",
      kind,
      agent_thread_id: childId,
      agent_path: agentPath,
    },
  };
  if (timestamp !== null) event.timestamp = timestamp;
  return event;
}

function usage({ model = "gpt-5.6-terra", input = 100, output = 20 } = {}) {
  return {
    type: "event_msg",
    timestamp: "2026-01-02T11:01:00.000Z",
    payload: {
      type: "token_count",
      info: {
        model,
        model_provider: "openai",
        last_token_usage: {
          input_tokens: input,
          output_tokens: output,
        },
      },
    },
  };
}

function toolCall(name = "synthetic_tool") {
  return {
    type: "response_item",
    timestamp: "2026-01-02T11:00:30.000Z",
    payload: { type: "function_call", name, arguments: "{}" },
  };
}

function writeRollout(base, day, id, events, { suffix = id } = {}) {
  const dir = join(base, "sessions", "2026", "01", day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-01-${day}T10-00-00-${suffix}.jsonl`);
  writeFileSync(
    path,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  return path;
}

function growPastFourMiB(path) {
  const filler = `${JSON.stringify({ type: "event_msg", payload: { type: "synthetic_noop" } })}\n`;
  const repetitions = Math.ceil(
    (4 * 1024 * 1024 + 1024) / Buffer.byteLength(filler),
  );
  appendFileSync(path, filler.repeat(repetitions), "utf8");
}

function diagnosticCodes(result) {
  return result.diagnostics.map((item) => item.code);
}

test("OBS-3: D+3 discovery follows started only and does not depend on total file size", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [
    sessionMeta(ROOT),
    activity(CHILD_A, { timestamp: "2026-01-04T11:00:00.000Z" }),
    toolCall("spawn_agent"), // A tool call alone is not evidence that another agent started.
  ]);
  const childPath = writeRollout(base, "04", CHILD_A, [
    sessionMeta(CHILD_A, { sessionId: ROOT, parentId: ROOT }),
    toolCall(),
    usage({ input: 400, output: 50 }),
  ]);
  growPastFourMiB(rootPath);
  growPastFourMiB(childPath);

  const result = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    mode: "offline",
  });

  assert.equal(result.state, "complete");
  assert.deepEqual(
    result.subagents.map((agent) => agent.id),
    [CHILD_A],
  );
  assert.equal(result.aggregate.count, 1);
  assert.equal(result.aggregate.calls, 1);
  assert.equal(result.aggregate.tokens, 450);
  assert.equal(result.subagents[0].tools, 1);
});

test("OBS-3: depth 2, A-B-A replay and duplicate signals produce each child once", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [
    sessionMeta(ROOT),
    activity(CHILD_A),
    activity(CHILD_A),
    activity(CHILD_A, { kind: "interacted" }),
  ]);
  const childAPath = writeRollout(base, "02", CHILD_A, [
    sessionMeta(CHILD_A, { sessionId: ROOT, parentId: ROOT, depth: 1 }),
    activity(CHILD_B, { timestamp: "2026-01-03T11:00:00.000Z" }),
    activity(CHILD_B, { timestamp: "2026-01-03T11:00:00.000Z" }),
    activity(CHILD_B, {
      kind: "interrupted",
      timestamp: "2026-01-03T11:02:00.000Z",
    }),
    usage({ input: 100, output: 10 }),
  ]);
  writeRollout(base, "03", CHILD_B, [
    sessionMeta(CHILD_B, { sessionId: ROOT, parentId: CHILD_A, depth: 2 }),
    activity(CHILD_A, { timestamp: "2026-01-02T11:00:00.000Z" }),
  ]);

  const repeatedSignal = {
    kind: "started",
    rolloutId: CHILD_A,
    parentRolloutId: ROOT,
    timestamp: "2026-01-02T11:00:00.000Z",
    transcriptPath: childAPath,
  };
  const result = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    signals: [repeatedSignal, { ...repeatedSignal }],
    mode: "offline",
  });

  assert.equal(result.state, "complete");
  assert.deepEqual(
    result.subagents.map((agent) => agent.id),
    [CHILD_A, CHILD_B],
  );
  assert.equal(result.aggregate.count, 2);
  assert.equal(new Set(result.subagents.map((agent) => agent.id)).size, 2);
  assert.equal(
    result.subagents.find((agent) => agent.id === CHILD_A).status,
    "interacted",
  );
  const zeroUsage = result.subagents.find((agent) => agent.id === CHILD_B);
  assert.equal(zeroUsage.status, "interrupted");
  assert.equal(zeroUsage.model, "unknown");
  assert.equal(zeroUsage.calls, 0);
  assert.equal(zeroUsage.tokens, 0);
  assert.equal(zeroUsage.cost, 0);
});

test("OBS-11/OBS-12: a signal-only child is accepted before started reaches the root transcript", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [sessionMeta(ROOT)]);
  const childPath = writeRollout(base, "02", CHILD_A, [
    sessionMeta(CHILD_A, { sessionId: ROOT, parentId: ROOT }),
    usage({ input: 25, output: 5 }),
  ]);

  const result = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    signals: [
      {
        rollout_id: CHILD_A,
        transcript_path: childPath,
        kind: "started",
        timestamp: "2026-01-02T11:00:00.000Z",
        agent_path: `/root/${CHILD_A}`,
      },
    ],
    mode: "offline",
  });

  assert.equal(result.state, "complete");
  assert.deepEqual(
    result.subagents.map((agent) => agent.id),
    [CHILD_A],
  );
  assert.equal(result.aggregate.tokens, 30);
  assert.deepEqual(result.diagnostics, []);
});

test("OBS-11/OBS-12: signal-only parent derivation does not admit another canonical root", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [sessionMeta(ROOT)]);
  const childPath = writeRollout(base, "02", CHILD_A, [
    sessionMeta(CHILD_A, { sessionId: "foreign-root", parentId: ROOT }),
    usage(),
  ]);

  const result = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    signals: [
      { rollout_id: CHILD_A, transcript_path: childPath, kind: "started" },
    ],
    mode: "offline",
  });

  assert.equal(result.state, "degraded");
  assert.equal(result.aggregate.count, 0);
  assert.deepEqual(diagnosticCodes(result), ["ROOT_MISMATCH"]);
});

test("OBS-11/OBS-12: an explicit mismatched signal parent is not replaced from child metadata", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [sessionMeta(ROOT)]);
  const otherRootPath = writeRollout(base, "01", "root-beta", [
    sessionMeta("root-beta"),
  ]);
  const childPath = writeRollout(base, "02", CHILD_A, [
    sessionMeta(CHILD_A, { sessionId: ROOT, parentId: ROOT }),
    usage(),
  ]);

  const result = composeCodexSubagentGraph({
    rootPaths: [rootPath, otherRootPath],
    canonicalSessionId: ROOT,
    signals: [
      {
        rollout_id: CHILD_A,
        transcript_path: childPath,
        parent_thread_id: "root-beta",
        kind: "started",
      },
    ],
    mode: "offline",
  });

  assert.equal(result.state, "degraded");
  assert.equal(result.aggregate.count, 0);
  assert.deepEqual(diagnosticCodes(result), ["ROOT_MISMATCH"]);
});

test("OBS-3/OBS-12: a modern child from another canonical root is excluded and degraded", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [
    sessionMeta(ROOT),
    activity(CHILD_A),
  ]);
  writeRollout(base, "02", CHILD_A, [
    sessionMeta(CHILD_A, { sessionId: "foreign-root", parentId: ROOT }),
    usage(),
  ]);

  const result = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    mode: "offline",
  });

  assert.equal(result.state, "degraded");
  assert.equal(result.aggregate.count, 0);
  assert.deepEqual(diagnosticCodes(result), ["ROOT_MISMATCH"]);
});

test("OBS-3/OBS-12: a complete legacy parent chain is accepted", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [
    sessionMeta(ROOT),
    activity(CHILD_A),
  ]);
  writeRollout(base, "02", CHILD_A, [
    sessionMeta(CHILD_A, { parentId: ROOT }),
    activity(CHILD_B, { timestamp: "2026-01-03T11:00:00.000Z" }),
    usage(),
  ]);
  writeRollout(base, "03", CHILD_B, [
    sessionMeta(CHILD_B, { parentId: CHILD_A, depth: 2 }),
  ]);

  const result = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    mode: "offline",
  });

  assert.equal(result.state, "complete");
  assert.deepEqual(
    result.subagents.map((agent) => agent.id),
    [CHILD_A, CHILD_B],
  );
});

test("OBS-3/OBS-12: an unproven legacy signal never becomes none", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [sessionMeta(ROOT)]);
  const orphanPath = writeRollout(base, "02", CHILD_A, [
    sessionMeta(CHILD_A, { parentId: "missing-parent" }),
  ]);

  const result = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    signals: [
      {
        kind: "started",
        rolloutId: CHILD_A,
        parentRolloutId: "missing-parent",
        timestamp: "2026-01-02T11:00:00.000Z",
        transcriptPath: orphanPath,
      },
    ],
    mode: "offline",
  });

  assert.equal(result.state, "degraded");
  assert.equal(result.aggregate.count, 0);
  assert.ok(diagnosticCodes(result).includes("LEGACY_CHAIN_UNPROVEN"));
});

test("OBS-3/OBS-12: divergent files claiming one rollout id are not double-counted", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [
    sessionMeta(ROOT),
    activity(CHILD_A),
  ]);
  writeRollout(
    base,
    "02",
    CHILD_A,
    [
      sessionMeta(CHILD_A, { sessionId: ROOT, parentId: ROOT }),
      usage({ input: 100 }),
    ],
    { suffix: `copy-${CHILD_A}` },
  );
  writeRollout(base, "02", CHILD_A, [
    sessionMeta(CHILD_A, { sessionId: ROOT, parentId: ROOT }),
    usage({ input: 999 }),
  ]);

  const result = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    mode: "offline",
  });

  assert.equal(result.state, "degraded");
  assert.equal(result.aggregate.count, 0);
  assert.ok(diagnosticCodes(result).includes("DUPLICATE_ROLLOUT_ID"));
});

test("OBS-3/OBS-12: immutable second composition is a zero-parse cache hit", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [
    sessionMeta(ROOT),
    activity(CHILD_A),
  ]);
  const childPath = writeRollout(base, "02", CHILD_A, [
    sessionMeta(CHILD_A, { sessionId: ROOT, parentId: ROOT }),
    usage({ input: 100, output: 10 }),
  ]);

  const first = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    mode: "offline",
  });
  const second = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    cache: first.cache,
    mode: "offline",
  });

  assert.equal(first.stats.parsedRollouts, 2);
  assert.equal(second.stats.parsedRollouts, 0);
  assert.equal(second.stats.cacheHits, 2);
  assert.deepEqual(second.aggregate, first.aggregate);
  assert.equal(second.frontier.graphCursor, first.frontier.graphCursor);
  assert.equal(
    second.frontier.sourceManifestHash,
    first.frontier.sourceManifestHash,
  );

  appendFileSync(
    childPath,
    `${JSON.stringify(usage({ input: 300, output: 30 }))}\n`,
    "utf8",
  );
  const changed = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    cache: second.cache,
    mode: "offline",
  });
  assert.equal(changed.stats.parsedRollouts, 1);
  assert.equal(changed.stats.cacheHits, 1);
  assert.ok(changed.aggregate.tokens > second.aggregate.tokens);
});

test("OBS-12: source mutation at manifest recheck degrades instead of publishing a partial snapshot", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [
    sessionMeta(ROOT),
    activity(CHILD_A),
  ]);
  const childPath = writeRollout(base, "02", CHILD_A, [
    sessionMeta(CHILD_A, { sessionId: ROOT, parentId: ROOT }),
    usage(),
  ]);
  let mutated = false;
  const now = (phase) => {
    if (phase === "before-recheck" && !mutated) {
      mutated = true;
      appendFileSync(
        childPath,
        `${JSON.stringify({ type: "event_msg", payload: { type: "late_write" } })}\n`,
        "utf8",
      );
    }
    return 0;
  };

  const result = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    mode: "live",
    deadlineAt: 1_000,
    now,
  });

  assert.equal(result.state, "degraded");
  assert.ok(diagnosticCodes(result).includes("SOURCE_CHANGED_DURING_SCAN"));
});

test("OBS-12: a corrupt cache is discarded, rebuilt and reported as degraded", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [
    sessionMeta(ROOT),
    activity(CHILD_A),
  ]);
  writeRollout(base, "02", CHILD_A, [
    sessionMeta(CHILD_A, { sessionId: ROOT, parentId: ROOT }),
    usage(),
  ]);

  const result = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    cache: { version: 999, entries: [] },
    mode: "offline",
  });

  assert.equal(result.state, "degraded");
  assert.equal(
    result.aggregate.count,
    1,
    "transcripts rebuild the derived cache",
  );
  assert.ok(diagnosticCodes(result).includes("CACHE_INVALID"));
  assert.equal(result.stats.parsedRollouts, 2);
});

test("OBS-12: hashes are independent of root input order", (t) => {
  const base = sandbox(t);
  const rootAPath = writeRollout(base, "01", ROOT, [
    sessionMeta(ROOT),
    activity(CHILD_A),
  ]);
  const rootBPath = writeRollout(base, "01", "root-beta", [
    sessionMeta("root-beta"),
  ]);
  writeRollout(base, "02", CHILD_A, [
    sessionMeta(CHILD_A, { sessionId: ROOT, parentId: ROOT }),
    usage(),
  ]);

  const left = composeCodexSubagentGraph({
    rootPaths: [rootAPath, rootBPath],
    canonicalSessionId: ROOT,
    mode: "offline",
  });
  const right = composeCodexSubagentGraph({
    rootPaths: [rootBPath, rootAPath],
    canonicalSessionId: ROOT,
    mode: "offline",
  });

  assert.deepEqual(right.aggregate, left.aggregate);
  assert.deepEqual(right.subagents, left.subagents);
  assert.deepEqual(right.frontier, left.frontier);
});

test("OBS-12: structural, fallback, byte and deadline limits are explicit and discriminating", (t) => {
  assert.deepEqual(CODEX_SUBAGENT_GRAPH_LIMITS, {
    maxGraphNodes: 4096,
    maxFallbackDays: 31,
    maxFallbackCandidates: 20_000,
    maxLiveUncachedBytes: 512 * 1024 * 1024,
  });

  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [
    sessionMeta(ROOT),
    activity(CHILD_A),
    activity(CHILD_B, { timestamp: "2026-01-03T11:00:00.000Z" }),
  ]);
  writeRollout(base, "02", CHILD_A, [
    sessionMeta(CHILD_A, { sessionId: ROOT, parentId: ROOT }),
  ]);
  writeRollout(base, "03", CHILD_B, [
    sessionMeta(CHILD_B, { sessionId: ROOT, parentId: ROOT }),
  ]);

  const graphLimited = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    mode: "offline",
    limits: { maxGraphNodes: 1 },
  });
  assert.equal(graphLimited.state, "degraded");
  assert.ok(diagnosticCodes(graphLimited).includes("GRAPH_LIMIT_EXCEEDED"));

  const byteLimited = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    mode: "live",
    deadlineAt: 1_000,
    now: () => 0,
    limits: { maxLiveUncachedBytes: 1 },
  });
  assert.equal(byteLimited.state, "degraded");
  assert.ok(diagnosticCodes(byteLimited).includes("LIVE_BYTE_BUDGET_EXCEEDED"));

  const deadlineLimited = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    mode: "live",
    deadlineAt: 45_000,
    now: () => 45_000,
  });
  assert.equal(deadlineLimited.state, "degraded");
  assert.deepEqual(diagnosticCodes(deadlineLimited), [
    "LIVE_DEADLINE_EXCEEDED",
  ]);

  const offline = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    mode: "offline",
    deadlineAt: 0,
    now: () => Number.MAX_SAFE_INTEGER,
    limits: { maxLiveUncachedBytes: 1 },
  });
  assert.equal(offline.state, "complete");
  assert.equal(offline.aggregate.count, 2);
});

test("[req:OBS-12] live deadline is checked between transcript chunks", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [sessionMeta(ROOT)]);
  const filler = `${JSON.stringify({ type: "event_msg", payload: { type: "synthetic_noop" } })}\n`;
  appendFileSync(rootPath, filler.repeat(Math.ceil((128 * 1024) / Buffer.byteLength(filler))), "utf8");
  let chunks = 0;

  const result = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    mode: "live",
    deadlineAt: 100,
    now: (phase) => (phase === "chunk" && ++chunks === 2 ? 100 : 0),
  });

  assert.equal(chunks, 2);
  assert.equal(result.state, "degraded");
  assert.deepEqual(diagnosticCodes(result), ["LIVE_DEADLINE_EXCEEDED"]);
});

test("[req:OBS-12] live deadline is checked between descendant rollouts", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [
    sessionMeta(ROOT),
    activity(CHILD_A),
    activity(CHILD_B, { timestamp: "2026-01-03T11:00:00.000Z" }),
  ]);
  writeRollout(base, "02", CHILD_A, [
    sessionMeta(CHILD_A, { sessionId: ROOT, parentId: ROOT }),
    usage(),
  ]);
  writeRollout(base, "03", CHILD_B, [
    sessionMeta(CHILD_B, { sessionId: ROOT, parentId: ROOT }),
    usage(),
  ]);
  let rollouts = 0;

  const result = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    mode: "live",
    deadlineAt: 100,
    now: (phase) => (phase === "node" && ++rollouts === 2 ? 100 : 0),
  });

  assert.equal(rollouts, 2);
  assert.equal(result.state, "degraded");
  assert.equal(result.aggregate.count, 1, "the first rollout completed before cancellation");
  assert.deepEqual(diagnosticCodes(result), ["LIVE_DEADLINE_EXCEEDED"]);
});

test("OBS-12: fallback day and candidate caps degrade a missing direct lookup", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [
    sessionMeta(ROOT),
    activity(CHILD_A, { timestamp: null }),
  ]);
  writeRollout(base, "01", "unrelated", [sessionMeta("unrelated")]);
  writeRollout(base, "02", CHILD_A, [
    sessionMeta(CHILD_A, { sessionId: ROOT, parentId: ROOT }),
  ]);

  const days = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    mode: "offline",
    limits: { maxFallbackDays: 1 },
  });
  assert.equal(days.state, "degraded");
  assert.ok(diagnosticCodes(days).includes("FALLBACK_LIMIT_EXCEEDED"));

  const candidates = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    mode: "offline",
    limits: { maxFallbackDays: 2, maxFallbackCandidates: 1 },
  });
  assert.equal(candidates.state, "degraded");
  assert.ok(diagnosticCodes(candidates).includes("FALLBACK_LIMIT_EXCEEDED"));
});

test("OBS-12: a stable scan with no started agents is none, not degraded", (t) => {
  const base = sandbox(t);
  const rootPath = writeRollout(base, "01", ROOT, [
    sessionMeta(ROOT),
    toolCall("spawn_agent"),
  ]);
  const result = composeCodexSubagentGraph({
    rootPaths: [rootPath],
    canonicalSessionId: ROOT,
    mode: "offline",
  });
  assert.equal(result.state, "none");
  assert.equal(result.aggregate.count, 0);
  assert.deepEqual(result.diagnostics, []);
});

test("OBS-12: absence of every registered root is degraded, never none", () => {
  const result = composeCodexSubagentGraph({
    rootPaths: [],
    canonicalSessionId: ROOT,
    mode: "offline",
  });
  assert.equal(result.state, "degraded");
  assert.deepEqual(diagnosticCodes(result), ["PARENT_META_INVALID"]);
});
