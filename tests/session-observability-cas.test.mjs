import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishSessionObservability } from '../hooks/session-observability.mjs';
import { readSessionRegistry, upsertSessionRegistry } from '../hooks/obsidian-common.mjs';
import { readObservabilityStore } from '../hooks/session-observability-store.mjs';

function frontier(overrides = {}) {
  return {
    canonical_session_id: 'session-synthetic',
    activation_id: 'activation-synthetic',
    activation_epoch: 2,
    turn_sequence: 4,
    signal_sequence: 6,
    roots_stat_hash: 'roots-synthetic',
    graph_cursor: 'graph-synthetic',
    source_manifest_hash: 'manifest-synthetic',
    ...overrides,
  };
}

function checkpointContent(value, state = 'complete') {
  return `---\ntype: session\nobservability_schema: 2\nsubagents_observability_state: '${state}'\nobservability_session_id: 'session-synthetic'\nobservability_activation_id: 'activation-synthetic'\nobservability_activation_epoch: ${value.activation_epoch}\nobservability_turn_sequence: ${value.turn_sequence}\nobservability_signal_sequence: ${value.signal_sequence}\nobservability_roots_stat_hash: '${value.roots_stat_hash}'\nobservability_graph_cursor: '${value.graph_cursor}'\nobservability_source_manifest_hash: '${value.source_manifest_hash}'\nsubagents_diagnostics_json: '[]'\n---\n\n# Synthetic\n`;
}

function candidate(value = frontier(), content = checkpointContent(value)) {
  return { state: 'complete', frontier: value, diagnostics: [], snapshot: { version: 2 }, content };
}

function memoryNote(initial) {
  let content = initial;
  let writes = 0;
  let lockHeld = false;
  return {
    get content() { return content; },
    get writes() { return writes; },
    get lockHeld() { return lockHeld; },
    mutate(_path, mutator) {
      lockHeld = true;
      try {
        const next = mutator(content);
        if (next == null) return { written: false, reason: 'aborted', content };
        if (next === content) return { written: false, reason: 'unchanged', content };
        content = next;
        writes += 1;
        return { written: true, reason: 'ok', content };
      } finally {
        lockHeld = false;
      }
    },
  };
}

test('[req:OBS-12] publish composes outside the note lock and equal candidates are byte-identical', () => {
  const value = frontier();
  const note = memoryNote(checkpointContent(value));
  let composedOutsideLock = false;
  let registryWrites = 0;
  let revalidatedCandidate = null;

  const result = publishSessionObservability({
    sessionPath: 'synthetic.md',
    frontier: value,
    compose: () => {
      composedOutsideLock = !note.lockHeld;
      return candidate(value, note.content);
    },
    readRuntimeFrontier: (candidateFrontier) => {
      revalidatedCandidate = candidateFrontier;
      return value;
    },
    writeRegistryCheckpoint: () => { registryWrites += 1; },
  }, { mutateNote: note.mutate.bind(note) });

  assert.equal(composedOutsideLock, true);
  assert.deepEqual(revalidatedCandidate, value);
  assert.equal(result.status, 'unchanged');
  assert.equal(note.writes, 0);
  assert.equal(registryWrites, 1, 'registry is reconciled even when note already has the candidate');
});

test('[req:OBS-11] [req:OBS-12] older candidate loses the causal CAS and never changes the note', () => {
  const current = frontier({ activation_epoch: 5, turn_sequence: 1, signal_sequence: 1 });
  const older = frontier({ activation_epoch: 4, turn_sequence: 99, signal_sequence: 99 });
  const original = checkpointContent(current);
  const note = memoryNote(original);

  const result = publishSessionObservability({
    sessionPath: 'synthetic.md',
    frontier: older,
    candidate: candidate(older, checkpointContent(older)),
    readRuntimeFrontier: () => current,
  }, { mutateNote: note.mutate.bind(note) });

  assert.equal(result.status, 'stale');
  assert.equal(note.content, original);
  assert.equal(note.writes, 0);
});

test('[req:OBS-11] a signal that advances after composition is rejected under the publication guard', () => {
  const composed = frontier({ signal_sequence: 6 });
  const advanced = frontier({ signal_sequence: 7 });
  const original = checkpointContent(composed);
  const note = memoryNote(original);
  let guardHeld = false;

  const result = publishSessionObservability({
    sessionPath: 'synthetic.md',
    candidate: candidate(composed, `${checkpointContent(composed)}\nnew snapshot\n`),
    withPublicationGuard(candidateFrontier, publish) {
      assert.deepEqual(candidateFrontier, composed);
      guardHeld = true;
      try { return publish({ current: advanced }); }
      finally { guardHeld = false; }
    },
    readRuntimeFrontier(candidateFrontier, context) {
      assert.equal(guardHeld, true, 'revalidation must run while the registry guard is held');
      assert.deepEqual(candidateFrontier, composed);
      return context.current;
    },
  }, { mutateNote: note.mutate.bind(note) });

  assert.equal(result.status, 'stale');
  assert.equal(note.content, original);
  assert.equal(note.writes, 0);
});

test('[req:OBS-12] degraded and manifest-conflicting candidates fail closed without touching the note', () => {
  const value = frontier();
  const original = checkpointContent(value);
  const note = memoryNote(original);

  const degraded = publishSessionObservability({
    sessionPath: 'synthetic.md',
    frontier: value,
    candidate: { ...candidate(value), state: 'degraded', content: 'must-not-publish' },
  }, { mutateNote: note.mutate.bind(note) });
  assert.equal(degraded.status, 'degraded');

  const conflicting = frontier({ source_manifest_hash: 'manifest-other' });
  const conflict = publishSessionObservability({
    sessionPath: 'synthetic.md',
    frontier: conflicting,
    candidate: candidate(conflicting, checkpointContent(conflicting)),
    readRuntimeFrontier: () => value,
  }, { mutateNote: note.mutate.bind(note) });
  assert.equal(conflict.status, 'conflict');
  assert.equal(note.content, original);
  assert.equal(note.writes, 0);
});

test('[req:OBS-12] crash after note publication is reconciled idempotently on retry', () => {
  const value = frontier({ signal_sequence: 7, source_manifest_hash: 'manifest-next' });
  const note = memoryNote('---\ntype: session\n---\n\n# Synthetic\n');
  let registryAttempts = 0;
  const publish = () => publishSessionObservability({
    sessionPath: 'synthetic.md',
    frontier: value,
    candidate: candidate(value, checkpointContent(value)),
    readRuntimeFrontier: () => value,
    writeRegistryCheckpoint: () => {
      registryAttempts += 1;
      if (registryAttempts === 1) throw new Error('synthetic registry crash');
    },
  }, { mutateNote: note.mutate.bind(note) });

  assert.throws(publish, /synthetic registry crash/);
  assert.equal(note.writes, 1, 'note was durably published before the simulated crash');
  const bytesAfterCrash = note.content;

  const retried = publish();
  assert.equal(retried.status, 'unchanged');
  assert.equal(note.content, bytesAfterCrash);
  assert.equal(note.writes, 1, 'retry must not republish the same handoff');
  assert.equal(registryAttempts, 2);
});

test('[req:OBS-11] [req:OBS-12] vault publication defaults hold the registry guard and persist both checkpoints', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-observe-default-cas-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    const note = join(vault, 'session.md');
    writeFileSync(note, '---\ntype: session\nprovider: codex\n---\n\n# Synthetic\n');
    upsertSessionRegistry(vault, 'session-synthetic', {
      session_file: 'session.md',
      provider: 'codex',
      active_activation_id: 'activation-synthetic',
      activation_epoch: 2,
      last_turn_sequence: 4,
      observability_signal_sequence: 0,
    });
    const initial = frontier({ signal_sequence: 0 });
    const first = publishSessionObservability({
      vaultBase: vault,
      sessionPath: note,
      canonicalConversationId: 'session-synthetic',
      candidate: candidate(initial, checkpointContent(initial)),
    });
    assert.equal(first.status, 'published');
    assert.equal(readSessionRegistry(vault).sessions['session-synthetic'].observability_checkpoint_sequence, 0);
    assert.equal(readObservabilityStore(vault, 'session-synthetic').checkpoint_frontier.signal_sequence, 0);

    upsertSessionRegistry(vault, 'session-synthetic', {
      active_activation_id: 'activation-next',
      activation_epoch: 3,
      last_turn_sequence: 1,
    });
    const bytes = readFileSync(note, 'utf8');
    const stale = publishSessionObservability({
      vaultBase: vault,
      sessionPath: note,
      canonicalConversationId: 'session-synthetic',
      candidate: candidate(initial, `${checkpointContent(initial)}\nold overwrite\n`),
    });
    assert.equal(stale.status, 'stale');
    assert.equal(readFileSync(note, 'utf8'), bytes);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OBS-12] an offline source refresh is rejected if the manifest changes after composition', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-observe-refresh-cas-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    const note = join(vault, 'session.md');
    const root = join(vault, 'root.jsonl');
    const current = frontier({ signal_sequence: 0, source_manifest_hash: 'manifest-old' });
    const refreshed = frontier({ signal_sequence: 0, source_manifest_hash: 'manifest-new' });
    writeFileSync(note, checkpointContent(current));
    writeFileSync(root, `${JSON.stringify({ type: 'session_meta', payload: { id: 'root-synthetic', session_id: 'session-synthetic' } })}\n`);
    const rootStat = statSync(root);
    upsertSessionRegistry(vault, 'session-synthetic', {
      session_file: 'session.md',
      provider: 'codex',
      transcript_path: root,
      active_activation_id: 'activation-synthetic',
      activation_epoch: 2,
      last_turn_sequence: 4,
      observability_signal_sequence: 0,
    });
    const composed = {
      ...candidate(refreshed, checkpointContent(refreshed)),
      snapshot: {
        version: 2,
        roots: { rootPaths: [root], descendantIds: [] },
        subagents: {
          sourceManifest: [{
            path: root,
            rolloutId: 'root-synthetic',
            size: rootStat.size,
            mtimeMs: rootStat.mtimeMs,
          }],
        },
      },
    };
    writeFileSync(root, `${readFileSync(root, 'utf8')}\n`);

    const result = publishSessionObservability({
      vaultBase: vault,
      sessionPath: note,
      canonicalConversationId: 'session-synthetic',
      candidate: composed,
      allowSourceRefresh: true,
    });
    assert.equal(result.status, 'conflict');
    assert.equal(readFileSync(note, 'utf8'), checkpointContent(current));
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
