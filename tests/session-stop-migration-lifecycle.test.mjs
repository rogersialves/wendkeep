import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseSharedMemory } from '../hooks/memory-schema.mjs';
import {
  parseTranscript,
  resolveTurnIdentity,
  shouldAbortStopAfterStaging,
} from '../hooks/session-stop.mjs';
import { migrateMemory } from '../src/memory.mjs';
import { renderCoreSkeleton } from '../src/validate-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SESSION_ID = 'synthetic-session-issue-20';
const TRANSCRIPT_ID = 'synthetic-rollout-issue-20';

function cleanEnv(vault) {
  const env = { ...process.env, OBSIDIAN_VAULT_PATH: vault };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_THREAD_ID;
  delete env.OBSIDIAN_NO_AUTO_FINALIZE;
  return env;
}

function runHook(script, project, vault, input) {
  return spawnSync(process.execPath, [script], {
    cwd: project,
    env: cleanEnv(vault),
    input: JSON.stringify({ cwd: project, obsidian_vault_path: vault, ...input }),
    encoding: 'utf8',
  });
}

function writeEvent(transcript, event) {
  appendFileSync(transcript, `${JSON.stringify(event)}\n`);
}

function writeTurn(transcript, turnId, userMessage, assistantMessage) {
  writeEvent(transcript, {
    type: 'turn_context',
    payload: { turn_id: turnId },
  });
  writeEvent(transcript, {
    type: 'event_msg',
    payload: { type: 'user_message', message: userMessage },
  });
  writeEvent(transcript, {
    type: 'event_msg',
    payload: { type: 'agent_message', message: assistantMessage },
  });
}

function seedLegacyFixture() {
  const project = mkdtempSync(join(tmpdir(), 'wk-session-memory-lifecycle-'));
  const vault = join(project, '.Synthetic-vault');
  const brain = join(vault, '.brain');
  const transcript = join(project, 'synthetic-rollout.jsonl');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectId: 'synthetic-memory-project',
  })}\n`);
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  writeFileSync(
    join(brain, 'SHARED_MEMORY.md'),
    '# Shared legacy\n\n## Current state\n- Synthetic legacy state.\n',
  );
  writeFileSync(transcript, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: TRANSCRIPT_ID,
      session_id: SESSION_ID,
      model_provider: 'openai',
      cwd: project,
    },
  })}\n`);
  return { project, vault, brain, transcript };
}

function assertHookSucceeded(result, label) {
  assert.equal(result.status, 0, `${label} failed:\n${result.stderr}`);
  assert.doesNotThrow(() => JSON.parse(result.stdout || '{}'), `${label} returned invalid JSON`);
}

function readRegistry(brain) {
  return JSON.parse(readFileSync(join(brain, 'SESSION_REGISTRY.json'), 'utf8'));
}

function readLedger(brain) {
  return readFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runMigrationLifecycle(runtimeRoot = ROOT) {
  const START = join(runtimeRoot, 'hooks', 'session-start.mjs');
  const ENSURE = join(runtimeRoot, 'hooks', 'session-ensure.mjs');
  const STOP = join(runtimeRoot, 'hooks', 'session-stop.mjs');
  const { project, vault, brain, transcript } = seedLegacyFixture();
  try {
    const start = runHook(START, project, vault, {
      hook_event_name: 'SessionStart',
      session_id: SESSION_ID,
      transcript_path: transcript,
      source: 'startup',
    });
    assertHookSucceeded(start, 'SessionStart');

    writeTurn(
      transcript,
      'synthetic-turn-1',
      'Start the synthetic lifecycle.',
      'Synthetic legacy turn completed.',
    );
    const firstPrompt = runHook(ENSURE, project, vault, {
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_ID,
      transcript_path: transcript,
      turn_id: 'synthetic-turn-1',
      prompt: 'Start the synthetic lifecycle.',
    });
    assertHookSucceeded(firstPrompt, 'first UserPromptSubmit');

    const legacyStop = runHook(STOP, project, vault, {
      hook_event_name: 'Stop',
      session_id: SESSION_ID,
      transcript_path: transcript,
      turn_id: 'synthetic-turn-1',
    });
    assertHookSucceeded(legacyStop, 'legacy Stop');
    assert.equal(readRegistry(brain).sessions[SESSION_ID].memory_status, 'legacy');

    // Reproduces the durable registry shape left by the pre-fix lifecycle. The
    // fixture remains synthetic; the following hooks and migration are real.
    const legacyRegistry = readRegistry(brain);
    const legacyEntry = legacyRegistry.sessions[SESSION_ID];
    const legacyActivationId = legacyEntry.active_activation_id
      || Object.keys(legacyEntry.activations || {}).at(-1);
    legacyEntry.status = 'done';
    legacyEntry.active_activation_id = '';
    legacyEntry.activations[legacyActivationId].status = 'done';
    writeFileSync(join(brain, 'SESSION_REGISTRY.json'), `${JSON.stringify(legacyRegistry, null, 2)}\n`);

    const migration = migrateMemory(vault, { apply: true });
    assert.equal(migration.status, 'migrated');
    assert.equal(parseSharedMemory(readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8')).metadata.revision, 0);

    writeTurn(
      transcript,
      'synthetic-turn-2',
      'Continue after the synthetic migration.',
      'Synthetic v2 handoff completed. Next action: review the fixture.',
    );
    const ensure = runHook(ENSURE, project, vault, {
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_ID,
      transcript_path: transcript,
      turn_id: 'synthetic-turn-2',
      prompt: 'Continue after the synthetic migration.',
    });
    assertHookSucceeded(ensure, 'UserPromptSubmit');

    const v2Stop = runHook(STOP, project, vault, {
      hook_event_name: 'Stop',
      session_id: SESSION_ID,
      transcript_path: transcript,
      turn_id: 'synthetic-turn-2',
    });
    assertHookSucceeded(v2Stop, 'v2 Stop');

    const duplicateStop = runHook(STOP, project, vault, {
      hook_event_name: 'Stop',
      session_id: SESSION_ID,
      transcript_path: transcript,
      turn_id: 'synthetic-turn-2',
    });
    assertHookSucceeded(duplicateStop, 'duplicate v2 Stop');

    const registry = readRegistry(brain);
    const shared = parseSharedMemory(readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8'));
    const ledger = readLedger(brain);
    const handoffs = ledger.filter((event) => event.memory_key === 'handoff.latest');
    const diagnostic = JSON.stringify({
      ledger_events: ledger.length,
      shared_revision: shared.metadata.revision,
      memory_status: registry.sessions[SESSION_ID].memory_status,
      has_checkpoint: Boolean(registry.sessions[SESSION_ID].memory_checkpoint),
      stop_output: JSON.parse(v2Stop.stdout || '{}'),
    });

    assert.equal(handoffs.length, 1, `first eligible v2 Stop did not publish exactly once: ${diagnostic}`);
    assert.equal(shared.metadata.revision, 1, diagnostic);
    assert.equal(registry.sessions[SESSION_ID].memory_status, 'projected', diagnostic);
    assert.deepEqual(registry.sessions[SESSION_ID].memory_checkpoint, {
      revision: 1,
      event_cursor: handoffs[0].event_id,
      state_hash: shared.metadata.state_hash,
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

// [sensor:session-memory-lifecycle]
test('[req:MEM-STOP-1] [req:MEM-STOP-2] [req:MEM-STOP-7] first real Stop after legacy-to-v2 migration publishes exactly once', () => {
  runMigrationLifecycle();
});

test('[req:MEM-STOP-1] [req:MEM-STOP-7] removing lifecycle staging makes the full-process oracle fail', () => {
  const mutantRoot = mkdtempSync(join(tmpdir(), 'wk-session-memory-mutant-'));

  try {
    cpSync(join(ROOT, 'hooks'), join(mutantRoot, 'hooks'), { recursive: true });
    cpSync(join(ROOT, 'src'), join(mutantRoot, 'src'), { recursive: true });
    cpSync(
      join(ROOT, 'packages', 'vault'),
      join(mutantRoot, 'packages', 'vault'),
      { recursive: true },
    );
    cpSync(
      join(ROOT, 'packages', 'integrations'),
      join(mutantRoot, 'packages', 'integrations'),
      { recursive: true },
    );

    assert.doesNotThrow(() => runMigrationLifecycle(mutantRoot));

    const lifecyclePath = join(mutantRoot, 'hooks', 'session-memory-lifecycle.mjs');
    const source = readFileSync(lifecyclePath, 'utf8');
    const marker = 'for (const event of events) deps.enqueueMemoryEvent(vaultBase, event);';
    const replacement = 'for (const event of events) void event;';
    assert.ok(source.includes(marker), 'mutation marker must track the production staging call');
    writeFileSync(lifecyclePath, source.replace(marker, replacement));

    assert.throws(
      () => runMigrationLifecycle(mutantRoot),
      /first eligible v2 Stop did not publish exactly once/,
    );
  } finally {
    rmSync(mutantRoot, { recursive: true, force: true });
  }
});

test('[req:MEM-STOP-2] native Codex and Claude transcripts derive causal turn order without hook-only fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-provider-turn-order-'));
  try {
    const codexPath = join(dir, 'synthetic-codex.jsonl');
    const codexEvents = [
      { type: 'session_meta', payload: { id: 'wk-fixture-rollout', session_id: 'wk-fixture-session' } },
      { type: 'turn_context', payload: { turn_id: 'wk-fixture-codex-turn-1' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic first prompt.' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Synthetic first answer.' } },
      { type: 'turn_context', payload: { turn_id: 'wk-fixture-codex-turn-2' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic second prompt.' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Synthetic second answer.' } },
    ];
    writeFileSync(codexPath, `${codexEvents.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const codex = parseTranscript(codexPath);
    assert.deepEqual(resolveTurnIdentity(codex, 'wk-fixture-codex-turn-1'), {
      id: 'wk-fixture-codex-turn-1', order: 1, observedAt: '',
    });
    assert.equal(resolveTurnIdentity(codex, 'wk-fixture-missing-turn'), null);

    const claudePath = join(dir, 'synthetic-claude.jsonl');
    const claudeEvents = [
      {
        type: 'user', uuid: 'wk-fixture-claude-turn-1', timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 'wk-fixture-session', message: { role: 'user', content: 'Synthetic first prompt.' },
      },
      {
        type: 'assistant', uuid: 'wk-fixture-claude-answer-1', timestamp: '2026-01-01T00:00:02.000Z',
        sessionId: 'wk-fixture-session', message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic first answer.' }] },
      },
      {
        type: 'user', uuid: 'wk-fixture-claude-turn-2', timestamp: '2026-01-01T00:00:03.000Z',
        sessionId: 'wk-fixture-session', message: { role: 'user', content: 'Synthetic second prompt.' },
      },
      {
        type: 'assistant', uuid: 'wk-fixture-claude-answer-2', timestamp: '2026-01-01T00:00:04.000Z',
        sessionId: 'wk-fixture-session', message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic second answer.' }] },
      },
    ];
    writeFileSync(claudePath, `${claudeEvents.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const claude = parseTranscript(claudePath);
    assert.deepEqual(resolveTurnIdentity(claude), {
      id: 'wk-fixture-claude-turn-2', order: 2, observedAt: '2026-01-01T00:00:03.000Z',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[req:MEM-STOP-6] unverifiable v2 Stop is durably observable as ambiguous', () => {
  const { project, vault, brain, transcript } = seedLegacyFixture();
  try {
    assert.equal(migrateMemory(vault, { apply: true }).status, 'migrated');
    const start = runHook(join(ROOT, 'hooks', 'session-start.mjs'), project, vault, {
      hook_event_name: 'SessionStart',
      session_id: SESSION_ID,
      transcript_path: transcript,
      source: 'startup',
    });
    assertHookSucceeded(start, 'SessionStart before ambiguous Stop');

    const stop = runHook(join(ROOT, 'hooks', 'session-stop.mjs'), project, vault, {
      hook_event_name: 'Stop',
      session_id: SESSION_ID,
      transcript_path: transcript,
      turn_id: 'wk-fixture-turn-not-in-transcript',
    });
    assertHookSucceeded(stop, 'ambiguous Stop');
    assert.match(JSON.parse(stop.stdout).systemMessage, /Stop ambiguous/);

    const attempt = readRegistry(brain).sessions[SESSION_ID].last_memory_attempt;
    assert.equal(attempt.memory_mode, 'v2');
    assert.equal(attempt.disposition, 'ambiguous');
    assert.equal(attempt.state, 'skipped');
    assert.deepEqual(attempt.event_ids, []);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('[req:MEM-STOP-2] Stop principal usa turn_sequences quando filhos intercalam a ordem global', () => {
  const { project, vault, brain, transcript } = seedLegacyFixture();
  try {
    const start = runHook(join(ROOT, 'hooks', 'session-start.mjs'), project, vault, {
      hook_event_name: 'SessionStart',
      session_id: SESSION_ID,
      transcript_path: transcript,
      source: 'startup',
    });
    assertHookSucceeded(start, 'SessionStart before mapped Stop');

    for (let index = 1; index <= 5; index += 1) {
      writeTurn(
        transcript,
        `wk-parent-turn-${index}`,
        `Synthetic parent prompt ${index}.`,
        `Synthetic parent answer ${index}.`,
      );
    }

    const polluted = readRegistry(brain);
    const pollutedEntry = polluted.sessions[SESSION_ID];
    const activationId = pollutedEntry.active_activation_id;
    pollutedEntry.last_turn_sequence = 17;
    pollutedEntry.activations[activationId].last_turn_sequence = 17;
    writeFileSync(join(brain, 'SESSION_REGISTRY.json'), `${JSON.stringify(polluted, null, 2)}\n`);

    const ensure = runHook(join(ROOT, 'hooks', 'session-ensure.mjs'), project, vault, {
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_ID,
      transcript_path: transcript,
      turn_id: 'wk-parent-turn-5',
      prompt: '[wk-fixture] Synthetic parent prompt 5.',
    });
    assertHookSucceeded(ensure, 'mapped UserPromptSubmit');
    assert.equal(readRegistry(brain).sessions[SESSION_ID].turn_sequences['wk-parent-turn-5'], 18);

    const stop = runHook(join(ROOT, 'hooks', 'session-stop.mjs'), project, vault, {
      hook_event_name: 'Stop',
      session_id: SESSION_ID,
      transcript_path: transcript,
      turn_id: 'wk-parent-turn-5',
    });
    assertHookSucceeded(stop, 'mapped Stop');

    const after = readRegistry(brain).sessions[SESSION_ID];
    const active = after.activations[Object.keys(after.activations || {}).at(-1)];
    const note = readFileSync(join(vault, after.session_file), 'utf8');
    assert.equal(after.status, 'done');
    assert.equal(after.active_activation_id, '');
    assert.equal(active.last_stop_turn_sequence, 18);
    assert.match(note, /<!-- wk-turn: wk-parent-turn-5 -->/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('[req:MEM-STOP-4] v2 staging revalidation aborts an older Stop before finalization', () => {
  const stopAcceptedBeforeConcurrentStart = {
    stopDisposition: 'applied',
    canPromoteMemory: true,
  };
  const supersededAtStaging = {
    memory_mode: 'v2',
    state: 'skipped',
    disposition: 'superseded',
  };

  assert.equal(shouldAbortStopAfterStaging(
    stopAcceptedBeforeConcurrentStart,
    supersededAtStaging,
  ), true);
  assert.equal(shouldAbortStopAfterStaging(stopAcceptedBeforeConcurrentStart, {
    memory_mode: 'v2', state: 'enqueued', disposition: 'applied',
  }), false);
  assert.equal(shouldAbortStopAfterStaging(stopAcceptedBeforeConcurrentStart, {
    memory_mode: 'legacy', state: 'skipped', disposition: 'legacy',
  }), false);
});

test('[req:MEM-STOP-4] concurrent activation between Stop CAS and staging preserves note and control', () => {
  const { project, vault, brain, transcript } = seedLegacyFixture();
  try {
    assert.equal(migrateMemory(vault, { apply: true }).status, 'migrated');
    const start = runHook(join(ROOT, 'hooks', 'session-start.mjs'), project, vault, {
      hook_event_name: 'SessionStart',
      session_id: SESSION_ID,
      transcript_path: transcript,
      source: 'startup',
    });
    assertHookSucceeded(start, 'SessionStart before concurrent Stop');
    writeTurn(
      transcript,
      'wk-fixture-concurrent-turn-1',
      'Start the concurrency fixture.',
      'Synthetic concurrent turn completed.',
    );
    const ensure = runHook(join(ROOT, 'hooks', 'session-ensure.mjs'), project, vault, {
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_ID,
      transcript_path: transcript,
      turn_id: 'wk-fixture-concurrent-turn-1',
      prompt: 'Start the concurrency fixture.',
    });
    assertHookSucceeded(ensure, 'UserPromptSubmit before concurrent Stop');

    const before = readRegistry(brain).sessions[SESSION_ID];
    const notePath = join(vault, before.session_file);
    const controlPath = join(brain, 'CURRENT_SESSION.md');
    const noteBefore = readFileSync(notePath);
    const controlBefore = readFileSync(controlPath);
    const runner = join(project, 'synthetic-concurrent-stop-runner.mjs');
    const stopModule = pathToFileURL(join(ROOT, 'hooks', 'session-stop.mjs')).href;
    const lifecycleModule = pathToFileURL(join(ROOT, 'hooks', 'session-memory-lifecycle.mjs')).href;
    const commonModule = pathToFileURL(join(ROOT, 'hooks', 'obsidian-common.mjs')).href;
    writeFileSync(runner, `
import { main } from ${JSON.stringify(stopModule)};
import { stageStopMemoryAttempt } from ${JSON.stringify(lifecycleModule)};
import { mutateSessionRegistry, openActivation } from ${JSON.stringify(commonModule)};
await main({
  stageMemory(vaultBase, context) {
    mutateSessionRegistry(vaultBase, (registry) => {
      const next = openActivation(registry, {
        session_id: ${JSON.stringify(SESSION_ID)},
        activation_id: 'wk-fixture-concurrent-activation-2',
        activation_started_at: '2026-01-01T00:00:02.000Z',
        turn_sequence: context.handoff.turn.sequence,
        transcript_id: ${JSON.stringify(TRANSCRIPT_ID)},
        transcript_path: ${JSON.stringify(transcript)},
        provider: 'codex',
      });
      registry.version = next.version;
      registry.sessions = next.sessions;
      return null;
    });
    return stageStopMemoryAttempt(vaultBase, context);
  },
});
`);

    const stop = runHook(runner, project, vault, {
      hook_event_name: 'Stop',
      session_id: SESSION_ID,
      transcript_path: transcript,
      turn_id: 'wk-fixture-concurrent-turn-1',
    });
    assertHookSucceeded(stop, 'concurrent Stop');
    assert.match(JSON.parse(stop.stdout).systemMessage, /Stop superseded/);
    assert.deepEqual(readFileSync(notePath), noteBefore);
    assert.deepEqual(readFileSync(controlPath), controlBefore);
    const after = readRegistry(brain).sessions[SESSION_ID];
    assert.equal(after.active_activation_id, 'wk-fixture-concurrent-activation-2');
    assert.equal(after.activations['wk-fixture-concurrent-activation-2'].status, 'active');
    assert.equal(parseSharedMemory(readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8')).metadata.revision, 0);
    assert.deepEqual(readLedger(brain), []);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
