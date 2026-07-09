#!/usr/bin/env node
// Stop hook. Se a change ativa tem tarefas abertas quando o agente tenta encerrar o turno,
// bloqueia UMA vez por sessão cobrando fechamento honesto: marcar done, rodar verify, OU
// informar a pendência ao usuário e encerrar (a saída honesta é obrigatória no reason — sem
// ela o modelo é incentivado a marcar done falso só para conseguir parar).
// Anti-loop absoluto: stop_hook_active é o PRIMEIRO check, antes de qualquer I/O.
import { pathToFileURL } from 'node:url';
import { getVaultBase, readHookInput, writeHookOutput } from './obsidian-common.mjs';
import { quickGateState, readSentinel, writeSentinel } from './change-core.mjs';

export function nagDecision(input, vaultBase) {
  if (input && input.stop_hook_active) return null; // anti-loop: sempre primeiro
  const gate = quickGateState(vaultBase);
  if (!gate || !gate.openTasks) return null;
  const sid = input?.session_id || input?.sessionId || '';
  if (readSentinel(vaultBase, 'nag', sid)) return null;
  writeSentinel(vaultBase, 'nag', sid);
  return {
    decision: 'block',
    reason: `A change ativa "${gate.slug}" tem ${gate.openTasks} tarefa(s) aberta(s). Antes de encerrar: marque as concluídas com \`wendkeep change done <id>\`, rode \`wendkeep verify\`, ou informe a pendência ao usuário e encerre.`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = readHookInput();
    writeHookOutput(nagDecision(input, getVaultBase(input)) || {});
  } catch {
    writeHookOutput({});
  }
}
