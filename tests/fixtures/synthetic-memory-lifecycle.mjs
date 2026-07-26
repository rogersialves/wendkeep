import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { renderSharedMemory } from '../../hooks/memory-schema.mjs';

const artificialInstant = (offset = 0) => new Date(offset).toISOString();
const artificialCommit = 'a'.repeat(40);

export const SYNTHETIC_MEMORY = Object.freeze({
  projectId: 'wk-fixture-example-project',
  vaultName: '.wk-fixture-example-vault',
  sessionId: 'wk-fixture-example-session',
  conversationId: 'wk-fixture-example-conversation',
  activationOne: 'wk-fixture-example-activation-one',
  activationTwo: 'wk-fixture-example-activation-two',
  turnOne: 'wk-fixture-example-turn-one',
  changeSlug: 'wk-fixture-example-change',
  nextActionId: 'wk-fixture-example-follow-up',
  noteRel: '03-Sessões/wk-fixture-example-session.md',
  transcriptName: 'wk-fixture-example-transcript.jsonl',
  observedAt: artificialInstant(),
  artificialCommit,
  userMessage: '[wk-fixture] artificial user request for lifecycle verification.',
  agentMessage: '[wk-fixture] artificial agent response for lifecycle verification.',
});

export const SYNTHETIC_SUMMARY_FACTS = Object.freeze([
  '[wk-fixture] archived change evidence is artificial.',
  '[wk-fixture] verification coverage is artificial and green.',
  `[wk-fixture] local commit ${artificialCommit}, sem push.`,
  `[wk-fixture] A próxima change será ${SYNTHETIC_MEMORY.nextActionId}.`,
]);

export const SYNTHETIC_SUMMARY = SYNTHETIC_SUMMARY_FACTS.join(' ');

export const SYNTHETIC_MEMORY_FACTS = Object.freeze([
  SYNTHETIC_MEMORY.changeSlug,
  'ADR-0001',
  'wk-fixture-example-sensor-alpha',
  SYNTHETIC_MEMORY.artificialCommit,
  SYNTHETIC_MEMORY.nextActionId,
  '[wk-fixture] archived change evidence is artificial.',
  'wk-fixture-example-session.md',
]);

export function syntheticWindowsHomePath() {
  const slash = '\\';
  return ['C:', slash, 'Users', slash, 'wk-fixture-example-user', slash, SYNTHETIC_MEMORY.transcriptName].join('');
}

export function makeSyntheticHandoff({ summary = SYNTHETIC_SUMMARY, evidence = {} } = {}) {
  return {
    projectId: SYNTHETIC_MEMORY.projectId,
    identity: {
      canonicalConversationId: SYNTHETIC_MEMORY.conversationId,
      provider: 'codex',
    },
    activation: { id: SYNTHETIC_MEMORY.activationOne, epoch: 1 },
    turn: { id: SYNTHETIC_MEMORY.turnOne, sequence: 1 },
    noteRel: SYNTHETIC_MEMORY.noteRel,
    observedAt: SYNTHETIC_MEMORY.observedAt,
    summary,
    evidence,
  };
}

function seedMemoryFiles(vault) {
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'CORE.md'), '# WK Fixture Core\n\n[WK fixture] immutable artificial baseline.\n');
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory());
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), '');
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), '');
  return brain;
}

export function seedSyntheticMemoryVault() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-fixture-example-memory-'));
  seedMemoryFiles(vault);
  return vault;
}

export function seedSyntheticLifecycleEvidence(vault) {
  const archived = join(vault, '08-Mudanças', '_arquivo', SYNTHETIC_MEMORY.changeSlug);
  const decisions = join(vault, '04-Decisões');
  mkdirSync(archived, { recursive: true });
  mkdirSync(decisions, { recursive: true });

  writeFileSync(join(archived, 'verdict.json'), JSON.stringify({
    ok: true,
    coverage: Array.from({ length: 3 }, (_, index) => ({
      req: `WK-FIXTURE-${index + 1}`,
      covered: true,
    })),
  }));
  writeFileSync(join(archived, 'evidencia.json'), JSON.stringify([
    { id: 'wk-fixture-example-sensor-alpha', status: 'green' },
    { id: 'wk-fixture-example-sensor-beta', status: 'green' },
    { id: 'wk-fixture-example-sensor-gamma', status: 'green' },
  ]));
  writeFileSync(
    join(decisions, `ADR-0001-${SYNTHETIC_MEMORY.changeSlug}.md`),
    '# WK Fixture ADR\n\n[WK fixture] artificial lifecycle decision.\n',
  );
}

function syntheticSessionNote() {
  return `---
type: session
session_id: ${SYNTHETIC_MEMORY.sessionId}
provider: codex
status: active
ended_at:
---

# [wk-fixture] Artificial session

## Objetivo da sessão

> [wk-fixture] Exercise the lifecycle without consumer data.

## Iterações

## Decisões geradas nesta sessão

Nenhuma decisão registrada ainda.

## Bugs gerados nesta sessão

Nenhum bug registrado ainda.

## Aprendizados gerados nesta sessão

Nenhum aprendizado registrado ainda.

## Pendências

- [ ] [wk-fixture] Review the artificial lifecycle result.

## Encerramento

[wk-fixture] Session is still active.
`;
}

function transcriptEvents(project) {
  return [
    {
      type: 'session_meta',
      timestamp: artificialInstant(),
      payload: {
        id: SYNTHETIC_MEMORY.sessionId,
        cwd: project,
        model: 'gpt-5.6-sol',
        model_provider: 'openai',
      },
    },
    {
      type: 'event_msg',
      timestamp: artificialInstant(1_000),
      payload: { type: 'task_started', turn_id: SYNTHETIC_MEMORY.turnOne },
    },
    {
      type: 'event_msg',
      timestamp: artificialInstant(2_000),
      payload: {
        type: 'user_message',
        turn_id: SYNTHETIC_MEMORY.turnOne,
        message: SYNTHETIC_MEMORY.userMessage,
      },
    },
    {
      type: 'event_msg',
      timestamp: artificialInstant(3_000),
      payload: {
        type: 'agent_message',
        turn_id: SYNTHETIC_MEMORY.turnOne,
        message: SYNTHETIC_SUMMARY,
      },
    },
  ];
}

export function seedSyntheticHybridLifecycle({ withSeededSession = true } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'wk-fixture-example-project-'));
  const vault = join(project, SYNTHETIC_MEMORY.vaultName);
  const brain = seedMemoryFiles(vault);
  const sessionPath = join(vault, ...SYNTHETIC_MEMORY.noteRel.split('/'));
  const transcript = join(project, SYNTHETIC_MEMORY.transcriptName);

  mkdirSync(dirname(sessionPath), { recursive: true });
  seedSyntheticLifecycleEvidence(vault);

  writeFileSync(join(project, '.wendkeep.json'), JSON.stringify({
    schemaVersion: 1,
    projectId: SYNTHETIC_MEMORY.projectId,
    vault: SYNTHETIC_MEMORY.vaultName,
  }));
  writeFileSync(join(brain, 'PROJECT.json'), JSON.stringify({
    schemaVersion: 1,
    projectId: SYNTHETIC_MEMORY.projectId,
  }));
  if (withSeededSession) writeFileSync(sessionPath, syntheticSessionNote());

  const events = transcriptEvents(project);
  writeFileSync(transcript, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

  if (withSeededSession) {
    writeFileSync(join(brain, 'SESSION_REGISTRY.json'), JSON.stringify({
      version: 1,
      sessions: {
        [SYNTHETIC_MEMORY.sessionId]: {
          session_file: SYNTHETIC_MEMORY.noteRel,
          status: 'active',
          provider: 'codex',
          transcript_path: transcript,
          transcript_id: SYNTHETIC_MEMORY.sessionId,
          change_slug: SYNTHETIC_MEMORY.changeSlug,
          activation_id: SYNTHETIC_MEMORY.activationOne,
          active_activation_id: SYNTHETIC_MEMORY.activationOne,
          activation_epoch: 1,
          last_turn_sequence: 0,
          activations: {
            [SYNTHETIC_MEMORY.activationOne]: {
              activation_id: SYNTHETIC_MEMORY.activationOne,
              epoch: 1,
              status: 'active',
              last_turn_sequence: 0,
              transcript_id: SYNTHETIC_MEMORY.sessionId,
              transcript_path: transcript,
              provider: 'codex',
            },
          },
        },
      },
    }));
  }

  return {
    project,
    vault,
    brain,
    sessionPath,
    transcript,
  };
}

export function cleanSyntheticHookEnv(vault) {
  const env = {
    ...process.env,
    OBSIDIAN_VAULT_PATH: vault,
    CLAUDECODE: '',
    CLAUDE_CODE_SESSION_ID: '',
  };
  delete env.CODEX_THREAD_ID;
  return env;
}
