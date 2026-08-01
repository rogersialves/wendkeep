import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rebuildSessionCosts,
  writeRebuildReportIfChanged,
} from '../src/rebuild-costs.mjs';
import { readSessionRegistry, upsertSessionRegistry } from '../hooks/obsidian-common.mjs';
import { readObservabilityStore } from '../hooks/session-observability-store.mjs';

function fixture(ids = ['synthetic-one']) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-rebuild-observe-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  mkdirSync(join(vault, 'sessions'), { recursive: true });
  const sessions = {};
  for (const id of ids) {
    const sessionFile = `sessions/${id}.md`;
    const transcriptPath = join(vault, `${id}.jsonl`);
    writeFileSync(join(vault, sessionFile), `---\ntype: session\n---\n\n# ${id}\n`);
    writeFileSync(transcriptPath, '{"type":"synthetic"}\n');
    sessions[id] = { session_file: sessionFile, transcript_path: transcriptPath };
  }
  return { vault, sessions };
}

function treeSnapshot(root, relative = '') {
  const directory = join(root, relative);
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const child = join(relative, entry.name);
      if (entry.isDirectory()) return [{ path: `${child}/`, type: 'directory' }, ...treeSnapshot(root, child)];
      const path = join(root, child);
      return [{
        path: child,
        type: 'file',
        bytes: readFileSync(path).toString('base64'),
        mtimeMs: statSync(path).mtimeMs,
      }];
    });
}

function codexRollout({ id, sessionId = id, model, input, output, parentId = '' }) {
  const meta = {
    id,
    session_id: sessionId,
    model,
    model_provider: 'openai',
    ...(parentId ? {
      parent_thread_id: parentId,
      source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
    } : {}),
  };
  return [
    { type: 'session_meta', payload: meta },
    { type: 'turn_context', payload: { model, model_provider: 'openai', effort: 'high' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'synthetic request' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { model, model_provider: 'openai', last_token_usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } } } },
  ];
}

function realLifecycleFixture({ withChild = false } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-rebuild-real-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  const note = join(vault, 'session.md');
  writeFileSync(note, '---\ntype: session\nprovider: codex\n---\n\n# Synthetic\n\n## Pendências\n\nNenhuma.\n');
  const rolloutDir = join(vault, 'rollouts', '2026', '01', '01');
  mkdirSync(rolloutDir, { recursive: true });
  const rootId = 'root-synthetic';
  const root = join(rolloutDir, `rollout-2026-01-01T10-00-00-${rootId}.jsonl`);
  const rootEvents = codexRollout({ id: rootId, model: 'model-main', input: 10, output: 5 });
  const transcriptPaths = [root];
  if (withChild) {
    const childId = 'child-synthetic';
    rootEvents.push({
      type: 'event_msg',
      timestamp: '2026-01-01T10:01:00.000Z',
      payload: { type: 'sub_agent_activity', kind: 'started', agent_thread_id: childId },
    });
    const child = join(rolloutDir, `rollout-2026-01-01T10-02-00-${childId}.jsonl`);
    writeFileSync(child, `${codexRollout({
      id: childId,
      sessionId: rootId,
      parentId: rootId,
      model: 'model-child',
      input: 7,
      output: 3,
    }).map(JSON.stringify).join('\n')}\n`);
    transcriptPaths.push(child);
  }
  writeFileSync(root, `${rootEvents.map(JSON.stringify).join('\n')}\n`);
  upsertSessionRegistry(vault, rootId, {
    session_file: 'session.md',
    transcript_path: root,
    transcript_paths: transcriptPaths,
    provider: 'codex',
    active_activation_id: 'activation-synthetic',
    activation_epoch: 1,
    last_turn_sequence: 1,
    observability_signal_sequence: 0,
  });
  return { vault, note, rootId };
}

test('[req:OBS-13] dry-run composes without acquiring a publisher or writing any file', () => {
  const fx = fixture();
  try {
    const note = join(fx.vault, fx.sessions['synthetic-one'].session_file);
    const before = readFileSync(note);
    const beforeMtime = statSync(note).mtimeMs;
    let publishes = 0;
    const report = rebuildSessionCosts(fx.vault, { apply: false }, {
      readRegistry: () => ({ sessions: fx.sessions }),
      compose: () => ({ state: 'complete', content: 'synthetic changed content', diagnostics: [] }),
      publish: () => { publishes += 1; throw new Error('dry-run invoked publisher'); },
      writeReport: () => { throw new Error('dry-run wrote report'); },
      now: () => '2026-01-01T00:00:00.000Z',
    });

    assert.equal(report.scanned, 1);
    assert.equal(report.changed, 1);
    assert.equal(report.ok, true);
    assert.equal(publishes, 0);
    assert.deepEqual(readFileSync(note), before);
    assert.equal(statSync(note).mtimeMs, beforeMtime);
    assert.equal(existsSync(join(fx.vault, '.brain', 'COST_REBUILD.json')), false);
  } finally {
    rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:OBS-13] dry-run with a fresh note lock preserves the complete vault tree', () => {
  const fx = fixture();
  try {
    const note = join(fx.vault, fx.sessions['synthetic-one'].session_file);
    mkdirSync(`${note}.lock`);
    const before = treeSnapshot(fx.vault);
    let writerCalls = 0;
    const report = rebuildSessionCosts(fx.vault, { apply: false }, {
      readRegistry: () => ({ sessions: fx.sessions }),
      compose: () => ({ state: 'complete', content: 'synthetic changed content', diagnostics: [] }),
      publish: () => { writerCalls += 1; return { status: 'published' }; },
      markDirty: () => { writerCalls += 1; },
      writeReport: () => { writerCalls += 1; },
      now: () => '2026-01-01T00:00:00.000Z',
    });

    assert.equal(report.changed, 1);
    assert.equal(writerCalls, 0);
    assert.deepEqual(treeSnapshot(fx.vault), before);
  } finally {
    rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:OBS-13] dry-run exercises the real registered Codex lifecycle without a writer', () => {
  const fx = fixture();
  try {
    const entry = fx.sessions['synthetic-one'];
    const note = join(fx.vault, entry.session_file);
    writeFileSync(note, '---\ntype: session\nprovider: codex\n---\n\n# Synthetic\n\n## Pendências\n\nNenhuma.\n');
    writeFileSync(entry.transcript_path, [
      { type: 'session_meta', payload: { id: 'synthetic-one', session_id: 'synthetic-one', model: 'gpt-5.6-sol', model_provider: 'openai' } },
      { type: 'turn_context', payload: { model: 'gpt-5.6-sol', model_provider: 'openai', effort: 'high' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'synthetic request' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { model: 'gpt-5.6-sol', last_token_usage: { input_tokens: 10, output_tokens: 5 } } } },
    ].map(JSON.stringify).join('\n') + '\n');
    entry.provider = 'codex';
    const before = readFileSync(note);
    const report = rebuildSessionCosts(fx.vault, { apply: false }, {
      readRegistry: () => ({ sessions: fx.sessions }),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    assert.equal(report.ok, true);
    assert.equal(report.changed, 1);
    assert.equal(report.sessions[0].status, 'would-change');
    assert.deepEqual(readFileSync(note), before);
  } finally {
    rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:OBS-13] apply publishes only complete/none and preserves degraded or stale sessions', () => {
  const fx = fixture(['synthetic-complete', 'synthetic-none', 'synthetic-degraded', 'synthetic-stale']);
  try {
    const original = Object.fromEntries(Object.entries(fx.sessions).map(([id, entry]) => [
      id, {
        content: readFileSync(join(fx.vault, entry.session_file), 'utf8'),
        mtimeMs: statSync(join(fx.vault, entry.session_file)).mtimeMs,
      },
    ]));
    const report = rebuildSessionCosts(fx.vault, { apply: true }, {
      readRegistry: () => ({ sessions: fx.sessions }),
      compose: ({ canonicalConversationId }) => ({
        state: canonicalConversationId === 'synthetic-none'
          ? 'none'
          : (canonicalConversationId === 'synthetic-degraded' ? 'degraded' : 'complete'),
        content: `changed:${canonicalConversationId}`,
        diagnostics: canonicalConversationId === 'synthetic-degraded'
          ? [{ code: 'GRAPH_LIMIT_EXCEEDED', count: 1 }]
          : [],
      }),
      publish: ({ canonicalConversationId, sessionPath, candidate }) => {
        if (canonicalConversationId === 'synthetic-stale') return { status: 'stale' };
        writeFileSync(sessionPath, candidate.content);
        return { status: 'published' };
      },
      writeReport: () => {},
      now: () => '2026-01-01T00:00:00.000Z',
    });

    assert.equal(readFileSync(join(fx.vault, fx.sessions['synthetic-complete'].session_file), 'utf8'), 'changed:synthetic-complete');
    assert.equal(readFileSync(join(fx.vault, fx.sessions['synthetic-none'].session_file), 'utf8'), 'changed:synthetic-none');
    const degradedNote = join(fx.vault, fx.sessions['synthetic-degraded'].session_file);
    const staleNote = join(fx.vault, fx.sessions['synthetic-stale'].session_file);
    assert.equal(readFileSync(degradedNote, 'utf8'), original['synthetic-degraded'].content);
    assert.equal(statSync(degradedNote).mtimeMs, original['synthetic-degraded'].mtimeMs);
    assert.equal(readFileSync(staleNote, 'utf8'), original['synthetic-stale'].content);
    assert.equal(statSync(staleNote).mtimeMs, original['synthetic-stale'].mtimeMs);
    assert.equal(readObservabilityStore(fx.vault, 'synthetic-degraded').observability_dirty, true);
    assert.equal(readObservabilityStore(fx.vault, 'synthetic-stale').observability_dirty, true);
    assert.equal(report.changed, 2);
    assert.equal(report.degraded, 1);
    assert.equal(report.stale, 1);
    assert.equal(report.ok, false);
    assert.deepEqual(report.sessions.map(({ sessionId, status }) => [sessionId, status]), [
      ['synthetic-complete', 'published'],
      ['synthetic-degraded', 'degraded'],
      ['synthetic-none', 'published'],
      ['synthetic-stale', 'stale'],
    ]);
  } finally {
    rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:OBS-13] real apply classifies root and child exactly once without duplicating totals', () => {
  const fx = realLifecycleFixture({ withChild: true });
  try {
    const report = rebuildSessionCosts(fx.vault, { apply: true }, {
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const note = readFileSync(fx.note, 'utf8');
    assert.equal(report.ok, true);
    assert.equal(report.changed, 1);
    assert.equal((note.match(/\| model-main \| openai \| main \|/g) || []).length, 1);
    assert.equal((note.match(/\| model-child \| openai \| subagent \|/g) || []).length, 1);
    assert.match(note, /\| Total tokens \| 15 \| 10 \| 25 \|/);
  } finally {
    rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:OBS-13] second real apply preserves note, checkpoint, store and report bytes plus mtimes', async () => {
  const fx = realLifecycleFixture();
  try {
    const first = rebuildSessionCosts(fx.vault, { apply: true }, {
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const reportPath = join(fx.vault, '.brain', 'COST_REBUILD.json');
    const before = {
      note: readFileSync(fx.note),
      noteMtime: statSync(fx.note).mtimeMs,
      checkpoint: readSessionRegistry(fx.vault).sessions[fx.rootId].observability_checkpoint_frontier,
      store: readObservabilityStore(fx.vault, fx.rootId),
      report: readFileSync(reportPath),
      reportMtime: statSync(reportPath).mtimeMs,
    };
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = rebuildSessionCosts(fx.vault, { apply: true }, {
      now: () => '2026-01-02T00:00:00.000Z',
    });

    assert.equal(first.changed, 1);
    assert.equal(second.unchanged, 1);
    assert.deepEqual(readFileSync(fx.note), before.note);
    assert.equal(statSync(fx.note).mtimeMs, before.noteMtime);
    assert.deepEqual(readSessionRegistry(fx.vault).sessions[fx.rootId].observability_checkpoint_frontier, before.checkpoint);
    assert.deepEqual(readObservabilityStore(fx.vault, fx.rootId), before.store);
    assert.deepEqual(readFileSync(reportPath), before.report);
    assert.equal(statSync(reportPath).mtimeMs, before.reportMtime);
  } finally {
    rmSync(fx.vault, { recursive: true, force: true });
  }
});

test('[req:OBS-13] semantically identical apply report preserves bytes, mtime and generatedAt', () => {
  const fx = fixture();
  try {
    const reportPath = join(fx.vault, '.brain', 'COST_REBUILD.json');
    const first = {
      version: 2, generatedAt: '2026-01-01T00:00:00.000Z', mode: 'apply',
      scanned: 1, changed: 1, unchanged: 0, degraded: 0, stale: 0, missing: 0,
      ok: true, sessions: [{ sessionId: 'synthetic-one', status: 'published', candidateHash: 'hash-a', diagnostics: [] }],
    };
    assert.equal(writeRebuildReportIfChanged(reportPath, first), true);
    const bytes = readFileSync(reportPath);
    const mtime = statSync(reportPath).mtimeMs;
    assert.equal(writeRebuildReportIfChanged(reportPath, {
      ...first,
      generatedAt: '2026-01-02T00:00:00.000Z',
    }), false);
    assert.deepEqual(readFileSync(reportPath), bytes);
    assert.equal(statSync(reportPath).mtimeMs, mtime);
    assert.equal(writeRebuildReportIfChanged(reportPath, {
      ...first,
      generatedAt: '2026-01-03T00:00:00.000Z',
      changed: 0,
      unchanged: 1,
      sessions: [{ sessionId: 'synthetic-one', status: 'unchanged', candidateHash: 'hash-b', diagnostics: [] }],
    }), true, 'a different candidate hash is a real semantic change');
  } finally {
    rmSync(fx.vault, { recursive: true, force: true });
  }
});
