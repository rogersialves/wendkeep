import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkSessionObservability,
  renderSessionObservabilityLines,
} from '../hooks/harness-doctor.mjs';
import { renderObservabilityCheckpointLines } from '../hooks/session-observability-state.mjs';
import {
  markObservabilityCheckpoint,
  observabilityStorePath,
  recordObservabilitySignal,
} from '../hooks/session-observability-store.mjs';

const SESSION_ID = 'synthetic-session';
const stableHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture({ state = 'none', diagnostics = [], legacy = false, withManifest = true } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-doctor-observe-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  mkdirSync(join(vault, 'sessions'), { recursive: true });
  const source = join(vault, 'synthetic-rollout.jsonl');
  const note = join(vault, 'sessions', 'synthetic.md');
  writeFileSync(source, '{"type":"synthetic"}\n');
  const sourceStat = statSync(source);
  const manifest = [{
    path: source,
    rolloutId: 'synthetic-rollout',
    size: sourceStat.size,
    mtimeMs: sourceStat.mtimeMs,
  }];
  const hashInput = manifest.map(({ rolloutId, size, mtimeMs }) => ({ rolloutId, size, mtimeMs }));
  const frontier = {
    canonical_session_id: SESSION_ID,
    activation_id: 'synthetic-activation',
    activation_epoch: 1,
    turn_sequence: 1,
    signal_sequence: 0,
    roots_stat_hash: 'synthetic-roots',
    graph_cursor: 'synthetic-graph',
    source_manifest_hash: stableHash(hashInput),
  };
  const checkpointLines = legacy
    ? 'observability_schema: 1\nsubagents_observability_state: none'
    : renderObservabilityCheckpointLines(frontier, { state, diagnostics });
  writeFileSync(note, `---\ntype: session\nprovider: codex\n${checkpointLines}\n---\n\n# Synthetic\n`);
  markObservabilityCheckpoint(vault, SESSION_ID, {
    checkpointSequence: 0,
    frontier,
    ...(withManifest ? { sourceManifest: manifest } : {}),
    diagnostics,
  });
  const registry = {
    version: 2,
    sessions: {
      [SESSION_ID]: {
        provider: 'codex',
        session_file: 'sessions/synthetic.md',
        transcript_path: source,
      },
    },
  };
  const registryFile = join(vault, '.brain', 'SESSION_REGISTRY.json');
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  return {
    vault,
    note,
    source,
    frontier,
    registry,
    registryFile,
    store: observabilityStorePath(vault, SESSION_ID),
  };
}

function check(fx, deps = {}) {
  return checkSessionObservability(fx.vault, deps);
}

function snapshot(paths) {
  return paths.map((path) => ({
    path,
    bytes: readFileSync(path),
    mtimeMs: statSync(path).mtimeMs,
  }));
}

function assertSnapshotUnchanged(before) {
  for (const item of before) {
    assert.deepEqual(readFileSync(item.path), item.bytes, item.path);
    assert.equal(statSync(item.path).mtimeMs, item.mtimeMs, item.path);
  }
}

test('[req:DIAG-9] fresh none and complete are healthy and byte-for-byte read-only', () => {
  const fixtures = [fixture(), fixture({ state: 'complete' })];
  try {
    for (const fx of fixtures) {
      const before = snapshot([fx.note, fx.source, fx.store, fx.registryFile]);
      const result = check(fx);
      assert.equal(result.ok, true, fx.note);
      assert.equal(result.healthy, 1, fx.note);
      assert.deepEqual(result.issues, [], fx.note);
      assertSnapshotUnchanged(before);
    }
  } finally {
    for (const fx of fixtures) rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:DIAG-9] every repairable state is distinguished without changing any source', () => {
  const signal = fixture();
  recordObservabilitySignal(signal.vault, SESSION_ID, {
    rollout_id: 'wk-fixture-signal-child',
    kind: 'started',
  });
  const roots = fixture();
  markObservabilityCheckpoint(roots.vault, SESSION_ID, {
    checkpointSequence: 0,
    frontier: { ...roots.frontier, roots_stat_hash: 'synthetic-roots-new' },
  });
  const fixtures = [
    [fixture({ legacy: true }), 'legacy'],
    [fixture({ state: 'degraded', diagnostics: [{ code: 'CHILD_MISSING', count: 1 }] }), 'degraded'],
    [fixture({ withManifest: false }), 'manifest-unproven'],
    [fixture(), 'stale'],
    [signal, 'stale'],
    [roots, 'stale'],
  ];
  try {
    writeFileSync(fixtures[3][0].source, '{"type":"synthetic-mutated"}\n');
    for (const [fx, expected] of fixtures) {
      const before = snapshot([fx.note, fx.source, fx.store, fx.registryFile]);
      const result = check(fx);
      assert.equal(result.ok, false, expected);
      assert.equal(result.issues[0].status, expected);
      assert.match(
        result.issues[0].command,
        /^npx --no-install wendkeep cost rebuild --session "synthetic-session" --json --vault ".+"$/,
      );
      assert.ok(result.issues[0].command.endsWith(`--vault "${fx.vault}"`));
      assertSnapshotUnchanged(before);
    }
    assert.deepEqual(fixtures[1][0] && check(fixtures[1][0]).issues[0].diagnostics, [
      { code: 'CHILD_MISSING', count: 1 },
    ]);
  } finally {
    for (const [fx] of fixtures) rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:DIAG-9] doctor reads the note but only stats transcript manifest entries', () => {
  const fx = fixture({ state: 'complete' });
  const fullReads = [];
  const stats = [];
  try {
    const result = check(fx, {
      readNote(path) {
        fullReads.push(path);
        if (path !== fx.note) throw new Error('transcript content must not be read');
        return readFileSync(path, 'utf8');
      },
      statSource(path) {
        stats.push(path);
        return statSync(path);
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(fullReads, [fx.note]);
    assert.deepEqual(stats, [fx.source]);
  } finally {
    rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:DIAG-9] renderer recommends dry-run before apply', () => {
  const fx = fixture({ legacy: true });
  try {
    const lines = renderSessionObservabilityLines(check(fx));
    const text = lines.join('\n');
    assert.ok(text.indexOf('--json') < text.indexOf('--apply'));
    assert.match(text, /npx --no-install wendkeep cost rebuild --session "synthetic-session" --json --vault ".+"/);
    assert.match(text, /--vault ".+" --apply/);
    assert.match(text, /^\[observabilidade\]/);
  } finally {
    rmSync(fx.vault, { recursive: true, force: true });
  }
});
