#!/usr/bin/env node
// Stop hook. Se a change ativa tem tarefas abertas quando o agente tenta encerrar o turno,
// bloqueia UMA vez por sessão cobrando fechamento honesto: marcar done, rodar verify, OU
// informar a pendência ao usuário e encerrar (a saída honesta é obrigatória no reason — sem
// ela o modelo é incentivado a marcar done falso só para conseguir parar).
// Anti-loop absoluto: stop_hook_active é o PRIMEIRO check, antes de qualquer I/O.
import { pathToFileURL } from 'node:url';
import { readHookInput, writeHookOutput } from './obsidian-common.mjs';
import { profileRuntimeError } from './brain-inject.mjs';
import { quickGateState, readSentinel, writeSentinel } from './change-core.mjs';
import {
  hookProfilePolicy,
  profileSentinelId,
  resolveHookOperatingProfile,
} from './operating-profile-runtime.mjs';
import { consumeSessionTaskOperatingProfile } from './operating-profile-task-store.mjs';

export function nagDecision(input, vaultBase, { profile = 'GOVERN' } = {}) {
  if (input && input.stop_hook_active) return null; // anti-loop: sempre primeiro
  const policy = hookProfilePolicy(profile);
  if (!policy.harness) return null;
  const gate = quickGateState(vaultBase);
  if (!gate || !gate.openTasks) return null;
  const sid = input?.session_id || input?.sessionId || '';
  const sentinelId = profileSentinelId(sid, profile);
  if (readSentinel(vaultBase, 'nag', sentinelId)) return null;
  writeSentinel(vaultBase, 'nag', sentinelId);
  return {
    decision: 'block',
    reason: `A change ativa "${gate.slug}" tem ${gate.openTasks} tarefa(s) aberta(s). Antes de encerrar: marque as concluídas com \`wendkeep change done <id>\`, rode \`wendkeep verify\`, ou informe a pendência ao usuário e encerre.`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = readHookInput();
    const runtime = resolveHookOperatingProfile({ input });
    const decision = input?.stop_hook_active
      ? null
      : runtime.bindingError
        ? { decision: 'block', reason: profileRuntimeError(runtime.bindingError) }
        : nagDecision(input, runtime.vaultBase, { profile: runtime.profile });
    if (!decision && runtime.taskLease?.state === 'active') {
      consumeSessionTaskOperatingProfile(
        runtime.vaultBase,
        runtime.identity?.canonicalConversationId || input?.session_id || input?.sessionId || '',
        runtime.taskLease.lease_id,
      );
    }
    writeHookOutput(decision || {});
  } catch {
    writeHookOutput({});
  }
}
