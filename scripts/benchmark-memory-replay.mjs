import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import {
  MEMORY_SNAPSHOT_FILE,
  canonicalMemoryJson,
  readMemoryProjectionSnapshot,
  reprojectMemoryLedger,
} from '../hooks/memory-store.mjs';

export const DEFAULT_SCALE_EVENTS = 100_000;
export const SCALE_MEMORY_KEY = 'next.scale-benchmark';

function normalizeEventCount(value, fallback = DEFAULT_SCALE_EVENTS) {
  const count = Number(value ?? fallback);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) {
    throw new RangeError('benchmark events must be an integer between 1 and 1000000');
  }
  return count;
}

function observedAt(index) {
  return new Date(Date.UTC(2026, 7, 26, 0, 0, 0, index)).toISOString();
}

export function createSyntheticMemoryEvents(count, {
  projectId = 'benchmark-memory-replay',
  startIndex = 0,
} = {}) {
  const eventCount = normalizeEventCount(count);
  if (!Number.isSafeInteger(startIndex) || startIndex < 0
      || startIndex + eventCount > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('benchmark startIndex must define a safe non-negative range');
  }

  const events = new Array(eventCount);
  for (let offset = 0; offset < eventCount; offset += 1) {
    const index = startIndex + offset;
    const suffix = String(index).padStart(7, '0');
    events[offset] = {
      v: 1,
      project_id: projectId,
      event_id: `mem-scale-${suffix}`,
      memory_key: SCALE_MEMORY_KEY,
      operation: 'assert',
      value: `scale-value-${suffix}`,
      authority: 'verified',
      canonical_session_id: 'session-memory-scale',
      activation_id: 'activation-memory-scale',
      activation_epoch: 1,
      turn_sequence: index + 1,
      source_turn_id: `turn-memory-scale-${suffix}`,
      observed_at: observedAt(index),
      evidence: ['memory-scale-benchmark'],
    };
  }
  return events;
}

function createBenchmarkVault(projectId) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-scale-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  writeFileSync(
    join(vault, '.brain', 'PROJECT.json'),
    `${JSON.stringify({ projectId }, null, 2)}\n`,
  );
  return vault;
}

function ledgerPath(vault) {
  return join(vault, '.brain', 'MEMORY_EVENTS.jsonl');
}

function writeLedger(vault, events) {
  const content = `${events.map((event) => canonicalMemoryJson(event)).join('\n')}\n`;
  writeFileSync(ledgerPath(vault), content);
  return Buffer.byteLength(content, 'utf8');
}

function appendLedgerEvent(vault, event) {
  const content = `${canonicalMemoryJson(event)}\n`;
  appendFileSync(ledgerPath(vault), content);
  return Buffer.byteLength(content, 'utf8');
}

function fileBytes(path) {
  return Number(statSync(path).size);
}

function elapsed(startedAt) {
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

export function runMemoryReplayScaleBenchmark({
  events: requestedEvents = DEFAULT_SCALE_EVENTS,
  keepVault = false,
} = {}) {
  const eventCount = normalizeEventCount(requestedEvents);
  const projectId = `benchmark-memory-replay-${eventCount}`;
  const vault = createBenchmarkVault(projectId);
  const rssBefore = process.memoryUsage().rss;

  try {
    const generationStarted = performance.now();
    const events = createSyntheticMemoryEvents(eventCount, { projectId });
    const generationMs = elapsed(generationStarted);
    const initialLedgerBytes = writeLedger(vault, events);

    const fullStarted = performance.now();
    const full = reprojectMemoryLedger(vault, { snapshot: { force: true } });
    const fullReplayMs = elapsed(fullStarted);

    const warmStarted = performance.now();
    const warm = reprojectMemoryLedger(vault);
    const warmReplayMs = elapsed(warmStarted);

    const tailEvent = createSyntheticMemoryEvents(1, {
      projectId,
      startIndex: eventCount,
    })[0];
    const tailBytes = appendLedgerEvent(vault, tailEvent);

    const tailStarted = performance.now();
    const tail = reprojectMemoryLedger(vault);
    const tailReplayMs = elapsed(tailStarted);

    const advanceStarted = performance.now();
    const advanced = reprojectMemoryLedger(vault, { snapshot: { force: true } });
    const snapshotAdvanceMs = elapsed(advanceStarted);

    const finalWarmStarted = performance.now();
    const finalWarm = reprojectMemoryLedger(vault);
    const finalWarmMs = elapsed(finalWarmStarted);

    const snapshot = readMemoryProjectionSnapshot(vault);
    const snapshotFile = join(vault, '.brain', MEMORY_SNAPSHOT_FILE);
    const sharedFile = join(vault, '.brain', 'SHARED_MEMORY.md');
    const result = {
      schema_version: 1,
      events: eventCount,
      timings_ms: {
        generation: generationMs,
        full_replay: fullReplayMs,
        warm_replay: warmReplayMs,
        one_event_tail_replay: tailReplayMs,
        snapshot_advance: snapshotAdvanceMs,
        final_warm_replay: finalWarmMs,
      },
      bytes: {
        initial_ledger: initialLedgerBytes,
        appended_tail: tailBytes,
        active_ledger: fileBytes(ledgerPath(vault)),
        snapshot: fileBytes(snapshotFile),
        shared_projection: fileBytes(sharedFile),
      },
      memory: {
        rss_before: rssBefore,
        rss_after: process.memoryUsage().rss,
      },
      full: {
        status: full.status,
        replay_mode: full.replayMode,
        replayed_events: full.replayedEvents,
        snapshot_status: full.snapshotStatus,
        snapshot_fallback: full.snapshotFallback,
        state_hash: full.stateHash,
      },
      warm: {
        status: warm.status,
        replay_mode: warm.replayMode,
        replayed_events: warm.replayedEvents,
        snapshot_status: warm.snapshotStatus,
        state_hash: warm.stateHash,
      },
      tail: {
        status: tail.status,
        replay_mode: tail.replayMode,
        replayed_events: tail.replayedEvents,
        snapshot_status: tail.snapshotStatus,
        state_hash: tail.stateHash,
      },
      advanced: {
        status: advanced.status,
        replay_mode: advanced.replayMode,
        replayed_events: advanced.replayedEvents,
        snapshot_status: advanced.snapshotStatus,
        snapshot_event_count: advanced.snapshotEventCount,
        state_hash: advanced.stateHash,
      },
      final_warm: {
        status: finalWarm.status,
        replay_mode: finalWarm.replayMode,
        replayed_events: finalWarm.replayedEvents,
        snapshot_status: finalWarm.snapshotStatus,
        state_hash: finalWarm.stateHash,
      },
      snapshot: {
        status: snapshot.status,
        event_count: snapshot.snapshot?.event_count ?? null,
        tail_events: snapshot.tail?.events?.length ?? null,
        through_event_id: snapshot.snapshot?.through_event_id || '',
      },
      contracts: {
        full_replay_complete: full.replayMode === 'full'
          && full.replayedEvents === eventCount,
        warm_replay_zero: warm.replayMode === 'snapshot-tail'
          && warm.replayedEvents === 0,
        one_event_tail_only: tail.replayMode === 'snapshot-tail'
          && tail.replayedEvents === 1,
        snapshot_advanced: advanced.snapshotStatus === 'written'
          && advanced.snapshotEventCount === eventCount + 1,
        final_warm_replay_zero: finalWarm.replayMode === 'snapshot-tail'
          && finalWarm.replayedEvents === 0,
        projection_stable: full.stateHash === warm.stateHash
          && tail.stateHash === advanced.stateHash
          && advanced.stateHash === finalWarm.stateHash,
      },
      ...(keepVault ? { vault } : {}),
    };
    result.memory.rss_delta = result.memory.rss_after - result.memory.rss_before;
    return result;
  } finally {
    if (!keepVault) rmSync(vault, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new TypeError(`missing value for ${arg}`);
      return argv[index];
    };
    if (arg === '--events') options.events = next();
    else if (arg === '--keep-vault') options.keepVault = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new TypeError(`unknown benchmark option: ${arg}`);
  }
  return options;
}

const HELP = `Memory replay scale benchmark\n\nUsage:\n  node scripts/benchmark-memory-replay.mjs [options]\n\nOptions:\n  --events <n>    Synthetic ledger events (default: ${DEFAULT_SCALE_EVENTS})\n  --keep-vault    Preserve the generated temporary Vault\n  --help          Show this help\n`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(HELP);
    else process.stdout.write(`${JSON.stringify(runMemoryReplayScaleBenchmark(options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 2;
  }
}
