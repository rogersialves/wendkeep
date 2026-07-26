import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STOP = join(ROOT, 'hooks', 'session-stop.mjs');
const INJECT = join(ROOT, 'hooks', 'brain-inject.mjs');
const SID = '019f9cea-b7c1-79d0-9ac5-931e56192b52';
const SUMMARY = [
  'Concluído. Halley finalizou com verdict ok:true, cobrindo 7/7 requisitos.',
  'Change arquivada como ADR-0107. Sensores backend-unit, contracts-openapi e campaign-import-backend verdes.',
  'E2E confirmou worker, OCR, MinIO privado e materialização 1|1|1|1.',
  'Commit local em main: 9fbbbb1bdad630cd4145ea4a916ef8f240ed603f. Nenhum push realizado.',
  'A próxima change será a interface de revisão.',
].join(' ');

const NOTE = `---
type: session
session_id: "${SID}"
provider: codex
status: active
ended_at:
---

# 22:22 - files mentioned by the user

## Iterações

## Decisões geradas nesta sessão

Nenhuma decisão registrada ainda.

## Bugs gerados nesta sessão

Nenhum bug registrado ainda.

## Aprendizados gerados nesta sessão

Nenhum aprendizado registrado ainda.

## Pendências

Nenhuma.
`;

function seed() {
  const project = mkdtempSync(join(tmpdir(), 'wk-memory-e2e-project-'));
  const vault = join(project, '.Vendiva-vault');
  const brain = join(vault, '.brain');
  const sessionRel = '02-Sessões/2026/07-JUL/DIA 25/22-22-files-mentioned-by-the-user.md';
  const sessionPath = join(vault, ...sessionRel.split('/'));
  const transcript = join(project, `rollout-${SID}.jsonl`);
  const archived = join(vault, '08-Mudanças', '_arquivo', '2026-07-25-campanhas-importacao');
  const decisions = join(vault, '04-Decisões', '2026', '07-JUL');
  mkdirSync(brain, { recursive: true });
  mkdirSync(dirname(sessionPath), { recursive: true });
  mkdirSync(archived, { recursive: true });
  mkdirSync(decisions, { recursive: true });

  writeFileSync(join(project, '.wendkeep.json'), JSON.stringify({ schemaVersion: 1, projectId: 'vendiva', vault: '.Vendiva-vault' }));
  writeFileSync(join(brain, 'PROJECT.json'), JSON.stringify({ schemaVersion: 1, projectId: 'vendiva' }));
  writeFileSync(join(brain, 'CORE.md'), [
    '# CORE', '', '## Preferências do Usuário', '- responder em pt-BR', '',
    '## Padrões Ativos', '- memória local e auditável', '', '## Pendências Abertas', '- consultar SHARED diretamente', '',
  ].join('\n'));
  writeFileSync(sessionPath, NOTE);
  writeFileSync(join(archived, 'verdict.json'), JSON.stringify({
    ok: true,
    coverage: Array.from({ length: 7 }, (_, index) => ({ req: `REQ-${index + 1}`, covered: true })),
  }));
  writeFileSync(join(archived, 'evidencia.json'), JSON.stringify([
    { id: 'backend-unit', status: 'green' },
    { id: 'contracts-openapi', status: 'green' },
    { id: 'campaign-import-backend', status: 'green' },
  ]));
  writeFileSync(join(decisions, 'ADR-0107-campanhas-importacao.md'), '# ADR-0107 — campanhas-importacao\n');

  const events = [
    { type: 'session_meta', timestamp: '2026-07-25T22:22:00.000Z', payload: { id: SID, cwd: project, model: 'gpt-5.6-sol', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: '2026-07-26T03:20:40.000Z', payload: { type: 'task_started', turn_id: 'turn-final' } },
    { type: 'event_msg', timestamp: '2026-07-26T03:20:41.000Z', payload: { type: 'user_message', turn_id: 'turn-final', message: 'Finalize e registre o handoff.' } },
    { type: 'event_msg', timestamp: '2026-07-26T03:20:47.000Z', payload: { type: 'agent_message', turn_id: 'turn-final', message: SUMMARY } },
  ];
  writeFileSync(transcript, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  writeFileSync(join(brain, 'SESSION_REGISTRY.json'), JSON.stringify({
    version: 2,
    sessions: {
      [SID]: {
        session_file: sessionRel,
        status: 'active',
        provider: 'codex',
        transcript_path: transcript,
        transcript_id: SID,
        change_slug: 'campanhas-importacao',
        activation_id: 'activation-1',
        active_activation_id: 'activation-1',
        activation_epoch: 1,
        last_turn_sequence: 1,
        activations: {
          'activation-1': {
            activation_id: 'activation-1', epoch: 1, status: 'active', last_turn_sequence: 1,
            transcript_id: SID, transcript_path: transcript, provider: 'codex',
          },
        },
      },
    },
  }));
  return { project, vault, brain, sessionPath, transcript };
}

function cleanEnv(vault) {
  const env = { ...process.env, OBSIDIAN_VAULT_PATH: vault, CLAUDECODE: '', CLAUDE_CODE_SESSION_ID: '' };
  delete env.CODEX_THREAD_ID;
  return env;
}

test('[req:MEM-HYB-1] [req:MEM-HYB-2] [req:MEM-HYB-3] Vendiva-like Stop becomes direct memory in the next SessionStart', () => {
  const { project, vault, brain, sessionPath, transcript } = seed();
  const stop = spawnSync(process.execPath, [STOP], {
    cwd: project,
    env: cleanEnv(vault),
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: 'Stop', cwd: project, session_id: SID, transcript_path: transcript,
      turn_id: 'turn-final', turn_sequence: 1, activation_id: 'activation-1',
    }),
  });

  assert.equal(stop.status, 0, stop.stderr);
  assert.doesNotThrow(() => JSON.parse(stop.stdout || '{}'));
  const stopOutput = JSON.parse(stop.stdout || '{}');
  assert.equal(stopOutput.systemMessage, undefined, `${stop.stderr}\n${stop.stdout}`);
  assert.match(readFileSync(sessionPath, 'utf8'), /status: done/);
  const registry = JSON.parse(readFileSync(join(brain, 'SESSION_REGISTRY.json'), 'utf8'));
  assert.equal(registry.sessions[SID].memory_status, 'projected');
  assert.equal(registry.sessions[SID].memory_checkpoint.revision >= 5, true);

  const shared = readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8');
  for (const fact of ['ADR-0107', '7/7', 'backend-unit', 'MinIO privado', '9fbbbb1bdad630cd4145ea4a916ef8f240ed603f', 'Nenhum push', 'interface de revisão']) {
    assert.match(shared, new RegExp(fact.replace(/[|]/g, '\\|'), 'i'), `SHARED perdeu: ${fact}`);
  }

  const noteMtime = statSync(sessionPath).mtimeMs;
  const ledgerBefore = readFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), 'utf8');
  const repeated = spawnSync(process.execPath, [STOP], {
    cwd: project,
    env: cleanEnv(vault),
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: 'Stop', cwd: project, session_id: SID, transcript_path: transcript,
      turn_id: 'turn-final', turn_sequence: 1, activation_id: 'activation-1',
    }),
  });
  assert.equal(repeated.status, 0);
  assert.equal(statSync(sessionPath).mtimeMs, noteMtime, 'Stop repetido não reescreve a nota');
  assert.equal(readFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), 'utf8'), ledgerBefore, 'Stop repetido não reapenda memória');

  const start = spawnSync(process.execPath, [INJECT], {
    cwd: project,
    env: cleanEnv(vault),
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: project, session_id: 'next-session' }),
  });
  assert.equal(start.status, 0, start.stderr);
  const context = JSON.parse(start.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /<brain_memory version="2"/);
  for (const fact of ['ADR-0107', '7/7', 'backend-unit', 'MinIO privado', '9fbbbb1bdad630cd4145ea4a916ef8f240ed603f', 'Nenhum push', 'interface de revisão']) {
    assert.match(context, new RegExp(fact.replace(/[|]/g, '\\|'), 'i'), `SessionStart perdeu: ${fact}`);
  }
});

test('[req:MEM-HYB-7] [req:HOOK-MEM-1] real Stop stays exit-0/JSON and records degraded checkpoint when projector lock is busy', () => {
  const { project, vault, brain, transcript } = seed();
  mkdirSync(join(brain, 'MEMORY.lock'));
  const stop = spawnSync(process.execPath, [STOP], {
    cwd: project,
    env: cleanEnv(vault),
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: 'Stop', cwd: project, session_id: SID, transcript_path: transcript,
      turn_id: 'turn-final', turn_sequence: 1, activation_id: 'activation-1',
    }),
  });

  assert.equal(stop.status, 0, stop.stderr);
  const output = JSON.parse(stop.stdout || '{}');
  assert.match(output.systemMessage, /memória compartilhada degradada|outbox/i);
  const registry = JSON.parse(readFileSync(join(brain, 'SESSION_REGISTRY.json'), 'utf8'));
  assert.equal(registry.sessions[SID].status, 'done');
  assert.equal(registry.sessions[SID].memory_status, 'degraded');
  assert.equal(registry.sessions[SID].memory_checkpoint, undefined);
  assert.ok(readdirSync(join(brain, 'memory-outbox')).some((name) => name.endsWith('.json')));
});
