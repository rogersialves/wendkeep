import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SYNTHETIC_MEMORY,
  SYNTHETIC_MEMORY_FACTS,
  cleanSyntheticHookEnv,
  seedSyntheticHybridLifecycle,
} from './fixtures/synthetic-memory-lifecycle.mjs';
import {
  deriveMemoryProjection, enqueueMemoryEvent, projectMemoryOutbox, readMemoryLedger,
} from '../hooks/memory-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'wendkeep.mjs');
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

function runPublicHook(name, { project, vault, input }) {
  const env = cleanSyntheticHookEnv(vault);
  env.OBSIDIAN_VAULT_PATH = join(project, '.wk-fixture-wrong-global-vault');
  return spawnSync(process.execPath, [BIN, 'hook', name], {
    cwd: project,
    env,
    encoding: 'utf8',
    input: JSON.stringify(input),
  });
}

function runCli(args, { project }) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: project,
    encoding: 'utf8',
  });
}

function readCandidates(brain) {
  const content = readFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), 'utf8').trim();
  return content ? content.split('\n').map(JSON.parse) : [];
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

test('[req:MEM-CUR-2] public Stop advances after CLI recovery despite physical/temporal inversion', () => {
  const { project, vault, brain, sessionPath, transcript } = seedSyntheticHybridLifecycle();
  const legacyBase = Date.now() - 10_000;
  const selected = {
    v: 1,
    event_id: 'wk-fixture-promoted-handoff',
    project_id: SYNTHETIC_MEMORY.projectId,
    memory_key: 'handoff.latest',
    operation: 'assert',
    value: '[wk-fixture] selected handoff before the next Stop.',
    authority: 'reported',
    canonical_session_id: SYNTHETIC_MEMORY.sessionId,
    activation_id: SYNTHETIC_MEMORY.activationOne,
    activation_epoch: 1,
    turn_sequence: 0,
    source_turn_id: 'wk-fixture-turn-before-stop',
    observed_at: new Date(legacyBase).toISOString(),
    evidence: ['wk-fixture:selected'],
  };
  const competing = {
    ...selected,
    event_id: 'wk-fixture-competing-handoff',
    value: '[wk-fixture] competing handoff.',
    canonical_session_id: 'wk-fixture-competing-session',
    activation_id: 'wk-fixture-competing-activation',
    source_turn_id: 'wk-fixture-competing-turn',
    observed_at: new Date(legacyBase + 1_000).toISOString(),
    evidence: ['wk-fixture:competing'],
  };
  enqueueMemoryEvent(vault, selected);
  enqueueMemoryEvent(vault, competing);
  projectMemoryOutbox(vault);
  const candidate = readCandidates(brain).find((item) => item.event_ids.includes(selected.event_id));
  assert.ok(candidate);

  const legacyPromotion = {
    v: 1,
    event_id: 'wk-fixture-0661-promotion',
    project_id: SYNTHETIC_MEMORY.projectId,
    memory_key: selected.memory_key,
    operation: 'replace',
    value: selected.value,
    authority: 'verified',
    activation_id: selected.activation_id,
    activation_epoch: selected.activation_epoch,
    turn_sequence: selected.turn_sequence,
    observed_at: new Date(legacyBase + 2_000).toISOString(),
    evidence: [`candidate:${candidate.candidate_id}`],
    candidate_decision: {
      candidate_id: candidate.candidate_id,
      action: 'promote',
      event_ids: [...candidate.event_ids].sort(),
      selected_event_id: selected.event_id,
    },
    supersedes: [...candidate.event_ids].sort(),
  };
  enqueueMemoryEvent(vault, legacyPromotion);
  projectMemoryOutbox(vault);
  assert.deepEqual(readCandidates(brain), []);

  const priorContinuation = {
    ...selected,
    event_id: 'wk-fixture-prior-0661-continuation',
    value: '[wk-fixture] prior continuation promoted by 0.66.1.',
    source_turn_id: 'wk-fixture-turn-prior-0661',
    observed_at: new Date(legacyBase + 3_000).toISOString(),
    evidence: ['wk-fixture:prior-0661'],
  };
  enqueueMemoryEvent(vault, priorContinuation);
  projectMemoryOutbox(vault);
  const priorCandidate = readCandidates(brain).find(
    (item) => item.event_ids.includes(priorContinuation.event_id),
  );
  assert.ok(priorCandidate);
  const laterLegacyPromotion = {
    ...legacyPromotion,
    event_id: 'wk-fixture-later-0661-promotion',
    value: priorContinuation.value,
    observed_at: new Date(legacyBase + 5_000).toISOString(),
    evidence: [`candidate:${priorCandidate.candidate_id}`],
    candidate_decision: {
      candidate_id: priorCandidate.candidate_id,
      action: 'promote',
      event_ids: [...priorCandidate.event_ids].sort(),
      selected_event_id: priorContinuation.event_id,
    },
    supersedes: [...priorCandidate.event_ids].sort(),
  };
  enqueueMemoryEvent(vault, laterLegacyPromotion);
  projectMemoryOutbox(vault);
  assert.deepEqual(readCandidates(brain), []);

  const postLegacyHandoff = {
    ...selected,
    event_id: 'wk-fixture-post-0661-handoff',
    value: '[wk-fixture] handoff observed after the 0.66.1 decision.',
    turn_sequence: 1,
    source_turn_id: 'wk-fixture-turn-after-0661',
    observed_at: new Date(legacyBase + 4_000).toISOString(),
    evidence: ['wk-fixture:post-0661'],
  };
  enqueueMemoryEvent(vault, postLegacyHandoff);
  projectMemoryOutbox(vault);
  const recoveryCandidate = readCandidates(brain).find(
    (item) => item.event_ids.includes(postLegacyHandoff.event_id),
  );
  assert.ok(recoveryCandidate, 'a decisão 0.66.1 sem sessão causal produz o candidate conhecido');
  assert.ok(
    recoveryCandidate.event_ids.includes(legacyPromotion.event_id),
    'o candidate de recuperação é causado pela promoção 0.66.1 persistida',
  );
  assert.equal(
    recoveryCandidate.event_ids.includes(laterLegacyPromotion.event_id),
    false,
    'a promoção projetada mais nova pode ficar fora do candidate por ordenação temporal',
  );
  const historicalPrefix = readFileSync(join(brain, 'MEMORY_EVENTS.jsonl'));

  const promoted = runCli([
    'memory', 'promote', recoveryCandidate.candidate_id,
    '--event', postLegacyHandoff.event_id,
    '--vault', vault,
  ], { project });
  assert.equal(promoted.status, 0, promoted.stderr || promoted.stdout);
  const promotion = JSON.parse(promoted.stdout);
  assert.equal(promotion.status, 'promoted');
  assert.deepEqual(readCandidates(brain), []);
  assert.ok(
    readFileSync(join(brain, 'MEMORY_EVENTS.jsonl')).subarray(0, historicalPrefix.length)
      .equals(historicalPrefix),
    'a recuperação acrescenta uma decisão sem reinterpretar o prefixo 0.66.1',
  );

  const decision = readMemoryLedger(vault).events.find((event) => event.event_id === promotion.eventId);
  assert.ok(
    decision.supersedes.includes(laterLegacyPromotion.event_id),
    'a nova decisão cobre a promoção legada que avançou a projeção fora do candidate',
  );
  assert.deepEqual(
    decision.candidate_decision.event_ids,
    [...recoveryCandidate.event_ids].sort(),
    'a auditoria da escolha continua descrevendo somente os membros do candidate',
  );
  const ledgerAfterPromotion = readFileSync(join(brain, 'MEMORY_EVENTS.jsonl'));
  const promotionRetryResult = runCli([
    'memory', 'promote', recoveryCandidate.candidate_id,
    '--event', postLegacyHandoff.event_id,
    '--vault', vault,
  ], { project });
  assert.equal(
    promotionRetryResult.status,
    0,
    promotionRetryResult.stderr || promotionRetryResult.stdout,
  );
  const promotionRetry = JSON.parse(promotionRetryResult.stdout);
  assert.equal(promotionRetry.alreadyApplied, true);
  assert.deepEqual(
    readFileSync(join(brain, 'MEMORY_EVENTS.jsonl')),
    ledgerAfterPromotion,
    'retry da recuperação temporal não duplica a decisão',
  );
  const stopEffectiveInstant = Date.parse(laterLegacyPromotion.observed_at) - 500;
  const transcriptEvents = readFileSync(transcript, 'utf8').trim().split('\n').map(JSON.parse);
  const secondTurnId = 'wk-fixture-example-turn-two';
  transcriptEvents.push(
    {
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: secondTurnId },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'user_message', turn_id: secondTurnId,
        message: '[wk-fixture] second artificial lifecycle request.',
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'agent_message', turn_id: secondTurnId,
        message: '[wk-fixture] second artificial lifecycle response.',
      },
    },
  );
  transcriptEvents.forEach((event, index) => {
    const distanceFromTail = transcriptEvents.length - index;
    event.timestamp = new Date(stopEffectiveInstant - (distanceFromTail * 10)).toISOString();
  });
  writeFileSync(transcript, `${transcriptEvents.map(JSON.stringify).join('\n')}\n`);

  const input = {
    ...stopInput(project, transcript), turn_id: secondTurnId, turn_sequence: 2,
  };
  const stop = runPublicHook('session-stop', { project, vault, input });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(JSON.parse(stop.stdout || '{}').systemMessage, undefined);
  assert.deepEqual(readCandidates(brain), []);
  const ledgerAfterStop = readFileSync(join(brain, 'MEMORY_EVENTS.jsonl'));
  const eventsAfterStop = readMemoryLedger(vault).events;
  const latest = eventsAfterStop.find((event) => (
    event.memory_key === 'handoff.latest' && event.source_turn_id === secondTurnId
  ));
  assert.ok(latest);
  assert.equal(latest.canonical_session_id, SYNTHETIC_MEMORY.sessionId);
  assert.equal(latest.activation_id, SYNTHETIC_MEMORY.activationOne);
  assert.equal(latest.activation_epoch, 1);
  assert.equal(latest.turn_sequence, 2);
  assert.ok(
    Date.parse(latest.observed_at) < Date.parse(laterLegacyPromotion.observed_at),
    'o Stop é efetivamente anterior às decisões CLI embora seja anexado fisicamente depois',
  );
  assert.ok(
    eventsAfterStop.findIndex((event) => event.event_id === latest.event_id)
      > eventsAfterStop.findIndex((event) => event.event_id === decision.event_id),
    'o Stop foi anexado fisicamente depois da correção CLI',
  );
  assert.ok(
    readFileSync(join(brain, 'MEMORY_EVENTS.jsonl')).subarray(0, historicalPrefix.length)
      .equals(historicalPrefix),
    'o Stop preserva byte a byte o prefixo legado auditado',
  );

  const sharedAfterStop = readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8');
  assert.match(sharedAfterStop, /second artificial lifecycle response/i);
  assert.doesNotMatch(sharedAfterStop, /prior continuation promoted by 0\.66\.1/i);
  const registryAfterStop = JSON.parse(readFileSync(join(brain, 'SESSION_REGISTRY.json'), 'utf8'));
  const sessionAfterStop = registryAfterStop.sessions[SYNTHETIC_MEMORY.sessionId];
  const expectedCheckpoint = deriveMemoryProjection(vault, eventsAfterStop).checkpoint;
  assert.equal(sessionAfterStop.memory_status, 'projected');
  assert.deepEqual(sessionAfterStop.memory_checkpoint, expectedCheckpoint);
  assert.equal(sessionAfterStop.last_memory_attempt.disposition, 'applied');
  assert.equal(sessionAfterStop.last_memory_attempt.state, 'projected');
  assert.deepEqual(
    sessionAfterStop.last_memory_attempt.checkpoint,
    sessionAfterStop.memory_checkpoint,
    'o attempt projetado espelha o checkpoint físico/causal persistido',
  );
  assert.equal(readdirSync(join(brain, 'memory-outbox')).length, 0);

  const healthResult = runCli(['memory', 'status', '--gate', '--vault', vault], { project });
  const health = JSON.parse(healthResult.stdout);
  assert.ok(
    health.failures.every((failure) => /^core:/i.test(failure)),
    'a fixture mínima pode omitir seções curadas, mas não possui falha operacional de memória',
  );
  assert.equal(health.metrics.candidates, 0);
  assert.equal(health.metrics.pendingOutbox, 0);
  assert.equal(health.metrics.activeConflicts, 0);

  const stable = {
    shared: readFileSync(join(brain, 'SHARED_MEMORY.md')),
    registry: readFileSync(join(brain, 'SESSION_REGISTRY.json')),
    note: readFileSync(sessionPath),
  };
  const repeated = runPublicHook('session-stop', { project, vault, input });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(readFileSync(join(brain, 'MEMORY_EVENTS.jsonl')), ledgerAfterStop);
  assert.deepEqual(readFileSync(join(brain, 'SHARED_MEMORY.md')), stable.shared);
  assert.deepEqual(readFileSync(join(brain, 'SESSION_REGISTRY.json')), stable.registry);
  assert.deepEqual(readFileSync(sessionPath), stable.note);
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
