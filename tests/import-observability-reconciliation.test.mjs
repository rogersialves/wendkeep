import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImport } from '../hooks/import-sessions.mjs';
import { parseObservabilityCheckpoint } from '../hooks/session-observability-state.mjs';
import {
  mutateObservabilityStore,
  readObservabilityStore,
} from '../hooks/session-observability-store.mjs';

const SESSION_ID = 'synthetic-session';
const TRANSCRIPT = [
  { type: 'user', uuid: 'turn-1', timestamp: '2026-01-01T09:00:00.000Z', sessionId: SESSION_ID, message: { role: 'user', content: 'synthetic request' } },
  { type: 'assistant', uuid: 'answer-1', timestamp: '2026-01-01T09:00:01.000Z', sessionId: SESSION_ID, message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: 'text', text: 'synthetic answer' }] } },
];

function seed() {
  const source = mkdtempSync(join(tmpdir(), 'wk-import-observe-src-'));
  const vault = mkdtempSync(join(tmpdir(), 'wk-import-observe-vault-'));
  writeFileSync(join(source, `${SESSION_ID}.jsonl`), `${TRANSCRIPT.map(JSON.stringify).join('\n')}\n`);
  const first = runImport(vault, { source: 'claude', from: source });
  return { source, vault, note: join(vault, first.sessions[0].relPath) };
}

function codexSeed() {
  const source = mkdtempSync(join(tmpdir(), 'wk-import-observe-codex-'));
  const vault = mkdtempSync(join(tmpdir(), 'wk-import-observe-vault-'));
  const day = join(source, '2026', '01', '01');
  mkdirSync(day, { recursive: true });
  const transcript = join(day, 'synthetic-rollout.jsonl');
  const events = [
    { type: 'session_meta', timestamp: '2026-01-01T09:00:00.000Z', payload: { id: SESSION_ID, cwd: 'synthetic-project', model: 'gpt-5.6-sol', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: '2026-01-01T09:00:01.000Z', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'event_msg', timestamp: '2026-01-01T09:00:02.000Z', payload: { type: 'user_message', turn_id: 'turn-1', message: 'synthetic request' } },
    { type: 'event_msg', timestamp: '2026-01-01T09:00:03.000Z', payload: { type: 'agent_message', turn_id: 'turn-1', message: 'synthetic answer' } },
    { type: 'event_msg', timestamp: '2026-01-01T09:00:04.000Z', payload: { type: 'token_count', turn_id: 'turn-1', info: { model: 'gpt-5.6-sol', last_token_usage: { input_tokens: 10, output_tokens: 5 } } } },
  ];
  writeFileSync(transcript, `${events.map(JSON.stringify).join('\n')}\n`);
  const first = runImport(vault, {
    source: 'codex', projectPath: 'synthetic-project', codexFrom: source,
  });
  return { source, vault, transcript, note: join(vault, first.sessions[0].relPath) };
}

test('[req:IMPORT-5] a complete note still reconciles observability without duplicating turns', () => {
  const fx = seed();
  try {
    const before = readFileSync(fx.note, 'utf8');
    const calls = [];
    const report = runImport(fx.vault, {
      source: 'claude',
      from: fx.source,
      reconcileObservability(input) {
        calls.push(input);
        return { status: 'published', diagnostics: [] };
      },
    });

    assert.equal(calls.length, 1, 'the old no-missing-turn early return must not bypass observability');
    assert.equal(calls[0].sessionId, SESSION_ID);
    assert.equal(calls[0].sessionPath, fx.note);
    assert.equal((readFileSync(fx.note, 'utf8').match(/<!-- wk-turn:/g) || []).length, 1);
    assert.equal((before.match(/<!-- wk-turn:/g) || []).length, 1);
    assert.equal(report.observabilityReconciled, 1);
    assert.equal(report.sessions[0].turns, 0);
    assert.deepEqual(report.sessions[0].observability, { status: 'published', diagnostics: [] });
  } finally {
    rmSync(fx.source, { recursive: true, force: true });
    rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:IMPORT-5] reconciliation failure is reported without leaking private error text', () => {
  const fx = seed();
  const privateMarker = 'PRIVATE_TRANSCRIPT_MARKER';
  try {
    let report;
    assert.doesNotThrow(() => {
      report = runImport(fx.vault, {
        source: 'claude',
        from: fx.source,
        reconcileObservability() {
          throw new Error(privateMarker);
        },
      });
    });

    assert.equal(report.observabilityDegraded, 1);
    assert.deepEqual(report.sessions[0].observability, {
      status: 'degraded',
      diagnostics: [{ code: 'CACHE_INVALID', count: 1 }],
    });
    assert.ok(!JSON.stringify(report).includes(privateMarker));
  } finally {
    rmSync(fx.source, { recursive: true, force: true });
    rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:IMPORT-5] degraded reconciliation strips private diagnostic fields', () => {
  const fx = seed();
  const privateMarker = 'PRIVATE_TRANSCRIPT_MARKER';
  try {
    const report = runImport(fx.vault, {
      source: 'claude',
      from: fx.source,
      reconcileObservability() {
        return {
          status: 'degraded',
          diagnostics: [{
            code: 'CHILD_MISSING',
            count: 2,
            transcriptExcerpt: privateMarker,
          }],
        };
      },
    });

    assert.equal(report.observabilityDegraded, 1);
    assert.deepEqual(report.sessions[0].observability, {
      status: 'degraded',
      diagnostics: [{ code: 'CHILD_MISSING', count: 2 }],
    });
    assert.ok(!JSON.stringify(report).includes(privateMarker));
  } finally {
    rmSync(fx.source, { recursive: true, force: true });
    rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:IMPORT-5] a proven-fresh reconciliation remains byte-identical', () => {
  const fx = seed();
  try {
    const before = readFileSync(fx.note);
    const report = runImport(fx.vault, {
      source: 'claude',
      from: fx.source,
      reconcileObservability() {
        return { status: 'fresh', diagnostics: [] };
      },
    });

    assert.deepEqual(readFileSync(fx.note), before);
    assert.equal(report.observabilityFresh, 1);
    assert.equal(report.observabilityReconciled, 0);
  } finally {
    rmSync(fx.source, { recursive: true, force: true });
    rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:IMPORT-5] real Codex import skips a fresh frontier and reconciles advanced source stat', () => {
  const fx = codexSeed();
  try {
    const before = readFileSync(fx.note);
    const beforeMtime = statSync(fx.note).mtimeMs;
    const initialCheckpoint = parseObservabilityCheckpoint(before.toString('utf8'));
    const initialRuntime = readObservabilityStore(fx.vault, SESSION_ID);
    assert.deepEqual(initialRuntime.checkpoint_frontier, initialCheckpoint.frontier);
    assert.equal(initialRuntime.observability_checkpoint_sequence, initialRuntime.observability_signal_sequence);
    assert.equal(initialRuntime.observability_dirty, false);
    const currentManifest = initialRuntime.source_manifest.map((source) => {
      const stat = statSync(source.path);
      assert.equal(stat.size, source.size);
      assert.equal(stat.mtimeMs, source.mtimeMs);
      return { rolloutId: source.rolloutId, size: stat.size, mtimeMs: stat.mtimeMs };
    }).sort((left, right) =>
      `${left.rolloutId}\u0000${left.size}\u0000${left.mtimeMs}`.localeCompare(
        `${right.rolloutId}\u0000${right.size}\u0000${right.mtimeMs}`,
      ));
    assert.equal(
      createHash('sha256').update(JSON.stringify(currentManifest)).digest('hex'),
      initialCheckpoint.frontier.source_manifest_hash,
    );
    const fresh = runImport(fx.vault, {
      source: 'codex', projectPath: 'synthetic-project', codexFrom: fx.source,
    });
    assert.deepEqual({
      fresh: fresh.observabilityFresh,
      reconciled: fresh.observabilityReconciled,
      degraded: fresh.observabilityDegraded,
      sessions: fresh.sessions,
    }, {
      fresh: 1,
      reconciled: 0,
      degraded: 0,
      sessions: [{
        sessionId: SESSION_ID,
        turns: 0,
        observability: { status: 'fresh', diagnostics: [] },
      }],
    });
    assert.deepEqual(readFileSync(fx.note), before);
    assert.equal(statSync(fx.note).mtimeMs, beforeMtime);

    writeFileSync(fx.transcript, `${readFileSync(fx.transcript, 'utf8')}${JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-01-01T09:00:05.000Z',
      payload: { type: 'token_count', turn_id: 'turn-1', info: { model: 'gpt-5.6-sol', last_token_usage: { input_tokens: 20, output_tokens: 5 } } },
    })}\n`);
    const stale = runImport(fx.vault, {
      source: 'codex', projectPath: 'synthetic-project', codexFrom: fx.source,
    });
    assert.equal(stale.observabilityReconciled, 1);
    assert.equal((readFileSync(fx.note, 'utf8').match(/<!-- wk-turn:/g) || []).length, 1);
  } finally {
    rmSync(fx.source, { recursive: true, force: true });
    rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:IMPORT-5] advanced signal reconciles with unchanged source stat and no new turn', () => {
  const fx = codexSeed();
  try {
    const sourceBefore = statSync(fx.transcript);
    mutateObservabilityStore(fx.vault, SESSION_ID, (state) => ({
      ...state,
      observability_signal_sequence: state.observability_signal_sequence + 1,
      observability_dirty: true,
    }));

    const report = runImport(fx.vault, {
      source: 'codex', projectPath: 'synthetic-project', codexFrom: fx.source,
    });

    assert.equal(report.observabilityReconciled, 1);
    assert.equal(report.observabilityFresh, 0);
    assert.equal((readFileSync(fx.note, 'utf8').match(/<!-- wk-turn:/g) || []).length, 1);
    const sourceAfter = statSync(fx.transcript);
    assert.equal(sourceAfter.size, sourceBefore.size);
    assert.equal(sourceAfter.mtimeMs, sourceBefore.mtimeMs);
  } finally {
    rmSync(fx.source, { recursive: true, force: true });
    rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:IMPORT-5] legacy observability schema is reconciled without adding a turn', () => {
  const fx = codexSeed();
  try {
    writeFileSync(fx.note, readFileSync(fx.note, 'utf8').replace(
      /^observability_schema:\s*2$/m,
      'observability_schema: 1',
    ));
    const legacyBytes = readFileSync(fx.note);
    const preview = runImport(fx.vault, {
      source: 'codex', projectPath: 'synthetic-project', codexFrom: fx.source, dryRun: true,
    });
    assert.equal(preview.observabilityReconciled, 1);
    assert.deepEqual(readFileSync(fx.note), legacyBytes, 'dry-run only plans reconciliation');
    const report = runImport(fx.vault, {
      source: 'codex', projectPath: 'synthetic-project', codexFrom: fx.source,
    });
    assert.equal(report.observabilityReconciled, 1);
    const noteContent = readFileSync(fx.note, 'utf8');
    assert.match(noteContent, /^observability_schema:\s*2$/m);
    assert.equal((noteContent.match(/<!-- wk-turn:/g) || []).length, 1);
  } finally {
    rmSync(fx.source, { recursive: true, force: true });
    rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:IMPORT-5] degraded state and missing frontier force reconciliation without adding turns', () => {
  const cases = [
    {
      label: 'degraded',
      mutate(content) {
        return content.replace(
          /^subagents_observability_state:\s*.*$/m,
          "subagents_observability_state: 'degraded'",
        );
      },
    },
    {
      label: 'frontier-missing',
      mutate(content) {
        return content.replace(
          /^observability_(?:session_id|activation_id|activation_epoch|turn_sequence|signal_sequence|roots_stat_hash|graph_cursor|source_manifest_hash):.*\r?\n/gm,
          '',
        );
      },
    },
  ];
  const fixtures = cases.map((entry) => ({ ...entry, fx: codexSeed() }));
  try {
    for (const { label, mutate, fx } of fixtures) {
      writeFileSync(fx.note, mutate(readFileSync(fx.note, 'utf8')));
      const beforeTurns = (readFileSync(fx.note, 'utf8').match(/<!-- wk-turn:/g) || []).length;

      const report = runImport(fx.vault, {
        source: 'codex', projectPath: 'synthetic-project', codexFrom: fx.source,
      });

      assert.equal(
        report.observabilityReconciled,
        1,
        `${label}: ${JSON.stringify(report.sessions[0]?.observability)}`,
      );
      assert.equal(report.observabilityFresh, 0, label);
      assert.equal(
        (readFileSync(fx.note, 'utf8').match(/<!-- wk-turn:/g) || []).length,
        beforeTurns,
        label,
      );
      const checkpoint = parseObservabilityCheckpoint(readFileSync(fx.note, 'utf8'));
      assert.ok(checkpoint, label);
      assert.notEqual(checkpoint.state, 'degraded', label);
    }
  } finally {
    for (const { fx } of fixtures) {
      rmSync(fx.source, { recursive: true, force: true });
      rmSync(fx.vault, { recursive: true, force: true });
    }
  }
});
