import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SYNTHETIC_MEMORY,
  SYNTHETIC_MEMORY_FACTS,
  cleanSyntheticHookEnv,
  seedSyntheticHybridLifecycle,
} from './fixtures/synthetic-memory-lifecycle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STOP = join(ROOT, 'hooks', 'session-stop.mjs');
const START = join(ROOT, 'hooks', 'session-start.mjs');
const INJECT = join(ROOT, 'hooks', 'brain-inject.mjs');

function stopInput(project, transcript, activationId = SYNTHETIC_MEMORY.activationOne) {
  return {
    hook_event_name: 'Stop',
    cwd: project,
    session_id: SYNTHETIC_MEMORY.sessionId,
    transcript_path: transcript,
    turn_id: SYNTHETIC_MEMORY.turnOne,
    turn_sequence: 1,
    activation_id: activationId,
  };
}

function runHook(script, { project, vault, input }) {
  return spawnSync(process.execPath, [script], {
    cwd: project,
    env: cleanSyntheticHookEnv(vault),
    encoding: 'utf8',
    input: JSON.stringify(input),
  });
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
}

test('[req:MEM-STOP-7] synthetic Stop projects lifecycle memory and remains idempotent', () => {
  const { project, vault, brain, sessionPath, transcript } = seedSyntheticHybridLifecycle();
  const corePath = join(brain, 'CORE.md');
  const coreBeforeStop = readFileSync(corePath);
  const stop = runHook(STOP, {
    project,
    vault,
    input: stopInput(project, transcript),
  });

  assert.equal(stop.status, 0, stop.stderr);
  assert.doesNotThrow(() => JSON.parse(stop.stdout || '{}'));
  const stopOutput = JSON.parse(stop.stdout || '{}');
  assert.equal(stopOutput.systemMessage, undefined, '[wk-fixture] successful Stop stays silent');
  assert.match(readFileSync(sessionPath, 'utf8'), /status: done/);

  const registryPath = join(brain, 'SESSION_REGISTRY.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.equal(registry.sessions[SYNTHETIC_MEMORY.sessionId].memory_status, 'projected');
  assert.equal(
    registry.sessions[SYNTHETIC_MEMORY.sessionId].memory_checkpoint.revision >= 5,
    true,
  );
  assert.deepEqual(
    readFileSync(corePath),
    coreBeforeStop,
    '[wk-fixture] runtime projection must not curate CORE',
  );

  const shared = readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8');
  for (const fact of SYNTHETIC_MEMORY_FACTS) {
    assert.match(
      shared,
      new RegExp(escapeRegExp(fact), 'i'),
      '[wk-fixture] projected fact is present in shared memory',
    );
  }

  const noteMtime = statSync(sessionPath).mtimeMs;
  const ledgerPath = join(brain, 'MEMORY_EVENTS.jsonl');
  const ledgerBefore = readFileSync(ledgerPath);
  const repeated = runHook(STOP, {
    project,
    vault,
    input: stopInput(project, transcript),
  });

  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(
    statSync(sessionPath).mtimeMs,
    noteMtime,
    '[wk-fixture] repeated Stop must not rewrite the note',
  );
  assert.equal(
    readFileSync(ledgerPath, 'utf8'),
    ledgerBefore.toString('utf8'),
    '[wk-fixture] repeated Stop must not duplicate ledger events',
  );

  const inject = runHook(INJECT, {
    project,
    vault,
    input: {
      hook_event_name: 'UserPromptSubmit',
      source: 'startup',
      cwd: project,
      session_id: 'wk-fixture-example-injected-session',
    },
  });
  assert.equal(inject.status, 0, inject.stderr);
  assert.deepEqual(
    readFileSync(corePath),
    coreBeforeStop,
    '[wk-fixture] injection must not mutate CORE',
  );
  const context = JSON.parse(inject.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /<brain_memory version="2"/);
  for (const fact of SYNTHETIC_MEMORY_FACTS) {
    assert.match(
      context,
      new RegExp(escapeRegExp(fact), 'i'),
      '[wk-fixture] injected context contains projected memory',
    );
  }
});

test('[req:MEM-STOP-7] synthetic busy projector preserves active session and durable outbox', () => {
  const { project, vault, brain, transcript } = seedSyntheticHybridLifecycle();
  mkdirSync(join(brain, 'MEMORY.lock'));
  const stop = runHook(STOP, {
    project,
    vault,
    input: stopInput(project, transcript),
  });

  assert.equal(stop.status, 0, stop.stderr);
  const output = JSON.parse(stop.stdout || '{}');
  assert.match(output.systemMessage, /memória compartilhada degradada|outbox/i);
  const registry = JSON.parse(readFileSync(join(brain, 'SESSION_REGISTRY.json'), 'utf8'));
  assert.equal(registry.sessions[SYNTHETIC_MEMORY.sessionId].status, 'active');
  assert.equal(registry.sessions[SYNTHETIC_MEMORY.sessionId].memory_status, 'degraded');
  assert.equal(registry.sessions[SYNTHETIC_MEMORY.sessionId].memory_checkpoint, undefined);
  assert.ok(readdirSync(join(brain, 'memory-outbox')).some((name) => name.endsWith('.json')));
});

test('[req:MEM-STOP-7] synthetic late Stop cannot overwrite a newer activation', () => {
  const { project, vault, brain, transcript } = seedSyntheticHybridLifecycle({
    withSeededSession: false,
  });
  const startOne = runHook(START, {
    project,
    vault,
    input: {
      hook_event_name: 'SessionStart',
      cwd: project,
      session_id: SYNTHETIC_MEMORY.sessionId,
      transcript_path: transcript,
      activation_id: SYNTHETIC_MEMORY.activationOne,
      source: 'startup',
    },
  });
  assert.equal(startOne.status, 0, startOne.stderr);
  assert.doesNotThrow(() => JSON.parse(startOne.stdout || '{}'));

  const registryPath = join(brain, 'SESSION_REGISTRY.json');
  const registryOne = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.equal(
    registryOne.sessions[SYNTHETIC_MEMORY.sessionId].active_activation_id,
    SYNTHETIC_MEMORY.activationOne,
  );
  assert.equal(
    registryOne.sessions[SYNTHETIC_MEMORY.sessionId]
      .activations[SYNTHETIC_MEMORY.activationOne].epoch,
    1,
  );

  const startTwo = runHook(START, {
    project,
    vault,
    input: {
      hook_event_name: 'SessionStart',
      cwd: project,
      session_id: SYNTHETIC_MEMORY.sessionId,
      transcript_path: transcript,
      activation_id: SYNTHETIC_MEMORY.activationTwo,
      source: 'startup',
    },
  });
  assert.equal(startTwo.status, 0, startTwo.stderr);
  assert.doesNotThrow(() => JSON.parse(startTwo.stdout || '{}'));

  const ledgerPath = join(brain, 'MEMORY_EVENTS.jsonl');
  const registryTwo = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.equal(
    registryTwo.sessions[SYNTHETIC_MEMORY.sessionId].active_activation_id,
    SYNTHETIC_MEMORY.activationTwo,
  );
  assert.equal(
    registryTwo.sessions[SYNTHETIC_MEMORY.sessionId]
      .activations[SYNTHETIC_MEMORY.activationTwo].epoch,
    2,
  );
  const sessionPath = join(
    vault,
    ...registryTwo.sessions[SYNTHETIC_MEMORY.sessionId].session_file.split('/'),
  );
  const before = {
    note: readFileSync(sessionPath),
    registry: readFileSync(registryPath),
    ledger: readFileSync(ledgerPath),
    checkpoint: Buffer.from(JSON.stringify(
      registryTwo.sessions[SYNTHETIC_MEMORY.sessionId].memory_checkpoint ?? null,
    )),
  };

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  const late = runHook(STOP, {
    project,
    vault,
    input: stopInput(project, transcript, SYNTHETIC_MEMORY.activationOne),
  });

  assert.equal(late.status, 0, late.stderr);
  assert.match(JSON.parse(late.stdout || '{}').systemMessage, /activation mais nova|superseded/i);
  assert.deepEqual(readFileSync(sessionPath), before.note);
  assert.deepEqual(readFileSync(registryPath), before.registry);
  assert.deepEqual(readFileSync(ledgerPath), before.ledger);
  const registryAfterLateStop = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.deepEqual(
    Buffer.from(JSON.stringify(
      registryAfterLateStop.sessions[SYNTHETIC_MEMORY.sessionId].memory_checkpoint ?? null,
    )),
    before.checkpoint,
    '[wk-fixture] stale Stop must preserve the newer checkpoint',
  );
});
